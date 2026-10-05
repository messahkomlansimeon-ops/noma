import "server-only";

import type { Pool } from "pg";
import type { SqlExecutor } from "../postgres/client";
import { CatalogValidationError } from "../catalog/errors";
import { mapDemand, mapOffer, type DemandRow, type OfferRow } from "../catalog/shared";
import type { DemandRecord, OfferRecord } from "../catalog/types";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { validateCandidateLimit } from "./candidates";
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

export interface StoredMatchesQueryOptions {
  limit?: number;
  cursor?: string;
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
  /**
   * true si la VERSION COURANTE de la source est en cours de traitement : événement outbox pending de son agrégat à
   * cette version, ou job evaluate_* du bon type sur (source, version) pending / running / failed. Un NOUVEAU
   * candidat est ajouté plus tard par SON PROPRE job : ce cas n'est pas reflété par `processing`.
   */
  processing: boolean;
  /** clock_timestamp() de la base à la fin de la lecture. */
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
  e.id AS eval_id, e.score::text AS eval_score, e.coverage::text AS eval_coverage,
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

async function listStoredMatches<
  TCandidate extends OfferRecord | DemandRecord,
  TRow extends OfferRow | DemandRow,
>(
  client: SqlExecutor,
  input: {
    sourceKind: StoredMatchSourceKind;
    sourceId: string;
    limit: number;
    cursor: StoredMatchCursorPayload | null;
    freshness: ReturnType<typeof resolveMatchingFreshnessParams>;
    candidateColumns: string;
    mapCandidate: (row: TRow) => TCandidate;
  },
): Promise<{ items: StoredMatchItem<TCandidate>[]; nextCursor: string | null; hasMore: boolean }> {
  const sourceColumn = input.sourceKind === "offer" ? "e.offer_id" : "e.demand_id";
  const freshness = buildMatchingFreshnessPredicate(input.freshness, 2);
  const values: unknown[] = [input.sourceId, ...freshness.values];
  const cursorCondition = input.cursor ? keysetCondition(input.cursor, values) : "";
  values.push(input.limit + 1);

  const result = await client.query<CandidateRow<TRow>>(
    `WITH ${MATCHING_CURRENT_CLOCK_CTE}
     SELECT ${input.candidateColumns}, ${EVALUATION_COLUMNS}
       FROM ${MATCHING_FRESHNESS_FROM}
      WHERE ${sourceColumn} = $1::uuid
        AND e.is_confirmed_match = TRUE
        AND ${freshness.conditions.join("\n        AND ")}
        ${cursorCondition}
      ORDER BY ${SORT_ORDER}
      LIMIT $${values.length}`,
    values,
  );

  const hasMore = result.rows.length > input.limit;
  const rows = hasMore ? result.rows.slice(0, input.limit) : result.rows;
  const items = rows.map((row): StoredMatchItem<TCandidate> => {
    const candidate = input.mapCandidate(row);
    return {
      candidateId: candidate.id,
      candidateContentVersion: candidate.contentVersion,
      candidate,
      compatibilityStatus: row.eval_compatibility_status,
      score: row.eval_score === null ? null : Number(row.eval_score),
      coverage: row.eval_coverage === null ? null : Number(row.eval_coverage),
      evaluatedAt: row.eval_evaluated_at,
      evaluationSummary: readEvaluationSummary(row.eval_evaluation_summary),
      scoringSummary: readScoringSummary(row.eval_scoring_summary),
      preferencesSummary: readPreferencesSummary(row.eval_preferences_summary),
    };
  });
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last
    ? encodeStoredMatchCursor({
      v: 1, sourceKind: input.sourceKind, sourceId: input.sourceId,
      score: last.eval_score, evaluatedAt: last.eval_evaluated_at_iso, id: last.eval_id,
    })
    : null;
  return { items, nextCursor, hasMore };
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

/**
 * Correspondances enregistrées d'une offre (demandes candidates). Mêmes validations et mêmes erreurs de source
 * que findEvaluatedDemandMatchesForOffer ; tout dans UN instantané de lecture.
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
  const cursor = decodeStoredMatchCursor(options?.cursor, { sourceKind: "offer", sourceId: offerId });
  const freshness = resolveMatchingFreshnessParams({
    engineOfflineVersion: options?.expectedEngineOfflineVersion,
    engineScoringVersion: options?.expectedEngineScoringVersion,
    scoringConfigHash: options?.expectedScoringConfigHash,
  });
  const targetPool = requireTransactionPool(pool);

  return withReadSnapshot(targetPool, async (client) => {
    const sourceOffer = await loadSourceOffer(ownerId, offerId, client);
    const page = await listStoredMatches<DemandRecord, DemandRow>(client, {
      sourceKind: "offer", sourceId: offerId, limit, cursor, freshness,
      candidateColumns: SOURCE_DEMAND_COLUMNS, mapCandidate: mapDemand,
    });
    const { processing, readAt } = await readProcessing(client, "offer", offerId, sourceOffer.contentVersion);
    return {
      source: { id: sourceOffer.id, contentVersion: sourceOffer.contentVersion, ownerId: sourceOffer.ownerId, record: sourceOffer },
      ...page, limit, processing, readAt,
    };
  });
}

/**
 * Correspondances enregistrées d'une demande (offres candidates). Mêmes validations et mêmes erreurs de source
 * que findEvaluatedOfferMatchesForDemand ; tout dans UN instantané de lecture.
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
  const cursor = decodeStoredMatchCursor(options?.cursor, { sourceKind: "demand", sourceId: demandId });
  const freshness = resolveMatchingFreshnessParams({
    engineOfflineVersion: options?.expectedEngineOfflineVersion,
    engineScoringVersion: options?.expectedEngineScoringVersion,
    scoringConfigHash: options?.expectedScoringConfigHash,
  });
  const targetPool = requireTransactionPool(pool);

  return withReadSnapshot(targetPool, async (client) => {
    const sourceDemand = await loadSourceDemand(ownerId, demandId, client);
    const page = await listStoredMatches<OfferRecord, OfferRow>(client, {
      sourceKind: "demand", sourceId: demandId, limit, cursor, freshness,
      candidateColumns: SOURCE_OFFER_COLUMNS, mapCandidate: mapOffer,
    });
    const { processing, readAt } = await readProcessing(client, "demand", demandId, sourceDemand.contentVersion);
    return {
      source: { id: sourceDemand.id, contentVersion: sourceDemand.contentVersion, ownerId: sourceDemand.ownerId, record: sourceDemand },
      ...page, limit, processing, readAt,
    };
  });
}
