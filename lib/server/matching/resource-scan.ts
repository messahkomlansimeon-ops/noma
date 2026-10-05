import "server-only";

import type { SqlExecutor } from "../postgres/client";
import { computeJobIdentity, type PlannedMatchingJob } from "./projection";

/**
 * Parcours keyset des ressources éligibles, partagé par le sweep de réactivation (un compte) et le bootstrap
 * (tous les propriétaires actifs). Module interne : pas d'export dans index.ts.
 */
export type ScanKind = "offer" | "demand";

export interface ScanPosition {
  kind: ScanKind;
  /** created_at en texte PostgreSQL (précision microseconde conservée) et id de la dernière ressource lue. */
  after: { createdAt: string; id: string } | null;
}

export interface ScannedResource {
  id: string;
  content_version: number;
  created_at_text: string;
}

/** Un compte précis (sweep : son état est contrôlé ailleurs) ou tous les propriétaires actifs et non archivés. */
export type ScanOwnerFilter = { kind: "account"; ownerId: string } | { kind: "active_owners" };

export const INITIAL_SCAN_POSITION: ScanPosition = { kind: "offer", after: null };

/**
 * Éligibilité EXACTEMENT celle de loadSourceOffer / loadSourceDemand (service.ts) :
 * offre published, non archivée, disponibilité ≠ unavailable (NULL accepté) ; demande active, non archivée.
 * Filtre propriétaire : `account` = ce compte seulement ; `active_owners` = propriétaire actif et non archivé (SQL).
 */
export async function listEligibleResources(
  executor: SqlExecutor,
  owner: ScanOwnerFilter,
  position: ScanPosition,
  batchSize: number,
): Promise<ScannedResource[]> {
  const eligibility = position.kind === "offer"
    ? "status = 'published' AND archived_at IS NULL AND availability_status IS DISTINCT FROM 'unavailable'"
    : "status = 'active' AND archived_at IS NULL";
  const table = position.kind === "offer" ? "offers" : "demands";
  const params: unknown[] = [];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };

  let ownerClause: string;
  if (owner.kind === "account") {
    ownerClause = `owner_id = ${bind(owner.ownerId)}::uuid AND ${eligibility}`;
  } else {
    ownerClause = `${eligibility} AND owner_id IN (SELECT id FROM users WHERE status = 'active' AND archived_at IS NULL)`;
  }
  const limit = bind(batchSize);
  let keyset = "";
  if (position.after) {
    keyset = `AND (created_at, id) > (${bind(position.after.createdAt)}::timestamptz, ${bind(position.after.id)}::uuid)`;
  }
  const result = await executor.query<ScannedResource>(
    `SELECT id, content_version, created_at::text AS created_at_text
       FROM ${table}
      WHERE ${ownerClause} ${keyset}
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}`,
    params,
  );
  return result.rows;
}

/** Position suivante : même type après un lot plein, sinon offres → demandes, puis fin (null). */
export function nextScanPosition(position: ScanPosition, rows: readonly ScannedResource[], batchSize: number): ScanPosition | null {
  if (rows.length === batchSize) {
    const last = rows[rows.length - 1];
    return { kind: position.kind, after: { createdAt: last.created_at_text, id: last.id } };
  }
  return position.kind === "offer" ? { kind: "demand", after: null } : null;
}

export interface ChildJobInput {
  kind: ScanKind;
  row: ScannedResource;
  /** Génération scellée : celle du sweep (version du compte) ou du bootstrap (content_version de la ressource). */
  generation: number;
  scoringConfigHash: string;
  sourceEventId: string;
}

/** Job enfant d'évaluation : version = content_version courante de la ressource, cible nulle. */
export function buildEvaluationChildJob(input: ChildJobInput): PlannedMatchingJob {
  const { kind, row, generation, scoringConfigHash, sourceEventId } = input;
  const jobType = kind === "offer" ? "evaluate_offer_candidates" : "evaluate_demand_candidates";
  return {
    jobIdentity: computeJobIdentity({
      generation,
      jobType,
      resourceId: row.id,
      resourceVersion: row.content_version,
      scoringConfigHash,
      sourceEventId,
      targetResourceId: null,
    }),
    jobType,
    resourceId: row.id,
    resourceVersion: row.content_version,
    targetResourceId: null,
    scoringConfigHash,
    sourceEventId,
    generation,
  };
}
