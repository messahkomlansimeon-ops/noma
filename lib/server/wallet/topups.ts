import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { CatalogValidationError } from "../catalog/errors";
import { requireUuid } from "../catalog/validation";
import { withPostgresTransaction } from "../postgres/client";
import {
  FAKE_PROVIDER, TOPUP_EXPIRY_DEFAULT_LIMIT, TOPUP_EXPIRY_MAX_LIMIT, TOPUP_EXPIRY_SECONDS, TOPUP_MAX_PENDING, TOPUP_MAX_XOF,
  TOPUP_MIN_XOF, TOPUP_STEP_XOF, WALLET_LOCK_TIMEOUT_MS, WALLET_TOPUP_LOCK_NAMESPACE,
} from "./config";
import { WalletError } from "./errors";
import { postWalletTransaction, requireWalletPool } from "./ledger";

/**
 * Recharges : intentions de paiement et application des événements du prestataire (lot P1a). Le module ne connaît aucun
 * prestataire : la vérification de signature et la lecture de l'événement sont faites AVANT, par `fake-provider.ts` (ou par un
 * futur adaptateur), qui appelle `applyProviderEvent`. Voir WALLET.md.
 */

export type PaymentProvider = typeof FAKE_PROVIDER;
export type PaymentIntentStatus = "pending" | "succeeded" | "failed" | "expired";
export type PaymentEventType = "payment.succeeded" | "payment.failed";
export const PAYMENT_EVENT_TYPES: readonly PaymentEventType[] = ["payment.succeeded", "payment.failed"];

/** Issue enregistrée dans le journal des événements. `duplicate` : événement DISTINCT sur une intention déjà traitée. */
export type PaymentEventOutcome = "applied" | "duplicate" | "rejected_amount" | "rejected_state" | "rejected_unknown_intent";

export interface PaymentIntent {
  id: string;
  ownerId: string;
  /** XOF entiers. */
  amountXof: bigint;
  provider: PaymentProvider;
  /**
   * Statut EFFECTIF : une intention `pending` dont l'échéance est passée est présentée `expired` même si le balayage
   * (expirePaymentIntents) ne l'a pas encore marquée. Un paiement tardif reste appliqué (voir applyProviderEvent).
   */
  status: PaymentIntentStatus;
  /** Statut tel qu'enregistré. */
  storedStatus: PaymentIntentStatus;
  idempotencyKey: string;
  providerReference: string;
  createdAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
}

interface IntentRow {
  id: string;
  owner_id: string;
  amount_xof: string;
  provider: PaymentProvider;
  status: PaymentIntentStatus;
  effective_status: PaymentIntentStatus;
  idempotency_key: string;
  provider_reference: string;
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
}

const INTENT_COLUMNS = `id, owner_id, amount_xof::text AS amount_xof, provider, status,
  CASE WHEN status = 'pending' AND expires_at <= clock_timestamp() THEN 'expired' ELSE status END AS effective_status,
  idempotency_key, provider_reference, created_at, expires_at, completed_at`;

function mapIntent(row: IntentRow): PaymentIntent {
  return {
    id: row.id,
    ownerId: row.owner_id,
    amountXof: BigInt(row.amount_xof),
    provider: row.provider,
    status: row.effective_status,
    storedStatus: row.status,
    idempotencyKey: row.idempotency_key,
    providerReference: row.provider_reference,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  };
}

// ───────────── validation (avant tout SQL) ─────────────

/** Montant d'une recharge : bigint, de TOPUP_MIN_XOF à TOPUP_MAX_XOF inclus, multiple de TOPUP_STEP_XOF. */
export function requireTopupAmount(value: unknown): bigint {
  if (typeof value !== "bigint") throw new CatalogValidationError("amountXof doit être un entier (bigint).");
  if (value < BigInt(TOPUP_MIN_XOF) || value > BigInt(TOPUP_MAX_XOF)) {
    throw new CatalogValidationError(`amountXof doit être compris entre ${TOPUP_MIN_XOF} et ${TOPUP_MAX_XOF} XOF.`);
  }
  if (value % BigInt(TOPUP_STEP_XOF) !== BigInt(0)) {
    throw new CatalogValidationError(`amountXof doit être un multiple de ${TOPUP_STEP_XOF} XOF.`);
  }
  return value;
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") throw new CatalogValidationError("idempotencyKey doit être un UUID.");
  return requireUuid(value, "idempotencyKey").toLowerCase();
}

// ───────────── création et lecture ─────────────

export interface CreatedTopupIntent {
  intent: PaymentIntent;
  /** Vrai si l'intention existait déjà pour cette clé d'idempotence et ce montant (aucune écriture). */
  reused: boolean;
}

/**
 * Crée une intention de recharge. Transaction READ COMMITTED : après BEGIN, `lock_timeout`, puis verrou consultatif PAR
 * UTILISATEUR (jamais un instantané pris avant le verrou) qui sérialise la lecture de la clé d'idempotence, le décompte des
 * intentions en attente et l'insertion.
 *  - même clé, même montant : l'intention existante est renvoyée (`reused: true`, aucune écriture), même si elle n'est plus
 *    en attente ;
 *  - même clé, autre montant : `idempotency_conflict` ;
 *  - déjà TOPUP_MAX_PENDING intentions en attente et non échues : `too_many_pending_topups`.
 */
export async function createTopupIntent(input: {
  pool: Pool;
  ownerId: string;
  amountXof: bigint;
  idempotencyKey: string;
}): Promise<CreatedTopupIntent> {
  const pool = requireWalletPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const amountXof = requireTopupAmount(input.amountXof);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);

  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${WALLET_LOCK_TIMEOUT_MS}ms'`);
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [WALLET_TOPUP_LOCK_NAMESPACE, ownerId]);

    const existing = await client.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE owner_id = $1::uuid AND idempotency_key = $2::uuid`,
      [ownerId, idempotencyKey],
    );
    if (existing.rows[0]) {
      const intent = mapIntent(existing.rows[0]);
      if (intent.amountXof !== amountXof) throw new WalletError("idempotency_conflict");
      return { intent, reused: true };
    }

    const pending = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_intents
        WHERE owner_id = $1::uuid AND status = 'pending' AND expires_at > clock_timestamp()`,
      [ownerId],
    );
    if (pending.rows[0].n >= TOPUP_MAX_PENDING) throw new WalletError("too_many_pending_topups");

    const inserted = await client.query<IntentRow>(
      `WITH t AS (SELECT clock_timestamp() AS now)
       INSERT INTO payment_intents (id, owner_id, amount_xof, provider, status, idempotency_key, provider_reference, created_at, expires_at)
       SELECT $1::uuid, $2::uuid, $3::bigint, $4, 'pending', $5::uuid, $6, t.now, t.now + make_interval(secs => $7::int)
         FROM t
       RETURNING ${INTENT_COLUMNS}`,
      [
        randomUUID(), ownerId, amountXof.toString(), FAKE_PROVIDER, idempotencyKey,
        `fakepay_${randomBytes(12).toString("hex")}`, TOPUP_EXPIRY_SECONDS,
      ],
    );
    return { intent: mapIntent(inserted.rows[0]), reused: false };
  }, pool);
}

/** Intention de l'utilisateur, ou null si elle n'existe pas OU appartient à un autre : les deux cas sont indiscernables. */
export async function readTopupIntent(input: { pool: Pool; ownerId: string; intentId: string }): Promise<PaymentIntent | null> {
  const pool = requireWalletPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const intentId = requireUuid(input.intentId, "intentId").toLowerCase();
  const result = await pool.query<IntentRow>(
    `SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE id = $1::uuid AND owner_id = $2::uuid`,
    [intentId, ownerId],
  );
  return result.rows[0] ? mapIntent(result.rows[0]) : null;
}

// ───────────── application d'un événement du prestataire ─────────────

export interface ProviderEvent {
  provider: PaymentProvider;
  /** Identifiant de l'événement chez le prestataire (unique avec le prestataire). */
  eventId: string;
  type: PaymentEventType;
  /** Référence de l'intention chez le prestataire (payment_intents.provider_reference). */
  providerReference: string;
  amountXof: bigint;
  /** Empreinte SHA-256 (hexadécimal) du corps brut signé. */
  payloadSha256: string;
}

export type ProviderEventResult =
  | { outcome: PaymentEventOutcome; intentId: string | null }
  /** Même (prestataire, identifiant d'événement) déjà enregistré : rien n'est refait ni réécrit ; `payloadMatches` dit si le corps est identique. */
  | { outcome: "replayed"; intentId: string | null; payloadMatches: boolean };

/**
 * Décision pure : que faire d'un événement vu l'état de l'intention. Ordre : intention inconnue, montant différent de celui de
 * l'intention, puis état. Un payment.succeeded sur une intention EXPIRÉE est appliqué (l'argent a été pris chez le prestataire).
 *
 * | intention  | payment.succeeded | payment.failed  |
 * | pending    | applied           | applied         |
 * | expired    | applied           | rejected_state  |
 * | failed     | rejected_state    | duplicate       |
 * | succeeded  | duplicate         | rejected_state  |
 */
export function decideProviderEventOutcome(input: {
  intent: { amountXof: bigint; status: PaymentIntentStatus } | null;
  type: PaymentEventType;
  amountXof: bigint;
}): PaymentEventOutcome {
  if (!input.intent) return "rejected_unknown_intent";
  if (input.intent.amountXof !== input.amountXof) return "rejected_amount";
  if (input.type === "payment.succeeded") {
    switch (input.intent.status) {
      case "pending":
      case "expired":
        return "applied";
      case "succeeded":
        return "duplicate";
      default:
        return "rejected_state";
    }
  }
  switch (input.intent.status) {
    case "pending":
      return "applied";
    case "failed":
      return "duplicate";
    default:
      return "rejected_state";
  }
}

const EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function requireProviderEvent(event: ProviderEvent): ProviderEvent {
  if (typeof event !== "object" || event === null) throw new CatalogValidationError("Événement invalide.");
  if (event.provider !== FAKE_PROVIDER) throw new CatalogValidationError("Prestataire inconnu.");
  if (typeof event.eventId !== "string" || !EVENT_ID.test(event.eventId)) throw new CatalogValidationError("eventId invalide.");
  if (!PAYMENT_EVENT_TYPES.includes(event.type)) throw new CatalogValidationError("type d'événement inconnu.");
  if (typeof event.providerReference !== "string" || !EVENT_ID.test(event.providerReference)) {
    throw new CatalogValidationError("providerReference invalide.");
  }
  if (typeof event.amountXof !== "bigint" || event.amountXof < BigInt(1) || event.amountXof > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CatalogValidationError("amountXof de l'événement invalide.");
  }
  if (typeof event.payloadSha256 !== "string" || !SHA256_HEX.test(event.payloadSha256)) throw new CatalogValidationError("payloadSha256 invalide.");
  return event;
}

interface LockedIntentRow {
  id: string;
  owner_id: string;
  amount_xof: string;
  status: PaymentIntentStatus;
}

/**
 * Applique UN événement du prestataire, en UNE transaction SQL (READ COMMITTED) :
 *  1. `lock_timeout`, puis verrou de l'intention (`FOR UPDATE`) : tous les événements d'une même intention sont sérialisés ;
 *  2. décision (decideProviderEventOutcome) ;
 *  3. enregistrement de l'événement dans le journal (`ON CONFLICT DO NOTHING` sur (prestataire, identifiant d'événement)) : si la
 *     ligne existe déjà, l'événement est une RELECTURE et rien d'autre n'est fait ;
 *  4. si `applied` : succès → intention `succeeded` et transaction `topup` (débit provider_clearing, crédit du compte de
 *     l'utilisateur, référence unique `topup:<intention>`) ; échec → intention `failed`.
 * L'appelant a déjà vérifié la signature : ce module ne vérifie rien du prestataire.
 */
export async function applyProviderEvent(input: { pool: Pool; event: ProviderEvent }): Promise<ProviderEventResult> {
  const pool = requireWalletPool(input.pool);
  const event = requireProviderEvent(input.event);

  return withPostgresTransaction(async (client): Promise<ProviderEventResult> => {
    await client.query(`SET LOCAL lock_timeout = '${WALLET_LOCK_TIMEOUT_MS}ms'`);
    const found = await client.query<LockedIntentRow>(
      `SELECT id, owner_id, amount_xof::text AS amount_xof, status
         FROM payment_intents WHERE provider = $1 AND provider_reference = $2
          FOR UPDATE`,
      [event.provider, event.providerReference],
    );
    const intent = found.rows[0] ?? null;
    const outcome = decideProviderEventOutcome({
      intent: intent ? { amountXof: BigInt(intent.amount_xof), status: intent.status } : null,
      type: event.type,
      amountXof: event.amountXof,
    });

    const logged = await client.query(
      `INSERT INTO payment_events (id, provider, provider_event_id, intent_id, type, amount_xof, payload_sha256, outcome)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::bigint, $7, $8)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id`,
      [randomUUID(), event.provider, event.eventId, intent?.id ?? null, event.type, event.amountXof.toString(), event.payloadSha256, outcome],
    );
    if (logged.rowCount === 0) {
      const previous = await client.query<{ payload_sha256: string }>(
        "SELECT payload_sha256 FROM payment_events WHERE provider = $1 AND provider_event_id = $2",
        [event.provider, event.eventId],
      );
      return { outcome: "replayed", intentId: intent?.id ?? null, payloadMatches: previous.rows[0]?.payload_sha256 === event.payloadSha256 };
    }

    if (outcome === "applied" && intent) {
      if (event.type === "payment.succeeded") {
        await client.query(
          "UPDATE payment_intents SET status = 'succeeded', completed_at = clock_timestamp() WHERE id = $1::uuid",
          [intent.id],
        );
        await postWalletTransaction(client, {
          kind: "topup",
          reference: `topup:${intent.id}`,
          metadata: { paymentIntentId: intent.id, provider: event.provider },
          entries: [
            { account: { kind: "provider_clearing" }, amount: -event.amountXof },
            { account: { kind: "user", ownerId: intent.owner_id }, amount: event.amountXof },
          ],
        });
      } else {
        await client.query(
          "UPDATE payment_intents SET status = 'failed', completed_at = clock_timestamp() WHERE id = $1::uuid",
          [intent.id],
        );
      }
    }
    return { outcome, intentId: intent?.id ?? null };
  }, pool);
}

// ───────────── expiration ─────────────

/**
 * Marque `expired` les intentions `pending` dont l'échéance est passée (au plus `limit`, les plus anciennes d'abord). Plusieurs
 * appels simultanés sont sûrs : les lignes verrouillées par un autre appel (ou par un événement en cours de traitement) sont
 * ignorées (`FOR UPDATE SKIP LOCKED`). Fonction prévue pour le worker ; non branchée au runner dans ce lot (script wallet:expire-intents).
 */
export async function expirePaymentIntents(input: { pool: Pool; limit?: number }): Promise<{ expired: number }> {
  const pool = requireWalletPool(input.pool);
  const limit = input.limit ?? TOPUP_EXPIRY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TOPUP_EXPIRY_MAX_LIMIT) {
    throw new CatalogValidationError(`limit doit être un entier compris entre 1 et ${TOPUP_EXPIRY_MAX_LIMIT}.`);
  }
  const result = await pool.query(
    `WITH due AS (
       SELECT id FROM payment_intents
        WHERE status = 'pending' AND expires_at < clock_timestamp()
        ORDER BY expires_at, id
        LIMIT $1::int
        FOR UPDATE SKIP LOCKED
     )
     UPDATE payment_intents p
        SET status = 'expired', completed_at = clock_timestamp()
       FROM due
      WHERE p.id = due.id AND p.status = 'pending'`,
    [limit],
  );
  return { expired: result.rowCount ?? 0 };
}
