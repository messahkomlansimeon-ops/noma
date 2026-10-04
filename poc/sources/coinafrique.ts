import { coinAfriqueQuery, COINAFRIQUE_VERSION, type BuiltQuery } from "../lib/query";
import type { ParsedNeed } from "../lib/need";
import { safeFetch, withDownloadSlot, SafeFetchError } from "../lib/fetch";
import { emptyResult, type SourceResult } from "./types";
import { cacheKey, cached, avecCache, type CacheReadMeta } from "../lib/cache";
import { withRetry } from "../lib/retry";
import { extractCoinAfriqueCheerio } from "./coinafrique-parser";

export async function fetchCoinAfrique(
  need: ParsedNeed,
  signal?: AbortSignal,
): Promise<SourceResult> {
  const built: BuiltQuery = coinAfriqueQuery(need);
  const cacheable = (r: SourceResult) => r.status === "ok" || r.status === "empty";
  if (signal?.aborted) {
    return emptyResult("coinafrique", built.url, built.capabilities, "timeout", 0, [
      "annulé avant la recherche",
    ]);
  }
  const t0Outer = Date.now();
  const meta: CacheReadMeta = {};
  const res = await cached(
    cacheKey("coinafrique", COINAFRIQUE_VERSION, built.url),
    async (): Promise<SourceResult> => {
  const t0 = Date.now();
  const errors: string[] = [];
  try {
    const res = await withDownloadSlot(() =>
      withRetry(
        () =>
          safeFetch(built.url, {
            headers: { "Accept-Language": "fr-FR,fr;q=0.9" },
            signal,
          }),
        {
          attempts: 2,
          signal,
          // seul un incident réseau transitoire mérite une relance — un
          // blocage SSRF, une URL invalide ou un dépassement sont définitifs
          shouldRetry: (e) => e instanceof SafeFetchError && e.kind === "network",
        },
      ),
    );
    const extraction = await extractCoinAfriqueCheerio({
      html: res.body,
      baseUrl: built.url,
    });
    const listings = extraction.listings;
    errors.push(...extraction.errors);
    return {
      source: "coinafrique",
      query: built.url,
      capabilities: built.capabilities,
      warnings: built.warnings,
      listings,
      status: listings.length > 0 ? "ok" : "empty",
      durationMs: Date.now() - t0,
      errors,
    };
  } catch (e) {
    const err = e as SafeFetchError;
    const status =
      err instanceof SafeFetchError && err.kind === "timeout"
        ? "timeout"
        : err instanceof SafeFetchError && err.kind === "blocked"
          ? "blocked"
          : "error";
    return emptyResult(
      "coinafrique",
      built.url,
      built.capabilities,
      status,
      Date.now() - t0,
      [err.message.slice(0, 200)],
    );
  }
    },
    cacheable,
    undefined,
    meta,
  );
  return avecCache(res, meta, Date.now() - t0Outer);
}
