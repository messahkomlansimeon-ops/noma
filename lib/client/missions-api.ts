/**
 * Couche cliente des missions d'achat en volume (lot MV1) : module partagé navigateur (aucun import serveur), mêmes règles que `api.ts` et `social-api.ts` : fetch même origine,
 * JSON, toute erreur devient une `ApiError { status, code }` construite UNIQUEMENT depuis le corps `{ error: { code, message } }` du serveur (ou un code fixe), réponses relues
 * champ par champ (liste blanche : un champ que le serveur ajouterait un jour n'atteint jamais l'écran). Contrat : lib/server/missions/http.ts (`missions/v1`). Voir MISSIONS.md.
 */

import { API_ABORTED, API_INVALID_ID, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, isUuid, type RequestOptions } from "./api";
import {
  MISSIONS_CONTRACT_VERSION,
  MISSION_ACTIONS,
  MISSION_STATUSES,
  SHORTFALL_REASONS,
  SHORTFALL_TEXT,
  checkMissionInput,
  type MissionAction,
  type MissionInput,
  type MissionStatus,
  type ShortfallReason,
} from "../missions-rules";

export { MISSIONS_CONTRACT_VERSION };

export interface MissionSummary {
  id: string;
  status: MissionStatus;
  title: string;
  category: string;
  brand: string;
  model: string;
  variant: string | null;
  condition: string;
  quantity: number;
  unit: string;
  securedQuantity: number;
  pendingQuantity: number;
  unitBudgetXof: number;
  totalBudgetXof: number;
  committedXof: number;
  location: string | null;
  deadlineDays: number;
  deadlineAt: string | null;
  /** Besoin porteur (lancé seulement) : sert à ouvrir une conversation, voir une fiche et déclarer un achat. */
  demandId: string | null;
  coveredQuantity: number | null;
  evaluatedAt: string | null;
  activatedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canActivate: boolean;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
}

export interface MissionOrder {
  id: string;
  status: "proposed" | "confirmed" | "declined" | "cancelled";
  quantity: number;
  unitPriceXof: number;
  offerId: string;
  title: string;
  createdAt: string;
}

export interface MissionDetail {
  mission: MissionSummary;
  orders: MissionOrder[];
}

export interface ProposalLine {
  offerId: string;
  /** « Vendeur 1 » : jamais un identifiant. */
  vendor: string;
  title: string;
  location: string | null;
  quantity: number;
  unitPriceXof: number;
  subtotalXof: number;
  stock: number;
}

/** Un achat déjà engagé pour la mission (commande proposée ou confirmée) : affiché à part, soustrait de la proposition. */
export interface ProposalEngaged {
  orderId: string;
  status: "proposed" | "confirmed";
  vendor: string;
  offerId: string;
  title: string;
  location: string | null;
  quantity: number;
  unitPriceXof: number;
  subtotalXof: number;
}

export type ProposalState = "ready" | "inactive" | "unavailable";

/** Une page de « Mes missions » : les ouvertes d'abord, puis les closes ; `nextCursor` pour la suite. */
export interface MissionsPage {
  missions: MissionSummary[];
  nextCursor: string | null;
}

export interface MissionProposal {
  state: ProposalState;
  /** Les lignes proposées pour le RESTE à acheter. */
  lines: ProposalLine[];
  /** Les achats déjà engagés (proposés ou confirmés). */
  engaged: ProposalEngaged[];
  requestedQuantity: number;
  committedQuantity: number;
  committedXof: number;
  remainingQuantity: number;
  /** Engagé + proposé. */
  coveredQuantity: number;
  coveragePercent: number;
  budgetUsedXof: number;
  budgetRemainingXof: number;
  totalBudgetXof: number;
  unitBudgetXof: number;
  sellerCount: number;
  candidateCount: number;
  reasons: ShortfallReason[];
  readAt: string;
}

// ───────────── relecture des réponses (liste blanche) ─────────────

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isIso = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown, max = 200): value is string => typeof value === "string" && value.length >= 1 && value.length <= max;
const nullableIso = (value: unknown): boolean => value === null || isIso(value);

function fixedError(status: number, code: string): ApiError {
  const messages: Record<string, string> = {
    [API_NETWORK_ERROR]: "Connexion au serveur impossible.",
    [API_INVALID_RESPONSE]: "Réponse du serveur inattendue.",
    [API_ABORTED]: "Requête interrompue.",
    [API_INVALID_ID]: "Identifiant invalide.",
    invalid_argument: "Paramètre invalide.",
  };
  return new ApiError(status, code, messages[code] ?? messages[API_INVALID_RESPONSE]);
}

function bad(status: number): never {
  throw fixedError(status, API_INVALID_RESPONSE);
}

function need(status: number, condition: boolean): void {
  if (!condition) bad(status);
}

function parseMission(status: number, value: unknown): MissionSummary {
  need(
    status,
    isObject(value) && isUuid(value.id) && (MISSION_STATUSES as readonly unknown[]).includes(value.status) && isText(value.title, 200) && isText(value.category, 50) && isText(value.brand, 50) &&
      isText(value.model, 50) && (value.variant === null || isText(value.variant, 50)) && isText(value.condition, 50) && isCount(value.quantity) && value.quantity >= 2 && value.quantity <= 10_000 &&
      isText(value.unit, 20) && isCount(value.securedQuantity) && isCount(value.pendingQuantity) && isCount(value.unitBudgetXof) && isCount(value.totalBudgetXof) && isCount(value.committedXof) &&
      (value.location === null || isText(value.location, 80)) && isCount(value.deadlineDays) && nullableIso(value.deadlineAt) && (value.demandId === null || isUuid(value.demandId)) &&
      (value.coveredQuantity === null || isCount(value.coveredQuantity)) && nullableIso(value.evaluatedAt) && nullableIso(value.activatedAt) && nullableIso(value.closedAt) && isIso(value.createdAt) &&
      isIso(value.updatedAt) && typeof value.canEdit === "boolean" && typeof value.canActivate === "boolean" && typeof value.canPause === "boolean" && typeof value.canResume === "boolean" &&
      typeof value.canCancel === "boolean",
  );
  const m = value as Json;
  return {
    id: m.id as string,
    status: m.status as MissionStatus,
    title: m.title as string,
    category: m.category as string,
    brand: m.brand as string,
    model: m.model as string,
    variant: m.variant as string | null,
    condition: m.condition as string,
    quantity: m.quantity as number,
    unit: m.unit as string,
    securedQuantity: m.securedQuantity as number,
    pendingQuantity: m.pendingQuantity as number,
    unitBudgetXof: m.unitBudgetXof as number,
    totalBudgetXof: m.totalBudgetXof as number,
    committedXof: m.committedXof as number,
    location: m.location as string | null,
    deadlineDays: m.deadlineDays as number,
    deadlineAt: m.deadlineAt as string | null,
    demandId: m.demandId as string | null,
    coveredQuantity: m.coveredQuantity as number | null,
    evaluatedAt: m.evaluatedAt as string | null,
    activatedAt: m.activatedAt as string | null,
    closedAt: m.closedAt as string | null,
    createdAt: m.createdAt as string,
    updatedAt: m.updatedAt as string,
    canEdit: m.canEdit as boolean,
    canActivate: m.canActivate as boolean,
    canPause: m.canPause as boolean,
    canResume: m.canResume as boolean,
    canCancel: m.canCancel as boolean,
  };
}

const ORDER_STATUSES = ["proposed", "confirmed", "declined", "cancelled"] as const;

function parseOrder(status: number, value: unknown): MissionOrder {
  need(
    status,
    isObject(value) && isUuid(value.id) && (ORDER_STATUSES as readonly unknown[]).includes(value.status) && isCount(value.quantity) && value.quantity >= 1 && isCount(value.unitPriceXof) &&
      isUuid(value.offerId) && isText(value.title, 200) && isIso(value.createdAt),
  );
  const o = value as Json;
  return {
    id: o.id as string,
    status: o.status as MissionOrder["status"],
    quantity: o.quantity as number,
    unitPriceXof: o.unitPriceXof as number,
    offerId: o.offerId as string,
    title: o.title as string,
    createdAt: o.createdAt as string,
  };
}

function parseLine(status: number, value: unknown): ProposalLine {
  need(
    status,
    isObject(value) && isUuid(value.offerId) && typeof value.vendor === "string" && /^Vendeur [0-9]{1,2}$/.test(value.vendor) && isText(value.title, 200) && (value.location === null || isText(value.location, 80)) &&
      isCount(value.quantity) && value.quantity >= 1 && isCount(value.unitPriceXof) && isCount(value.subtotalXof) && isCount(value.stock) && value.stock >= 1,
  );
  const l = value as Json;
  return {
    offerId: l.offerId as string,
    vendor: l.vendor as string,
    title: l.title as string,
    location: l.location as string | null,
    quantity: l.quantity as number,
    unitPriceXof: l.unitPriceXof as number,
    subtotalXof: l.subtotalXof as number,
    stock: l.stock as number,
  };
}

function parseEngaged(status: number, value: unknown): ProposalEngaged {
  need(
    status,
    isObject(value) && isUuid(value.orderId) && (value.status === "proposed" || value.status === "confirmed") && typeof value.vendor === "string" && /^Vendeur [0-9]{1,2}$/.test(value.vendor) &&
      isUuid(value.offerId) && isText(value.title, 200) && (value.location === null || isText(value.location, 80)) && isCount(value.quantity) && value.quantity >= 1 && isCount(value.unitPriceXof) &&
      isCount(value.subtotalXof),
  );
  const o = value as Json;
  return {
    orderId: o.orderId as string,
    status: o.status as "proposed" | "confirmed",
    vendor: o.vendor as string,
    offerId: o.offerId as string,
    title: o.title as string,
    location: o.location as string | null,
    quantity: o.quantity as number,
    unitPriceXof: o.unitPriceXof as number,
    subtotalXof: o.subtotalXof as number,
  };
}

function parseProposal(status: number, value: unknown): MissionProposal {
  need(
    status,
    isObject(value) && (value.state === "ready" || value.state === "inactive" || value.state === "unavailable") && Array.isArray(value.lines) && Array.isArray(value.engaged) && isCount(value.requestedQuantity) &&
      isCount(value.committedQuantity) && isCount(value.committedXof) && isCount(value.remainingQuantity) && isCount(value.coveredQuantity) && isCount(value.coveragePercent) && value.coveragePercent <= 100 && isCount(value.budgetUsedXof) && isCount(value.budgetRemainingXof) &&
      isCount(value.totalBudgetXof) && isCount(value.unitBudgetXof) && isCount(value.sellerCount) && isCount(value.candidateCount) && Array.isArray(value.reasons) && isIso(value.readAt),
  );
  const p = value as Json;
  const reasons = (p.reasons as unknown[]).map((entry) => {
    need(status, isObject(entry) && (SHORTFALL_REASONS as readonly unknown[]).includes(entry.code));
    return (entry as Json).code as ShortfallReason;
  });
  return {
    state: p.state as ProposalState,
    lines: (p.lines as unknown[]).map((line) => parseLine(status, line)),
    engaged: (p.engaged as unknown[]).map((order) => parseEngaged(status, order)),
    requestedQuantity: p.requestedQuantity as number,
    committedQuantity: p.committedQuantity as number,
    committedXof: p.committedXof as number,
    remainingQuantity: p.remainingQuantity as number,
    coveredQuantity: p.coveredQuantity as number,
    coveragePercent: p.coveragePercent as number,
    budgetUsedXof: p.budgetUsedXof as number,
    budgetRemainingXof: p.budgetRemainingXof as number,
    totalBudgetXof: p.totalBudgetXof as number,
    unitBudgetXof: p.unitBudgetXof as number,
    sellerCount: p.sellerCount as number,
    candidateCount: p.candidateCount as number,
    reasons,
    readAt: p.readAt as string,
  };
}

// ───────────── client ─────────────

export interface MissionsClientOptions {
  /** fetch injecté (tests) ; par défaut le fetch global, résolu à chaque appel. */
  fetch?: typeof fetch;
}

export function createMissionsClient(options: MissionsClientOptions = {}) {
  async function send(method: "GET" | "POST" | "PUT", path: string, body?: unknown, requestOptions: RequestOptions = {}): Promise<{ status: number; json: unknown }> {
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
      if (isObject(json) && isObject(json.error) && typeof json.error.code === "string" && ERROR_CODE.test(json.error.code) && typeof json.error.message === "string" && json.error.message.length <= 500) {
        throw new ApiError(response.status, json.error.code, json.error.message);
      }
      throw fixedError(response.status, API_INVALID_RESPONSE);
    }
    return { status: response.status, json };
  }

  const id = (value: string): string => {
    if (!isUuid(value)) throw fixedError(0, API_INVALID_ID);
    return value;
  };

  function contract(status: number, json: unknown): Json {
    if (!isObject(json) || json.contractVersion !== MISSIONS_CONTRACT_VERSION) bad(status);
    return json as Json;
  }

  /** Le contenu d'une mission est contrôlé AVANT l'envoi par la même règle que le serveur (aucune requête pour un contenu qui sera refusé). */
  function requireMissionInput(input: MissionInput): MissionInput {
    const checked = checkMissionInput(input);
    if (!checked.ok) throw fixedError(0, "invalid_argument");
    return checked.value;
  }

  return {
    /** « Mes missions » : les ouvertes d'abord, puis les closes ; `cursor` (celui de la page précédente) pour la suite. */
    async list(cursor: string | null = null, requestOptions?: RequestOptions): Promise<MissionsPage> {
      if (cursor !== null && !/^[A-Za-z0-9_-]{1,140}$/.test(cursor)) throw fixedError(0, "invalid_argument");
      const { status, json } = await send("GET", cursor === null ? "/api/missions" : `/api/missions?cursor=${cursor}`, undefined, requestOptions);
      const body = contract(status, json);
      need(status, Array.isArray(body.missions) && (body.nextCursor === null || (typeof body.nextCursor === "string" && /^[A-Za-z0-9_-]{1,140}$/.test(body.nextCursor))));
      return { missions: (body.missions as unknown[]).map((mission) => parseMission(status, mission)), nextCursor: body.nextCursor as string | null };
    },
    /** Crée un brouillon, ou lance la mission tout de suite (`activate`). */
    async create(input: MissionInput, activate = false, requestOptions?: RequestOptions): Promise<MissionSummary> {
      const body = activate ? { ...requireMissionInput(input), activate: true } : requireMissionInput(input);
      const { status, json } = await send("POST", "/api/missions", body, requestOptions);
      return parseMission(status, contract(status, json).mission);
    },
    async get(missionId: string, requestOptions?: RequestOptions): Promise<MissionDetail> {
      const { status, json } = await send("GET", `/api/missions/${id(missionId)}`, undefined, requestOptions);
      const body = contract(status, json);
      need(status, Array.isArray(body.orders));
      return { mission: parseMission(status, body.mission), orders: (body.orders as unknown[]).map((order) => parseOrder(status, order)) };
    },
    /** Modifie un brouillon (la mission entière est renvoyée, recontrôlée par le serveur). */
    async update(missionId: string, input: MissionInput, requestOptions?: RequestOptions): Promise<MissionSummary> {
      const { status, json } = await send("PUT", `/api/missions/${id(missionId)}`, requireMissionInput(input), requestOptions);
      return parseMission(status, contract(status, json).mission);
    },
    async act(missionId: string, action: MissionAction, requestOptions?: RequestOptions): Promise<MissionSummary> {
      if (!(MISSION_ACTIONS as readonly string[]).includes(action)) throw fixedError(0, "invalid_argument");
      const { status, json } = await send("POST", `/api/missions/${id(missionId)}`, { action }, requestOptions);
      return parseMission(status, contract(status, json).mission);
    },
    async proposal(missionId: string, requestOptions?: RequestOptions): Promise<MissionProposal> {
      const { status, json } = await send("GET", `/api/missions/${id(missionId)}/proposal`, undefined, requestOptions);
      const body = contract(status, json);
      need(status, isUuid(body.missionId));
      return parseProposal(status, body.proposal);
    },
  };
}

export type MissionsClient = ReturnType<typeof createMissionsClient>;

/** Client du navigateur : fetch global, même origine. */
export const missions: MissionsClient = createMissionsClient();

// ───────────── messages d'erreur (fixes, en français) ─────────────

export type MissionErrorContext = "list" | "mission" | "form" | "action" | "line";

/** Message FIXE pour l'utilisateur d'après (contexte, statut, code) : jamais le texte d'une exception ni celui du serveur. */
export function describeMissionError(error: unknown, context: MissionErrorContext): string {
  if (!(error instanceof ApiError)) return "Une erreur est survenue. Réessayez dans un instant.";
  if (error.code === API_NETWORK_ERROR) return "Connexion impossible. Vérifiez votre réseau et réessayez.";
  if (error.code === API_ABORTED) return "Requête interrompue.";
  if (error.status === 401) return "Votre session a expiré. Reconnectez-vous pour continuer.";
  if (error.status === 403) return "Requête refusée. Rechargez la page et réessayez.";
  if (error.code === "invalid_argument") return "Paramètre invalide. Rechargez la page.";
  if (error.code === "phone_number_in_mission") return "Pas de numéro de téléphone dans la mission : les vendeurs vous répondront dans la messagerie de noma.";
  if (error.code === "invalid_mission") return "Cette mission n'est pas valide. Vérifiez les champs.";
  if (error.code === "mission_daily_limit") return "Vous avez créé 20 missions aujourd'hui. Réessayez demain.";
  if (error.code === "mission_active_limit") return "Vous avez déjà 5 missions actives : terminez-en ou annulez-en une avant d'en lancer une autre.";
  if (error.code === "mission_not_draft") return "Seul un brouillon se modifie. La page va être actualisée.";
  if (error.code === "mission_state_conflict") return "Cette mission ne peut pas changer d'état de cette façon. La page va être actualisée.";
  if (context === "line") {
    if (error.status === 404) return "Cette annonce n'est plus disponible pour votre mission.";
    if (error.code === "offer_not_available") return "Cette annonce n'est plus disponible.";
    if (error.status === 429) return "Trop de messages ou de conversations aujourd'hui. Réessayez plus tard.";
  }
  if (error.status === 404) return context === "list" ? "Élément introuvable." : "Mission introuvable.";
  if (error.status === 503) return "Le service est temporairement indisponible. Réessayez dans un instant.";
  if (error.status === 400) return "La demande n'est pas valide. Rechargez la page.";
  return "Une erreur est survenue. Réessayez dans un instant.";
}

/** Le texte d'une raison de couverture incomplète (table fixe). */
export function shortfallText(reason: ShortfallReason): string {
  return SHORTFALL_TEXT[reason];
}
