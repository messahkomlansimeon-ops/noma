import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool } from "../catalog/validation";
import { MEDIA_GC_DEFAULT_MIN_AGE_SECONDS, MEDIA_GC_MIN_AGE_VARIABLE, MEDIA_GC_MISSING_MAX_COUNT, MEDIA_GC_MISSING_MAX_PERCENT } from "./config";
import { removePhotoRowWithoutFile } from "./photos";
import type { MediaStore } from "./store";

/**
 * Purge des photos (`npm run media:gc`, lot PH1) : supprime les FICHIERS sans ligne en base (envois interrompus, suppressions dont le fichier n'a pas pu partir) et les LIGNES sans fichier
 * (fichier perdu). Simulation par défaut. Garde-fous : refus hors développement et essai sauf autorisation explicite en production (`purgeEnvironmentRefusal`, partagé avec
 * `metrics:purge`) ; un fichier n'est jamais supprimé avant `minAgeSeconds` (10 minutes : un envoi en cours a écrit son fichier avant de valider sa ligne) ; seuls les fichiers aux noms
 * que ce code crée (UUID minuscule, ou fichier temporaire) sont jamais touchés : un dossier mal désigné n'est pas vidé de ses autres fichiers.
 * GARDE CONTRE UN DOSSIER MAL DÉSIGNÉ (`NOMA_MEDIA_DIR` vers un autre dossier, un disque non monté, un dossier vidé) : si plus de 5 % des lignes, ou plus de 20 lignes, n'ont pas de fichier,
 * l'application est REFUSÉE EN ENTIER (aucune ligne et aucun fichier supprimé : un dossier mal désigné peut aussi contenir les fichiers d'une autre instance, que l'on prendrait pour des
 * orphelins) sauf `expectMissing` égal EXACTEMENT au nombre constaté (le gestionnaire sait que ces fichiers sont perdus). Un `expectMissing` différent du constat est toujours refusé.
 */

export type MediaGcRefusal = "too_many_missing" | "expect_mismatch";

export interface MediaGcResult {
  apply: boolean;
  files: { scanned: number; orphans: number; temporaries: number; foreign: number; deleted: number };
  rows: { scanned: number; withoutFile: number; deleted: number };
  journal: { open: number; resolved: number };
  /** Le dossier de stockage existe. */
  storeExists: boolean;
  /** Raison pour laquelle l'application est (en simulation : serait) REFUSÉE ; `null` si elle est permise. En application refusée, rien n'a été supprimé. */
  refusal: MediaGcRefusal | null;
}

/** Garde des lignes sans fichier (voir plus haut) : `null` si l'application est permise. */
export function missingRowsGuard(input: { rows: number; missing: number; expectMissing?: number }): MediaGcRefusal | null {
  const { rows, missing, expectMissing } = input;
  if (expectMissing !== undefined) return expectMissing === missing ? null : "expect_mismatch";
  if (missing === 0) return null;
  return missing > MEDIA_GC_MISSING_MAX_COUNT || missing * 100 > rows * MEDIA_GC_MISSING_MAX_PERCENT ? "too_many_missing" : null;
}

/** Âge minimal (secondes) d'un fichier orphelin : `NOMA_MEDIA_GC_MIN_AGE_SECONDS` (entier ≥ 0), sinon 600. */
export function resolveMinAgeSeconds(env: Record<string, string | undefined>): number {
  const raw = env[MEDIA_GC_MIN_AGE_VARIABLE];
  if (raw === undefined || raw.trim() === "") return MEDIA_GC_DEFAULT_MIN_AGE_SECONDS;
  if (!/^[0-9]{1,7}$/.test(raw.trim())) throw new RangeError(`${MEDIA_GC_MIN_AGE_VARIABLE} doit être un entier de secondes (0 ou plus).`);
  return Number(raw.trim());
}

export async function collectMediaGarbage(input: {
  pool: Pool;
  store: MediaStore;
  apply: boolean;
  /** Âge minimal d'un fichier orphelin avant suppression (défaut 600 s). */
  minAgeSeconds?: number;
  /** Instant de référence (réservé aux essais). */
  now?: Date;
  /** Nombre de lignes sans fichier que le gestionnaire accepte de supprimer ; doit être EXACTEMENT le nombre constaté. */
  expectMissing?: number;
}): Promise<MediaGcResult> {
  const pool = requireTransactionPool(input.pool);
  const minAgeMs = (input.minAgeSeconds ?? MEDIA_GC_DEFAULT_MIN_AGE_SECONDS) * 1_000;
  const now = (input.now ?? new Date()).getTime();
  // LES LIGNES D'ABORD, puis les fichiers : un envoi validé entre les deux a un fichier récent (protégé par l'âge minimal), jamais une ligne vue sans son fichier.
  const rows = (await pool.query<{ id: string }>("SELECT id FROM offer_photos")).rows.map((row) => row.id);
  const listing = await input.store.list();
  const rowIds = new Set(rows);
  const photoFiles = listing.objects.filter((object) => object.kind === "photo");
  const fileKeys = new Set(photoFiles.map((object) => object.name));
  const old = (object: { modifiedAt: Date }): boolean => now - object.modifiedAt.getTime() >= minAgeMs;

  const orphans = photoFiles.filter((object) => !rowIds.has(object.name) && old(object));
  const temporaries = listing.objects.filter((object) => object.kind === "temporary" && old(object));
  const withoutFile = rows.filter((id) => !fileKeys.has(id));
  const refusal = missingRowsGuard({ rows: rows.length, missing: withoutFile.length, expectMissing: input.expectMissing });

  const open = await pool.query<{ id: string; storage_key: string }>("SELECT id::text, storage_key FROM media_orphans WHERE resolved_at IS NULL");
  const result: MediaGcResult = {
    apply: input.apply,
    files: { scanned: listing.objects.length, orphans: orphans.length, temporaries: temporaries.length, foreign: listing.foreign, deleted: 0 },
    rows: { scanned: rows.length, withoutFile: withoutFile.length, deleted: 0 },
    journal: { open: open.rows.length, resolved: 0 },
    storeExists: listing.exists,
    refusal,
  };
  if (!input.apply || refusal !== null) return result;

  for (const object of [...orphans, ...temporaries]) if (await input.store.delete(object.name)) result.files.deleted += 1;
  for (const id of withoutFile) if (await removePhotoRowWithoutFile(pool, id)) result.rows.deleted += 1;
  // Le journal : une entrée est RÉSOLUE quand son fichier n'existe plus (supprimé par ce passage, ou déjà parti) ou quand sa photo a désormais une ligne (jamais un orphelin).
  const after = await input.store.list();
  const present = new Set(after.objects.map((object) => object.name));
  for (const entry of open.rows) {
    const stillThere = present.has(entry.storage_key);
    const hasRow = (await pool.query("SELECT 1 FROM offer_photos WHERE id = $1::uuid", [entry.storage_key])).rowCount ?? 0;
    if (!stillThere || hasRow > 0) {
      await pool.query("UPDATE media_orphans SET resolved_at = clock_timestamp() WHERE id = $1::bigint", [entry.id]);
      result.journal.resolved += 1;
    }
  }
  return result;
}

