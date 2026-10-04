/**
 * Constructeurs de requêtes par connecteur — plus aucune URL codée en dur.
 *
 * Chaque connecteur déclare ses capacités et ses limites ; les critères du
 * besoin non pris en charge sont signalés (jamais silencieux).
 * Clé de cache = source + version du connecteur + requête effective.
 */
import type { ParsedNeed } from "./need";
import { accentNormalize } from "./need";

export interface Capabilities {
  search: boolean;
  location: boolean;
  pagination: boolean;
  itemCheck: boolean;
  services: boolean;
  /** Critères du besoin que ce connecteur ne sait pas traiter. */
  unsupported: string[];
}

export interface BuiltQuery {
  url: string;
  /** Requête effective (texte envoyé au site). */
  query: string;
  capabilities: Capabilities;
  warnings: string[];
}

const CITY_SLUGS: Record<string, string> = {
  abidjan: "abidjan",
  cocody: "abidjan",
  yopougon: "abidjan",
  marcory: "abidjan",
  treichville: "abidjan",
  adjame: "abidjan",
  plateau: "abidjan",
  koumassi: "abidjan",
  "port-bouet": "abidjan",
  bingerville: "abidjan",
  riviera: "abidjan",
  angre: "abidjan",
  bouake: "bouake",
  yamoussoukro: "yamoussoukro",
  "san-pedro": "san-pedro",
  daloa: "daloa",
  korhogo: "korhogo",
};

export function needsText(need: ParsedNeed): string {
  // Seul le produit/service part dans la requête site : les critères
  // (« bon état », « pas de troc »…) sont appliqués localement au filtrage —
  // les inclure viderait les résultats des sites de petites annonces.
  // Le modèle ET sa variante sont toujours reconstructés explicitement :
  // « iPhone 12 Pro 128 Go » → « iphone 12 pro », jamais « pro » seul.
  const modelBase = need.model
    ? `${need.model}${need.variant ? " " + need.variant : ""}`
    : null;
  // les caractéristiques chiffrées (55 pouces, 12 000 BTU, pointure 42…)
  // partent dans la requête : ce sont des spécifications objectives du produit
  const attrText = need.attributes
    .map((a) => `${a.value} ${a.label}`)
    .join(" ");
  // L'IA ordonne les formulations avec le terme le plus employé dans les
  // annonces locales en premier (« TV », « frigo »…). Les autres variantes
  // servent au rappel lors du filtrage, sans alourdir la requête du site.
  const semanticProduct =
    need.semantic?.searchTerms.find((term) => term.trim().length > 0)?.trim() ||
    need.semantic?.canonicalProduct?.trim() ||
    null;
  const extras = (semanticProduct ?? need.product)
    .split(" ")
    .filter(Boolean)
    .filter((w) => w !== need.model && w !== need.variant)
    .filter((w) => !modelBase || !modelBase.includes(w));
  const parts = [modelBase, attrText, ...extras].filter(Boolean);
  const query = parts.join(" ").trim();
  return query || need.text.split(" ").slice(0, 4).join(" ");
}

function checkUnsupported(need: ParsedNeed, caps: Capabilities): string[] {
  const unsupported: string[] = [];
  if (need.zone && !caps.location) {
    unsupported.push(`zone « ${need.zone} » non filtrée côté site (filtrage local ensuite)`);
  }
  if (need.kind === "service" && !caps.services) {
    unsupported.push("services non pris en charge par ce connecteur");
  }
  if (need.capacity && need.kind === "service") {
    unsupported.push("capacité non pertinente pour un service");
  }
  return unsupported;
}

// ─── CoinAfrique ────────────────────────────────────────────────────────────

export const COINAFRIQUE_VERSION = "v3";

export function coinAfriqueQuery(need: ParsedNeed): BuiltQuery {
  const query = needsText(need) || need.text;
  const capabilities: Capabilities = {
    search: true,
    location: false, // paramètre de zone non validé → filtrage local ensuite
    pagination: true,
    itemCheck: false,
    services: false,
    unsupported: [],
  };
  capabilities.unsupported = checkUnsupported(need, capabilities);
  const url =
    "https://ci.coinafrique.com/search?" +
    new URLSearchParams({ keyword: query }).toString();
  return { url, query, capabilities, warnings: capabilities.unsupported };
}

// ─── Facebook Marketplace ───────────────────────────────────────────────────

export const FACEBOOK_VERSION = "v3";

export function facebookQuery(need: ParsedNeed): BuiltQuery {
  const slug = need.zone ? CITY_SLUGS[accentNormalize(need.zone)] : "abidjan";
  const warnings: string[] = [];
  if (need.zone && !slug) {
    warnings.push(`ville « ${need.zone} » inconnue de Facebook → repli sur Abidjan`);
  }
  const effectiveSlug = slug ?? "abidjan";
  const query = needsText(need) || need.text;
  const capabilities: Capabilities = {
    search: true,
    location: true,
    pagination: false,
    itemCheck: true,
    services: false,
    unsupported: [],
  };
  capabilities.unsupported = checkUnsupported(need, capabilities);
  const url =
    `https://www.facebook.com/marketplace/${effectiveSlug}/search?` +
    new URLSearchParams({ query }).toString();
  return { url, query, capabilities, warnings: [...capabilities.unsupported, ...warnings] };
}

// ─── Locanto ────────────────────────────────────────────────────────────────

export const LOCANTO_VERSION = "v3";

export function locantoQuery(need: ParsedNeed): BuiltQuery {
  const query = needsText(need) || need.text;
  const capabilities: Capabilities = {
    search: true,
    location: true,
    pagination: true,
    itemCheck: false,
    services: true,
    unsupported: [],
  };
  capabilities.unsupported = checkUnsupported(need, capabilities);
  const url =
    "https://www.locanto.ci/g/q/?" +
    new URLSearchParams({ query }).toString();
  return { url, query, capabilities, warnings: capabilities.unsupported };
}

// ─── Google (CSE / :online) ────────────────────────────────────────────────

export const GOOGLE_VERSION = "v3";

/** Requêtes de secours construites depuis le besoin — jamais codées en dur. */
export function serpQueries(need: ParsedNeed): string[] {
  const base = needsText(need);
  const zone = need.zone ?? "";
  return [
    `${base} ${zone} annonce côte d'ivoire`.replace(/\s+/g, " ").trim(),
    `site:facebook.com/marketplace ${base} ${zone}`.replace(/\s+/g, " ").trim(),
    `${base} occasion ${zone || "côte d'ivoire"}`.replace(/\s+/g, " ").trim(),
  ];
}

export function googleQuery(need: ParsedNeed): BuiltQuery {
  const base = needsText(need);
  const query = `${base} côte d'ivoire annonce`.trim();
  const capabilities: Capabilities = {
    search: true,
    location: true,
    pagination: false,
    itemCheck: true,
    services: true,
    unsupported: [],
  };
  capabilities.unsupported = checkUnsupported(need, capabilities);
  return { url: query, query, capabilities, warnings: capabilities.unsupported };
}
