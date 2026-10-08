import "server-only";

import { after } from "next/server";
import type { Pool } from "pg";
import { AUTH_SESSION_COOKIE } from "../auth/http";
import { resolveSession as resolveStoredSession } from "../auth/sessions";
import type { AuthClock, ResolvedSession, SessionContext } from "../auth/types";
import { CatalogValidationError } from "../catalog/errors";
import { checkPostOrigin, noStoreJsonResponse, readBodyCapped, readSingleCookie } from "../http/protection";
import { readOfferPhotoRefsSafely } from "../media/read";
import { readStoredOfferForDemand, type StoredOfferDetail } from "../matching/stored-matches";
import { getPostgresPool } from "../postgres/client";
import { CONTACT_DAILY_SELLER_LIMIT } from "./config";
import { buildContactLinks, revealOfferContact, type OfferContactInput, type OfferContactResult } from "./contacts";
import { MetricsError } from "./errors";
import { mapOfferDetailToDto } from "./offer-detail";
import { readOfferStats, type BoostStats, type OfferStats } from "./stats";
import { recordOfferView, type OfferViewInput } from "./views";

/**
 * Routes HTTP des mesures d'efficacité (lot M1) :
 *  - GET  /api/demands/{id}/offers/{offerId}          : fiche d'une annonce pour l'acheteur, dans le contexte d'un de SES besoins (enregistre l'ouverture) ;
 *  - POST /api/demands/{id}/offers/{offerId}/contact  : numéro vérifié du vendeur (origine vérifiée AVANT la session), limite de vendeurs distincts ;
 *  - GET  /api/offers/{id}/stats                       : ce que produit l'annonce, pour son vendeur seulement.
 * Réponses `no-store`, textes fixes (jamais une donnée de la base), 404 identique pour tout accès refusé. Voir MESURES.md.
 */

export const OFFER_CONTACT_CONTRACT_VERSION = "offer-contact/v1" as const;
export const OFFER_STATS_CONTRACT_VERSION = "offer-stats/v1" as const;

/** Un corps de contact est vide (ou `{}`) : 64 octets suffisent. */
const CONTACT_BODY_MAX_BYTES = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOG_CODE = /^[A-Za-z0-9_]{1,40}$/;

type Environment = Record<string, string | undefined>;

export interface MetricsHttpDependencies {
  pool?: Pool;
  now?: AuthClock;
  env?: Environment;
  /** Résolution de session (défaut : `resolveSession` de lib/server/auth). */
  resolveSession?: (token: string, context: SessionContext) => Promise<ResolvedSession | null>;
  /** Lecture de la fiche (défaut : `readStoredOfferForDemand`). Réservé aux tests. */
  readOffer?: (ownerId: string, demandId: string, offerId: string, pool: Pool) => Promise<StoredOfferDetail | null>;
  /** Journal des ouvertures (défaut : `recordOfferView`). Réservé aux tests : un journal qui échoue ne casse jamais la lecture de la fiche. */
  recordView?: (pool: Pool, input: OfferViewInput) => Promise<boolean>;
  /**
   * Planificateur du journal des ouvertures : exécute la tâche APRÈS l'envoi de la réponse (défaut : `after()` de `next/server`, le mécanisme officiel de Next.js,
   * qui exige une requête en cours). Réservé aux tests, pour lesquels `after()` n'a pas de requête.
   */
  schedule?: (task: () => Promise<void>) => void;
  /** Révélation du contact (défaut : `revealOfferContact`). Réservé aux tests. */
  revealContact?: (input: OfferContactInput) => Promise<OfferContactResult>;
  /** Journal serveur : ne reçoit QU'UN code (jamais de message brut, de requête ni d'identifiant). Un journal qui lève est ignoré. */
  log?: (code: string) => void;
}

export interface MetricsHttpHandlers {
  demandOffers: {
    get(request: Request, demandId: string, offerId: string): Promise<Response>;
    contact(request: Request, demandId: string, offerId: string): Promise<Response>;
  };
  offers: {
    stats(request: Request, offerId: string): Promise<Response>;
  };
}

// ───────────── réponses (textes fixes) ─────────────

function metricsError(status: number, code: string, message: string, headers?: HeadersInit): Response {
  return noStoreJsonResponse(status, { error: { code, message } }, headers);
}

const unauthorized = () => metricsError(401, "authentication_required", "Authentification requise.");
const forbiddenOrigin = () => metricsError(403, "invalid_origin", "Origine de la requête non autorisée.");
const invalidRequest = () => metricsError(400, "invalid_request", "Requête invalide.");
/** Accès refusé, ressource inexistante, d'un autre, hors correspondance : la MÊME réponse. */
const resourceNotFound = () => metricsError(404, "resource_not_found", "Ressource introuvable.");
const offerNotAvailable = () => metricsError(409, "offer_not_available", "Cette annonce n'est plus disponible.");
const contactUnavailable = () => metricsError(409, "contact_unavailable", "Le contact de ce vendeur n'est pas disponible.");
const metricsUnavailable = () => metricsError(503, "metrics_unavailable", "Le service est temporairement indisponible.");

/** Secondes jusqu'à minuit UTC (au moins 1) : le quota de contacts se renouvelle au changement de jour UTC. */
export function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

const rateLimited = (now: Date) => metricsError(
  429,
  "rate_limited",
  `Vous avez déjà contacté ${CONTACT_DAILY_SELLER_LIMIT} vendeurs aujourd'hui : réessayez demain.`,
  { "retry-after": String(secondsUntilNextUtcDay(now)) },
);

/** Défaut du planificateur : `after()` de Next.js (la tâche s'exécute une fois la réponse envoyée ; hors requête, `after` lève et la fiche journalise le code). */
export function scheduleAfterResponse(task: () => Promise<void>): void {
  after(task);
}

function logCodeOf(error: unknown): string {
  if (error instanceof MetricsError) return error.code;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && LOG_CODE.test(code) ? code : "unexpected_error";
}

// ───────────── DTO des statistiques (liste blanche, dates en ISO) ─────────────

function boostDto(boost: BoostStats): Omit<BoostStats, "startsAt" | "endsAt"> & { startsAt: string; endsAt: string } {
  return { ...boost, startsAt: boost.startsAt.toISOString(), endsAt: boost.endsAt.toISOString() };
}

function statsDto(stats: OfferStats) {
  return {
    contractVersion: OFFER_STATS_CONTRACT_VERSION,
    activeMatches: stats.activeMatches,
    periods: stats.periods,
    boosts: stats.boosts.map(boostDto),
  };
}

// ───────────── gestionnaires ─────────────

/** Aucun paramètre de requête n'est admis sur ces routes. */
function hasQuery(request: Request): boolean {
  return [...new URL(request.url).searchParams.keys()].length > 0;
}

export function createMetricsHttpHandlers(dependencies: MetricsHttpDependencies = {}): MetricsHttpHandlers {
  const environment = (): Environment => dependencies.env ?? process.env;
  const readSession = dependencies.resolveSession ?? resolveStoredSession;
  const readOffer = dependencies.readOffer ?? ((ownerId, demandId, offerId, pool) => readStoredOfferForDemand(ownerId, demandId, offerId, pool));
  const writeView = dependencies.recordView ?? recordOfferView;
  const schedule = dependencies.schedule ?? scheduleAfterResponse;
  const reveal = dependencies.revealContact ?? revealOfferContact;
  const clock = (): Date => (dependencies.now ? dependencies.now() : new Date());

  function journal(code: string): void {
    try {
      if (dependencies.log) dependencies.log(code);
      else console.error(`[metrics-http] ${code}`);
    } catch {
      // Un journal défaillant ne doit jamais changer la réponse.
    }
  }

  function unavailable(code: string): Response {
    journal(code);
    return metricsUnavailable();
  }

  async function authenticate(request: Request): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
    const token = readSingleCookie(request, AUTH_SESSION_COOKIE);
    if (!token) return { ok: false, response: unauthorized() };
    try {
      const session = await readSession(token, { pool: dependencies.pool, now: dependencies.now });
      return session ? { ok: true, userId: session.userId } : { ok: false, response: unauthorized() };
    } catch (error) {
      return { ok: false, response: unavailable(logCodeOf(error)) };
    }
  }

  const poolOf = (): Pool => dependencies.pool ?? getPostgresPool();

  return {
    demandOffers: {
      async get(request, demandId, offerId) {
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (!UUID.test(demandId) || !UUID.test(offerId) || hasQuery(request)) return invalidRequest();
        let detail: StoredOfferDetail | null;
        try {
          detail = await readOffer(authenticated.userId, demandId, offerId, poolOf());
        } catch (error) {
          if (error instanceof CatalogValidationError) return invalidRequest();
          return unavailable(logCodeOf(error));
        }
        if (detail === null) return resourceNotFound();
        const body = mapOfferDetailToDto(detail);
        // Lot PH1 : galerie de l'annonce (l'accès est prouvé par la lecture de la fiche ci-dessus ; décor : une erreur de lecture donne une fiche sans galerie).
        const photos = await readOfferPhotoRefsSafely(poolOf(), detail.item.candidateId);
        if (photos.length > 0) body.details.photos = photos;
        // Ouverture : enregistrée APRÈS l'envoi de la réponse (`after()`), dans une transaction courte et séparée : un journal lent (table verrouillée) ne retarde
        // JAMAIS la fiche. Toute erreur est attrapée, seul son code est journalisé (un seul code par ouverture perdue) : le journal ne change JAMAIS la réponse.
        // Le vendeur d'une annonce n'est jamais compté (recordOfferView). Une ouverture que le délai de 2 s abandonne n'est pas rejouée (compteur).
        const view: OfferViewInput = { offerId: detail.item.candidateId, demandId: demandId.toLowerCase(), viewerId: authenticated.userId };
        const pool = poolOf();
        try {
          schedule(async () => {
            try {
              await writeView(pool, view);
            } catch (error) {
              journal(`offer_view_ignored_${logCodeOf(error)}`);
            }
          });
        } catch (error) {
          journal(`offer_view_ignored_${logCodeOf(error)}`);
        }
        return noStoreJsonResponse(200, body);
      },

      async contact(request, demandId, offerId) {
        // Origine AVANT la session : une requête d'origine douteuse n'atteint ni la base ni la résolution de session.
        const origin = checkPostOrigin(request, environment().NOMA_AUTH_ORIGIN);
        if (origin === "unconfigured") return unavailable("origin_unconfigured");
        if (origin === "forbidden") return forbiddenOrigin();

        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (!UUID.test(demandId) || !UUID.test(offerId) || hasQuery(request)) return invalidRequest();
        const body = await readBodyCapped(request, CONTACT_BODY_MAX_BYTES);
        if (!body.ok || (body.text.trim() !== "" && body.text.trim() !== "{}")) return invalidRequest();
        try {
          const result = await reveal({ pool: poolOf(), viewerId: authenticated.userId, demandId, offerId });
          const links = buildContactLinks(result.phone);
          return noStoreJsonResponse(200, {
            contractVersion: OFFER_CONTACT_CONTRACT_VERSION,
            contact: { phone: result.phone, telUrl: links.telUrl, whatsappUrl: links.whatsappUrl, firstContact: result.firstContact },
          });
        } catch (error) {
          if (error instanceof CatalogValidationError) return invalidRequest();
          if (error instanceof MetricsError) {
            if (error.code === "resource_not_found") return resourceNotFound();
            if (error.code === "offer_not_available") return offerNotAvailable();
            if (error.code === "contact_unavailable") return contactUnavailable();
            if (error.code === "rate_limited") return rateLimited(clock());
          }
          return unavailable(logCodeOf(error));
        }
      },
    },

    offers: {
      async stats(request, offerId) {
        const authenticated = await authenticate(request);
        if (!authenticated.ok) return authenticated.response;
        if (!UUID.test(offerId) || hasQuery(request)) return invalidRequest();
        try {
          const stats = await readOfferStats({ pool: poolOf(), ownerId: authenticated.userId, offerId });
          return noStoreJsonResponse(200, statsDto(stats));
        } catch (error) {
          if (error instanceof CatalogValidationError) return invalidRequest();
          if (error instanceof MetricsError && error.code === "resource_not_found") return resourceNotFound();
          return unavailable(logCodeOf(error));
        }
      },
    },
  };
}

export const defaultMetricsHttpHandlers = createMetricsHttpHandlers();
