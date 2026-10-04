/**
 * Validation du parcours réel (Lot 6) — Playwright, sources simulées :
 * formulaire → recherche progressive → détail → comparaison → rechargement
 * (sans relance) → annulation. Captures mobile + desktop.
 * Usage: (depuis poc/) npm run ui-parcours
 */
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.NOMA_BASE_URL ?? "http://localhost:3210";
const OUT = "/tmp/opencode/noma-ui";
mkdirSync(OUT, { recursive: true });

const step = (msg: string) => console.log(`→ ${msg}`);
const fail = (msg: string): never => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

async function newPage(browser: Browser, mobile: boolean): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    isMobile: mobile,
    hasTouch: mobile,
  });
  return ctx.newPage();
}

async function main() {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome-stable",
  });

  // ── Parcours desktop complet ────────────────────────────────────────────
  {
    const page = await newPage(browser, false);
    step("accueil");
    await page.goto(`${BASE}/`);
    await page.getByRole("button", { name: /Que recherchez-vous/i }).first().click();
    await page.waitForTimeout(300);

    step("formulaire contrôlé : texte saisi, budget « 150 000 FCFA » normalisé");
    await page.getByPlaceholder(/iPhone 12 en bon état/i).fill("Un iPhone 12 en bon état, à Abidjan");
    await page.getByPlaceholder("FCFA").fill("150 000 FCFA");
    await page.screenshot({ path: `${OUT}/desktop-form.png`, fullPage: true });
    await page.getByRole("button", { name: /Trouver des offres/i }).click();

    step("recherche : résultat progressif (source rapide d'abord)");
    await page.waitForURL("**/recherche");
    await page.waitForSelector("text=annonce simulée", { timeout: 15_000 });
    await page.waitForTimeout(2_500); // source lente arrivée
    await page.screenshot({ path: `${OUT}/desktop-resultats.png`, fullPage: true });

    step("aucune valeur fictive imposée : besoin saisi + budget normalisé affichés");
    const needShown = await page.locator("text=Un iPhone 12 en bon état, à Abidjan").count();
    if (needShown === 0) fail("le besoin saisi n'apparaît pas sur la page résultats");
    const budgetShown = await page.locator("text=150\\u00a0000 F max").count()
      + await page.locator("text=150 000 F max").count();
    if (budgetShown === 0) fail("le budget normalisé n'apparaît pas sur la page résultats");
    const fakeOffersCount = await page.locator("text=annonce simulée").count();
    if (fakeOffersCount < 3) fail(`trop peu d'offres réelles affichées (${fakeOffersCount})`);

    step("détail : première offre réelle");
    await page.locator("a", { hasText: "annonce simulée n°1" }).first().click();
    await page.waitForURL("**/offre/**");
    await page.waitForSelector("text=Pourquoi cette offre ?");
    const sourceShown = await page.locator("text=Annonce externe").count();
    if (sourceShown === 0) fail("le détail n'affiche pas le badge annonce externe");
    await page.screenshot({ path: `${OUT}/desktop-detail.png`, fullPage: true });

    step("comparaison : 2 offres réelles");
    await page.goBack();
    await page.waitForURL("**/recherche");
    const checkboxes = page.getByRole("button", { name: "Sélectionner pour comparer" });
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();
    await page.locator("a", { hasText: /Comparer les 2 offres/ }).click();
    await page.waitForURL("**/comparer");
    await page.waitForSelector("text=Voir l'offre");
    await page.screenshot({ path: `${OUT}/desktop-comparaison.png`, fullPage: true });

    step("rechargement : résultats restaurés sans relance");
    await page.goto(`${BASE}/recherche`);
    await page.waitForSelector("text=annonce simulée");
    await page.waitForTimeout(500);
    const stillDone = await page.locator("text=Des pistes pour vous.").count();
    if (stillDone === 0) fail("après rechargement, les résultats ne sont pas restaurés");
    await page.screenshot({ path: `${OUT}/desktop-rechargement.png`, fullPage: true });
    await page.context().close();
  }

  // ── Parcours mobile : annulation et détail introuvable ──────────────────
  {
    const page = await newPage(browser, true);
    step("mobile : formulaire → recherche (budget « 150k » normalisé)");
    await page.goto(`${BASE}/`);
    await page.getByRole("button", { name: /Que recherchez-vous/i }).first().click();
    await page.getByPlaceholder(/iPhone 12 en bon état/i).fill("canapé 3 places à Cocody");
    await page.getByPlaceholder("FCFA").fill("150k");
    await page.getByRole("button", { name: /Trouver des offres/i }).click();
    await page.waitForURL("**/recherche");
    await page.waitForSelector("text=annonce simulée", { timeout: 15_000 });
    await page.screenshot({ path: `${OUT}/mobile-resultats.png`, fullPage: true });

    step("mobile : annulation — les résultats partiels restent");
    await page.getByRole("button", { name: "Arrêter" }).click();
    await page.waitForTimeout(200);
    const partial = await page.locator("text=annonce simulée").count();
    if (partial === 0) fail("les résultats partiels ont disparu après annulation");
    await page.screenshot({ path: `${OUT}/mobile-annulation.png`, fullPage: true });

    step("mobile : détail introuvable = état explicite (jamais la 1re offre fictive)");
    await page.goto(`${BASE}/offre/id-inconnu-123`);
    await page.waitForSelector("text=Cette offre n'est pas dans vos résultats");
    await page.screenshot({ path: `${OUT}/mobile-detail-inconnu.png`, fullPage: true });
    await page.context().close();
  }

  await browser.close();
  console.log(`✔ parcours complet validé (mobile + desktop) — captures dans ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});