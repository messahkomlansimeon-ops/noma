/**
 * Éléments partagés par les essais de l'offre Pro (lot PRO1) : utilisateurs, crédit de départ, annonces, cotations de boost, souscription, vérification du grand livre.
 * Chaque fonction reçoit le pool du schéma de test de son fichier.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createOffer, createUser } from "../../lib/server/catalog";
import type { OfferRecord } from "../../lib/server/catalog/types";
import { subscribeToPlan } from "../../lib/server/subscriptions/lifecycle";
import { checkWalletIntegrity, type WalletCheckReport } from "../../lib/server/wallet/check";
import { readWalletBalance, recordWalletTransaction } from "../../lib/server/wallet/ledger";
import { addReachableBuyer } from "./boost-fixtures";

export const big = (value: number | string): bigint => BigInt(value);

export const makeUser = async (db: Pool): Promise<string> => (await createUser({}, db)).id;

/** Crédit de départ (opération du grand livre autonome : boost_revenue → utilisateur, motif de test). */
export async function fund(db: Pool, userId: string, amount: number): Promise<void> {
  await recordWalletTransaction(db, {
    kind: "adjustment",
    reference: `adjustment:fund-${randomUUID()}`,
    metadata: { reasonCode: "test_fixture" },
    entries: [
      { account: { kind: "boost_revenue" }, amount: -big(amount) },
      { account: { kind: "user", ownerId: userId }, amount: big(amount) },
    ],
  });
}

export const balanceOf = (db: Pool, userId: string): Promise<bigint> => readWalletBalance(db, userId);

export async function scalar<T = string>(db: Pool, text: string, values: unknown[] = []): Promise<T> {
  return (await db.query(text, values)).rows[0].n as T;
}

export const countRows = async (db: Pool, table: string, where = "TRUE", values: unknown[] = []): Promise<number> =>
  Number(await scalar(db, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values));

/** Solde d'un compte système (texte → bigint). */
export const systemBalance = async (db: Pool, kind: string): Promise<bigint> =>
  big(await scalar(db, "SELECT COALESCE(sum(balance), 0)::text AS n FROM wallet_accounts WHERE kind = $1", [kind]));

/** Solde du sous-compte promotionnel (écrit au grand livre : peut contenir des crédits échus pas encore expirés). */
export const promoLedgerBalance = async (db: Pool, userId: string): Promise<bigint> =>
  big(await scalar(db, "SELECT COALESCE(sum(balance), 0)::text AS n FROM wallet_accounts WHERE kind = 'user_promo' AND owner_id = $1", [userId]));

export async function assertWalletGreen(db: Pool, label: string): Promise<WalletCheckReport> {
  const report = await checkWalletIntegrity(db);
  assert.deepEqual(report.violations, [], `${label} : wallet:check doit être vert`);
  return report;
}

/** État comptable global : rien n'a changé si cet instantané est identique avant et après un refus. */
export async function ledgerSnapshot(db: Pool): Promise<Record<string, string>> {
  return (await db.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM wallet_transactions)::text AS transactions, (SELECT count(*) FROM wallet_entries)::text AS entries,
            (SELECT COALESCE(sum(abs(balance)), 0) FROM wallet_accounts)::text AS balances, (SELECT count(*) FROM wallet_accounts)::text AS accounts,
            (SELECT count(*) FROM subscriptions)::text AS subscriptions, (SELECT count(*) FROM subscription_periods)::text AS periods,
            (SELECT count(*) FROM promo_grants)::text AS grants, (SELECT count(*) FROM promo_movements)::text AS movements,
            (SELECT count(*) FROM boost_purchases)::text AS purchases, (SELECT count(*) FROM offer_boosts)::text AS boosts`)).rows[0];
}

/** Souscription au plan Pro avec une clé neuve (horloge injectable). */
export const subscribePro = (db: Pool, userId: string, options: { now?: Date; key?: string; plan?: string } = {}) =>
  subscribeToPlan({ pool: db, userId, planCode: options.plan ?? "pro", idempotencyKey: options.key ?? randomUUID(), now: options.now });

/** Un utilisateur crédité de `credit` XOF puis abonné au plan Pro (10 000 XOF, 5 000 XOF de crédits promotionnels). */
export async function makePro(db: Pool, credit = 10_000, now?: Date): Promise<{ userId: string; subscriptionId: string; periodId: string }> {
  const userId = await makeUser(db);
  if (credit > 0) await fund(db, userId, credit);
  const result = await subscribePro(db, userId, { now });
  return { userId, subscriptionId: result.subscriptionId, periodId: result.periodId };
}

/** Début, fin de la période courante et de l'émission promotionnelle de l'abonnement d'un utilisateur. */
export async function periodOf(db: Pool, userId: string): Promise<{ start: Date; end: Date; status: string; graceEnds: Date | null }> {
  const row = (await db.query<{ start: Date; end: Date; status: string; grace: Date | null }>(
    `SELECT current_period_start AS start, current_period_end AS "end", status, grace_ends_at AS grace
       FROM subscriptions WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
  return { start: row.start, end: row.end, status: row.status, graceEnds: row.grace };
}

export const addMs = (date: Date, ms: number): Date => new Date(date.getTime() + ms);
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

let counter = 0;

/** Une annonce EN LIGNE (ou autre statut) du propriétaire donné. */
export async function makeOffer(
  db: Pool,
  ownerId: string,
  input: { status?: "published" | "paused" | "draft"; category?: string; brand?: string; model?: string; rawText?: string } = {},
): Promise<OfferRecord> {
  counter += 1;
  return createOffer({
    ownerId,
    rawText: input.rawText ?? `Annonce de test ${counter} ${randomBytes(3).toString("hex")}`,
    category: input.category ?? `cat${counter}x${randomBytes(2).toString("hex")}`,
    brand: input.brand ?? "acme",
    model: input.model ?? `m${counter}`,
    price: { amount: 100_000 + counter, currency: "XOF" },
    status: input.status ?? "published",
    availabilityStatus: "available",
  }, db);
}

/** Un périmètre produit UNIQUE : aucune interférence de places entre les tests. */
export interface Scope { category: string; brand: string; model: string }
export function makeScope(): Scope {
  counter += 1;
  return { category: `cat${counter}x${randomBytes(2).toString("hex")}`, brand: "acme", model: `m${counter}` };
}

/** Une offre publiée dans un périmètre, avec un acheteur atteignable (l'achat de boost revérifie la portée). */
const reachableOffers = new Set<string>();
export async function ensureReachable(db: Pool, offer: OfferRecord): Promise<void> {
  if (reachableOffers.has(offer.id)) return;
  reachableOffers.add(offer.id);
  await addReachableBuyer(db, offer);
}

const scopeOf = (offer: OfferRecord): Scope => ({
  category: offer.category!.trim().toLowerCase(), brand: offer.brand!.trim().toLowerCase(), model: offer.model!.trim().toLowerCase(),
});

/** Cotation insérée directement (lignes immuables : seul le code les écrit en production). Le prix est celui qu'on donne. */
export async function insertQuote(
  db: Pool,
  offer: OfferRecord,
  options: { amount?: number; durationCode?: "24h" | "3d" | "7d"; expiresInSeconds?: number } = {},
): Promise<string> {
  const id = randomUUID();
  const scope = scopeOf(offer);
  const amount = options.amount ?? 2300;
  await db.query(
    `INSERT INTO boost_quotes (
       id, offer_id, seller_id, scope_category, scope_brand, scope_model, duration_code, pricing_key, pricing_version, currency,
       status, unavailable_reason, amount, raw_amount, competition_milli, demand_milli, scarcity_milli, duration_milli,
       competing_sellers, compatible_buyers, slots_total, slots_used, computed_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'default', 1, 'XOF',
       'available', NULL, $8, $9, 1000, 1000, 1000, 1000, 1, 1, 1, 0,
       clock_timestamp() - make_interval(secs => 7200), clock_timestamp() + make_interval(secs => $10::int))`,
    [id, offer.id, offer.ownerId, scope.category, scope.brand, scope.model, options.durationCode ?? "24h", amount, String(amount), options.expiresInSeconds ?? 900],
  );
  await ensureReachable(db, offer);
  return id;
}

/** Un vendeur avec une offre publiée dans un périmètre neuf et une cotation disponible au prix donné. */
export async function buyWorld(db: Pool, options: { sellerId?: string; amount?: number; offers?: number } = {}) {
  const scope = makeScope();
  const sellerId = options.sellerId ?? await makeUser(db);
  const offer = await makeOffer(db, sellerId, scope);
  for (let index = 1; index < (options.offers ?? 1); index += 1) await makeOffer(db, await makeUser(db), scope);
  return { sellerId, offer, scope, quoteId: await insertQuote(db, offer, { amount: options.amount }) };
}
