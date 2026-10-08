import "server-only";

import { noStoreJsonResponse } from "../http/protection";
import {
  CONVERSATIONS_CONTRACT_VERSION,
  FAVORITES_CONTRACT_VERSION,
  MESSAGES_PAGE_DEFAULT,
  MESSAGES_PAGE_MAX,
  MESSAGE_BODY_MAX_BYTES,
  ORDERS_CONTRACT_VERSION,
  ORDER_BODY_MAX_BYTES,
  ORDER_SALES_CONTRACT_VERSION,
} from "./config";
import {
  countUnreadConversations,
  isConversationParticipant,
  listConversations,
  listMessages,
  markConversationRead,
  openConversation,
  readConversationDetail,
  sendMessage,
  type ConversationDetail,
  type ConversationMessage,
  type ConversationSummary,
} from "./conversations";
import { addFavorite, listFavorites, removeFavorite, type FavoriteItem } from "./favorites";
import { UUID, createSocialContext, hasUnexpectedQuery, invalidRequest, isoOrNull, logCodeOf, resourceNotFound, type SocialHttpDependencies } from "./http-common";
import { getMessageBus, type MessageBus } from "./message-bus";
import { ORDER_ACTIONS, declareOrder, listOrders, readOfferSales, readOrder, transitionOrder, type OrderAction, type OrderView } from "./orders";
import { getStreamRegistry, openMessageStream, type StreamRegistry } from "./stream";

/**
 * Routes HTTP des favoris, de la messagerie en direct et des commandes (lot D2). Voir MESSAGERIE.md et COMMANDES.md.
 *  - POST   /api/demands/{id}/offers/{offerId}/favorite       : garde l'annonce (accès de la fiche) ;       DELETE /api/favorites/{offerId} : la retire ;   GET /api/favorites
 *  - POST   /api/demands/{id}/offers/{offerId}/conversation   : l'acheteur ouvre (ou retrouve) la conversation ;  GET /api/conversations, /unread, /{id}
 *  - GET|POST /api/conversations/{id}/messages ; POST /api/conversations/{id}/read ; GET /api/conversations/{id}/stream (SSE)
 *  - POST   /api/demands/{id}/offers/{offerId}/orders         : déclare une vente ;  GET /api/orders?as=buyer|seller, /{id} ;  POST /api/orders/{id}/confirm|decline|cancel
 *  - GET    /api/offers/{id}/sales                            : ventes confirmées de SON annonce (arrondies)
 * Toute écriture : origine vérifiée AVANT la session. Réponses `no-store` (le flux aussi), textes fixes, 404 identique pour tout accès refusé. Aucun identifiant ni
 * téléphone de l'autre partie n'est jamais servi : l'autre partie est désignée par son rôle.
 */

export interface SocialHandlersDependencies extends SocialHttpDependencies {
  /** Bus des messages en direct (défaut : celui du processus). Réservé aux tests. */
  bus?: MessageBus;
  /** Registre des flux ouverts par utilisateur (défaut : celui du processus). Réservé aux tests. */
  registry?: StreamRegistry;
  heartbeatMs?: number;
}

export interface SocialHttpHandlers {
  favorites: {
    list(request: Request): Promise<Response>;
    add(request: Request, demandId: string, offerId: string): Promise<Response>;
    remove(request: Request, offerId: string): Promise<Response>;
  };
  conversations: {
    open(request: Request, demandId: string, offerId: string): Promise<Response>;
    list(request: Request): Promise<Response>;
    unread(request: Request): Promise<Response>;
    detail(request: Request, conversationId: string): Promise<Response>;
    messages(request: Request, conversationId: string): Promise<Response>;
    send(request: Request, conversationId: string): Promise<Response>;
    read(request: Request, conversationId: string): Promise<Response>;
    stream(request: Request, conversationId: string): Promise<Response>;
  };
  orders: {
    declare(request: Request, demandId: string, offerId: string): Promise<Response>;
    list(request: Request): Promise<Response>;
    get(request: Request, orderId: string): Promise<Response>;
    act(request: Request, orderId: string, action: string): Promise<Response>;
    sales(request: Request, offerId: string): Promise<Response>;
  };
}

// ───────────── DTO (liste blanche) ─────────────

function favoriteDto(item: FavoriteItem) {
  return {
    offerId: item.offerId,
    demandId: item.demandId,
    title: item.title,
    price: item.price === null ? null : { amount: item.price.amount, currency: item.price.currency },
    available: item.available,
    openable: item.openable,
    createdAt: item.createdAt.toISOString(),
    ...(item.coverPhotoId === undefined ? {} : { coverPhotoId: item.coverPhotoId }),
  };
}

function conversationDto(item: ConversationSummary) {
  return {
    id: item.id,
    role: item.role,
    title: item.title,
    demandId: item.demandId,
    offerId: item.offerId,
    available: item.available,
    createdAt: item.createdAt.toISOString(),
    lastMessage: item.lastMessage === null ? null : { body: item.lastMessage.body, mine: item.lastMessage.mine, createdAt: item.lastMessage.createdAt.toISOString() },
    unreadCount: item.unreadCount,
  };
}

function detailDto(detail: ConversationDetail) {
  return {
    id: detail.id,
    role: detail.role,
    title: detail.title,
    demandId: detail.demandId,
    offerId: detail.offerId,
    available: detail.available,
    order: detail.order === null ? null : { id: detail.order.id, status: detail.order.status },
    canDeclareOrder: detail.canDeclareOrder,
  };
}

function messageDto(message: ConversationMessage) {
  return { id: message.id, mine: message.mine, body: message.body, createdAt: message.createdAt.toISOString() };
}

function orderDto(order: OrderView) {
  return {
    id: order.id,
    role: order.role,
    status: order.status,
    price: { amount: order.price.amount, currency: order.price.currency },
    title: order.title,
    offerId: order.offerId,
    demandId: order.demandId,
    conversationId: order.conversationId,
    createdAt: order.createdAt.toISOString(),
    decidedAt: isoOrNull(order.decidedAt),
    canConfirm: order.canConfirm,
    canDecline: order.canDecline,
    canCancel: order.canCancel,
    canMarkDemandSatisfied: order.canMarkDemandSatisfied,
  };
}

const noStoreJson = (status: number, body: unknown): Response => noStoreJsonResponse(status, body);

export function createSocialHttpHandlers(dependencies: SocialHandlersDependencies = {}): SocialHttpHandlers {
  const context = createSocialContext(dependencies, "social-http");
  const busOf = (): MessageBus => dependencies.bus ?? getMessageBus();
  const registryOf = (): StreamRegistry => dependencies.registry ?? getStreamRegistry();

  /** Gabarit des routes : (origine pour l'écriture) → session → identifiants valides, sans paramètre de requête → corps. */
  async function guarded(
    request: Request,
    options: { write: boolean; ids?: readonly string[]; query?: readonly string[] },
    run: (userId: string) => Promise<Response>,
  ): Promise<Response> {
    if (options.write) {
      const refusal = context.originGuard(request);
      if (refusal) return refusal;
    }
    const authenticated = await context.authenticate(request);
    if (!authenticated.ok) return authenticated.response;
    if ((options.ids ?? []).some((id) => !UUID.test(id)) || hasUnexpectedQuery(request, options.query ?? [])) return invalidRequest();
    try {
      return await run(authenticated.userId);
    } catch (error) {
      const mapped = context.mapError(error);
      if (mapped) return mapped;
      return context.unavailable(logCodeOf(error), "social");
    }
  }

  return {
    favorites: {
      list: (request) =>
        guarded(request, { write: false }, async (userId) => {
          const items = await listFavorites({ pool: context.poolOf(), userId });
          return noStoreJson(200, { contractVersion: FAVORITES_CONTRACT_VERSION, items: items.map(favoriteDto) });
        }),
      add: (request, demandId, offerId) =>
        guarded(request, { write: true, ids: [demandId, offerId] }, async (userId) => {
          const body = await context.readJsonObject(request, 64);
          if (body === null || Object.keys(body).length > 0) return invalidRequest();
          const result = await addFavorite({ pool: context.poolOf(), userId, demandId, offerId });
          return noStoreJson(result.created ? 201 : 200, { contractVersion: FAVORITES_CONTRACT_VERSION, favorite: { offerId: offerId.toLowerCase(), demandId: demandId.toLowerCase() } });
        }),
      remove: (request, offerId) =>
        guarded(request, { write: true, ids: [offerId] }, async (userId) => {
          const result = await removeFavorite({ pool: context.poolOf(), userId, offerId });
          return noStoreJson(200, { contractVersion: FAVORITES_CONTRACT_VERSION, removed: result.removed });
        }),
    },

    conversations: {
      open: (request, demandId, offerId) =>
        guarded(request, { write: true, ids: [demandId, offerId] }, async (userId) => {
          const body = await context.readJsonObject(request, 64);
          if (body === null || Object.keys(body).length > 0) return invalidRequest();
          const result = await openConversation({ pool: context.poolOf(), viewerId: userId, demandId, offerId });
          return noStoreJson(result.created ? 201 : 200, { contractVersion: CONVERSATIONS_CONTRACT_VERSION, conversation: { id: result.conversationId }, created: result.created });
        }),

      list: (request) =>
        guarded(request, { write: false }, async (userId) => {
          const result = await listConversations({ pool: context.poolOf(), userId });
          return noStoreJson(200, { contractVersion: CONVERSATIONS_CONTRACT_VERSION, items: result.items.map(conversationDto), unreadCount: result.unreadCount });
        }),

      unread: (request) =>
        guarded(request, { write: false }, async (userId) => {
          const unreadCount = await countUnreadConversations({ pool: context.poolOf(), userId });
          return noStoreJson(200, { contractVersion: CONVERSATIONS_CONTRACT_VERSION, unreadCount });
        }),

      detail: (request, conversationId) =>
        guarded(request, { write: false, ids: [conversationId] }, async (userId) => {
          const detail = await readConversationDetail({ pool: context.poolOf(), userId, conversationId });
          return noStoreJson(200, { contractVersion: CONVERSATIONS_CONTRACT_VERSION, conversation: detailDto(detail) });
        }),

      messages: (request, conversationId) =>
        guarded(request, { write: false, ids: [conversationId], query: ["after", "limit"] }, async (userId) => {
          const parameters = new URL(request.url).searchParams;
          let afterId: number | null = null;
          if (parameters.has("after")) {
            const text = parameters.get("after") ?? "";
            if (!/^[0-9]{1,15}$/.test(text)) return invalidRequest();
            afterId = Number(text);
          }
          let limit = MESSAGES_PAGE_DEFAULT;
          if (parameters.has("limit")) {
            const text = parameters.get("limit") ?? "";
            if (!/^[0-9]{1,3}$/.test(text)) return invalidRequest();
            limit = Number(text);
            if (limit < 1 || limit > MESSAGES_PAGE_MAX) return invalidRequest();
          }
          const page = await listMessages({ pool: context.poolOf(), userId, conversationId, afterId, limit });
          return noStoreJson(200, { contractVersion: CONVERSATIONS_CONTRACT_VERSION, messages: page.messages.map(messageDto), hasMore: page.hasMore });
        }),

      send: (request, conversationId) =>
        guarded(request, { write: true, ids: [conversationId] }, async (userId) => {
          const body = await context.readJsonObject(request, MESSAGE_BODY_MAX_BYTES);
          if (body === null || Object.keys(body).some((key) => key !== "body") || typeof body.body !== "string") return invalidRequest();
          const message = await sendMessage({ pool: context.poolOf(), senderId: userId, conversationId, body: body.body });
          return noStoreJson(201, { contractVersion: CONVERSATIONS_CONTRACT_VERSION, message: messageDto(message) });
        }),

      read: (request, conversationId) =>
        guarded(request, { write: true, ids: [conversationId] }, async (userId) => {
          const body = await context.readJsonObject(request, 256);
          if (body === null || Object.keys(body).some((key) => key !== "upToId")) return invalidRequest();
          let upToId: number | null = null;
          if (body.upToId !== undefined) {
            if (typeof body.upToId !== "number" || !Number.isSafeInteger(body.upToId) || body.upToId < 0) return invalidRequest();
            upToId = body.upToId;
          }
          const result = await markConversationRead({ pool: context.poolOf(), userId, conversationId, upToId });
          return noStoreJson(200, { contractVersion: CONVERSATIONS_CONTRACT_VERSION, unreadCount: result.unreadCount });
        }),

      stream: (request, conversationId) =>
        guarded(request, { write: false, ids: [conversationId] }, async (userId) => {
          // Accès AVANT toute place prise : un tiers reçoit le même 404 que pour une conversation inexistante, et ne consomme rien.
          if (!(await isConversationParticipant({ pool: context.poolOf(), userId, conversationId }))) return resourceNotFound();
          return openMessageStream({ bus: busOf(), registry: registryOf(), userId, conversationId: conversationId.toLowerCase(), signal: request.signal, heartbeatMs: dependencies.heartbeatMs });
        }),
    },

    orders: {
      declare: (request, demandId, offerId) =>
        guarded(request, { write: true, ids: [demandId, offerId] }, async (userId) => {
          const body = await context.readJsonObject(request, ORDER_BODY_MAX_BYTES);
          if (body === null || Object.keys(body).some((key) => key !== "priceXof")) return invalidRequest();
          const order = await declareOrder({ pool: context.poolOf(), buyerId: userId, demandId, offerId, price: body.priceXof });
          return noStoreJson(201, { contractVersion: ORDERS_CONTRACT_VERSION, order: orderDto(order) });
        }),

      list: (request) =>
        guarded(request, { write: false, query: ["as"] }, async (userId) => {
          const as = new URL(request.url).searchParams.get("as");
          if (as !== "buyer" && as !== "seller") return invalidRequest();
          const orders = await listOrders({ pool: context.poolOf(), userId, as });
          return noStoreJson(200, { contractVersion: ORDERS_CONTRACT_VERSION, orders: orders.map(orderDto) });
        }),

      get: (request, orderId) =>
        guarded(request, { write: false, ids: [orderId] }, async (userId) => {
          const order = await readOrder({ pool: context.poolOf(), userId, orderId });
          return noStoreJson(200, { contractVersion: ORDERS_CONTRACT_VERSION, order: orderDto(order) });
        }),

      act: (request, orderId, action) =>
        guarded(request, { write: true, ids: [orderId] }, async (userId) => {
          if (!(ORDER_ACTIONS as readonly string[]).includes(action)) return resourceNotFound();
          const body = await context.readJsonObject(request, 64);
          if (body === null || Object.keys(body).length > 0) return invalidRequest();
          const order = await transitionOrder({ pool: context.poolOf(), userId, orderId, action: action as OrderAction });
          return noStoreJson(200, { contractVersion: ORDERS_CONTRACT_VERSION, order: orderDto(order) });
        }),

      sales: (request, offerId) =>
        guarded(request, { write: false, ids: [offerId] }, async (userId) => {
          const sales = await readOfferSales({ pool: context.poolOf(), ownerId: userId, offerId });
          return noStoreJson(200, {
            contractVersion: ORDER_SALES_CONTRACT_VERSION,
            sales: { confirmed: sales.confirmed, attributedToBoost: sales.attributedToBoost, organic: sales.organic },
          });
        }),
    },
  };
}

export const defaultSocialHttpHandlers = createSocialHttpHandlers();

