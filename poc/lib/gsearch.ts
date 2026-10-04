import { z } from "zod";
import { llmJson } from "./llm";
import { GOOGLE_API_KEY, GOOGLE_CX, ONLINE_MODEL } from "./env";
import { googleQuery, GOOGLE_VERSION, type BuiltQuery } from "./query";
import type { ParsedNeed } from "./need";
import { RawListingSchema, type RawListing } from "./normalize";
import { safeFetch, withDownloadSlot, SafeFetchError } from "./fetch";
import { canonicalUrl } from "./dedup";
import { cacheKey, cached } from "./cache";
import { withRetry } from "./retry";
import { logLine } from "./log";
import type { SourceResult } from "../sources/types";

const OnlineSearchSchema = z.object({
  links: z.array(
    z.object({
      title: z.string().nullable().default(""),
      url: z.string(),
    }),
  ),
});

const PageExtractionSchema = z.object({
  title: z.string().nullable().default(null),
  price: z.number().nullable().default(null),
  currency: z.string().nullable().default("FCFA"),
  zone: z.string().nullable().default(null),
  vendor: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  isListing: z.boolean().default(true),
});

/**
 * Clé de cache d'une page : URL canonique (paramètres de suivi retirés,
 * paramètres identifiants conservés — revue P1-6).
 */
export const PAGE_VERSION = "v3";
export function pageCacheKey(url: string): string {
  return cacheKey("page", PAGE_VERSION, canonicalUrl(url) ?? url);
}

/** « Google ciblé Côte d'Ivoire » : CSE API → plugin :online → SERP publics. */
export async function runGoogleSearch(need: ParsedNeed, signal?: AbortSignal): Promise<SourceResult> {
  const built: BuiltQuery = googleQuery(need);
  const t0 = Date.now();
  const errors: string[] = [];
  const warnings = [...built.warnings];

  if (signal?.aborted) {
    return {
      source: "google",
      query: built.url,
      capabilities: built.capabilities,
      warnings,
      listings: [],
      status: "timeout",
      durationMs: 0,
      errors: ["annulé avant la recherche"],
    };
  }

  const cachedSearch = await cached(
    cacheKey("google", GOOGLE_VERSION, built.url),
    async (): Promise<{ links: { title: string; url: string }[]; via: string; note: string } | null> => {
      // 1. API officielle Google CSE
      if (GOOGLE_API_KEY && GOOGLE_CX) {
        const res = await fetch(
          `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(built.query)}&num=10&gl=ci&lr=lang_fr`,
          { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) },
        );
        if (res.ok) {
          const data = (await res.json()) as {
            items?: { title?: string; link?: string }[];
          };
          const links = (data.items ?? [])
            .filter((i) => i.link)
            .map((i) => ({ title: i.title ?? "", url: i.link! }));
          return { links, via: "cse", note: "Google CSE API" };
        }
        errors.push(`CSE HTTP ${res.status}`);
      }
      // 2. Plugin web :online d'OpenRouter
      try {
        const { data, model } = await llmJson(OnlineSearchSchema, {
          task: "google-online",
          models: [ONLINE_MODEL],
          arrayKey: "links",
          system:
            "Tu effectues une recherche web (plugin :online) pour trouver des pages d'annonces réelles en Côte d'Ivoire. Renvoie {links:[{title,url}]}. Uniquement des URLs obtenues via la recherche web — ne jamais inventer une URL.",
          user: `Trouve des pages d'annonces (marketplace, sites de petites annonces, boutiques en ligne) en Côte d'Ivoire pour : ${built.query}. Max 10 liens.`,
          maxTokens: 1200,
          webSearch: true, // plugin :online : frais web hors tokens, réservés
          signal,
        });
        const links = data.links
          .filter((l) => l.url.startsWith("http"))
          .map((l) => ({ title: l.title ?? "", url: l.url }));
        if (links.length > 0) return { links, via: "online", note: `via ${model}` };
      } catch (e) {
        errors.push(`:online échec: ${(e as Error).message.slice(0, 120)}`);
      }
      return null;
    },
    (v) => v !== null && v.links.length > 0,
  );

  if (!cachedSearch) {
    return {
      source: "google",
      query: built.url,
      capabilities: built.capabilities,
      warnings,
      listings: [],
      status: "empty",
      durationMs: Date.now() - t0,
      errors: errors.length ? errors : ["aucune voie de recherche disponible"],
    };
  }
  warnings.push(`recherche ${cachedSearch.via} (${cachedSearch.note})`);

  // Extraction IA des pages cibles (téléchargement sécurisé + cache par page)
  const listings: RawListing[] = [];
  const targets = cachedSearch.links.slice(0, 5);
  for (const target of targets) {
    try {
      const extracted = await cached(
        pageCacheKey(target.url),
        async () => {
          const res = await withDownloadSlot(() =>
            withRetry(
              () =>
                safeFetch(target.url, {
                  headers: { "Accept-Language": "fr-FR,fr;q=0.9" },
                  signal,
                }),
              {
                attempts: 2,
                signal,
                shouldRetry: (e) =>
                  e instanceof SafeFetchError && e.kind === "network",
              },
            ),
          );
          const text = res.body
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .slice(0, 20000);
          return llmJson(PageExtractionSchema, {
            task: "page-extraction",
            system:
              "Tu extrais une annonce du texte d'une page web. Si la page n'est pas une annonce de produit unique, mets isListing=false. Prix numériques uniquement, jamais inventés : champ inconnu = null.",
            user: `Page: ${target.url}\nTitre: ${target.title}\n\nTexte:\n${text}`,
            maxTokens: 1500,
            signal,
          });
        },
        (v) => v !== null && v !== undefined,
      );
      if (!extracted || !extracted.data.isListing) continue;
      const data = extracted.data;
      listings.push(
        RawListingSchema.parse({
          id: `gpage-${listings.length + 1}`,
          source: new URL(target.url).hostname,
          title: data.title ?? target.title,
          price: data.price,
          currency: data.currency ?? "FCFA",
          zone: data.zone,
          vendor: data.vendor,
          url: target.url,
          photo: null,
          date: data.date,
          description: data.description,
        }),
      );
      logLine(
        `   · [${extracted.model}] ${(data.title ?? target.title).slice(0, 55)} — ${data.price ?? "?"}`,
      );
    } catch (e) {
      errors.push(`${target.url.slice(0, 60)}: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  return {
    source: "google",
    query: built.url,
    capabilities: built.capabilities,
    warnings,
    listings,
    status: listings.length > 0 ? "ok" : cachedSearch.links.length > 0 ? "empty" : "error",
    durationMs: Date.now() - t0,
    errors,
  };
}
