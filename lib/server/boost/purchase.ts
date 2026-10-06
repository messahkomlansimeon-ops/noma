import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { CatalogValidationError } from "../catalog/errors";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction } from "../postgres/client";
import { postWalletTransaction } from "../wallet/ledger";
import {
  BOOST_LOCK_TIMEOUT_MS, BOOST_PURCHASE_LOCK_NAMESPACE, type BoostDurationCode,
} from "./boost-config";
import { BOOST_PURCHASE_REACH_BUDGET_MS, computeBoostReach, isReachUndetermined } from "./reach";
import {
  BOOST_COLUMNS, BoostError, cancelOfferBoostInTransaction, mapBoost, placeOfferBoostInTransaction, withReadOnlySnapshot,
  type BoostRow, type BoostScope, type OfferBoostRecord,
} from "./boosts";

/**
 * Achat atomique d'un boost avec les crédits du portefeuille (lot P1b) et remboursement d'administration. Voir BOOST-PURCHASE.md.
 *
 * UNE transaction SQL (`purchaseOfferBoost`) : idempotence, devis (propriétaire, disponibilité, validité, jamais déjà acheté),
 * puis LES MÊMES règles de places et de plafond vendeur que l'attribution d'administration (`placeOfferBoostInTransaction`, une
 * seule copie), puis le débit (`postWalletTransaction`, transaction `boost_purchase`), le boost (source `purchase`) et la ligne
 * `boost_purchases`. Tout échec, à n'importe quelle étape, annule tout : jamais de débit sans boost, jamais de boost sans débit.
 *
 * ORDRE GLOBAL DES VERROUS (toute transaction du système les prend dans cet ordre, jamais à l'envers : pas d'interblocage) :
 *   1. verrou consultatif d'IDEMPOTENCE (vendeur, clé) — achat seulement ;
 *   2. verrou consultatif de COTATION par offre — cotations seulement (quotes.ts) ;
 *   2b. (lot P3) verrou consultatif du VENDEUR (limite de débit des devis) — cotations seulement, pris juste après le précédent ;
 *   3. ligne de l'offre, FOR SHARE ;
 *   4. verrou consultatif de PÉRIMÈTRE (clé produit) — attribution et achat ;
 *   5. ligne de l'achat, FOR UPDATE — remboursement seulement ;
 *   6. lignes de boost de l'offre (échéance, annulation) ;
 *   7. comptes du grand livre, par identifiant croissant (écritures insérées dans cet ordre : voir ledger.ts) ;
 *   8. insertion de la ligne d'achat (ou mise à jour, au remboursement).
 * La revérification de la portée de l'achat (lot P3) est une LECTURE faite sous 1 et 4, avant 7 : elle ne prend aucun verrou de plus.
 * Une attente de verrou est bornée par `lock_timeout` (BOOST_LOCK_TIMEOUT_MS).
 */

export interface BoostPurchaseRecord {
  id: string;
  sellerId: string;
  offerId: string;
  quoteId: string;
  boostId: string;
  transactionId: string;
  durationCode: BoostDurationCode;
  /** XOF entiers (jamais de flottant). */
  amount: bigint;
  idempotencyKey: string;
  createdAt: Date;
  refundedAt: Date | null;
  refundTransactionId: string | null;
}

export interface BoostPurchaseResult {
  purchase: BoostPurchaseRecord;
  boost: OfferBoostRecord;
  /** Solde du vendeur après l'achat (ou courant, pour un rejeu). */
  balance: bigint;
  /** Vrai si cet appel a renvoyé un achat déjà enregistré pour la même clé d'idempotence : aucun nouveau débit. */
  reused: boolean;
}

export interface BoostRefundResult {
  purchase: BoostPurchaseRecord;
  boost: OfferBoostRecord;
  /** Vrai si CE remboursement a annulé un boost encore actif ; faux si le boost était déjà annulé ou expiré. */
  boostCancelled: boolean;
  /** Montant intégral recrédité. */
  refundedAmount: bigint;
  /** Solde du vendeur après le remboursement. */
  balance: bigint;
}

export interface BoostPurchaseHistoryItem {
  id: string;
  quoteId: string;
  durationCode: BoostDurationCode;
  amount: bigint;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  refundedAt: Date | null;
}

export interface BoostPurchaseTestHooks {
  /** Réservé aux tests : appelé après TOUS les contrôles (places, plafond, solde non encore débité) et juste avant le débit. */
  beforeDebit?: () => void | Promise<void>;
  /** Réservé aux tests : appelé juste après le débit, avant la création du boost. */
  afterDebit?: () => void | Promise<void>;
  /** Réservé aux tests : appelé pendant la revérification de la portée (verrou du périmètre tenu), avant l'examen de chaque besoin. */
  beforeReachDemand?: (index: number) => void | Promise<void>;
  /** Réservé aux tests : horloge et budget (ms) de la revérification de la portée. */
  reachClock?: () => number;
  reachBudgetMs?: number;
}

export interface BoostRefundTestHooks {
  /** Réservé aux tests : appelé après le verrou de l'achat et l'annulation du boost, juste avant l'écriture du remboursement. */
  beforeLedger?: () => void | Promise<void>;
}

// ───────────── validations (avant tout SQL) ─────────────

const REASON_CODE = /^[a-z_]{1,40}$/;

function requirePurchasePool(pool: unknown): Pool {
  if (pool === undefined || pool === null) throw new CatalogValidationError("Un pool PostgreSQL est requis.");
  return requireTransactionPool(pool);
}

function requireLimit(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new CatalogValidationError(`limit doit être un entier compris entre 1 et ${max}.`);
  }
  return value;
}

// ───────────── lignes ─────────────

interface PurchaseRow {
  id: string;
  seller_id: string;
  offer_id: string;
  quote_id: string;
  boost_id: string;
  transaction_id: string;
  amount_xof: string;
  duration_code: BoostDurationCode;
  idempotency_key: string;
  created_at: Date;
  refunded_at: Date | null;
  refund_transaction_id: string | null;
}

/** Colonnes d'un achat, préfixées par l'alias de table (`p.`) ou sans préfixe (clause RETURNING). */
const purchaseColumns = (prefix: string): string => `${prefix}id, ${prefix}seller_id, ${prefix}offer_id, ${prefix}quote_id, ${prefix}boost_id,
  ${prefix}transaction_id, ${prefix}amount_xof::text AS amount_xof, ${prefix}duration_code, ${prefix}idempotency_key, ${prefix}created_at,
  ${prefix}refunded_at, ${prefix}refund_transaction_id`;
const PURCHASE_COLUMNS = purchaseColumns("p.");
const PURCHASE_RETURNING = purchaseColumns("");

function mapPurchase(row: PurchaseRow): BoostPurchaseRecord {
  return {
    id: row.id,
    sellerId: row.seller_id,
    offerId: row.offer_id,
    quoteId: row.quote_id,
    boostId: row.boost_id,
    transactionId: row.transaction_id,
    durationCode: row.duration_code,
    amount: BigInt(row.amount_xof),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    refundedAt: row.refunded_at,
    refundTransactionId: row.refund_transaction_id,
  };
}

async function readBoost(client: PoolClient, boostId: string): Promise<OfferBoostRecord> {
  const result = await client.query<BoostRow>(`SELECT ${BOOST_COLUMNS} FROM offer_boosts WHERE id = $1::uuid`, [boostId]);
  if (!result.rows[0]) throw new BoostError("boost_not_found");
  return mapBoost(result.rows[0]);
}

async function readUserBalance(client: PoolClient, userId: string): Promise<bigint> {
  const result = await client.query<{ balance: string }>(
    "SELECT balance::text AS balance FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1::uuid",
    [userId],
  );
  return result.rows[0] ? BigInt(result.rows[0].balance) : BigInt(0);
}

interface QuoteRow {
  id: string;
  offer_id: string;
  seller_id: string;
  status: "available" | "unavailable";
  duration_code: BoostDurationCode;
  amount: number | null;
  scope_category: string;
  scope_brand: string;
  scope_model: string;
  expired: boolean;
}

/**
 * Contrôles de la cotation (relus sous le verrou du périmètre : l'horloge est celle de la base, à CE moment) :
 * elle existe et appartient à CETTE offre ET à CE vendeur (sinon `quote_not_found`, indiscernable d'une cotation inexistante) ;
 * elle est disponible (`quote_unavailable`) ; elle n'est pas échue (`quote_expired`) ; si `scope` est donné, la clé produit de
 * l'offre est toujours celle de la cotation (sinon le prix ne vaut plus : `quote_expired`) ; elle n'a pas déjà été achetée
 * (`quote_already_used`, même si l'achat a été remboursé : un devis ne s'achète qu'une fois). Le prix est celui de la cotation,
 * jamais recalculé.
 */
async function assertQuotePurchasable(
  client: PoolClient,
  input: { quoteId: string; sellerId: string; offerId: string; scope?: BoostScope },
): Promise<{ amount: bigint; durationCode: BoostDurationCode }> {
  const found = await client.query<QuoteRow>(
    `SELECT id, offer_id, seller_id, status, duration_code, amount, scope_category, scope_brand, scope_model,
            (clock_timestamp() >= expires_at) AS expired
       FROM boost_quotes WHERE id = $1::uuid`,
    [input.quoteId],
  );
  const quote = found.rows[0];
  if (!quote || quote.offer_id !== input.offerId || quote.seller_id !== input.sellerId) throw new BoostError("quote_not_found");
  if (quote.status !== "available" || quote.amount === null) throw new BoostError("quote_unavailable");
  if (quote.expired) throw new BoostError("quote_expired");
  const { scope } = input;
  if (scope && (quote.scope_category !== scope.category || quote.scope_brand !== scope.brand || quote.scope_model !== scope.model)) {
    throw new BoostError("quote_expired");
  }
  const used = await client.query("SELECT 1 FROM boost_purchases WHERE quote_id = $1::uuid LIMIT 1", [input.quoteId]);
  if (used.rowCount) throw new BoostError("quote_already_used");
  return { amount: BigInt(quote.amount), durationCode: quote.duration_code };
}

// ───────────── achat ─────────────

/**
 * Achète le boost d'une cotation, en UNE transaction SQL. Ordre :
 *  1. validation avant tout SQL (UUID du vendeur, de l'offre, de la cotation, clé d'idempotence en UUID) ;
 *  2. idempotence : verrou (vendeur, clé) puis relecture. Un achat existant pour la même clé : même cotation et même offre → il
 *     est renvoyé (`reused: true`, aucun nouveau débit, même si la cotation a expiré depuis) ; sinon `idempotency_conflict` ;
 *  3. cotation (`assertQuotePurchasable`) : 404 indiscernable (`quote_not_found`) si elle n'est pas à CE vendeur pour CETTE offre ;
 *     `quote_unavailable`, `quote_expired`, `quote_already_used` ;
 *  4. placement : offre admissible (`offer_not_found`, `offer_not_owned`, `offer_not_eligible`, `offer_not_boostable`), verrou de
 *     périmètre, cotation relue sous le verrou, `offer_already_boosted`, `no_slot_available`, `seller_boost_limit_reached` : les
 *     MÊMES règles et codes que `grantOfferBoost` (`placeOfferBoostInTransaction`) ; puis PORTÉE revérifiée sous le verrou du périmètre
 *     (lot P3, `no_visible_effect` : aucun acheteur ne verrait l'offre monter, démontré ; lot P3-bis, `reach_check_unavailable` : vérification non terminée dans le budget, rien démontré ; avant le débit) ;
 *  5. le prix est EXACTEMENT le montant de la cotation et la durée celle de la cotation ; le boost commence à clock_timestamp() ;
 *  6. débit : transaction `boost_purchase` (vendeur −montant, `boost_revenue` +montant) ; solde insuffisant → WalletError
 *     `insufficient_balance` et RIEN n'est écrit ;
 *  7. boost (source `purchase`) puis ligne `boost_purchases`.
 * Rejouer la requête (même clé) ne débite pas deux fois ; 20 rejeux simultanés donnent un seul achat.
 */
export async function purchaseOfferBoost(input: {
  pool: Pool;
  sellerId: string;
  offerId: string;
  quoteId: string;
  idempotencyKey: string;
  hooks?: BoostPurchaseTestHooks;
}): Promise<BoostPurchaseResult> {
  const pool = requirePurchasePool(input.pool);
  const sellerId = requireUuid(input.sellerId, "sellerId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const quoteId = requireUuid(input.quoteId, "quoteId").toLowerCase();
  const idempotencyKey = requireUuid(input.idempotencyKey, "idempotencyKey").toLowerCase();

  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${BOOST_LOCK_TIMEOUT_MS}ms'`);

    // 2. Idempotence : les rejeux d'une même clé se sérialisent ; le premier crée, les suivants relisent.
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [BOOST_PURCHASE_LOCK_NAMESPACE, `${sellerId}:${idempotencyKey}`]);
    const replay = await client.query<PurchaseRow>(
      `SELECT ${PURCHASE_COLUMNS} FROM boost_purchases p WHERE p.seller_id = $1::uuid AND p.idempotency_key = $2::uuid`,
      [sellerId, idempotencyKey],
    );
    if (replay.rows[0]) {
      const existing = mapPurchase(replay.rows[0]);
      if (existing.quoteId !== quoteId || existing.offerId !== offerId) throw new BoostError("idempotency_conflict");
      return {
        purchase: existing, boost: await readBoost(client, existing.boostId), balance: await readUserBalance(client, sellerId), reused: true,
      };
    }

    // 3. Cotation : le prix et la durée sont ceux de la cotation (lignes immuables), jamais recalculés.
    const price = await assertQuotePurchasable(client, { quoteId, sellerId, offerId });

    // 4 à 7.
    const purchaseId = randomUUID();
    let transactionId: string | undefined;
    const placed = await placeOfferBoostInTransaction(client, {
      offerId,
      ownerId: sellerId,
      durationCode: price.durationCode,
      source: "purchase",
      afterScopeLock: async ({ scope }) => {
        // Sous le verrou du périmètre : la cotation est relue (échéance à CET instant, achat concurrent, périmètre actuel de l'offre).
        await assertQuotePurchasable(client, { quoteId, sellerId, offerId, scope });
      },
      beforeInsert: async () => {
        // Portée REVÉRIFIÉE sous le verrou du périmètre (lot P3), après les contrôles de places et AVANT le débit : le devis date de jusqu'à 15 minutes,
        // les listes des acheteurs et les autres boosts ont pu changer (un boost plus ancien peut avoir pris la place). Arrêt au premier acheteur
        // atteignable ; aucun DÉMONTRÉ (tous les besoins examinés dans les bornes) → `no_visible_effect` ; budget ou délai épuisé sans en trouver (lot
        // P3-bis : verrou lent, base chargée) → `reach_check_unavailable` (503, à réessayer avec la MÊME clé), jamais un refus définitif. RIEN n'est écrit
        // dans les deux cas (ni débit, ni boost, ni achat).
        const reach = await computeBoostReach(client, {
          offerId, mode: "first", budgetMs: input.hooks?.reachBudgetMs ?? BOOST_PURCHASE_REACH_BUDGET_MS,
          clock: input.hooks?.reachClock, beforeDemand: input.hooks?.beforeReachDemand,
        });
        if (isReachUndetermined(reach)) throw new BoostError("reach_check_unavailable");
        if (reach.reachableBuyers === 0) throw new BoostError("no_visible_effect");
        if (input.hooks?.beforeDebit) await input.hooks.beforeDebit();
        const amount = price.amount;
        const posted = await postWalletTransaction(client, {
          kind: "boost_purchase",
          reference: `boost_purchase:${purchaseId}`,
          metadata: { boostPurchaseId: purchaseId, quoteId },
          entries: [
            { account: { kind: "user", ownerId: sellerId }, amount: -amount },
            { account: { kind: "boost_revenue" }, amount },
          ],
        });
        transactionId = posted.id;
        if (input.hooks?.afterDebit) await input.hooks.afterDebit();
      },
    });

    const inserted = await client.query<PurchaseRow>(
      `INSERT INTO boost_purchases (id, seller_id, offer_id, quote_id, boost_id, transaction_id, amount_xof, duration_code, idempotency_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::bigint, $8, $9::uuid)
       RETURNING ${PURCHASE_RETURNING}`,
      [purchaseId, sellerId, offerId, quoteId, placed.boost.id, transactionId, price.amount.toString(), price.durationCode, idempotencyKey],
    ).catch((error: unknown) => {
      const details = error as { code?: string; constraint?: string };
      if (details.code === "23505" && details.constraint === "uq_boost_purchases_quote") throw new BoostError("quote_already_used");
      throw error;
    });
    return {
      purchase: mapPurchase(inserted.rows[0]), boost: placed.boost, balance: await readUserBalance(client, sellerId), reused: false,
    };
  }, pool);
}

// ───────────── remboursement (administration) ─────────────

/**
 * Rembourse INTÉGRALEMENT un achat (opération d'administration : aucune route HTTP), en UNE transaction : verrou de l'achat
 * (`FOR UPDATE`), `purchase_not_found` s'il n'existe pas, `already_refunded` s'il l'est déjà ; annulation du boost s'il est encore
 * actif (`cancelOfferBoostInTransaction`, la logique de `cancelOfferBoost` : un boost déjà expiré ou annulé n'est pas touché, le
 * crédit est tout de même rendu) ; transaction `boost_refund` du MONTANT INTÉGRAL (boost_revenue −montant, vendeur +montant),
 * référence `boost_refund:<achat>` (UNIQUE : un seul remboursement par achat, même en parallèle) ; l'achat est marqué remboursé.
 * Aucun prorata : le montant ne dépend ni de l'usage ni du temps restant.
 */
export async function refundBoostPurchase(input: {
  pool: Pool;
  purchaseId: string;
  reasonCode: string;
  hooks?: BoostRefundTestHooks;
}): Promise<BoostRefundResult> {
  const pool = requirePurchasePool(input.pool);
  const purchaseId = requireUuid(input.purchaseId, "purchaseId").toLowerCase();
  if (typeof input.reasonCode !== "string" || !REASON_CODE.test(input.reasonCode)) {
    throw new CatalogValidationError("reasonCode doit être un code en minuscules et tirets bas (1 à 40 caractères).");
  }
  const reasonCode = input.reasonCode;

  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${BOOST_LOCK_TIMEOUT_MS}ms'`);
    const found = await client.query<PurchaseRow>(`SELECT ${PURCHASE_COLUMNS} FROM boost_purchases p WHERE p.id = $1::uuid FOR UPDATE`, [purchaseId]);
    if (!found.rows[0]) throw new BoostError("purchase_not_found");
    const purchase = mapPurchase(found.rows[0]);
    if (purchase.refundedAt !== null) throw new BoostError("already_refunded");

    const cancel = await cancelOfferBoostInTransaction(client, { boostId: purchase.boostId, ownerId: purchase.sellerId });
    if (input.hooks?.beforeLedger) await input.hooks.beforeLedger();

    const posted = await postWalletTransaction(client, {
      kind: "boost_refund",
      reference: `boost_refund:${purchase.id}`,
      metadata: { boostPurchaseId: purchase.id, reasonCode },
      entries: [
        { account: { kind: "boost_revenue" }, amount: -purchase.amount },
        { account: { kind: "user", ownerId: purchase.sellerId }, amount: purchase.amount },
      ],
    });
    const updated = await client.query<PurchaseRow>(
      `UPDATE boost_purchases SET refunded_at = clock_timestamp(), refund_transaction_id = $2::uuid
        WHERE id = $1::uuid AND refunded_at IS NULL
        RETURNING ${PURCHASE_RETURNING}`,
      [purchase.id, posted.id],
    );
    if (!updated.rows[0]) throw new BoostError("already_refunded");
    return {
      purchase: mapPurchase(updated.rows[0]),
      boost: cancel.boost,
      boostCancelled: cancel.cancelled,
      refundedAmount: purchase.amount,
      balance: await readUserBalance(client, purchase.sellerId),
    };
  }, pool);
}

// ───────────── historique ─────────────

/**
 * Historique des achats du vendeur pour SON offre (plus récents d'abord : created_at, id), lu dans un instantané. `offer_not_found`
 * si l'offre n'existe pas, `offer_not_owned` si elle est à un autre. Ni identifiant de boost, ni de transaction.
 */
export async function listOfferBoostPurchases(input: {
  pool: Pool;
  sellerId: string;
  offerId: string;
  limit: number;
}): Promise<BoostPurchaseHistoryItem[]> {
  const pool = requirePurchasePool(input.pool);
  const sellerId = requireUuid(input.sellerId, "sellerId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const limit = requireLimit(input.limit, 50);
  return withReadOnlySnapshot(pool, async (client) => {
    const offer = await client.query<{ owner_id: string }>("SELECT owner_id FROM offers WHERE id = $1::uuid", [offerId]);
    if (!offer.rows[0]) throw new BoostError("offer_not_found");
    if (offer.rows[0].owner_id !== sellerId) throw new BoostError("offer_not_owned");
    const rows = await client.query<PurchaseRow & { starts_at: Date; ends_at: Date }>(
      `SELECT ${PURCHASE_COLUMNS}, b.starts_at, b.ends_at
         FROM boost_purchases p JOIN offer_boosts b ON b.id = p.boost_id
        WHERE p.offer_id = $1::uuid AND p.seller_id = $2::uuid
        ORDER BY p.created_at DESC, p.id DESC LIMIT $3::int`,
      [offerId, sellerId, limit],
    );
    return rows.rows.map((row) => {
      const purchase = mapPurchase(row);
      return {
        id: purchase.id, quoteId: purchase.quoteId, durationCode: purchase.durationCode, amount: purchase.amount,
        startsAt: row.starts_at, endsAt: row.ends_at, createdAt: purchase.createdAt, refundedAt: purchase.refundedAt,
      };
    });
  });
}
