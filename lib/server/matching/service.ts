import "server-only";

import type { Pool, PoolClient } from "pg";
import type { SqlExecutor } from "../postgres/client";
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
import {
  requireTransactionPool,
  requireUuid,
} from "../catalog/validation";
import {
  decodeCandidateCursor,
  findDemandCandidatesForOffer,
  findOfferCandidatesForDemand,
  validateCandidateLimit,
} from "./candidates";
import { evaluateOfflineMatching } from "./offline";
import { computeMatchingScore } from "./scoring";
import {
  MATCHING_SERVICE_CONTRACT_VERSION,
  type EvaluatedMatchesQueryOptions,
  type EvaluatedMatchItem,
  type EvaluatedMatchPage,
} from "./service-types";

/**
 * Encapsule l'ensemble des opérations de lecture dans un instantané stable PostgreSQL (REPEATABLE READ READ ONLY).
 * Réserve un client dédié depuis le pool validé et le libère systématiquement à la fin.
 */
async function withReadSnapshot<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Conserver l'erreur utile initiale
    }
    throw error;
  } finally {
    client.release();
  }
}

interface SourceDemandRowWithUserStatus extends DemandRow {
  user_status: string;
  user_archived_at: Date | null;
}

interface SourceOfferRowWithUserStatus extends OfferRow {
  user_status: string;
  user_archived_at: Date | null;
}

const SOURCE_DEMAND_COLUMNS = `
  d.id, d.owner_id, d.status, d.budget_amount::text AS budget_amount, d.budget_currency,
  d.requirements, d.preferences, d.content_version,
  d.raw_text, d.category, d.brand, d.model, d.variant, d.attributes, d.condition_text,
  d.quantity, d.unit, d.location_text, d.deadline_at, d.extractor_version,
  d.extraction_metadata, d.extracted_at, d.created_at, d.updated_at, d.archived_at
`;

const SOURCE_OFFER_COLUMNS = `
  o.id, o.owner_id, o.status, o.price_amount::text AS price_amount, o.price_currency,
  o.availability_status, o.availability_confirmed_at, o.content_version,
  o.raw_text, o.category, o.brand, o.model, o.variant, o.attributes, o.condition_text,
  o.quantity, o.unit, o.location_text, o.deadline_at, o.extractor_version,
  o.extraction_metadata, o.extracted_at, o.created_at, o.updated_at, o.archived_at
`;

/**
 * Charge la demande source complète et vérifie son éligibilité ainsi que celle de son propriétaire.
 */
async function loadSourceDemand(
  ownerId: string,
  demandId: string,
  client: SqlExecutor,
): Promise<DemandRecord> {
  const result = await client.query<SourceDemandRowWithUserStatus>(
    `SELECT ${SOURCE_DEMAND_COLUMNS},
            u.status AS user_status,
            u.archived_at AS user_archived_at
       FROM demands d
       LEFT JOIN users u ON u.id = d.owner_id
      WHERE d.id = $1::uuid`,
    [demandId],
  );

  if (!result.rowCount) {
    throw new CatalogNotFoundError("demande");
  }

  const row = result.rows[0];
  if (row.owner_id.toLowerCase() !== ownerId.toLowerCase()) {
    throw new CatalogNotFoundError("demande");
  }

  if (row.user_status !== "active" || row.user_archived_at !== null) {
    throw new CatalogValidationError("Le propriétaire de la demande n'est pas actif.");
  }

  if (row.status !== "active" || row.archived_at !== null) {
    throw new CatalogValidationError(
      `La demande source n'est pas active (statut: ${row.status}).`,
    );
  }

  return mapDemand(row);
}

/**
 * Charge l'offre source complète et vérifie son éligibilité ainsi que celle de son propriétaire.
 */
async function loadSourceOffer(
  ownerId: string,
  offerId: string,
  client: SqlExecutor,
): Promise<OfferRecord> {
  const result = await client.query<SourceOfferRowWithUserStatus>(
    `SELECT ${SOURCE_OFFER_COLUMNS},
            u.status AS user_status,
            u.archived_at AS user_archived_at
       FROM offers o
       LEFT JOIN users u ON u.id = o.owner_id
      WHERE o.id = $1::uuid`,
    [offerId],
  );

  if (!result.rowCount) {
    throw new CatalogNotFoundError("offre");
  }

  const row = result.rows[0];
  if (row.owner_id.toLowerCase() !== ownerId.toLowerCase()) {
    throw new CatalogNotFoundError("offre");
  }

  if (row.user_status !== "active" || row.user_archived_at !== null) {
    throw new CatalogValidationError("Le propriétaire de l'offre n'est pas actif.");
  }

  if (row.status !== "published" || row.archived_at !== null) {
    throw new CatalogValidationError(
      `L'offre source n'est pas publiée (statut: ${row.status}).`,
    );
  }

  if (row.availability_status === "unavailable") {
    throw new CatalogValidationError("L'offre source est marquée indisponible (unavailable).");
  }

  return mapOffer(row);
}

/**
 * Service serveur évaluant les offres candidates pour une demande source donnée.
 *
 * Valide les entrées (identifiants, limite et curseur) avant toute acquisition de connexion.
 * Exécute sous un instantané PostgreSQL unique et stable (REPEATABLE READ READ ONLY) sur un client réservé :
 * 1. Le chargement complet de la demande source et le contrôle de son propriétaire.
 * 2. La sélection paginée et bornée des offres candidates éligibles (Lot 2C1).
 * 3. L'évaluation déterministe hors ligne de chaque paire (Lot 2A).
 * 4. Le calcul du score explicable et de la couverture (Lot 2B).
 *
 * Préserve l'ordre chronologique décroissant de la page de candidats sans tri par score.
 */
export async function findEvaluatedOfferMatchesForDemand(
  ownerIdValue: string,
  demandIdValue: string,
  options?: EvaluatedMatchesQueryOptions,
  pool?: Pool,
): Promise<EvaluatedMatchPage<DemandRecord, OfferRecord>> {
  const ownerId = requireUuid(ownerIdValue, "ownerId").toLowerCase();
  const demandId = requireUuid(demandIdValue, "demandId").toLowerCase();
  validateCandidateLimit(options?.limit);
  decodeCandidateCursor(options?.cursor);
  const targetPool = requireTransactionPool(pool);
  const now = options?.now ?? new Date();

  return withReadSnapshot(targetPool, async (client) => {
    const sourceDemand = await loadSourceDemand(ownerId, demandId, client);
    const candidatesPage = await findOfferCandidatesForDemand(
      ownerId,
      demandId,
      options,
      client,
    );

    const items: EvaluatedMatchItem<OfferRecord>[] = candidatesPage.items.map((offer) => {
      const evaluation = evaluateOfflineMatching(offer, sourceDemand, { now });
      const scoring = computeMatchingScore(evaluation, {
        ...options?.scoringOptions,
        now,
      });

      return {
        candidateId: offer.id,
        candidateContentVersion: offer.contentVersion,
        candidate: offer,
        compatibilityStatus: evaluation.compatibility.status,
        evaluation,
        scoring,
      };
    });

    return {
      contractVersion: MATCHING_SERVICE_CONTRACT_VERSION,
      evaluatedAt: now,
      source: {
        id: sourceDemand.id,
        contentVersion: sourceDemand.contentVersion,
        ownerId: sourceDemand.ownerId,
        record: sourceDemand,
      },
      items,
      nextCursor: candidatesPage.nextCursor,
      hasMore: candidatesPage.hasMore,
      limit: candidatesPage.limit,
    };
  });
}

/**
 * Service serveur évaluant les demandes candidates pour une offre source donnée.
 *
 * Valide les entrées (identifiants, limite et curseur) avant toute acquisition de connexion.
 * Exécute sous un instantané PostgreSQL unique et stable (REPEATABLE READ READ ONLY) sur un client réservé :
 * 1. Le chargement complet de l'offre source et le contrôle de son propriétaire.
 * 2. La sélection paginée et bornée des demandes candidates éligibles (Lot 2C1).
 * 3. L'évaluation déterministe hors ligne de chaque paire (Lot 2A).
 * 4. Le calcul du score explicable et de la couverture (Lot 2B).
 *
 * Préserve l'ordre chronologique décroissant de la page de candidats sans tri par score.
 */
export async function findEvaluatedDemandMatchesForOffer(
  ownerIdValue: string,
  offerIdValue: string,
  options?: EvaluatedMatchesQueryOptions,
  pool?: Pool,
): Promise<EvaluatedMatchPage<OfferRecord, DemandRecord>> {
  const ownerId = requireUuid(ownerIdValue, "ownerId").toLowerCase();
  const offerId = requireUuid(offerIdValue, "offerId").toLowerCase();
  validateCandidateLimit(options?.limit);
  decodeCandidateCursor(options?.cursor);
  const targetPool = requireTransactionPool(pool);
  const now = options?.now ?? new Date();

  return withReadSnapshot(targetPool, async (client) => {
    const sourceOffer = await loadSourceOffer(ownerId, offerId, client);
    const candidatesPage = await findDemandCandidatesForOffer(
      ownerId,
      offerId,
      options,
      client,
    );

    const items: EvaluatedMatchItem<DemandRecord>[] = candidatesPage.items.map((demand) => {
      const evaluation = evaluateOfflineMatching(sourceOffer, demand, { now });
      const scoring = computeMatchingScore(evaluation, {
        ...options?.scoringOptions,
        now,
      });

      return {
        candidateId: demand.id,
        candidateContentVersion: demand.contentVersion,
        candidate: demand,
        compatibilityStatus: evaluation.compatibility.status,
        evaluation,
        scoring,
      };
    });

    return {
      contractVersion: MATCHING_SERVICE_CONTRACT_VERSION,
      evaluatedAt: now,
      source: {
        id: sourceOffer.id,
        contentVersion: sourceOffer.contentVersion,
        ownerId: sourceOffer.ownerId,
        record: sourceOffer,
      },
      items,
      nextCursor: candidatesPage.nextCursor,
      hasMore: candidatesPage.hasMore,
      limit: candidatesPage.limit,
    };
  });
}

export const getEvaluatedOfferMatchesForDemand = findEvaluatedOfferMatchesForDemand;
export const getEvaluatedDemandMatchesForOffer = findEvaluatedDemandMatchesForOffer;
