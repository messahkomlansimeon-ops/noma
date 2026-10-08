import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { CatalogValidationError } from "../catalog/errors";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction, type NomaTransactionalClient, type SqlExecutor } from "../postgres/client";
import { readPromoSummary } from "../subscriptions/promo";
import { WALLET_HISTORY_DEFAULT_LIMIT, WALLET_HISTORY_MAX_LIMIT, WALLET_MAX_SAFE_AMOUNT } from "./config";
import { WalletError } from "./errors";

/**
 * Grand livre en partie double (lot P1a). Une transaction est un jeu d'écritures dont la somme vaut ZÉRO ; une écriture positive
 * crédite un compte, une écriture négative le débite. Les montants sont des `bigint` (XOF entiers, jamais de flottant). Le solde de
 * chaque compte est tenu par un déclencheur de la base dans la même transaction SQL que les écritures : un solde utilisateur
 * négatif fait échouer toute la transaction. Les lignes sont immuables. Voir WALLET.md.
 *
 * Ordre des verrous : intention de paiement (si elle existe), puis comptes par identifiant croissant (les écritures sont insérées
 * dans cet ordre : deux transactions concurrentes ne peuvent pas s'interbloquer).
 */

export const WALLET_ACCOUNT_KINDS = [
  "user", "user_promo", "provider_clearing", "boost_revenue", "subscription_revenue", "promo_issuance", "promo_consumed", "promo_expired",
] as const;
export type WalletAccountKind = (typeof WALLET_ACCOUNT_KINDS)[number];

/** Comptes système (un seul de chaque, créés par les migrations, recréés à la demande s'il en manquait). */
export const WALLET_SYSTEM_ACCOUNT_KINDS = [
  "provider_clearing", "boost_revenue", "subscription_revenue", "promo_issuance", "promo_consumed", "promo_expired",
] as const;
export type WalletSystemAccountKind = (typeof WALLET_SYSTEM_ACCOUNT_KINDS)[number];

/**
 * Types de transaction (même liste que chk_wallet_transactions_kind, migration 0021) : recharge, ajustement d'administration, achat
 * de boost et remboursement intégral d'un achat (lot P1b), débit d'une période d'abonnement avec émission de ses crédits promotionnels,
 * remboursement intégral d'une période, expiration des crédits promotionnels restants (lot PRO1).
 */
export const WALLET_TRANSACTION_KINDS = [
  "topup", "adjustment", "boost_purchase", "boost_refund", "subscription_charge", "subscription_refund", "promo_expiry",
] as const;
export type WalletTransactionKind = (typeof WALLET_TRANSACTION_KINDS)[number];

export type LedgerAccountRef =
  | { kind: "user"; ownerId: string }
  | { kind: "user_promo"; ownerId: string }
  | { kind: WalletSystemAccountKind };

export interface LedgerEntryInput {
  account: LedgerAccountRef;
  /** Positif : crédit du compte ; négatif : débit. Jamais nul. */
  amount: bigint;
}

/** Clés et formes autorisées (mêmes règles que chk_wallet_transactions_metadata) : aucune donnée personnelle possible. */
export interface WalletTransactionMetadata {
  paymentIntentId?: string;
  provider?: string;
  reasonCode?: string;
  /** Achat de boost dont découle l'opération : l'achat lui-même (`boost_purchase`) ou l'achat remboursé (`boost_refund`). */
  boostPurchaseId?: string;
  /** Cotation achetée (`boost_purchase` seulement). */
  quoteId?: string;
  /** Période d'abonnement débitée (`subscription_charge`) ou remboursée (`subscription_refund`). */
  subscriptionPeriodId?: string;
  /** Émission de crédits promotionnels expirée (`promo_expiry`). */
  promoGrantId?: string;
}

export interface WalletTransactionInput {
  kind: WalletTransactionKind;
  /** « <type>:<identifiant> », unique : c'est la clé d'idempotence de l'opération. */
  reference: string;
  metadata?: WalletTransactionMetadata;
  entries: LedgerEntryInput[];
}

export interface PostedWalletTransaction {
  id: string;
  kind: WalletTransactionKind;
  reference: string;
  createdAt: Date;
  entries: Array<{ accountId: string; amount: bigint }>;
}

const ZERO = BigInt(0);
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFERENCE = /^[a-z_]{1,20}:[A-Za-z0-9_.-]{1,100}$/;
const PROVIDER_CODE = /^[a-z_]{1,20}$/;
const REASON_CODE = /^[a-z_]{1,40}$/;
const MAX_ENTRIES = 10;

// ───────────── validation (avant tout SQL) ─────────────

export function requireWalletPool(pool: unknown): Pool {
  if (pool === undefined || pool === null) throw new CatalogValidationError("Un pool PostgreSQL est requis.");
  return requireTransactionPool(pool);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Montant du grand livre : bigint, jamais nul, jamais au-delà de 2^53 - 1 en valeur absolue (limite du JSON et des CHECK). */
export function requireLedgerAmount(value: unknown, field = "amount"): bigint {
  if (typeof value !== "bigint") throw new CatalogValidationError(`${field} doit être un entier (bigint).`);
  if (value === ZERO) throw new CatalogValidationError(`${field} ne peut pas être nul.`);
  if (value > WALLET_MAX_SAFE_AMOUNT || value < -WALLET_MAX_SAFE_AMOUNT) {
    throw new CatalogValidationError(`${field} dépasse la limite des montants entiers sûrs.`);
  }
  return value;
}

function requireMetadata(value: unknown): WalletTransactionMetadata {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) throw new CatalogValidationError("metadata doit être un objet.");
  const result: WalletTransactionMetadata = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new CatalogValidationError(`metadata.${key} doit être un texte.`);
    if (key === "paymentIntentId" && UUID_LOWER.test(entry)) result.paymentIntentId = entry;
    else if (key === "provider" && PROVIDER_CODE.test(entry)) result.provider = entry;
    else if (key === "reasonCode" && REASON_CODE.test(entry)) result.reasonCode = entry;
    else if (key === "boostPurchaseId" && UUID_LOWER.test(entry)) result.boostPurchaseId = entry;
    else if (key === "quoteId" && UUID_LOWER.test(entry)) result.quoteId = entry;
    else if (key === "subscriptionPeriodId" && UUID_LOWER.test(entry)) result.subscriptionPeriodId = entry;
    else if (key === "promoGrantId" && UUID_LOWER.test(entry)) result.promoGrantId = entry;
    else throw new CatalogValidationError(`metadata.${key} refusé (clé inconnue ou forme invalide).`);
  }
  return result;
}

function requireAccountRef(value: unknown): LedgerAccountRef {
  if (!isPlainRecord(value)) throw new CatalogValidationError("account doit être un objet.");
  const keys = Object.keys(value);
  if (value.kind === "user" || value.kind === "user_promo") {
    if (keys.length !== 2 || typeof value.ownerId !== "string") throw new CatalogValidationError("Compte utilisateur invalide.");
    return { kind: value.kind, ownerId: requireUuid(value.ownerId, "ownerId").toLowerCase() };
  }
  if (typeof value.kind === "string" && (WALLET_SYSTEM_ACCOUNT_KINDS as readonly string[]).includes(value.kind) && keys.length === 1) {
    return { kind: value.kind as WalletSystemAccountKind };
  }
  throw new CatalogValidationError("Compte invalide.");
}

/**
 * Qui peut toucher les comptes de l'offre Pro, et dans quel sens (même règle que le déclencheur wallet_guard_account_usage de la migration 0021) : un crédit promotionnel
 * ne se recharge pas, ne s'ajuste pas, ne se retire pas. Aucun autre compte n'est restreint ici.
 */
function assertAccountUsage(kind: WalletTransactionKind, account: LedgerAccountRef, amount: bigint): void {
  let allowed: boolean | null = null;
  switch (account.kind) {
    case "user_promo":
      allowed = ((kind === "subscription_charge" || kind === "boost_refund") && amount > ZERO)
        || ((kind === "boost_purchase" || kind === "promo_expiry" || kind === "subscription_refund") && amount < ZERO);
      break;
    case "promo_issuance":
      allowed = kind === "subscription_charge" && amount < ZERO;
      break;
    case "promo_consumed":
      allowed = (kind === "boost_purchase" && amount > ZERO) || (kind === "boost_refund" && amount < ZERO);
      break;
    case "promo_expired":
      allowed = (kind === "promo_expiry" || kind === "subscription_refund" || kind === "boost_refund") && amount > ZERO;
      break;
    case "subscription_revenue":
      allowed = (kind === "subscription_charge" && amount > ZERO) || (kind === "subscription_refund" && amount < ZERO);
      break;
    default:
      break;
  }
  if (allowed === false) throw new CatalogValidationError("Ce type de transaction ne peut pas écrire sur ce compte, ni dans ce sens.");
}

export function validateWalletTransactionInput(input: unknown): Required<WalletTransactionInput> {
  if (!isPlainRecord(input)) throw new CatalogValidationError("La transaction doit être un objet.");
  const { kind, reference, entries } = input;
  if (typeof kind !== "string" || !(WALLET_TRANSACTION_KINDS as readonly string[]).includes(kind)) {
    throw new CatalogValidationError(`kind doit valoir ${WALLET_TRANSACTION_KINDS.join(" ou ")}.`);
  }
  if (typeof reference !== "string" || !REFERENCE.test(reference) || !reference.startsWith(`${kind}:`)) {
    throw new CatalogValidationError("reference doit avoir la forme « <type>:<identifiant> » et commencer par le type de la transaction.");
  }
  const metadata = requireMetadata(input.metadata);
  if (kind === "topup" && (metadata.paymentIntentId === undefined || reference !== `topup:${metadata.paymentIntentId}`)) {
    throw new CatalogValidationError("Une recharge porte paymentIntentId et sa référence en dérive.");
  }
  // Mêmes règles que chk_wallet_transactions_boost : clés exactes, référence dérivée de l'achat ; aucune autre sorte n'en porte.
  const metadataKeys = Object.keys(metadata).sort().join(",");
  if (kind === "boost_purchase" && (metadataKeys !== "boostPurchaseId,quoteId" || reference !== `boost_purchase:${metadata.boostPurchaseId}`)) {
    throw new CatalogValidationError("Un achat de boost porte boostPurchaseId et quoteId, et sa référence en dérive de l'achat.");
  }
  if (kind === "boost_refund" && (metadataKeys !== "boostPurchaseId,reasonCode" || reference !== `boost_refund:${metadata.boostPurchaseId}`)) {
    throw new CatalogValidationError("Un remboursement de boost porte boostPurchaseId et reasonCode, et sa référence en dérive de l'achat.");
  }
  if (kind !== "boost_purchase" && kind !== "boost_refund" && (metadata.boostPurchaseId !== undefined || metadata.quoteId !== undefined)) {
    throw new CatalogValidationError("boostPurchaseId et quoteId sont réservés aux achats et remboursements de boost.");
  }
  // Mêmes règles que chk_wallet_transactions_pro : clés exactes, référence dérivée de la période ou de l'émission ; aucune autre sorte n'en porte.
  if (kind === "subscription_charge" && (metadataKeys !== "subscriptionPeriodId" || reference !== `subscription_charge:${metadata.subscriptionPeriodId}`)) {
    throw new CatalogValidationError("Un débit de période porte subscriptionPeriodId, et sa référence en dérive.");
  }
  if (kind === "subscription_refund" && (metadataKeys !== "reasonCode,subscriptionPeriodId" || reference !== `subscription_refund:${metadata.subscriptionPeriodId}`)) {
    throw new CatalogValidationError("Un remboursement de période porte subscriptionPeriodId et reasonCode, et sa référence en dérive.");
  }
  if (kind === "promo_expiry" && (metadataKeys !== "promoGrantId" || reference !== `promo_expiry:${metadata.promoGrantId}`)) {
    throw new CatalogValidationError("Une expiration promotionnelle porte promoGrantId, et sa référence en dérive.");
  }
  if (!["subscription_charge", "subscription_refund", "promo_expiry"].includes(kind) && (metadata.subscriptionPeriodId !== undefined || metadata.promoGrantId !== undefined)) {
    throw new CatalogValidationError("subscriptionPeriodId et promoGrantId sont réservés aux transactions de l'offre Pro.");
  }
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > MAX_ENTRIES) {
    throw new CatalogValidationError(`Une transaction compte de 2 à ${MAX_ENTRIES} écritures.`);
  }
  const accounts = new Set<string>();
  let total = ZERO;
  const validated: LedgerEntryInput[] = entries.map((entry: unknown) => {
    if (!isPlainRecord(entry) || Object.keys(entry).length !== 2) throw new CatalogValidationError("Écriture invalide.");
    const account = requireAccountRef(entry.account);
    const amount = requireLedgerAmount(entry.amount);
    assertAccountUsage(kind as WalletTransactionKind, account, amount);
    const key = account.kind === "user" || account.kind === "user_promo" ? `${account.kind}:${account.ownerId}` : account.kind;
    if (accounts.has(key)) throw new CatalogValidationError("Un compte ne figure qu'une fois par transaction.");
    accounts.add(key);
    total += amount;
    return { account, amount };
  });
  if (total !== ZERO) throw new CatalogValidationError("La somme des écritures doit valoir zéro.");
  return { kind: kind as WalletTransactionKind, reference, metadata, entries: validated };
}

// ───────────── comptes ─────────────

/** Compte de l'utilisateur, créé à la demande (INSERT … ON CONFLICT DO NOTHING). Renvoie son identifiant. */
export async function ensureUserWalletAccount(executor: SqlExecutor, ownerId: string): Promise<string> {
  const owner = requireUuid(ownerId, "ownerId").toLowerCase();
  try {
    await executor.query(
      "INSERT INTO wallet_accounts (id, kind, owner_id) VALUES ($1::uuid, 'user', $2::uuid) ON CONFLICT DO NOTHING",
      [randomUUID(), owner],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23503") throw new WalletError("account_owner_not_found");
    throw error;
  }
  const found = await executor.query<{ id: string }>(
    "SELECT id FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1::uuid",
    [owner],
  );
  return found.rows[0].id;
}

/** Sous-compte promotionnel de l'utilisateur, créé à la demande (INSERT … ON CONFLICT DO NOTHING). Renvoie son identifiant. */
export async function ensureUserPromoAccount(executor: SqlExecutor, ownerId: string): Promise<string> {
  const owner = requireUuid(ownerId, "ownerId").toLowerCase();
  try {
    await executor.query(
      "INSERT INTO wallet_accounts (id, kind, owner_id) VALUES ($1::uuid, 'user_promo', $2::uuid) ON CONFLICT DO NOTHING",
      [randomUUID(), owner],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23503") throw new WalletError("account_owner_not_found");
    throw error;
  }
  const found = await executor.query<{ id: string }>(
    "SELECT id FROM wallet_accounts WHERE kind = 'user_promo' AND owner_id = $1::uuid",
    [owner],
  );
  return found.rows[0].id;
}

/** Compte système (un seul par type) : créé par la migration ; recréé à la demande s'il manquait. */
export async function ensureSystemWalletAccount(
  executor: SqlExecutor,
  kind: WalletSystemAccountKind,
): Promise<string> {
  const select = () => executor.query<{ id: string }>("SELECT id FROM wallet_accounts WHERE kind = $1", [kind]);
  const existing = await select();
  if (existing.rows[0]) return existing.rows[0].id;
  await executor.query(
    "INSERT INTO wallet_accounts (id, kind, owner_id) VALUES ($1::uuid, $2, NULL) ON CONFLICT DO NOTHING",
    [randomUUID(), kind],
  );
  return (await select()).rows[0].id;
}

/** Traduit les refus de la base en erreurs de domaine ; toute autre erreur est relancée telle quelle. */
function mapLedgerError(error: unknown): unknown {
  const details = error as { code?: string; constraint?: string };
  if (details.code === "23505" && details.constraint === "uq_wallet_transactions_reference") return new WalletError("duplicate_reference");
  if (details.code === "23514" && details.constraint === "chk_wallet_accounts_user_balance_non_negative") return new WalletError("insufficient_balance");
  if (details.code === "23514" && details.constraint === "trg_wallet_transaction_balanced") return new WalletError("unbalanced_transaction");
  return error;
}

// ───────────── écriture ─────────────

/**
 * Enregistre une transaction DANS la transaction SQL du client fourni (celui de `withPostgresTransaction`) : l'appelant garde
 * donc le contrôle de l'atomicité avec d'autres écritures (changement d'état d'une intention, futur achat de boost). Validation
 * complète AVANT toute requête. L'équilibre est ensuite imposé par la base au COMMIT (contrainte différée).
 *
 * Erreurs : `duplicate_reference` (référence déjà utilisée : l'opération existe déjà), `insufficient_balance` (un compte
 * utilisateur deviendrait négatif), `account_owner_not_found`. La transaction SQL est alors à annuler par l'appelant.
 */
export async function postWalletTransaction(client: PoolClient, input: WalletTransactionInput): Promise<PostedWalletTransaction> {
  const validated = validateWalletTransactionInput(input);
  if ((client as NomaTransactionalClient).__inNomaTransaction !== true) {
    throw new CatalogValidationError("postWalletTransaction exige une transaction SQL ouverte (withPostgresTransaction).");
  }
  const resolved = [];
  for (const entry of validated.entries) {
    const accountId = entry.account.kind === "user"
      ? await ensureUserWalletAccount(client, entry.account.ownerId)
      : entry.account.kind === "user_promo"
        ? await ensureUserPromoAccount(client, entry.account.ownerId)
        : await ensureSystemWalletAccount(client, entry.account.kind);
    resolved.push({ accountId, amount: entry.amount });
  }
  // Ordre global des verrous de comptes : identifiant croissant.
  resolved.sort((left, right) => (left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0));

  const transactionId = randomUUID();
  try {
    const inserted = await client.query<{ created_at: Date }>(
      `INSERT INTO wallet_transactions (id, kind, reference, metadata)
       VALUES ($1::uuid, $2, $3, $4::jsonb)
       RETURNING created_at`,
      [transactionId, validated.kind, validated.reference, JSON.stringify(validated.metadata)],
    );
    for (const entry of resolved) {
      await client.query(
        "INSERT INTO wallet_entries (id, transaction_id, account_id, amount) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint)",
        [randomUUID(), transactionId, entry.accountId, entry.amount.toString()],
      );
    }
    return {
      id: transactionId,
      kind: validated.kind,
      reference: validated.reference,
      createdAt: inserted.rows[0].created_at,
      entries: resolved,
    };
  } catch (error) {
    throw mapLedgerError(error);
  }
}

/** Variante autonome : ouvre sa propre transaction SQL (ajustements, outils, tests). */
export async function recordWalletTransaction(pool: Pool, input: WalletTransactionInput): Promise<PostedWalletTransaction> {
  const validated = validateWalletTransactionInput(input);
  const checkedPool = requireWalletPool(pool);
  try {
    return await withPostgresTransaction((client) => postWalletTransaction(client, validated), checkedPool);
  } catch (error) {
    // L'équilibre est vérifié au COMMIT : l'erreur peut venir de withPostgresTransaction.
    throw mapLedgerError(error);
  }
}

// ───────────── lectures ─────────────

export async function readWalletBalance(pool: Pool, ownerId: string): Promise<bigint> {
  const checkedPool = requireWalletPool(pool);
  const owner = requireUuid(ownerId, "ownerId").toLowerCase();
  const result = await checkedPool.query<{ balance: string }>(
    "SELECT balance::text AS balance FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1::uuid",
    [owner],
  );
  return result.rows[0] ? BigInt(result.rows[0].balance) : ZERO;
}

export interface WalletHistoryItem {
  id: string;
  kind: WalletTransactionKind;
  /** Signé, côté utilisateur, sur ses crédits PAYÉS : positif = crédit reçu, négatif = débit. Nul pour une opération purement promotionnelle. */
  amount: bigint;
  /** Signé, côté utilisateur, sur ses crédits PROMOTIONNELS (lot PRO1) : positif = émis ou restitué, négatif = dépensé, expiré ou annulé. Nul si l'opération n'y touche pas. */
  promoAmount: bigint;
  createdAt: Date;
}

export interface WalletOverview {
  /** Crédits payés (rechargés, ajustés, remboursés). */
  balance: bigint;
  /** Crédits promotionnels dépensables maintenant (émissions non expirées), distincts des crédits payés : non remboursables, non retirables, ils expirent. */
  promoBalance: bigint;
  /** Échéance la plus proche des crédits promotionnels qui restent ; null s'il n'y en a pas. */
  promoExpiresAt: Date | null;
  items: WalletHistoryItem[];
  nextCursor: string | null;
}

const CURSOR_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;

export function encodeWalletCursor(createdAt: string, transactionId: string): string {
  return Buffer.from(`${createdAt}|${transactionId}`, "utf8").toString("base64url");
}

/** Curseur opaque (instant à la microseconde + identifiant) : toute autre forme est refusée. */
export function decodeWalletCursor(cursor: unknown): { createdAt: string; transactionId: string } {
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(cursor)) throw new CatalogValidationError("cursor invalide.");
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const parts = decoded.split("|");
  if (parts.length !== 2 || !CURSOR_AT.test(parts[0]) || !UUID_LOWER.test(parts[1])) throw new CatalogValidationError("cursor invalide.");
  if (encodeWalletCursor(parts[0], parts[1]) !== cursor) throw new CatalogValidationError("cursor invalide.");
  if (Number.isNaN(new Date(parts[0]).getTime())) throw new CatalogValidationError("cursor invalide.");
  return { createdAt: parts[0], transactionId: parts[1] };
}

/**
 * Solde et historique de l'utilisateur, plus récents d'abord (instant de la transaction, puis identifiant), lus dans UN instantané.
 * Un utilisateur sans compte a un solde nul et aucune ligne. Aucune donnée d'un autre compte n'est lue : seules les écritures du
 * compte de l'utilisateur sortent, avec leur montant signé.
 */
export async function readWalletOverview(input: {
  pool: Pool;
  ownerId: string;
  limit?: number;
  cursor?: string | null;
}): Promise<WalletOverview> {
  const pool = requireWalletPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const limit = input.limit ?? WALLET_HISTORY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WALLET_HISTORY_MAX_LIMIT) {
    throw new CatalogValidationError(`limit doit être un entier compris entre 1 et ${WALLET_HISTORY_MAX_LIMIT}.`);
  }
  const cursor = input.cursor === undefined || input.cursor === null ? null : decodeWalletCursor(input.cursor);

  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const account = await client.query<{ id: string; balance: string }>(
      "SELECT id, balance::text AS balance FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1::uuid",
      [ownerId],
    );
    const promo = await readPromoSummary(client, ownerId);
    let overview: WalletOverview = { balance: ZERO, promoBalance: promo.balance, promoExpiresAt: promo.expiresAt, items: [], nextCursor: null };
    // Une ligne par TRANSACTION : ses écritures sur le compte payé et sur le sous-compte promotionnel de l'utilisateur, additionnées chacune (jamais une écriture de la contrepartie).
    const rows = await client.query<{ id: string; kind: WalletTransactionKind; amount: string; promo_amount: string; created_at: Date; cursor_at: string }>(
      `SELECT t.id, t.kind,
              COALESCE(sum(e.amount) FILTER (WHERE a.kind = 'user'), 0)::text AS amount,
              COALESCE(sum(e.amount) FILTER (WHERE a.kind = 'user_promo'), 0)::text AS promo_amount,
              t.created_at,
              to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
         FROM wallet_entries e
         JOIN wallet_accounts a ON a.id = e.account_id
         JOIN wallet_transactions t ON t.id = e.transaction_id
        WHERE a.owner_id = $1::uuid AND a.kind IN ('user', 'user_promo')
          AND ($2::timestamptz IS NULL OR (t.created_at, t.id) < ($2::timestamptz, $3::uuid))
        GROUP BY t.id, t.kind, t.created_at
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $4::int`,
      [ownerId, cursor?.createdAt ?? null, cursor?.transactionId ?? null, limit + 1],
    );
    const page = rows.rows.slice(0, limit);
    const last = page[page.length - 1];
    overview = {
      balance: account.rows[0] ? BigInt(account.rows[0].balance) : ZERO,
      promoBalance: promo.balance,
      promoExpiresAt: promo.expiresAt,
      items: page.map((row) => ({ id: row.id, kind: row.kind, amount: BigInt(row.amount), promoAmount: BigInt(row.promo_amount), createdAt: row.created_at })),
      nextCursor: rows.rows.length > limit && last ? encodeWalletCursor(last.cursor_at, last.id) : null,
    };
    await client.query("COMMIT");
    return overview;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* conserver l'erreur utile */ }
    throw error;
  } finally {
    client.release();
  }
}
