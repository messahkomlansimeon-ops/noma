import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { CatalogValidationError } from "../catalog/errors";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { buildMatchingFreshnessPredicate, MATCHING_FRESHNESS_FROM, resolveMatchingFreshnessParams } from "../matching/persistence";
import { withPostgresTransaction, type SqlExecutor } from "../postgres/client";
import {
  BOOST_DURATION_CODES, BOOST_LOCK_TIMEOUT_MS, BOOST_QUOTE_LOCK_NAMESPACE, BOOST_UNAVAILABLE_QUOTE_SECONDS,
  type BoostDurationCode,
} from "./boost-config";
import {
  BOOST_ELIGIBLE_OFFER_SQL, BoostError, boostEffectiveSql, completeScope, computeSellerLimit, computeSlots, loadOfferFacts,
  readBoostSettings, withReadOnlySnapshot, type BoostScope,
} from "./boosts";
import {
  computeBoostPrice, validatePricingSettings, type BoostPriceFactors, type BoostPricingSettings,
} from "./pricing";

/**
 * Cotations vendeur du boost (lot 2I2) : un prix daté, conservé pendant sa courte validité. AUCUN paiement, achat, crédit ni
 * réservation de place : la disponibilité sera revérifiée à l'achat (lot paiement). Les cotations sont IMMUABLES : ce module
 * n'en modifie jamais une, il en lit ou en insère. Voir BOOST-PRICING.md.
 */

export type BoostQuoteUnavailableReason =
  | "offer_already_boosted"
  | "no_slot_available"
  | "seller_boost_limit_reached"
  | "no_compatible_buyer";

export interface BoostQuoteInputs {
  /** Vendeurs autres distincts ayant une offre éligible dans le périmètre (nombre daté, aucune identité). */
  competingSellers: number;
  /** Acheteurs compatibles distincts pour CETTE offre (nombre daté, aucune identité). */
  compatibleBuyers: number;
  slotsTotal: number;
  slotsUsed: number;
}

export interface BoostQuote {
  id: string;
  offerId: string;
  durationCode: BoostDurationCode;
  currency: "XOF";
  status: "available" | "unavailable";
  /** Montant en XOF, ou null si la cotation est indisponible. */
  amount: number | null;
  /** Prix brut exact (12 décimales), ou null si indisponible. */
  rawAmount: string | null;
  unavailableReason: BoostQuoteUnavailableReason | null;
  factors: BoostPriceFactors | null;
  inputs: BoostQuoteInputs;
  pricing: { key: string; version: number };
  computedAt: Date;
  expiresAt: Date;
  /** Vrai si cette réponse renvoie une cotation déjà enregistrée et encore valable (aucune écriture). */
  reused: boolean;
}

export type BoostQuoteHistoryItem = Omit<BoostQuote, "reused"> & { expired: boolean };

export interface BoostScopePricePoint {
  computedAt: Date;
  durationCode: BoostDurationCode;
  currency: "XOF";
  amount: number;
  factors: BoostPriceFactors;
  pricing: { key: string; version: number };
}

export interface BoostQuoteTestHooks {
  /** Réservé aux tests : appelé dans la transaction, après le calcul et juste avant l'INSERT. */
  beforeInsert?: () => void | Promise<void>;
}

// ───────────── validations (avant tout SQL) ─────────────

function requireQuotePool(pool: unknown): Pool {
  if (pool === undefined || pool === null) throw new CatalogValidationError("Un pool PostgreSQL est requis.");
  return requireTransactionPool(pool);
}

function requireQuoteDuration(value: unknown): BoostDurationCode {
  if (typeof value !== "string" || !(BOOST_DURATION_CODES as readonly string[]).includes(value)) {
    throw new CatalogValidationError(`durationCode doit valoir ${BOOST_DURATION_CODES.join(", ")}.`);
  }
  return value as BoostDurationCode;
}

function requireLimit(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new CatalogValidationError(`limit doit être un entier compris entre 1 et ${max}.`);
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new CatalogValidationError(`${field} doit être un texte non vide.`);
  return value;
}

// ───────────── réglages tarifaires ─────────────

interface PricingRow {
  key: string;
  version: number;
  currency: string;
  base_amount: number;
  grid_amount: number;
  min_amount: number;
  max_amount: number;
  competition_step_milli: number;
  competition_max_milli: number;
  demand_step_milli: number;
  demand_max_milli: number;
  scarcity_max_milli: number;
  duration_24h_milli: number;
  duration_3d_milli: number;
  duration_7d_milli: number;
  quote_validity_seconds: number;
}

/**
 * Réglages tarifaires : la ligne de la catégorie (lower(btrim)) si elle existe, sinon `default` ; toujours la version la plus
 * élevée de la clé retenue. `boost_pricing_missing` si aucune des deux n'existe.
 */
export async function readBoostPricingSettings(executor: SqlExecutor, category: string | null): Promise<BoostPricingSettings> {
  const result = await executor.query<PricingRow>(
    `SELECT key, version, currency, base_amount, grid_amount, min_amount, max_amount, competition_step_milli, competition_max_milli,
            demand_step_milli, demand_max_milli, scarcity_max_milli, duration_24h_milli, duration_3d_milli, duration_7d_milli,
            quote_validity_seconds
       FROM boost_pricing_settings
      WHERE key = lower(btrim($1::text)) OR key = 'default'
      ORDER BY (key = 'default') ASC, version DESC
      LIMIT 1`,
    [category],
  );
  const row = result.rows[0];
  if (!row) throw new BoostError("boost_pricing_missing");
  return validatePricingSettings({
    key: row.key,
    version: row.version,
    currency: row.currency as "XOF",
    baseAmount: row.base_amount,
    gridAmount: row.grid_amount,
    minAmount: row.min_amount,
    maxAmount: row.max_amount,
    competitionStepMilli: row.competition_step_milli,
    competitionMaxMilli: row.competition_max_milli,
    demandStepMilli: row.demand_step_milli,
    demandMaxMilli: row.demand_max_milli,
    scarcityMaxMilli: row.scarcity_max_milli,
    duration24hMilli: row.duration_24h_milli,
    duration3dMilli: row.duration_3d_milli,
    duration7dMilli: row.duration_7d_milli,
    quoteValiditySeconds: row.quote_validity_seconds,
  });
}

// ───────────── comptages (UNE requête, un seul instantané) ─────────────

interface ScopeCountsRow {
  offers_in_scope: number;
  slots_used: number;
  seller_used: number;
  competing_sellers: number;
  compatible_buyers: number;
  already_boosted: boolean;
}

/**
 * Tous les comptages d'une cotation dans UNE SEULE requête : offres du périmètre et boosts effectifs (mêmes fragments SQL que
 * readBoostSlots et grantOfferBoost), boosts effectifs du vendeur, vendeurs concurrents distincts, acheteurs compatibles distincts
 * (évaluations que stored-matches servirait côté demande : dernières, non périmées, confirmées, prédicat de fraîcheur partagé),
 * et boost effectif ou futur déjà présent sur l'offre.
 */
async function readQuoteCounts(executor: SqlExecutor, offerId: string, sellerId: string, scope: BoostScope): Promise<ScopeCountsRow> {
  const freshness = buildMatchingFreshnessPredicate(resolveMatchingFreshnessParams(), 6);
  const result = await executor.query<ScopeCountsRow>(
    `WITH current_clock AS (SELECT clock_timestamp() AS fresh_now)
     SELECT
       (SELECT count(*)::int FROM offers o JOIN users u ON u.id = o.owner_id
         WHERE lower(btrim(o.category)) = $2 AND lower(btrim(o.brand)) = $3 AND lower(btrim(o.model)) = $4
           AND ${BOOST_ELIGIBLE_OFFER_SQL}) AS offers_in_scope,
       (SELECT count(*)::int FROM offer_boosts b
         WHERE b.scope_category = $2 AND b.scope_brand = $3 AND b.scope_model = $4
           AND ${boostEffectiveSql("b.")}) AS slots_used,
       (SELECT count(*)::int FROM offer_boosts b
         WHERE b.scope_category = $2 AND b.scope_brand = $3 AND b.scope_model = $4
           AND ${boostEffectiveSql("b.")} AND b.seller_id = $5::uuid) AS seller_used,
       (SELECT count(DISTINCT o.owner_id)::int FROM offers o JOIN users u ON u.id = o.owner_id
         WHERE lower(btrim(o.category)) = $2 AND lower(btrim(o.brand)) = $3 AND lower(btrim(o.model)) = $4
           AND ${BOOST_ELIGIBLE_OFFER_SQL} AND o.owner_id <> $5::uuid) AS competing_sellers,
       (SELECT count(DISTINCT e.demand_owner_id)::int FROM ${MATCHING_FRESHNESS_FROM}
         WHERE e.offer_id = $1::uuid AND e.is_confirmed_match = TRUE
           AND ${freshness.conditions.join("\n           AND ")}) AS compatible_buyers,
       EXISTS (SELECT 1 FROM offer_boosts b WHERE b.offer_id = $1::uuid AND b.status = 'active' AND b.ends_at > clock_timestamp()) AS already_boosted`,
    [offerId, scope.category, scope.brand, scope.model, sellerId, ...freshness.values],
  );
  return result.rows[0];
}

// ───────────── lignes ─────────────

interface QuoteRow {
  id: string;
  offer_id: string;
  duration_code: BoostDurationCode;
  currency: "XOF";
  status: "available" | "unavailable";
  unavailable_reason: BoostQuoteUnavailableReason | null;
  amount: number | null;
  raw_amount: string | null;
  competition_milli: number | null;
  demand_milli: number | null;
  scarcity_milli: number | null;
  duration_milli: number | null;
  competing_sellers: number;
  compatible_buyers: number;
  slots_total: number;
  slots_used: number;
  pricing_key: string;
  pricing_version: number;
  computed_at: Date;
  expires_at: Date;
  expired?: boolean;
}

const QUOTE_COLUMNS = `id, offer_id, duration_code, currency, status, unavailable_reason, amount, raw_amount::text AS raw_amount,
  competition_milli, demand_milli, scarcity_milli, duration_milli, competing_sellers, compatible_buyers, slots_total, slots_used,
  pricing_key, pricing_version, computed_at, expires_at`;

function mapQuote(row: QuoteRow): Omit<BoostQuote, "reused"> {
  return {
    id: row.id,
    offerId: row.offer_id,
    durationCode: row.duration_code,
    currency: row.currency,
    status: row.status,
    amount: row.amount,
    rawAmount: row.raw_amount,
    unavailableReason: row.unavailable_reason,
    factors: row.competition_milli === null ? null : {
      competitionMilli: row.competition_milli!, demandMilli: row.demand_milli!, scarcityMilli: row.scarcity_milli!, durationMilli: row.duration_milli!,
    },
    inputs: { competingSellers: row.competing_sellers, compatibleBuyers: row.compatible_buyers, slotsTotal: row.slots_total, slotsUsed: row.slots_used },
    pricing: { key: row.pricing_key, version: row.pricing_version },
    computedAt: row.computed_at,
    expiresAt: row.expires_at,
  };
}

// ───────────── cotation ─────────────

/**
 * Cotation du boost d'une offre pour une durée. Transaction READ COMMITTED : après BEGIN, `lock_timeout` puis verrou consultatif
 * par offre (jamais un instantané pris avant le verrou : il masquerait une cotation concurrente et créerait un doublon). Si une
 * cotation de cette offre, de même durée, même vendeur et même périmètre est encore valable, elle est renvoyée telle quelle
 * (`reused: true`, aucune écriture), même si les comptages ou la version tarifaire ont changé. Sinon : comptages (une requête),
 * prix (pricing.ts) ou indisponibilité (ordre : offre déjà boostée, plus de place, plafond vendeur, aucun acheteur compatible),
 * puis INSERT. Aucune place n'est réservée.
 */
export async function quoteOfferBoost(input: {
  pool: Pool;
  ownerId: string;
  offerId: string;
  durationCode: BoostDurationCode;
  hooks?: BoostQuoteTestHooks;
}): Promise<BoostQuote> {
  const pool = requireQuotePool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const durationCode = requireQuoteDuration(input.durationCode);

  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${BOOST_LOCK_TIMEOUT_MS}ms'`);
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [BOOST_QUOTE_LOCK_NAMESPACE, offerId]);

    // Mêmes contrôles de l'offre que l'attribution ; la ligne reste verrouillée en lecture partagée jusqu'à la fin.
    const facts = await loadOfferFacts(client, offerId, true);
    if (!facts) throw new BoostError("offer_not_found");
    if (facts.owner_id !== ownerId) throw new BoostError("offer_not_owned");
    if (!facts.eligible) throw new BoostError("offer_not_eligible");
    const scope = completeScope(facts);

    // Réutilisation d'une cotation encore valable (même offre, durée, vendeur et périmètre).
    const existing = await client.query<QuoteRow>(
      `SELECT ${QUOTE_COLUMNS} FROM boost_quotes
        WHERE offer_id = $1::uuid AND duration_code = $2 AND seller_id = $3::uuid
          AND scope_category = $4 AND scope_brand = $5 AND scope_model = $6
          AND expires_at > clock_timestamp()
        ORDER BY computed_at DESC, id DESC
        LIMIT 1`,
      [offerId, durationCode, ownerId, scope.category, scope.brand, scope.model],
    );
    if (existing.rows[0]) return { ...mapQuote(existing.rows[0]), reused: true };

    const pricing = await readBoostPricingSettings(client, scope.category);
    const settings = await readBoostSettings(client, scope.category);
    const counts = await readQuoteCounts(client, offerId, ownerId, scope);
    const slotsTotal = computeSlots(counts.offers_in_scope, settings);
    const slotsUsed = counts.slots_used;

    // Indisponibilité, par ordre de priorité.
    let reason: BoostQuoteUnavailableReason | null = null;
    if (counts.already_boosted) reason = "offer_already_boosted";
    else if (slotsTotal === 0 || slotsUsed >= slotsTotal) reason = "no_slot_available";
    else if (counts.seller_used >= computeSellerLimit(slotsTotal, settings)) reason = "seller_boost_limit_reached";
    else if (counts.compatible_buyers === 0) reason = "no_compatible_buyer";

    const price = reason === null
      ? computeBoostPrice({
        competingSellers: counts.competing_sellers, compatibleBuyers: counts.compatible_buyers, slotsUsed, slotsTotal, durationCode, settings: pricing,
      })
      : null;

    if (input.hooks?.beforeInsert) await input.hooks.beforeInsert();

    const validitySeconds = price ? pricing.quoteValiditySeconds : BOOST_UNAVAILABLE_QUOTE_SECONDS;
    const inserted = await client.query<QuoteRow>(
      `WITH t AS (SELECT clock_timestamp() AS now)
       INSERT INTO boost_quotes (
         id, offer_id, seller_id, scope_category, scope_brand, scope_model, duration_code, pricing_key, pricing_version, currency,
         status, unavailable_reason, amount, raw_amount, competition_milli, demand_milli, scarcity_milli, duration_milli,
         competing_sellers, compatible_buyers, slots_total, slots_used, computed_at, expires_at)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::int, 'XOF',
              $10, $11, $12::int, $13::numeric, $14::int, $15::int, $16::int, $17::int,
              $18::int, $19::int, $20::int, $21::int, t.now, t.now + make_interval(secs => $22::int)
         FROM t
       RETURNING ${QUOTE_COLUMNS}`,
      [
        randomUUID(), offerId, ownerId, scope.category, scope.brand, scope.model, durationCode, pricing.key, pricing.version,
        price ? "available" : "unavailable", reason, price?.amount ?? null, price?.rawAmount ?? null,
        price?.factors.competitionMilli ?? null, price?.factors.demandMilli ?? null, price?.factors.scarcityMilli ?? null, price?.factors.durationMilli ?? null,
        counts.competing_sellers, counts.compatible_buyers, slotsTotal, slotsUsed, validitySeconds,
      ],
    );
    return { ...mapQuote(inserted.rows[0]), reused: false };
  }, pool);
}

// ───────────── lectures ─────────────

/** Historique des cotations du vendeur pour SON offre : plus récentes d'abord (computed_at, id), `expired` calculé à la lecture. */
export async function listOfferBoostQuotes(input: {
  pool: Pool;
  ownerId: string;
  offerId: string;
  limit: number;
}): Promise<BoostQuoteHistoryItem[]> {
  const pool = requireQuotePool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const limit = requireLimit(input.limit, 50);
  return withReadOnlySnapshot(pool, async (client) => {
    const offer = await client.query<{ owner_id: string }>("SELECT owner_id FROM offers WHERE id = $1::uuid", [offerId]);
    if (!offer.rows[0]) throw new BoostError("offer_not_found");
    if (offer.rows[0].owner_id !== ownerId) throw new BoostError("offer_not_owned");
    const rows = await client.query<QuoteRow>(
      `SELECT ${QUOTE_COLUMNS}, (expires_at <= clock_timestamp()) AS expired
         FROM boost_quotes WHERE offer_id = $1::uuid
        ORDER BY computed_at DESC, id DESC LIMIT $2::int`,
      [offerId, limit],
    );
    return rows.rows.map((row) => ({ ...mapQuote(row), expired: row.expired === true }));
  });
}

/**
 * Historique des prix d'un périmètre (clé produit normalisée en SQL) : cotations DISPONIBLES seulement, plus récentes d'abord.
 * Aucun identifiant d'offre ni de vendeur n'est renvoyé.
 */
export async function readScopeBoostPriceHistory(input: {
  pool: Pool;
  category: string;
  brand: string;
  model: string;
  limit: number;
}): Promise<BoostScopePricePoint[]> {
  const pool = requireQuotePool(input.pool);
  const category = requireText(input.category, "category");
  const brand = requireText(input.brand, "brand");
  const model = requireText(input.model, "model");
  const limit = requireLimit(input.limit, 200);
  const rows = await pool.query<{
    computed_at: Date; duration_code: BoostDurationCode; currency: "XOF"; amount: number;
    competition_milli: number; demand_milli: number; scarcity_milli: number; duration_milli: number; pricing_key: string; pricing_version: number;
  }>(
    `SELECT computed_at, duration_code, currency, amount, competition_milli, demand_milli, scarcity_milli, duration_milli, pricing_key, pricing_version
       FROM boost_quotes
      WHERE scope_category = lower(btrim($1::text)) AND scope_brand = lower(btrim($2::text)) AND scope_model = lower(btrim($3::text))
        AND status = 'available'
      ORDER BY computed_at DESC, id DESC
      LIMIT $4::int`,
    [category, brand, model, limit],
  );
  return rows.rows.map((row) => ({
    computedAt: row.computed_at,
    durationCode: row.duration_code,
    currency: row.currency,
    amount: row.amount,
    factors: { competitionMilli: row.competition_milli, demandMilli: row.demand_milli, scarcityMilli: row.scarcity_milli, durationMilli: row.duration_milli },
    pricing: { key: row.pricing_key, version: row.pricing_version },
  }));
}
