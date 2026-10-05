import "server-only";

import type { QueryResultRow } from "pg";
import { getPostgresPool, type SqlExecutor } from "../postgres/client";
import {
  CatalogNotFoundError,
  CatalogValidationError,
} from "../catalog/errors";
import {
  mapDemand,
  mapOffer,
  type DemandRow,
  type OfferRow,
} from "../catalog/shared";
import type { DemandRecord, OfferRecord } from "../catalog/types";
import { requireUuid } from "../catalog/validation";
import type {
  CandidateCursorPayload,
  CandidatePage,
  CandidateQueryOptions,
  InternalDemandCandidateQueryOptions,
} from "./candidates-types";

export const DEFAULT_CANDIDATE_LIMIT = 20;
export const MAX_CANDIDATE_LIMIT = 100;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_UTC_MICROSECONDS_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

/**
 * Valide et extrait la limite de pagination demandée.
 */
export function validateCandidateLimit(limit?: number): number {
  if (limit === undefined) {
    return DEFAULT_CANDIDATE_LIMIT;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CANDIDATE_LIMIT) {
    throw new CatalogValidationError(
      `limit doit être un entier compris entre 1 et ${MAX_CANDIDATE_LIMIT}.`,
    );
  }
  return limit;
}

/**
 * Encode un curseur SQL opaque préservant la précision microseconde.
 */
export function encodeCandidateCursor(payload: CandidateCursorPayload): string {
  const jsonStr = JSON.stringify({
    createdAtIso: payload.createdAtIso,
    id: payload.id,
  });
  return Buffer.from(jsonStr, "utf8").toString("base64url");
}

/**
 * Décode et valide strictement un curseur opaque avant tout appel SQL.
 * Rejette les types non chaîne, encodages non conformes, dates corrompues ou non calendaires.
 */
export function decodeCandidateCursor(cursor?: unknown): CandidateCursorPayload | null {
  if (cursor === undefined || cursor === null) {
    return null;
  }
  if (typeof cursor !== "string") {
    throw new CatalogValidationError("Curseur de pagination invalide (chaîne attendue).");
  }
  if (!BASE64URL_PATTERN.test(cursor) || cursor.length > 512) {
    throw new CatalogValidationError("Curseur de pagination invalide (encodage base64url non conforme).");
  }

  let parsed: unknown;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(raw);
  } catch {
    throw new CatalogValidationError("Curseur de pagination invalide ou corrompu.");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new CatalogValidationError("Structure de curseur invalide.");
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !("createdAtIso" in parsed) || !("id" in parsed)) {
    throw new CatalogValidationError("Curseur de pagination incomplet ou comportant des propriétés inattendues.");
  }

  const { createdAtIso, id } = parsed as { createdAtIso: unknown; id: unknown };
  if (typeof id !== "string" || !UUID_REGEX.test(id)) {
    throw new CatalogValidationError("Identifiant de curseur invalide.");
  }

  if (typeof createdAtIso !== "string") {
    throw new CatalogValidationError("Format de date de curseur invalide.");
  }

  const match = ISO_UTC_MICROSECONDS_PATTERN.exec(createdAtIso);
  if (!match) {
    throw new CatalogValidationError("Date de curseur invalide (ISO UTC avec microsecondes requis).");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new CatalogValidationError("Date de curseur hors limites calendaires.");
  }

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new CatalogValidationError("Date de curseur calendairement invalide.");
  }

  return {
    createdAtIso,
    id,
  };
}

/**
 * Valide la restriction interne `candidateId` avant tout SQL : UUID (renvoyé en minuscules) ou null.
 * Combinée à un curseur non nul, elle est refusée (une restriction à un candidat n'a pas de page suivante).
 */
export function resolveInternalCandidateId(options?: InternalDemandCandidateQueryOptions): string | null {
  const raw = options?.candidateId;
  if (raw === undefined) return null;
  const candidateId = requireUuid(raw, "candidateId").toLowerCase();
  if (options?.cursor !== undefined && options.cursor !== null) {
    throw new CatalogValidationError("candidateId ne peut pas être combiné à un curseur.");
  }
  return candidateId;
}

interface CandidateOfferRowWithSourceStatus extends Partial<OfferRow>, QueryResultRow {
  source_check_status: "OK" | "NOT_FOUND" | "USER_INACTIVE" | "DEMAND_INACTIVE";
  source_raw_status: string | null;
  created_at_iso?: string;
}

interface CandidateDemandRowWithSourceStatus extends Partial<DemandRow>, QueryResultRow {
  source_check_status: "OK" | "NOT_FOUND" | "USER_INACTIVE" | "OFFER_INACTIVE" | "OFFER_UNAVAILABLE";
  source_raw_status: string | null;
  created_at_iso?: string;
}

const CANDIDATE_OFFER_COLUMNS = `
  o.id, o.owner_id, o.status, o.price_amount::text AS price_amount, o.price_currency,
  o.availability_status, o.availability_confirmed_at, o.content_version,
  o.raw_text, o.category, o.brand, o.model, o.variant, o.attributes, o.condition_text,
  o.quantity, o.unit, o.location_text, o.deadline_at, o.extractor_version,
  o.extraction_metadata, o.extracted_at, o.created_at, o.updated_at, o.archived_at
`;

const CANDIDATE_DEMAND_COLUMNS = `
  d.id, d.owner_id, d.status, d.budget_amount::text AS budget_amount, d.budget_currency,
  d.requirements, d.preferences, d.content_version,
  d.raw_text, d.category, d.brand, d.model, d.variant, d.attributes, d.condition_text,
  d.quantity, d.unit, d.location_text, d.deadline_at, d.extractor_version,
  d.extraction_metadata, d.extracted_at, d.created_at, d.updated_at, d.archived_at
`;

/**
 * Sélectionne les offres candidates pour une demande active donnée.
 *
 * Filtres d'éligibilité et cohérence d'instantané (exécuté en une seule requête SQL) :
 * 1. Source et son propriétaire vérifiés dans le même instantané que les candidats.
 * 2. Propriétaire source actif, demande active non archivée.
 * 3. Exclusion de l'auto-matching (candidate.owner_id <> source.owner_id).
 * 4. Propriétaire du candidat actif et non archivé (users.status = 'active' AND users.archived_at IS NULL).
 * 5. Statut de l'offre candidate = 'published' et non archivée.
 * 6. Disponibilité de l'offre : availability_status IS DISTINCT FROM 'unavailable' (conserve 'available', 'reserved' et null).
 * 7. Pagination par curseur stable (created_at DESC, id DESC) préservant l'UTC et les microsecondes.
 */
export async function findOfferCandidatesForDemand(
  ownerIdValue: string,
  demandIdValue: string,
  options?: CandidateQueryOptions,
  db: SqlExecutor = getPostgresPool(),
): Promise<CandidatePage<OfferRecord>> {
  const ownerId = requireUuid(ownerIdValue, "ownerId").toLowerCase();
  const demandId = requireUuid(demandIdValue, "demandId").toLowerCase();
  const limit = validateCandidateLimit(options?.limit);
  const cursorPayload = decodeCandidateCursor(options?.cursor);

  const values: unknown[] = [demandId, ownerId, limit + 1];
  let cursorCondition = "";

  if (cursorPayload) {
    values.push(cursorPayload.createdAtIso, cursorPayload.id.toLowerCase());
    const pDate = values.length - 1;
    const pId = values.length;
    cursorCondition = `AND (o.created_at, o.id) < ($${pDate}::timestamptz, $${pId}::uuid)`;
  }

  const queryText = `
    WITH source_info AS (
      SELECT d.id, d.owner_id, d.status, d.archived_at,
             u.status AS user_status, u.archived_at AS user_archived_at
        FROM demands d
        LEFT JOIN users u ON u.id = d.owner_id
       WHERE d.id = $1::uuid
    ),
    source_check AS (
      SELECT
        CASE
          WHEN s.owner_id <> $2::uuid THEN 'NOT_FOUND'
          WHEN s.user_status IS DISTINCT FROM 'active' OR s.user_archived_at IS NOT NULL THEN 'USER_INACTIVE'
          WHEN s.status <> 'active' OR s.archived_at IS NOT NULL THEN 'DEMAND_INACTIVE'
          ELSE 'OK'
        END AS check_status,
        s.status AS source_status
      FROM source_info s
    ),
    candidates AS (
      SELECT ${CANDIDATE_OFFER_COLUMNS},
             to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso
        FROM offers o
        JOIN users u ON u.id = o.owner_id
       WHERE (SELECT check_status FROM source_check) = 'OK'
         AND o.owner_id <> $2::uuid
         AND o.status = 'published'
         AND o.archived_at IS NULL
         AND o.availability_status IS DISTINCT FROM 'unavailable'
         AND u.status = 'active'
         AND u.archived_at IS NULL
         ${cursorCondition}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT $3
    )
    SELECT
      sc.check_status AS source_check_status,
      sc.source_status AS source_raw_status,
      c.*
    FROM (
      SELECT
        COALESCE((SELECT check_status FROM source_check), 'NOT_FOUND') AS check_status,
        (SELECT source_status FROM source_check) AS source_status
    ) sc
    LEFT JOIN candidates c ON sc.check_status = 'OK'
    ORDER BY c.created_at DESC NULLS LAST, c.id DESC NULLS LAST
  `;

  const result = await db.query<CandidateOfferRowWithSourceStatus>(queryText, values);
  const firstRow = result.rows[0];

  if (!firstRow || firstRow.source_check_status === "NOT_FOUND") {
    throw new CatalogNotFoundError("demande");
  }

  if (firstRow.source_check_status === "USER_INACTIVE") {
    throw new CatalogValidationError("Le propriétaire de la demande n'est pas actif.");
  }

  if (firstRow.source_check_status === "DEMAND_INACTIVE") {
    throw new CatalogValidationError(
      `La demande source n'est pas active (statut: ${firstRow.source_raw_status ?? "inconnu"}).`,
    );
  }

  const validRows = firstRow.id ? (result.rows as OfferRow[]) : [];
  const hasMore = validRows.length > limit;
  const itemsRows = hasMore ? validRows.slice(0, limit) : validRows;
  const items = itemsRows.map(mapOffer);

  let nextCursor: string | null = null;
  if (hasMore && itemsRows.length > 0) {
    const lastRow = itemsRows[itemsRows.length - 1];
    nextCursor = encodeCandidateCursor({
      createdAtIso: lastRow.created_at_iso!,
      id: lastRow.id,
    });
  }

  return {
    items,
    nextCursor,
    hasMore,
    limit,
  };
}

/**
 * Sélectionne les demandes candidates pour une offre publiée donnée.
 *
 * Filtres d'éligibilité et cohérence d'instantané (exécuté en une seule requête SQL) :
 * 1. Source et son propriétaire vérifiés dans le même instantané que les candidats.
 * 2. Propriétaire source actif, offre publiée non archivée et non indisponible.
 * 3. Exclusion de l'auto-matching (candidate.owner_id <> source.owner_id).
 * 4. Propriétaire du candidat actif et non archivé (users.status = 'active' AND users.archived_at IS NULL).
 * 5. Statut de la demande candidate = 'active' et non archivée.
 * 6. Pagination par curseur stable (created_at DESC, id DESC) préservant l'UTC et les microsecondes.
 * Option INTERNE `candidateId` : une seule condition `d.id = $n` ajoutée à la même requête (même éligibilité).
 */
export async function findDemandCandidatesForOffer(
  ownerIdValue: string,
  offerIdValue: string,
  options?: InternalDemandCandidateQueryOptions,
  db: SqlExecutor = getPostgresPool(),
): Promise<CandidatePage<DemandRecord>> {
  const ownerId = requireUuid(ownerIdValue, "ownerId").toLowerCase();
  const offerId = requireUuid(offerIdValue, "offerId").toLowerCase();
  const limit = validateCandidateLimit(options?.limit);
  const cursorPayload = decodeCandidateCursor(options?.cursor);
  const candidateId = resolveInternalCandidateId(options);

  const values: unknown[] = [offerId, ownerId, limit + 1];
  let cursorCondition = "";
  let candidateCondition = "";
  if (candidateId) {
    values.push(candidateId);
    candidateCondition = `AND d.id = $${values.length}::uuid`;
  }

  if (cursorPayload) {
    values.push(cursorPayload.createdAtIso, cursorPayload.id.toLowerCase());
    const pDate = values.length - 1;
    const pId = values.length;
    cursorCondition = `AND (d.created_at, d.id) < ($${pDate}::timestamptz, $${pId}::uuid)`;
  }

  const queryText = `
    WITH source_info AS (
      SELECT o.id, o.owner_id, o.status, o.availability_status, o.archived_at,
             u.status AS user_status, u.archived_at AS user_archived_at
        FROM offers o
        LEFT JOIN users u ON u.id = o.owner_id
       WHERE o.id = $1::uuid
    ),
    source_check AS (
      SELECT
        CASE
          WHEN s.owner_id <> $2::uuid THEN 'NOT_FOUND'
          WHEN s.user_status IS DISTINCT FROM 'active' OR s.user_archived_at IS NOT NULL THEN 'USER_INACTIVE'
          WHEN s.status <> 'published' OR s.archived_at IS NOT NULL THEN 'OFFER_INACTIVE'
          WHEN s.availability_status = 'unavailable' THEN 'OFFER_UNAVAILABLE'
          ELSE 'OK'
        END AS check_status,
        s.status AS source_status
      FROM source_info s
    ),
    candidates AS (
      SELECT ${CANDIDATE_DEMAND_COLUMNS},
             to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso
        FROM demands d
        JOIN users u ON u.id = d.owner_id
       WHERE (SELECT check_status FROM source_check) = 'OK'
         AND d.owner_id <> $2::uuid
         AND d.status = 'active'
         AND d.archived_at IS NULL
         AND u.status = 'active'
         AND u.archived_at IS NULL
         ${candidateCondition}
         ${cursorCondition}
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT $3
    )
    SELECT
      sc.check_status AS source_check_status,
      sc.source_status AS source_raw_status,
      c.*
    FROM (
      SELECT
        COALESCE((SELECT check_status FROM source_check), 'NOT_FOUND') AS check_status,
        (SELECT source_status FROM source_check) AS source_status
    ) sc
    LEFT JOIN candidates c ON sc.check_status = 'OK'
    ORDER BY c.created_at DESC NULLS LAST, c.id DESC NULLS LAST
  `;

  const result = await db.query<CandidateDemandRowWithSourceStatus>(queryText, values);
  const firstRow = result.rows[0];

  if (!firstRow || firstRow.source_check_status === "NOT_FOUND") {
    throw new CatalogNotFoundError("offre");
  }

  if (firstRow.source_check_status === "USER_INACTIVE") {
    throw new CatalogValidationError("Le propriétaire de l'offre n'est pas actif.");
  }

  if (firstRow.source_check_status === "OFFER_INACTIVE") {
    throw new CatalogValidationError(
      `L'offre source n'est pas publiée (statut: ${firstRow.source_raw_status ?? "inconnu"}).`,
    );
  }

  if (firstRow.source_check_status === "OFFER_UNAVAILABLE") {
    throw new CatalogValidationError("L'offre source est marquée indisponible (unavailable).");
  }

  const validRows = firstRow.id ? (result.rows as DemandRow[]) : [];
  const hasMore = validRows.length > limit;
  const itemsRows = hasMore ? validRows.slice(0, limit) : validRows;
  const items = itemsRows.map(mapDemand);

  let nextCursor: string | null = null;
  if (hasMore && itemsRows.length > 0) {
    const lastRow = itemsRows[itemsRows.length - 1];
    nextCursor = encodeCandidateCursor({
      createdAtIso: lastRow.created_at_iso!,
      id: lastRow.id,
    });
  }

  return {
    items,
    nextCursor,
    hasMore,
    limit,
  };
}
