import "server-only";

import type { Pool } from "pg";
import { CatalogValidationError } from "../catalog/errors";
import { noStoreJsonResponse } from "../http/protection";
import { UUID, createSocialContext, failure, hasUnexpectedQuery, invalidRequest, logCodeOf, resourceNotFound, type SocialHttpDependencies } from "../social/http-common";
import { readBinaryBodyCapped } from "./body";
import { PHOTO_MAX_BYTES, PHOTO_MAX_PER_OFFER, PHOTO_MAX_PIXELS, PHOTO_MAX_SIDE, PHOTO_MIN_SIDE, PHOTO_SECURITY_HEADERS } from "./config";
import { MediaError, type MediaErrorCode } from "./errors";
import { sanitizeImage } from "./image";
import { checkOfferOwner, consumeUploadSlot, deletePhoto, listOwnerPhotos, reorderPhotos, uploadPhoto, type PhotoHooks, type PhotoRecord } from "./photos";
import { readPhotoForViewer } from "./read";
import { createMediaStore, type MediaStore } from "./store";

/**
 * Routes HTTP des photos d'annonces (lot PH1) :
 *  - POST   /api/offers/{id}/photos            envoi (corps = les octets du fichier ; propriétaire seulement ; origine vérifiée AVANT la session ; 5 Mo ; 30 envois par heure) ;
 *  - GET    /api/offers/{id}/photos            photos de l'annonce (propriétaire seulement) ;
 *  - PUT    /api/offers/{id}/photos            nouvel ordre `{ order: [identifiants] }` (la première photo est la couverture) ;
 *  - DELETE /api/offers/{id}/photos/{photoId}  suppression ;
 *  - GET    /api/media/{photoId}               le fichier : propriétaire, administrateur ou acheteur d'une correspondance confirmée ; 404 INDISCERNABLE pour tous les autres.
 * Réponses JSON `no-store`, textes fixes (jamais une donnée de la base ni du fichier). Voir PHOTOS.md.
 */

export const OFFER_PHOTOS_CONTRACT_VERSION = "offer-photos/v1" as const;

export interface MediaHttpDependencies extends SocialHttpDependencies {
  /** Stockage des fichiers (défaut : disque, `NOMA_MEDIA_DIR`). */
  store?: MediaStore;
  /** Points d'injection RÉSERVÉS AUX ESSAIS. */
  hooks?: PhotoHooks;
  /** Délai total de lecture du corps d'un envoi (défaut 30 s) : réservé aux essais (un corps lent simulé n'attend pas 30 s). */
  bodyReadTimeoutMs?: number;
}

export interface MediaHttpHandlers {
  photos: {
    list(request: Request, offerId: string): Promise<Response>;
    upload(request: Request, offerId: string): Promise<Response>;
    reorder(request: Request, offerId: string): Promise<Response>;
    remove(request: Request, offerId: string, photoId: string): Promise<Response>;
  };
  media: {
    get(request: Request, photoId: string): Promise<Response>;
  };
}

/** Photo vue par son PROPRIÉTAIRE : jamais l'empreinte ni l'annonce. */
function ownerPhotoDto(photo: PhotoRecord): Record<string, unknown> {
  return { id: photo.id, position: photo.position, mime: photo.mime, width: photo.width, height: photo.height, bytes: photo.bytes };
}

/** 4100 -> « 4 100 » (sans dépendre de la locale). */
function spaced(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Refus du domaine → (statut, texte fixe en mots simples). Le texte ne contient jamais le nom ni le contenu du fichier. */
const REFUSALS: Readonly<Record<MediaErrorCode, { status: number; message: string }>> = Object.freeze({
  resource_not_found: { status: 404, message: "Ressource introuvable." },
  resource_archived: { status: 409, message: "Annonce archivée non modifiable." },
  photo_limit: { status: 409, message: `Cette annonce a déjà ${PHOTO_MAX_PER_OFFER} photos : supprimez-en une pour en ajouter.` },
  rate_limited: { status: 429, message: "Vous avez envoyé beaucoup de photos : réessayez un peu plus tard." },
  file_too_large: { status: 413, message: `Cette photo est trop lourde : ${PHOTO_MAX_BYTES / (1024 * 1024)} Mo au plus.` },
  request_timeout: { status: 408, message: "L'envoi de la photo a pris trop de temps : vérifiez votre connexion, puis réessayez." },
  empty_body: { status: 400, message: "Aucune photo n'a été reçue." },
  invalid_request: { status: 400, message: "Requête invalide." },
  invalid_key: { status: 400, message: "Requête invalide." },
  storage_unavailable: { status: 503, message: "Le service est temporairement indisponible." },
  unsupported_type: { status: 415, message: "Ce format n'est pas accepté : envoyez une photo JPEG, PNG ou WebP." },
  corrupt: { status: 422, message: "Cette photo est abîmée ou incomplète : essayez-en une autre." },
  truncated: { status: 422, message: "Cette photo est abîmée ou incomplète : essayez-en une autre." },
  too_small: { status: 422, message: `Cette photo est trop petite : ${PHOTO_MIN_SIDE} pixels au moins de chaque côté.` },
  too_large_dimensions: { status: 422, message: `Cette photo est trop grande : ${spaced(PHOTO_MAX_SIDE)} pixels au plus de chaque côté. Choisissez une photo plus petite ou réduisez-la.` },
  too_many_pixels: { status: 422, message: `Cette photo est trop grande : ${String(PHOTO_MAX_PIXELS / 1_000_000).replace(".", ",")} millions de pixels au plus (par exemple 4 000 × 3 000). Choisissez une photo plus petite ou réduisez-la.` },
  animated: { status: 422, message: "Les images animées ne sont pas acceptées : envoyez une photo fixe." },
});

/** Poids annoncé déjà trop grand : refus avant d'avoir pris une place de la limite d'envoi. */
function declaredTooLarge(request: Request): boolean {
  const declared = request.headers.get("content-length");
  return declared !== null && /^[0-9]+$/.test(declared) && BigInt(declared) > BigInt(PHOTO_MAX_BYTES);
}

function cancelBody(request: Request): void {
  void request.body?.cancel().catch(() => {});
}

export function createMediaHttpHandlers(dependencies: MediaHttpDependencies = {}): MediaHttpHandlers {
  const context = createSocialContext(dependencies, "media-http");
  const store = (): MediaStore => dependencies.store ?? createMediaStore(context.environment());
  const poolOf = (): Pool => context.poolOf();

  function refuse(error: MediaError): Response {
    const refusal = REFUSALS[error.code];
    // Lot T3 : après un 408 (corps lu trop lentement, donc ni lu en entier ni vidé), la connexion est FERMÉE : une connexion persistante réutilisée pour la requête suivante lirait le reste du corps
    // abandonné comme un début de requête.
    const headers: Record<string, string> | undefined =
      error.code === "rate_limited" ? { "retry-after": String(error.retryAfterSeconds ?? 60) } : refusal.status === 408 ? { connection: "close" } : undefined;
    if (error.code === "storage_unavailable") context.journal("storage_unavailable");
    return failure(refusal.status, error.code === "empty_body" ? "invalid_request" : error.code, refusal.message, headers);
  }

  function mapError(error: unknown): Response {
    if (error instanceof MediaError) return refuse(error);
    if (error instanceof CatalogValidationError) return invalidRequest();
    return context.unavailable(logCodeOf(error), "media");
  }

  /** Origine (écriture) → session ; le corps d'une requête refusée n'est jamais lu. */
  async function writer(request: Request): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
    const refusal = context.originGuard(request);
    if (refusal) {
      cancelBody(request);
      return { ok: false, response: refusal };
    }
    const authenticated = await context.authenticate(request);
    if (!authenticated.ok) cancelBody(request);
    return authenticated;
  }

  return {
    photos: {
      async list(request, offerId) {
        const authenticated = await context.authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (!UUID.test(offerId) || hasUnexpectedQuery(request)) return invalidRequest();
        try {
          const photos = await listOwnerPhotos({ pool: poolOf(), ownerId: authenticated.userId, offerId });
          return noStoreJsonResponse(200, { contractVersion: OFFER_PHOTOS_CONTRACT_VERSION, photos: photos.map(ownerPhotoDto) });
        } catch (error) {
          return mapError(error);
        }
      },

      async upload(request, offerId) {
        const authenticated = await writer(request);
        if (!authenticated.ok) return authenticated.response;
        if (!UUID.test(offerId) || hasUnexpectedQuery(request)) {
          cancelBody(request);
          return invalidRequest();
        }
        try {
          const pool = poolOf();
          await checkOfferOwner({ pool, ownerId: authenticated.userId, offerId, forWrite: true });
          if (declaredTooLarge(request)) throw new MediaError("file_too_large");
          await consumeUploadSlot({ pool, sellerId: authenticated.userId });
          const body = await readBinaryBodyCapped(request, PHOTO_MAX_BYTES, dependencies.bodyReadTimeoutMs);
          // Une lecture trop lente (408) ne rend PAS la place d'envoi prise plus haut : c'est elle qui borne le nombre de connexions lentes qu'un compte peut retenir (30 par heure).
          if (!body.ok) throw new MediaError(body.reason === "too_large" ? "file_too_large" : body.reason === "empty" ? "empty_body" : body.reason === "timeout" ? "request_timeout" : "invalid_request");
          // Type, dimensions et nettoyage : les octets seuls décident (jamais le Content-Type ni un nom de fichier).
          const sanitized = sanitizeImage(body.bytes);
          if (!sanitized.ok) throw new MediaError(sanitized.reason);
          const result = await uploadPhoto({ pool, store: store(), ownerId: authenticated.userId, offerId, image: sanitized.image, hooks: dependencies.hooks });
          const photos = await listOwnerPhotos({ pool, ownerId: authenticated.userId, offerId });
          return noStoreJsonResponse(result.created ? 201 : 200, {
            contractVersion: OFFER_PHOTOS_CONTRACT_VERSION,
            created: result.created,
            photo: ownerPhotoDto(result.photo),
            photos: photos.map(ownerPhotoDto),
          });
        } catch (error) {
          cancelBody(request);
          return mapError(error);
        }
      },

      async reorder(request, offerId) {
        const authenticated = await writer(request);
        if (!authenticated.ok) return authenticated.response;
        if (!UUID.test(offerId) || hasUnexpectedQuery(request)) return invalidRequest();
        const body = await context.readJsonObject(request, 1_024);
        if (body === null || Object.keys(body).length !== 1 || !Array.isArray(body.order)) return invalidRequest();
        try {
          const photos = await reorderPhotos({ pool: poolOf(), ownerId: authenticated.userId, offerId, order: body.order as string[] });
          return noStoreJsonResponse(200, { contractVersion: OFFER_PHOTOS_CONTRACT_VERSION, photos: photos.map(ownerPhotoDto) });
        } catch (error) {
          return mapError(error);
        }
      },

      async remove(request, offerId, photoId) {
        const authenticated = await writer(request);
        if (!authenticated.ok) return authenticated.response;
        if (!UUID.test(offerId) || !UUID.test(photoId) || hasUnexpectedQuery(request)) return invalidRequest();
        try {
          const result = await deletePhoto({ pool: poolOf(), store: store(), ownerId: authenticated.userId, offerId, photoId, hooks: dependencies.hooks });
          return noStoreJsonResponse(200, { contractVersion: OFFER_PHOTOS_CONTRACT_VERSION, removed: result.removed, photos: result.photos.map(ownerPhotoDto) });
        } catch (error) {
          return mapError(error);
        }
      },
    },

    media: {
      async get(request, photoId) {
        // Aucun visiteur sans session, aucun identifiant mal formé, aucune annonce inconnue ou interdite ne se distingue : le MÊME 404.
        const authenticated = await context.authenticate(request);
        if (!authenticated.ok) return authenticated.response.status === 401 ? resourceNotFound() : authenticated.response;
        if (!UUID.test(photoId) || hasUnexpectedQuery(request)) return resourceNotFound();
        try {
          const served = await readPhotoForViewer({ pool: poolOf(), store: store(), viewerId: authenticated.userId, photoId, log: (code) => context.journal(code) });
          if (served === null) return resourceNotFound();
          const headers = new Headers(PHOTO_SECURITY_HEADERS);
          // Le type est celui que les octets ont prouvé à l'envoi (stocké en base), jamais un type reçu.
          headers.set("Content-Type", served.mime);
          headers.set("Content-Length", String(served.bytes.byteLength));
          return new Response(served.bytes as unknown as BodyInit, { status: 200, headers });
        } catch (error) {
          return mapError(error);
        }
      },
    },
  };
}

export const defaultMediaHttpHandlers = createMediaHttpHandlers();
