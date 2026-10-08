/**
 * Couche cliente des photos d'annonces (lot PH1) : module partagé navigateur (aucun import serveur), mêmes règles que `api.ts` : même origine, toute erreur devient une `ApiError { status,
 * code }` construite UNIQUEMENT depuis le corps `{ error: { code, message } }` du serveur (ou un code fixe), réponses relues champ par champ (liste blanche). Contrat :
 * lib/server/media/http.ts (`offer-photos/v1`). L'envoi passe par XMLHttpRequest (seul moyen d'avoir la progression d'un envoi) ; le corps est le fichier lui-même, sans enveloppe ;
 * le serveur ne lit ni le nom du fichier ni son type déclaré. Voir PHOTOS.md.
 */

import { API_ABORTED, API_INVALID_ID, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, describeApiError, isUuid, type RequestOptions } from "./api";
import { mediaUrl, parseCoverPhotoId, parsePhotoRefs, type PhotoRef } from "./photos-refs";

export { mediaUrl, parseCoverPhotoId, parsePhotoRefs, type PhotoRef };

export const OFFER_PHOTOS_CONTRACT_VERSION = "offer-photos/v1";

/** Copies des bornes du serveur (lib/server/media/config.ts) ; un essai vérifie qu'elles sont identiques. */
export const PHOTO_MAX_PER_OFFER = 6;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_MIN_SIDE = 200;
export const PHOTO_ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoMime = (typeof PHOTO_ACCEPTED_TYPES)[number];
/** Valeur de l'attribut `accept` d'un champ de fichier. */
export const PHOTO_ACCEPT_ATTRIBUTE = PHOTO_ACCEPTED_TYPES.join(",");

/** Photo vue par son propriétaire. */
export interface OfferPhoto {
  id: string;
  /** 0 = couverture. */
  position: number;
  mime: PhotoMime;
  width: number;
  height: number;
  bytes: number;
}

export interface UploadResult {
  created: boolean;
  photo: OfferPhoto;
  photos: OfferPhoto[];
}

// ───────────── messages en mots simples ─────────────

/** Texte fixe par code de refus du serveur ; jamais le texte reçu, jamais le nom du fichier. */
export const PHOTO_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  file_too_large: "Cette photo est trop lourde : 5 Mo au plus.",
  unsupported_type: "Ce format n'est pas accepté : envoyez une photo JPEG, PNG ou WebP.",
  corrupt: "Cette photo est abîmée ou incomplète : essayez-en une autre.",
  truncated: "Cette photo est abîmée ou incomplète : essayez-en une autre.",
  too_small: "Cette photo est trop petite : 200 pixels au moins de chaque côté.",
  too_large_dimensions: "Cette photo est trop grande : 4 100 pixels au plus de chaque côté. Choisissez une photo plus petite ou réduisez-la.",
  too_many_pixels: "Cette photo est trop grande : 12,5 millions de pixels au plus (par exemple 4 000 × 3 000). Choisissez une photo plus petite ou réduisez-la.",
  request_timeout: "L'envoi de la photo a pris trop de temps : vérifiez votre connexion, puis réessayez.",
  animated: "Les images animées ne sont pas acceptées : envoyez une photo fixe.",
  photo_limit: "Cette annonce a déjà 6 photos : supprimez-en une pour en ajouter.",
  rate_limited: "Vous avez envoyé beaucoup de photos : réessayez un peu plus tard.",
  invalid_request: "Cette demande n'est pas valide. Rechargez la page, puis réessayez.",
  resource_archived: "Cette annonce est archivée : ses photos ne peuvent plus changer.",
  resource_not_found: "Annonce ou photo introuvable : elle n'existe plus, ou n'est pas à vous.",
});

/** Message fixe pour l'utilisateur d'après le code d'erreur ; repli sur les messages généraux de `describeApiError`. */
export function describePhotoError(error: unknown): string {
  if (error instanceof ApiError && Object.prototype.hasOwnProperty.call(PHOTO_ERROR_MESSAGES, error.code) && [400, 404, 408, 409, 413, 415, 422, 429].includes(error.status)) {
    return PHOTO_ERROR_MESSAGES[error.code];
  }
  return describeApiError(error, "catalog");
}

// ───────────── relecture des réponses (liste blanche) ─────────────

const FIXED_MESSAGES: Record<string, string> = {
  [API_NETWORK_ERROR]: "Connexion au serveur impossible.",
  [API_INVALID_RESPONSE]: "Réponse du serveur inattendue.",
  [API_ABORTED]: "Requête interrompue.",
  [API_INVALID_ID]: "Identifiant invalide.",
};

function fixedError(status: number, code: string): ApiError {
  return new ApiError(status, code, FIXED_MESSAGES[code] ?? FIXED_MESSAGES[API_INVALID_RESPONSE]);
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

function errorFromBody(status: number, body: unknown): ApiError {
  if (isObject(body) && isObject(body.error)) {
    const { code, message } = body.error;
    if (typeof code === "string" && ERROR_CODE.test(code) && typeof message === "string" && message.length <= 500) return new ApiError(status, code, message);
  }
  return fixedError(status, API_INVALID_RESPONSE);
}

/** Photo du propriétaire : relue champ par champ. */
export function parseOfferPhoto(status: number, value: unknown): OfferPhoto {
  if (
    !isObject(value) || !isUuid(value.id) || !isInt(value.position, 0, PHOTO_MAX_PER_OFFER - 1) || !PHOTO_ACCEPTED_TYPES.includes(value.mime as PhotoMime) ||
    !isInt(value.width, 1, 65_535) || !isInt(value.height, 1, 65_535) || !isInt(value.bytes, 1, PHOTO_MAX_BYTES)
  ) {
    throw fixedError(status, API_INVALID_RESPONSE);
  }
  return { id: value.id.toLowerCase(), position: value.position, mime: value.mime as PhotoMime, width: value.width, height: value.height, bytes: value.bytes };
}

function parsePhotoList(status: number, value: unknown): OfferPhoto[] {
  if (!Array.isArray(value) || value.length > PHOTO_MAX_PER_OFFER) throw fixedError(status, API_INVALID_RESPONSE);
  return value.map((entry) => parseOfferPhoto(status, entry));
}

// ───────────── transport d'envoi ─────────────

export interface UploadTransportInput {
  url: string;
  body: Blob;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface UploadTransportResult {
  status: number;
  json: unknown;
}

/** Envoi par XMLHttpRequest (progression réelle). Le texte d'une exception n'est jamais repris : réseau coupé = `network_error`. */
export function browserUpload(input: UploadTransportInput): Promise<UploadTransportResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", input.url);
    request.setRequestHeader("Accept", "application/json");
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) input.onProgress?.(Math.min(1, event.loaded / event.total));
    };
    request.onerror = () => reject(fixedError(0, API_NETWORK_ERROR));
    request.ontimeout = () => reject(fixedError(0, API_NETWORK_ERROR));
    request.onabort = () => reject(fixedError(0, API_ABORTED));
    request.onload = () => {
      let json: unknown;
      try {
        json = JSON.parse(request.responseText);
      } catch {
        json = undefined;
      }
      resolve({ status: request.status, json });
    };
    if (input.signal) {
      if (input.signal.aborted) {
        reject(fixedError(0, API_ABORTED));
        return;
      }
      input.signal.addEventListener("abort", () => request.abort(), { once: true });
    }
    request.send(input.body);
  });
}

export interface PhotosClientOptions {
  fetch?: typeof fetch;
  upload?: (input: UploadTransportInput) => Promise<UploadTransportResult>;
}

export interface UploadOptions extends RequestOptions {
  onProgress?: (fraction: number) => void;
}

export function createPhotosClient(options: PhotosClientOptions = {}) {
  async function send(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown, requestOptions: RequestOptions = {}): Promise<{ status: number; json: unknown }> {
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
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    if (!response.ok) throw errorFromBody(response.status, json);
    return { status: response.status, json };
  }

  function id(value: string): string {
    if (!isUuid(value)) throw fixedError(0, API_INVALID_ID);
    return value.toLowerCase();
  }

  function listResult(status: number, json: unknown): OfferPhoto[] {
    if (!isObject(json) || json.contractVersion !== OFFER_PHOTOS_CONTRACT_VERSION) throw fixedError(status, API_INVALID_RESPONSE);
    return parsePhotoList(status, json.photos);
  }

  return {
    /** GET /api/offers/{id}/photos : photos de l'annonce (propriétaire). */
    async list(offerId: string, requestOptions?: RequestOptions): Promise<OfferPhoto[]> {
      const { status, json } = await send("GET", `/api/offers/${id(offerId)}/photos`, undefined, requestOptions);
      return listResult(status, json);
    },

    /** POST /api/offers/{id}/photos : envoie UN fichier (corps brut). Renvoie la photo et la liste à jour. */
    async upload(offerId: string, file: Blob, uploadOptions: UploadOptions = {}): Promise<UploadResult> {
      const url = `/api/offers/${id(offerId)}/photos`;
      const transport = options.upload ?? browserUpload;
      const { status, json } = await transport({ url, body: file, signal: uploadOptions.signal, onProgress: uploadOptions.onProgress });
      if (status < 200 || status >= 300) throw errorFromBody(status, json);
      if (!isObject(json) || json.contractVersion !== OFFER_PHOTOS_CONTRACT_VERSION || typeof json.created !== "boolean") throw fixedError(status, API_INVALID_RESPONSE);
      return { created: json.created, photo: parseOfferPhoto(status, json.photo), photos: parsePhotoList(status, json.photos) };
    },

    /** PUT /api/offers/{id}/photos : nouvel ordre (la première photo est la couverture). */
    async reorder(offerId: string, order: readonly string[], requestOptions?: RequestOptions): Promise<OfferPhoto[]> {
      const { status, json } = await send("PUT", `/api/offers/${id(offerId)}/photos`, { order: order.map(id) }, requestOptions);
      return listResult(status, json);
    },

    /** DELETE /api/offers/{id}/photos/{photoId} : supprime ; `removed` est faux pour une suppression rejouée. */
    async remove(offerId: string, photoId: string, requestOptions?: RequestOptions): Promise<{ removed: boolean; photos: OfferPhoto[] }> {
      const { status, json } = await send("DELETE", `/api/offers/${id(offerId)}/photos/${id(photoId)}`, undefined, requestOptions);
      if (!isObject(json) || typeof json.removed !== "boolean") throw fixedError(status, API_INVALID_RESPONSE);
      return { removed: json.removed, photos: listResult(status, json) };
    },
  };
}

export type PhotosClient = ReturnType<typeof createPhotosClient>;

/** Client du navigateur : fetch global, XMLHttpRequest, même origine. */
export const photosApi: PhotosClient = createPhotosClient();
