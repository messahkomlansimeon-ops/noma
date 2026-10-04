/**
 * Validation du Turnstile CÔTÉ FORMULAIRE (bêta privée) — Playwright avec
 * widget Turnstile SIMULÉ (aucun appel au CDN, aucun siteverify) :
 *  - jeton absent      → la recherche ne part pas, message explicite ;
 *  - jeton transmis    → turnstileToken dans le corps POST /api/search ;
 *  - renouvellement    → widget réinitialisé après usage, nouveau jeton exigé ;
 *  - expiration        → jeton annulé, recherche bloquée ;
 *  - erreur du widget  → message « indisponible ».
 * Prérequis : serveur de développement lancé avec
 *   NEXT_PUBLIC_TURNSTILE_SITE_KEY=<clé> NOMA_FAKE_SOURCES=1 \
 *   NOMA_TURNSTILE_DISABLED=1 NOMA_AI_DISABLED=1 npm run dev -- -p 3210
 * (le serveur accepte sans siteverify : ce script ne prétend PAS tester
 *  Turnstile réel — voir BETA-CHECKLIST.md).
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.NOMA_BASE_URL ?? "http://localhost:3210";
const OUT = "/tmp/opencode/noma-ui-turnstile";
mkdirSync(OUT, { recursive: true });

const step = (msg: string) => console.log(`→ ${msg}`);
const fail = (msg: string): never => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

/** Widget simulé : mêmes points d'entrée que l'API Cloudflare, callbacks
 *  déclenchables depuis le test. `reset` ne régénère PAS de jeton : après
 *  usage, un nouveau callback est exigé (comme le vrai widget). */
const MOCK_TURNSTILE = `
window.turnstile = {
  render(el, opts) {
    el.dataset.renderedWidget = "1";
    window.__ts = opts;
    window.__tsState = { resets: 0 };
    return "w1";
  },
  reset(id) { window.__tsState.resets++; }
};
window.__tsFire = (cb, token) => window.__ts && window.__ts[cb] && window.__ts[cb](token);
`;

declare global {
  interface Window {
    __ts: {
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    };
    __tsState: { resets: number };
    __tsFire: (cb: string, token?: string) => void;
  }
}

async function main() {
  // quotas : 2 démarrages/minute par IP — chaque rejeu s'aligne sur une
  // frontière de minute pour être répétable
  const waitMs = 60_000 - (Date.now() % 60_000) + 500;
  if (waitMs < 59_000) {
    console.log(`→ attente d'une frontière de minute (${Math.ceil(waitMs / 1000)} s) pour reposer les quotas`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome-stable" });
  // IP distincte par contexte (proxy de confiance du serveur de test) : chaque
  // contexte dispose de son propre bucket de quota IP, comme des testeurs distincts.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { "x-forwarded-for": "203.0.113.50", "x-noma-proxy-secret": "secret-ui-tests" },
  });
  const page = await context.newPage();

  // interception : le « script Turnstile » est servi localement (jamais de réseau)
  const searchPosts: string[] = [];
  page.on("response", (res) => {
    if (res.url().endsWith("/api/search") && res.request().method() === "POST") {
      step(`POST /api/search → ${res.status()}`);
    }
  });
  page.on("request", (req) => {
    if (req.url().endsWith("/api/search") && req.method() === "POST") {
      searchPosts.push(req.postData() ?? "");
    }
  });
  await page.route(/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/, (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: MOCK_TURNSTILE }),
  );

  const openForm = async (): Promise<void> => {
    await page.goto(`${BASE}/`);
    await page.getByRole("button", { name: /Que recherchez-vous/i }).first().click();
    await page.waitForSelector("text=Que cherchez-vous ?");
    await page.getByPlaceholder(/iPhone 12 en bon état/i).fill("Un iPhone 12 en bon état, à Abidjan");
  };
  const widgetRendered = async (): Promise<void> => {
    await page.waitForSelector("[data-rendered-widget]", { state: "attached", timeout: 5_000 });
  };
  const clickSearch = (): Promise<void> =>
    page.getByRole("button", { name: /Trouver des offres/i }).click();

  // ── 1. Jeton ABSENT : aucune recherche envoyée ────────────────────────────
  step("jeton absent : le bouton ne lance rien, message explicite");
  await openForm();
  await widgetRendered();
  await clickSearch();
  await page.waitForSelector("text=Vérification anti-robot en cours…", { timeout: 5_000 });
  if (page.url() !== `${BASE}/`) fail("navigation vers /recherche sans jeton !");
  if (searchPosts.length > 0) fail("POST /api/search envoyé sans jeton !");
  await page.screenshot({ path: `${OUT}/desktop-jeton-absent.png`, fullPage: true });

  // ── 2. EXPIRATION : le jeton obtenu est annulé avant usage ────────────────
  step("expiration : jeton annulé, recherche bloquée");
  await page.evaluate(() => window.__tsFire("callback", "tok-expire"));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__tsFire("expired-callback"));
  await page.waitForTimeout(200);
  await clickSearch();
  await page.waitForSelector("text=Vérification anti-robot en cours…", { timeout: 5_000 });
  if (searchPosts.length > 0) fail("POST /api/search envoyé avec un jeton expiré !");

  // ── 3. ERREUR du widget : message « indisponible » ────────────────────────
  step("erreur du widget : message « indisponible »");
  await page.evaluate(() => window.__tsFire("error-callback"));
  await page.waitForTimeout(200);
  await clickSearch();
  await page.waitForSelector(
    "text=Vérification anti-robot indisponible. Rechargez la page.",
    { timeout: 5_000 },
  );
  if (searchPosts.length > 0) fail("POST /api/search envoyé malgré l'erreur du widget !");

  // ── 4. TRANSMISSION : le jeton part dans le corps du POST ─────────────────
  step("transmission : callback → recherche lancée avec turnstileToken");
  await page.evaluate(() => window.__tsFire("callback", "tok-abc-1"));
  await page.waitForTimeout(200);
  await clickSearch();
  await page.waitForURL("**/recherche", { timeout: 10_000 });
  await page.waitForSelector("text=annonce simulée", { timeout: 15_000 });
  const withToken = searchPosts.find((b) => b.includes("tok-abc-1"));
  if (!withToken) fail(`turnstileToken « tok-abc-1 » absent du POST (${searchPosts.length} POST)`);
  step("renouvellement après usage : widget réinitialisé, jeton effacé");
  // la réinitialisation a lieu à la FIN du flux (après completed)
  await page.waitForSelector("text=Des pistes pour vous.", { timeout: 15_000 });
  const resets = await page.evaluate(() => window.__tsState.resets);
  if (resets < 1) fail(`widget non réinitialisé après usage (${resets} reset)`);
  await page.screenshot({ path: `${OUT}/desktop-resultats-jeton.png`, fullPage: true });

  // ── 5. NOUVEAU jeton exigé : sans callback, la relance est bloquée ────────
  step("relance sans nouveau jeton : bloquée (renouvellement obligatoire)");
  await page.goBack();
  await page.waitForURL(`${BASE}/`);
  await page.getByRole("button", { name: /Que recherchez-vous/i }).first().click();
  await page.waitForSelector("text=Que cherchez-vous ?");
  await widgetRendered();
  const postsBefore = searchPosts.length;
  await clickSearch();
  await page.waitForSelector("text=Vérification anti-robot en cours…", { timeout: 5_000 });
  if (searchPosts.length > postsBefore) fail("recherche relancée avec l'ancien jeton !");

  // ── 6. RENOUVELLEMENT : un NOUVEAU jeton est transmis (pas l'ancien) ──────
  step("nouveau jeton transmis : tok-2, jamais l'ancien");
  await page.evaluate(() => window.__tsFire("callback", "tok-abc-2"));
  await page.waitForTimeout(200);
  await clickSearch();
  await page.waitForURL("**/recherche", { timeout: 10_000 });
  await page.waitForSelector("text=annonce simulée", { timeout: 15_000 });
  const renewed = searchPosts.slice(postsBefore).find((b) => b.includes("tok-abc-2"));
  if (!renewed) fail("nouveau jeton « tok-abc-2 » non transmis");
  if (searchPosts.slice(postsBefore).some((b) => b.includes("tok-abc-1"))) {
    fail("ancien jeton réutilisé après renouvellement !");
  }

  // ── 7. Mobile : même comportement (jeton requis avant recherche) ──────────
  step("mobile : jeton requis avant recherche");
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    extraHTTPHeaders: { "x-forwarded-for": "203.0.113.51", "x-noma-proxy-secret": "secret-ui-tests" },
  });
  const mPage = await mobile.newPage();
  const mobilePosts: string[] = [];
  mPage.on("request", (req) => {
    if (req.url().endsWith("/api/search") && req.method() === "POST") {
      mobilePosts.push(req.postData() ?? "");
    }
  });
  await mPage.route(/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/, (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: MOCK_TURNSTILE }),
  );
  await mPage.goto(`${BASE}/`);
  await mPage.getByRole("button", { name: /Que recherchez-vous/i }).first().click();
  await mPage.waitForSelector("text=Que cherchez-vous ?");
  await mPage.getByPlaceholder(/iPhone 12 en bon état/i).fill("chargeur USB-C 20 W");
  await mPage.waitForSelector("[data-rendered-widget]", { state: "attached", timeout: 5_000 });
  await mPage.getByRole("button", { name: /Trouver des offres/i }).click();
  await mPage.waitForSelector("text=Vérification anti-robot en cours…", { timeout: 5_000 });
  if (mobilePosts.length > 0) fail("mobile : POST envoyé sans jeton !");
  await mPage.screenshot({ path: `${OUT}/mobile-jeton-absent.png`, fullPage: true });
  await mPage.evaluate(() => window.__tsFire("callback", "tok-mobile-1"));
  await mPage.waitForTimeout(200);
  await mPage.getByRole("button", { name: /Trouver des offres/i }).click();
  await mPage.waitForURL("**/recherche", { timeout: 10_000 });
  await mPage.waitForSelector("text=annonce simulée", { timeout: 15_000 });
  if (!mobilePosts.some((b) => b.includes("tok-mobile-1"))) fail("mobile : jeton non transmis");
  await mPage.screenshot({ path: `${OUT}/mobile-resultats-jeton.png`, fullPage: true });
  await mobile.close();

  await browser.close();
  console.log(
    `✔ Turnstile côté formulaire validé (7 scénarios, ${searchPosts.length + mobilePosts.length} POST analysés) — captures dans ${OUT}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
