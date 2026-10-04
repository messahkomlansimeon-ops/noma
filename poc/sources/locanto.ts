import { chromium } from "playwright";
import { CHROME_PATH, USER_AGENT } from "../lib/env";
import { locantoQuery, LOCANTO_VERSION, type BuiltQuery } from "../lib/query";
import { cacheKey, cached, avecCache, type CacheReadMeta } from "../lib/cache";
import type { ParsedNeed } from "../lib/need";
import type { RawListing } from "../lib/normalize";
import { mkdirSync, writeFileSync } from "node:fs";
import { evidenceDir } from "../lib/evidence";
import * as cheerio from "cheerio";
import { sleep } from "../lib/log";
import { emptyResult, type SourceResult } from "./types";

function timeSince(unix: number): string {
  const diff = Date.now() / 1000 - unix;
  const mins = Math.round(diff / 60);
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `il y a ${days} j`;
  return `il y a ${Math.round(days / 30)} mois`;
}

export async function fetchLocanto(need: ParsedNeed, signal?: AbortSignal): Promise<SourceResult> {
  const built: BuiltQuery = locantoQuery(need);
  const cacheable = (r: SourceResult) => r.status === "ok" || r.status === "empty";
  if (signal?.aborted) {
    return emptyResult("locanto", built.url, built.capabilities, "timeout", 0, [
      "annulé avant le lancement du navigateur",
    ]);
  }
  const t0Outer = Date.now();
  const meta: CacheReadMeta = {};
  const res = await cached(
    cacheKey("locanto", LOCANTO_VERSION, built.url),
    async (): Promise<SourceResult> => {
  const t0 = Date.now();
  mkdirSync("evidence", { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const onAbort = () => browser.close().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: "fr-FR",
    });
    const page = await context.newPage();
    try {
      if (signal?.aborted) {
        return emptyResult("locanto", built.url, built.capabilities, "timeout", Date.now() - t0, ["annulé"]);
      }
      await page.goto(built.url, { waitUntil: "domcontentloaded", timeout: 35000, signal });
      await sleep(5000);
      // Le site redirige parfois vers l'accueil : on relance via le formulaire.
      let found = await page.$$("article.posting_listing");
      if (found.length === 0) {
        const input = await page.$(
          'input[type="search"], input[name*="query"], input[name*="q"]',
        );
        if (input) {
          await input.fill(need.product || need.text);
          await input.press("Enter");
          await sleep(6000);
          found = await page.$$("article.posting_listing");
        }
      }
      const title = await page.title();
      const html = await page.content();
      // preuves : dossier PAR RUN si artefacts demandés, sinon aucune écriture
      const ev = evidenceDir("locanto");
      if (ev) {
        writeFileSync(`${ev}/search.html`, html.slice(0, 800000));
        await page.screenshot({ path: `${ev}/search.png` });
      }

      if (/attention required|access denied|captcha/i.test(title + html.slice(0, 3000))) {
        return emptyResult("locanto", built.url, built.capabilities, "blocked", Date.now() - t0, ["blocage anti-bot"]);
      }

      const $ = cheerio.load(html);
      const listings: RawListing[] = [];
      $("article.posting_listing").each((i, el) => {
        try {
          const $el = $(el);
          const link = $el.find("a.posting_listing__title").first();
          const href = link.attr("href") ?? null;
          const rawTitle = $el.find(".js-result_title").first().text().trim();
          if (!href || !rawTitle) return;
          const priceText = $el.find(".posting_listing__price").first().text().trim();
          const priceMatch = priceText.match(/([\d\s.,]+)\s*CFA/i);
          const price = priceMatch
            ? parseFloat(priceMatch[1].replace(/[\s.,]/g, ""))
            : null;
          const desc = $el.find(".posting_listing__description").text().trim();
          const img = $el.find("img").first().attr("src") ?? null;
          const unix = $el.attr("data-unix");
          const titleClean = rawTitle.replace(/,\s*Abidjan\s*$/i, "").trim();
          listings.push({
            id: `loc-${$el.attr("data-msgid") ?? i}`,
            source: "locanto",
            title: titleClean.slice(0, 120),
            price: Number.isFinite(price) ? price : null,
            currency: price === null ? "unknown" : "FCFA",
            zone: rawTitle.match(/,\s*([^,]+)$/)?.[1]?.trim() ?? null,
            vendor: null,
            url: href,
            photo: img,
            date: unix ? timeSince(parseFloat(unix)) : null,
            description:
              (price === null ? "Prix sur demande — " : "") +
              (desc.slice(0, 280) || null),
          });
        } catch {
          // article inattendu ignoré
        }
      });
      const callView = listings.filter((l) => l.price === null).length;
      const warnings = [...built.warnings];
      if (callView > 0) {
        warnings.push(`${callView} annonces « call view » conservées (prix sur demande)`);
      }
      return {
        source: "locanto",
        query: built.url,
        capabilities: built.capabilities,
        warnings,
        listings,
        status: listings.length > 0 ? "ok" : "empty",
        durationMs: Date.now() - t0,
        errors: [],
      };
    } finally {
      await page.close().catch(() => {});
    }
  } catch (e) {
    return emptyResult(
      "locanto",
      built.url,
      built.capabilities,
      "error",
      Date.now() - t0,
      [(e as Error).message.slice(0, 200)],
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await browser.close().catch(() => {});
  }
    },
    cacheable,
    undefined,
    meta,
  );
  return avecCache(res, meta, Date.now() - t0Outer);
}