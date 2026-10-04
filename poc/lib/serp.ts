import { logLine } from "./log";
import { USER_AGENT } from "./env";
import * as cheerio from "cheerio";

export interface SerpLink {
  title: string;
  url: string;
}

function decodeBing(href: string): string {
  if (!href.includes("bing.com/ck/")) return href;
  try {
    const u = new URL(href);
    const encoded = u.searchParams.get("u") ?? "";
    if (encoded.startsWith("a1")) {
      const b64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      if (decoded.startsWith("http")) return decoded;
    }
  } catch {
    /* ignore */
  }
  return href;
}

function decodeDdg(href: string): string | null {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    if (u.pathname.startsWith("/l/")) {
      const target = u.searchParams.get("uddg");
      return target ? decodeURIComponent(target) : null;
    }
    return href.startsWith("http") ? href : null;
  } catch {
    return null;
  }
}

async function bingLinks(query: string, limit = 8, signal?: AbortSignal): Promise<SerpLink[]> {
  const res = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=fr`,
    {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "fr-FR,fr;q=0.9",
      },
      signal,
    },
  );
  if (!res.ok) return [];
  const $ = cheerio.load(await res.text());
  const out: SerpLink[] = [];
  $("li.b_algo h2 a, li.b_algo a[href^=http]").each((_, el) => {
    const title = $(el).text().trim();
    const url = decodeBing($(el).attr("href") ?? "");
    if (title && url.startsWith("http") && !out.some((o) => o.url === url)) {
      out.push({ title, url });
    }
  });
  return out.slice(0, limit);
}

export async function serpLinks(query: string, limit = 8, signal?: AbortSignal): Promise<SerpLink[]> {
  const ddg = await ddgLinks(query, limit, signal);
  if (ddg.length > 0) return ddg;
  return bingLinks(query, limit, signal);
}

async function ddgLinks(query: string, limit = 8, signal?: AbortSignal): Promise<SerpLink[]> {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": USER_AGENT }, signal },
  );
  if (!res.ok) {
    logLine(`  ⚠ SERP HTTP ${res.status} pour "${query}"`);
    return [];
  }
  const $ = cheerio.load(await res.text());
  const out: SerpLink[] = [];
  $("a.result__a").each((_, el) => {
    const title = $(el).text().trim();
    const url = decodeDdg($(el).attr("href") ?? "");
    if (title && url && !out.some((o) => o.url === url)) {
      out.push({ title, url });
    }
  });
  return out.slice(0, limit);
}

const LISTING_HINTS = [
  "coinafrique",
  "locanto",
  "facebook.com/marketplace",
  "jumia",
  "jiji",
  "annonces",
  "vente",
  "occasion",
];

export function looksLikeListing(url: string): boolean {
  const u = url.toLowerCase();
  return LISTING_HINTS.some((h) => u.includes(h));
}