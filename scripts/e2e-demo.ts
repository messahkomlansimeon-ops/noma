/**
 * `npm run e2e:demo` (lot D1) : la DÉMONSTRATION, dans un vrai navigateur (Chrome piloté par Playwright, installé dans poc/, 390 px de large), contre un vrai serveur Next lancé par
 * `npm run dev:try` À TRAVERS LE RELAIS (même cadre que `e2e:ui`). NON inclus dans `npm test`. Parcours :
 *   1. `demo:seed` sur la base noma_e2e (puis une seconde fois : rejouable à l'identique) ;
 *   2. visiteur sans compte : présentation en 3 étapes, bouton « Se connecter », sélecteur d'espace sans chevauchement ;
 *   3. acheteur démo (+225 07 00 00 01 01) : accueil (3 besoins avec leurs correspondances, notifications non lues, « Décrire un besoin »), résultats avec « Sponsorisé »,
 *      fiche d'une annonce (aucun numéro de téléphone, attributs), contact, notifications ;
 *   4. vendeur démo (+225 07 00 00 02 02) : tableau de bord (annonces par statut, besoins correspondants « environ N », solde, boost actif), page d'une annonce avec ses
 *      statistiques (« environ 10 » acheteurs, jamais un compte exact, tout pourcentage en « environ X % ») ;
 *   5. achat d'un boost avec les crédits (Galaxy S21) puis « Sponsorisé » côté acheteur ; pages « Bientôt disponible » ; recherche sur d'autres sites (démonstration) avec les fausses sources ;
 *   6. sur chaque page visitée : aucun texte technique (identifiant, code d'erreur brut), aucun défilement horizontal à 390 px.
 * Captures dans NOMA_E2E_SHOTS (défaut /var/tmp/noma-d1-shots).
 *
 * Variables : NOMA_E2E_BASE_URL (relais, défaut http://localhost:3212), NOMA_E2E_SERVER_LOG, NOMA_E2E_DATABASE_URL (noma_e2e, pour demo:seed), NOMA_E2E_SHOTS, NOMA_E2E_CHROME.
 * Voir scripts/e2e-common.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { E2E_BASE, E2E_SERVER_LOG, awaitOtpLine, demoSeedByAdministration } from "./e2e-common";

const require = createRequire(import.meta.url);
const { chromium } = require("../poc/node_modules/playwright") as typeof import("../poc/node_modules/playwright");
type Page = import("../poc/node_modules/playwright").Page;

const BASE = E2E_BASE;
const SHOTS = process.env.NOMA_E2E_SHOTS ?? "/var/tmp/noma-d1-shots";
const CHROME = process.env.NOMA_E2E_CHROME ?? "/usr/bin/google-chrome-stable";
const VIEWPORT = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } as const;

if (!E2E_SERVER_LOG) {
  console.error("e2e:demo : NOMA_E2E_SERVER_LOG est requis.");
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

let checks = 0;
const ok = (label: string) => {
  checks += 1;
  console.log(`  ✓ ${label}`);
};
const step = (title: string) => console.log(`→ ${title}`);
const info = (label: string) => console.log(`    · ${label}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pageErrors: string[] = [];
const consoleErrors: string[] = [];
function watch(page: Page): void {
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of 40[134]/.test(message.text())) consoleErrors.push(message.text());
  });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Un code d'erreur brut ou un identifiant technique : jamais à l'écran. */
const TECHNICAL = /\b[a-z]+(?:_[a-z0-9]+){1,}\b|undefined|\bNaN\b|\[object |\bnull\b|TypeError|Error:/;

async function loginViaUi(page: Page, localPhone: string, next: string, destination: (url: URL) => boolean): Promise<void> {
  await page.goto(`${BASE}/connexion?next=${encodeURIComponent(next)}`);
  await page.getByPlaceholder("07 00 00 00 42").fill(localPhone);
  const offset = statSync(E2E_SERVER_LOG).size;
  await page.getByRole("button", { name: /Recevoir un code/ }).click();
  await page.waitForURL("**/verification");
  const { code } = await awaitOtpLine(offset);
  await page.getByLabel(/Code reçu par SMS/).fill(code);
  await page.getByRole("button", { name: "Vérifier", exact: true }).click();
  await page.waitForURL((url) => destination(url), { timeout: 60_000 });
}

/** Aucun texte technique, aucun défilement horizontal, rien qui déborde de l'écran de 390 px. */
async function checkClean(page: Page, label: string): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText);
  assert.equal(UUID.test(text), false, `${label} : un identifiant (UUID) est affiché`);
  const technical = TECHNICAL.exec(text);
  assert.equal(technical, null, `${label} : texte technique affiché (« ${technical?.[0]} »)`);
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${label} : défilement horizontal (${widths.scroll} > ${widths.inner})`);
  ok(`${label} : aucun texte technique ni identifiant, aucun défilement horizontal à 390 px`);
}

/** Le sélecteur d'espace ne recouvre aucun titre, lien ni bouton de la page. */
async function checkSwitcherDoesNotOverlap(page: Page, label: string): Promise<void> {
  const overlaps = await page.evaluate(() => {
    const bar = document.querySelector("[data-role-switcher]");
    if (!bar) return ["sélecteur absent"];
    const style = getComputedStyle(bar);
    const found: string[] = [];
    if (style.position === "fixed" || style.position === "absolute") found.push(`position ${style.position}`);
    const a = bar.getBoundingClientRect();
    for (const element of document.querySelectorAll("h1, h2, button, a, input, textarea")) {
      if (bar.contains(element)) continue;
      const b = element.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      const intersects = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      if (intersects) found.push(`${element.tagName} « ${(element.textContent ?? "").trim().slice(0, 30)} »`);
    }
    return found;
  });
  assert.deepEqual(overlaps, [], `${label} : le sélecteur d'espace recouvre un élément`);
  ok(`${label} : le sélecteur d'espace (Acheteur / Vendeur / Admin) ne recouvre aucun titre ni bouton`);
}

async function main(): Promise<void> {
  step("demo:seed sur la base noma_e2e, puis rejeu à l'identique");
  const first = await demoSeedByAdministration();
  assert.match(first, /demo:seed : base « noma_e2e » : (\d+) annonce\(s\) publiée\(s\)/);
  const created = Number(/: (\d+) annonce\(s\) publiée\(s\)/.exec(first)?.[1]);
  info(first.split("\n")[0]);
  const second = await demoSeedByAdministration();
  assert.match(second, /0 annonce\(s\) publiée\(s\) \(30 déjà présente\(s\)\), 0 besoin\(s\) activé\(s\) \(14 déjà présent\(s\)\), 0 compte\(s\) créé\(s\) \(21 déjà présent\(s\)\)/);
  assert.match(second, /0 ouverture\(s\) et 0 contact\(s\) fictifs écrits, crédits déjà présents, boost déjà actif/);
  ok(`premier passage : ${created} annonce(s) ; rejeu : 0 annonce, 0 besoin, 0 compte, 0 ouverture, 0 contact, crédits et boost déjà présents`);

  const browser = await chromium.launch({ executablePath: CHROME });
  const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  try {
    // ── visiteur sans compte ───────────────────────────────────────────────────────────────────────────
    const visitorContext = await browser.newContext({ ...VIEWPORT });
    const visitor = await visitorContext.newPage();
    visitor.setDefaultTimeout(60_000);
    watch(visitor);
    step("Visiteur sans compte : présentation de noma en 3 étapes et bouton « Se connecter »");
    await visitor.goto(`${BASE}/`);
    await visitor.getByRole("heading", { level: 1 }).waitFor();
    assert.equal(await visitor.locator("ol > li").count(), 3);
    await visitor.getByRole("link", { name: "Se connecter" }).waitFor();
    const visitorText = await visitor.evaluate(() => document.body.innerText);
    assert.equal(/iPhone 14|Produits phares|Marcory Mobile|Alex O\./.test(visitorText), false, "aucune donnée factice sur l'accueil");
    assert.equal(await visitor.locator('a[href^="/offre/"]').count(), 0, "aucune annonce publique listée");
    ok("trois étapes, bouton « Se connecter », aucune annonce publique, aucune donnée factice");
    await checkSwitcherDoesNotOverlap(visitor, "accueil visiteur");
    await checkClean(visitor, "accueil visiteur");
    await shot(visitor, "01-accueil-visiteur");
    await visitorContext.close();

    // ── acheteur démo ──────────────────────────────────────────────────────────────────────────────────
    const buyerContext = await browser.newContext({ ...VIEWPORT });
    const buyer = await buyerContext.newPage();
    buyer.setDefaultTimeout(60_000);
    watch(buyer);
    step("Acheteur démo : connexion (code lu dans la sortie du serveur) puis accueil « Explorer »");
    await loginViaUi(buyer, "07 00 00 01 01", "/", (url) => url.pathname === "/");
    await buyer.getByRole("heading", { name: "Vos besoins" }).waitFor();
    await buyer.locator("[data-buyer-demands] a").first().waitFor();
    const demandsText = await buyer.locator("[data-buyer-demands]").innerText();
    assert.equal(await buyer.locator('[data-buyer-demands] a[href^="/besoins/"]').count(), 3, "trois besoins actifs");
    assert.match(demandsText, /Je cherche un iPhone 12 en bon état à Abidjan/);
    assert.match(demandsText, /MacBook Air M1 pour mes études/);
    assert.match(demandsText, /Samsung Galaxy S21 pas trop cher/);
    assert.match(demandsText, /9 annonces correspondent/);
    assert.match(demandsText, /\d annonces correspondent/);
    await buyer.getByRole("link", { name: /Décrire un besoin/ }).waitFor();
    assert.match(await buyer.locator("[data-unread-summary]").innerText(), /3 notifications non lues/);
    assert.equal(await buyer.locator('a[href^="/offre/"]').count(), 0, "aucune annonce publique listée sur l'accueil");
    ok("3 besoins actifs avec leur nombre de correspondances, 3 notifications non lues, gros bouton « Décrire un besoin »");
    await checkSwitcherDoesNotOverlap(buyer, "accueil acheteur");
    await checkClean(buyer, "accueil acheteur");
    await shot(buyer, "02-accueil-acheteur");

    step("Acheteur démo : résultats du besoin iPhone 12, badge « Sponsorisé », fiche, contact");
    await buyer.locator("[data-buyer-demands] a", { hasText: "iPhone 12" }).first().click();
    await buyer.waitForURL(/\/besoins\/[0-9a-f-]{36}$/);
    await buyer.getByTestId("match-card").first().waitFor();
    assert.equal(await buyer.getByTestId("match-card").count(), 9, "neuf annonces pour ce besoin");
    const sponsored = buyer.getByTestId("match-card").filter({ hasText: "Sponsorisé" });
    assert.equal(await sponsored.count(), 1, "UNE annonce Sponsorisée (le boost du vendeur démo)");
    ok("9 correspondances, dont une « Sponsorisé » (l'annonce boostée du vendeur démo)");
    await checkClean(buyer, "résultats");
    await shot(buyer, "03-resultats-acheteur");
    await sponsored.getByTestId("match-detail-link").click();
    await buyer.waitForURL(/\/besoins\/[0-9a-f-]{36}\/offres\/[0-9a-f-]{36}$/);
    await buyer.getByRole("heading", { name: /Apple iPhone 12 128 Go/ }).waitFor();
    const ficheText = await buyer.evaluate(() => document.body.innerText);
    assert.match(ficheText, /165.000 FCFA/);
    assert.match(ficheText, /sponsorisé/i);
    assert.match(ficheText, /Stockage/);
    assert.equal(/0700000202|07 00 00 02 02|\+225/.test(ficheText.replace(/\s/g, " ")), false, "la fiche ne montre jamais le numéro du vendeur");
    assert.equal(await buyer.locator('a[href^="tel:"], a[href*="wa.me"]').count(), 0, "ni lien d'appel ni lien WhatsApp avant le contact");
    ok("fiche : titre, prix, attributs, « Sponsorisé », aucun numéro ni lien d'appel avant le contact");
    await checkClean(buyer, "fiche");
    await shot(buyer, "04-fiche-acheteur");
    await buyer.getByTestId("contact-button").click();
    await buyer.locator('a[href^="tel:"]').first().waitFor();
    const contactText = await buyer.evaluate(() => document.body.innerText);
    assert.match(contactText.replace(/\s/g, " "), /\+225 07 00 00 02 02/);
    assert.equal(await buyer.locator('a[href="tel:+2250700000202"]').count() >= 1, true);
    assert.equal(await buyer.locator('a[href="https://wa.me/2250700000202"]').count() >= 1, true);
    ok("« Contacter le vendeur » révèle le numéro vérifié du vendeur démo, avec « Appeler » et WhatsApp");
    await shot(buyer, "05-contact-acheteur");

    step("Acheteur démo : notifications");
    await buyer.goto(`${BASE}/notifications`);
    await buyer.getByTestId("notifications-heading").waitFor();
    assert.match(await buyer.getByTestId("notifications-heading").innerText(), /3 non lues/);
    const notifText = await buyer.evaluate(() => document.body.innerText);
    assert.match(notifText, /Apple iPhone 12 64 Go/);
    assert.match(notifText, /Samsung Galaxy S21 128 Go/);
    assert.match(notifText, /Apple MacBook Air M1/);
    ok("3 notifications non lues : iPhone 12 64 Go, Galaxy S21, MacBook Air M1 (annonces publiées après les besoins)");
    await checkClean(buyer, "notifications");
    await shot(buyer, "06-notifications-acheteur");

    // ── vendeur démo ───────────────────────────────────────────────────────────────────────────────────
    const vendorContext = await browser.newContext({ ...VIEWPORT });
    const vendor = await vendorContext.newPage();
    vendor.setDefaultTimeout(60_000);
    watch(vendor);
    step("Vendeur démo : connexion puis tableau de bord");
    await loginViaUi(vendor, "07 00 00 02 02", "/vendeur", (url) => url.pathname === "/vendeur");
    await vendor.getByRole("heading", { name: "Votre activité" }).waitFor();
    await vendor.locator("[data-vendor-offers] a").first().waitFor();
    assert.equal(await vendor.locator('[data-vendor-offers] a[href^="/vendeur/annonces/"]').count(), 4, "4 annonces");
    assert.match(await vendor.locator('[data-tile="En ligne"]').innerText(), /4/);
    const needsText = await vendor.locator("[data-vendor-needs]").innerText();
    assert.match(needsText, /environ 15 besoins d'acheteurs correspondent à vos annonces en ligne/);
    assert.match((await vendor.locator("[data-wallet-balance]").innerText()).replace(/\s/g, " "), /25 000 FCFA/);
    assert.match(await vendor.locator("[data-active-boosts]").innerText(), /iPhone 12 128 Go noir, parfait état[\s\S]*Boost actif jusqu'au/);
    const dashboardText = await vendor.locator("[data-vendor-offers]").innerText();
    assert.match(dashboardText, /environ 10 besoins correspondent/);
    assert.match(dashboardText, /moins de 5 besoins correspondent/);
    assert.equal(/(?<!environ )(?<!moins de )\b\d+ besoins/.test(dashboardText), false, "jamais un compte exact");
    ok("4 annonces en ligne, besoins correspondants arrondis (« environ 15 », « environ 10 », « moins de 5 »), solde 25 000 FCFA, boost actif");
    await checkSwitcherDoesNotOverlap(vendor, "tableau de bord vendeur");
    await checkClean(vendor, "tableau de bord vendeur");
    await shot(vendor, "07-tableau-de-bord-vendeur");

    step("Vendeur démo : page de l'annonce boostée, statistiques arrondies");
    await vendor.locator("[data-vendor-offers] a", { hasText: "iPhone 12 128 Go noir, parfait état" }).click();
    await vendor.waitForURL(/\/vendeur\/annonces\/[0-9a-f-]{36}$/);
    await vendor.getByRole("heading", { name: "Acheteurs intéressés" }).waitFor();
    await vendor.getByText("Ce que produit votre annonce").first().waitFor();
    await vendor.getByText(/environ 10/).first().waitFor({ timeout: 60_000 });
    const statsText = await vendor.evaluate(() => document.body.innerText);
    assert.match(statsText, /environ 10/);
    assert.match(statsText, /environ 5/);
    // Section des statistiques seulement (la compatibilité d'un acheteur intéressé n'est pas une statistique : « Compatibilité 100 % »).
    const statsSection = statsText.split("Ce que produit votre annonce")[1]?.split("Booster cette annonce")[0] ?? "";
    assert.ok(statsSection.length > 100, "section des statistiques lue");
    const barePercent = [...statsSection.matchAll(/(.{0,12})\b\d+ ?%/g)].filter((match) => !/environ\s*$/.test(match[1]));
    assert.deepEqual(barePercent.map((match) => match[0]), [], "tout pourcentage de statistique s'écrit « environ X % »");
    assert.equal(/\b(11|12|6|7) (acheteurs|ouvertures|contacts)\b/.test(statsText), false, "jamais un compte exact");
    ok("statistiques : « environ 10 » acheteurs, « environ 5 » contacts, aucun pourcentage sans « environ », aucun compte exact");
    await checkClean(vendor, "statistiques de l'annonce");
    await shot(vendor, "08-statistiques-vendeur");

    step("Vendeur démo : achat d'un boost avec les crédits (Galaxy S21), puis « Sponsorisé » côté acheteur");
    await vendor.goto(`${BASE}/vendeur`);
    await vendor.locator("[data-vendor-offers] a", { hasText: "Galaxy S21" }).first().click();
    await vendor.waitForURL(/\/vendeur\/annonces\/[0-9a-f-]{36}$/);
    await vendor.getByRole("heading", { name: "Booster cette annonce" }).waitFor();
    await vendor.getByRole("button", { name: /^24 h$/ }).click();
    await vendor.getByTestId("boost-amount").waitFor({ timeout: 60_000 });
    await vendor.getByTestId("boost-buy").waitFor();
    assert.equal(await vendor.getByTestId("boost-buy").isEnabled(), true, "« Acheter » actif : le solde de 25 000 FCFA couvre le prix");
    assert.match(await vendor.getByTestId("boost-quote").innerText(), /Mise en avant visible auprès de/);
    await shot(vendor, "09-boost-devis-vendeur");
    await vendor.getByTestId("boost-buy").click();
    await vendor.getByTestId("boost-confirm-button").click();
    await vendor.getByTestId("boost-success").waitFor({ timeout: 60_000 });
    ok("devis du boost du Galaxy S21 disponible (effet visible démontré), achat avec les crédits, « Boost actif »");
    await shot(vendor, "10-boost-achete-vendeur");
    await buyer.goto(`${BASE}/`);
    await buyer.locator("[data-buyer-demands] a", { hasText: "Galaxy S21" }).first().click();
    await buyer.waitForURL(/\/besoins\/[0-9a-f-]{36}$/);
    await buyer.getByTestId("match-card").first().waitFor();
    assert.equal(await buyer.getByTestId("match-card").count(), 8, "huit annonces Galaxy S21");
    assert.equal(await buyer.getByTestId("match-card").filter({ hasText: "Sponsorisé" }).count(), 1, "l'annonce boostée remonte « Sponsorisé »");
    ok("côté acheteur : 8 annonces Galaxy S21 dont une « Sponsorisé »");

    step("Pages « Bientôt disponible » (acheteur, vendeur, admin)");
    for (const [path, page, label] of [
      ["/favoris", buyer, "favoris"], ["/messages", buyer, "messages"], ["/comparer", buyer, "comparer"], ["/commandes", buyer, "commandes"],
      ["/vendeur/demandes", vendor, "demandes vendeur"], ["/vendeur/devis/nouveau", vendor, "devis"], ["/admin", vendor, "admin"], ["/admin/dossiers", vendor, "dossiers"],
    ] as const) {
      await page.goto(`${BASE}${path}`);
      await page.getByText("Bientôt disponible").first().waitFor();
      await page.getByRole("link", { name: /Retour/ }).first().waitFor();
      assert.equal(/Alex O\.|Marcory Mobile|iPhone 14|NM-0|D-10/.test(await page.evaluate(() => document.body.innerText)), false, `${label} : aucune donnée factice`);
      await checkClean(page, `« Bientôt disponible » (${label})`);
    }
    await shot(buyer, "12-bientot-disponible");

    step("Recherche sur d'autres sites (démonstration) : fausses sources, mention visible");
    await buyer.goto(`${BASE}/`);
    await buyer.getByRole("button", { name: "Recherche sur d'autres sites (démonstration)" }).first().click();
    await buyer.getByPlaceholder("Un iPhone 12 en bon état, à Abidjan…").fill("iPhone 12 en bon état à Abidjan, 200 000 FCFA");
    await buyer.getByRole("button", { name: "Trouver des offres" }).click();
    await buyer.waitForURL("**/recherche");
    await buyer.getByText("Recherche sur d'autres sites (démonstration)").first().waitFor();
    await buyer.getByText("Annonce externe").first().waitFor({ timeout: 90_000 });
    assert.equal(await buyer.getByText("Sélectionner pour comparer").count(), 0);
    assert.equal(await buyer.locator('a[href^="/offre/"]').count(), 0, "aucun lien vers une fiche factice");
    ok("la recherche fonctionne avec les fausses sources, porte la mention « Recherche sur d'autres sites (démonstration) », sans comparaison ni fiche factice");
    await buyer.getByRole("button", { name: "Arrêter" }).click({ timeout: 2_000 }).catch(() => undefined);
    await shot(buyer, "11-recherche-demonstration");

    assert.deepEqual(pageErrors, [], "aucune exception de page");
    assert.deepEqual(consoleErrors, [], "aucune erreur de console");
    ok("aucune exception de page ni erreur de console pendant tout le parcours");
    await sleep(100);
    await buyerContext.close();
    await vendorContext.close();
  } finally {
    await browser.close();
  }
  console.log(`\ne2e:demo : ${checks} vérifications réussies. Captures dans ${SHOTS}.`);
}

main().catch((error: unknown) => {
  console.error(`e2e:demo : ÉCHEC — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
