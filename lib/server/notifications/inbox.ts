import "server-only";

import type { Pool } from "pg";
import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import {
  NOTIFICATIONS_PAGE_DEFAULT_LIMIT,
  NOTIFICATIONS_PAGE_MAX_LIMIT,
  NOTIFICATIONS_READ_MAX_IDS,
} from "./config";
import { looksLikePhoneNumber } from "../../phone-text";
import { EXTERNAL_SOURCE_FALLBACK, EXTERNAL_TITLE_FALLBACK, TITLE_FALLBACK, demandLink, offerLink, type NotificationPrice } from "./content";

/**
 * Lecture des notifications DANS l'application (lot N1) : pagination par curseur (plus récentes d'abord), compteur de non-lues, « marquer comme lu ».
 * Tout est limité à l'utilisateur de la session ; une notification d'autrui ou inconnue est « introuvable » (la même erreur). DTO en liste blanche :
 * titre, prix, lien, dates. Jamais de téléphone, d'identifiant du vendeur ni de texte libre. Voir NOTIFICATIONS.md.
 */

export type NotificationKind = "new_match" | "new_matches_digest" | "new_message" | "mission_coverage" | "new_external_match" | "active_search_expiring";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  /** Titre de l'annonce (new_match, new_message) ou null (résumé : le texte « N nouvelles annonces » est construit à partir de `count`). */
  title: string | null;
  price: NotificationPrice | null;
  /** Résumé seulement : nombre d'annonces au-delà du plafond du jour. */
  count: number | null;
  demandId: string;
  /** new_match : la fiche de l'annonce, dans le contexte du besoin ; résumé : le besoin ; new_message : la conversation (`/messages/{id}`) ; mission_coverage : la mission (`/missions/{id}`). */
  offerId: string | null;
  link: string;
  createdAt: Date;
  readAt: Date | null;
  /** new_external_match seulement (lot RA1) : nom de la source de l'annonce d'un autre site. Absent des autres genres. */
  sourceName?: string;
  /** active_search_expiring seulement (lots RA1 et RA1-bis) : fin de la CHAÎNE de périodes de recherche active au moment de la lecture (une prolongation payée après l'avis la repousse). Absent des autres genres. */
  endsAt?: Date;
}

export interface NotificationsPage {
  items: NotificationItem[];
  nextCursor: string | null;
  unreadCount: number;
}

const CURSOR_AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function encodeNotificationCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

/** Curseur opaque (instant à la microseconde + identifiant) : toute autre forme est refusée. */
export function decodeNotificationCursor(cursor: unknown): { createdAt: string; id: string } {
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(cursor)) throw new CatalogValidationError("cursor invalide.");
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (parts.length !== 2 || !CURSOR_AT.test(parts[0]) || !UUID_LOWER.test(parts[1])) throw new CatalogValidationError("cursor invalide.");
  if (encodeNotificationCursor(parts[0], parts[1]) !== cursor) throw new CatalogValidationError("cursor invalide.");
  if (Number.isNaN(new Date(parts[0]).getTime())) throw new CatalogValidationError("cursor invalide.");
  return { createdAt: parts[0], id: parts[1] };
}

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  title: string | null;
  price_amount: string | null;
  price_currency: string | null;
  item_count: number | null;
  demand_id: string;
  offer_id: string | null;
  conversation_id: string | null;
  mission_id: string | null;
  source_name: string | null;
  search_ends_at: Date | null;
  created_at: Date;
  read_at: Date | null;
  cursor_at: string;
}

function mapRow(row: NotificationRow): NotificationItem {
  if (row.kind === "mission_coverage" && row.mission_id !== null) {
    // « La couverture de votre mission a augmenté » (lot MV1) : titre assemblé par le serveur (« Apple iPhone 12 : 7 sur 20 », parties nettoyées comme tout titre), quantité couverte
    // dans `count`, lien vers la mission. Jamais de budget, de vendeur ni de texte libre.
    return {
      id: row.id,
      kind: row.kind,
      title: row.title !== null && looksLikePhoneNumber(row.title) ? TITLE_FALLBACK : row.title,
      price: null,
      count: row.item_count,
      demandId: row.demand_id,
      offerId: null,
      link: `/missions/${row.mission_id}`,
      createdAt: row.created_at,
      readAt: row.read_at,
    };
  }
  if (row.kind === "new_external_match") {
    // Annonce d'un AUTRE SITE (recherche active) : titre nettoyé, prix, nom de la source ; le lien est la page du BESOIN (jamais l'URL de l'annonce externe).
    const amount = row.price_amount === null ? null : Number(row.price_amount);
    return {
      id: row.id,
      kind: row.kind,
      title: row.title !== null && !looksLikePhoneNumber(row.title) ? row.title : EXTERNAL_TITLE_FALLBACK,
      price: amount !== null && Number.isSafeInteger(amount) && row.price_currency !== null ? { amount, currency: row.price_currency } : null,
      count: null,
      demandId: row.demand_id,
      offerId: null,
      link: demandLink(row.demand_id),
      createdAt: row.created_at,
      readAt: row.read_at,
      sourceName: row.source_name !== null && !looksLikePhoneNumber(row.source_name) ? row.source_name : EXTERNAL_SOURCE_FALLBACK,
    };
  }
  if (row.kind === "active_search_expiring" && row.search_ends_at !== null) {
    // Avis d'échéance de la recherche active : aucune donnée d'annonce.
    return { id: row.id, kind: row.kind, title: null, price: null, count: null, demandId: row.demand_id, offerId: null, link: demandLink(row.demand_id), createdAt: row.created_at, readAt: row.read_at, endsAt: row.search_ends_at };
  }
  if (row.kind === "new_message" && row.conversation_id !== null) {
    // « Nouveau message » (lot D2) : titre de l'annonce (liste blanche), lien vers la conversation. Jamais le texte du message ni l'identité de l'autre participant.
    return {
      id: row.id,
      kind: row.kind,
      title: row.title !== null && looksLikePhoneNumber(row.title) ? TITLE_FALLBACK : row.title,
      price: null,
      count: null,
      demandId: row.demand_id,
      offerId: null,
      link: `/messages/${row.conversation_id}`,
      createdAt: row.created_at,
      readAt: row.read_at,
    };
  }
  const isMatch = row.kind === "new_match" && row.offer_id !== null;
  const amount = row.price_amount === null ? null : Number(row.price_amount);
  return {
    id: row.id,
    kind: row.kind,
    // Défense à la lecture : un titre déjà enregistré qui ressemble à un numéro (écrit sous une règle plus ancienne) n'est jamais servi.
    title: isMatch ? (row.title !== null && looksLikePhoneNumber(row.title) ? TITLE_FALLBACK : row.title) : null,
    price: amount !== null && Number.isSafeInteger(amount) && row.price_currency !== null ? { amount, currency: row.price_currency } : null,
    count: row.kind === "new_matches_digest" ? row.item_count : null,
    demandId: row.demand_id,
    offerId: isMatch ? row.offer_id : null,
    link: isMatch ? offerLink(row.demand_id, row.offer_id as string) : demandLink(row.demand_id),
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

/** Une page de notifications de l'utilisateur (plus récentes d'abord) et le nombre TOTAL de non-lues, lus dans un instantané. */
export async function listNotifications(input: { pool: Pool; userId: string; limit?: number; cursor?: string | null }): Promise<NotificationsPage> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const limit = input.limit ?? NOTIFICATIONS_PAGE_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > NOTIFICATIONS_PAGE_MAX_LIMIT) {
    throw new CatalogValidationError(`limit doit être un entier compris entre 1 et ${NOTIFICATIONS_PAGE_MAX_LIMIT}.`);
  }
  const cursor = input.cursor === undefined || input.cursor === null ? null : decodeNotificationCursor(input.cursor);

  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const rows = await client.query<NotificationRow>(
      `SELECT n.id, n.kind, n.title, n.price_amount::text AS price_amount, n.price_currency, n.item_count, n.demand_id, n.offer_id, n.conversation_id, n.mission_id, n.source_name,
              active_search_chain_end(n.active_search_id) AS search_ends_at, n.created_at, n.read_at,
              to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
         FROM notifications n
        WHERE n.user_id = $1::uuid
          AND ($2::timestamptz IS NULL OR (n.created_at, n.id) < ($2::timestamptz, $3::uuid))
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT $4::int`,
      [userId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const unread = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1::uuid AND read_at IS NULL",
      [userId],
    );
    await client.query("COMMIT");
    const page = rows.rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(mapRow),
      nextCursor: rows.rows.length > limit && last ? encodeNotificationCursor(last.cursor_at, last.id) : null,
      unreadCount: unread.rows[0].n,
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* conserver l'erreur utile */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * `all` : toutes les notifications créées AVANT OU À `upTo` (la date de la plus récente notification AFFICHÉE, à la milliseconde : les dates de l'API n'ont pas de
 * microsecondes). Celles arrivées après le chargement de l'écran restent non lues.
 */
export type MarkReadTarget = { all: true; upTo: Date } | { ids: readonly string[] };

/**
 * Marque comme lues des notifications DE L'UTILISATEUR : une liste d'identifiants (1 à 100, tous à lui, sinon aucune n'est touchée et l'erreur est « introuvable » :
 * la même pour une notification inconnue et pour celle d'autrui) ou « tout ce qui a été vu » (créé avant ou à `upTo`). Idempotent : une notification déjà lue garde sa
 * date de lecture. Renvoie le nombre de notifications nouvellement marquées et le nombre de non-lues restantes.
 */
export async function markNotificationsRead(input: { pool: Pool; userId: string; target: MarkReadTarget }): Promise<{ marked: number; unreadCount: number }> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  let ids: string[] | null = null;
  let upTo: Date | null = null;
  if ("all" in input.target) {
    upTo = input.target.upTo;
    if (!(upTo instanceof Date) || Number.isNaN(upTo.getTime())) throw new CatalogValidationError("upTo invalide.");
  } else {
    if (!("ids" in input.target)) throw new CatalogValidationError("Cible invalide.");
    if (!Array.isArray(input.target.ids) || input.target.ids.length < 1 || input.target.ids.length > NOTIFICATIONS_READ_MAX_IDS) {
      throw new CatalogValidationError(`ids doit contenir de 1 à ${NOTIFICATIONS_READ_MAX_IDS} identifiants.`);
    }
    ids = [...new Set(input.target.ids.map((id) => requireUuid(id, "id").toLowerCase()))];
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    let marked: number;
    if (ids === null) {
      // « Tout ce qui a été vu » : créé avant ou à `upTo` (à la milliseconde : strictement avant `upTo` + 1 ms). Ce qui est arrivé après reste non lu.
      const result = await client.query(
        `UPDATE notifications SET read_at = clock_timestamp()
          WHERE user_id = $1::uuid AND read_at IS NULL AND created_at < $2::timestamptz + interval '1 millisecond'`,
        [userId, upTo],
      );
      marked = result.rowCount ?? 0;
    } else {
      const owned = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1::uuid AND id = ANY($2::uuid[])",
        [userId, ids],
      );
      if (owned.rows[0].n !== ids.length) throw new CatalogNotFoundError("notification");
      const result = await client.query(
        "UPDATE notifications SET read_at = clock_timestamp() WHERE user_id = $1::uuid AND id = ANY($2::uuid[]) AND read_at IS NULL",
        [userId, ids],
      );
      marked = result.rowCount ?? 0;
    }
    const unread = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1::uuid AND read_at IS NULL", [userId]);
    await client.query("COMMIT");
    return { marked, unreadCount: unread.rows[0].n };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* conserver l'erreur utile */ }
    throw error;
  } finally {
    client.release();
  }
}
