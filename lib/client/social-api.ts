/**
 * Couche cliente des favoris, de la messagerie en direct, des commandes et de l'administration (lot D2) : module partagé navigateur (aucun import serveur), même règles que
 * `api.ts` : fetch même origine, JSON, toute erreur devient une `ApiError { status, code }` construite UNIQUEMENT depuis le corps `{ error: { code, message } }` du serveur
 * (ou un code fixe), réponses relues champ par champ (liste blanche : un champ ajouté un jour par le serveur n'atteint jamais l'écran). Contrats : lib/server/social/http.ts
 * (`favorites/v1`, `conversations/v1`, `orders/v1`, `offer-sales/v1`) et lib/server/admin/http.ts (`admin/v1`). Voir MESSAGERIE.md.
 */

import { API_ABORTED, API_INVALID_ID, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, isUuid, type Money, type RequestOptions } from "./api";
import { checkMessageBody } from "../messages-text";

export const FAVORITES_CONTRACT_VERSION = "favorites/v1";
export const CONVERSATIONS_CONTRACT_VERSION = "conversations/v1";
export const ORDERS_CONTRACT_VERSION = "orders/v1";
export const ORDER_SALES_CONTRACT_VERSION = "offer-sales/v1";
export const ADMIN_CONTRACT_VERSION = "admin/v1";

export type ParticipantRole = "buyer" | "seller";
export type OrderStatus = "proposed" | "confirmed" | "declined" | "cancelled";
export const ORDER_STATUSES: readonly OrderStatus[] = ["proposed", "confirmed", "declined", "cancelled"];
export type OrderAction = "confirm" | "decline" | "cancel";

export interface FavoriteItem {
  offerId: string;
  demandId: string;
  title: string;
  price: Money | null;
  available: boolean;
  openable: boolean;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  role: ParticipantRole;
  title: string;
  demandId: string | null;
  offerId: string;
  available: boolean;
  createdAt: string;
  lastMessage: { body: string; mine: boolean; createdAt: string } | null;
  unreadCount: number;
}

export interface ConversationMessage {
  id: number;
  mine: boolean;
  body: string;
  createdAt: string;
}

export interface ConversationDetail {
  id: string;
  role: ParticipantRole;
  title: string;
  demandId: string | null;
  offerId: string;
  available: boolean;
  order: { id: string; status: OrderStatus } | null;
  canDeclareOrder: boolean;
}

export interface OrderView {
  id: string;
  role: ParticipantRole;
  status: OrderStatus;
  price: { amount: number; currency: "XOF" };
  title: string;
  offerId: string;
  demandId: string | null;
  conversationId: string | null;
  createdAt: string;
  decidedAt: string | null;
  canConfirm: boolean;
  canDecline: boolean;
  canCancel: boolean;
  canMarkDemandSatisfied: boolean;
}

export type SalesCount = { kind: "below"; bound: number } | { kind: "approx"; value: number };

export interface OfferSales {
  confirmed: SalesCount;
  attributedToBoost: SalesCount | null;
  organic: SalesCount | null;
}

export interface AdminSummary {
  accounts: { total: number; active: number; suspended: number };
  offers: { total: number; byStatus: Record<string, number> };
  activeDemands: number;
  confirmedMatches: number;
  activeBoosts: number;
  credits: { circulationXof: number; topupsTodayCount: number; topupsTodayXof: number };
  conversations: { total: number; messagesToday: number };
  orders: { confirmed: number; proposed: number };
  worker: {
    schemaReady: boolean;
    healthy: boolean;
    pendingEvents: number;
    pendingJobs: number;
    runningJobs: number;
    deadLetter: number;
    warnings: Array<{ code: string; message: string }>;
    lastCompletedAt: string | null;
  };
  readAt: string;
}

export interface AdminVendor {
  id: string;
  maskedPhone: string | null;
  offerCount: number;
  publishedCount: number;
  createdAt: string;
  status: "active" | "suspended" | "archived";
  isAdmin: boolean;
}

export interface AdminVendorsPage {
  total: number;
  limit: number;
  offset: number;
  vendors: AdminVendor[];
}

export interface AdminActionEntry {
  id: string;
  action: "suspend_user" | "reactivate_user" | "grant_admin";
  source: "admin_ui" | "command";
  byMaskedPhone: string | null;
  targetMaskedPhone: string | null;
  createdAt: string;
}

export interface AdminBoostSettings {
  key: string;
  slotRatio: number | null;
  minSlots: number | null;
  maxSlots: number | null;
  maxActivePerSeller: number | null;
  maxSellerSlotShare: number | null;
  maxPromotedShare: number | null;
  minRelevance: number | null;
  pricingVersion: number | null;
  baseAmountXof: number | null;
  minAmountXof: number | null;
  maxAmountXof: number | null;
  quoteValiditySeconds: number | null;
}

// ───────────── relecture des réponses (liste blanche) ─────────────

const FIXED_MESSAGES: Record<string, string> = {
  [API_NETWORK_ERROR]: "Connexion au serveur impossible.",
  [API_INVALID_RESPONSE]: "Réponse du serveur inattendue.",
  [API_ABORTED]: "Requête interrompue.",
  [API_INVALID_ID]: "Identifiant invalide.",
  invalid_argument: "Paramètre invalide.",
};

function fixedError(status: number, code: string): ApiError {
  return new ApiError(status, code, FIXED_MESSAGES[code] ?? FIXED_MESSAGES[API_INVALID_RESPONSE]);
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isIso = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown, max = 1_000): value is string => typeof value === "string" && value.length <= max;

function bad(status: number): never {
  throw fixedError(status, API_INVALID_RESPONSE);
}

function need(status: number, condition: boolean): void {
  if (!condition) bad(status);
}

function parseMoney(status: number, value: unknown): Money | null {
  if (value === null) return null;
  if (!isObject(value) || !isCount(value.amount) || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) bad(status);
  return { amount: value.amount as number, currency: value.currency as string };
}

function parseRole(status: number, value: unknown): ParticipantRole {
  need(status, value === "buyer" || value === "seller");
  return value as ParticipantRole;
}

function parseOrderStatus(status: number, value: unknown): OrderStatus {
  need(status, (ORDER_STATUSES as readonly unknown[]).includes(value));
  return value as OrderStatus;
}

function parseFavorite(status: number, value: unknown): FavoriteItem {
  need(status, isObject(value) && isUuid(value.offerId) && isUuid(value.demandId) && isText(value.title, 200) && typeof value.available === "boolean" && typeof value.openable === "boolean" && isIso(value.createdAt));
  const item = value as Json;
  return { offerId: item.offerId as string, demandId: item.demandId as string, title: item.title as string, price: parseMoney(status, item.price), available: item.available as boolean, openable: item.openable as boolean, createdAt: item.createdAt as string };
}

function parseSummary(status: number, value: unknown): ConversationSummary {
  need(status, isObject(value) && isUuid(value.id) && isText(value.title, 200) && (value.demandId === null || isUuid(value.demandId)) && isUuid(value.offerId) && typeof value.available === "boolean" && isIso(value.createdAt) && isCount(value.unreadCount));
  const item = value as Json;
  let lastMessage: ConversationSummary["lastMessage"] = null;
  if (item.lastMessage !== null) {
    const last = item.lastMessage;
    need(status, isObject(last) && isText(last.body, 2_000) && typeof last.mine === "boolean" && isIso(last.createdAt));
    lastMessage = { body: (last as Json).body as string, mine: (last as Json).mine as boolean, createdAt: (last as Json).createdAt as string };
  }
  return {
    id: item.id as string,
    role: parseRole(status, item.role),
    title: item.title as string,
    demandId: item.demandId as string | null,
    offerId: item.offerId as string,
    available: item.available as boolean,
    createdAt: item.createdAt as string,
    lastMessage,
    unreadCount: item.unreadCount as number,
  };
}

function parseMessage(status: number, value: unknown): ConversationMessage {
  need(status, isObject(value) && isCount(value.id) && (value.id as number) >= 1 && typeof value.mine === "boolean" && isText(value.body, 2_000) && isIso(value.createdAt));
  const message = value as Json;
  return { id: message.id as number, mine: message.mine as boolean, body: message.body as string, createdAt: message.createdAt as string };
}

function parseDetail(status: number, value: unknown): ConversationDetail {
  need(status, isObject(value) && isUuid(value.id) && isText(value.title, 200) && (value.demandId === null || isUuid(value.demandId)) && isUuid(value.offerId) && typeof value.available === "boolean" && typeof value.canDeclareOrder === "boolean");
  const detail = value as Json;
  let order: ConversationDetail["order"] = null;
  if (detail.order !== null) {
    need(status, isObject(detail.order) && isUuid((detail.order as Json).id));
    order = { id: (detail.order as Json).id as string, status: parseOrderStatus(status, (detail.order as Json).status) };
  }
  return {
    id: detail.id as string,
    role: parseRole(status, detail.role),
    title: detail.title as string,
    demandId: detail.demandId as string | null,
    offerId: detail.offerId as string,
    available: detail.available as boolean,
    order,
    canDeclareOrder: detail.canDeclareOrder as boolean,
  };
}

function parseOrder(status: number, value: unknown): OrderView {
  need(
    status,
    isObject(value) && isUuid(value.id) && isObject(value.price) && isCount(value.price.amount) && value.price.currency === "XOF" && isText(value.title, 200) && isUuid(value.offerId) &&
      (value.demandId === null || isUuid(value.demandId)) && (value.conversationId === null || isUuid(value.conversationId)) && isIso(value.createdAt) && (value.decidedAt === null || isIso(value.decidedAt)) &&
      typeof value.canConfirm === "boolean" && typeof value.canDecline === "boolean" && typeof value.canCancel === "boolean" && typeof value.canMarkDemandSatisfied === "boolean",
  );
  const order = value as Json;
  return {
    id: order.id as string,
    role: parseRole(status, order.role),
    status: parseOrderStatus(status, order.status),
    price: { amount: (order.price as Json).amount as number, currency: "XOF" },
    title: order.title as string,
    offerId: order.offerId as string,
    demandId: order.demandId as string | null,
    conversationId: order.conversationId as string | null,
    createdAt: order.createdAt as string,
    decidedAt: order.decidedAt as string | null,
    canConfirm: order.canConfirm as boolean,
    canDecline: order.canDecline as boolean,
    canCancel: order.canCancel as boolean,
    canMarkDemandSatisfied: order.canMarkDemandSatisfied as boolean,
  };
}

function parseSalesCount(status: number, value: unknown): SalesCount {
  need(status, isObject(value) && ((value.kind === "below" && isCount(value.bound)) || (value.kind === "approx" && isCount(value.value))));
  const count = value as Json;
  return count.kind === "below" ? { kind: "below", bound: count.bound as number } : { kind: "approx", value: count.value as number };
}

function parseSummaryOfAdmin(status: number, value: unknown): AdminSummary {
  need(
    status,
    isObject(value) && isObject(value.accounts) && isObject(value.offers) && isObject(value.offers.byStatus) && isObject(value.credits) && isObject(value.conversations) && isObject(value.orders) && isObject(value.worker) && isIso(value.readAt) &&
      isCount(value.activeDemands) && isCount(value.confirmedMatches) && isCount(value.activeBoosts),
  );
  const summary = value as Json;
  const accounts = summary.accounts as Json;
  const offers = summary.offers as Json;
  const credits = summary.credits as Json;
  const conversations = summary.conversations as Json;
  const orders = summary.orders as Json;
  const worker = summary.worker as Json;
  need(status, [accounts.total, accounts.active, accounts.suspended, offers.total, credits.circulationXof, credits.topupsTodayCount, credits.topupsTodayXof, conversations.total, conversations.messagesToday, orders.confirmed, orders.proposed, worker.pendingEvents, worker.pendingJobs, worker.runningJobs, worker.deadLetter].every(isCount));
  need(status, typeof worker.schemaReady === "boolean" && typeof worker.healthy === "boolean" && Array.isArray(worker.warnings) && (worker.lastCompletedAt === null || isIso(worker.lastCompletedAt)));
  const byStatus: Record<string, number> = {};
  for (const [key, count] of Object.entries(offers.byStatus as Json)) {
    need(status, /^[a-z_]{1,20}$/.test(key) && isCount(count));
    byStatus[key] = count as number;
  }
  const warnings = (worker.warnings as unknown[]).map((entry) => {
    need(status, isObject(entry) && isText(entry.code, 60) && isText(entry.message, 400));
    return { code: (entry as Json).code as string, message: (entry as Json).message as string };
  });
  return {
    accounts: { total: accounts.total as number, active: accounts.active as number, suspended: accounts.suspended as number },
    offers: { total: offers.total as number, byStatus },
    activeDemands: summary.activeDemands as number,
    confirmedMatches: summary.confirmedMatches as number,
    activeBoosts: summary.activeBoosts as number,
    credits: { circulationXof: credits.circulationXof as number, topupsTodayCount: credits.topupsTodayCount as number, topupsTodayXof: credits.topupsTodayXof as number },
    conversations: { total: conversations.total as number, messagesToday: conversations.messagesToday as number },
    orders: { confirmed: orders.confirmed as number, proposed: orders.proposed as number },
    worker: {
      schemaReady: worker.schemaReady as boolean,
      healthy: worker.healthy as boolean,
      pendingEvents: worker.pendingEvents as number,
      pendingJobs: worker.pendingJobs as number,
      runningJobs: worker.runningJobs as number,
      deadLetter: worker.deadLetter as number,
      warnings,
      lastCompletedAt: worker.lastCompletedAt as string | null,
    },
    readAt: summary.readAt as string,
  };
}

function parseAdminVendor(status: number, value: unknown): AdminVendor {
  need(status, isObject(value) && isUuid(value.id) && (value.maskedPhone === null || (typeof value.maskedPhone === "string" && /^\+•*[0-9]{1,2}$/.test(value.maskedPhone) && value.maskedPhone.length <= 20)) && isCount(value.offerCount) && isCount(value.publishedCount) && isIso(value.createdAt) && typeof value.isAdmin === "boolean" && (value.status === "active" || value.status === "suspended" || value.status === "archived"));
  const vendor = value as Json;
  return { id: vendor.id as string, maskedPhone: vendor.maskedPhone as string | null, offerCount: vendor.offerCount as number, publishedCount: vendor.publishedCount as number, createdAt: vendor.createdAt as string, status: vendor.status as AdminVendor["status"], isAdmin: vendor.isAdmin as boolean };
}

function parseAdminAction(status: number, value: unknown): AdminActionEntry {
  need(status, isObject(value) && isUuid(value.id) && (value.action === "suspend_user" || value.action === "reactivate_user" || value.action === "grant_admin") && (value.source === "admin_ui" || value.source === "command") && (value.byMaskedPhone === null || isText(value.byMaskedPhone, 20)) && (value.targetMaskedPhone === null || isText(value.targetMaskedPhone, 20)) && isIso(value.createdAt));
  const entry = value as Json;
  return { id: entry.id as string, action: entry.action as AdminActionEntry["action"], source: entry.source as AdminActionEntry["source"], byMaskedPhone: entry.byMaskedPhone as string | null, targetMaskedPhone: entry.targetMaskedPhone as string | null, createdAt: entry.createdAt as string };
}

function numberOrNull(status: number, value: unknown): number | null {
  if (value === null) return null;
  need(status, typeof value === "number" && Number.isFinite(value));
  return value as number;
}

function parseBoostSettings(status: number, value: unknown): AdminBoostSettings {
  need(status, isObject(value) && isText(value.key, 80));
  const row = value as Json;
  return {
    key: row.key as string,
    slotRatio: numberOrNull(status, row.slotRatio),
    minSlots: numberOrNull(status, row.minSlots),
    maxSlots: numberOrNull(status, row.maxSlots),
    maxActivePerSeller: numberOrNull(status, row.maxActivePerSeller),
    maxSellerSlotShare: numberOrNull(status, row.maxSellerSlotShare),
    maxPromotedShare: numberOrNull(status, row.maxPromotedShare),
    minRelevance: numberOrNull(status, row.minRelevance),
    pricingVersion: numberOrNull(status, row.pricingVersion),
    baseAmountXof: numberOrNull(status, row.baseAmountXof),
    minAmountXof: numberOrNull(status, row.minAmountXof),
    maxAmountXof: numberOrNull(status, row.maxAmountXof),
    quoteValiditySeconds: numberOrNull(status, row.quoteValiditySeconds),
  };
}

// ───────────── client ─────────────

export interface SocialClientOptions {
  /** fetch injecté (tests) ; par défaut le fetch global, résolu à chaque appel. */
  fetch?: typeof fetch;
}

export function createSocialClient(options: SocialClientOptions = {}) {
  async function send(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, requestOptions: RequestOptions = {}): Promise<{ status: number; json: unknown }> {
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
    if (response.status !== 204) {
      try {
        json = await response.json();
      } catch {
        json = undefined;
      }
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

  function contract(status: number, json: unknown, version: string): Json {
    if (!isObject(json) || json.contractVersion !== version) bad(status);
    return json as Json;
  }

  return {
    favorites: {
      async list(requestOptions?: RequestOptions): Promise<FavoriteItem[]> {
        const { status, json } = await send("GET", "/api/favorites", undefined, requestOptions);
        const body = contract(status, json, FAVORITES_CONTRACT_VERSION);
        if (!Array.isArray(body.items)) bad(status);
        return (body.items as unknown[]).map((item) => parseFavorite(status, item));
      },
      /** Garde l'annonce dans le contexte du besoin d'origine (201 créé, 200 déjà gardé). */
      async add(demandId: string, offerId: string, requestOptions?: RequestOptions): Promise<{ created: boolean }> {
        const { status, json } = await send("POST", `/api/demands/${id(demandId)}/offers/${id(offerId)}/favorite`, {}, requestOptions);
        contract(status, json, FAVORITES_CONTRACT_VERSION);
        return { created: status === 201 };
      },
      async remove(offerId: string, requestOptions?: RequestOptions): Promise<{ removed: boolean }> {
        const { status, json } = await send("DELETE", `/api/favorites/${id(offerId)}`, undefined, requestOptions);
        const body = contract(status, json, FAVORITES_CONTRACT_VERSION);
        if (typeof body.removed !== "boolean") bad(status);
        return { removed: body.removed as boolean };
      },
    },

    conversations: {
      /** L'acheteur ouvre (ou retrouve) la conversation de l'annonce, dans le contexte de son besoin. */
      async open(demandId: string, offerId: string, requestOptions?: RequestOptions): Promise<{ conversationId: string; created: boolean }> {
        const { status, json } = await send("POST", `/api/demands/${id(demandId)}/offers/${id(offerId)}/conversation`, {}, requestOptions);
        const body = contract(status, json, CONVERSATIONS_CONTRACT_VERSION);
        if (!isObject(body.conversation) || !isUuid(body.conversation.id) || typeof body.created !== "boolean") bad(status);
        return { conversationId: (body.conversation as Json).id as string, created: body.created as boolean };
      },
      async list(requestOptions?: RequestOptions): Promise<{ items: ConversationSummary[]; unreadCount: number }> {
        const { status, json } = await send("GET", "/api/conversations", undefined, requestOptions);
        const body = contract(status, json, CONVERSATIONS_CONTRACT_VERSION);
        if (!Array.isArray(body.items) || !isCount(body.unreadCount)) bad(status);
        return { items: (body.items as unknown[]).map((item) => parseSummary(status, item)), unreadCount: body.unreadCount as number };
      },
      /** Nombre de conversations qui ont un message non lu (la pastille). */
      async unreadCount(requestOptions?: RequestOptions): Promise<number> {
        const { status, json } = await send("GET", "/api/conversations/unread", undefined, requestOptions);
        const body = contract(status, json, CONVERSATIONS_CONTRACT_VERSION);
        if (!isCount(body.unreadCount)) bad(status);
        return body.unreadCount as number;
      },
      async detail(conversationId: string, requestOptions?: RequestOptions): Promise<ConversationDetail> {
        const { status, json } = await send("GET", `/api/conversations/${id(conversationId)}`, undefined, requestOptions);
        return parseDetail(status, contract(status, json, CONVERSATIONS_CONTRACT_VERSION).conversation);
      },
      /** Sans `afterId` : les derniers messages ; avec `afterId` : ceux dont l'id est supérieur (rattrapage). */
      async messages(conversationId: string, query: { afterId?: number | null; limit?: number } = {}, requestOptions?: RequestOptions): Promise<{ messages: ConversationMessage[]; hasMore: boolean }> {
        const params = new URLSearchParams();
        if (query.afterId !== undefined && query.afterId !== null) {
          if (!Number.isSafeInteger(query.afterId) || query.afterId < 0) throw fixedError(0, "invalid_argument");
          params.set("after", String(query.afterId));
        }
        if (query.limit !== undefined) {
          if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw fixedError(0, "invalid_argument");
          params.set("limit", String(query.limit));
        }
        const text = params.toString();
        const { status, json } = await send("GET", `/api/conversations/${id(conversationId)}/messages${text ? `?${text}` : ""}`, undefined, requestOptions);
        const body = contract(status, json, CONVERSATIONS_CONTRACT_VERSION);
        if (!Array.isArray(body.messages) || typeof body.hasMore !== "boolean") bad(status);
        return { messages: (body.messages as unknown[]).map((message) => parseMessage(status, message)), hasMore: body.hasMore as boolean };
      },
      /** Envoie un message : le texte est contrôlé AVANT la requête (même règle que le serveur) ; refusé : `invalid_argument`, rien n'est envoyé. */
      async send(conversationId: string, text: string, requestOptions?: RequestOptions): Promise<ConversationMessage> {
        const checked = checkMessageBody(text);
        if (!checked.ok) throw fixedError(0, "invalid_argument");
        const { status, json } = await send("POST", `/api/conversations/${id(conversationId)}/messages`, { body: checked.body }, requestOptions);
        return parseMessage(status, contract(status, json, CONVERSATIONS_CONTRACT_VERSION).message);
      },
      async markRead(conversationId: string, upToId?: number, requestOptions?: RequestOptions): Promise<{ unreadCount: number }> {
        if (upToId !== undefined && (!Number.isSafeInteger(upToId) || upToId < 0)) throw fixedError(0, "invalid_argument");
        const { status, json } = await send("POST", `/api/conversations/${id(conversationId)}/read`, upToId === undefined ? {} : { upToId }, requestOptions);
        const body = contract(status, json, CONVERSATIONS_CONTRACT_VERSION);
        if (!isCount(body.unreadCount)) bad(status);
        return { unreadCount: body.unreadCount as number };
      },
      /** Adresse du flux en direct (Server-Sent Events) : construite depuis l'identifiant, jamais depuis une saisie. */
      streamUrl(conversationId: string): string {
        return `/api/conversations/${id(conversationId)}/stream`;
      },
    },

    orders: {
      async declare(demandId: string, offerId: string, priceXof: number, requestOptions?: RequestOptions): Promise<OrderView> {
        if (!Number.isSafeInteger(priceXof) || priceXof < 1 || priceXof > 100_000_000) throw fixedError(0, "invalid_argument");
        const { status, json } = await send("POST", `/api/demands/${id(demandId)}/offers/${id(offerId)}/orders`, { priceXof }, requestOptions);
        return parseOrder(status, contract(status, json, ORDERS_CONTRACT_VERSION).order);
      },
      async list(as: ParticipantRole, requestOptions?: RequestOptions): Promise<OrderView[]> {
        if (as !== "buyer" && as !== "seller") throw fixedError(0, "invalid_argument");
        const { status, json } = await send("GET", `/api/orders?as=${as}`, undefined, requestOptions);
        const body = contract(status, json, ORDERS_CONTRACT_VERSION);
        if (!Array.isArray(body.orders)) bad(status);
        return (body.orders as unknown[]).map((order) => parseOrder(status, order));
      },
      async get(orderId: string, requestOptions?: RequestOptions): Promise<OrderView> {
        const { status, json } = await send("GET", `/api/orders/${id(orderId)}`, undefined, requestOptions);
        return parseOrder(status, contract(status, json, ORDERS_CONTRACT_VERSION).order);
      },
      async act(orderId: string, action: OrderAction, requestOptions?: RequestOptions): Promise<OrderView> {
        if (action !== "confirm" && action !== "decline" && action !== "cancel") throw fixedError(0, "invalid_argument");
        const { status, json } = await send("POST", `/api/orders/${id(orderId)}/${action}`, {}, requestOptions);
        return parseOrder(status, contract(status, json, ORDERS_CONTRACT_VERSION).order);
      },
      /** Ventes confirmées de SON annonce, arrondies. */
      async sales(offerId: string, requestOptions?: RequestOptions): Promise<OfferSales> {
        const { status, json } = await send("GET", `/api/offers/${id(offerId)}/sales`, undefined, requestOptions);
        const body = contract(status, json, ORDER_SALES_CONTRACT_VERSION);
        if (!isObject(body.sales)) bad(status);
        const sales = body.sales as Json;
        return {
          confirmed: parseSalesCount(status, sales.confirmed),
          attributedToBoost: sales.attributedToBoost === null ? null : parseSalesCount(status, sales.attributedToBoost),
          organic: sales.organic === null ? null : parseSalesCount(status, sales.organic),
        };
      },
    },

    admin: {
      async summary(requestOptions?: RequestOptions): Promise<AdminSummary> {
        const { status, json } = await send("GET", "/api/admin/summary", undefined, requestOptions);
        return parseSummaryOfAdmin(status, contract(status, json, ADMIN_CONTRACT_VERSION).summary);
      },
      async vendors(query: { limit?: number; offset?: number } = {}, requestOptions?: RequestOptions): Promise<AdminVendorsPage> {
        const params = new URLSearchParams();
        if (query.limit !== undefined) {
          if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) throw fixedError(0, "invalid_argument");
          params.set("limit", String(query.limit));
        }
        if (query.offset !== undefined) {
          if (!Number.isInteger(query.offset) || query.offset < 0) throw fixedError(0, "invalid_argument");
          params.set("offset", String(query.offset));
        }
        const text = params.toString();
        const { status, json } = await send("GET", `/api/admin/vendors${text ? `?${text}` : ""}`, undefined, requestOptions);
        const body = contract(status, json, ADMIN_CONTRACT_VERSION);
        if (!isCount(body.total) || !isCount(body.limit) || !isCount(body.offset) || !Array.isArray(body.vendors)) bad(status);
        return { total: body.total as number, limit: body.limit as number, offset: body.offset as number, vendors: (body.vendors as unknown[]).map((vendor) => parseAdminVendor(status, vendor)) };
      },
      async setStatus(userId: string, action: "suspend" | "reactivate", requestOptions?: RequestOptions): Promise<{ status: "active" | "suspended"; changed: boolean }> {
        const { status, json } = await send("POST", `/api/admin/vendors/${id(userId)}/${action}`, {}, requestOptions);
        const body = contract(status, json, ADMIN_CONTRACT_VERSION);
        if ((body.status !== "active" && body.status !== "suspended") || typeof body.changed !== "boolean") bad(status);
        return { status: body.status as "active" | "suspended", changed: body.changed as boolean };
      },
      async actions(requestOptions?: RequestOptions): Promise<AdminActionEntry[]> {
        const { status, json } = await send("GET", "/api/admin/actions", undefined, requestOptions);
        const body = contract(status, json, ADMIN_CONTRACT_VERSION);
        if (!Array.isArray(body.actions)) bad(status);
        return (body.actions as unknown[]).map((entry) => parseAdminAction(status, entry));
      },
      async settings(requestOptions?: RequestOptions): Promise<AdminBoostSettings[]> {
        const { status, json } = await send("GET", "/api/admin/settings", undefined, requestOptions);
        const body = contract(status, json, ADMIN_CONTRACT_VERSION);
        if (!Array.isArray(body.settings)) bad(status);
        return (body.settings as unknown[]).map((row) => parseBoostSettings(status, row));
      },
    },
  };
}

export type SocialClient = ReturnType<typeof createSocialClient>;

/** Client du navigateur : fetch global, même origine. */
export const social: SocialClient = createSocialClient();

// ───────────── messages d'erreur (fixes, en français) ─────────────

export type SocialErrorContext = "favorites" | "conversation" | "message" | "order" | "admin";

/** Message FIXE pour l'utilisateur d'après (contexte, statut, code) : jamais le texte d'une exception ni celui du serveur. */
export function describeSocialError(error: unknown, context: SocialErrorContext): string {
  if (!(error instanceof ApiError)) return "Une erreur est survenue. Réessayez dans un instant.";
  if (error.code === API_NETWORK_ERROR) return "Connexion impossible. Vérifiez votre réseau et réessayez.";
  if (error.code === API_ABORTED) return "Requête interrompue.";
  if (error.status === 401) return "Votre session a expiré. Reconnectez-vous pour continuer.";
  if (error.status === 403) return "Requête refusée. Rechargez la page et réessayez.";
  if (error.code === "invalid_argument") return context === "message" ? "Ce message n'est pas valide : 1 à 1 000 caractères, sans caractère spécial." : "Paramètre invalide. Rechargez la page.";
  if (context === "favorites") {
    if (error.status === 404) return "Cette annonce n'est plus visible pour votre besoin : elle ne peut pas être gardée.";
    if (error.code === "favorites_limit") return "Vous avez atteint la limite de 200 favoris. Retirez-en un pour en garder un autre.";
  }
  if (context === "conversation" || context === "message") {
    if (error.status === 404) return "Cette conversation est introuvable ou l'annonce n'est plus disponible pour votre besoin.";
    if (error.code === "offer_not_available") return "Cette annonce n'est plus disponible : la conversation ne peut pas être ouverte.";
    if (error.status === 429) return context === "message" ? "Trop de messages envoyés. Patientez un moment avant de réécrire." : "Vous avez ouvert 20 conversations aujourd'hui. Réessayez demain.";
    if (error.code === "invalid_message") return "Ce message n'est pas valide : 1 à 1 000 caractères, sans caractère spécial.";
  }
  if (context === "order") {
    if (error.status === 404) return "Commande introuvable, ou annonce plus disponible pour votre besoin.";
    if (error.code === "invalid_price") return "Le prix convenu doit être un nombre entier de 1 à 100 000 000 FCFA.";
    if (error.code === "order_active_exists") return "Une commande est déjà en cours pour cette annonce.";
    if (error.code === "order_state_conflict") return "Cette commande ne peut plus changer d'état. La page va être actualisée.";
    if (error.code === "action_not_allowed") return "Cette action n'est pas permise pour votre rôle.";
    if (error.code === "offer_not_available") return "Cette annonce n'est plus disponible : aucune commande ne peut être déclarée.";
  }
  if (context === "admin") {
    if (error.status === 404) return "Page introuvable.";
    if (error.code === "target_protected") return "Un compte administrateur ne peut pas être suspendu.";
    if (error.code === "target_archived") return "Ce compte est archivé : son statut ne change plus.";
  }
  if (error.status === 400) return "La demande n'est pas valide. Rechargez la page.";
  if (error.status === 404) return "Élément introuvable.";
  if (error.status === 503) return "Le service est temporairement indisponible. Réessayez dans un instant.";
  return "Une erreur est survenue. Réessayez dans un instant.";
}
