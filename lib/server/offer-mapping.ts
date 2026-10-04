/**
 * Mapping ScoredListing (moteur) → Offre publique (contrat partagé) —
 * Lot 2/5. Fonctions pures, sans dépendance serveur au-delà du hachage :
 * ni coordonnées du vendeur, ni ledger, ni description brute, ni erreur
 * technique. URL http/https uniquement (sanitizePublicUrl). La devise est
 * transportée telle quelle — zéro conversion implicite.
 */
import { createHash } from "node:crypto";
import { sanitizePublicUrl, type PublicOffer } from "../contracts";
import type { RawListing } from "../../poc/lib/normalize.js";
import type { ScoredListing } from "../../poc/lib/scoring.js";

/** Libellés d'affichage des sources connues ; les autres (hostnames du
 *  secours SERP) sont affichés tels quels. */
const SOURCE_LABELS: Record<string, string> = {
  coinafrique: "CoinAfrique",
  facebook: "Facebook Marketplace",
  locanto: "Locanto",
  google: "Google",
};

/** Identifiant STABLE : dérivé du contenu (URL canonique sinon identité),
 *  identique entre les instantanés progressifs et le résultat final. */
export function publicOfferId(listing: RawListing): string {
  const basis =
    listing.url ??
    `${listing.source}|${listing.title}|${listing.price ?? "nd"}|${listing.zone ?? ""}`;
  return `o-${createHash("sha1").update(basis).digest("hex").slice(0, 16)}`;
}

export function toPublicOffer(scored: ScoredListing): PublicOffer {
  const listing = scored.evaluated.listing;
  return {
    id: publicOfferId(listing),
    title: listing.title,
    price: listing.price,
    currency: listing.currency || "FCFA",
    location: listing.zone,
    source: SOURCE_LABELS[listing.source] ?? listing.source,
    url: sanitizePublicUrl(listing.url),
    photo: sanitizePublicUrl(listing.photo),
    justification: scored.raison,
    confirmed: scored.criteria
      .filter((c) => c.valeur !== null && c.valeur !== undefined)
      .map((c) => `${c.nom} : ${c.valeur}`),
    aiStatus: scored.aiStatus,
  };
}

export const sourceLabel = (source: string): string =>
  SOURCE_LABELS[source] ?? source;