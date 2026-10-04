import "server-only";

import type { Pool, PoolClient } from "pg";
import { AUTH_SESSION_COOKIE } from "../auth/http";
import { resolveSession } from "../auth/sessions";
import type { AuthClock } from "../auth/types";
import { getDemandById } from "../catalog/demands";
import {
  ArchivedCatalogResourceError,
  CatalogNotFoundError,
  CatalogOwnershipError,
  CatalogValidationError,
  StaleContentVersionError,
} from "../catalog/errors";
import { getOfferById } from "../catalog/offers";
import type { CatalogPagination } from "../catalog/types";
import { requireUuid } from "../catalog/validation";
import {
  checkPostOrigin,
  noStoreJsonResponse,
  readBodyCapped,
  readSingleCookie,
} from "../http/protection";
import {
  applyCatalogExtractionProposal,
  normalizeIdempotencyKey,
  type CatalogExtractionApplicationReceipt,
  type CatalogExtractionApplicationSelection,
} from "./application";
import {
  CatalogExtractionApplicationConflictError,
  CatalogExtractionApplicationValidationError,
  CatalogExtractionProposalAttachmentError,
  CatalogExtractionValidationError,
  StaleCatalogExtractionProposalError,
} from "./errors";
import {
  createCatalogExtractionProposal,
  listCatalogExtractionProposals,
  CatalogExtractionPersistenceConflictError,
  type PersistedCatalogExtractionProposal,
} from "./persistence";
import type { CatalogExtractionType } from "./types";

export const CATALOG_EXTRACTION_HTTP_BODY_MAX_BYTES = 32 * 1_024;

type Environment = Record<string, string | undefined>;

export interface CatalogExtractionHttpDependencies {
  pool?: Pool;
  now?: AuthClock;
  env?: Environment;
  beforeUpdate?: (client: PoolClient) => Promise<void>;
}

export interface CatalogExtractionResourceHttpHandlers {
  list(request: Request, id: string): Promise<Response>;
  create(request: Request, id: string): Promise<Response>;
  apply(request: Request, id: string, proposalId: string): Promise<Response>;
}

export interface CatalogExtractionHttpHandlers {
  offers: CatalogExtractionResourceHttpHandlers;
  demands: CatalogExtractionResourceHttpHandlers;
}

function extractionError(status: number, code: string, message: string): Response {
  return noStoreJsonResponse(status, { error: { code, message } });
}

function unauthorized(): Response {
  return extractionError(401, "authentication_required", "Authentification requise.");
}

function invalidRequest(message = "Requête d'extraction catalogue invalide."): Response {
  return extractionError(400, "invalid_request", message);
}

function serviceUnavailable(): Response {
  return extractionError(
    503,
    "catalog_extraction_unavailable",
    "Le service d'extraction est temporairement indisponible.",
  );
}

function mapExtractionError(error: unknown): Response {
  if (
    error instanceof CatalogNotFoundError ||
    error instanceof CatalogOwnershipError ||
    error instanceof CatalogExtractionProposalAttachmentError
  ) {
    return extractionError(404, "resource_not_found", "Ressource introuvable.");
  }
  if (error instanceof CatalogExtractionApplicationValidationError) {
    return invalidRequest(error.message);
  }
  if (error instanceof CatalogExtractionValidationError) {
    return extractionError(400, "extraction_validation_error", error.message);
  }
  if (error instanceof CatalogValidationError) {
    return invalidRequest(error.message);
  }
  if (error instanceof ArchivedCatalogResourceError) {
    return extractionError(409, "resource_archived", "Ressource archivée non modifiable.");
  }
  if (error instanceof StaleContentVersionError) {
    return extractionError(409, "stale_version", error.message);
  }
  if (error instanceof StaleCatalogExtractionProposalError) {
    return extractionError(409, "stale_proposal", error.message);
  }
  if (error instanceof CatalogExtractionApplicationConflictError) {
    return extractionError(409, "conflict", error.message);
  }
  if (error instanceof CatalogExtractionPersistenceConflictError) {
    return extractionError(409, "extraction_conflict", error.message);
  }
  return serviceUnavailable();
}

function parsePagination(request: Request): CatalogPagination {
  const parameters = new URL(request.url).searchParams;
  if ([...parameters.keys()].some((key) => key !== "limit" && key !== "offset")) {
    throw new CatalogValidationError("Pagination invalide.");
  }
  if (parameters.getAll("limit").length > 1 || parameters.getAll("offset").length > 1) {
    throw new CatalogValidationError("Pagination invalide.");
  }
  const rawLimit = parameters.get("limit") ?? "20";
  const rawOffset = parameters.get("offset") ?? "0";
  if (!/^[0-9]+$/.test(rawLimit) || !/^[0-9]+$/.test(rawOffset)) {
    throw new CatalogValidationError("Pagination invalide.");
  }
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new CatalogValidationError("Pagination invalide.");
  }
  return { limit, offset };
}

function publicExtractionProposal(record: PersistedCatalogExtractionProposal): Record<string, unknown> {
  return {
    id: record.id,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    sourceContentVersion: record.sourceContentVersion,
    sourceRawText: record.sourceRawText,
    sourceTextSha256: record.sourceTextSha256,
    contractVersion: record.contractVersion,
    extractorVersion: record.extractorVersion,
    provenance: record.provenance,
    proposal: record.proposal,
    evidence: record.evidence,
    ambiguities: record.ambiguities,
    createdAt: record.createdAt.toISOString(),
    isStale: record.isStale,
  };
}

function publicApplicationReceipt(record: CatalogExtractionApplicationReceipt): Record<string, unknown> {
  return {
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    ownerId: record.ownerId,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    proposalId: record.proposalId,
    expectedContentVersion: record.expectedContentVersion,
    versionBefore: record.versionBefore,
    versionAfter: record.versionAfter,
    selectedFields: record.selectedFields,
    changes: record.changes,
    appliedAt: record.appliedAt.toISOString(),
  };
}

export function createCatalogExtractionHttpHandlers(
  dependencies: CatalogExtractionHttpDependencies = {},
): CatalogExtractionHttpHandlers {
  const environment = (): Environment => dependencies.env ?? process.env;

  async function authenticate(request: Request): Promise<
    | { ok: true; ownerId: string }
    | { ok: false; response: Response }
  > {
    const token = readSingleCookie(request, AUTH_SESSION_COOKIE);
    if (!token) return { ok: false, response: unauthorized() };
    try {
      const session = await resolveSession(token, {
        pool: dependencies.pool,
        now: dependencies.now,
      });
      return session
        ? { ok: true, ownerId: session.userId }
        : { ok: false, response: unauthorized() };
    } catch {
      return { ok: false, response: serviceUnavailable() };
    }
  }

  async function mutationOwner(request: Request): Promise<
    | { ok: true; ownerId: string }
    | { ok: false; response: Response }
  > {
    const authenticated = await authenticate(request);
    if (!authenticated.ok) return authenticated;
    const origin = checkPostOrigin(request, environment().NOMA_AUTH_ORIGIN);
    if (origin === "unconfigured") return { ok: false, response: serviceUnavailable() };
    if (origin === "forbidden") {
      return {
        ok: false,
        response: extractionError(403, "invalid_origin", "Origine de la requête non autorisée."),
      };
    }
    return authenticated;
  }

  async function readPostEmptyBody(request: Request): Promise<
    | { ok: true }
    | { ok: false; response: Response }
  > {
    const body = await readBodyCapped(request, CATALOG_EXTRACTION_HTTP_BODY_MAX_BYTES);
    if (!body.ok) {
      return {
        ok: false,
        response:
          body.reason === "too_large"
            ? extractionError(413, "payload_too_large", "Requête trop volumineuse.")
            : invalidRequest("Format JSON attendu pour le corps de la requête."),
      };
    }

    if (body.text.length === 0) {
      return { ok: true };
    }

    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return {
        ok: false,
        response: invalidRequest("Format JSON attendu pour le corps de la requête."),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return {
        ok: false,
        response: invalidRequest("Format JSON attendu pour le corps de la requête."),
      };
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length > 0
    ) {
      return {
        ok: false,
        response: invalidRequest("Aucun champ métier n'est accepté dans le corps."),
      };
    }

    return { ok: true };
  }

  interface ValidatedApplyPayload {
    expectedContentVersion: number;
    selection: CatalogExtractionApplicationSelection;
    idempotencyKey: string;
  }

  const ALLOWED_APPLY_BODY_KEYS = new Set([
    "expectedContentVersion",
    "selection",
    "idempotencyKey",
  ]);

  const ALLOWED_SELECTION_KEYS = new Set([
    "fields",
    "attributeKeys",
  ]);

  async function readApplyBody(
    request: Request,
  ): Promise<
    | { ok: true; body: ValidatedApplyPayload }
    | { ok: false; response: Response }
  > {
    const read = await readBodyCapped(request, CATALOG_EXTRACTION_HTTP_BODY_MAX_BYTES);
    if (!read.ok) {
      return {
        ok: false,
        response:
          read.reason === "too_large"
            ? extractionError(413, "payload_too_large", "Requête trop volumineuse.")
            : invalidRequest("Format JSON attendu pour le corps de la requête."),
      };
    }

    if (read.text.length === 0) {
      return {
        ok: false,
        response: invalidRequest("Corps de la requête requis."),
      };
    }

    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return {
        ok: false,
        response: invalidRequest("Format JSON attendu pour le corps de la requête."),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return {
        ok: false,
        response: invalidRequest("Format JSON attendu pour le corps de la requête."),
      };
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        response: invalidRequest("Le corps de la requête doit être un objet JSON."),
      };
    }

    const keys = Object.keys(parsed);
    for (const key of keys) {
      if (!ALLOWED_APPLY_BODY_KEYS.has(key)) {
        return {
          ok: false,
          response: invalidRequest(`Propriété inconnue ou non autorisée dans le corps : ${key}.`),
        };
      }
    }

    const record = parsed as Record<string, unknown>;

    // 1. expectedContentVersion
    if (record.expectedContentVersion === undefined || record.expectedContentVersion === null) {
      return {
        ok: false,
        response: invalidRequest("expectedContentVersion est requis."),
      };
    }
    if (
      typeof record.expectedContentVersion !== "number" ||
      !Number.isSafeInteger(record.expectedContentVersion) ||
      record.expectedContentVersion <= 0
    ) {
      return {
        ok: false,
        response: invalidRequest("expectedContentVersion doit être un entier strictement positif."),
      };
    }

    // 2. idempotencyKey
    if (record.idempotencyKey === undefined || record.idempotencyKey === null) {
      return {
        ok: false,
        response: invalidRequest("idempotencyKey est requise."),
      };
    }
    if (typeof record.idempotencyKey !== "string") {
      return {
        ok: false,
        response: invalidRequest("idempotencyKey doit être une chaîne."),
      };
    }
    let idempotencyKey: string;
    try {
      idempotencyKey = normalizeIdempotencyKey(record.idempotencyKey);
    } catch (error) {
      if (error instanceof CatalogExtractionApplicationValidationError) {
        return {
          ok: false,
          response: invalidRequest(error.message),
        };
      }
      throw error;
    }

    // 3. selection
    if (record.selection === undefined || record.selection === null) {
      return {
        ok: false,
        response: invalidRequest("selection est requise."),
      };
    }
    if (typeof record.selection !== "object" || Array.isArray(record.selection)) {
      return {
        ok: false,
        response: invalidRequest("selection doit être un objet."),
      };
    }

    const selectionRecord = record.selection as Record<string, unknown>;
    const selectionKeys = Object.keys(selectionRecord);
    for (const sk of selectionKeys) {
      if (!ALLOWED_SELECTION_KEYS.has(sk)) {
        return {
          ok: false,
          response: invalidRequest(`Propriété inconnue ou non autorisée dans selection : ${sk}.`),
        };
      }
    }

    let fields: string[] | undefined;
    if (selectionRecord.fields !== undefined) {
      if (!Array.isArray(selectionRecord.fields)) {
        return {
          ok: false,
          response: invalidRequest("selection.fields doit être un tableau."),
        };
      }
      for (const f of selectionRecord.fields) {
        if (typeof f !== "string" || !f.trim()) {
          return {
            ok: false,
            response: invalidRequest("Chaque élément de selection.fields doit être une chaîne non vide."),
          };
        }
      }
      fields = selectionRecord.fields.map((f: string) => f.trim());
    }

    let attributeKeys: string[] | undefined;
    if (selectionRecord.attributeKeys !== undefined) {
      if (!Array.isArray(selectionRecord.attributeKeys)) {
        return {
          ok: false,
          response: invalidRequest("selection.attributeKeys doit être un tableau."),
        };
      }
      for (const k of selectionRecord.attributeKeys) {
        if (typeof k !== "string" || !k.trim()) {
          return {
            ok: false,
            response: invalidRequest("Chaque élément de selection.attributeKeys doit être une chaîne non vide."),
          };
        }
      }
      attributeKeys = selectionRecord.attributeKeys.map((k: string) => k.trim());
    }

    if ((!fields || fields.length === 0) && (!attributeKeys || attributeKeys.length === 0)) {
      return {
        ok: false,
        response: invalidRequest("Au moins un champ ou attribut doit être spécifié dans selection."),
      };
    }

    return {
      ok: true,
      body: {
        expectedContentVersion: record.expectedContentVersion,
        selection: {
          ...(fields ? { fields } : {}),
          ...(attributeKeys ? { attributeKeys } : {}),
        },
        idempotencyKey,
      },
    };
  }

  function resourceHandlers(type: CatalogExtractionType): CatalogExtractionResourceHttpHandlers {
    const isOffer = type === "offer";
    return {
      async list(request: Request, id: string): Promise<Response> {
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        try {
          const resourceId = requireUuid(id, "id");
          const parent = isOffer
            ? await getOfferById(authenticated.ownerId, resourceId, dependencies.pool)
            : await getDemandById(authenticated.ownerId, resourceId, dependencies.pool);
          if (!parent) {
            return extractionError(404, "resource_not_found", "Ressource introuvable.");
          }
          const pagination = parsePagination(request);
          const records = await listCatalogExtractionProposals(
            {
              ownerId: authenticated.ownerId,
              resourceType: type,
              resourceId,
              pagination,
            },
            dependencies.pool,
          );
          const serialized = records.map(publicExtractionProposal);
          return noStoreJsonResponse(200, {
            extractionProposals: serialized,
            proposals: serialized,
            pagination,
          });
        } catch (error) {
          return mapExtractionError(error);
        }
      },

      async create(request: Request, id: string): Promise<Response> {
        const authenticated = await mutationOwner(request);
        if (!authenticated.ok) return authenticated.response;
        const bodyCheck = await readPostEmptyBody(request);
        if (!bodyCheck.ok) return bodyCheck.response;
        try {
          const resourceId = requireUuid(id, "id");
          const proposal = await createCatalogExtractionProposal(
            {
              ownerId: authenticated.ownerId,
              resourceType: type,
              resourceId,
            },
            { pool: dependencies.pool },
          );
          const serialized = publicExtractionProposal(proposal);
          return noStoreJsonResponse(200, {
            extractionProposal: serialized,
            proposal: serialized,
          });
        } catch (error) {
          return mapExtractionError(error);
        }
      },

      async apply(request: Request, id: string, proposalId: string): Promise<Response> {
        const authenticated = await mutationOwner(request);
        if (!authenticated.ok) return authenticated.response;

        let resourceId: string;
        let validatedProposalId: string;
        try {
          resourceId = requireUuid(id, "id");
          validatedProposalId = requireUuid(proposalId, "proposalId");
        } catch (err) {
          return invalidRequest((err as Error).message);
        }

        const bodyCheck = await readApplyBody(request);
        if (!bodyCheck.ok) return bodyCheck.response;

        try {
          const receipt = await applyCatalogExtractionProposal(
            {
              ownerId: authenticated.ownerId,
              resourceType: type,
              resourceId,
              proposalId: validatedProposalId,
              expectedContentVersion: bodyCheck.body.expectedContentVersion,
              selection: bodyCheck.body.selection,
              idempotencyKey: bodyCheck.body.idempotencyKey,
            },
            {
              pool: dependencies.pool,
              beforeUpdate: dependencies.beforeUpdate,
            },
          );

          return noStoreJsonResponse(200, {
            applicationReceipt: publicApplicationReceipt(receipt),
          });
        } catch (error) {
          return mapExtractionError(error);
        }
      },
    };
  }

  return {
    offers: resourceHandlers("offer"),
    demands: resourceHandlers("demand"),
  };
}

export const defaultCatalogExtractionHttpHandlers = createCatalogExtractionHttpHandlers();
