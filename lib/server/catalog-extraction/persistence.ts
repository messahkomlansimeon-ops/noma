import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { ArchivedCatalogResourceError, CatalogNotFoundError } from "../catalog/errors";
import type { CatalogPagination } from "../catalog/types";
import { requireCatalogPagination, requireUuid } from "../catalog/validation";
import {
  getPostgresPool,
  type SqlExecutor,
  withPostgresTransaction,
} from "../postgres/client";
import { extractCatalogProposal } from "./service";
import {
  CATALOG_EXTRACTION_CONTRACT_VERSION,
  DETERMINISTIC_EXTRACTOR_VERSION,
  type CatalogExtractionAmbiguity,
  type CatalogExtractionProposal,
  type CatalogExtractionProvenance,
  type CatalogExtractionType,
  type CatalogTextEvidence,
} from "./types";

export class CatalogExtractionPersistenceConflictError extends Error {
  constructor() {
    super("La ressource catalogue a changé pendant son extraction.");
    this.name = "CatalogExtractionPersistenceConflictError";
  }
}

export interface CreateCatalogExtractionProposalInput {
  ownerId: string;
  resourceType: CatalogExtractionType;
  resourceId: string;
}

export interface ReadCatalogExtractionProposalInput {
  ownerId: string;
  proposalId: string;
}

export interface ListCatalogExtractionProposalsInput {
  ownerId: string;
  resourceType: CatalogExtractionType;
  resourceId: string;
  pagination?: CatalogPagination;
}

export interface PersistedCatalogExtractionProposal {
  id: string;
  resourceType: CatalogExtractionType;
  resourceId: string;
  sourceContentVersion: number;
  sourceRawText: string;
  sourceTextSha256: string;
  contractVersion: string;
  extractorVersion: string;
  provenance: CatalogExtractionProvenance;
  proposal: CatalogExtractionProposal;
  evidence: CatalogTextEvidence[];
  ambiguities: CatalogExtractionAmbiguity[];
  createdAt: Date;
  /** Vrai si le contenu courant diffère ou si la ressource est archivée. */
  isStale: boolean;
}

export interface CatalogExtractionPersistenceOptions {
  pool?: Pool;
  /** Point de synchronisation sans remplacement de l'extracteur déterministe. */
  afterExtraction?: () => Promise<void>;
}

interface ResourceDefinition {
  table: "offers" | "demands";
  referenceColumn: "offer_id" | "demand_id";
  label: "offre" | "demande";
}

interface ResourceRow extends QueryResultRow {
  id: string;
  raw_text: string;
  content_version: number;
  status: string;
}

interface ProposalRow extends QueryResultRow {
  id: string;
  offer_id: string | null;
  demand_id: string | null;
  source_content_version: number;
  source_raw_text: string;
  source_text_sha256: string;
  contract_version: string;
  extractor_version: string;
  provenance: CatalogExtractionProvenance;
  proposal: CatalogExtractionProposal;
  evidence: CatalogTextEvidence[];
  ambiguities: CatalogExtractionAmbiguity[];
  created_at: Date;
  current_content_version?: number;
  current_raw_text?: string;
  current_status?: string;
}

interface ResourceSnapshot {
  id: string;
  rawText: string;
  contentVersion: number;
  status: string;
}

const PROPOSAL_COLUMNS = `
  id, offer_id, demand_id, source_content_version, source_raw_text,
  source_text_sha256, contract_version, extractor_version, provenance,
  proposal, evidence, ambiguities, created_at
`;

function definitionFor(type: CatalogExtractionType): ResourceDefinition {
  return type === "offer"
    ? { table: "offers", referenceColumn: "offer_id", label: "offre" }
    : { table: "demands", referenceColumn: "demand_id", label: "demande" };
}

function requireResourceType(value: CatalogExtractionType): CatalogExtractionType {
  if (value !== "offer" && value !== "demand") {
    throw new TypeError("resourceType doit valoir offer ou demand.");
  }
  return value;
}

function textFingerprint(rawText: string): string {
  return createHash("sha256").update(rawText, "utf8").digest("hex");
}

function resourceSnapshot(row: ResourceRow): ResourceSnapshot {
  return {
    id: row.id,
    rawText: row.raw_text,
    contentVersion: row.content_version,
    status: row.status,
  };
}

async function readOwnedResource(
  db: SqlExecutor,
  definition: ResourceDefinition,
  ownerId: string,
  resourceId: string,
  lock: "FOR SHARE" | "FOR UPDATE",
): Promise<ResourceSnapshot | null> {
  const result = await db.query<ResourceRow>(
    `SELECT id, raw_text, content_version, status
       FROM ${definition.table}
      WHERE id = $1 AND owner_id = $2
      ${lock}`,
    [resourceId, ownerId],
  );
  return result.rowCount ? resourceSnapshot(result.rows[0]) : null;
}

async function readExactProposal(
  db: SqlExecutor,
  definition: ResourceDefinition,
  resourceId: string,
  contentVersion: number,
): Promise<ProposalRow | null> {
  const result = await db.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM catalog_extraction_proposals
      WHERE ${definition.referenceColumn} = $1
        AND source_content_version = $2
        AND contract_version = $3
        AND extractor_version = $4`,
    [
      resourceId,
      contentVersion,
      CATALOG_EXTRACTION_CONTRACT_VERSION,
      DETERMINISTIC_EXTRACTOR_VERSION,
    ],
  );
  return result.rowCount ? result.rows[0] : null;
}

function mapProposal(
  row: ProposalRow,
  current: { contentVersion: number; rawText: string; status: string },
): PersistedCatalogExtractionProposal {
  const resourceType = row.offer_id === null ? "demand" : "offer";
  return {
    id: row.id,
    resourceType,
    resourceId: row.offer_id ?? row.demand_id!,
    sourceContentVersion: row.source_content_version,
    sourceRawText: row.source_raw_text,
    sourceTextSha256: row.source_text_sha256,
    contractVersion: row.contract_version,
    extractorVersion: row.extractor_version,
    provenance: row.provenance,
    proposal: row.proposal,
    evidence: row.evidence,
    ambiguities: row.ambiguities,
    createdAt: row.created_at,
    isStale:
      current.status === "archived" ||
      current.contentVersion !== row.source_content_version ||
      textFingerprint(current.rawText) !== row.source_text_sha256,
  };
}

function mapJoinedProposal(row: ProposalRow): PersistedCatalogExtractionProposal {
  if (
    row.current_content_version === undefined ||
    row.current_raw_text === undefined ||
    row.current_status === undefined
  ) {
    throw new Error("État courant de la ressource absent.");
  }
  return mapProposal(row, {
    contentVersion: row.current_content_version,
    rawText: row.current_raw_text,
    status: row.current_status,
  });
}

/**
 * Produit hors transaction une proposition déterministe, puis la persiste
 * seulement si propriétaire, version, texte et absence d'archivage sont inchangés.
 */
export async function createCatalogExtractionProposal(
  input: CreateCatalogExtractionProposalInput,
  options: CatalogExtractionPersistenceOptions = {},
): Promise<PersistedCatalogExtractionProposal> {
  const ownerId = requireUuid(input.ownerId, "ownerId");
  const resourceId = requireUuid(input.resourceId, "resourceId");
  const type = requireResourceType(input.resourceType);
  const definition = definitionFor(type);
  const pool = options.pool ?? getPostgresPool();

  const prepared = await withPostgresTransaction(async (client) => {
    const source = await readOwnedResource(client, definition, ownerId, resourceId, "FOR SHARE");
    if (!source) throw new CatalogNotFoundError(definition.label);
    if (source.status === "archived") throw new ArchivedCatalogResourceError(definition.label);
    const existing = await readExactProposal(
      client,
      definition,
      resourceId,
      source.contentVersion,
    );
    return { source, existing };
  }, pool);

  if (prepared.existing) return mapProposal(prepared.existing, prepared.source);

  const proposal = await extractCatalogProposal({ type, rawText: prepared.source.rawText }, {
    mode: "deterministic",
  });
  await options.afterExtraction?.();

  return withPostgresTransaction(async (client) => {
    const current = await readOwnedResource(client, definition, ownerId, resourceId, "FOR UPDATE");
    if (
      !current ||
      current.status === "archived" ||
      current.contentVersion !== prepared.source.contentVersion ||
      current.rawText !== prepared.source.rawText
    ) {
      throw new CatalogExtractionPersistenceConflictError();
    }

    const existing = await readExactProposal(
      client,
      definition,
      resourceId,
      current.contentVersion,
    );
    if (existing) return mapProposal(existing, current);

    const id = randomUUID();
    const fingerprint = textFingerprint(current.rawText);
    const result = await client.query<ProposalRow>(
      `INSERT INTO catalog_extraction_proposals (
         id, ${definition.referenceColumn}, source_content_version,
         source_raw_text, source_text_sha256, contract_version,
         extractor_version, provenance, proposal, evidence, ambiguities
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)
       RETURNING ${PROPOSAL_COLUMNS}`,
      [
        id,
        resourceId,
        current.contentVersion,
        current.rawText,
        fingerprint,
        proposal.contractVersion,
        proposal.extractorVersion,
        proposal.provenance,
        JSON.stringify(proposal),
        JSON.stringify(proposal.evidence),
        JSON.stringify(proposal.ambiguities),
      ],
    );
    return mapProposal(result.rows[0], current);
  }, pool);
}

/** Lecture par identifiant ; propriétaire étranger et identifiant absent donnent `null`. */
export async function getCatalogExtractionProposalById(
  input: ReadCatalogExtractionProposalInput,
  db: SqlExecutor = getPostgresPool(),
): Promise<PersistedCatalogExtractionProposal | null> {
  const ownerId = requireUuid(input.ownerId, "ownerId");
  const proposalId = requireUuid(input.proposalId, "proposalId");
  const result = await db.query<ProposalRow>(
    `SELECT p.id, p.offer_id, p.demand_id, p.source_content_version,
            p.source_raw_text, p.source_text_sha256, p.contract_version,
            p.extractor_version, p.provenance, p.proposal, p.evidence,
            p.ambiguities, p.created_at,
            COALESCE(o.content_version, d.content_version) AS current_content_version,
            COALESCE(o.raw_text, d.raw_text) AS current_raw_text,
            COALESCE(o.status, d.status) AS current_status
       FROM catalog_extraction_proposals AS p
       LEFT JOIN offers AS o ON o.id = p.offer_id
       LEFT JOIN demands AS d ON d.id = p.demand_id
      WHERE p.id = $1
        AND COALESCE(o.owner_id, d.owner_id) = $2`,
    [proposalId, ownerId],
  );
  return result.rowCount ? mapJoinedProposal(result.rows[0]) : null;
}

/** Historique d'une ressource, du plus récent au plus ancien. */
export async function listCatalogExtractionProposals(
  input: ListCatalogExtractionProposalsInput,
  db: SqlExecutor = getPostgresPool(),
): Promise<PersistedCatalogExtractionProposal[]> {
  const ownerId = requireUuid(input.ownerId, "ownerId");
  const resourceId = requireUuid(input.resourceId, "resourceId");
  const definition = definitionFor(requireResourceType(input.resourceType));
  const page = input.pagination ? requireCatalogPagination(input.pagination) : null;
  const values: unknown[] = [resourceId, ownerId];
  let limitClause = "";
  if (page) {
    values.push(page.limit, page.offset);
    limitClause = "LIMIT $3 OFFSET $4";
  }
  const result = await db.query<ProposalRow>(
    `SELECT p.id, p.offer_id, p.demand_id, p.source_content_version,
            p.source_raw_text, p.source_text_sha256, p.contract_version,
            p.extractor_version, p.provenance, p.proposal, p.evidence,
            p.ambiguities, p.created_at,
            resource.content_version AS current_content_version,
            resource.raw_text AS current_raw_text,
            resource.status AS current_status
       FROM catalog_extraction_proposals AS p
       JOIN ${definition.table} AS resource
         ON resource.id = p.${definition.referenceColumn}
      WHERE p.${definition.referenceColumn} = $1
        AND resource.owner_id = $2
      ORDER BY p.source_content_version DESC, p.created_at DESC, p.id DESC
      ${limitClause}`,
    values,
  );
  return result.rows.map(mapJoinedProposal);
}
