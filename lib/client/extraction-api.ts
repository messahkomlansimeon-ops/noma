/**
 * Couche cliente des propositions d'extraction du catalogue : module partagé navigateur (aucun import serveur), mêmes règles que `shares-api.ts` : fetch même origine, JSON, toute erreur
 * devient une `ApiError { status, code }` construite UNIQUEMENT depuis le corps `{ error: { code, message } }` du serveur (ou un code fixe), réponses relues champ par champ (liste blanche).
 * Contrat : lib/server/catalog-extraction/http.ts (`catalog-extraction/v1`). Voir CATALOG-EXTRACTION-HTTP.md.
 *
 * Une proposition est LUE dans le texte que le propriétaire a écrit lui-même ; rien n'est modifié tant qu'il n'a pas coché des champs et appuyé sur « Appliquer ». Les valeurs appliquées
 * viennent de la proposition enregistrée par le serveur, jamais du corps de la requête (seulement les noms des champs choisis).
 */

import { API_ABORTED, API_INVALID_ID, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, isUuid, type RequestOptions } from "./api";

export const EXTRACTION_CONTRACT_VERSION = "catalog-extraction/v1";

export type ExtractionKind = "offers" | "demands";

export interface ExtractionMoney {
  amount: number;
  /** `null` : le texte ne donne aucune devise ; le serveur refuse d'appliquer un montant sans devise. */
  currency: string | null;
}

export interface ExtractionAttribute {
  key: string;
  value: string | number | boolean;
  unit: string | null;
  sourceUnit: string | null;
}

export interface ExtractionCriterion {
  key: string;
  operator: "includes" | "excludes" | "equals";
  value: string;
}

/** Les champs proposés ; `null` = rien trouvé dans le texte. `price` n'existe que pour une offre, `budget`, `requirements` et `preferences` que pour un besoin. */
export interface ExtractionFields {
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  attributes: ExtractionAttribute[] | null;
  condition: string | null;
  quantity: number | null;
  location: string | null;
  deadlineAt: string | null;
  price?: ExtractionMoney | null;
  budget?: ExtractionMoney | null;
  requirements?: ExtractionCriterion[] | null;
  preferences?: ExtractionCriterion[] | null;
}

export interface ExtractionEvidence {
  field: string;
  quote: string;
}

export interface ExtractionAmbiguity {
  field: string;
  code: string;
  message: string;
  evidence: string[];
}

export interface ExtractionProposal {
  id: string;
  resourceType: "offer" | "demand";
  resourceId: string;
  sourceContentVersion: number;
  /** Vrai quand le texte ou la version de la fiche a changé depuis l'analyse : il faut analyser à nouveau. */
  isStale: boolean;
  createdAt: string;
  fields: ExtractionFields;
  evidence: ExtractionEvidence[];
  ambiguities: ExtractionAmbiguity[];
}

export interface ExtractionSelection {
  fields: string[];
  attributeKeys: string[];
}

export interface ExtractionReceipt {
  proposalId: string;
  versionBefore: number;
  versionAfter: number;
  /** Les noms des champs réellement modifiés (jamais leurs valeurs). */
  changedFields: string[];
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isIso = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const isText = (value: unknown, max = 2000): value is string => typeof value === "string" && value.length <= max;
const nullableText = (value: unknown, max = 200): value is string | null => value === null || isText(value, max);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function fixedError(status: number, code: string): ApiError {
  const messages: Record<string, string> = {
    [API_NETWORK_ERROR]: "Connexion au serveur impossible.",
    [API_INVALID_RESPONSE]: "Réponse du serveur inattendue.",
    [API_ABORTED]: "Requête interrompue.",
    [API_INVALID_ID]: "Identifiant invalide.",
  };
  return new ApiError(status, code, messages[code] ?? messages[API_INVALID_RESPONSE]);
}

function need(status: number, condition: boolean): void {
  if (!condition) throw fixedError(status, API_INVALID_RESPONSE);
}

function money(value: unknown): ExtractionMoney | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || typeof value.amount !== "number" || !Number.isSafeInteger(value.amount) || value.amount < 0) return undefined;
  if (value.currency !== null && !(typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency))) return undefined;
  return { amount: value.amount, currency: value.currency as string | null };
}

function attributes(value: unknown): ExtractionAttribute[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 50) return undefined;
  const out: ExtractionAttribute[] = [];
  for (const item of value) {
    if (!isObject(item) || !isText(item.key, 80) || item.key.length === 0) return undefined;
    if (!(typeof item.value === "boolean" || (typeof item.value === "number" && Number.isFinite(item.value)) || isText(item.value, 200))) return undefined;
    if (!nullableText(item.unit, 40) || !nullableText(item.sourceUnit, 40)) return undefined;
    out.push({ key: item.key, value: item.value as string | number | boolean, unit: item.unit as string | null, sourceUnit: item.sourceUnit as string | null });
  }
  return out;
}

function criteria(value: unknown): ExtractionCriterion[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 50) return undefined;
  const out: ExtractionCriterion[] = [];
  for (const item of value) {
    if (!isObject(item) || !isText(item.key, 80) || !isText(item.value, 200)) return undefined;
    if (item.operator !== "includes" && item.operator !== "excludes" && item.operator !== "equals") return undefined;
    out.push({ key: item.key, operator: item.operator, value: item.value });
  }
  return out;
}

function parseFields(value: unknown, type: "offer" | "demand"): ExtractionFields | undefined {
  if (!isObject(value)) return undefined;
  const attrs = attributes(value.attributes);
  if (attrs === undefined) return undefined;
  if (!nullableText(value.category) || !nullableText(value.brand) || !nullableText(value.model) || !nullableText(value.variant) || !nullableText(value.condition) || !nullableText(value.location)) return undefined;
  if (!(value.quantity === null || (typeof value.quantity === "number" && Number.isSafeInteger(value.quantity) && value.quantity > 0))) return undefined;
  if (!(value.deadlineAt === null || isIso(value.deadlineAt))) return undefined;
  const fields: ExtractionFields = {
    category: value.category as string | null,
    brand: value.brand as string | null,
    model: value.model as string | null,
    variant: value.variant as string | null,
    attributes: attrs,
    condition: value.condition as string | null,
    quantity: value.quantity as number | null,
    location: value.location as string | null,
    deadlineAt: value.deadlineAt as string | null,
  };
  if (type === "offer") {
    const price = money(value.price);
    if (price === undefined) return undefined;
    fields.price = price;
  } else {
    const budget = money(value.budget);
    const requirements = criteria(value.requirements);
    const preferences = criteria(value.preferences);
    if (budget === undefined || requirements === undefined || preferences === undefined) return undefined;
    fields.budget = budget;
    fields.requirements = requirements;
    fields.preferences = preferences;
  }
  return fields;
}

function parseProposal(value: unknown): ExtractionProposal | undefined {
  if (!isObject(value) || !isObject(value.proposal)) return undefined;
  if (value.contractVersion !== EXTRACTION_CONTRACT_VERSION) return undefined;
  if (typeof value.id !== "string" || !isUuid(value.id) || typeof value.resourceId !== "string" || !isUuid(value.resourceId)) return undefined;
  if (value.resourceType !== "offer" && value.resourceType !== "demand") return undefined;
  if (typeof value.sourceContentVersion !== "number" || !Number.isSafeInteger(value.sourceContentVersion) || value.sourceContentVersion < 1) return undefined;
  if (typeof value.isStale !== "boolean" || !isIso(value.createdAt)) return undefined;
  const fields = parseFields(value.proposal.fields, value.resourceType);
  if (!fields || !Array.isArray(value.evidence) || !Array.isArray(value.ambiguities) || value.evidence.length > 100 || value.ambiguities.length > 100) return undefined;
  const evidence: ExtractionEvidence[] = [];
  for (const item of value.evidence) {
    if (!isObject(item) || !isText(item.field, 80) || !isText(item.quote, 400)) return undefined;
    evidence.push({ field: item.field, quote: item.quote });
  }
  const ambiguities: ExtractionAmbiguity[] = [];
  for (const item of value.ambiguities) {
    if (!isObject(item) || !isText(item.field, 80) || !isText(item.code, 80) || !isText(item.message, 400) || !Array.isArray(item.evidence) || item.evidence.length > 20 || !item.evidence.every((quote) => isText(quote, 400))) return undefined;
    ambiguities.push({ field: item.field, code: item.code, message: item.message, evidence: item.evidence as string[] });
  }
  return {
    id: value.id,
    resourceType: value.resourceType,
    resourceId: value.resourceId,
    sourceContentVersion: value.sourceContentVersion,
    isStale: value.isStale,
    createdAt: value.createdAt as string,
    fields,
    evidence,
    ambiguities,
  };
}

export interface ExtractionClientOptions {
  /** fetch injecté (tests) ; par défaut le fetch global, résolu à chaque appel. */
  fetch?: typeof fetch;
}

export function createExtractionClient(options: ExtractionClientOptions = {}) {
  async function send(method: "GET" | "POST", path: string, body?: unknown, requestOptions: RequestOptions = {}): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const init: RequestInit = { method, headers, credentials: "same-origin", cache: "no-store", signal: requestOptions.signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(path, init);
    } catch {
      throw fixedError(0, requestOptions.signal?.aborted ? API_ABORTED : API_NETWORK_ERROR);
    }
    let json: unknown = undefined;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      // Le message du serveur n'est jamais affiché tel quel : seul le code compte (voir `describeExtractionError`).
      if (isObject(json) && isObject(json.error) && typeof json.error.code === "string" && ERROR_CODE.test(json.error.code)) {
        throw new ApiError(response.status, json.error.code, "Erreur du serveur.");
      }
      throw fixedError(response.status, API_INVALID_RESPONSE);
    }
    return { status: response.status, json };
  }

  const id = (value: string): string => {
    if (!isUuid(value)) throw fixedError(0, API_INVALID_ID);
    return value;
  };
  const base = (kind: ExtractionKind, resourceId: string): string => `/api/${kind}/${id(resourceId)}/extraction-proposals`;
  const expectedType = (kind: ExtractionKind): "offer" | "demand" => (kind === "offers" ? "offer" : "demand");

  /** Une proposition relue champ par champ, et qui doit bien porter sur CETTE fiche et CE type de fiche. */
  function single(status: number, kind: ExtractionKind, resourceId: string, raw: unknown): ExtractionProposal {
    const parsed = parseProposal(raw);
    need(status, parsed !== undefined && parsed.resourceType === expectedType(kind) && parsed.resourceId === resourceId);
    return parsed as ExtractionProposal;
  }

  return {
    /** L'historique, la plus récente analyse d'abord (lecture seule : rien n'est calculé). */
    async list(kind: ExtractionKind, resourceId: string, requestOptions?: RequestOptions): Promise<ExtractionProposal[]> {
      const { status, json } = await send("GET", `${base(kind, resourceId)}?limit=5`, undefined, requestOptions);
      need(status, isObject(json) && Array.isArray(json.extractionProposals) && json.extractionProposals.length <= 100);
      return ((json as Json).extractionProposals as unknown[]).map((item) => single(status, kind, resourceId, item));
    },
    /** Analyse le texte de la fiche (ou renvoie l'analyse déjà faite pour cette version du texte). Ne modifie jamais la fiche. */
    async propose(kind: ExtractionKind, resourceId: string, requestOptions?: RequestOptions): Promise<ExtractionProposal> {
      const { status, json } = await send("POST", base(kind, resourceId), {}, requestOptions);
      need(status, isObject(json));
      return single(status, kind, resourceId, (json as Json).extractionProposal);
    },
    /** Applique les champs choisis. `idempotencyKey` : la même clé rejouée renvoie le même reçu, sans second effet. */
    async apply(
      kind: ExtractionKind,
      resourceId: string,
      proposal: Pick<ExtractionProposal, "id" | "sourceContentVersion">,
      selection: ExtractionSelection,
      idempotencyKey: string,
      requestOptions?: RequestOptions,
    ): Promise<ExtractionReceipt> {
      const selected: { fields?: string[]; attributeKeys?: string[] } = {};
      if (selection.fields.length > 0) selected.fields = [...selection.fields];
      if (selection.attributeKeys.length > 0) selected.attributeKeys = [...selection.attributeKeys];
      const { status, json } = await send(
        "POST",
        `${base(kind, resourceId)}/${id(proposal.id)}/apply`,
        { expectedContentVersion: proposal.sourceContentVersion, selection: selected, idempotencyKey },
        requestOptions,
      );
      need(status, isObject(json) && isObject(json.applicationReceipt));
      const receipt = (json as Json).applicationReceipt as Json;
      need(status, receipt.proposalId === proposal.id && isCount(receipt.versionBefore) && isCount(receipt.versionAfter) && isObject(receipt.changes));
      return {
        proposalId: receipt.proposalId as string,
        versionBefore: receipt.versionBefore as number,
        versionAfter: receipt.versionAfter as number,
        changedFields: Object.keys(receipt.changes as Json).slice(0, 50),
      };
    },
  };
}

export type ExtractionClient = ReturnType<typeof createExtractionClient>;

/** Client du navigateur : fetch global, même origine. */
export const extraction: ExtractionClient = createExtractionClient();
