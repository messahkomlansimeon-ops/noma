import "server-only";

import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import { requireAuthSecret } from "../auth/config";
import { getPostgresPool } from "../postgres/client";
import { budgetErrorCode, planBudgets, type SmsBudgetAudience, type SmsBudgetPlan, type SmsBudgetScope } from "./budget";
import { finishSend, markInterrupted, reserveSend, utcDayStart, type SmsPurpose, type SmsSendRow } from "./journal";
import { SmsLocalValidationError, lastTwoDigits, localRefusal, maskRecipient } from "./validation";
import { createMenoClient, type MenoClient, type MenoSendOutcome, type SmsFinalStatus } from "./meno";
import { isMenoActive, readSmsConfig, type Environment } from "./config";

/**
 * Envoi d'un SMS avec journal (lot SMS1) : l'unique chemin des SMS réels. Ordre, pour qu'aucun envoi payant ne soit invisible ni répété :
 *  1. contrôles locaux (pays, un seul segment, format de la clé) : un refus ne coûte rien et ne laisse aucune ligne ;
 *  2. réservation de la ligne `sms_sends` (clé d'idempotence UNIQUE) AVANT l'appel, avec le contrôle des BUDGETS du jour (total, codes / notifications, numéros inconnus, lissage
 *     horaire ; verrou consultatif : plafond exact) : sans journal ou sans budget, AUCUN appel ;
 *  3. selon la ligne trouvée pour la même clé : accepted/uncertain/rejected → résultat rendu SANS appel ; pending récent → envoi en cours ; pending ancien → uncertain
 *     (processus mort pendant l'appel) ; failed → nouvelle tentative avec la MÊME clé, mais APRÈS un nouveau contrôle de budget (la reprise ne contourne jamais le plafond) ;
 *  4. appel au fournisseur, puis écriture du résultat (jamais d'écrasement d'un statut final).
 * Un envoi « uncertain » n'est JAMAIS relancé automatiquement. Une seule ligne de journal par envoi : finalité, statut, code HTTP, code d'erreur, numéro masqué (deux derniers
 * chiffres). Jamais la clé du fournisseur, le texte, le numéro entier, ni la clé d'idempotence.
 */

export interface SmsSendRequest {
  purpose: SmsPurpose;
  /** Référence métier (identifiant du défi OTP, clé du lot figé des notifications). */
  reference: string;
  /** STABLE pour une action métier : `otp-<défi>`, `notif-<lot>`. Ne change jamais lors d'une reprise. */
  idempotencyKey: string;
  to: string;
  content: string;
  /** Délai global de l'envoi (toutes tentatives comprises). */
  deadlineMs?: number;
  /** Code de connexion seulement : le numéro a-t-il DÉJÀ un compte (`existing`) ? Absent ou `null` = non établi, traité comme un numéro inconnu (`new`). */
  audience?: SmsBudgetAudience | null;
}

export interface SmsSendResult {
  status: SmsFinalStatus;
  errorCode: string | null;
  httpStatus: number | null;
  providerId: string | null;
  attempts: number;
  /** Vrai : aucun appel n'a été fait (résultat déjà connu du journal, ou envoi en cours ailleurs). */
  skipped: boolean;
  /** Motif du refus pour budget (aucun appel, aucune écriture), sinon null. */
  budgetScope?: SmsBudgetScope | null;
}

export interface SmsSender {
  send(request: SmsSendRequest): Promise<SmsSendResult>;
}

export interface SmsSenderDependencies {
  client: Pick<MenoClient, "send">;
  pool: () => Pool;
  /** Secret de l'empreinte des numéros (défaut : NOMA_AUTH_SECRET). */
  phoneSecret?: () => Uint8Array;
  /** Budgets du jour (plafond total découpé). Pratique pour les essais : `dailyCap` seul donne le découpage par défaut. */
  budget?: SmsBudgetPlan;
  dailyCap?: number;
  now?: () => Date;
  /** Un envoi `pending` plus ancien que ce délai est considéré interrompu (défaut 2 minutes). */
  staleAfterMs?: number;
  /** Ligne de journal (défaut : console.log). Ne reçoit jamais de secret. */
  log?: (line: string) => void;
}

export const SMS_STALE_PENDING_MS = 2 * 60_000;

export function phoneHash(secret: Uint8Array, phone: string): string {
  return createHmac("sha256", secret).update("noma:sms:phone:v1\0", "utf8").update(phone, "utf8").digest("hex");
}

function result(status: SmsFinalStatus, errorCode: string | null, extra: Partial<SmsSendResult> = {}): SmsSendResult {
  return { status, errorCode, httpStatus: null, providerId: null, attempts: 0, skipped: false, ...extra };
}

function fromRow(row: SmsSendRow): SmsSendResult {
  return {
    status: row.status === "pending" ? "uncertain" : row.status,
    errorCode: row.error_code,
    httpStatus: row.http_status,
    providerId: row.provider_id,
    attempts: 0,
    skipped: true,
  };
}

export function createSmsSender(dependencies: SmsSenderDependencies): SmsSender {
  const now = dependencies.now ?? (() => new Date());
  const staleAfterMs = dependencies.staleAfterMs ?? SMS_STALE_PENDING_MS;
  const phoneSecret = dependencies.phoneSecret ?? (() => requireAuthSecret());
  const write = dependencies.log ?? ((line: string) => console.log(line));
  const budget = dependencies.budget ?? planBudgets(dependencies.dailyCap ?? 1_000);

  function log(request: SmsSendRequest, outcome: SmsSendResult): void {
    try {
      write(
        `[sms] ${request.purpose} ${outcome.status} vers ${maskRecipient(request.to)}, http ${outcome.httpStatus ?? "-"}, ${outcome.attempts} requête(s), ` +
          `${outcome.skipped ? "sans appel, " : ""}code ${outcome.errorCode ?? "-"}`,
      );
    } catch {
      // Un journal défaillant ne change jamais le résultat d'un envoi.
    }
  }

  async function run(request: SmsSendRequest): Promise<SmsSendResult> {
    const refusal = localRefusal(request);
    if (refusal) return result("failed", refusal);

    let pool: Pool;
    let hash: string;
    let reservation: Awaited<ReturnType<typeof reserveSend>>;
    try {
      pool = dependencies.pool();
      hash = phoneHash(phoneSecret(), request.to);
      const startedAt = now();
      reservation = await reserveSend(pool, {
        purpose: request.purpose,
        reference: request.reference,
        idempotencyKey: request.idempotencyKey,
        phoneHash: hash,
        phoneLast2: lastTwoDigits(request.to),
        now: startedAt,
        budget,
        audience: request.audience ?? null,
        dayStart: utcDayStart(startedAt),
      });
    } catch {
      // Pas de journal, pas d'envoi : un SMS payant ne part jamais sans trace.
      return result("failed", "journal_unavailable");
    }

    if (reservation.kind === "budget") return result("failed", budgetErrorCode(reservation.scope), { budgetScope: reservation.scope });
    if (reservation.kind === "existing") {
      const row = reservation.row;
      if (row.phone_hash !== hash || row.purpose !== request.purpose) return result("rejected", "idempotency_conflict", { skipped: true });
      if (row.status === "accepted" || row.status === "uncertain" || row.status === "rejected") return fromRow(row);
      if (row.status === "pending") {
        try {
          const current = now();
          const interrupted = await markInterrupted(pool, row.id, new Date(current.getTime() - staleAfterMs), current);
          return interrupted ? result("uncertain", "interrupted", { skipped: true, providerId: row.provider_id }) : result("uncertain", "in_flight", { skipped: true });
        } catch {
          return result("failed", "journal_unavailable");
        }
      }
      // `failed` : la reprise (même clé, APRÈS un nouveau contrôle de budget) est faite par `reserveSend`, qui rend alors `new` ; une ligne `failed` rendue telle quelle ne peut être
      // qu'un conflit de clé, traité plus haut. Par prudence : aucun appel.
      return result("failed", row.error_code ?? "unknown", { skipped: true, httpStatus: row.http_status });
    }
    const rowId = reservation.id;

    let outcome: MenoSendOutcome;
    try {
      outcome = await dependencies.client.send({ to: request.to, content: request.content, idempotencyKey: request.idempotencyKey, deadlineMs: request.deadlineMs });
    } catch (error) {
      // Une exception du client est un défaut de programmation : refus local (rien n'est parti) ou résultat inconnu (jamais « accepted », jamais relancé).
      outcome = error instanceof SmsLocalValidationError
        ? { status: "failed", httpStatus: null, errorCode: error.code, providerId: null, attempts: 0, replay: false }
        : { status: "uncertain", httpStatus: null, errorCode: "client_error", providerId: null, attempts: 0, replay: false };
    }

    try {
      await finishSend(pool, rowId, outcome, now());
    } catch {
      // Le message est peut-être parti mais la trace n'a pas pu être écrite : la ligne reste `pending`, donc visible comme interrompue (rapprochement) après le délai.
    }
    return {
      status: outcome.status,
      errorCode: outcome.errorCode,
      httpStatus: outcome.httpStatus,
      providerId: outcome.providerId,
      attempts: outcome.attempts,
      skipped: false,
    };
  }

  return {
    async send(request) {
      const outcome = await run(request);
      log(request, outcome);
      return outcome;
    },
  };
}

/**
 * Clients et expéditeurs du runtime, un par (base, clé, budgets) : l'environnement est relu à chaque appel. La clé est lue À L'EXÉCUTION (`process.env`, jamais inlinée par le bundler) et ne
 * vit qu'en mémoire du serveur ; elle ne doit JAMAIS être présente pendant le build (le cache Turbopack, .next/cache/turbopack/*.sst, retient les variables d'environnement lues au build) :
 * le build de production se fait par `npm run build:production`, qui retire tous les secrets de l'environnement du build puis supprime .next/cache (voir DEPLOIEMENT.md et SMS.md).
 */
const senders = new Map<string, SmsSender>();

/** Expéditeur Meno réel d'après l'environnement, ou undefined si le branchement n'est pas actif (clé absente ou invalide, fournisseur autre que meno). */
export function resolveMenoSender(env: Environment = process.env): SmsSender | undefined {
  const config = readSmsConfig(env);
  if (!isMenoActive(config) || config.apiKey === null) return undefined;
  const cacheKey = `${config.baseUrl}\u0000${config.apiKey}\u0000${JSON.stringify(config.budget)}`;
  let sender = senders.get(cacheKey);
  if (!sender) {
    sender = createSmsSender({
      client: createMenoClient({ apiKey: config.apiKey, baseUrl: config.baseUrl }),
      pool: () => getPostgresPool(),
      budget: config.budget,
    });
    senders.set(cacheKey, sender);
  }
  return sender;
}
