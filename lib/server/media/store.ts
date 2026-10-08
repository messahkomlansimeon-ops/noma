import "server-only";

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MEDIA_DEFAULT_DIRECTORY, MEDIA_DIRECTORY_VARIABLE, PHOTO_MAX_BYTES } from "./config";
import { MediaError } from "./errors";

/**
 * Stockage des fichiers de photos (lot PH1) derrière un PORT : `MediaStore`. L'implémentation d'aujourd'hui écrit sur le disque, dans un dossier HORS de `public/`
 * (`NOMA_MEDIA_DIR`, par défaut `data/media` hors production, obligatoire en production) ; un stockage objet pourra la remplacer sans toucher au reste. Le nom d'un fichier
 * est l'identifiant de la photo (un UUID tiré par le serveur) : le nom envoyé par l'utilisateur n'existe pas pour ce code. Toute clé qui n'est pas un UUID minuscule est
 * refusée AVANT d'atteindre le système de fichiers (aucune traversée de chemin possible), et le chemin final est revérifié (son dossier parent est exactement le dossier de
 * stockage). Voir PHOTOS.md.
 */

/** UUID version 4 en minuscules : la forme de `randomUUID()`, et la seule clé de photo acceptée. */
export const MEDIA_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Fichier temporaire d'une écriture en cours (`.<clé>.<16 hexadécimaux>.tmp`) : jamais lu, supprimé par `media:gc` quand il est ancien. */
export const MEDIA_TEMPORARY_FILE = /^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{16}\.tmp$/;

export interface MediaObject {
  /** Clé de la photo, ou nom du fichier temporaire. */
  name: string;
  kind: "photo" | "temporary";
  size: number;
  modifiedAt: Date;
}

export interface MediaListing {
  objects: MediaObject[];
  /** Fichiers, dossiers ou liens du dossier de stockage qui ne portent ni un nom de photo ni un nom de fichier temporaire : jamais listés, jamais supprimés. */
  foreign: number;
  /** Le dossier de stockage existe. */
  exists: boolean;
}

export interface MediaStore {
  /** Écrit les octets sous la clé (atomique, jamais d'écrasement : une clé déjà prise lève une erreur). */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Lit les octets ; `null` si la clé n'existe pas. */
  get(key: string): Promise<Uint8Array | null>;
  /** Supprime ; `false` si elle n'existait pas. Accepte une clé de photo ou un nom de fichier temporaire. */
  delete(name: string): Promise<boolean>;
  list(): Promise<MediaListing>;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
}

export class DiskMediaStore implements MediaStore {
  readonly root: string;

  constructor(directory: string) {
    if (typeof directory !== "string" || directory.trim() === "" || directory.includes("\0")) throw new MediaError("storage_unavailable");
    this.root = resolve(directory);
  }

  /** Chemin d'un fichier du dossier : le nom doit être une clé de photo ou un fichier temporaire, et le parent du chemin résolu est le dossier lui-même. */
  private pathOf(name: string, allowTemporary: boolean): string {
    if (typeof name !== "string" || !(MEDIA_KEY.test(name) || (allowTemporary && MEDIA_TEMPORARY_FILE.test(name)))) throw new MediaError("invalid_key");
    const target = join(this.root, name);
    if (dirname(target) !== this.root) throw new MediaError("invalid_key");
    return target;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const final = this.pathOf(key, false);
    if (bytes.byteLength < 1 || bytes.byteLength > PHOTO_MAX_BYTES) throw new MediaError("file_too_large");
    const temporary = join(this.root, `.${key}.${randomBytes(8).toString("hex")}.tmp`);
    let created = false;
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // `link` échoue si la clé existe déjà : jamais d'écrasement silencieux.
      await link(temporary, final);
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError("storage_unavailable");
    } finally {
      if (created) await unlink(temporary).catch(() => {});
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const target = this.pathOf(key, false);
    let handle;
    try {
      // O_NOFOLLOW : un lien symbolique posé dans le dossier ne mène jamais à un autre fichier.
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return null;
      throw new MediaError("storage_unavailable");
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > PHOTO_MAX_BYTES) return null;
      return new Uint8Array(await handle.readFile());
    } catch {
      throw new MediaError("storage_unavailable");
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async delete(name: string): Promise<boolean> {
    const target = this.pathOf(name, true);
    try {
      await unlink(target);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw new MediaError("storage_unavailable");
    }
  }

  async list(): Promise<MediaListing> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { objects: [], foreign: 0, exists: false };
      throw new MediaError("storage_unavailable");
    }
    const objects: MediaObject[] = [];
    let foreign = 0;
    for (const entry of entries) {
      const kind = MEDIA_KEY.test(entry.name) ? "photo" : MEDIA_TEMPORARY_FILE.test(entry.name) ? "temporary" : null;
      if (kind === null || !entry.isFile()) {
        foreign += 1;
        continue;
      }
      try {
        const info = await lstat(join(this.root, entry.name));
        if (!info.isFile()) {
          foreign += 1;
          continue;
        }
        objects.push({ name: entry.name, kind, size: info.size, modifiedAt: info.mtime });
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw new MediaError("storage_unavailable");
      }
    }
    return { objects, foreign, exists: true };
  }
}

/**
 * Dossier de stockage : `NOMA_MEDIA_DIR` (chemin relatif au dossier courant ou absolu) ; à défaut `data/media` hors production ; en production la variable est OBLIGATOIRE
 * (refus : aucun dossier par défaut n'est supposé sur un serveur de production).
 */
export function resolveMediaDirectory(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string {
  const configured = env[MEDIA_DIRECTORY_VARIABLE]?.trim();
  if (configured) {
    if (configured.includes("\0")) throw new MediaError("storage_unavailable");
    return resolve(cwd, configured);
  }
  if (env.NODE_ENV === "production") throw new MediaError("storage_unavailable");
  return resolve(cwd, MEDIA_DEFAULT_DIRECTORY);
}

/** Stockage de l'environnement donné (disque). Aucune écriture à la création : le dossier est créé à la première photo. */
export function createMediaStore(env: Record<string, string | undefined> = process.env): MediaStore {
  return new DiskMediaStore(resolveMediaDirectory(env));
}
