/**
 * Déduplication par identité — v2 (cahier des charges §4).
 *
 * - fusion UNIQUEMENT si même source + identifiant stable ou URL canonique
 *   équivalente (après retrait des seuls paramètres de suivi connus) ;
 * - jamais de fusion sur similarité titre+prix : deux vendeurs avec le même
 *   produit au même prix restent deux offres distinctes ;
 * - les ressemblances inter-sources deviennent des « groupes de doublons
 *   possibles », sans suppression ;
 * - en cas de fusion certaine, on conserve les provenances et on complète
 *   les informations manquantes par celles des doublons.
 */
import type { RawListing } from "./normalize";
import { accentNormalize } from "./need";

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "msclkid", "dclid", "twclid",
  "spm", "scm", "share_url", "origin", "referrer", "referrer_source",
  "_position", "_trk", "_trkparms", "ref", "ref_src", "ref_loc",
]);

/** URL canonique : protocole forcé https, www retiré, hash retiré,
 *  seuls les paramètres de suivi connus sont supprimés (ad?id=1 reste ad?id=1). */
export function canonicalUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.protocol = "https:";
    u.hash = "";
    if (u.hostname.startsWith("www.")) {
      u.hostname = u.hostname.slice(4);
    }
    for (const p of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
    }
    u.searchParams.sort();
    let s = u.toString();
    if (s.endsWith("?")) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

function tokenSet(title: string): Set<string> {
  const GENERIC = new Set([
    "go", "gb", "simple", "telephone", "mobile", "occasion", "neuf", "pas",
    "cher", "avec", "sans", "boite", "annonce", "vente", "cfa", "fcfa",
    "cote", "ivoire", "abidjan",
  ]);
  return new Set(
    accentNormalize(title)
      .replace(/\bgb\b/g, "go")
      .split(" ")
      .filter((w) => w.length >= 2 && !GENERIC.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface DedupResult {
  kept: RawListing[];
  /** Annonces fusionnées (même identité), par id gardé. */
  mergedFrom: Record<string, string[]>;
  /** Groupes de doublons POSSIBLES entre sources (aucune suppression). */
  possibleDuplicates: { ids: string[]; sources: string[] }[];
  exactDuplicates: number;
}

export function dedupListings(listings: RawListing[]): DedupResult {
  const byIdentity = new Map<string, RawListing>();
  const mergedFrom: Record<string, string[]> = {};
  let exactDuplicates = 0;

  // 1. fusion certaine : même source + identifiant stable ou URL canonique
  for (const l of listings) {
    const canon = canonicalUrl(l.url);
    // identité : URL canonique équivalente (transverse aux étiquettes de
    // source — une même annonce vue sur ci.coinafrique.com et coinafrique
    // est la même) ; sinon identifiant stable + source
    const identity = canon ?? `${l.source}#${l.id}`;
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, { ...l });
    } else {
      exactDuplicates++;
      // complément d'informations : premiers champs non nuls gagnent
      const merged: RawListing = { ...existing };
      merged.photo ??= l.photo;
      merged.zone ??= l.zone;
      merged.price ??= l.price;
      merged.date ??= l.date;
      merged.vendor ??= l.vendor;
      merged.description = [existing.description, l.description]
        .filter(Boolean)
        .join(" — ") || null;
      byIdentity.set(identity, merged);
      (mergedFrom[existing.id] ??= []).push(l.id);
    }
  }

  const kept = [...byIdentity.values()];

  // 2. groupes de doublons POSSIBLES entre sources différentes (sans suppression)
  const tokenCache = kept.map((l) => tokenSet(l.title));
  const used = new Set<number>();
  const possibleDuplicates: DedupResult["possibleDuplicates"] = [];
  for (let i = 0; i < kept.length; i++) {
    if (used.has(i)) continue;
    const group = [kept[i]];
    const sources = new Set([kept[i].source]);
    for (let j = i + 1; j < kept.length; j++) {
      if (used.has(j)) continue;
      if (kept[j].source === kept[i].source) continue;
      const sameZone =
        (kept[i].zone ?? "") === (kept[j].zone ?? "") ||
        !kept[i].zone || !kept[j].zone;
      if (jaccard(tokenCache[i], tokenCache[j]) >= 0.75 && sameZone) {
        group.push(kept[j]);
        sources.add(kept[j].source);
        used.add(j);
      }
    }
    if (group.length > 1) {
      used.add(i);
      possibleDuplicates.push({
        ids: group.map((g) => g.id),
        sources: [...sources],
      });
    }
  }

  return { kept, mergedFrom, possibleDuplicates, exactDuplicates };
}