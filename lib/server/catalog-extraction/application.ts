import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  ArchivedCatalogResourceError,
  CatalogNotFoundError,
  StaleContentVersionError,
} from "../catalog/errors";
import type { Money } from "../catalog/types";
import { requireUuid, requireVersion } from "../catalog/validation";
import { getPostgresPool, type SqlExecutor, withPostgresTransaction } from "../postgres/client";
import {
  CatalogExtractionApplicationConflictError,
  CatalogExtractionApplicationValidationError,
  CatalogExtractionProposalAttachmentError,
  StaleCatalogExtractionProposalError,
} from "./errors";
import { invalidateMatchesForDemand, invalidateMatchesForOffer } from "../matching/persistence";
import { recordOfferMutation, recordDemandMutation } from "../matching/outbox";
import { OFFER_COLUMNS, DEMAND_COLUMNS, mapOffer, mapDemand, type OfferRow, type DemandRow } from "../catalog/shared";
import type {
  CatalogDemandProposedFields,
  CatalogExtractionProposal,
  CatalogExtractionType,
  CatalogOfferProposedFields,
  ProposedAttribute,
  ProposedCriterion,
} from "./types";

export interface CatalogExtractionApplicationSelection {
  /** Liste des champs de premier niveau à appliquer (ex: ["category", "brand", "model", "price"]) */
  fields?: string[];
  /** Clés spécifiques d'attributs à appliquer (ex: ["storage_capacity", "color"]) */
  attributeKeys?: string[];
}

export type CatalogExtractionApplicationSelectionInput =
  | CatalogExtractionApplicationSelection
  | string[];

export interface ApplyCatalogExtractionProposalInput {
  ownerId: string;
  resourceType: CatalogExtractionType;
  resourceId: string;
  proposalId: string;
  expectedContentVersion: number;
  selection: CatalogExtractionApplicationSelectionInput;
  idempotencyKey: string;
}

export interface CatalogExtractionApplicationReceipt {
  id: string;
  idempotencyKey: string;
  ownerId: string;
  resourceType: CatalogExtractionType;
  resourceId: string;
  proposalId: string;
  expectedContentVersion: number;
  versionBefore: number;
  versionAfter: number;
  selectedFields: CatalogExtractionApplicationSelection;
  changes: Record<string, unknown>;
  appliedAt: Date;
}

export interface CatalogExtractionApplicationOptions {
  pool?: Pool;
  /** Crochet pour synchroniser des tests concurrents sous verrou */
  beforeUpdate?: (client: PoolClient) => Promise<void>;
}

interface NormalizedSelection {
  fields: string[];
  attributeKeys: string[];
}

interface ApplicationRow extends QueryResultRow {
  id: string;
  idempotency_key: string;
  owner_id: string;
  resource_type: CatalogExtractionType;
  offer_id: string | null;
  demand_id: string | null;
  proposal_id: string;
  expected_content_version: number;
  version_before: number;
  version_after: number;
  selected_fields: CatalogExtractionApplicationSelection;
  changes: Record<string, unknown>;
  request_hash: string;
  applied_at: Date;
}

interface ResourceRow extends QueryResultRow {
  id: string;
  owner_id: string;
  status: string;
  content_version: number;
  raw_text: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  attributes: Record<string, unknown> | null;
  condition_text: string | null;
  quantity: number | null;
  unit: string | null;
  location_text: string | null;
  deadline_at: Date | null;
  price_amount?: string | null;
  price_currency?: string | null;
  budget_amount?: string | null;
  budget_currency?: string | null;
  requirements?: unknown[] | null;
  preferences?: unknown[] | null;
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
  provenance: string;
  proposal: CatalogExtractionProposal;
  evidence: unknown[];
  ambiguities: Array<{ field: string; code: string; message: string; evidence: string[] }>;
  created_at: Date;
}

const FORBIDDEN_FIELDS = new Set([
  "rawtext",
  "raw_text",
  "ownerid",
  "owner_id",
  "status",
  "id",
  "contentversion",
  "content_version",
  "createdat",
  "created_at",
  "updatedat",
  "updated_at",
  "archivedat",
  "archived_at",
  "availabilitystatus",
  "availability_status",
  "availabilityconfirmedat",
  "availability_confirmed_at",
  "extractorversion",
  "extractor_version",
  "extractionmetadata",
  "extraction_metadata",
  "extractedat",
  "extracted_at",
]);

const ALLOWED_OFFER_FIELDS = new Set([
  "category",
  "brand",
  "model",
  "variant",
  "condition",
  "quantity",
  "location",
  "deadlineAt",
  "price",
  "attributes",
]);

const ALLOWED_DEMAND_FIELDS = new Set([
  "category",
  "brand",
  "model",
  "variant",
  "condition",
  "quantity",
  "location",
  "deadlineAt",
  "budget",
  "attributes",
  "requirements",
  "preferences",
]);

function requireResourceType(value: CatalogExtractionType): CatalogExtractionType {
  if (value !== "offer" && value !== "demand") {
    throw new TypeError("resourceType doit valoir offer ou demand.");
  }
  return value;
}

export function normalizeIdempotencyKey(raw: string): string {
  if (typeof raw !== "string") {
    throw new CatalogExtractionApplicationValidationError("Clé d'idempotence invalide.");
  }
  if (raw.includes("\0")) {
    throw new CatalogExtractionApplicationValidationError(
      "La clé d'idempotence ne peut pas contenir le caractère NUL.",
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 255) {
    throw new CatalogExtractionApplicationValidationError(
      "La clé d'idempotence doit comporter entre 1 et 255 caractères.",
    );
  }
  return trimmed;
}

function normalizeSelection(
  raw: CatalogExtractionApplicationSelectionInput,
  resourceType: CatalogExtractionType,
): NormalizedSelection {
  if (!raw) {
    throw new CatalogExtractionApplicationValidationError("Une sélection explicite est requise.");
  }

  const fields = new Set<string>();
  const attributeKeys = new Set<string>();

  const processItem = (item: unknown) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new CatalogExtractionApplicationValidationError("Élément de sélection invalide.");
    }
    const trimmed = item.trim();
    const lower = trimmed.toLowerCase();
    if (FORBIDDEN_FIELDS.has(lower)) {
      throw new CatalogExtractionApplicationValidationError(
        `Le champ ${trimmed} est strictement interdit à la modification.`,
      );
    }
    if (trimmed.startsWith("attributes.") || trimmed.startsWith("attributes:")) {
      const key = trimmed.slice(11).trim();
      if (!key) throw new CatalogExtractionApplicationValidationError("Clé d'attribut invalide.");
      attributeKeys.add(key);
    } else {
      fields.add(trimmed);
    }
  };

  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new CatalogExtractionApplicationValidationError("La sélection ne peut pas être vide.");
    }
    for (const item of raw) processItem(item);
  } else if (typeof raw === "object") {
    if (raw.fields !== undefined) {
      if (!Array.isArray(raw.fields)) {
        throw new CatalogExtractionApplicationValidationError("fields doit être un tableau de chaînes.");
      }
      for (const item of raw.fields) processItem(item);
    }
    if (raw.attributeKeys !== undefined) {
      if (!Array.isArray(raw.attributeKeys)) {
        throw new CatalogExtractionApplicationValidationError("attributeKeys doit être un tableau de chaînes.");
      }
      for (const key of raw.attributeKeys) {
        if (typeof key !== "string" || !key.trim()) {
          throw new CatalogExtractionApplicationValidationError("Clé d'attribut invalide dans attributeKeys.");
        }
        attributeKeys.add(key.trim());
      }
    }
  } else {
    throw new CatalogExtractionApplicationValidationError("Format de sélection invalide.");
  }

  if (fields.size === 0 && attributeKeys.size === 0) {
    throw new CatalogExtractionApplicationValidationError("Au moins un champ ou attribut doit être sélectionné.");
  }

  const allowed = resourceType === "offer" ? ALLOWED_OFFER_FIELDS : ALLOWED_DEMAND_FIELDS;
  for (const field of fields) {
    if (!allowed.has(field)) {
      throw new CatalogExtractionApplicationValidationError(
        `Le champ ${field} est inconnu ou non applicable pour une ${resourceType === "offer" ? "offre" : "demande"}.`,
      );
    }
  }

  return {
    fields: Array.from(fields).sort(),
    attributeKeys: Array.from(attributeKeys).sort(),
  };
}

function computeRequestHash(
  resourceType: CatalogExtractionType,
  resourceId: string,
  proposalId: string,
  expectedContentVersion: number,
  selection: NormalizedSelection,
): string {
  const canonical = {
    expectedContentVersion,
    proposalId,
    resourceId,
    resourceType,
    selection: {
      attributeKeys: selection.attributeKeys,
      fields: selection.fields,
    },
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function textFingerprint(rawText: string): string {
  return createHash("sha256").update(rawText, "utf8").digest("hex");
}

function checkAmbiguities(
  ambiguities: ProposalRow["ambiguities"],
  selection: NormalizedSelection,
): void {
  for (const amb of ambiguities) {
    if (selection.fields.includes(amb.field)) {
      throw new CatalogExtractionApplicationValidationError(
        `Le champ ${amb.field} comporte des ambiguïtés non résolues (${amb.code} : ${amb.message}).`,
      );
    }
    if (amb.field === "attributes") {
      if (selection.fields.includes("attributes")) {
        throw new CatalogExtractionApplicationValidationError(
          `Les attributs comportent des ambiguïtés non résolues (${amb.code} : ${amb.message}).`,
        );
      }
      for (const key of selection.attributeKeys) {
        if (
          amb.code.includes(key) ||
          amb.message.includes(key) ||
          (key === "storage_capacity" && amb.code === "multiple_capacities")
        ) {
          throw new CatalogExtractionApplicationValidationError(
            `L'attribut ${key} comporte des ambiguïtés non résolues (${amb.code} : ${amb.message}).`,
          );
        }
      }
    }
  }
}

function mapReceipt(row: ApplicationRow): CatalogExtractionApplicationReceipt {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    ownerId: row.owner_id,
    resourceType: row.resource_type,
    resourceId: row.offer_id ?? row.demand_id!,
    proposalId: row.proposal_id,
    expectedContentVersion: row.expected_content_version,
    versionBefore: row.version_before,
    versionAfter: row.version_after,
    selectedFields: row.selected_fields,
    changes: row.changes,
    appliedAt: row.applied_at,
  };
}

interface ValueConversionResult {
  converted: Record<string, unknown>;
}

function convertSelectedValues(
  proposal: CatalogExtractionProposal,
  selection: NormalizedSelection,
  resourceType: CatalogExtractionType,
  currentAttributes: Record<string, unknown> | null,
): ValueConversionResult {
  const converted: Record<string, unknown> = {};
  const fields = proposal.fields;

  for (const field of selection.fields) {
    if (field === "category") {
      if (fields.category === null || fields.category === undefined) {
        throw new CatalogExtractionApplicationValidationError("La catégorie est absente de la proposition.");
      }
      converted.category = fields.category;
    } else if (field === "brand") {
      if (fields.brand === null || fields.brand === undefined) {
        throw new CatalogExtractionApplicationValidationError("La marque est absente de la proposition.");
      }
      converted.brand = fields.brand;
    } else if (field === "model") {
      if (fields.model === null || fields.model === undefined) {
        throw new CatalogExtractionApplicationValidationError("Le modèle est absent de la proposition.");
      }
      converted.model = fields.model;
    } else if (field === "variant") {
      if (fields.variant === null || fields.variant === undefined) {
        throw new CatalogExtractionApplicationValidationError("La variante est absente de la proposition.");
      }
      converted.variant = fields.variant;
    } else if (field === "condition") {
      if (fields.condition === null || fields.condition === undefined) {
        throw new CatalogExtractionApplicationValidationError("L'état/condition est absent de la proposition.");
      }
      converted.condition = fields.condition;
    } else if (field === "quantity") {
      if (fields.quantity === null || fields.quantity === undefined) {
        throw new CatalogExtractionApplicationValidationError("La quantité est absente de la proposition.");
      }
      if (!Number.isSafeInteger(fields.quantity) || fields.quantity <= 0) {
        throw new CatalogExtractionApplicationValidationError("Quantité invalide dans la proposition.");
      }
      converted.quantity = fields.quantity;
    } else if (field === "location") {
      if (fields.location === null || fields.location === undefined) {
        throw new CatalogExtractionApplicationValidationError("La localisation est absente de la proposition.");
      }
      converted.location = fields.location;
    } else if (field === "deadlineAt") {
      if (fields.deadlineAt === null || fields.deadlineAt === undefined) {
        throw new CatalogExtractionApplicationValidationError("L'échéance est absente de la proposition.");
      }
      const parsedDate = new Date(fields.deadlineAt);
      if (Number.isNaN(parsedDate.getTime())) {
        throw new CatalogExtractionApplicationValidationError("Date d'échéance invalide dans la proposition.");
      }
      converted.deadlineAt = parsedDate;
    } else if (field === "price" && resourceType === "offer") {
      const money = (fields as CatalogOfferProposedFields).price;
      if (!money || money.amount === null || money.amount === undefined) {
        throw new CatalogExtractionApplicationValidationError("Le prix est absent de la proposition.");
      }
      if (money.currency === null || !money.currency.trim()) {
        throw new CatalogExtractionApplicationValidationError(
          "Le prix proposé n'a pas de devise exploitable : conversion implicite en XOF interdite.",
        );
      }
      if (!/^[A-Z]{3}$/.test(money.currency)) {
        throw new CatalogExtractionApplicationValidationError("Devise de prix invalide dans la proposition.");
      }
      if (!Number.isSafeInteger(money.amount) || money.amount < 0) {
        throw new CatalogExtractionApplicationValidationError("Montant de prix invalide dans la proposition.");
      }
      converted.price = { amount: money.amount, currency: money.currency };
    } else if (field === "budget" && resourceType === "demand") {
      const money = (fields as CatalogDemandProposedFields).budget;
      if (!money || money.amount === null || money.amount === undefined) {
        throw new CatalogExtractionApplicationValidationError("Le budget est absent de la proposition.");
      }
      if (money.currency === null || !money.currency.trim()) {
        throw new CatalogExtractionApplicationValidationError(
          "Le budget proposé n'a pas de devise exploitable : conversion implicite en XOF interdite.",
        );
      }
      if (!/^[A-Z]{3}$/.test(money.currency)) {
        throw new CatalogExtractionApplicationValidationError("Devise de budget invalide dans la proposition.");
      }
      if (!Number.isSafeInteger(money.amount) || money.amount < 0) {
        throw new CatalogExtractionApplicationValidationError("Montant de budget invalide dans la proposition.");
      }
      converted.budget = { amount: money.amount, currency: money.currency };
    } else if (field === "requirements" && resourceType === "demand") {
      const reqs = (fields as CatalogDemandProposedFields).requirements;
      if (!reqs || !Array.isArray(reqs)) {
        throw new CatalogExtractionApplicationValidationError("Les exigences sont absentes de la proposition.");
      }
      converted.requirements = reqs.map((r: ProposedCriterion) => ({
        key: r.key,
        operator: r.operator,
        value: r.value,
      }));
    } else if (field === "preferences" && resourceType === "demand") {
      const prefs = (fields as CatalogDemandProposedFields).preferences;
      if (!prefs || !Array.isArray(prefs)) {
        throw new CatalogExtractionApplicationValidationError("Les préférences sont absentes de la proposition.");
      }
      converted.preferences = prefs.map((p: ProposedCriterion) => ({
        key: p.key,
        operator: p.operator,
        value: p.value,
      }));
    }
  }

  // Traitement des attributs : fusion et préservation des unités canoniques et sourceUnit
  const applyAllAttributes = selection.fields.includes("attributes") && selection.attributeKeys.length === 0;
  const hasAttributeKeys = selection.attributeKeys.length > 0;

  if (applyAllAttributes || hasAttributeKeys) {
    const proposedAttributes = fields.attributes;
    if (!proposedAttributes || !Array.isArray(proposedAttributes) || proposedAttributes.length === 0) {
      if (hasAttributeKeys) {
        throw new CatalogExtractionApplicationValidationError(
          `L'attribut ${selection.attributeKeys[0]} est absent de la proposition.`,
        );
      }
      throw new CatalogExtractionApplicationValidationError("Aucun attribut présent dans la proposition.");
    }

    const attributeMap = new Map<string, ProposedAttribute>();
    for (const attr of proposedAttributes) {
      attributeMap.set(attr.key, attr);
    }

    const keysToApply: string[] = applyAllAttributes
      ? proposedAttributes.map((a) => a.key)
      : selection.attributeKeys;

    for (const key of keysToApply) {
      if (!attributeMap.has(key)) {
        throw new CatalogExtractionApplicationValidationError(
          `L'attribut ${key} est absent de la proposition.`,
        );
      }
    }

    // Conserver les clés existantes
    const nextAttributes: Record<string, unknown> = { ...(currentAttributes ?? {}) };
    for (const key of keysToApply) {
      const attr = attributeMap.get(key)!;
      nextAttributes[attr.key] = {
        value: attr.value,
        unit: attr.unit,
        sourceUnit: attr.sourceUnit,
      };
    }
    converted.attributes = nextAttributes;
  }

  return { converted };
}

function isStructuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  return isDeepStrictEqual(a, b);
}

function calculateEffectiveChanges(
  converted: Record<string, unknown>,
  current: ResourceRow,
  resourceType: CatalogExtractionType,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(converted)) {
    if (key === "category" && !isStructuralEqual(current.category, val)) {
      changes.category = val;
    } else if (key === "brand" && !isStructuralEqual(current.brand, val)) {
      changes.brand = val;
    } else if (key === "model" && !isStructuralEqual(current.model, val)) {
      changes.model = val;
    } else if (key === "variant" && !isStructuralEqual(current.variant, val)) {
      changes.variant = val;
    } else if (key === "condition" && !isStructuralEqual(current.condition_text, val)) {
      changes.condition = val;
    } else if (key === "quantity" && !isStructuralEqual(current.quantity, val)) {
      changes.quantity = val;
    } else if (key === "location" && !isStructuralEqual(current.location_text, val)) {
      changes.location = val;
    } else if (key === "deadlineAt") {
      const currentDate = current.deadline_at ? new Date(current.deadline_at) : null;
      if (!isStructuralEqual(currentDate, val)) {
        changes.deadlineAt = (val as Date).toISOString();
      }
    } else if (key === "price" && resourceType === "offer") {
      const currentPrice: Money | null =
        current.price_amount !== null && current.price_amount !== undefined && current.price_currency
          ? { amount: Number(current.price_amount), currency: current.price_currency }
          : null;
      if (!isStructuralEqual(currentPrice, val)) {
        changes.price = val;
      }
    } else if (key === "budget" && resourceType === "demand") {
      const currentBudget: Money | null =
        current.budget_amount !== null && current.budget_amount !== undefined && current.budget_currency
          ? { amount: Number(current.budget_amount), currency: current.budget_currency }
          : null;
      if (!isStructuralEqual(currentBudget, val)) {
        changes.budget = val;
      }
    } else if (key === "requirements" && resourceType === "demand") {
      if (!isStructuralEqual(current.requirements ?? null, val)) {
        changes.requirements = val;
      }
    } else if (key === "preferences" && resourceType === "demand") {
      if (!isStructuralEqual(current.preferences ?? null, val)) {
        changes.preferences = val;
      }
    } else if (key === "attributes") {
      if (!isStructuralEqual(current.attributes ?? null, val)) {
        changes.attributes = val;
      }
    }
  }

  return changes;
}

/**
 * Applique atomiquement une sélection explicite de champs d'une proposition
 * persistée à son offre ou demande dans PostgreSQL.
 */
export async function applyCatalogExtractionProposal(
  input: ApplyCatalogExtractionProposalInput,
  options: CatalogExtractionApplicationOptions = {},
): Promise<CatalogExtractionApplicationReceipt> {
  const ownerId = requireUuid(input.ownerId, "ownerId");
  const resourceId = requireUuid(input.resourceId, "resourceId");
  const proposalId = requireUuid(input.proposalId, "proposalId");
  const expectedVersion = requireVersion(input.expectedContentVersion, "expectedContentVersion");
  const resourceType = requireResourceType(input.resourceType);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const selection = normalizeSelection(input.selection, resourceType);
  const requestHash = computeRequestHash(
    resourceType,
    resourceId,
    proposalId,
    expectedVersion,
    selection,
  );

  const table = resourceType === "offer" ? "offers" : "demands";
  const entityLabel = resourceType === "offer" ? "offre" : "demande";
  const pool = options.pool ?? getPostgresPool();

  return withPostgresTransaction(async (client) => {
    // 0. Sérialisation PostgreSQL par (ownerId, idempotencyKey) avant de décider qu'aucun reçu n'existe
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [ownerId, idempotencyKey]);

    // 1. Contrôle d'idempotence préalable sous transaction
    const existingReceiptResult = await client.query<ApplicationRow>(
      `SELECT id, idempotency_key, owner_id, resource_type, offer_id, demand_id,
              proposal_id, expected_content_version, version_before, version_after,
              selected_fields, changes, request_hash, applied_at
         FROM catalog_extraction_applications
        WHERE owner_id = $1 AND idempotency_key = $2`,
      [ownerId, idempotencyKey],
    );

    if (existingReceiptResult.rowCount) {
      const existing = existingReceiptResult.rows[0];
      if (existing.request_hash === requestHash) {
        return mapReceipt(existing);
      }
      throw new CatalogExtractionApplicationConflictError();
    }

    // 2. Verrouillage exclusif de la ressource sous transaction
    const resourceResult = await client.query<ResourceRow>(
      `SELECT * FROM ${table} WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
      [resourceId, ownerId],
    );

    if (!resourceResult.rowCount) {
      throw new CatalogNotFoundError(entityLabel);
    }

    const currentResource = resourceResult.rows[0];

    // Contrôles de statut et version optimiste
    if (currentResource.status === "archived") {
      throw new ArchivedCatalogResourceError(entityLabel);
    }
    if (currentResource.content_version !== expectedVersion) {
      throw new StaleContentVersionError(entityLabel, expectedVersion, currentResource.content_version);
    }

    // 3. Lecture et contrôle de la proposition d'extraction
    const proposalResult = await client.query<ProposalRow>(
      `SELECT id, offer_id, demand_id, source_content_version, source_raw_text,
              source_text_sha256, contract_version, extractor_version, provenance,
              proposal, evidence, ambiguities, created_at
         FROM catalog_extraction_proposals
        WHERE id = $1`,
      [proposalId],
    );

    if (!proposalResult.rowCount) {
      throw new CatalogExtractionProposalAttachmentError();
    }

    const proposalRow = proposalResult.rows[0];

    // Rattachement exact à la ressource
    const attachedId = resourceType === "offer" ? proposalRow.offer_id : proposalRow.demand_id;
    if (attachedId !== resourceId) {
      throw new CatalogExtractionProposalAttachmentError();
    }

    // Contrôle d'obsolescence sous verrou (version ET texte brut)
    if (
      currentResource.content_version !== proposalRow.source_content_version ||
      currentResource.raw_text !== proposalRow.source_raw_text ||
      textFingerprint(currentResource.raw_text) !== proposalRow.source_text_sha256
    ) {
      throw new StaleCatalogExtractionProposalError();
    }

    // Contrôle des ambiguïtés
    checkAmbiguities(proposalRow.ambiguities, selection);

    // 4. Conversion et validation des valeurs sélectionnées
    const { converted } = convertSelectedValues(
      proposalRow.proposal,
      selection,
      resourceType,
      currentResource.attributes,
    );

    // 5. Calcul des changements effectifs
    const effectiveChanges = calculateEffectiveChanges(converted, currentResource, resourceType);
    const hasEffectiveChanges = Object.keys(effectiveChanges).length > 0;

    // Crochet de synchronisation pour tests de concurrence
    if (options.beforeUpdate) {
      await options.beforeUpdate(client);
    }

    const versionBefore = currentResource.content_version;
    const versionAfter = hasEffectiveChanges ? versionBefore + 1 : versionBefore;

    // 6. Mise à jour du catalogue seulement si un changement effectif existe
    if (hasEffectiveChanges) {
      const assignments: string[] = [];
      const values: unknown[] = [resourceId, ownerId, expectedVersion];

      const addAssignment = (col: string, val: unknown) => {
        values.push(val);
        assignments.push(`${col} = $${values.length}`);
      };

      if (Object.hasOwn(effectiveChanges, "category")) {
        addAssignment("category", effectiveChanges.category);
      }
      if (Object.hasOwn(effectiveChanges, "brand")) {
        addAssignment("brand", effectiveChanges.brand);
      }
      if (Object.hasOwn(effectiveChanges, "model")) {
        addAssignment("model", effectiveChanges.model);
      }
      if (Object.hasOwn(effectiveChanges, "variant")) {
        addAssignment("variant", effectiveChanges.variant);
      }
      if (Object.hasOwn(effectiveChanges, "condition")) {
        addAssignment("condition_text", effectiveChanges.condition);
      }
      if (Object.hasOwn(effectiveChanges, "quantity")) {
        addAssignment("quantity", effectiveChanges.quantity);
      }
      if (Object.hasOwn(effectiveChanges, "location")) {
        addAssignment("location_text", effectiveChanges.location);
      }
      if (Object.hasOwn(effectiveChanges, "deadlineAt")) {
        addAssignment("deadline_at", effectiveChanges.deadlineAt);
      }
      if (Object.hasOwn(effectiveChanges, "attributes")) {
        addAssignment("attributes", JSON.stringify(effectiveChanges.attributes));
      }
      if (Object.hasOwn(effectiveChanges, "price") && resourceType === "offer") {
        const p = effectiveChanges.price as Money;
        addAssignment("price_amount", p.amount);
        addAssignment("price_currency", p.currency);
      }
      if (Object.hasOwn(effectiveChanges, "budget") && resourceType === "demand") {
        const b = effectiveChanges.budget as Money;
        addAssignment("budget_amount", b.amount);
        addAssignment("budget_currency", b.currency);
      }
      if (Object.hasOwn(effectiveChanges, "requirements") && resourceType === "demand") {
        addAssignment("requirements", JSON.stringify(effectiveChanges.requirements));
      }
      if (Object.hasOwn(effectiveChanges, "preferences") && resourceType === "demand") {
        addAssignment("preferences", JSON.stringify(effectiveChanges.preferences));
      }

      assignments.push("content_version = content_version + 1", "updated_at = CURRENT_TIMESTAMP");

      await client.query(
        `UPDATE ${table}
            SET ${assignments.join(", ")}
          WHERE id = $1 AND owner_id = $2 AND content_version = $3 AND status <> 'archived'`,
        values,
      );

      if (resourceType === "offer") {
        await invalidateMatchesForOffer(client, resourceId, "offer_updated");
        const updated = await client.query<OfferRow>(`SELECT ${OFFER_COLUMNS} FROM offers WHERE id = $1`, [resourceId]);
        const offer = mapOffer(updated.rows[0]);
        await recordOfferMutation(client, offer, offer);
      } else {
        await invalidateMatchesForDemand(client, resourceId, "demand_updated");
        const updated = await client.query<DemandRow>(`SELECT ${DEMAND_COLUMNS} FROM demands WHERE id = $1`, [resourceId]);
        const demand = mapDemand(updated.rows[0]);
        await recordDemandMutation(client, demand, demand);
      }
    }

    // 7. Enregistrement durable du reçu d'application
    const receiptId = randomUUID();
    const offerId = resourceType === "offer" ? resourceId : null;
    const demandId = resourceType === "demand" ? resourceId : null;

    const receiptResult = await client.query<ApplicationRow>(
      `INSERT INTO catalog_extraction_applications (
         id, idempotency_key, owner_id, resource_type, offer_id, demand_id,
         proposal_id, expected_content_version, version_before, version_after,
         selected_fields, changes, request_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
       RETURNING id, idempotency_key, owner_id, resource_type, offer_id, demand_id,
                 proposal_id, expected_content_version, version_before, version_after,
                 selected_fields, changes, request_hash, applied_at`,
      [
        receiptId,
        idempotencyKey,
        ownerId,
        resourceType,
        offerId,
        demandId,
        proposalId,
        expectedVersion,
        versionBefore,
        versionAfter,
        JSON.stringify(selection),
        JSON.stringify(effectiveChanges),
        requestHash,
      ],
    );

    return mapReceipt(receiptResult.rows[0]);
  }, pool);
}

/**
 * Lecture d'un reçu d'application par son identifiant unique.
 */
export async function getCatalogExtractionApplicationById(
  ownerId: string,
  receiptId: string,
  db: SqlExecutor = getPostgresPool(),
): Promise<CatalogExtractionApplicationReceipt | null> {
  const result = await db.query<ApplicationRow>(
    `SELECT id, idempotency_key, owner_id, resource_type, offer_id, demand_id,
            proposal_id, expected_content_version, version_before, version_after,
            selected_fields, changes, request_hash, applied_at
       FROM catalog_extraction_applications
      WHERE id = $1 AND owner_id = $2`,
    [requireUuid(receiptId, "receiptId"), requireUuid(ownerId, "ownerId")],
  );
  return result.rowCount ? mapReceipt(result.rows[0]) : null;
}

/**
 * Lecture d'un reçu d'application par sa clé d'idempotence.
 */
export async function getCatalogExtractionApplicationByIdempotencyKey(
  ownerId: string,
  idempotencyKey: string,
  db: SqlExecutor = getPostgresPool(),
): Promise<CatalogExtractionApplicationReceipt | null> {
  const result = await db.query<ApplicationRow>(
    `SELECT id, idempotency_key, owner_id, resource_type, offer_id, demand_id,
            proposal_id, expected_content_version, version_before, version_after,
            selected_fields, changes, request_hash, applied_at
       FROM catalog_extraction_applications
      WHERE owner_id = $1 AND idempotency_key = $2`,
    [requireUuid(ownerId, "ownerId"), normalizeIdempotencyKey(idempotencyKey)],
  );
  return result.rowCount ? mapReceipt(result.rows[0]) : null;
}

/**
 * Liste l'historique des applications pour une ressource donnée.
 */
export async function listCatalogExtractionApplications(
  ownerId: string,
  resourceType: CatalogExtractionType,
  resourceId: string,
  db: SqlExecutor = getPostgresPool(),
): Promise<CatalogExtractionApplicationReceipt[]> {
  const column = requireResourceType(resourceType) === "offer" ? "offer_id" : "demand_id";
  const result = await db.query<ApplicationRow>(
    `SELECT id, idempotency_key, owner_id, resource_type, offer_id, demand_id,
            proposal_id, expected_content_version, version_before, version_after,
            selected_fields, changes, request_hash, applied_at
       FROM catalog_extraction_applications
      WHERE owner_id = $1 AND ${column} = $2
      ORDER BY applied_at DESC, id DESC`,
    [requireUuid(ownerId, "ownerId"), requireUuid(resourceId, "resourceId")],
  );
  return result.rows.map(mapReceipt);
}
