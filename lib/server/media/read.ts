import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import {
  MATCHING_CURRENT_CLOCK_CTE,
  MATCHING_FRESHNESS_FROM,
  buildMatchingFreshnessPredicate,
  resolveMatchingFreshnessParams,
} from "../matching/persistence";
import type { SqlExecutor } from "../postgres/client";
import type { ImageMime } from "./image";
import type { MediaStore } from "./store";

/**
 * Lecture des photos (lot PH1) : QUI peut voir un fichier, et les références (identifiants) que les écrans de l'acheteur et du vendeur reçoivent.
 *
 * Droit de voir une photo = droit de voir l'annonce : son propriétaire ; un administrateur actif (lecture seule) ; un acheteur dont un besoin ACTIF a cette annonce parmi ses
 * correspondances CONFIRMÉES ET FRAÎCHES (le prédicat de la fiche, de la liste des résultats et du contact : `buildMatchingFreshnessPredicate`, qui exige l'annonce publiée,
 * disponible, de propriétaires actifs). Pour tous les autres (annonce inconnue, d'un autre, hors correspondance, dépubliée, vendue, vendeur suspendu, visiteur sans session) la
 * réponse est la MÊME : `null`, que la route traduit en 404.
 */

export interface ServedPhoto {
  mime: ImageMime;
  bytes: Uint8Array;
}

interface AccessRow {
  offer_id: string;
  mime: ImageMime;
  size: number;
  is_owner: boolean;
  is_admin: boolean;
}

export async function readPhotoForViewer(input: { pool: Pool; store: MediaStore; viewerId: string; photoId: string; log?: (code: string) => void }): Promise<ServedPhoto | null> {
  const pool = requireTransactionPool(input.pool);
  const viewerId = requireUuid(input.viewerId, "viewerId").toLowerCase();
  const photoId = requireUuid(input.photoId, "photoId").toLowerCase();
  const found = await pool.query<AccessRow>(
    `SELECT p.offer_id, p.mime, p.bytes AS size,
            (o.owner_id = $2::uuid) AS is_owner,
            EXISTS (SELECT 1 FROM users u WHERE u.id = $2::uuid AND u.is_admin = TRUE AND u.status = 'active') AS is_admin
       FROM offer_photos p JOIN offers o ON o.id = p.offer_id
      WHERE p.id = $1::uuid`,
    [photoId, viewerId],
  );
  const row = found.rows[0];
  if (!row) return null;
  let allowed = row.is_owner || row.is_admin;
  if (!allowed) {
    const freshness = buildMatchingFreshnessPredicate(resolveMatchingFreshnessParams(), 3);
    const access = await pool.query(
      `WITH ${MATCHING_CURRENT_CLOCK_CTE}
       SELECT 1
         FROM ${MATCHING_FRESHNESS_FROM}
        WHERE e.offer_id = $1::uuid AND d.owner_id = $2::uuid AND e.is_confirmed_match = TRUE
          AND ${freshness.conditions.join("\n          AND ")}
        LIMIT 1`,
      [row.offer_id, viewerId, ...freshness.values],
    );
    allowed = (access.rowCount ?? 0) > 0;
  }
  if (!allowed) return null;
  const bytes = await input.store.get(photoId);
  if (bytes === null || bytes.byteLength !== row.size) {
    // Ligne sans fichier (ou fichier tronqué) : jamais servi ; `media:gc` signale et nettoie.
    try {
      input.log?.(bytes === null ? "photo_file_missing" : "photo_file_size_mismatch");
    } catch {
      // Journal défaillant : sans effet.
    }
    return null;
  }
  return { mime: row.mime, bytes };
}

/** Référence publique d'une photo pour l'acheteur : l'identifiant (l'URL est `/api/media/{id}`) et ses dimensions (pour réserver la place de l'image). */
export interface PublicPhoto {
  id: string;
  width: number;
  height: number;
}

/**
 * Photos d'UNE annonce, dans l'ordre. Ne vérifie AUCUN droit : l'appelant a déjà prouvé l'accès (fiche d'une correspondance, annonce de l'utilisateur lui-même).
 */
export async function readOfferPhotoRefs(executor: SqlExecutor, offerId: string): Promise<PublicPhoto[]> {
  const rows = await executor.query<{ id: string; width: number; height: number }>(
    "SELECT id, width, height FROM offer_photos WHERE offer_id = $1::uuid ORDER BY position",
    [offerId],
  );
  return rows.rows.map((row) => ({ id: row.id, width: row.width, height: row.height }));
}

/** Photo de COUVERTURE (position 0) de chaque annonce de la liste qui en a une ; même remarque : aucun droit vérifié ici. */
export async function readCoverPhotoIds(executor: SqlExecutor, offerIds: readonly string[]): Promise<Map<string, string>> {
  const covers = new Map<string, string>();
  if (offerIds.length === 0) return covers;
  const rows = await executor.query<{ offer_id: string; id: string }>(
    "SELECT offer_id, id FROM offer_photos WHERE offer_id = ANY($1::uuid[]) AND position = 0",
    [[...offerIds]],
  );
  for (const row of rows.rows) covers.set(row.offer_id, row.id);
  return covers;
}


// ───────────── lectures « décor » : une photo ne fait JAMAIS échouer l'écran qui la porte ─────────────

/** Comme `readCoverPhotoIds`, mais une erreur donne une liste vide : les écrans retombent sur l'icône d'avant les photos. */
export async function readCoverPhotoIdsSafely(executor: SqlExecutor, offerIds: readonly string[]): Promise<Map<string, string>> {
  try {
    return await readCoverPhotoIds(executor, offerIds);
  } catch {
    return new Map();
  }
}

/** Comme `readOfferPhotoRefs`, mais une erreur donne une liste vide (la fiche s'affiche sans galerie). */
export async function readOfferPhotoRefsSafely(executor: SqlExecutor, offerId: string): Promise<PublicPhoto[]> {
  try {
    return await readOfferPhotoRefs(executor, offerId);
  } catch {
    return [];
  }
}

/** Ajoute `coverPhotoId` aux éléments dont l'annonce (`candidateId`) a des photos ; les autres n'ont pas la clé. L'appelant a déjà prouvé l'accès à ces annonces. */
export async function attachCoverPhotos(executor: SqlExecutor, items: Array<{ candidateId: string; coverPhotoId?: string }>): Promise<void> {
  if (items.length === 0) return;
  const covers = await readCoverPhotoIdsSafely(executor, items.map((item) => item.candidateId));
  for (const item of items) {
    const cover = covers.get(item.candidateId);
    if (cover !== undefined) item.coverPhotoId = cover;
  }
}
