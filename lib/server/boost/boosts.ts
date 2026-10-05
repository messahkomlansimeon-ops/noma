import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { CatalogValidationError } from "../catalog/errors";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction, type SqlExecutor } from "../postgres/client";
import {
  BOOST_DEFAULT_SETTINGS_KEY, BOOST_DURATION_CODES, BOOST_DURATION_SECONDS, BOOST_LOCK_TIMEOUT_MS,
  BOOST_SCOPE_LOCK_NAMESPACE, BOOST_SOURCES, type BoostDurationCode, type BoostSource,
} from "./boost-config";

/**
 * Boosts d'offres (lot 2I1) : réglages en base, places par périmètre, plafond par vendeur, attribution et annulation.
 * AUCUN paiement : l'attribution est une opération d'administration. Un boost est EFFECTIF si
 * `status = 'active' AND starts_at <= now < ends_at` (now = clock_timestamp() de la base). Voir BOOST.md.
 */

// ───────────── erreurs de domaine ─────────────

export type BoostErrorCode =
  | "offer_not_found"
  | "offer_not_owned"
  | "offer_not_eligible"
  | "offer_not_boostable"
  | "offer_already_boosted"
  | "no_slot_available"
  | "seller_boost_limit_reached"
  | "boost_not_found"
  | "boost_not_owned"
  | "boost_settings_missing"
  | "boost_pricing_missing";

/** Textes fixes : jamais de donnée de la base (ni identifiant, ni texte métier). */
export const BOOST_ERROR_MESSAGES: Readonly<Record<BoostErrorCode, string>> = Object.freeze({
  offer_not_found: "Offre introuvable.",
  offer_not_owned: "Cette offre n'appartient pas à ce vendeur.",
  offer_not_eligible: "Offre non éligible (publiée, non archivée, disponible, propriétaire actif requis).",
  offer_not_boostable: "Offre sans catégorie, marque ou modèle : elle n'est pas boostable.",
  offer_already_boosted: "Cette offre a déjà un boost actif.",
  no_slot_available: "Aucune place de boost disponible dans ce périmètre.",
  seller_boost_limit_reached: "Le plafond de boosts de ce vendeur dans ce périmètre est atteint.",
  boost_not_found: "Boost introuvable.",
  boost_not_owned: "Ce boost n'appartient pas à ce vendeur.",
  boost_settings_missing: "Réglages de boost absents (ligne « default »).",
  boost_pricing_missing: "Réglages tarifaires du boost absents (ni ligne de la catégorie, ni ligne « default »).",
});

export class BoostError extends Error {
  readonly code: BoostErrorCode;

  constructor(code: BoostErrorCode) {
    super(BOOST_ERROR_MESSAGES[code]);
    this.name = "BoostError";
    this.code = code;
  }
}

// ───────────── types ─────────────

export interface BoostSettings {
  /** Clé de la ligne lue : `default` ou la catégorie en minuscules. */
  key: string;
  slotRatio: number;
  minSlots: number;
  maxSlots: number;
  maxActivePerSeller: number;
  maxSellerSlotShare: number;
  maxPromotedShare: number;
  minRelevance: number;
}

export interface BoostScope {
  /** Clé produit normalisée : lower(btrim(...)), comme le marché de 2H1. */
  category: string;
  brand: string;
  model: string;
}

export interface BoostSlots {
  scope: BoostScope;
  total: number;
  used: number;
  available: number;
}

export type BoostStatus = "active" | "cancelled" | "expired";

export interface OfferBoostRecord {
  id: string;
  offerId: string;
  sellerId: string;
  scope: BoostScope;
  status: BoostStatus;
  durationCode: BoostDurationCode;
  startsAt: Date;
  endsAt: Date;
  source: BoostSource;
  createdAt: Date;
  cancelledAt: Date | null;
}

export interface BoostTestHooks {
  /** Réservé aux tests : appelé dans la transaction d'attribution, après les contrôles et juste avant l'INSERT. */
  beforeInsert?: () => void | Promise<void>;
}

// ───────────── calculs purs ─────────────

type SlotSettings = Pick<BoostSettings, "slotRatio" | "minSlots" | "maxSlots">;
type SellerLimitSettings = Pick<BoostSettings, "maxSellerSlotShare" | "maxActivePerSeller">;

/** Arithmétique entière en millièmes (les parts ont au plus trois décimales) : aucun arrondi flottant ne décale un seuil. */
const toMilli = (share: number): number => Math.round(share * 1000);

/** clamp(ceil(slot_ratio × n), min_slots, max_slots). */
export function computeSlots(activeOffersInScope: number, settings: SlotSettings): number {
  if (!Number.isSafeInteger(activeOffersInScope) || activeOffersInScope < 0) {
    throw new CatalogValidationError("activeOffersInScope doit être un entier positif ou nul.");
  }
  const product = toMilli(settings.slotRatio) * activeOffersInScope;
  const ratioSlots = Math.floor((product + 999) / 1000);
  return Math.min(settings.maxSlots, Math.max(settings.minSlots, ratioSlots));
}

/** Plafond d'un vendeur dans un périmètre : max(1, floor(max_seller_slot_share × places)), borné par max_active_per_seller. */
export function computeSellerLimit(totalSlots: number, settings: SellerLimitSettings): number {
  if (!Number.isSafeInteger(totalSlots) || totalSlots < 0) {
    throw new CatalogValidationError("totalSlots doit être un entier positif ou nul.");
  }
  const product = toMilli(settings.maxSellerSlotShare) * totalSlots;
  const share = (product - (product % 1000)) / 1000;
  return Math.min(Math.max(1, share), settings.maxActivePerSeller);
}

// ───────────── validations (avant tout SQL) ─────────────

function requireBoostPool(pool: unknown): Pool {
  if (pool === undefined || pool === null) throw new CatalogValidationError("Un pool PostgreSQL est requis.");
  return requireTransactionPool(pool);
}

function requireDuration(value: unknown): BoostDurationCode {
  if (typeof value !== "string" || !(BOOST_DURATION_CODES as readonly string[]).includes(value)) {
    throw new CatalogValidationError(`durationCode doit valoir ${BOOST_DURATION_CODES.join(", ")}.`);
  }
  return value as BoostDurationCode;
}

function requireSource(value: unknown): BoostSource {
  if (typeof value !== "string" || !(BOOST_SOURCES as readonly string[]).includes(value)) {
    throw new CatalogValidationError(`source doit valoir ${BOOST_SOURCES.join(", ")}.`);
  }
  return value as BoostSource;
}

// ───────────── lectures ─────────────

interface SettingsRow {
  key: string;
  slot_ratio: string;
  min_slots: number;
  max_slots: number;
  max_active_per_seller: number;
  max_seller_slot_share: string;
  max_promoted_share: string;
  min_relevance: string;
}

/** Réglages de la catégorie (clé en minuscules), sinon la ligne `default`. */
export async function readBoostSettings(executor: SqlExecutor, category: string | null): Promise<BoostSettings> {
  const result = await executor.query<SettingsRow>(
    `SELECT key, slot_ratio::text AS slot_ratio, min_slots, max_slots, max_active_per_seller,
            max_seller_slot_share::text AS max_seller_slot_share, max_promoted_share::text AS max_promoted_share,
            min_relevance::text AS min_relevance
       FROM boost_settings
      WHERE key = lower(btrim($1::text)) OR key = $2
      ORDER BY (key = $2) ASC
      LIMIT 1`,
    [category, BOOST_DEFAULT_SETTINGS_KEY],
  );
  const row = result.rows[0];
  if (!row) throw new BoostError("boost_settings_missing");
  return {
    key: row.key,
    slotRatio: Number(row.slot_ratio),
    minSlots: row.min_slots,
    maxSlots: row.max_slots,
    maxActivePerSeller: row.max_active_per_seller,
    maxSellerSlotShare: Number(row.max_seller_slot_share),
    maxPromotedShare: Number(row.max_promoted_share),
    minRelevance: Number(row.min_relevance),
  };
}

/**
 * Fragments SQL PARTAGÉS (lots 2I1 et 2I2) : une seule définition de l'éligibilité d'une offre et d'un boost effectif, pour que
 * l'attribution, les places et les cotations ne divergent jamais. `o` = offers, `u` = users du propriétaire.
 */
export const BOOST_ELIGIBLE_OFFER_SQL = `o.status = 'published' AND o.archived_at IS NULL
        AND o.availability_status IS DISTINCT FROM 'unavailable'
        AND u.status = 'active' AND u.archived_at IS NULL`;

/** Boost effectif (status active, starts_at <= now < ends_at) ; `prefix` = alias de offer_boosts avec son point, ou vide. */
export function boostEffectiveSql(prefix: string): string {
  return `${prefix}status = 'active' AND ${prefix}starts_at <= clock_timestamp() AND clock_timestamp() < ${prefix}ends_at`;
}

export interface OfferBoostFacts {
  owner_id: string;
  published: boolean;
  eligible: boolean;
  scope_category: string | null;
  scope_brand: string | null;
  scope_model: string | null;
}

/** Offre + éligibilité (mêmes règles que la recherche de candidats : publiée, non archivée, non indisponible, propriétaire actif) + clé produit normalisée par PostgreSQL. */
export async function loadOfferFacts(client: SqlExecutor, offerId: string, lockRow: boolean): Promise<OfferBoostFacts | null> {
  const result = await client.query<OfferBoostFacts>(
    `SELECT o.owner_id,
            (o.status = 'published') AS published,
            (${BOOST_ELIGIBLE_OFFER_SQL}) AS eligible,
            NULLIF(lower(btrim(o.category)), '') AS scope_category,
            NULLIF(lower(btrim(o.brand)), '') AS scope_brand,
            NULLIF(lower(btrim(o.model)), '') AS scope_model
       FROM offers o JOIN users u ON u.id = o.owner_id
      WHERE o.id = $1::uuid
      ${lockRow ? "FOR SHARE OF o" : ""}`,
    [offerId],
  );
  return result.rows[0] ?? null;
}

export function completeScope(facts: OfferBoostFacts): BoostScope {
  if (!facts.scope_category || !facts.scope_brand || !facts.scope_model) throw new BoostError("offer_not_boostable");
  return { category: facts.scope_category, brand: facts.scope_brand, model: facts.scope_model };
}

/** Offres du périmètre qui comptent pour le nombre de places : publiées, non archivées, non indisponibles, propriétaire actif. */
async function countOffersInScope(client: SqlExecutor, scope: BoostScope): Promise<number> {
  const result = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM offers o JOIN users u ON u.id = o.owner_id
      WHERE lower(btrim(o.category)) = $1 AND lower(btrim(o.brand)) = $2 AND lower(btrim(o.model)) = $3
        AND ${BOOST_ELIGIBLE_OFFER_SQL}`,
    [scope.category, scope.brand, scope.model],
  );
  return result.rows[0].n;
}

/** Boosts EFFECTIFS du périmètre (status active, starts_at <= now < ends_at), éventuellement ceux d'un seul vendeur. */
async function countEffectiveBoosts(client: SqlExecutor, scope: BoostScope, sellerId: string | null): Promise<number> {
  const result = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM offer_boosts
      WHERE scope_category = $1 AND scope_brand = $2 AND scope_model = $3
        AND ${boostEffectiveSql("")}
        AND ($4::uuid IS NULL OR seller_id = $4::uuid)`,
    [scope.category, scope.brand, scope.model, sellerId],
  );
  return result.rows[0].n;
}

async function readSlots(client: SqlExecutor, scope: BoostScope, settings: BoostSettings): Promise<BoostSlots> {
  const total = computeSlots(await countOffersInScope(client, scope), settings);
  const used = await countEffectiveBoosts(client, scope, null);
  return { scope, total, used, available: Math.max(0, total - used) };
}

export async function withReadOnlySnapshot<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* conserver l'erreur utile */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Places du périmètre de l'offre : total, utilisées (boosts effectifs), disponibles. Lecture seule. */
export async function readBoostSlots(input: { pool: Pool; offerId: string }): Promise<BoostSlots> {
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const pool = requireBoostPool(input.pool);
  return withReadOnlySnapshot(pool, async (client) => {
    const facts = await loadOfferFacts(client, offerId, false);
    if (!facts) throw new BoostError("offer_not_found");
    const scope = completeScope(facts);
    return readSlots(client, scope, await readBoostSettings(client, scope.category));
  });
}

interface BoostRow {
  id: string;
  offer_id: string;
  seller_id: string;
  scope_category: string;
  scope_brand: string;
  scope_model: string;
  status: BoostStatus;
  duration_code: BoostDurationCode;
  starts_at: Date;
  ends_at: Date;
  source: BoostSource;
  created_at: Date;
  cancelled_at: Date | null;
}

const BOOST_COLUMNS = `id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code,
  starts_at, ends_at, source, created_at, cancelled_at`;

function mapBoost(row: BoostRow): OfferBoostRecord {
  return {
    id: row.id,
    offerId: row.offer_id,
    sellerId: row.seller_id,
    scope: { category: row.scope_category, brand: row.scope_brand, model: row.scope_model },
    status: row.status,
    durationCode: row.duration_code,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    source: row.source,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
  };
}

// ───────────── attribution ─────────────

/**
 * Attribue un boost à une offre (opération d'administration, sans paiement), en UNE transaction :
 * a) l'offre appartient à `ownerId`, est éligible et a une clé produit complète ; b) verrou consultatif sur le
 * périmètre ; c) les boosts actifs de CETTE offre dont ends_at est passé deviennent `expired` ; d) un boost effectif ou
 * futur existe déjà → `offer_already_boosted` ; e) plus de place → `no_slot_available` ; f) plafond du vendeur atteint
 * → `seller_boost_limit_reached` ; g) INSERT (starts_at = maintenant, ends_at = maintenant + durée, calculés par la base).
 * Toute erreur de domaine est une `BoostError` au code stable.
 */
export async function grantOfferBoost(input: {
  pool: Pool;
  offerId: string;
  ownerId: string;
  durationCode: BoostDurationCode;
  source: BoostSource;
  hooks?: BoostTestHooks;
}): Promise<{ boost: OfferBoostRecord; slots: BoostSlots }> {
  const pool = requireBoostPool(input.pool);
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const durationCode = requireDuration(input.durationCode);
  const source = requireSource(input.source);

  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${BOOST_LOCK_TIMEOUT_MS}ms'`);

    // a) L'offre reste verrouillée en lecture partagée jusqu'à la fin : sa clé produit ne change pas sous nos pieds.
    const facts = await loadOfferFacts(client, offerId, true);
    if (!facts) throw new BoostError("offer_not_found");
    if (facts.owner_id !== ownerId) throw new BoostError("offer_not_owned");
    if (!facts.eligible) throw new BoostError("offer_not_eligible");
    const scope = completeScope(facts);

    // b) Sérialise les attributions d'un même périmètre (places et plafond vendeur sont des invariants de périmètre).
    await client.query(
      "SELECT pg_advisory_xact_lock($1::int, hashtext($2::text || chr(31) || $3::text || chr(31) || $4::text))",
      [BOOST_SCOPE_LOCK_NAMESPACE, scope.category, scope.brand, scope.model],
    );

    // c) Boosts de cette offre arrivés à échéance.
    await client.query(
      "UPDATE offer_boosts SET status = 'expired' WHERE offer_id = $1::uuid AND status = 'active' AND ends_at <= clock_timestamp()",
      [offerId],
    );

    // d) Il reste alors un boost effectif (ou futur).
    const existing = await client.query("SELECT 1 FROM offer_boosts WHERE offer_id = $1::uuid AND status = 'active' LIMIT 1", [offerId]);
    if (existing.rowCount) throw new BoostError("offer_already_boosted");

    // e) f)
    const settings = await readBoostSettings(client, scope.category);
    const total = computeSlots(await countOffersInScope(client, scope), settings);
    if ((await countEffectiveBoosts(client, scope, null)) >= total) throw new BoostError("no_slot_available");
    if ((await countEffectiveBoosts(client, scope, ownerId)) >= computeSellerLimit(total, settings)) {
      throw new BoostError("seller_boost_limit_reached");
    }

    if (input.hooks?.beforeInsert) await input.hooks.beforeInsert();

    // g) Un seul instantané pour starts_at et ends_at.
    const inserted = await client.query<BoostRow>(
      `WITH t AS (SELECT clock_timestamp() AS now)
       INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code,
                                 starts_at, ends_at, source)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'active', $7, t.now, t.now + make_interval(secs => $8::int), $9
         FROM t
       RETURNING ${BOOST_COLUMNS}`,
      [randomUUID(), offerId, ownerId, scope.category, scope.brand, scope.model, durationCode,
        BOOST_DURATION_SECONDS[durationCode], source],
    );
    return { boost: mapBoost(inserted.rows[0]), slots: await readSlots(client, scope, settings) };
  }, pool);
}

// ───────────── annulation ─────────────

/**
 * Annule un boost du vendeur. Conditionnel (seul un boost `active` non échu passe à `cancelled`, avec `cancelled_at`) et
 * idempotent : annuler un boost déjà annulé ou expiré renvoie son état courant, sans rien modifier. Un boost `active`
 * dont ends_at est passé est d'abord marqué `expired` (il n'est plus annulable).
 */
export async function cancelOfferBoost(input: {
  pool: Pool;
  boostId: string;
  ownerId: string;
}): Promise<{ boost: OfferBoostRecord; cancelled: boolean }> {
  const pool = requireBoostPool(input.pool);
  const boostId = requireUuid(input.boostId, "boostId").toLowerCase();
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();

  return withPostgresTransaction(async (client) => {
    const found = await client.query<BoostRow & { lapsed: boolean }>(
      `SELECT ${BOOST_COLUMNS}, (ends_at <= clock_timestamp()) AS lapsed FROM offer_boosts WHERE id = $1::uuid FOR UPDATE`,
      [boostId],
    );
    const row = found.rows[0];
    if (!row) throw new BoostError("boost_not_found");
    if (row.seller_id !== ownerId) throw new BoostError("boost_not_owned");
    if (row.status !== "active") return { boost: mapBoost(row), cancelled: false };

    const updated = await client.query<BoostRow>(
      row.lapsed
        ? `UPDATE offer_boosts SET status = 'expired' WHERE id = $1::uuid RETURNING ${BOOST_COLUMNS}`
        : `UPDATE offer_boosts SET status = 'cancelled', cancelled_at = clock_timestamp() WHERE id = $1::uuid RETURNING ${BOOST_COLUMNS}`,
      [boostId],
    );
    return { boost: mapBoost(updated.rows[0]), cancelled: !row.lapsed };
  }, pool);
}

// ───────────── lecture pour le classement ─────────────

/**
 * Parmi `offerIds`, les offres dont le boost est EFFECTIF à l'instant `at` (l'horloge figée du curseur de pertinence) :
 * boost actif, `starts_at <= at < ends_at`, vendeur = propriétaire actuel et actif, offre toujours éligible, et clé
 * produit actuelle de l'offre égale au périmètre du boost (une offre modifiée vers un autre produit ne garde pas
 * l'avantage obtenu dans l'ancien périmètre). Le statut est celui de l'instantané de lecture. Lecture seule.
 */
export async function readEffectiveBoostedOfferIds(
  executor: SqlExecutor,
  offerIds: readonly string[],
  at: string,
): Promise<Set<string>> {
  if (offerIds.length === 0) return new Set();
  const result = await executor.query<{ offer_id: string }>(
    `SELECT DISTINCT b.offer_id
       FROM offer_boosts b
       JOIN offers o ON o.id = b.offer_id AND o.owner_id = b.seller_id
       JOIN users u ON u.id = b.seller_id
      WHERE b.offer_id = ANY($1::uuid[])
        AND b.status = 'active' AND b.starts_at <= $2::timestamptz AND $2::timestamptz < b.ends_at
        AND o.status = 'published' AND o.archived_at IS NULL AND o.availability_status IS DISTINCT FROM 'unavailable'
        AND u.status = 'active' AND u.archived_at IS NULL
        AND lower(btrim(o.category)) = b.scope_category
        AND lower(btrim(o.brand)) = b.scope_brand
        AND lower(btrim(o.model)) = b.scope_model`,
    [[...offerIds], at],
  );
  return new Set(result.rows.map((row) => row.offer_id));
}
