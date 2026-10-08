import "server-only";

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withPostgresTransaction } from "../../postgres/client";
import { CatalogValidationError } from "../../catalog/errors";
import { requireWalletPool } from "../ledger";
import { applyProviderEventInTransaction, type PaymentEventType } from "../topups";
import { recordAnomaly, type AnomalyKind } from "./anomalies";
import { SublymusApiError, SublymusClient, type SublymusIntentSummary } from "./client";
import {
  CATCHUP_DEFAULT_LIMIT, CATCHUP_FIRST_DELAY_MS, CATCHUP_MAX_DELAY_MS, CATCHUP_MAX_LIMIT, CATCHUP_PASS_BUDGET_MS, CATCHUP_WINDOW_MS, SUBLYMUS_PROVIDER, SUBLYMUS_SOURCE_SYSTEM,
  resolvePaymentSelection, type SublymusConfig,
} from "./config";
import { safeEqualText } from "./webhook";

/**
 * RATTRAPAGE des recharges Sublymus (lot PAY1) : étape ISOLÉE du worker (`runMatchingCycle`). Si un webhook est perdu, la recharge payée n'est pas oubliée : toute intention
 * EN ATTENTE depuis plus de 2 minutes est interrogée chez Sublymus (`GET /v1/intents?external_reference=<référence>`), avec une attente DOUBLÉE à chaque tentative (plafond
 * 1 heure) et jusqu'à 24 heures après sa création.
 *
 * Lot PAY1-ter (N4) : une intention ÉCHOUÉE (`failed`, par un webhook ou par une lecture FAILED) ou EXPIRÉE lue FAILED RESTE sondée, aux mêmes intervalles (doublement, plafond
 * 1 heure) et jusqu'à 24 heures après sa création : un paiement peut réussir après un échec (l'argent a été pris). Si Sublymus répond alors COMPLETED, la recharge est créditée UNE
 * fois (`allowSuccessAfterFailure`, même chemin que le webhook) et une anomalie `state_conflict` est journalisée. Seule une intention `succeeded` ferme la session tout de suite.
 *
 * La recherche de Sublymus est PARTIELLE : on filtre la référence EXACTE, puis on vérifie payeur, montant, devise, système source et identifiant avant d'agir. `COMPLETED` crédite
 * (une seule fois, par le MÊME chemin que le webhook : verrou de l'intention, statut, référence `topup:<intention>` unique), `FAILED` termine l'intention, `WAVE_CREATED` attend.
 * Le rattrapage et le webhook peuvent arriver en même temps : l'intention est verrouillée, le second ne fait rien (`duplicate`).
 *
 * BUDGET DE TEMPS : un passage dure au plus ~20 s (CATCHUP_PASS_BUDGET_MS) et s'arrête à la PREMIÈRE erreur de délai, de réseau, de limite de débit ou 5xx de Sublymus ; les
 * intentions non examinées restent dues (leur réservation est rendue), la fautive a son attente croissante. Une clé refusée (401/403) arrête aussi le passage (les réservations
 * de 5 minutes gardées : pas de martèlement). Doublons chez Sublymus : si un identifiant Sublymus est déjà enregistré, l'entrée qui le porte est jugée et le doublon est
 * journalisé sans bloquer le crédit.
 */

export interface CatchupStepResult {
  /** Aucun prestataire Sublymus actif, ou migration 0026 absente : étape ignorée sans erreur. */
  skipped: boolean;
  examined: number;
  completed: number;
  failed: number;
  waiting: number;
  notFound: number;
  anomalies: number;
  windowClosed: number;
  /** Intentions réservées mais NON examinées (budget de temps épuisé, ou arrêt après une erreur de Sublymus) : leur réservation est rendue, elles restent dues. */
  deferred: number;
  /** Codes stables (`catchup_error_<code>`) : jamais un message. */
  errors: string[];
}

export const EMPTY_CATCHUP_RESULT: CatchupStepResult = Object.freeze({
  skipped: false, examined: 0, completed: 0, failed: 0, waiting: 0, notFound: 0, anomalies: 0, windowClosed: 0, deferred: 0, errors: [],
}) as CatchupStepResult;

interface DueRow {
  intent_id: string;
  external_reference: string;
  amount_xof: string;
  sublymus_intent_id: string | null;
  catchup_attempts: number;
  created_at: Date;
  /** Statut de l'intention de recharge au moment de la réservation (lot PAY1-ter : `failed` et `expired` restent sondées). */
  intent_status: string;
  /** Prochaine tentative AVANT la réservation (rendue si l'intention n'est pas examinée). */
  previous_due: Date;
}

/** Délai avant la tentative suivante : 2 min × 2^tentatives, plafonné à 1 heure. */
export function catchupDelayMs(attempts: number): number {
  return Math.min(CATCHUP_FIRST_DELAY_MS * 2 ** Math.max(0, attempts), CATCHUP_MAX_DELAY_MS);
}

/** Bail pris sur une ligne en cours de traitement (un autre passage ne la reprend pas avant ce délai). */
const LEASE_MS = 5 * 60_000;

export type CatchupVerdict =
  | { action: "apply"; type: PaymentEventType }
  | { action: "wait" }
  | { action: "anomaly"; kinds: AnomalyKind[] };

/**
 * Décision pure sur l'entrée de Sublymus (référence EXACTE déjà filtrée) : écarts d'abord (montant, devise, payeur, système source, identifiant), puis statut :
 * COMPLETED → créditer, FAILED → terminer, WAVE_CREATED → attendre, tout autre statut → anomalie.
 */
export function judgeProviderIntent(input: {
  entry: SublymusIntentSummary;
  expectedAmountXof: bigint;
  storedSublymusIntentId: string | null;
  managerId: string;
}): CatchupVerdict {
  const { entry } = input;
  const kinds: AnomalyKind[] = [];
  if (input.storedSublymusIntentId !== null && input.storedSublymusIntentId !== entry.id) kinds.push("intent_id_mismatch");
  if (entry.amountXof === null) kinds.push("invalid_amount");
  else if (entry.amountXof !== input.expectedAmountXof) kinds.push("amount_mismatch");
  if (entry.currency !== "XOF") kinds.push("currency_mismatch");
  if (entry.payerId !== null && !safeEqualText(entry.payerId, input.managerId)) kinds.push("payer_mismatch");
  if (entry.sourceSystem !== null && entry.sourceSystem !== SUBLYMUS_SOURCE_SYSTEM) kinds.push("source_mismatch");
  if (kinds.length > 0) return { action: "anomaly", kinds };
  if (entry.status === "COMPLETED") return { action: "apply", type: "payment.succeeded" };
  if (entry.status === "FAILED") return { action: "apply", type: "payment.failed" };
  if (entry.status === "WAVE_CREATED") return { action: "wait" };
  return { action: "anomaly", kinds: ["status_mismatch"] };
}

/** Identifiant de l'événement de rattrapage dans le journal des paiements : un par intention et par issue (déduplication). */
export function catchupEventId(intentId: string, type: PaymentEventType): string {
  return `sublymus_poll_${intentId.replace(/-/g, "")}_${type === "payment.succeeded" ? "c" : "f"}`;
}

async function finishRow(client: PoolClient, intentId: string, input: { outcome: string; providerStatus: string | null; attempts: number; createdAt: Date; now: Date; done: boolean }): Promise<void> {
  const next = new Date(input.now.getTime() + catchupDelayMs(input.attempts));
  const closed = input.done || next.getTime() > input.createdAt.getTime() + CATCHUP_WINDOW_MS;
  // Course avec un webhook qui a terminé la session pendant le sondage : une session déjà terminée (catchup_done_at posé) n'a plus de prochaine tentative (contrainte
  // chk_sublymus_checkouts_done) et ni son statut ni son issue ne sont écrasés par un sondage qui avait vu « en attente ».
  await client.query(
    `UPDATE sublymus_checkouts
        SET catchup_attempts = catchup_attempts + 1, last_catchup_at = $2::timestamptz,
            last_catchup_outcome = CASE WHEN catchup_done_at IS NOT NULL THEN last_catchup_outcome ELSE $3 END,
            provider_status = CASE WHEN catchup_done_at IS NOT NULL THEN provider_status ELSE COALESCE($4, provider_status) END,
            next_catchup_at = CASE WHEN $5::boolean OR catchup_done_at IS NOT NULL THEN NULL ELSE $6::timestamptz END,
            catchup_done_at = CASE WHEN $5::boolean THEN COALESCE(catchup_done_at, $2::timestamptz) ELSE catchup_done_at END
      WHERE intent_id = $1::uuid`,
    // Lot PAY1-ter : à la fermeture de la fenêtre, l'issue « failed » d'une intention échouée reste lisible (« window_closed » ne l'écrase pas).
    [intentId, input.now.toISOString(), closed && !input.done && input.outcome !== "failed" ? "window_closed" : input.outcome, input.providerStatus, closed, next.toISOString()],
  );
}

async function processRow(input: {
  pool: Pool;
  client: SublymusClient;
  managerId: string;
  row: DueRow;
  now: Date;
  result: CatchupStepResult;
}): Promise<void> {
  const { row, now, result } = input;
  const amount = BigInt(row.amount_xof);
  const attempts = row.catchup_attempts + 1;
  const found = (await input.client.findIntents(row.external_reference)).filter((entry) => entry.externalReference === row.external_reference);

  // Doublons EXACTS chez Sublymus : si l'identifiant Sublymus de NOTRE session est enregistré et se retrouve parmi eux, c'est cette entrée qui est jugée (le doublon est journalisé,
  // il ne bloque pas le crédit) ; sinon on ne peut pas savoir laquelle est la nôtre : anomalie, rien n'est décidé.
  const stored = found.length > 1 && row.sublymus_intent_id !== null ? found.find((entry) => entry.id === row.sublymus_intent_id) : undefined;

  if (found.length === 0) {
    result.notFound += 1;
    await withPostgresTransaction((tx) => finishRow(tx, row.intent_id, { outcome: "not_found", providerStatus: null, attempts, createdAt: row.created_at, now, done: false }), input.pool);
    return;
  }
  if (found.length > 1 && stored === undefined) {
    result.anomalies += 1;
    await withPostgresTransaction(async (tx) => {
      await recordAnomaly(tx, {
        kind: "duplicate_provider_intents", origin: "catchup", dedupeKey: `catchup:${row.intent_id}`, intentId: row.intent_id, externalReference: row.external_reference,
        expectedAmountXof: amount,
      });
      await finishRow(tx, row.intent_id, { outcome: "anomaly", providerStatus: null, attempts, createdAt: row.created_at, now, done: false });
    }, input.pool);
    return;
  }

  const entry = stored ?? found[0];
  const verdict = judgeProviderIntent({ entry, expectedAmountXof: amount, storedSublymusIntentId: row.sublymus_intent_id, managerId: input.managerId });
  await withPostgresTransaction(async (tx) => {
    if (stored !== undefined) {
      const created = await recordAnomaly(tx, {
        kind: "duplicate_provider_intents", origin: "catchup", dedupeKey: `catchup:${row.intent_id}`, intentId: row.intent_id, externalReference: row.external_reference,
        sublymusIntentId: entry.id, expectedAmountXof: amount,
      });
      if (created) result.anomalies += 1;
    }
    if (verdict.action === "anomaly") {
      result.anomalies += 1;
      for (const kind of verdict.kinds) {
        await recordAnomaly(tx, {
          kind, origin: "catchup", dedupeKey: `catchup:${row.intent_id}`, intentId: row.intent_id, externalReference: row.external_reference, sublymusIntentId: entry.id,
          expectedAmountXof: amount, receivedAmountXof: entry.amountXof, receivedCurrency: entry.currency, receivedStatus: entry.status, payerId: entry.payerId,
        });
      }
      await finishRow(tx, row.intent_id, { outcome: "anomaly", providerStatus: null, attempts, createdAt: row.created_at, now, done: false });
      return;
    }
    if (verdict.action === "wait") {
      result.waiting += 1;
      await finishRow(tx, row.intent_id, { outcome: "waiting", providerStatus: "WAVE_CREATED", attempts, createdAt: row.created_at, now, done: false });
      return;
    }
    if (row.sublymus_intent_id === null) {
      const taken = await tx.query("SELECT 1 FROM sublymus_checkouts WHERE sublymus_intent_id = $1 AND intent_id <> $2::uuid", [entry.id, row.intent_id]);
      if (taken.rowCount) {
        result.anomalies += 1;
        await recordAnomaly(tx, {
          kind: "intent_id_mismatch", origin: "catchup", dedupeKey: `catchup:${row.intent_id}`, intentId: row.intent_id, externalReference: row.external_reference, sublymusIntentId: entry.id,
          expectedAmountXof: amount, receivedAmountXof: entry.amountXof, receivedCurrency: entry.currency, receivedStatus: entry.status, payerId: entry.payerId,
        });
        await finishRow(tx, row.intent_id, { outcome: "anomaly", providerStatus: null, attempts, createdAt: row.created_at, now, done: false });
        return;
      }
      await tx.query("UPDATE sublymus_checkouts SET sublymus_intent_id = $2 WHERE intent_id = $1::uuid AND sublymus_intent_id IS NULL", [row.intent_id, entry.id]);
    }
    const applied = await applyProviderEventInTransaction(tx, {
      provider: SUBLYMUS_PROVIDER,
      eventId: catchupEventId(row.intent_id, verdict.type),
      type: verdict.type,
      providerReference: row.external_reference,
      amountXof: amount,
      payloadSha256: createHash("sha256").update(`poll:${row.external_reference}:${entry.status}:${entry.id}`).digest("hex"),
      // Lot PAY1-ter (N4) : un paiement RÉUSSI lu chez Sublymus sur une intention déjà échouée est crédité (l'argent a été pris), UNE seule fois, comme pour le webhook.
    }, { allowSuccessAfterFailure: true });
    if (verdict.type === "payment.succeeded" && (applied.outcome === "rejected_state" || (applied.outcome === "applied" && row.intent_status === "failed"))) {
      result.anomalies += 1;
      await recordAnomaly(tx, {
        kind: "state_conflict", origin: "catchup", dedupeKey: `catchup:${row.intent_id}`, intentId: row.intent_id, externalReference: row.external_reference, sublymusIntentId: entry.id,
        expectedAmountXof: amount, receivedAmountXof: entry.amountXof, receivedCurrency: entry.currency, receivedStatus: entry.status, payerId: entry.payerId,
      });
    }
    if (verdict.type === "payment.succeeded") result.completed += 1;
    else result.failed += 1;
    // Lot PAY1-ter (N4) : seule une réussite TERMINE la session. Un échec (FAILED) la laisse sondée (attente doublée, plafond 1 h) jusqu'à la fin de la fenêtre de 24 h.
    await finishRow(tx, row.intent_id, {
      outcome: verdict.type === "payment.succeeded" ? "completed" : "failed", providerStatus: verdict.type === "payment.succeeded" ? "COMPLETED" : "FAILED",
      attempts, createdAt: row.created_at, now, done: verdict.type === "payment.succeeded",
    });
  }, input.pool);
}

/**
 * Un passage du rattrapage : réserve (bail de 5 min) les sessions dont la prochaine tentative est échue (au plus `limit`), ferme celles qui ont dépassé 24 h, puis interroge Sublymus
 * pour chacune. Chaque intention est traitée dans SA transaction : l'échec de l'une n'empêche pas les autres. Une clé refusée (401/403) arrête le passage (pas de martèlement).
 */
export async function runCatchup(input: { pool: Pool; client: SublymusClient; managerId: string; now?: Date; limit?: number; budgetMs?: number }): Promise<CatchupStepResult> {
  const pool = requireWalletPool(input.pool);
  const limit = input.limit ?? CATCHUP_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATCHUP_MAX_LIMIT) {
    throw new CatalogValidationError(`limit doit être un entier compris entre 1 et ${CATCHUP_MAX_LIMIT}.`);
  }
  const budgetMs = input.budgetMs ?? CATCHUP_PASS_BUDGET_MS;
  if (!Number.isFinite(budgetMs) || budgetMs < 1) throw new CatalogValidationError("budgetMs doit être un nombre de millisecondes positif.");
  const now = input.now ?? new Date();
  const startedAt = Date.now();
  const result: CatchupStepResult = { ...EMPTY_CATCHUP_RESULT, errors: [] };

  // Fermeture : plus de 24 h, ou intention déjà créditée. Une intention échouée (webhook ou lecture FAILED) reste sondée jusqu'à 24 h (lot PAY1-ter, N4).
  const closed = await pool.query(
    `UPDATE sublymus_checkouts c
        SET next_catchup_at = NULL, catchup_done_at = COALESCE(c.catchup_done_at, $1::timestamptz),
            last_catchup_outcome = COALESCE(c.last_catchup_outcome, CASE WHEN p.status = 'succeeded' THEN 'completed' WHEN p.status = 'failed' THEN 'failed' ELSE 'window_closed' END)
       FROM payment_intents p
      WHERE p.id = c.intent_id AND c.next_catchup_at IS NOT NULL
        AND (p.status = 'succeeded' OR p.created_at <= $1::timestamptz - make_interval(secs => $2::int))`,
    [now.toISOString(), Math.round(CATCHUP_WINDOW_MS / 1000)],
  );
  result.windowClosed = closed.rowCount ?? 0;

  const claimed = await pool.query<DueRow>(
    `WITH due AS (
       SELECT c.intent_id, c.next_catchup_at AS previous_due FROM sublymus_checkouts c JOIN payment_intents p ON p.id = c.intent_id
        WHERE c.next_catchup_at IS NOT NULL AND c.next_catchup_at <= $1::timestamptz AND p.provider = 'sublymus' AND p.status IN ('pending', 'expired', 'failed')
        ORDER BY c.next_catchup_at, c.intent_id
        LIMIT $2::int
        FOR UPDATE OF c SKIP LOCKED
     )
     UPDATE sublymus_checkouts c
        SET next_catchup_at = $1::timestamptz + make_interval(secs => $3::int)
       FROM due, payment_intents p
      WHERE c.intent_id = due.intent_id AND p.id = c.intent_id
      RETURNING c.intent_id, c.external_reference, p.amount_xof::text AS amount_xof, c.sublymus_intent_id, c.catchup_attempts, p.created_at, p.status AS intent_status, due.previous_due`,
    [now.toISOString(), limit, Math.round(LEASE_MS / 1000)],
  );
  let next = 0;
  for (const row of claimed.rows) {
    // Budget de temps épuisé (jamais avant la première intention) : le reste est rendu, il restera dû.
    if (next > 0 && Date.now() - startedAt >= budgetMs) break;
    next += 1;
    result.examined += 1;
    try {
      await processRow({ pool, client: input.client, managerId: input.managerId, row, now, result });
    } catch (error) {
      const code = error instanceof SublymusApiError ? error.code : errorCode(error);
      result.errors.push(`catchup_error_${code}`);
      // Clé refusée : le passage s'arrête, les réservations de 5 minutes sont gardées (aucun martèlement).
      if (error instanceof SublymusApiError && error.kind === "auth") {
        result.deferred = claimed.rows.length - next;
        return result;
      }
      await pool.query(
        `UPDATE sublymus_checkouts SET catchup_attempts = catchup_attempts + 1, last_catchup_at = $2::timestamptz, last_catchup_outcome = 'error',
                next_catchup_at = $3::timestamptz WHERE intent_id = $1::uuid AND catchup_done_at IS NULL`,
        [row.intent_id, now.toISOString(), new Date(now.getTime() + catchupDelayMs(row.catchup_attempts + 1)).toISOString()],
      ).catch(() => undefined);
      // Sublymus lent, injoignable, en panne ou qui limite le débit : on n'insiste pas, les intentions suivantes seront reprises au prochain passage.
      if (error instanceof SublymusApiError && STOP_PASS_KINDS.has(error.kind)) break;
    }
  }
  return finishPass(pool, claimed.rows, next, result);
}

/** Erreurs de Sublymus qui arrêtent le passage (le reste des intentions n'est pas examiné). */
const STOP_PASS_KINDS: ReadonlySet<SublymusApiError["kind"]> = new Set(["timeout", "network", "server", "rate_limited"]);

/** Rend les réservations des intentions non examinées (`rows` à partir de `examined`) : leur prochaine tentative redevient celle d'avant le passage. */
async function finishPass(pool: Pool, rows: DueRow[], examined: number, result: CatchupStepResult): Promise<CatchupStepResult> {
  const unexamined = rows.slice(examined);
  result.deferred = unexamined.length;
  if (unexamined.length > 0) {
    await pool.query(
      `UPDATE sublymus_checkouts c SET next_catchup_at = d.previous_due
         FROM unnest($1::uuid[], $2::timestamptz[]) AS d(intent_id, previous_due)
        WHERE c.intent_id = d.intent_id AND c.catchup_done_at IS NULL AND c.next_catchup_at IS NOT NULL`,
      [unexamined.map((row) => row.intent_id), unexamined.map((row) => row.previous_due.toISOString())],
    );
  }
  return result;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code.toLowerCase() : "unknown";
}

type Environment = Record<string, string | undefined>;

/**
 * Étape du worker : ne fait rien (`skipped`) si le prestataire actif n'est pas Sublymus, si sa configuration est refusée (journalisée par un code) ou si la migration 0026 est
 * absente. Sinon, un passage du rattrapage avec le client de la configuration de l'environnement.
 */
export async function runSublymusCatchupStep(input: {
  pool: Pool; env?: Environment; fetch?: typeof fetch; now?: Date; limit?: number;
  /** Délai d'un appel à Sublymus et budget du passage (millisecondes) : réservés aux essais. */
  timeoutMs?: number; budgetMs?: number;
}): Promise<CatchupStepResult> {
  const env = input.env ?? process.env;
  let config: SublymusConfig;
  try {
    const selection = resolvePaymentSelection(env);
    if (selection.provider !== SUBLYMUS_PROVIDER) return { ...EMPTY_CATCHUP_RESULT, skipped: true, errors: [] };
    config = selection.config;
  } catch {
    return { ...EMPTY_CATCHUP_RESULT, skipped: true, errors: ["catchup_error_provider_config"] };
  }
  const table = await input.pool.query<{ present: boolean }>("SELECT to_regclass('sublymus_checkouts') IS NOT NULL AS present");
  if (table.rows[0]?.present !== true) return { ...EMPTY_CATCHUP_RESULT, skipped: true, errors: [] };
  // Le rattrapage parle au service configuré comme la création de session : en PRODUCTION l'adresse du vrai service est admise (sans cela le rattrapage serait inopérant),
  // ailleurs seule la boucle locale (la fausse API) l'est.
  const client = new SublymusClient(config, { fetch: input.fetch, timeoutMs: input.timeoutMs, allowRealHost: config.production });
  return runCatchup({ pool: input.pool, client, managerId: config.managerId, now: input.now, limit: input.limit, budgetMs: input.budgetMs });
}
