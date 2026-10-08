import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction } from "../postgres/client";
import {
  MEDIA_OFFER_LOCK_NAMESPACE, MEDIA_TRANSACTION_TIMEOUT, MEDIA_UPLOAD_LOCK_NAMESPACE, PHOTO_MAX_PER_OFFER, PHOTO_UPLOADS_PER_HOUR, PHOTO_UPLOAD_LOG_RETENTION_HOURS,
} from "./config";
import { MediaError } from "./errors";
import type { ImageMime, SanitizedImage } from "./image";
import type { MediaStore } from "./store";

/**
 * Photos d'une annonce (lot PH1) : envoi, liste, ordre, suppression, journal des fichiers orphelins. Les règles sont tenues DANS LE CODE (ici) et EN BASE (migration 0022 : position 0 à
 * 5 unique par annonce, empreinte unique par annonce, dimensions et poids bornés). Toutes les écritures d'UNE annonce passent par un verrou consultatif sur l'annonce : deux envois
 * simultanés sur la dernière place se serrent la main au lieu de se dépasser.
 *
 * Ordre des opérations (un fichier ne doit jamais manquer à une ligne) :
 *  - envoi : le fichier est écrit, PUIS la ligne ; si la transaction échoue, le fichier est retiré (jamais s'il y a quand même une ligne) ou, à défaut, journalisé ;
 *  - suppression : la ligne est supprimée dans une transaction ; le FICHIER n'est supprimé qu'après la validation, et un fichier qu'on n'a pas pu supprimer est journalisé
 *    (`media_orphans`) puis repris par `media:gc`.
 */

export interface PhotoRecord {
  id: string;
  offerId: string;
  position: number;
  mime: ImageMime;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  createdAt: Date;
}

interface PhotoRow {
  id: string;
  offer_id: string;
  position: number;
  mime: ImageMime;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  created_at: Date;
}

export const PHOTO_COLUMNS = "id, offer_id, position, mime, bytes, width, height, sha256, created_at";

export function mapPhoto(row: PhotoRow): PhotoRecord {
  return { id: row.id, offerId: row.offer_id, position: row.position, mime: row.mime, bytes: row.bytes, width: row.width, height: row.height, sha256: row.sha256, createdAt: row.created_at };
}

/** Points d'injection RÉSERVÉS AUX ESSAIS (échec de la transaction après l'écriture, observation des étapes). */
export interface PhotoHooks {
  /** Appelé dans la transaction, après les écritures et avant la validation. */
  beforeCommit?: () => Promise<void>;
  /** Journal serveur : ne reçoit QU'UN code. */
  log?: (code: string) => void;
}

const LOG_CODE = /^[A-Za-z0-9_]{1,40}$/;

function logCode(hooks: PhotoHooks | undefined, code: string): void {
  try {
    if (hooks?.log) hooks.log(code);
    else if (LOG_CODE.test(code)) console.error(`[media] ${code}`);
  } catch {
    // Un journal défaillant ne change jamais le résultat.
  }
}

async function lockOffer(client: PoolClient, offerId: string): Promise<void> {
  await client.query(`SET LOCAL statement_timeout = '${MEDIA_TRANSACTION_TIMEOUT}'`);
  await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [MEDIA_OFFER_LOCK_NAMESPACE, offerId]);
}

interface Queryable {
  query: PoolClient["query"];
}

/** L'annonce est celle de cet utilisateur : sinon `resource_not_found` (404 indiscernable : annonce inconnue ou d'un autre). Une annonce archivée n'accepte plus d'ajout ni de tri (`forWrite`). */
export async function assertOfferOwner(client: Queryable, ownerId: string, offerId: string, options: { forWrite: boolean }): Promise<void> {
  const found = await client.query<{ owner_id: string; archived: boolean }>(
    "SELECT owner_id, (status = 'archived' OR archived_at IS NOT NULL) AS archived FROM offers WHERE id = $1::uuid",
    [offerId],
  );
  const row = found.rows[0];
  if (!row || row.owner_id !== ownerId) throw new MediaError("resource_not_found");
  if (options.forWrite && row.archived) throw new MediaError("resource_archived");
}

/** Annonce du propriétaire, sans rien écrire (la route vérifie avant de lire un corps de plusieurs Mo). */
export async function checkOfferOwner(input: { pool: Pool; ownerId: string; offerId: string; forWrite: boolean }): Promise<void> {
  const pool = requireTransactionPool(input.pool);
  await assertOfferOwner(pool, requireUuid(input.ownerId, "ownerId").toLowerCase(), requireUuid(input.offerId, "offerId").toLowerCase(), { forWrite: input.forWrite });
}

/**
 * Prend UNE place de la limite d'envoi du vendeur (30 par heure glissante, `PHOTO_UPLOADS_PER_HOUR`), sous un verrou par vendeur : la limite est exacte. Tout envoi compte, accepté
 * ou refusé pour son fichier, rejeu compris : supprimer une photo ne rend pas la place. `rate_limited` porte le délai avant que la plus ancienne place sorte de l'heure.
 */
export async function consumeUploadSlot(input: { pool: Pool; sellerId: string; limit?: number }): Promise<void> {
  const pool = requireTransactionPool(input.pool);
  const sellerId = requireUuid(input.sellerId, "sellerId").toLowerCase();
  const limit = input.limit ?? PHOTO_UPLOADS_PER_HOUR;
  await withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${MEDIA_TRANSACTION_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [MEDIA_UPLOAD_LOCK_NAMESPACE, sellerId]);
    await client.query(
      "DELETE FROM offer_photo_uploads WHERE seller_id = $1::uuid AND uploaded_at < clock_timestamp() - make_interval(hours => $2::int)",
      [sellerId, PHOTO_UPLOAD_LOG_RETENTION_HOURS],
    );
    const recent = await client.query<{ n: number; wait_seconds: number | null }>(
      `SELECT count(*)::int AS n,
              ceil(extract(epoch FROM (min(uploaded_at) + interval '1 hour' - clock_timestamp())))::int AS wait_seconds
         FROM offer_photo_uploads
        WHERE seller_id = $1::uuid AND uploaded_at > clock_timestamp() - interval '1 hour'`,
      [sellerId],
    );
    if (recent.rows[0].n >= limit) throw new MediaError("rate_limited", Math.max(1, recent.rows[0].wait_seconds ?? 60));
    await client.query("INSERT INTO offer_photo_uploads (seller_id) VALUES ($1::uuid)", [sellerId]);
  }, pool);
}

/** Journal des fichiers orphelins (`media_orphans`) : un fichier qu'on n'a pas pu retirer. Ne lève jamais (le code seul est journalisé si l'écriture échoue). */
export async function journalOrphan(pool: Pool, key: string, reason: "delete_failed" | "write_failed", hooks?: PhotoHooks): Promise<void> {
  try {
    await pool.query("INSERT INTO media_orphans (storage_key, reason) VALUES ($1, $2)", [key, reason]);
  } catch {
    logCode(hooks, `orphan_journal_failed`);
  }
}

async function removeFile(pool: Pool, store: MediaStore, key: string, reason: "delete_failed" | "write_failed", hooks?: PhotoHooks): Promise<void> {
  try {
    await store.delete(key);
  } catch {
    logCode(hooks, "orphan_file");
    await journalOrphan(pool, key, reason, hooks);
  }
}

export interface UploadResult {
  photo: PhotoRecord;
  /** Faux pour un rejeu : la même photo (même empreinte après nettoyage) était déjà sur l'annonce. */
  created: boolean;
}

export async function uploadPhoto(input: {
  pool: Pool;
  store: MediaStore;
  ownerId: string;
  offerId: string;
  image: SanitizedImage;
  hooks?: PhotoHooks;
}): Promise<UploadResult> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const { image, store, hooks } = input;
  // L'empreinte est calculée sur le fichier NETTOYÉ : deux envois de la même photo avec des métadonnées différentes sont le même fichier.
  const sha256 = createHash("sha256").update(image.bytes).digest("hex");
  const photoId = randomUUID();
  let written = false;
  try {
    return await withPostgresTransaction(async (client): Promise<UploadResult> => {
      await lockOffer(client, offerId);
      await assertOfferOwner(client, ownerId, offerId, { forWrite: true });
      const replay = await client.query<PhotoRow>(`SELECT ${PHOTO_COLUMNS} FROM offer_photos WHERE offer_id = $1::uuid AND sha256 = $2`, [offerId, sha256]);
      if (replay.rows[0]) return { photo: mapPhoto(replay.rows[0]), created: false };
      const free = await client.query<{ position: number | null; n: number }>(
        `SELECT (SELECT min(p) FROM generate_series(0, $2::int - 1) AS p WHERE p NOT IN (SELECT position FROM offer_photos WHERE offer_id = $1::uuid)) AS position,
                (SELECT count(*)::int FROM offer_photos WHERE offer_id = $1::uuid) AS n`,
        [offerId, PHOTO_MAX_PER_OFFER],
      );
      if (free.rows[0].n >= PHOTO_MAX_PER_OFFER || free.rows[0].position === null) throw new MediaError("photo_limit");
      await store.put(photoId, image.bytes);
      written = true;
      const inserted = await client.query<PhotoRow>(
        `INSERT INTO offer_photos (id, offer_id, position, mime, bytes, width, height, sha256)
         VALUES ($1::uuid, $2::uuid, $3::int, $4, $5::int, $6::int, $7::int, $8) RETURNING ${PHOTO_COLUMNS}`,
        [photoId, offerId, free.rows[0].position, image.mime, image.bytes.byteLength, image.width, image.height, sha256],
      );
      await hooks?.beforeCommit?.();
      return { photo: mapPhoto(inserted.rows[0]), created: true };
    }, pool);
  } catch (error) {
    if (written) {
      // La transaction n'a pas abouti : le fichier est retiré, SAUF si la ligne existe quand même (validation dont la réponse s'est perdue) ; en cas de doute, il est gardé et journalisé.
      let rowExists: boolean | null = null;
      try {
        rowExists = ((await pool.query("SELECT 1 FROM offer_photos WHERE id = $1::uuid", [photoId])).rowCount ?? 0) > 0;
      } catch {
        rowExists = null;
      }
      if (rowExists === false) await removeFile(pool, store, photoId, "write_failed", hooks);
      else if (rowExists === null) await journalOrphan(pool, photoId, "write_failed", hooks);
    }
    throw error;
  }
}

/** Photos de l'annonce du propriétaire, dans l'ordre (couverture en premier). */
export async function listOwnerPhotos(input: { pool: Pool; ownerId: string; offerId: string }): Promise<PhotoRecord[]> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  await assertOfferOwner(pool, ownerId, offerId, { forWrite: false });
  const rows = await pool.query<PhotoRow>(`SELECT ${PHOTO_COLUMNS} FROM offer_photos WHERE offer_id = $1::uuid ORDER BY position`, [offerId]);
  return rows.rows.map(mapPhoto);
}

/** Positions de nouveau consécutives (0, 1, 2…) dans l'ordre actuel : la contrainte d'unicité est différée, aucun échange intermédiaire ne la heurte. */
export async function compactPositions(client: Queryable, offerId: string): Promise<void> {
  await client.query(
    `UPDATE offer_photos p SET position = r.next
       FROM (SELECT id, (row_number() OVER (ORDER BY position, created_at, id) - 1)::int AS next FROM offer_photos WHERE offer_id = $1::uuid) r
      WHERE p.id = r.id AND p.position <> r.next`,
    [offerId],
  );
}

/** Nouvel ordre : la liste doit être EXACTEMENT les photos de l'annonce (mêmes identifiants, aucun doublon) ; la première devient la couverture. */
export async function reorderPhotos(input: { pool: Pool; ownerId: string; offerId: string; order: readonly string[] }): Promise<PhotoRecord[]> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  if (!Array.isArray(input.order) || input.order.length > PHOTO_MAX_PER_OFFER || input.order.some((id) => typeof id !== "string")) throw new MediaError("invalid_request");
  const order = input.order.map((id) => id.toLowerCase());
  return withPostgresTransaction(async (client) => {
    await lockOffer(client, offerId);
    await assertOfferOwner(client, ownerId, offerId, { forWrite: true });
    const current = await client.query<{ id: string }>("SELECT id FROM offer_photos WHERE offer_id = $1::uuid", [offerId]);
    const known = new Set(current.rows.map((row) => row.id));
    if (order.length !== known.size || new Set(order).size !== order.length || order.some((id) => !known.has(id))) throw new MediaError("invalid_request");
    if (order.length > 0) {
      await client.query(
        `UPDATE offer_photos p SET position = v.position
           FROM unnest($2::uuid[], $3::int[]) AS v(id, position)
          WHERE p.id = v.id AND p.offer_id = $1::uuid`,
        [offerId, order, order.map((_, index) => index)],
      );
    }
    const rows = await client.query<PhotoRow>(`SELECT ${PHOTO_COLUMNS} FROM offer_photos WHERE offer_id = $1::uuid ORDER BY position`, [offerId]);
    return rows.rows.map(mapPhoto);
  }, pool);
}

export interface DeleteResult {
  removed: boolean;
  photos: PhotoRecord[];
}

/**
 * Supprime une photo : la LIGNE dans une transaction (positions recompactées), le FICHIER après la validation. Un fichier impossible à supprimer est journalisé (`media_orphans`).
 * Une photo déjà absente de l'annonce du propriétaire n'est pas une erreur (`removed: false` : une suppression rejouée).
 */
export async function deletePhoto(input: { pool: Pool; store: MediaStore; ownerId: string; offerId: string; photoId: string; hooks?: PhotoHooks }): Promise<DeleteResult> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const photoId = requireUuid(input.photoId, "photoId").toLowerCase();
  const outcome = await withPostgresTransaction(async (client) => {
    await lockOffer(client, offerId);
    await assertOfferOwner(client, ownerId, offerId, { forWrite: false });
    const deleted = await client.query("DELETE FROM offer_photos WHERE id = $1::uuid AND offer_id = $2::uuid RETURNING id", [photoId, offerId]);
    if (!deleted.rowCount) return { removed: false, photos: [] as PhotoRecord[] };
    await compactPositions(client, offerId);
    await input.hooks?.beforeCommit?.();
    const rows = await client.query<PhotoRow>(`SELECT ${PHOTO_COLUMNS} FROM offer_photos WHERE offer_id = $1::uuid ORDER BY position`, [offerId]);
    return { removed: true, photos: rows.rows.map(mapPhoto) };
  }, pool);
  if (outcome.removed) await removeFile(pool, input.store, photoId, "delete_failed", input.hooks);
  else outcome.photos = await listOwnerPhotos({ pool, ownerId, offerId });
  return outcome;
}

/** Supprime la ligne d'une photo dont le fichier manque (utilisé par `media:gc`) et recompacte les positions de son annonce. */
export async function removePhotoRowWithoutFile(pool: Pool, photoId: string): Promise<boolean> {
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${MEDIA_TRANSACTION_TIMEOUT}'`);
    const found = await client.query<{ offer_id: string }>("SELECT offer_id FROM offer_photos WHERE id = $1::uuid", [photoId]);
    if (!found.rows[0]) return false;
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [MEDIA_OFFER_LOCK_NAMESPACE, found.rows[0].offer_id]);
    const deleted = await client.query("DELETE FROM offer_photos WHERE id = $1::uuid RETURNING id", [photoId]);
    if (!deleted.rowCount) return false;
    await compactPositions(client, found.rows[0].offer_id);
    return true;
  }, pool);
}
