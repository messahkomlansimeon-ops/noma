import { chromium } from "playwright";
import { CHROME_PATH, USER_AGENT } from "../lib/env";
import { facebookQuery, FACEBOOK_VERSION, type BuiltQuery } from "../lib/query";
import { cacheKey, cached, avecCache, type CacheReadMeta } from "../lib/cache";
import type { ParsedNeed } from "../lib/need";
import type { RawListing } from "../lib/normalize";
import { writeFileSync } from "node:fs";
import { evidenceDir } from "../lib/evidence";
import { sleep } from "../lib/log";
import { emptyResult, type SourceResult } from "./types";

function parseCardText(
  id: string,
  url: string,
  text: string,
  photo: string | null,
): RawListing | null {
  const flat = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length < 4) return null;

  let price: number | null = null;
  let currency = "FCFA";
  let rest = flat;

  const curLast = rest.match(/([\d][\d\s.,]{0,11})\s*(F\s?CFA|FCFA|CFA)(?=[^a-z]|$)/i);
  const usdLast = rest.match(/([\d][\d\s.,]{0,9})\s*\$?\s*US\b/i);
  const curFirst = rest.match(/(F\s?CFA|FCFA|CFA)\s*([\d][\d\s.,]{0,11})/i);
  const usdFirst = rest.match(/\$?\s*US\s*([\d][\d\s.,]{0,9})/i);
  const match = curLast ?? usdLast ?? curFirst ?? usdFirst;
  if (match) {
    price = parseFloat(match[curLast || usdLast ? 1 : 2].replace(/[\s.,]/g, ""));
    if (!Number.isFinite(price)) price = null;
    currency = usdFirst || usdLast ? "USD" : "FCFA";
    rest = rest
      .replace(/[\d][\d\s.,]{0,11}\s*(?:F\s?CFA|FCFA|CFA)/gi, " ")
      .replace(/(?:F\s?CFA|FCFA|CFA)\s*[\d][\d\s.,]{0,11}/gi, " ")
      .replace(/[\d][\d\s.,]{0,9}\s*\$?\s*US\b/gi, " ")
      .replace(/\$?\s*US\s*[\d][\d\s.,]{0,9}/gi, " ");
  }

  const cityRegex =
    /\b(Abidjan|Cocody|Yopougon|Marcory|Treichville|Adjamé|Koumassi|Port-Bouët|Bingerville|Grand-Bassam|Riviera|Angré|Plateau|Abatta|Songon|Anyama|Bouaké|San[ -]?Pedro)\b/i;
  let zone: string | null = null;
  const zoneMatch = rest.match(cityRegex);
  if (zoneMatch) {
    zone = zoneMatch[1];
    rest = rest.replace(zoneMatch[0], " ");
  }

  const title = rest
    .replace(/Annonce récente|Sponsored|Parrainé/gi, " ")
    .replace(/[|·]+/g, " ")
    .replace(/[\d][\d\s.,]{0,11}\s*(?:F\s?CFA|FCFA|CFA)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!title || title.length < 4) return null;
  return {
    id,
    source: "facebook",
    title: title.slice(0, 120),
    price,
    currency,
    zone,
    vendor: null,
    url,
    photo,
    date: /annonce récente/i.test(flat) ? "récente" : null,
    description: flat.slice(0, 300),
  };
}

export async function fetchFacebook(
  need: ParsedNeed,
  signal?: AbortSignal,
  attempts = 3,
): Promise<SourceResult> {
  const built: BuiltQuery = facebookQuery(need);
  const cacheable = (r: SourceResult) => r.status === "ok" || r.status === "empty";
  if (signal?.aborted) {
    return emptyResult("facebook", built.url, built.capabilities, "timeout", 0, [
      "annulé avant le lancement du navigateur",
    ]);
  }
  const t0Outer = Date.now();
  const meta: CacheReadMeta = {};
  const res = await cached(
    cacheKey("facebook", FACEBOOK_VERSION, built.url),
    async (): Promise<SourceResult> => {
  const t0 = Date.now();
  const errors: string[] = [];
  const warnings = [...built.warnings];
  const evidence: string[] = [];
  // preuves : dossier PAR RUN si artefacts demandés, sinon aucune écriture
  // (des recherches simultanées ne s'écrasent plus mutuellement)
  const ev = evidenceDir("facebook");

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  // annulation : fermeture immédiate du navigateur (revue 2 P1-1)
  const onAbort = () => browser.close().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) {
      return emptyResult("facebook", built.url, built.capabilities, "timeout", Date.now() - t0, ["annulé"]);
    }
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: "fr-FR",
    });

    for (let i = 1; i <= attempts; i++) {
      if (signal?.aborted) {
        return emptyResult("facebook", built.url, built.capabilities, "timeout", Date.now() - t0, [
          `annulé avant la tentative ${i}`,
        ]);
      }
      const page = await context.newPage();
      try {
        await page.goto(built.url, { waitUntil: "domcontentloaded", timeout: 35000 });
        await sleep(4000 + i * 1500);
        const title = await page.title();
        const html = await page.content();
        if (ev) {
          writeFileSync(`${ev}/attempt-${i}.html`, html.slice(0, 500000));
          await page.screenshot({ path: `${ev}/attempt-${i}.png` });
          evidence.push(`${ev}/attempt-${i}.png`);
        }

        const itemLinks = await page.$$eval(
          'a[href*="/marketplace/item/"]',
          (els) =>
            els.slice(0, 20).map((e) => {
              const a = e as HTMLAnchorElement;
              const card =
                (a.closest('[role="link"]') as HTMLElement) ??
                (a.closest("div") as HTMLElement) ??
                a;
              const text =
                (card.innerText || "").trim() || a.getAttribute("aria-label") || "";
              const img =
                a.querySelector("img")?.getAttribute("src") ??
                card.querySelector("img")?.getAttribute("src") ??
                null;
              return { url: a.href, text: text.slice(0, 300), photo: img };
            }),
        );
        const items = itemLinks.filter((x) => x.text.trim().length > 0);

        if (items.length > 0) {
          const listings: RawListing[] = [];
          const seen = new Set<string>();
          for (const it of items) {
            const m = it.url.match(/\/marketplace\/item\/(\d+)/);
            const id = `fb-${m?.[1] ?? seen.size}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const parsed = parseCardText(id, it.url, it.text, it.photo);
            if (parsed) listings.push(parsed);
          }
          if (listings.length > 0) {
            return {
              source: "facebook",
              query: built.url,
              capabilities: built.capabilities,
              warnings,
              listings,
              status: "ok",
              durationMs: Date.now() - t0,
              errors,
              evidence,
            };
          }
          errors.push(`tentative ${i} : ${items.length} liens mais 0 carte parsée`);
        } else {
          const bodyText = await page
            .evaluate(() => document.body.innerText.slice(0, 3000))
            .catch(() => "");
          const loginWall =
            /log in|se connecter|connexion|must log in/i.test(bodyText) ||
            /login_form|loginPageForm|LoginProfilePicture/i.test(html);
          if (loginWall) {
            return emptyResult(
              "facebook",
              built.url,
              built.capabilities,
              "blocked",
              Date.now() - t0,
              [`tentative ${i} : mur de connexion détecté`],
            );
          }
          errors.push(
            `tentative ${i} : 0 item · titre="${title.slice(0, 80)}"`,
          );
        }
      } catch (e) {
        errors.push(`tentative ${i} : ${(e as Error).message.slice(0, 150)}`);
      } finally {
        await page.close().catch(() => {});
      }
      await sleep(2500);
    }
    return emptyResult(
      "facebook",
      built.url,
      built.capabilities,
      errors.some((e) => e.includes("mur de connexion")) ? "blocked" : "empty",
      Date.now() - t0,
      errors,
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
