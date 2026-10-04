import { chromium } from "playwright";
import { CHROME_PATH, USER_AGENT } from "./lib/env";
import { mkdirSync, writeFileSync } from "node:fs";
import { sleep } from "./lib/log";

// Test : l'URL ville Abidjan change-t-elle la géographie sans login ?
mkdirSync("evidence", { recursive: true });
const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  userAgent: USER_AGENT,
  viewport: { width: 1280, height: 900 },
  locale: "fr-FR",
});
const page = await context.newPage();
try {
  await page.goto(
    "https://www.facebook.com/marketplace/abidjan/search?query=iphone%2012",
    { waitUntil: "domcontentloaded", timeout: 35000 },
  );
  await sleep(6000);
  console.log("URL finale:", page.url().slice(0, 90));
  console.log("titre:", (await page.title()).slice(0, 60));
  const items = await page.$$eval('a[href*="/marketplace/item/"]', (els) =>
    els.slice(0, 8).map((e) => (e as HTMLAnchorElement).closest('[role="link"]')?.textContent?.slice(0, 80) ?? (e as HTMLAnchorElement).getAttribute("aria-label")?.slice(0, 80) ?? ""),
  );
  console.log("items:", items.length);
  for (const it of items.slice(0, 5)) console.log(" ·", it.replace(/\n/g, " | "));
  await page.screenshot({ path: "evidence/fb-abidjan.png" });
  writeFileSync(
    "results/fb-abidjan-cards.json",
    JSON.stringify(items, null, 1),
  );
} catch (e) {
  console.error("ERR:", (e as Error).message.slice(0, 150));
}
await browser.close();