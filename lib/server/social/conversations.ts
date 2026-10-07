import "server-only";

import type { Pool, PoolClient } from "pg";
import { checkMessageBody } from "../../messages-text";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { readOfferAccess } from "../metrics/contacts";
import { buildNotificationTitle } from "../notifications/content";
import { withPostgresTransaction } from "../postgres/client";
import {
  CONVERSATIONS_LIST_LIMIT,
  CONVERSATION_OPEN_LOCK_NAMESPACE,
  MESSAGES_PAGE_DEFAULT,
  MESSAGES_PAGE_MAX,
  MESSAGES_PER_DAY,
  MESSAGES_PER_MINUTE,
  MESSAGE_PREVIEW_LENGTH,
  MESSAGE_SEND_LOCK_NAMESPACE,
  NEW_CONVERSATIONS_PER_DAY,
  SOCIAL_TRANSACTION_TIMEOUT,
} from "./config";
import { SocialError } from "./errors";

/**
 * Messagerie (lot D2) : une conversation par couple (besoin, annonce) entre l'acheteur (propriétaire du besoin) et le vendeur.
 *  - OUVERTE par l'acheteur seulement, aux mêmes conditions que le contact (`readOfferAccess` : correspondance confirmée et fraîche, annonce en ligne) ; le vendeur ne peut
 *    que répondre : il n'existe aucun chemin d'ouverture côté vendeur ;
 *  - lue et écrite par les DEUX participants seulement : pour tout autre, `resource_not_found` (404 indiscernable de « n'existe pas ») ;
 *  - limites par utilisateur : 30 messages par minute, 300 par jour UTC ; 20 nouvelles conversations par jour UTC et par acheteur (verrous consultatifs : limites exactes) ;
 *  - un message est écrit sous le verrou de sa conversation : les `id` croissent dans l'ordre de validation (rattrapage « messages après l'id X » sans trou) ;
 *  - la même transaction crée, pour l'autre participant, UNE notification `new_message` par conversation tant qu'elle n'est pas lue ; le trigger de la migration 0020 émet
 *    NOTIFY (conversation, id, jamais le texte).
 * Le texte d'un message est contrôlé par `checkMessageBody` (module pur partagé avec l'écran). Voir MESSAGERIE.md.
 */

export type ParticipantRole = "buyer" | "seller";

export interface ConversationSummary {
  id: string;
  role: ParticipantRole;
  /** Titre de l'annonce (liste blanche des notifications : marque, modèle, variante nettoyés). */
  title: string;
  /** Besoin d'origine : connu de l'acheteur seulement (null côté vendeur). */
  demandId: string | null;
  offerId: string;
  /** L'annonce est toujours en ligne. */
  available: boolean;
  createdAt: Date;
  lastMessage: { body: string; mine: boolean; createdAt: Date } | null;
  unreadCount: number;
}

export interface ConversationMessage {
  id: number;
  mine: boolean;
  body: string;
  createdAt: Date;
}

export interface ConversationDetail {
  id: string;
  role: ParticipantRole;
  title: string;
  demandId: string | null;
  offerId: string;
  available: boolean;
  /** Dernière commande du couple (besoin, annonce) : l'état et l'identifiant pour y accéder. */
  order: { id: string; status: "proposed" | "confirmed" | "declined" | "cancelled" } | null;
  /** Une commande peut être déclarée depuis cette conversation (acheteur, annonce encore en ligne, aucune commande active). */
  canDeclareOrder: boolean;
}

const previewOf = (body: string): string => {
  const chars = [...body];
  return chars.length > MESSAGE_PREVIEW_LENGTH ? `${chars.slice(0, MESSAGE_PREVIEW_LENGTH - 1).join("")}…` : body;
};

function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function requireBigintId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new SocialError("invalid_message");
  return value;
}

// ───────────── ouverture ─────────────

/**
 * Ouvre (ou retrouve) la conversation de l'acheteur pour ce couple (besoin, annonce). Aucune écriture si l'accès est refusé. Une conversation déjà ouverte est rendue sans
 * compter dans la limite quotidienne ; au-delà de 20 NOUVELLES conversations par jour UTC : `rate_limited`.
 */
export async function openConversation(input: { pool: Pool; viewerId: string; demandId: string; offerId: string }): Promise<{ conversationId: string; created: boolean }> {
  const pool = requireTransactionPool(input.pool);
  const viewerId = requireUuid(input.viewerId, "viewerId").toLowerCase();
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${SOCIAL_TRANSACTION_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [CONVERSATION_OPEN_LOCK_NAMESPACE, viewerId]);
    const access = await readOfferAccess(client, { viewerId, demandId, offerId });
    if (!access.ok) throw new SocialError(access.reason === "offer_not_available" ? "offer_not_available" : "resource_not_found");
    const existing = await client.query<{ id: string }>("SELECT id FROM conversations WHERE demand_id = $1::uuid AND offer_id = $2::uuid AND buyer_id = $3::uuid", [demandId, offerId, viewerId]);
    if (existing.rows[0]) return { conversationId: existing.rows[0].id, created: false };
    const today = await client.query<{ n: number; now: Date }>(
      `SELECT count(*)::int AS n, clock_timestamp() AS now FROM conversations
        WHERE buyer_id = $1::uuid AND created_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
      [viewerId],
    );
    if (today.rows[0].n >= NEW_CONVERSATIONS_PER_DAY) throw new SocialError("rate_limited", secondsUntilNextUtcDay(today.rows[0].now));
    const created = await client.query<{ id: string }>(
      "INSERT INTO conversations (demand_id, offer_id, buyer_id, seller_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid) RETURNING id",
      [demandId, offerId, viewerId, access.sellerId],
    );
    return { conversationId: created.rows[0].id, created: true };
  }, pool);
}

// ───────────── accès des participants ─────────────

interface ConversationRow {
  id: string;
  demand_id: string;
  offer_id: string;
  buyer_id: string;
  seller_id: string;
  brand: string | null;
  model: string | null;
  variant: string | null;
  available: boolean;
}

type Executor = Pool | PoolClient;

async function loadParticipantConversation(executor: Executor, conversationId: string, userId: string, lock = false): Promise<ConversationRow | null> {
  const result = await executor.query<ConversationRow>(
    `SELECT c.id, c.demand_id, c.offer_id, c.buyer_id, c.seller_id, o.brand, o.model, o.variant,
            (o.status = 'published' AND o.availability_status IS DISTINCT FROM 'unavailable') AS available
       FROM conversations c JOIN offers o ON o.id = c.offer_id
      WHERE c.id = $1::uuid AND (c.buyer_id = $2::uuid OR c.seller_id = $2::uuid)
      ${lock ? "FOR UPDATE OF c" : ""}`,
    [conversationId, userId],
  );
  return result.rows[0] ?? null;
}

/** Vrai si l'utilisateur est l'un des deux participants (sert à autoriser le flux en direct). */
export async function isConversationParticipant(input: { pool: Pool; userId: string; conversationId: string }): Promise<boolean> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const conversationId = requireUuid(input.conversationId, "conversationId").toLowerCase();
  return (await loadParticipantConversation(pool, conversationId, userId)) !== null;
}

export async function readConversationDetail(input: { pool: Pool; userId: string; conversationId: string }): Promise<ConversationDetail> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const conversationId = requireUuid(input.conversationId, "conversationId").toLowerCase();
  const row = await loadParticipantConversation(pool, conversationId, userId);
  if (!row) throw new SocialError("resource_not_found");
  const role: ParticipantRole = row.buyer_id === userId ? "buyer" : "seller";
  const order = await pool.query<{ id: string; status: "proposed" | "confirmed" | "declined" | "cancelled" }>(
    `SELECT id, status FROM orders WHERE demand_id = $1::uuid AND offer_id = $2::uuid
      ORDER BY (status IN ('proposed', 'confirmed')) DESC, created_at DESC, id DESC LIMIT 1`,
    [row.demand_id, row.offer_id],
  );
  const latest = order.rows[0] ?? null;
  return {
    id: row.id,
    role,
    title: buildNotificationTitle(row),
    demandId: role === "buyer" ? row.demand_id : null,
    offerId: row.offer_id,
    available: row.available,
    order: latest,
    canDeclareOrder: role === "buyer" && row.available && (latest === null || latest.status === "declined" || latest.status === "cancelled"),
  };
}

// ───────────── liste et non-lus ─────────────

interface ListRow {
  id: string;
  demand_id: string;
  offer_id: string;
  buyer_id: string;
  created_at: Date;
  brand: string | null;
  model: string | null;
  variant: string | null;
  available: boolean;
  last_body: string | null;
  last_sender: string | null;
  last_at: Date | null;
  unread: number;
}

/** Les conversations de l'utilisateur (les plus récentes d'abord) : un vendeur ne voit une conversation qu'à partir du premier message de l'acheteur. */
export async function listConversations(input: { pool: Pool; userId: string }): Promise<{ items: ConversationSummary[]; unreadCount: number }> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const rows = await pool.query<ListRow>(
    `SELECT c.id, c.demand_id, c.offer_id, c.buyer_id, c.created_at, o.brand, o.model, o.variant,
            (o.status = 'published' AND o.availability_status IS DISTINCT FROM 'unavailable') AS available,
            lm.body AS last_body, lm.sender_id AS last_sender, lm.created_at AS last_at,
            (SELECT count(*)::int FROM messages m
              WHERE m.conversation_id = c.id AND m.sender_id <> $1::uuid
                AND m.id > CASE WHEN c.buyer_id = $1::uuid THEN c.buyer_last_read_id ELSE c.seller_last_read_id END) AS unread
       FROM conversations c
       JOIN offers o ON o.id = c.offer_id
       LEFT JOIN LATERAL (SELECT body, sender_id, created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) lm ON TRUE
      WHERE c.buyer_id = $1::uuid OR (c.seller_id = $1::uuid AND c.last_message_at IS NOT NULL)
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
      LIMIT $2::int`,
    [userId, CONVERSATIONS_LIST_LIMIT],
  );
  const items = rows.rows.map((row): ConversationSummary => {
    const role: ParticipantRole = row.buyer_id === userId ? "buyer" : "seller";
    return {
      id: row.id,
      role,
      title: buildNotificationTitle(row),
      demandId: role === "buyer" ? row.demand_id : null,
      offerId: row.offer_id,
      available: row.available,
      createdAt: row.created_at,
      lastMessage: row.last_body === null || row.last_at === null ? null : { body: previewOf(row.last_body), mine: row.last_sender === userId, createdAt: row.last_at },
      unreadCount: row.unread,
    };
  });
  return { items, unreadCount: items.filter((item) => item.unreadCount > 0).length };
}

/** Nombre de conversations qui ont au moins un message non lu (la pastille de la navigation). */
export async function countUnreadConversations(input: { pool: Pool; userId: string }): Promise<number> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM conversations c
      WHERE (c.buyer_id = $1::uuid OR c.seller_id = $1::uuid)
        AND EXISTS (SELECT 1 FROM messages m
                     WHERE m.conversation_id = c.id AND m.sender_id <> $1::uuid
                       AND m.id > CASE WHEN c.buyer_id = $1::uuid THEN c.buyer_last_read_id ELSE c.seller_last_read_id END)`,
    [userId],
  );
  return result.rows[0].n;
}

// ───────────── lecture des messages ─────────────

interface MessageRow {
  id: string;
  sender_id: string;
  body: string;
  created_at: Date;
}

/**
 * Messages d'une conversation, du plus ancien au plus récent. Sans `afterId` : les `limit` derniers (`hasMore` : il en existe de plus anciens). Avec `afterId` : ceux dont l'id
 * est strictement supérieur, `limit` au plus (`hasMore` : il en reste) : c'est le rattrapage d'un client qui a manqué des événements. Participants seulement.
 */
export async function listMessages(input: { pool: Pool; userId: string; conversationId: string; afterId?: number | null; limit?: number }): Promise<{ messages: ConversationMessage[]; hasMore: boolean }> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const conversationId = requireUuid(input.conversationId, "conversationId").toLowerCase();
  const limit = input.limit ?? MESSAGES_PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MESSAGES_PAGE_MAX) throw new SocialError("invalid_message");
  const afterId = input.afterId === undefined || input.afterId === null ? null : requireBigintId(input.afterId);
  if (!(await loadParticipantConversation(pool, conversationId, userId))) throw new SocialError("resource_not_found");
  const rows =
    afterId === null
      ? await pool.query<MessageRow>(
          "SELECT id::text AS id, sender_id, body, created_at FROM messages WHERE conversation_id = $1::uuid ORDER BY id DESC LIMIT $2::int",
          [conversationId, limit + 1],
        )
      : await pool.query<MessageRow>(
          "SELECT id::text AS id, sender_id, body, created_at FROM messages WHERE conversation_id = $1::uuid AND id > $3::bigint ORDER BY id ASC LIMIT $2::int",
          [conversationId, limit + 1, afterId],
        );
  const hasMore = rows.rows.length > limit;
  const kept = rows.rows.slice(0, limit);
  if (afterId === null) kept.reverse();
  return {
    messages: kept.map((row) => ({ id: Number(row.id), mine: row.sender_id === userId, body: row.body, createdAt: row.created_at })),
    hasMore,
  };
}

// ───────────── lecture (état par participant) ─────────────

/**
 * Marque la conversation lue pour l'utilisateur jusqu'à `upToId` (par défaut le dernier message) : l'état de lecture ne recule jamais. Quand plus rien n'est non lu, la
 * notification `new_message` de cette conversation est marquée lue (même règle que la liste des notifications). Renvoie le nombre de conversations encore non lues.
 */
export async function markConversationRead(input: { pool: Pool; userId: string; conversationId: string; upToId?: number | null }): Promise<{ unreadCount: number }> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const conversationId = requireUuid(input.conversationId, "conversationId").toLowerCase();
  const upTo = input.upToId === undefined || input.upToId === null ? null : requireBigintId(input.upToId);
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${SOCIAL_TRANSACTION_TIMEOUT}'`);
    const row = await loadParticipantConversation(client, conversationId, userId, true);
    if (!row) throw new SocialError("resource_not_found");
    const latest = await client.query<{ id: string | null }>("SELECT max(id)::text AS id FROM messages WHERE conversation_id = $1::uuid", [conversationId]);
    const maxId = latest.rows[0].id === null ? 0 : Number(latest.rows[0].id);
    const target = Math.min(upTo === null ? maxId : upTo, maxId);
    const column = row.buyer_id === userId ? "buyer_last_read_id" : "seller_last_read_id";
    await client.query(`UPDATE conversations SET ${column} = GREATEST(${column}, $2::bigint) WHERE id = $1::uuid`, [conversationId, target]);
    const remaining = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1::uuid AND m.sender_id <> $2::uuid AND m.id > c.${column}`,
      [conversationId, userId],
    );
    if (remaining.rows[0].n === 0) {
      await client.query(
        "UPDATE notifications SET read_at = clock_timestamp() WHERE user_id = $1::uuid AND conversation_id = $2::uuid AND kind = 'new_message' AND read_at IS NULL",
        [userId, conversationId],
      );
    }
    const total = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM conversations c
        WHERE (c.buyer_id = $1::uuid OR c.seller_id = $1::uuid)
          AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> $1::uuid
                       AND m.id > CASE WHEN c.buyer_id = $1::uuid THEN c.buyer_last_read_id ELSE c.seller_last_read_id END)`,
      [userId],
    );
    return { unreadCount: total.rows[0].n };
  }, pool);
}

// ───────────── envoi ─────────────

/**
 * Envoie un message. Ordre des contrôles : texte (avant toute connexion à la base) ; puis, dans UNE transaction sous le verrou de l'expéditeur puis celui de la conversation :
 * participant (sinon 404 indiscernable), limite de 30 par minute, limite de 300 par jour UTC. Le message, la date du dernier message, l'état de lecture de l'expéditeur et la
 * notification de l'autre participant sont écrits ensemble.
 */
export async function sendMessage(input: {
  pool: Pool;
  senderId: string;
  conversationId: string;
  body: unknown;
  /** Faux : aucune notification « nouveau message » (historique de démonstration écrit par `demo:seed`). Jamais passé par une route HTTP. */
  notify?: boolean;
}): Promise<ConversationMessage> {
  const pool = requireTransactionPool(input.pool);
  const senderId = requireUuid(input.senderId, "senderId").toLowerCase();
  const conversationId = requireUuid(input.conversationId, "conversationId").toLowerCase();
  const checked = checkMessageBody(input.body);
  if (!checked.ok) throw new SocialError("invalid_message");
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${SOCIAL_TRANSACTION_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [MESSAGE_SEND_LOCK_NAMESPACE, senderId]);
    const conversation = await loadParticipantConversation(client, conversationId, senderId, true);
    if (!conversation) throw new SocialError("resource_not_found");

    const usage = await client.query<{ minute_count: number; oldest_minute: Date | null; day_count: number; now: Date }>(
      `SELECT count(*) FILTER (WHERE created_at > clock_timestamp() - interval '1 minute')::int AS minute_count,
              min(created_at) FILTER (WHERE created_at > clock_timestamp() - interval '1 minute') AS oldest_minute,
              count(*)::int AS day_count, clock_timestamp() AS now
         FROM messages
        WHERE sender_id = $1::uuid AND created_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
      [senderId],
    );
    const counts = usage.rows[0];
    if (counts.minute_count >= MESSAGES_PER_MINUTE) {
      const oldest = counts.oldest_minute?.getTime() ?? counts.now.getTime();
      throw new SocialError("rate_limited", Math.max(1, Math.ceil((oldest + 60_000 - counts.now.getTime()) / 1000)));
    }
    if (counts.day_count >= MESSAGES_PER_DAY) throw new SocialError("rate_limited", secondsUntilNextUtcDay(counts.now));

    const inserted = await client.query<{ id: string; created_at: Date }>(
      "INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1::uuid, $2::uuid, $3::text) RETURNING id::text AS id, created_at",
      [conversationId, senderId, checked.body],
    );
    const message = inserted.rows[0];
    const senderIsBuyer = conversation.buyer_id === senderId;
    const readColumn = senderIsBuyer ? "buyer_last_read_id" : "seller_last_read_id";
    await client.query(
      `UPDATE conversations SET last_message_at = $2::timestamptz, ${readColumn} = GREATEST(${readColumn}, $3::bigint) WHERE id = $1::uuid`,
      [conversationId, message.created_at, Number(message.id)],
    );
    // Notification de l'AUTRE participant : une seule par conversation tant qu'elle n'est pas lue.
    if (input.notify !== false) await client.query(
      `INSERT INTO notifications (user_id, kind, demand_id, offer_id, conversation_id, title)
       VALUES ($1::uuid, 'new_message', $2::uuid, $3::uuid, $4::uuid, $5::text)
       ON CONFLICT (user_id, conversation_id) WHERE kind = 'new_message' AND read_at IS NULL DO NOTHING`,
      [senderIsBuyer ? conversation.seller_id : conversation.buyer_id, conversation.demand_id, conversation.offer_id, conversationId, buildNotificationTitle(conversation)],
    );
    return { id: Number(message.id), mine: true, body: checked.body, createdAt: message.created_at };
  }, pool);
}
