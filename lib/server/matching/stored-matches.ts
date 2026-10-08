import "server-only";

import type { Pool } from "pg";
import type { SqlExecutor } from "../postgres/client";
import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import { mapDemand, mapOffer, type DemandRow, type OfferRow } from "../catalog/shared";
import type { DemandRecord, OfferRecord } from "../catalog/types";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { rankEffectiveBoosts, readBoostSettings, readEffectiveBoostDetails } from "../boost/boosts";
import { recordBoostExposures, type BoostExposureBatch, type BoostExposureRow } from "../boost/exposures";
import { placeBoostedItems } from "../boost/placement";
import { validateCandidateLimit } from "./candidates";
import {
  computeAvailabilityIndicator, computeConfidenceIndicator, computePriceIndicator, computeRelevance,
  type AvailabilityIndicator, type ConfidenceIndicator, type MarketReference, type PriceIndicator, type RelevanceSense,
} from "./indicators";
import { readMarketReferences, type MarketQuery } from "./market";
import { RELEVANCE_CONFIG, RELEVANCE_WINDOW } from "./relevance-config";
import {
  MATCHING_CURRENT_CLOCK_CTE,
  MATCHING_FRESHNESS_FROM,
  buildMatchingFreshnessPredicate,
  resolveMatchingFreshnessParams,
} from "./persistence";
import {
  SOURCE_DEMAND_COLUMNS,
  SOURCE_OFFER_COLUMNS,
  loadSourceDemand,
  loadSourceOffer,
  withReadSnapshot,
} from "./service";
import type { MatchingCompatibilityStatus } from "./types";

/**
 * Lecture des correspondances ENREGISTRÉES (matching_evaluations), produites par le worker : aucune évaluation
 * n'est recalculée ici. Une ligne n'est lue que si elle est une correspondance confirmée ET fraîche (prédicat
 * partagé avec getActiveMatchingEvaluation). Voir MATCHING-STORED-READ.md.
 */

export type StoredMatchSourceKind = "offer" | "demand";

export type StoredMatchSort = "score" | "relevance";

export interface StoredMatchesQueryOptions {
  limit?: number;
  cursor?: string;
  /** `score` (défaut : ordre et curseur historiques) ou `relevance` (pertinence organique, voir MATCHING-RELEVANCE.md). */
  sort?: StoredMatchSort;
  /** Réservé aux tests (non exposé par HTTP) : fenêtre de lecture du tri par pertinence, 200 par défaut. */
  relevanceWindow?: number;
  /** Valeurs courantes par défaut, comme getActiveMatchingEvaluation (non exposées par HTTP). */
  expectedEngineOfflineVersion?: string;
  expectedEngineScoringVersion?: string;
  expectedScoringConfigHash?: string;
}

export interface StoredMatchEvaluationSummary {
  matchedCount: number;
  mismatchedCount: number;
  unknownCount: number;
  totalExploitableCriteria: number;
}

export interface StoredMatchScoringSummary {
  totalApplicableWeight: number;
  matchedWeight: number;
  mismatchedWeight: number;
  unknownWeight: number;
  applicableCriteriaCount: number;
  matchedCount: number;
  mismatchedCount: number;
  unknownCount: number;
}

export interface StoredMatchPreferencesSummary {
  preferenceScore: number | null;
  preferenceCoverage: number | null;
  totalPreferencesCount: number;
  matchedCount: number;
  mismatchedCount: number;
  unknownCount: number;
}

/**
 * Indicateurs séparés (brief §5), calculés à la lecture et jamais enregistrés. Sens demande (l'acheteur voit des
 * offres) : les trois concernent l'offre candidate et son vendeur. Sens offre (le vendeur voit des demandes) :
 * `availability` et `price` sont null (ils décriraient SA propre offre, identique pour tous les éléments) ;
 * `confidence` concerne l'acheteur.
 */
export interface StoredMatchIndicators {
  availability: AvailabilityIndicator | null;
  price: PriceIndicator | null;
  confidence: ConfidenceIndicator;
}

export interface StoredMatchItem<TCandidate extends OfferRecord | DemandRecord> {
  candidateId: string;
  candidateContentVersion: number;
  candidate: TCandidate;
  compatibilityStatus: MatchingCompatibilityStatus;
  /** NUMERIC(9,6) converti en nombre : arrondi à 6 décimales. */
  score: number | null;
  coverage: number | null;
  evaluatedAt: Date;
  evaluationSummary: StoredMatchEvaluationSummary;
  scoringSummary: StoredMatchScoringSummary;
  preferencesSummary: StoredMatchPreferencesSummary;
  indicators: StoredMatchIndicators;
  /** Pertinence organique 0..100 (2 décimales) : le boost n'y entre jamais. */
  relevance: number;
  /**
   * Vrai UNIQUEMENT pour un élément promu par un boost (tri `relevance`, sens demande, voir BOOST.md). Faux partout
   * ailleurs : tri par score, sens offre, éléments non promus. N'expose ni identifiant de boost, ni dates, ni vendeur.
   */
  sponsored: boolean;
  /**
   * Lot PRO1 : le vendeur de l'annonce a un abonnement Pro EN VIGUEUR portant le droit `badge_pro` (sens demande seulement ; faux dans le sens offre). Lu côté serveur à chaque
   * lecture ; n'expose ni le plan, ni les dates, ni l'identité du vendeur. Ce n'est pas une garantie de qualité et ne change ni la pertinence ni le classement.
   */
  proBadge: boolean;
}

export interface StoredMatchesPage<
  TSource extends OfferRecord | DemandRecord,
  TCandidate extends OfferRecord | DemandRecord,
> {
  source: { id: string; contentVersion: number; ownerId: string; record: TSource };
  items: StoredMatchItem<TCandidate>[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  /** Tri `relevance` seulement : plus de RELEVANCE_WINDOW correspondances existent, seules les meilleures par score sont triées. */
  truncated: boolean;
  /**
   * true si la VERSION COURANTE de la source est en cours de traitement : événement outbox pending de son agrégat à
   * cette version, ou job evaluate_* du bon type sur (source, version) pending / running / failed. Un NOUVEAU
   * candidat est ajouté plus tard par SON PROPRE job : ce cas n'est pas reflété par `processing`.
   */
  processing: boolean;
  /** clock_timestamp() de la base au début de la lecture (c'est aussi le `now` des indicateurs, sauf pages suivantes du tri par pertinence). */
  readAt: Date;
}

// ───────────── curseur opaque ─────────────

interface StoredMatchCursorPayload {
  v: 1;
  sourceKind: StoredMatchSourceKind;
  sourceId: string;
  /** Texte NUMERIC exact (ex. "0.870000"), ou null (segment NULLS LAST). */
  score: string | null;
  /** ISO UTC à la microseconde, `Z` final. */
  evaluatedAt: string;
  /** Identifiant de l'évaluation (départage final). */
  id: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SCORE_TEXT_PATTERN = /^[0-9]{1,3}\.[0-9]{6}$/;
const ISO_UTC_MICROSECONDS_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const CURSOR_KEYS = ["evaluatedAt", "id", "score", "sourceId", "sourceKind", "v"];
const MAX_CURSOR_LENGTH = 512;

function invalidCursor(detail: string): CatalogValidationError {
  return new CatalogValidationError(`Curseur de pagination invalide (${detail}).`);
}

function encodeStoredMatchCursor(payload: StoredMatchCursorPayload): string {
  return Buffer.from(JSON.stringify({
    v: payload.v,
    sourceKind: payload.sourceKind,
    sourceId: payload.sourceId,
    score: payload.score,
    evaluatedAt: payload.evaluatedAt,
    id: payload.id,
  }), "utf8").toString("base64url");
}

function isCalendarIsoMicroseconds(value: string): boolean {
  const match = ISO_UTC_MICROSECONDS_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

/**
 * Décodage strict, AVANT tout SQL : encodage, JSON, clés exactes, version, types, formats, puis liaison à la source
 * et au sens demandés. Tout écart (curseur forgé, réutilisé sur une autre source ou dans l'autre sens) →
 * CatalogValidationError (HTTP 400).
 */
function decodeStoredMatchCursor(
  cursor: unknown,
  expected: { sourceKind: StoredMatchSourceKind; sourceId: string },
): StoredMatchCursorPayload | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string") throw invalidCursor("chaîne attendue");
  if (!BASE64URL_PATTERN.test(cursor) || cursor.length > MAX_CURSOR_LENGTH) throw invalidCursor("encodage non conforme");

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor("contenu corrompu");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalidCursor("structure");
  const keys = Object.keys(parsed).sort();
  if (keys.length !== CURSOR_KEYS.length || keys.some((key, index) => key !== CURSOR_KEYS[index])) {
    throw invalidCursor("propriétés inattendues");
  }

  const { v, sourceKind, sourceId, score, evaluatedAt, id } = parsed as Record<string, unknown>;
  if (v !== 1) throw invalidCursor("version");
  if (sourceKind !== "offer" && sourceKind !== "demand") throw invalidCursor("sens");
  if (typeof sourceId !== "string" || !UUID_REGEX.test(sourceId)) throw invalidCursor("source");
  if (score !== null && (typeof score !== "string" || !SCORE_TEXT_PATTERN.test(score))) throw invalidCursor("score");
  if (typeof evaluatedAt !== "string" || !isCalendarIsoMicroseconds(evaluatedAt)) throw invalidCursor("date");
  if (typeof id !== "string" || !UUID_REGEX.test(id)) throw invalidCursor("identifiant");
  if (sourceKind !== expected.sourceKind || sourceId.toLowerCase() !== expected.sourceId) {
    throw invalidCursor("curseur d'une autre source");
  }
  return { v: 1, sourceKind, sourceId: sourceId.toLowerCase(), score, evaluatedAt, id: id.toLowerCase() };
}

/**
 * Curseur du tri par pertinence : pagination par DÉCALAGE sur la liste triée, avec l'horloge `at` figée à la première
 * page (les indicateurs des pages suivantes sont recalculés avec now = at). Clés exactes, distinctes de celles du curseur
 * de score : un curseur de l'un est refusé par l'autre.
 */
interface RelevanceCursorPayload {
  v: 1;
  sort: "relevance";
  sourceKind: StoredMatchSourceKind;
  sourceId: string;
  offset: number;
  /** ISO UTC à 6 décimales, `Z` final. */
  at: string;
}

const RELEVANCE_CURSOR_KEYS = ["at", "offset", "sort", "sourceId", "sourceKind", "v"];

const toIsoMicros = (date: Date): string => date.toISOString().replace(/Z$/, "000Z");

function encodeRelevanceCursor(payload: RelevanceCursorPayload): string {
  return Buffer.from(JSON.stringify({
    v: payload.v, sort: payload.sort, sourceKind: payload.sourceKind, sourceId: payload.sourceId, offset: payload.offset, at: payload.at,
  }), "utf8").toString("base64url");
}

function decodeRelevanceCursor(
  cursor: unknown,
  expected: { sourceKind: StoredMatchSourceKind; sourceId: string },
): RelevanceCursorPayload | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string") throw invalidCursor("chaîne attendue");
  if (!BASE64URL_PATTERN.test(cursor) || cursor.length > MAX_CURSOR_LENGTH) throw invalidCursor("encodage non conforme");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor("contenu corrompu");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalidCursor("structure");
  const keys = Object.keys(parsed).sort();
  if (keys.length !== RELEVANCE_CURSOR_KEYS.length || keys.some((key, index) => key !== RELEVANCE_CURSOR_KEYS[index])) {
    throw invalidCursor("propriétés inattendues (curseur d'un autre tri ?)");
  }
  const { v, sort, sourceKind, sourceId, offset, at } = parsed as Record<string, unknown>;
  if (v !== 1) throw invalidCursor("version");
  if (sort !== "relevance") throw invalidCursor("tri");
  if (sourceKind !== "offer" && sourceKind !== "demand") throw invalidCursor("sens");
  if (typeof sourceId !== "string" || !UUID_REGEX.test(sourceId)) throw invalidCursor("source");
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > RELEVANCE_CONFIG.relevance.maxOffset) throw invalidCursor("décalage");
  if (typeof at !== "string" || !isCalendarIsoMicroseconds(at)) throw invalidCursor("date");
  if (sourceKind !== expected.sourceKind || sourceId.toLowerCase() !== expected.sourceId) {
    throw invalidCursor("curseur d'une autre source");
  }
  return { v: 1, sort: "relevance", sourceKind, sourceId: sourceId.toLowerCase(), offset, at };
}

// ───────────── lecture des colonnes JSON enregistrées ─────────────

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`stored_match_corrupt_${field}`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(source: Record<string, unknown>, key: string, field: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`stored_match_corrupt_${field}`);
  return value;
}

function nullableFiniteNumber(source: Record<string, unknown>, key: string, field: string): number | null {
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`stored_match_corrupt_${field}`);
  return value;
}

function readEvaluationSummary(stored: unknown): StoredMatchEvaluationSummary {
  const criteria = asRecord(asRecord(stored, "evaluation_summary").criteriaSummary, "evaluation_summary");
  return {
    matchedCount: finiteNumber(criteria, "matchedCount", "evaluation_summary"),
    mismatchedCount: finiteNumber(criteria, "mismatchedCount", "evaluation_summary"),
    unknownCount: finiteNumber(criteria, "unknownCount", "evaluation_summary"),
    totalExploitableCriteria: finiteNumber(criteria, "totalExploitableCriteria", "evaluation_summary"),
  };
}

function readScoringSummary(stored: unknown): StoredMatchScoringSummary {
  const summary = asRecord(stored, "scoring_summary");
  return {
    totalApplicableWeight: finiteNumber(summary, "totalApplicableWeight", "scoring_summary"),
    matchedWeight: finiteNumber(summary, "matchedWeight", "scoring_summary"),
    mismatchedWeight: finiteNumber(summary, "mismatchedWeight", "scoring_summary"),
    unknownWeight: finiteNumber(summary, "unknownWeight", "scoring_summary"),
    applicableCriteriaCount: finiteNumber(summary, "applicableCriteriaCount", "scoring_summary"),
    matchedCount: finiteNumber(summary, "matchedCount", "scoring_summary"),
    mismatchedCount: finiteNumber(summary, "mismatchedCount", "scoring_summary"),
    unknownCount: finiteNumber(summary, "unknownCount", "scoring_summary"),
  };
}

function readPreferencesSummary(stored: unknown): StoredMatchPreferencesSummary {
  const summary = asRecord(stored, "preferences_summary");
  return {
    preferenceScore: nullableFiniteNumber(summary, "preferenceScore", "preferences_summary"),
    preferenceCoverage: nullableFiniteNumber(summary, "preferenceCoverage", "preferences_summary"),
    totalPreferencesCount: finiteNumber(summary, "totalPreferencesCount", "preferences_summary"),
    matchedCount: finiteNumber(summary, "matchedCount", "preferences_summary"),
    mismatchedCount: finiteNumber(summary, "mismatchedCount", "preferences_summary"),
    unknownCount: finiteNumber(summary, "unknownCount", "preferences_summary"),
  };
}

// ───────────── requêtes ─────────────

interface StoredEvaluationColumns {
  eval_id: string;
  eval_confirmed: boolean;
  eval_score: string | null;
  eval_coverage: string | null;
  eval_compatibility_status: MatchingCompatibilityStatus;
  eval_evaluated_at: Date;
  eval_evaluated_at_iso: string;
  eval_evaluation_summary: unknown;
  eval_scoring_summary: unknown;
  eval_preferences_summary: unknown;
}

const EVALUATION_COLUMNS = `
  e.id AS eval_id, e.is_confirmed_match AS eval_confirmed, e.score::text AS eval_score, e.coverage::text AS eval_coverage,
  e.compatibility_status AS eval_compatibility_status, e.evaluated_at AS eval_evaluated_at,
  to_char(e.evaluated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS eval_evaluated_at_iso,
  e.evaluation_summary AS eval_evaluation_summary, e.scoring_summary AS eval_scoring_summary,
  e.preferences_summary AS eval_preferences_summary
`;

const SORT_ORDER = "e.score DESC NULLS LAST, e.evaluated_at DESC, e.id DESC";

/**
 * Condition keyset de l'ordre (score DESC NULLS LAST, evaluated_at DESC, id DESC).
 * Curseur sur un score non nul : scores inférieurs, PUIS tous les scores NULL (NULLS LAST), puis les égalités
 * départagées par (evaluated_at, id). Curseur sur un score NULL : uniquement le reste du segment NULL.
 */
function keysetCondition(cursor: StoredMatchCursorPayload, values: unknown[]): string {
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const tie = (): string => `(e.evaluated_at, e.id) < (${bind(cursor.evaluatedAt)}::timestamptz, ${bind(cursor.id)}::uuid)`;
  if (cursor.score === null) return `AND (e.score IS NULL AND ${tie()})`;
  const score = bind(cursor.score);
  return `AND (e.score < ${score}::numeric OR e.score IS NULL OR (e.score = ${score}::numeric AND ${tie()}))`;
}

type CandidateRow<TRow> = TRow & StoredEvaluationColumns;

interface RowsInput {
  sourceKind: StoredMatchSourceKind;
  sourceId: string;
  freshness: ReturnType<typeof resolveMatchingFreshnessParams>;
  candidateColumns: string;
  rowLimit: number;
  cursor: StoredMatchCursorPayload | null;
  /** Lot M1 : ne lit que la ligne de CE candidat (la fiche d'une annonce relit une seule correspondance confirmée et fraîche). */
  candidateId?: string;
}

/** Lignes confirmées et fraîches de la source, dans l'ordre du score, `rowLimit` lignes au plus. */
async function fetchRows<TRow extends OfferRow | DemandRow>(client: SqlExecutor, input: RowsInput): Promise<Array<CandidateRow<TRow>>> {
  const sourceColumn = input.sourceKind === "offer" ? "e.offer_id" : "e.demand_id";
  const freshness = buildMatchingFreshnessPredicate(input.freshness, 2);
  const values: unknown[] = [input.sourceId, ...freshness.values];
  const cursorCondition = input.cursor ? keysetCondition(input.cursor, values) : "";
  let candidateCondition = "";
  if (input.candidateId !== undefined) {
    values.push(input.candidateId);
    candidateCondition = `AND ${input.sourceKind === "offer" ? "e.demand_id" : "e.offer_id"} = $${values.length}::uuid`;
  }
  values.push(input.rowLimit);

  const result = await client.query<CandidateRow<TRow>>(
    `WITH ${MATCHING_CURRENT_CLOCK_CTE}
     SELECT ${input.candidateColumns}, ${EVALUATION_COLUMNS}
       FROM ${MATCHING_FRESHNESS_FROM}
      WHERE ${sourceColumn} = $1::uuid
        AND e.is_confirmed_match = TRUE
        AND ${freshness.conditions.join("\n        AND ")}
        ${cursorCondition}
        ${candidateCondition}
      ORDER BY ${SORT_ORDER}
      LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

/** Item enrichi + clés internes de tri (jamais exposées). */
interface RankedItem<TCandidate extends OfferRecord | DemandRecord> {
  item: StoredMatchItem<TCandidate>;
  evaluationId: string;
  evaluatedAtIso: string;
}

interface OwnerFacts {
  createdAt: Date;
  phoneVerified: boolean;
  /** Lot PRO1 : abonnement Pro en vigueur avec le droit `badge_pro` (règle unique `subscription_effective_version`). */
  proBadge: boolean;
}

/**
 * Vérification du téléphone et ancienneté des propriétaires des candidats : une requête pour toute la liste. Avec `known` (portée d'un
 * boost, lot P3 : plusieurs listes d'acheteurs lues de suite dans le MÊME instantané), seuls les propriétaires pas encore lus sont demandés ;
 * le résultat est le même, sans relire ce qui ne dépend pas de la demande.
 */
async function readOwnerFacts(client: SqlExecutor, ownerIds: readonly string[], known?: Map<string, OwnerFacts>): Promise<Map<string, OwnerFacts>> {
  const facts = known ?? new Map<string, OwnerFacts>();
  const missing = [...new Set(ownerIds)].filter((id) => !facts.has(id));
  if (missing.length === 0) return facts;
  const result = await client.query<{ id: string; created_at: Date; phone_verified: boolean; pro_badge: boolean }>(
    `SELECT u.id, u.created_at,
            EXISTS (SELECT 1 FROM phone_identities p WHERE p.user_id = u.id AND p.verified_at IS NOT NULL) AS phone_verified,
            COALESCE((SELECT 'badge_pro' = ANY(v.entitlements) FROM plan_versions v WHERE v.id = subscription_effective_version(u.id)), FALSE) AS pro_badge
       FROM users u WHERE u.id = ANY($1::uuid[])`,
    [missing],
  );
  for (const row of result.rows) facts.set(row.id, { createdAt: row.created_at, phoneVerified: row.phone_verified, proBadge: row.pro_badge === true });
  return facts;
}

/**
 * Éléments qui ne dépendent PAS de la demande (propriétaires, marché observé de chaque offre) et que la portée d'un boost relit pour chaque
 * liste d'acheteur d'une même cotation : mémorisés entre deux lectures du MÊME instantané. Jamais partagé entre deux requêtes de l'utilisateur.
 */
export interface OrganicReadCache {
  owners: Map<string, OwnerFacts>;
  markets: Map<string, MarketReference>;
}

export const createOrganicReadCache = (): OrganicReadCache => ({ owners: new Map(), markets: new Map() });

/**
 * Items + indicateurs + pertinence pour des lignes déjà lues. Faits relus dans le MÊME instantané : marché (une requête,
 * sens demande seulement) et propriétaires (une requête). `now` est l'horloge des indicateurs.
 */
async function buildItems<TCandidate extends OfferRecord | DemandRecord, TRow extends OfferRow | DemandRow>(
  client: SqlExecutor,
  input: {
    sourceKind: StoredMatchSourceKind;
    source: OfferRecord | DemandRecord;
    rows: Array<CandidateRow<TRow>>;
    mapCandidate: (row: TRow) => TCandidate;
    now: Date;
    cache?: OrganicReadCache;
  },
): Promise<Array<RankedItem<TCandidate>>> {
  const candidates = input.rows.map((row) => input.mapCandidate(row));
  const owners = await readOwnerFacts(client, candidates.map((candidate) => candidate.ownerId), input.cache?.owners);
  // Sens demande : l'acheteur voit des OFFRES, dont le prix se situe par rapport au marché observé.
  const senseIsDemandSource = input.sourceKind === "demand";
  let markets = new Map<string, MarketReference>();
  if (senseIsDemandSource) {
    const known = input.cache?.markets;
    const wanted = (candidates as OfferRecord[]).filter((offer) => !known?.has(offer.id)).map((offer): MarketQuery => ({
      offerId: offer.id, category: offer.category, brand: offer.brand, model: offer.model, currency: offer.price?.currency ?? null,
    }));
    const fetched = wanted.length > 0 ? await readMarketReferences(client, wanted) : new Map<string, MarketReference>();
    if (known) {
      for (const [offerId, reference] of fetched) known.set(offerId, reference);
      markets = known;
    } else {
      markets = fetched;
    }
  }
  const sense: RelevanceSense = senseIsDemandSource ? "demand_source" : "offer_source";

  return input.rows.map((row, index): RankedItem<TCandidate> => {
    const candidate = candidates[index];
    const owner = owners.get(candidate.ownerId) ?? { createdAt: input.now, phoneVerified: false, proBadge: false };
    let indicators: StoredMatchIndicators;
    if (senseIsDemandSource) {
      const offer = candidate as OfferRecord;
      indicators = {
        availability: computeAvailabilityIndicator({
          status: offer.availabilityStatus ?? null,
          confirmedAt: offer.availabilityConfirmedAt ?? null,
          quantity: offer.quantity ?? null,
          requestedQuantity: (input.source as DemandRecord).quantity ?? null,
          now: input.now,
        }),
        price: computePriceIndicator({ price: offer.price?.amount ?? null, market: markets.get(offer.id) ?? null }),
        confidence: computeConfidenceIndicator({
          kind: "offer", phoneVerified: owner.phoneVerified, accountCreatedAt: owner.createdAt, now: input.now,
          availabilityEverConfirmed: offer.availabilityConfirmedAt != null,
          fields: {
            category: offer.category, brand: offer.brand, model: offer.model, condition: offer.condition,
            price: offer.price?.amount ?? null, location: offer.location,
          },
        }),
      };
    } else {
      const demand = candidate as DemandRecord;
      indicators = {
        availability: null,
        price: null,
        confidence: computeConfidenceIndicator({
          kind: "demand", phoneVerified: owner.phoneVerified, accountCreatedAt: owner.createdAt, now: input.now,
          availabilityEverConfirmed: false,
          fields: { category: demand.category, brand: demand.brand, model: demand.model, condition: demand.condition, location: demand.location },
        }),
      };
    }
    const score = row.eval_score === null ? null : Number(row.eval_score);
    const relevance = computeRelevance({
      confirmed: row.eval_confirmed === true,
      sense,
      compatibility: score,
      availability: indicators.availability?.score ?? null,
      price: indicators.price?.score ?? null,
      priceFactor: indicators.price?.factors[0] ?? null,
      confidence: indicators.confidence.score,
    });
    return {
      evaluationId: row.eval_id,
      evaluatedAtIso: row.eval_evaluated_at_iso,
      item: {
        candidateId: candidate.id,
        candidateContentVersion: candidate.contentVersion,
        candidate,
        compatibilityStatus: row.eval_compatibility_status,
        score,
        coverage: row.eval_coverage === null ? null : Number(row.eval_coverage),
        evaluatedAt: row.eval_evaluated_at,
        evaluationSummary: readEvaluationSummary(row.eval_evaluation_summary),
        scoringSummary: readScoringSummary(row.eval_scoring_summary),
        preferencesSummary: readPreferencesSummary(row.eval_preferences_summary),
        indicators,
        relevance: relevance ?? 0,
        sponsored: false,
        // Le badge n'existe que sur une ANNONCE (sens demande) : le sens offre sert des besoins d'acheteurs.
        proBadge: senseIsDemandSource && owner.proBadge,
      },
    };
  });
}

/** Ordre du tri par pertinence : relevance DESC, score DESC NULLS LAST, evaluated_at DESC, id d'évaluation DESC. */
function compareByRelevance<T extends OfferRecord | DemandRecord>(a: RankedItem<T>, b: RankedItem<T>): number {
  if (a.item.relevance !== b.item.relevance) return b.item.relevance - a.item.relevance;
  if ((a.item.score === null) !== (b.item.score === null)) return a.item.score === null ? 1 : -1;
  if (a.item.score !== null && b.item.score !== null && a.item.score !== b.item.score) return b.item.score - a.item.score;
  if (a.evaluatedAtIso !== b.evaluatedAtIso) return a.evaluatedAtIso < b.evaluatedAtIso ? 1 : -1;
  return a.evaluationId < b.evaluationId ? 1 : a.evaluationId > b.evaluationId ? -1 : 0;
}

interface BoostedOrder<TCandidate extends OfferRecord | DemandRecord> {
  items: Array<StoredMatchItem<TCandidate>>;
  /** Une entrée par élément de la fenêtre dont l'offre a un boost effectif à `at`, sponsorisé ou non (position dans l'ordre FINAL complet). */
  exposures: BoostExposureRow[];
}

/**
 * Boost (brief §15 : compatibles, puis pertinence, puis boost À L'INTÉRIEUR du classement). `organic` est la fenêtre
 * entière déjà triée par pertinence. Sont promouvables les éléments dont l'offre a un boost EFFECTIF à `at` et dont la
 * pertinence atteint le seuil des réglages de la catégorie de la demande ; au plus floor(part promue × N) sont promus,
 * à des positions k × ceil(1 / part), le boost le plus ANCIEN d'abord (priorité d'ancienneté, lot P3), et un promu ne peut que MONTER
 * (« sponsorisé » = a gagné des places). Aucune ligne
 * n'est ajoutée ni retirée : seules des lignes confirmées et fraîches (déjà dans `organic`) peuvent apparaître.
 * Voir BOOST.md.
 */
async function computeBoostedOrder<TCandidate extends OfferRecord | DemandRecord>(
  client: SqlExecutor,
  input: { organic: Array<RankedItem<TCandidate>>; demand: DemandRecord; at: Date },
): Promise<BoostedOrder<TCandidate>> {
  // Une SEULE lecture des boosts effectifs sert l'ordre servi ET le journal d'exposition : ils ne peuvent pas diverger.
  const boosts = await readEffectiveBoostDetails(client, input.organic.map((entry) => entry.item.candidateId), toIsoMicros(input.at));
  if (boosts.size === 0) return { items: input.organic.map((entry) => entry.item), exposures: [] };
  const settings = await readBoostSettings(client, input.demand.category);
  // Priorité d'ANCIENNETÉ (lot P3) : à quota insuffisant, la promotion va aux boosts les plus anciens, jamais selon l'ordre organique.
  const ranks = rankEffectiveBoosts(boosts);
  const placed = placeBoostedItems(
    input.organic,
    (entry) => (entry.item.relevance >= settings.minRelevance ? ranks.get(entry.item.candidateId) ?? null : null),
    settings.maxPromotedShare,
  );
  const organicPosition = new Map(input.organic.map((entry, index) => [entry.item.candidateId, index]));
  const exposures: BoostExposureRow[] = [];
  placed.forEach(({ item, promoted }, position) => {
    const boostId = boosts.get(item.item.candidateId)?.boostId;
    if (boostId === undefined) return;
    exposures.push({
      boostId, offerId: item.item.candidateId, position, sponsored: promoted,
      gain: Math.max(0, (organicPosition.get(item.item.candidateId) ?? position) - position),
    });
  });
  return { items: placed.map(({ item, promoted }) => (promoted ? { ...item.item, sponsored: true } : item.item)), exposures };
}

/**
 * Étape boost CLOISONNÉE : sous un SAVEPOINT de la transaction de lecture. Une panne du boost (réglages absents, table
 * absente, toute erreur SQL) ne casse JAMAIS le classement : ROLLBACK TO SAVEPOINT, puis l'ordre organique avec
 * `sponsored` faux partout. Les résultats organiques passent avant le revenu. Seul le code de l'erreur est journalisé
 * côté serveur ; rien n'en est renvoyé au client.
 */
async function applyBoost<TCandidate extends OfferRecord | DemandRecord>(
  client: SqlExecutor,
  input: { organic: Array<RankedItem<TCandidate>>; demand: DemandRecord; at: Date },
): Promise<{ items: Array<StoredMatchItem<TCandidate>>; exposures: BoostExposureRow[] | null }> {
  if (input.organic.length === 0) return { items: [], exposures: null };
  await client.query("SAVEPOINT boost_step");
  try {
    const { items, exposures } = await computeBoostedOrder<TCandidate>(client, input);
    await client.query("RELEASE SAVEPOINT boost_step");
    return { items, exposures };
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT boost_step");
    console.error(`[matching] étape boost ignorée (${safeErrorCode(error)}) : classement organique servi.`);
    // Repli organique : rien n'est journalisé (`exposures: null`).
    return { items: input.organic.map((entry) => entry.item), exposures: null };
  }
}

/** Code d'une erreur pour le journal serveur : jamais le message (il peut contenir hôte, requête ou identifiant). */
function safeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "erreur";
}

/**
 * Journal d'exposition (lot 2I4), APRÈS la transaction de lecture : transaction courte et séparée, plafonnée en durée. Toute erreur
 * est attrapée et seul son code est journalisé : l'enregistrement ne change JAMAIS la réponse.
 */
async function journalBoostExposures(pool: Pool, batch: BoostExposureBatch): Promise<void> {
  try {
    await recordBoostExposures(pool, batch);
  } catch (error) {
    console.error(`[matching] journal d'exposition ignoré (${safeErrorCode(error)})`);
  }
}

/**
 * Plage de validité de `at` : horloge de la base − `maxAgeMs` ≤ at ≤ horloge + `maxFutureSkewMs`. Un `at` futur
 * décalerait toutes les échéances (72 h, 14 jours, ancienneté) à volonté ; un `at` ancien est un curseur expiré.
 */
function assertCursorAtInRange(at: Date, databaseNow: Date): void {
  const { maxFutureSkewMs, maxAgeMs } = RELEVANCE_CONFIG.relevance.cursorAt;
  if (at.getTime() > databaseNow.getTime() + maxFutureSkewMs) throw invalidCursor("date postérieure à l'horloge");
  if (at.getTime() < databaseNow.getTime() - maxAgeMs) throw invalidCursor("curseur expiré : recommencez à la première page");
}

/** processing + readAt, dans le même instantané que la lecture des lignes. */
async function readProcessing(
  client: SqlExecutor,
  sourceKind: StoredMatchSourceKind,
  sourceId: string,
  contentVersion: number,
): Promise<{ processing: boolean; readAt: Date }> {
  const jobType = sourceKind === "offer" ? "evaluate_offer_candidates" : "evaluate_demand_candidates";
  const result = await client.query<{ processing: boolean; read_at: Date }>(
    `SELECT (
              EXISTS (SELECT 1 FROM matching_outbox_events ev
                       WHERE ev.aggregate_type = $1 AND ev.aggregate_id = $2::uuid
                         AND ev.aggregate_version = $3 AND ev.dispatch_status = 'pending')
              OR EXISTS (SELECT 1 FROM matching_jobs j
                          WHERE j.job_type = $4 AND j.resource_id = $2::uuid
                            AND j.resource_version = $3 AND j.status IN ('pending', 'running', 'failed'))
            ) AS processing,
            clock_timestamp() AS read_at`,
    [sourceKind, sourceId, contentVersion, jobType],
  );
  return { processing: result.rows[0].processing === true, readAt: result.rows[0].read_at };
}

function validateSort(sort: unknown): StoredMatchSort {
  if (sort === undefined) return "score";
  if (sort === "score" || sort === "relevance") return sort;
  throw new CatalogValidationError("sort doit valoir score ou relevance.");
}

function validateRelevanceWindow(window: unknown): number {
  if (window === undefined) return RELEVANCE_WINDOW;
  const max = RELEVANCE_CONFIG.relevance.maxWindowOption;
  if (typeof window !== "number" || !Number.isSafeInteger(window) || window < 1 || window > max) {
    throw new CatalogValidationError(`relevanceWindow doit être un entier entre 1 et ${max}.`);
  }
  return window;
}

interface StoredReadInput<TSource extends OfferRecord | DemandRecord, TCandidate extends OfferRecord | DemandRecord, TRow extends OfferRow | DemandRow> {
  sourceKind: StoredMatchSourceKind;
  ownerId: string;
  sourceId: string;
  limit: number;
  sort: StoredMatchSort;
  window: number;
  scoreCursor: StoredMatchCursorPayload | null;
  relevanceCursor: RelevanceCursorPayload | null;
  freshness: ReturnType<typeof resolveMatchingFreshnessParams>;
  pool: Pool;
  loadSource: (ownerId: string, sourceId: string, client: SqlExecutor) => Promise<TSource>;
  candidateColumns: string;
  mapCandidate: (row: TRow) => TCandidate;
}

/** Cœur commun aux deux sens : un seul instantané de lecture, mêmes erreurs de source que les routes en direct. */
async function readStored<TSource extends OfferRecord | DemandRecord, TCandidate extends OfferRecord | DemandRecord, TRow extends OfferRow | DemandRow>(
  input: StoredReadInput<TSource, TCandidate, TRow>,
): Promise<StoredMatchesPage<TSource, TCandidate>> {
  // Le journal d'exposition est écrit APRÈS la transaction de lecture (qui reste READ ONLY) : `exposure` n'est renseigné que par le tri
  // par pertinence du sens demande quand l'étape boost a réussi et que la page contient des offres boostées.
  let exposure = null as BoostExposureBatch | null;
  const page = await withReadSnapshot(input.pool, async (client) => {
    const source = await input.loadSource(input.ownerId, input.sourceId, client);
    // Lu AVANT les lignes : readAt est l'horloge (« now ») des indicateurs.
    const { processing, readAt } = await readProcessing(client, input.sourceKind, input.sourceId, source.contentVersion);
    const sourceView = { id: source.id, contentVersion: source.contentVersion, ownerId: source.ownerId, record: source };
    const rowsInput = { sourceKind: input.sourceKind, sourceId: input.sourceId, freshness: input.freshness, candidateColumns: input.candidateColumns };

    if (input.sort === "relevance") {
      // Les pages suivantes recalculent avec now = at, figé à la première page. `at` doit rester proche de l'horloge de la
      // base (lue ci-dessus, avant tout calcul) : ni dans le futur au-delà de la tolérance, ni expiré.
      const at = input.relevanceCursor ? new Date(input.relevanceCursor.at) : readAt;
      if (input.relevanceCursor) assertCursorAtInRange(at, readAt);
      const rows = await fetchRows<TRow>(client, { ...rowsInput, rowLimit: input.window + 1, cursor: null });
      const truncated = rows.length > input.window;
      const ranked = await buildItems<TCandidate, TRow>(client, {
        sourceKind: input.sourceKind, source, rows: truncated ? rows.slice(0, input.window) : rows, mapCandidate: input.mapCandidate, now: at,
      });
      ranked.sort(compareByRelevance);
      // Boost : sens demande seulement (l'acheteur voit des offres). Le décalage s'applique à l'ordre FINAL, calculé à `at`.
      const applied = input.sourceKind === "demand"
        ? await applyBoost<TCandidate>(client, { organic: ranked, demand: source as DemandRecord, at })
        : { items: ranked.map((entry) => entry.item), exposures: null };
      const finalOrder = applied.items;
      const offset = input.relevanceCursor?.offset ?? 0;
      const items = finalOrder.slice(offset, offset + input.limit);
      // Apparitions servies : les éléments boostés de la PAGE (tranche offset … offset + limit), pas de la fenêtre entière.
      const served = (applied.exposures ?? []).filter((row) => row.position >= offset && row.position < offset + input.limit);
      if (served.length > 0) exposure = { demandId: source.id, viewerId: source.ownerId, at: toIsoMicros(at), rows: served };
      const hasMore = offset + input.limit < finalOrder.length;
      const nextCursor = hasMore
        ? encodeRelevanceCursor({ v: 1, sort: "relevance", sourceKind: input.sourceKind, sourceId: input.sourceId, offset: offset + input.limit, at: toIsoMicros(at) })
        : null;
      return { source: sourceView, items, nextCursor, hasMore, limit: input.limit, truncated, processing, readAt };
    }

    const rows = await fetchRows<TRow>(client, { ...rowsInput, rowLimit: input.limit + 1, cursor: input.scoreCursor });
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const ranked = await buildItems<TCandidate, TRow>(client, {
      sourceKind: input.sourceKind, source, rows: pageRows, mapCandidate: input.mapCandidate, now: readAt,
    });
    const last = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last
      ? encodeStoredMatchCursor({
        v: 1, sourceKind: input.sourceKind, sourceId: input.sourceId,
        score: last.eval_score, evaluatedAt: last.eval_evaluated_at_iso, id: last.eval_id,
      })
      : null;
    return { source: sourceView, items: ranked.map((entry) => entry.item), nextCursor, hasMore, limit: input.limit, truncated: false, processing, readAt };
  });
  if (exposure) await journalBoostExposures(input.pool, exposure);
  return page;
}

// ───────────── fiche d'une annonce dans le contexte d'un besoin (lot M1) ─────────────

export interface StoredOfferDetail {
  /** Annonce complète (usage interne : le DTO public n'en prend que les champs de la liste blanche, jamais le propriétaire ni le texte brut). */
  offer: OfferRecord;
  /** La correspondance telle que la liste des résultats la sert : compatibilité, indicateurs, pertinence et `sponsored` (placement relu maintenant). */
  item: StoredMatchItem<OfferRecord>;
  readAt: Date;
}

/**
 * Fiche d'UNE annonce pour l'acheteur, dans le contexte d'un de ses besoins : la correspondance n'est servie que si l'annonce figure parmi les correspondances
 * CONFIRMÉES ET FRAÎCHES de ce besoin (mêmes lignes et même prédicat que `listStoredOfferMatchesForDemand`, `fetchRows`), le besoin appartenant à
 * l'acheteur et étant actif. `null` dans tous les autres cas (besoin inconnu, d'un autre, non actif ; annonce hors correspondances ; vendeur lui-même) :
 * l'appelant répond le même 404, sans rien distinguer. `sponsored` est RELU : le placement (pertinence, boosts effectifs, quota, ancienneté) est recalculé
 * dans le même instantané que la liste des résultats (même fonction `applyBoost`), jamais déduit de la requête du client. Aucune écriture : le journal d'exposition
 * ne compte que les pages de résultats servies, pas cette lecture.
 */
export async function readStoredOfferForDemand(
  ownerIdValue: string,
  demandIdValue: string,
  offerIdValue: string,
  pool?: Pool,
): Promise<StoredOfferDetail | null> {
  const ownerId = requireUuid(ownerIdValue, "ownerId").toLowerCase();
  const demandId = requireUuid(demandIdValue, "demandId").toLowerCase();
  const offerId = requireUuid(offerIdValue, "offerId").toLowerCase();
  const freshness = resolveMatchingFreshnessParams();
  const targetPool = requireTransactionPool(pool);
  return withReadSnapshot(targetPool, async (client) => {
    let demand: DemandRecord;
    try {
      demand = await loadSourceDemand(ownerId, demandId, client);
    } catch (error) {
      if (error instanceof CatalogNotFoundError || error instanceof CatalogValidationError) return null;
      throw error;
    }
    const clock = await client.query<{ read_at: Date }>("SELECT clock_timestamp() AS read_at");
    const readAt = clock.rows[0].read_at;
    const rowsInput = { sourceKind: "demand" as const, sourceId: demandId, freshness, candidateColumns: SOURCE_OFFER_COLUMNS };
    const rows = await fetchRows<OfferRow>(client, { ...rowsInput, rowLimit: RELEVANCE_WINDOW + 1, cursor: null });
    const truncated = rows.length > RELEVANCE_WINDOW;
    const ranked = await buildItems<OfferRecord, OfferRow>(client, {
      sourceKind: "demand", source: demand, rows: truncated ? rows.slice(0, RELEVANCE_WINDOW) : rows, mapCandidate: mapOffer, now: readAt,
    });
    ranked.sort(compareByRelevance);
    const applied = await applyBoost<OfferRecord>(client, { organic: ranked, demand, at: readAt });
    const found = applied.items.find((entry) => entry.candidateId === offerId);
    if (found) return { offer: found.candidate, item: found, readAt };
    // Plus de RELEVANCE_WINDOW correspondances : une annonce confirmée et fraîche peut être au-delà de la fenêtre triée (jamais promue : elle n'est pas dans le placement).
    if (!truncated) return null;
    const single = await fetchRows<OfferRow>(client, { ...rowsInput, rowLimit: 1, cursor: null, candidateId: offerId });
    if (single.length === 0) return null;
    const [entry] = await buildItems<OfferRecord, OfferRow>(client, { sourceKind: "demand", source: demand, rows: single, mapCandidate: mapOffer, now: readAt });
    return { offer: entry.item.candidate, item: entry.item, readAt };
  });
}

// ───────────── classement organique d'une demande, pour la portée d'un boost (lot P2-bis) ─────────────

export interface DemandOrganicEntry {
  offerId: string;
  /** Pertinence organique 0..100 (2 décimales) : exactement celle du tri par pertinence. */
  relevance: number;
}

/**
 * Nombre d'offres que la lecture des résultats de CHACUNE de ces demandes servirait (lignes confirmées et fraîches, plafonné à la fenêtre du tri
 * par pertinence) : c'est le N du quota de places promues. UNE SEULE requête pour toutes les demandes (lot P3 : la portée d'un boost écarte
 * ainsi les listes dont le quota est nul sans relire leur classement), mêmes conditions que `fetchRows`. Une demande sans ligne vaut 0.
 * `cap` (1 à la fenêtre, défaut la fenêtre) PLAFONNE le comptage de chaque demande : au plus `cap` lignes sont lues par demande ; le résultat est
 * min(taille réelle, cap). Un appelant qui n'a besoin que de savoir si la liste atteint un seuil (le quota de places promues est nul sous
 * ceil(1 / part) offres) passe ce seuil : le coût ne dépend plus de la taille des listes (mesuré : 600 ms pour 50 listes de 200 offres sans plafond).
 */
export async function countDemandOrganicLists(client: SqlExecutor, demandIds: readonly string[], cap: number = RELEVANCE_WINDOW): Promise<Map<string, number>> {
  const bound = Math.min(RELEVANCE_WINDOW, Math.max(1, Math.trunc(cap)));
  const sizes = new Map<string, number>(demandIds.map((demandId) => [demandId, 0]));
  if (demandIds.length === 0) return sizes;
  const freshness = buildMatchingFreshnessPredicate(resolveMatchingFreshnessParams(), 3);
  const result = await client.query<{ demand_id: string; n: number }>(
    `WITH ${MATCHING_CURRENT_CLOCK_CTE}
     SELECT req.demand_id,
            (SELECT count(*)::int FROM (
               SELECT 1
                 FROM ${MATCHING_FRESHNESS_FROM}
                WHERE e.demand_id = req.demand_id AND e.is_confirmed_match = TRUE
                  AND ${freshness.conditions.join("\n                  AND ")}
                LIMIT $2::int
             ) counted) AS n
       FROM unnest($1::uuid[]) AS req(demand_id)`,
    [[...demandIds], bound, ...freshness.values],
  );
  for (const row of result.rows) sizes.set(row.demand_id, Math.min(row.n, RELEVANCE_WINDOW));
  return sizes;
}

/** Taille de la liste d'UNE demande (voir `countDemandOrganicLists`). */
export async function countDemandOrganicList(client: SqlExecutor, demandId: string): Promise<number> {
  return (await countDemandOrganicLists(client, [demandId])).get(demandId) ?? 0;
}

/**
 * Le classement ORGANIQUE (pertinence décroissante, départage de `compareByRelevance`) que le tri par pertinence servirait à l'acheteur de
 * cette demande, avant tout boost : mêmes lignes (fenêtre `RELEVANCE_WINDOW`), mêmes indicateurs, même pertinence, calculés avec la même
 * fonction que la lecture. `at` est l'horloge des indicateurs. Lecture seule. `cache` (optionnel) évite de relire, pour une autre demande du
 * MÊME instantané, les propriétaires et le marché de chaque offre : le résultat est identique.
 */
export async function readDemandOrganicRanking(
  client: SqlExecutor,
  input: { demandId: string; ownerId: string; at: Date },
  cache?: OrganicReadCache,
): Promise<DemandOrganicEntry[]> {
  const demand = await loadSourceDemand(input.ownerId, input.demandId, client);
  const rows = await fetchRows<OfferRow>(client, {
    sourceKind: "demand", sourceId: input.demandId, freshness: resolveMatchingFreshnessParams(),
    candidateColumns: SOURCE_OFFER_COLUMNS, rowLimit: RELEVANCE_WINDOW + 1, cursor: null,
  });
  const ranked = await buildItems<OfferRecord, OfferRow>(client, {
    sourceKind: "demand", source: demand, rows: rows.length > RELEVANCE_WINDOW ? rows.slice(0, RELEVANCE_WINDOW) : rows,
    mapCandidate: mapOffer, now: input.at, cache,
  });
  ranked.sort(compareByRelevance);
  return ranked.map((entry) => ({ offerId: entry.item.candidateId, relevance: entry.item.relevance }));
}

/**
 * Correspondances enregistrées d'une offre (demandes candidates). Mêmes validations et mêmes erreurs de source
 * que findEvaluatedDemandMatchesForOffer ; tout dans UN instantané de lecture. Sens offre : indicateurs `availability`
 * et `price` nuls, pertinence = compatibilité et confiance de l'acheteur.
 */
export async function listStoredDemandMatchesForOffer(
  ownerIdValue: string,
  offerIdValue: string,
  options?: StoredMatchesQueryOptions,
  pool?: Pool,
): Promise<StoredMatchesPage<OfferRecord, DemandRecord>> {
  const ownerId = requireUuid(ownerIdValue, "ownerId").toLowerCase();
  const offerId = requireUuid(offerIdValue, "offerId").toLowerCase();
  const limit = validateCandidateLimit(options?.limit);
  const sort = validateSort(options?.sort);
  const window = validateRelevanceWindow(options?.relevanceWindow);
  const expected = { sourceKind: "offer" as const, sourceId: offerId };
  const scoreCursor = sort === "score" ? decodeStoredMatchCursor(options?.cursor, expected) : null;
  const relevanceCursor = sort === "relevance" ? decodeRelevanceCursor(options?.cursor, expected) : null;
  const freshness = resolveMatchingFreshnessParams({
    engineOfflineVersion: options?.expectedEngineOfflineVersion,
    engineScoringVersion: options?.expectedEngineScoringVersion,
    scoringConfigHash: options?.expectedScoringConfigHash,
  });
  const targetPool = requireTransactionPool(pool);
  return readStored<OfferRecord, DemandRecord, DemandRow>({
    sourceKind: "offer", ownerId, sourceId: offerId, limit, sort, window, scoreCursor, relevanceCursor, freshness, pool: targetPool,
    loadSource: loadSourceOffer, candidateColumns: SOURCE_DEMAND_COLUMNS, mapCandidate: mapDemand,
  });
}

/**
 * Correspondances enregistrées d'une demande (offres candidates). Mêmes validations et mêmes erreurs de source
 * que findEvaluatedOfferMatchesForDemand ; tout dans UN instantané de lecture. Sens demande : trois indicateurs sur
 * l'offre candidate, pertinence sur les quatre composantes.
 */
export async function listStoredOfferMatchesForDemand(
  ownerIdValue: string,
  demandIdValue: string,
  options?: StoredMatchesQueryOptions,
  pool?: Pool,
): Promise<StoredMatchesPage<DemandRecord, OfferRecord>> {
  const ownerId = requireUuid(ownerIdValue, "ownerId").toLowerCase();
  const demandId = requireUuid(demandIdValue, "demandId").toLowerCase();
  const limit = validateCandidateLimit(options?.limit);
  const sort = validateSort(options?.sort);
  const window = validateRelevanceWindow(options?.relevanceWindow);
  const expected = { sourceKind: "demand" as const, sourceId: demandId };
  const scoreCursor = sort === "score" ? decodeStoredMatchCursor(options?.cursor, expected) : null;
  const relevanceCursor = sort === "relevance" ? decodeRelevanceCursor(options?.cursor, expected) : null;
  const freshness = resolveMatchingFreshnessParams({
    engineOfflineVersion: options?.expectedEngineOfflineVersion,
    engineScoringVersion: options?.expectedEngineScoringVersion,
    scoringConfigHash: options?.expectedScoringConfigHash,
  });
  const targetPool = requireTransactionPool(pool);
  return readStored<DemandRecord, OfferRecord, OfferRow>({
    sourceKind: "demand", ownerId, sourceId: demandId, limit, sort, window, scoreCursor, relevanceCursor, freshness, pool: targetPool,
    loadSource: loadSourceDemand, candidateColumns: SOURCE_OFFER_COLUMNS, mapCandidate: mapOffer,
  });
}
