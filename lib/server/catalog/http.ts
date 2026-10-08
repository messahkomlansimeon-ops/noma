import "server-only";

import type { Pool } from "pg";
import { AUTH_SESSION_COOKIE } from "../auth/http";
import { resolveSession } from "../auth/sessions";
import type { AuthClock } from "../auth/types";
import {
  checkPostOrigin,
  noStoreJsonResponse,
  readJsonBodyCapped,
  readSingleCookie,
} from "../http/protection";
import {
  ArchivedCatalogResourceError,
  CatalogAttributeKeyError,
  CatalogNotFoundError,
  CatalogOwnershipError,
  CatalogPhoneNumberError,
  CatalogStatusTransitionError,
  CatalogValidationError,
  OfferLimitError,
  StaleContentVersionError,
} from "./errors";
import {
  activateDemand,
  archiveDemand,
  createDemand,
  getDemandById,
  listDemandsByOwner,
  satisfyDemand,
  updateDemand,
} from "./demands";
import {
  archiveOffer,
  createOffer,
  getOfferById,
  listOffersByOwner,
  pauseOffer,
  publishOffer,
  updateOffer,
} from "./offers";
import type {
  AvailabilityStatus,
  CatalogContentChanges,
  CatalogContentInput,
  CatalogPagination,
  CreateDemandInput,
  CreateOfferInput,
  DemandRecord,
  JsonObject,
  JsonValue,
  Money,
  OfferRecord,
  UpdateDemandInput,
  UpdateOfferInput,
} from "./types";
import {
  optionalJsonArray,
  optionalJsonObject,
  optionalMoney,
  optionalQuantity,
  optionalText,
  requiredText,
  requireVersion,
} from "./validation";

export const CATALOG_HTTP_BODY_MAX_BYTES = 32 * 1_024;

/** Refus de publication au-delà de la limite d'annonces en ligne du plan (lot PRO1). */
export const OFFER_LIMIT_MESSAGE = "Vous avez atteint le nombre maximal d'annonces en ligne de votre offre. Mettez une annonce en pause ou passez à l'offre Pro.";

type Environment = Record<string, string | undefined>;
type PublicCatalogRecord = OfferRecord | DemandRecord;

export interface CatalogHttpDependencies {
  pool?: Pool;
  now?: AuthClock;
  env?: Environment;
  beforeUpdate?: () => Promise<void>;
}

export interface CatalogResourceHttpHandlers {
  list(request: Request): Promise<Response>;
  create(request: Request): Promise<Response>;
  read(request: Request, id: string): Promise<Response>;
  update(request: Request, id: string): Promise<Response>;
  archive(request: Request, id: string): Promise<Response>;
}

export interface OfferHttpHandlers extends CatalogResourceHttpHandlers {
  publish(request: Request, id: string): Promise<Response>;
  pause(request: Request, id: string): Promise<Response>;
}

export interface DemandHttpHandlers extends CatalogResourceHttpHandlers {
  activate(request: Request, id: string): Promise<Response>;
  satisfy(request: Request, id: string): Promise<Response>;
}

export interface CatalogHttpHandlers {
  offers: OfferHttpHandlers;
  demands: DemandHttpHandlers;
}

const COMMON_FIELDS = [
  "rawText",
  "category",
  "brand",
  "model",
  "variant",
  "attributes",
  "condition",
  "quantity",
  "unit",
  "location",
  "deadlineAt",
] as const;
const OFFER_FIELDS = [...COMMON_FIELDS, "price", "availabilityStatus"] as const;
const DEMAND_FIELDS = [...COMMON_FIELDS, "budget", "requirements", "preferences"] as const;
const AVAILABILITY = new Set<AvailabilityStatus>(["available", "reserved", "unavailable"]);
const STRICT_ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function catalogError(status: number, code: string, message: string): Response {
  return noStoreJsonResponse(status, { error: { code, message } });
}

function unauthorized(): Response {
  return catalogError(401, "authentication_required", "Authentification requise.");
}

function invalidRequest(): Response {
  return catalogError(400, "invalid_request", "Requête catalogue invalide.");
}

function serviceUnavailable(): Response {
  return catalogError(503, "catalog_unavailable", "Le catalogue est temporairement indisponible.");
}

function mapCatalogError(error: unknown): Response {
  // Message FIXE et clair (jamais le texte saisi) : un numéro de téléphone dans l'annonce est refusé (lots D1 et D3) ; le champ concerné est nommé (liste fermée de noms).
  if (error instanceof CatalogPhoneNumberError) {
    return noStoreJsonResponse(400, { error: { code: "phone_number_in_offer", message: error.message, ...(error.field === null ? {} : { field: error.field }) } });
  }
  // Un nom d'attribut hors de [a-z_] (lot D3) : refus explicite, sans répéter le nom saisi.
  if (error instanceof CatalogAttributeKeyError) return catalogError(400, "invalid_attribute_key", error.message);
  // Lot PRO1 : la limite d'annonces EN LIGNE du plan est atteinte (texte fixe, jamais le nombre ni une donnée de la base).
  if (error instanceof OfferLimitError) return catalogError(409, "offer_limit_reached", OFFER_LIMIT_MESSAGE);
  if (error instanceof CatalogValidationError) return invalidRequest();
  if (error instanceof CatalogNotFoundError || error instanceof CatalogOwnershipError) {
    return catalogError(404, "resource_not_found", "Ressource introuvable.");
  }
  if (error instanceof StaleContentVersionError) {
    return catalogError(409, "content_version_conflict", "Version de contenu obsolète.");
  }
  if (error instanceof ArchivedCatalogResourceError) {
    return catalogError(409, "resource_archived", "Ressource archivée non modifiable.");
  }
  if (error instanceof CatalogStatusTransitionError) {
    return catalogError(409, "status_transition_conflict", "Transition de statut non autorisée.");
  }
  return serviceUnavailable();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireAllowedObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new CatalogValidationError("Champs catalogue invalides.");
  }
  return value;
}

function strictIsoDate(value: unknown, field: string): Date | null {
  if (value === null) return null;
  if (typeof value !== "string" || !STRICT_ISO_UTC.test(value)) {
    throw new CatalogValidationError(`${field} doit être une date ISO UTC stricte.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CatalogValidationError(`${field} doit être une date ISO UTC stricte.`);
  }
  const canonical = value.includes(".")
    ? parsed.toISOString()
    : parsed.toISOString().replace(".000Z", "Z");
  if (canonical !== value) {
    throw new CatalogValidationError(`${field} doit être une date ISO UTC stricte.`);
  }
  return parsed;
}

function parseMoney(value: unknown, field: string): Money | null {
  if (value === null) return null;
  const money = requireAllowedObject(value, ["amount", "currency"]);
  if (
    !Object.hasOwn(money, "amount") ||
    !Object.hasOwn(money, "currency") ||
    typeof money.amount !== "number" ||
    typeof money.currency !== "string" ||
    !/^[A-Z]{3}$/.test(money.currency)
  ) {
    throw new CatalogValidationError(`${field} invalide.`);
  }
  return optionalMoney({ amount: money.amount, currency: money.currency }, field);
}

function parseAvailability(value: unknown): AvailabilityStatus | null {
  if (value === null) return null;
  if (typeof value !== "string" || !AVAILABILITY.has(value as AvailabilityStatus)) {
    throw new CatalogValidationError("availabilityStatus invalide.");
  }
  return value as AvailabilityStatus;
}

function parseCommonFields(
  body: Record<string, unknown>,
  requireRawText: boolean,
): CatalogContentInput | CatalogContentChanges {
  const parsed: CatalogContentChanges = {};
  if (requireRawText && !Object.hasOwn(body, "rawText")) {
    throw new CatalogValidationError("rawText est requis.");
  }
  if (Object.hasOwn(body, "rawText")) {
    if (typeof body.rawText !== "string") throw new CatalogValidationError("rawText invalide.");
    parsed.rawText = requiredText(body.rawText, "rawText");
  }
  for (const field of ["category", "brand", "model", "variant", "condition", "unit", "location"] as const) {
    if (Object.hasOwn(body, field)) {
      const value = body[field];
      if (value !== null && typeof value !== "string") {
        throw new CatalogValidationError(`${field} invalide.`);
      }
      parsed[field] = optionalText(value as string | null, field);
    }
  }
  if (Object.hasOwn(body, "attributes")) {
    parsed.attributes = optionalJsonObject(body.attributes as JsonObject | null, "attributes");
  }
  if (Object.hasOwn(body, "quantity")) {
    if (body.quantity !== null && typeof body.quantity !== "number") {
      throw new CatalogValidationError("quantity invalide.");
    }
    parsed.quantity = optionalQuantity(body.quantity as number | null);
  }
  if (Object.hasOwn(body, "deadlineAt")) {
    parsed.deadlineAt = strictIsoDate(body.deadlineAt, "deadlineAt");
  }
  return parsed;
}

function parseOfferCreate(value: unknown): Omit<CreateOfferInput, "ownerId"> {
  const body = requireAllowedObject(value, OFFER_FIELDS);
  const parsed = parseCommonFields(body, true) as CatalogContentInput;
  return {
    ...parsed,
    ...(Object.hasOwn(body, "price") ? { price: parseMoney(body.price, "price") } : {}),
    ...(Object.hasOwn(body, "availabilityStatus")
      ? { availabilityStatus: parseAvailability(body.availabilityStatus) }
      : {}),
  };
}

function parseDemandCreate(value: unknown): Omit<CreateDemandInput, "ownerId"> {
  const body = requireAllowedObject(value, DEMAND_FIELDS);
  const parsed = parseCommonFields(body, true) as CatalogContentInput;
  return {
    ...parsed,
    ...(Object.hasOwn(body, "budget") ? { budget: parseMoney(body.budget, "budget") } : {}),
    ...(Object.hasOwn(body, "requirements")
      ? { requirements: optionalJsonArray(body.requirements as JsonValue[] | null, "requirements") }
      : {}),
    ...(Object.hasOwn(body, "preferences")
      ? { preferences: optionalJsonArray(body.preferences as JsonValue[] | null, "preferences") }
      : {}),
  };
}

function parseOfferUpdate(value: unknown): {
  expectedContentVersion: number;
  changes: UpdateOfferInput["changes"];
} {
  const body = requireAllowedObject(value, ["expectedContentVersion", ...OFFER_FIELDS]);
  const expectedContentVersion = requireVersion(
    body.expectedContentVersion as number,
    "expectedContentVersion",
  );
  const changes = parseCommonFields(body, false) as UpdateOfferInput["changes"];
  if (Object.hasOwn(body, "price")) changes.price = parseMoney(body.price, "price");
  if (Object.hasOwn(body, "availabilityStatus")) {
    changes.availabilityStatus = parseAvailability(body.availabilityStatus);
  }
  if (Object.keys(changes).length === 0) {
    throw new CatalogValidationError("Aucune modification fournie.");
  }
  return { expectedContentVersion, changes };
}

function parseDemandUpdate(value: unknown): {
  expectedContentVersion: number;
  changes: UpdateDemandInput["changes"];
} {
  const body = requireAllowedObject(value, ["expectedContentVersion", ...DEMAND_FIELDS]);
  const expectedContentVersion = requireVersion(
    body.expectedContentVersion as number,
    "expectedContentVersion",
  );
  const changes = parseCommonFields(body, false) as UpdateDemandInput["changes"];
  if (Object.hasOwn(body, "budget")) changes.budget = parseMoney(body.budget, "budget");
  if (Object.hasOwn(body, "requirements")) {
    changes.requirements = optionalJsonArray(
      body.requirements as JsonValue[] | null,
      "requirements",
    );
  }
  if (Object.hasOwn(body, "preferences")) {
    changes.preferences = optionalJsonArray(
      body.preferences as JsonValue[] | null,
      "preferences",
    );
  }
  if (Object.keys(changes).length === 0) {
    throw new CatalogValidationError("Aucune modification fournie.");
  }
  return { expectedContentVersion, changes };
}

function parseExpectedContentVersion(value: unknown): number {
  const body = requireAllowedObject(value, ["expectedContentVersion"]);
  if (!Object.hasOwn(body, "expectedContentVersion")) {
    throw new CatalogValidationError("expectedContentVersion est requis.");
  }
  return requireVersion(body.expectedContentVersion as number, "expectedContentVersion");
}

const parseArchive = parseExpectedContentVersion;

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

function publicRecord(record: PublicCatalogRecord): Record<string, unknown> {
  const common = {
    id: record.id,
    status: record.status,
    rawText: record.rawText,
    category: record.category,
    brand: record.brand,
    model: record.model,
    variant: record.variant,
    attributes: record.attributes,
    condition: record.condition,
    quantity: record.quantity,
    unit: record.unit,
    location: record.location,
    deadlineAt: record.deadlineAt?.toISOString() ?? null,
    contentVersion: record.contentVersion,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    archivedAt: record.archivedAt?.toISOString() ?? null,
  };
  if ("price" in record) {
    return {
      ...common,
      price: record.price,
      availabilityStatus: record.availabilityStatus,
    };
  }
  return {
    ...common,
    budget: record.budget,
    requirements: record.requirements,
    preferences: record.preferences,
  };
}

interface ResourceDefinition<RecordType extends PublicCatalogRecord, CreateInput, UpdateChanges> {
  singularKey: "offer" | "demand";
  pluralKey: "offers" | "demands";
  parseCreate(value: unknown): CreateInput;
  parseUpdate(value: unknown): { expectedContentVersion: number; changes: UpdateChanges };
  create(ownerId: string, input: CreateInput): Promise<RecordType>;
  list(ownerId: string, pagination: CatalogPagination): Promise<RecordType[]>;
  read(ownerId: string, id: string): Promise<RecordType | null>;
  update(
    ownerId: string,
    id: string,
    expectedContentVersion: number,
    changes: UpdateChanges,
  ): Promise<RecordType>;
  archive(ownerId: string, id: string, expectedContentVersion: number): Promise<RecordType>;
}

export function createCatalogHttpHandlers(
  dependencies: CatalogHttpDependencies = {},
): CatalogHttpHandlers {
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
        response: catalogError(403, "invalid_origin", "Origine de la requête non autorisée."),
      };
    }
    return authenticated;
  }

  async function readBody(request: Request): Promise<
    | { ok: true; value: unknown }
    | { ok: false; response: Response }
  > {
    const body = await readJsonBodyCapped(request, CATALOG_HTTP_BODY_MAX_BYTES);
    if (body.ok) return body;
    return {
      ok: false,
      response: body.reason === "too_large"
        ? catalogError(413, "payload_too_large", "Requête trop volumineuse.")
        : invalidRequest(),
    };
  }

  function resourceHandlers<
    RecordType extends PublicCatalogRecord,
    CreateInput,
    UpdateChanges,
  >(
    definition: ResourceDefinition<RecordType, CreateInput, UpdateChanges>,
  ): CatalogResourceHttpHandlers {
    return {
      async list(request) {
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        try {
          const pagination = parsePagination(request);
          const records = await definition.list(authenticated.ownerId, pagination);
          return noStoreJsonResponse(200, {
            [definition.pluralKey]: records.map(publicRecord),
            pagination,
          });
        } catch (error) {
          return mapCatalogError(error);
        }
      },

      async create(request) {
        const authenticated = await mutationOwner(request);
        if (!authenticated.ok) return authenticated.response;
        const body = await readBody(request);
        if (!body.ok) return body.response;
        try {
          const record = await definition.create(
            authenticated.ownerId,
            definition.parseCreate(body.value),
          );
          return noStoreJsonResponse(201, { [definition.singularKey]: publicRecord(record) });
        } catch (error) {
          return mapCatalogError(error);
        }
      },

      async read(request, id) {
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        try {
          const record = await definition.read(authenticated.ownerId, id);
          return record
            ? noStoreJsonResponse(200, { [definition.singularKey]: publicRecord(record) })
            : catalogError(404, "resource_not_found", "Ressource introuvable.");
        } catch (error) {
          return mapCatalogError(error);
        }
      },

      async update(request, id) {
        const authenticated = await mutationOwner(request);
        if (!authenticated.ok) return authenticated.response;
        const body = await readBody(request);
        if (!body.ok) return body.response;
        try {
          const parsed = definition.parseUpdate(body.value);
          const record = await definition.update(
            authenticated.ownerId,
            id,
            parsed.expectedContentVersion,
            parsed.changes,
          );
          return noStoreJsonResponse(200, { [definition.singularKey]: publicRecord(record) });
        } catch (error) {
          return mapCatalogError(error);
        }
      },

      async archive(request, id) {
        const authenticated = await mutationOwner(request);
        if (!authenticated.ok) return authenticated.response;
        const body = await readBody(request);
        if (!body.ok) return body.response;
        try {
          const record = await definition.archive(
            authenticated.ownerId,
            id,
            parseArchive(body.value),
          );
          return noStoreJsonResponse(200, { [definition.singularKey]: publicRecord(record) });
        } catch (error) {
          return mapCatalogError(error);
        }
      },
    };
  }

  async function transitionAction<RecordType extends PublicCatalogRecord>(
    request: Request,
    id: string,
    singularKey: "offer" | "demand",
    action: (ownerId: string, id: string, version: number) => Promise<RecordType>,
  ): Promise<Response> {
    const authenticated = await mutationOwner(request);
    if (!authenticated.ok) return authenticated.response;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    try {
      const record = await action(
        authenticated.ownerId,
        id,
        parseExpectedContentVersion(body.value),
      );
      return noStoreJsonResponse(200, { [singularKey]: publicRecord(record) });
    } catch (error) {
      return mapCatalogError(error);
    }
  }

  const baseOffers = resourceHandlers<OfferRecord, Omit<CreateOfferInput, "ownerId">, UpdateOfferInput["changes"]>({
    singularKey: "offer",
    pluralKey: "offers",
    parseCreate: parseOfferCreate,
    parseUpdate: parseOfferUpdate,
    create: (ownerId, input) => createOffer({ ...input, ownerId }, dependencies.pool),
    list: (ownerId, pagination) => listOffersByOwner(ownerId, dependencies.pool, pagination),
    read: (ownerId, id) => getOfferById(ownerId, id, dependencies.pool),
    update: (ownerId, id, expectedContentVersion, changes) => updateOffer({
      id,
      ownerId,
      expectedContentVersion,
      changes,
    }, dependencies.pool),
    archive: (ownerId, id, expectedContentVersion) => archiveOffer(
      ownerId,
      id,
      expectedContentVersion,
      dependencies.pool,
    ),
  });

  const baseDemands = resourceHandlers<DemandRecord, Omit<CreateDemandInput, "ownerId">, UpdateDemandInput["changes"]>({
    singularKey: "demand",
    pluralKey: "demands",
    parseCreate: parseDemandCreate,
    parseUpdate: parseDemandUpdate,
    create: (ownerId, input) => createDemand({ ...input, ownerId }, dependencies.pool),
    list: (ownerId, pagination) => listDemandsByOwner(ownerId, dependencies.pool, pagination),
    read: (ownerId, id) => getDemandById(ownerId, id, dependencies.pool),
    update: (ownerId, id, expectedContentVersion, changes) => updateDemand({
      id,
      ownerId,
      expectedContentVersion,
      changes,
    }, dependencies.pool),
    archive: (ownerId, id, expectedContentVersion) => archiveDemand(
      ownerId,
      id,
      expectedContentVersion,
      dependencies.pool,
    ),
  });

  const transitionOptions = dependencies.beforeUpdate
    ? { beforeUpdate: dependencies.beforeUpdate }
    : undefined;

  return {
    offers: {
      ...baseOffers,
      publish: (request, id) => transitionAction(
        request,
        id,
        "offer",
        (ownerId, id, version) => publishOffer(ownerId, id, version, dependencies.pool, transitionOptions),
      ),
      pause: (request, id) => transitionAction(
        request,
        id,
        "offer",
        (ownerId, id, version) => pauseOffer(ownerId, id, version, dependencies.pool, transitionOptions),
      ),
    },
    demands: {
      ...baseDemands,
      activate: (request, id) => transitionAction(
        request,
        id,
        "demand",
        (ownerId, id, version) => activateDemand(ownerId, id, version, dependencies.pool, transitionOptions),
      ),
      satisfy: (request, id) => transitionAction(
        request,
        id,
        "demand",
        (ownerId, id, version) => satisfyDemand(ownerId, id, version, dependencies.pool, transitionOptions),
      ),
    },
  };
}

export const defaultCatalogHttpHandlers = createCatalogHttpHandlers();
