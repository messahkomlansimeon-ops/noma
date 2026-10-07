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
 *   6. sur chaque page visitée : aucun texte technique (identifiant, code d'erreur brut), aucun défilement horizontal à 390 px ;
 *   7. LOT D2, dans trois navigateurs (acheteur, vendeur, admin) : favori ajouté puis retiré ; messagerie EN DIRECT (le message de l'acheteur apparaît chez le vendeur SANS recharger,
 *      en moins de 3 s, et inversement ; du HTML dans un message reste du texte ; un numéro n'est pas bloqué ; rappel de sécurité la première fois) ; commande déclarée par l'acheteur,
 *      confirmée par le vendeur (ventes confirmées arrondies, besoin proposé satisfait) ; administration : tableau de bord, vendeurs aux numéros masqués, suspension et réactivation
 *      journalisées, réglages en lecture seule ; /admin : page 404 standard de Next pour l'acheteur (sans titre « Administration »), onglet Admin du sélecteur visible seulement pour l'admin.
 *   8. LOT D3 : le visiteur anonyme ne provoque aucun 401 ni aucune erreur dans la console du navigateur ; l'onglet Admin n'existe pas pour l'acheteur et le vendeur.
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
  assert.match(first, /3 message\(s\) écrit\(s\), favori ajouté, commande de démonstration proposée au vendeur démo, rôle admin attribué au compte Admin démo/);
  const created = Number(/: (\d+) annonce\(s\) publiée\(s\)/.exec(first)?.[1]);
  info(first.split("\n")[0]);
  const second = await demoSeedByAdministration();
  assert.match(second, /0 annonce\(s\) publiée\(s\) \(30 déjà présente\(s\)\), 0 besoin\(s\) activé\(s\) \(14 déjà présent\(s\)\), 0 compte\(s\) créé\(s\) \(21 déjà présent\(s\)\)/);
  assert.match(second, /0 ouverture\(s\) et 0 contact\(s\) fictifs écrits, crédits déjà présents, boost déjà actif/);
  assert.match(second, /0 message\(s\) écrit\(s\), favori déjà présent, commande de démonstration déjà active, rôle admin déjà attribué/);
  ok(`premier passage : ${created} annonce(s) ; rejeu : 0 annonce, 0 besoin, 0 compte, 0 ouverture, 0 contact, crédits et boost déjà présents`);

  const browser = await chromium.launch({ executablePath: CHROME });
  const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  try {
    // ── visiteur sans compte ───────────────────────────────────────────────────────────────────────────
    const visitorContext = await browser.newContext({ ...VIEWPORT });
    const visitor = await visitorContext.newPage();
    visitor.setDefaultTimeout(60_000);
    watch(visitor);
    // Lot D3 : NON filtré (contrairement à `watch`) : aucune erreur de console ni aucune réponse 401/403 pour le visiteur anonyme.
    const visitorConsole: string[] = [];
    const visitorDenied: string[] = [];
    visitor.on("console", (message) => {
      if (message.type() === "error") visitorConsole.push(message.text());
    });
    visitor.on("response", (response) => {
      if (response.status() === 401 || response.status() === 403) visitorDenied.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    step("Visiteur sans compte : présentation de noma en 3 étapes et bouton « Se connecter »");
    await visitor.goto(`${BASE}/`);
    await visitor.getByRole("heading", { level: 1 }).waitFor();
    assert.equal(await visitor.locator("ol > li").count(), 3);
    await visitor.getByRole("link", { name: "Se connecter" }).waitFor();
    const visitorText = await visitor.evaluate(() => document.body.innerText);
    assert.equal(/iPhone 14|Produits phares|Marcory Mobile|Alex O\./.test(visitorText), false, "aucune donnée factice sur l'accueil");
    assert.equal(await visitor.locator('a[href^="/offre/"]').count(), 0, "aucune annonce publique listée");
    ok("trois étapes, bouton « Se connecter », aucune annonce publique, aucune donnée factice");
    await sleep(1_500);
    assert.deepEqual(visitorDenied, [], "aucune réponse 401 ni 403 pour le visiteur anonyme");
    assert.deepEqual(visitorConsole, [], "aucune erreur dans la console du navigateur pour le visiteur anonyme");
    assert.equal(await visitor.locator('[data-role-switcher] a[href="/admin"]').count(), 0, "le visiteur ne voit pas l'onglet Admin");
    ok("visiteur anonyme : aucune réponse 401, aucune erreur de console (la lecture de session répond 200 { authenticated: false }), aucun onglet Admin");
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
    assert.equal(await buyer.locator('[data-role-switcher] a[href="/admin"]').count(), 0, "lot D3 : l'acheteur ne voit pas l'onglet Admin");
    assert.equal(await buyer.locator('[data-role-switcher] a[href="/vendeur"]').count(), 1);
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
    assert.equal(await vendor.locator('[data-role-switcher] a[href="/admin"]').count(), 0, "lot D3 : le vendeur ne voit pas l'onglet Admin");
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

    step("Pages « Bientôt disponible » restantes (lot D2 : favoris, messages, commandes et administration sont branchés)");
    for (const [path, page, label] of [
      ["/comparer", buyer, "comparer"], ["/vendeur/demandes", vendor, "demandes vendeur"], ["/vendeur/devis/nouveau", vendor, "devis"],
      // Lot D3 : « /admin/dossiers » est dans l'espace d'administration : un compte ordinaire y obtient la page 404 standard ; « Bientôt disponible » est vérifié plus bas avec l'admin démo.
    ] as const) {
      await page.goto(`${BASE}${path}`);
      await page.getByText("Bientôt disponible").first().waitFor();
      await page.getByRole("link", { name: /Retour/ }).first().waitFor();
      assert.equal(/Alex O\.|Marcory Mobile|iPhone 14|NM-0|D-10/.test(await page.evaluate(() => document.body.innerText)), false, `${label} : aucune donnée factice`);
      await checkClean(page, `« Bientôt disponible » (${label})`);
    }
    await shot(buyer, "12-bientot-disponible");

    // ── LOT D2 : favoris, messagerie en direct, commande, administration ───────────────────────────────
    step("D2 · Favoris : le cœur de la fiche, la page /favoris, retrait");
    await buyer.goto(`${BASE}/`);
    await buyer.locator("[data-buyer-demands] a", { hasText: "iPhone 12" }).first().click();
    await buyer.waitForURL(/\/besoins\/[0-9a-f-]{36}$/);
    await buyer.getByTestId("match-card").first().waitFor();
    await buyer.getByTestId("match-card").filter({ hasText: "Sponsorisé" }).getByTestId("match-detail-link").click();
    await buyer.waitForURL(/\/besoins\/[0-9a-f-]{36}\/offres\/[0-9a-f-]{36}$/);
    const ficheUrl = buyer.url();
    const heart = buyer.getByTestId("favorite-button");
    await heart.waitFor();
    await buyer.waitForFunction(() => document.querySelector('[data-testid="favorite-button"]')?.hasAttribute("disabled") === false);
    assert.equal(await heart.getAttribute("data-favorite"), "false");
    await heart.click();
    await buyer.waitForFunction(() => document.querySelector('[data-testid="favorite-button"]')?.getAttribute("data-favorite") === "true");
    await shot(buyer, "13-favori-fiche");
    await buyer.goto(`${BASE}/favoris`);
    await buyer.getByTestId("favorite-row").first().waitFor();
    assert.equal(await buyer.getByTestId("favorite-row").count(), 2, "le favori de la démonstration et celui qu'on vient d'ajouter");
    const addedRow = buyer.getByTestId("favorite-row").filter({ hasText: "165 000" });
    assert.equal(await addedRow.count(), 1, "l'annonce du vendeur démo : titre, prix");
    assert.match(await addedRow.innerText(), /Apple iPhone 12 128 Go[\s\S]*En ligne/);
    assert.equal(await addedRow.getByRole("link", { name: /Voir l'annonce/ }).getAttribute("href"), new URL(ficheUrl).pathname, "lien vers la fiche par le besoin d'origine");
    await checkClean(buyer, "favoris");
    await shot(buyer, "14-favoris");
    await addedRow.getByTestId("favorite-remove").click();
    await buyer.waitForFunction(() => document.querySelectorAll('[data-testid="favorite-row"]').length === 1);
    ok("favori ajouté depuis la fiche (cœur), listé avec titre, prix et statut, lien vers la fiche, puis retiré ; le favori de la démonstration reste");
    await buyer.goto(ficheUrl);
    await buyer.waitForFunction(() => document.querySelector('[data-testid="favorite-button"]')?.hasAttribute("disabled") === false);
    assert.equal(await buyer.getByTestId("favorite-button").getAttribute("data-favorite"), "false", "retiré : le cœur est vide");

    step("D2 · Messagerie EN DIRECT : acheteur et vendeur dans deux navigateurs, sans recharger");
    await buyer.getByTestId("write-to-seller").click();
    await buyer.waitForURL(/\/messages\/[0-9a-f-]{36}$/);
    await buyer.getByTestId("conversation-title").waitFor();
    assert.match(await buyer.getByTestId("conversation-title").innerText(), /^Vendeur de l'annonce Apple iPhone 12 128 Go$/, "l'autre partie est désignée SANS identité");
    await buyer.waitForFunction(() => document.querySelector('[data-testid="live-status"]')?.getAttribute("data-status") === "live", undefined, { timeout: 30_000 });
    assert.match(await buyer.getByTestId("safety-reminder").innerText(), /Pour votre sécurité, ne payez jamais avant d'avoir vu l'objet\./, "rappel de sécurité la première fois");
    const buyerConversationUrl = buyer.url();
    await shot(buyer, "15-conversation-vide-acheteur");
    // Le vendeur n'a rien à répondre tant que l'acheteur n'a rien écrit.
    await vendor.goto(`${BASE}/vendeur/messages`);
    await vendor.getByTestId("messages-empty").waitFor();
    const FIRST = "Bonjour, l'iPhone est-il toujours disponible ?";
    await buyer.getByTestId("message-input").fill(FIRST);
    await buyer.getByTestId("message-send").click();
    await buyer.getByTestId("message-bubble").filter({ hasText: FIRST }).waitFor();
    await buyer.getByTestId("safety-reminder").waitFor({ state: "detached" });
    // Le vendeur ouvre sa liste : la conversation est là, non lue, l'acheteur sans identité, pastille sur l'onglet Messages.
    await vendor.goto(`${BASE}/vendeur/messages`);
    const sellerRow = vendor.getByTestId("conversation-row").first();
    await sellerRow.waitFor();
    assert.equal(await sellerRow.getAttribute("data-unread"), "true", "non lue : en gras");
    const rowText = await sellerRow.innerText();
    assert.match(rowText, /Acheteur intéressé/);
    assert.match(rowText, /Annonce : Apple iPhone 12 128 Go/);
    assert.ok(rowText.includes(FIRST));
    assert.equal(/Alex|0700000101|07 00 00 01 01/.test(rowText), false, "aucune identité de l'acheteur");
    await vendor.getByTestId("messages-badge").first().waitFor();
    assert.equal((await vendor.getByTestId("messages-badge").first().innerText()).trim(), "1", "pastille : une conversation non lue");
    await checkClean(vendor, "messages vendeur");
    await shot(vendor, "16-messages-vendeur");
    await sellerRow.click();
    await vendor.waitForURL(/\/vendeur\/messages\/[0-9a-f-]{36}$/);
    await vendor.getByTestId("message-bubble").filter({ hasText: FIRST }).waitFor();
    assert.match(await vendor.getByTestId("conversation-title").innerText(), /^Acheteur intéressé$/);
    await vendor.waitForFunction(() => document.querySelector('[data-testid="live-status"]')?.getAttribute("data-status") === "live", undefined, { timeout: 30_000 });
    await vendor.evaluate(() => { (window as unknown as { __noReload: string }).__noReload = "ok"; });
    await buyer.evaluate(() => { (window as unknown as { __noReload: string }).__noReload = "ok"; });

    // Acheteur → vendeur, SANS recharger, en moins de 3 s.
    const SECOND = "Je peux passer demain à Cocody ?";
    let started = Date.now();
    await buyer.getByTestId("message-input").fill(SECOND);
    await buyer.getByTestId("message-send").click();
    await vendor.getByTestId("message-bubble").filter({ hasText: SECOND }).waitFor({ timeout: 3_000 });
    const toVendor = Date.now() - started;
    assert.ok(toVendor < 3_000, `acheteur → vendeur en ${toVendor} ms`);
    assert.equal(await vendor.evaluate(() => (window as unknown as { __noReload?: string }).__noReload), "ok", "la page du vendeur n'a pas été rechargée");
    ok(`le message de l'acheteur apparaît chez le vendeur SANS recharger la page, en ${toVendor} ms (< 3 s)`);
    // Vendeur → acheteur.
    const REPLY = "Oui, demain après 17 h, je vous attends.";
    started = Date.now();
    await vendor.getByTestId("message-input").fill(REPLY);
    await vendor.getByTestId("message-send").click();
    await buyer.getByTestId("message-bubble").filter({ hasText: REPLY }).waitFor({ timeout: 3_000 });
    const toBuyer = Date.now() - started;
    assert.ok(toBuyer < 3_000, `vendeur → acheteur en ${toBuyer} ms`);
    assert.equal(await buyer.evaluate(() => (window as unknown as { __noReload?: string }).__noReload), "ok", "la page de l'acheteur n'a pas été rechargée");
    assert.equal(await buyer.getByTestId("message-bubble").filter({ hasText: REPLY }).getAttribute("data-mine"), "false");
    assert.equal(await vendor.getByTestId("message-bubble").filter({ hasText: REPLY }).getAttribute("data-mine"), "true");
    ok(`la réponse du vendeur apparaît chez l'acheteur SANS recharger la page, en ${toBuyer} ms (< 3 s) ; chacun voit « mes » messages de son côté`);
    assert.equal(await buyer.getByTestId("message-bubble").filter({ hasText: SECOND }).count(), 1, "aucun doublon (écho de l'envoi puis flux)");

    // Du HTML reste du texte ; un numéro de téléphone n'est pas bloqué.
    const HTML_TEXT = `<b>gras</b> <img src=x onerror="window.__xss=1">`;
    await buyer.getByTestId("message-input").fill(HTML_TEXT);
    await buyer.getByTestId("message-send").click();
    await vendor.getByTestId("message-bubble").filter({ hasText: "<b>gras</b>" }).waitFor({ timeout: 3_000 });
    assert.equal(await vendor.locator('[data-testid="message-bubble"] b, [data-testid="message-bubble"] img').count(), 0, "aucune balise créée à partir du texte");
    assert.equal(await vendor.evaluate(() => (window as unknown as { __xss?: number }).__xss), undefined, "rien n'est exécuté");
    assert.ok((await vendor.getByTestId("message-bubble").filter({ hasText: "<b>gras</b>" }).innerText()).includes(HTML_TEXT), "le texte est affiché tel quel");
    const PHONE_TEXT = "Appelez-moi au 07 08 09 10 11 pour confirmer.";
    await vendor.getByTestId("message-input").fill(PHONE_TEXT);
    await vendor.getByTestId("message-send").click();
    await buyer.getByTestId("message-bubble").filter({ hasText: "07 08 09 10 11" }).waitFor({ timeout: 3_000 });
    ok("un message qui ressemble à du HTML s'affiche comme du texte (aucune balise, rien d'exécuté) ; un numéro de téléphone passe (contact direct voulu)");
    await checkClean(buyer, "conversation acheteur");
    await shot(buyer, "17-conversation-acheteur");
    await shot(vendor, "18-conversation-vendeur");
    await buyer.goto(`${BASE}/messages`);
    const buyerRow = buyer.getByTestId("conversation-row").first();
    await buyerRow.waitFor();
    assert.match(await buyerRow.innerText(), /Vendeur de l'annonce Apple iPhone 12 128 Go/);
    assert.equal(await buyer.getByTestId("conversation-row").count(), 2, "la conversation de la démonstration (vendeur fictif) et la nouvelle");
    await checkClean(buyer, "messages acheteur");
    await shot(buyer, "19-messages-acheteur");

    step("D2 · Commande : l'acheteur déclare « Je l'ai acheté », le vendeur confirme");
    await buyer.goto(buyerConversationUrl);
    await buyer.getByTestId("declare-order-open").click();
    assert.match(await buyer.getByTestId("no-payment-notice").innerText(), /noma ne gère aucun paiement de l'objet/);
    await buyer.getByTestId("order-price").fill("0");
    assert.equal(await buyer.getByTestId("declare-order-submit").isDisabled(), true, "prix 0 : refusé avant l'envoi");
    await buyer.getByTestId("order-price").fill("158 000");
    await buyer.getByTestId("declare-order-submit").click();
    await buyer.waitForURL(/\/commandes\/[0-9a-f-]{36}$/);
    await buyer.getByTestId("order-detail").waitFor();
    assert.match(await buyer.getByTestId("order-status").innerText(), /En attente du vendeur/);
    assert.match((await buyer.getByTestId("order-price").innerText()).replace(/\s/g, " "), /158 000 FCFA/);
    assert.equal(await buyer.getByTestId("order-confirm").count(), 0, "l'acheteur ne confirme pas sa propre commande");
    assert.equal(await buyer.getByTestId("order-cancel").count(), 1, "il peut annuler tant que ce n'est pas confirmé");
    assert.match(await buyer.getByTestId("no-payment-notice").innerText(), /noma ne gère aucun paiement de l'objet/);
    await checkClean(buyer, "commande acheteur");
    await shot(buyer, "20-commande-acheteur");
    await vendor.goto(`${BASE}/vendeur/commandes`);
    await vendor.getByTestId("order-row").first().waitFor();
    assert.equal(await vendor.getByTestId("order-row").count(), 2, "la commande de la démonstration (acheteur fictif) et celle de l'acheteur démo");
    assert.equal(await vendor.locator('[data-testid="order-row"][data-needs-action="true"]').count(), 2, "deux commandes à confirmer");
    const myOrder = vendor.getByTestId("order-row").filter({ hasText: "158 000" });
    assert.match(await myOrder.innerText(), /Acheteur intéressé/);
    await checkClean(vendor, "commandes vendeur");
    await shot(vendor, "21-commandes-vendeur");
    await myOrder.click();
    await vendor.waitForURL(/\/vendeur\/commandes\/[0-9a-f-]{36}$/);
    await vendor.getByTestId("order-detail").waitFor();
    assert.equal(await vendor.getByTestId("order-cancel").count(), 0, "le vendeur n'annule pas : il confirme ou refuse");
    await vendor.getByTestId("order-confirm").click();
    await vendor.getByTestId("order-notice").waitFor();
    assert.match(await vendor.getByTestId("order-status").innerText(), /Confirmée/);
    await shot(vendor, "22-commande-confirmee-vendeur");
    ok("commande déclarée (158 000 FCFA, « aucun paiement ne passe par noma »), proposée au vendeur, confirmée par le vendeur");
    // Statistiques du vendeur : ventes confirmées arrondies.
    await vendor.goto(`${BASE}/vendeur`);
    await vendor.locator("[data-vendor-offers] a", { hasText: "iPhone 12 128 Go noir, parfait état" }).click();
    await vendor.getByTestId("offer-sales").waitFor();
    await vendor.getByText("Ventes confirmées").first().waitFor();
    const salesText = await vendor.getByTestId("offer-sales").innerText();
    assert.match(salesText, /Ventes déclarées et confirmées/);
    assert.match(salesText, /Ventes confirmées\s*moins de 5/, "une vente confirmée : « moins de 5 », jamais le compte exact");
    ok("statistiques du vendeur : « Ventes déclarées et confirmées : moins de 5 » (arrondi comme les autres mesures)");
    await shot(vendor, "23-ventes-vendeur");

    step("D2 · Administration : tableau de bord, vendeurs masqués, suspension et réactivation, réglages ; refus à l'acheteur");
    const adminContext = await browser.newContext({ ...VIEWPORT });
    const adminPage = await adminContext.newPage();
    adminPage.setDefaultTimeout(60_000);
    watch(adminPage);
    await loginViaUi(adminPage, "07 00 00 03 03", "/admin", (url) => url.pathname === "/admin");
    await adminPage.getByTestId("admin-dashboard").waitFor();
    await adminPage.locator('[data-role-switcher] a[href="/admin"]').waitFor();
    assert.equal(((await adminPage.locator('[data-role-switcher] a[href="/admin"]').textContent()) ?? "").trim(), "Admin");
    ok("l'onglet Admin du sélecteur d'espace est visible pour l'administrateur");
    const tile = async (key: string): Promise<string> => (await adminPage.locator(`[data-tile="${key}"] [data-tile-value]`).innerText()).replace(/\s/g, " ");
    assert.equal(await tile("accounts"), "21", "21 comptes : 3 de démonstration, 7 vendeurs et 11 acheteurs fictifs");
    assert.equal(await tile("offers"), "30");
    assert.equal(await tile("boosts"), "2", "deux boosts actifs (celui de la démonstration et l'achat du Galaxy S21)");
    assert.ok(Number(await tile("matches")) > 30, "correspondances confirmées");
    assert.equal(await tile("conversations"), "2");
    assert.equal(await tile("orders"), "1", "une vente confirmée");
    assert.match(await tile("credits"), /\d+ FCFA/);
    assert.match(await adminPage.getByTestId("admin-worker").innerText(), /Calcul des correspondances/);
    await checkSwitcherDoesNotOverlap(adminPage, "tableau de bord admin");
    await checkClean(adminPage, "tableau de bord admin");
    await shot(adminPage, "24-admin-tableau-de-bord");
    await adminPage.goto(`${BASE}/admin/vendeurs`);
    await adminPage.getByTestId("vendor-row").first().waitFor();
    assert.equal(await adminPage.getByTestId("vendor-row").count(), 8, "le vendeur démo et les 7 vendeurs fictifs");
    const phones = await adminPage.getByTestId("vendor-phone").allInnerTexts();
    for (const phone of phones) assert.match(phone, /^\+•+\d\d$/, `numéro masqué : ${phone}`);
    const vendorsText = (await adminPage.evaluate(() => document.body.innerText)).replace(/\s/g, "");
    assert.equal(/0700000202|0788888807|2250700000202/.test(vendorsText), false, "aucun numéro complet dans /admin/vendeurs");
    await shot(adminPage, "25-admin-vendeurs");
    const target = adminPage.locator('[data-testid="vendor-row"]').filter({ has: adminPage.locator('[data-testid="vendor-phone"]', { hasText: /07$/ }) }).first();
    await target.getByTestId("vendor-suspend").click();
    assert.match(await adminPage.getByTestId("admin-confirm").innerText(), /Suspendre le vendeur \+•+07 \?/, "confirmation à l'écran");
    await shot(adminPage, "26-admin-confirmation");
    await adminPage.getByTestId("admin-confirm-yes").click();
    await adminPage.getByTestId("admin-notice").filter({ hasText: "Vendeur suspendu." }).waitFor();
    await adminPage.locator('[data-testid="vendor-row"][data-status="suspended"]').first().waitFor();
    assert.match(await adminPage.getByTestId("admin-journal").innerText(), /Suspension · \+•+07 · par \+•+03/);
    await adminPage.locator('[data-testid="vendor-row"][data-status="suspended"]').first().getByTestId("vendor-reactivate").click();
    await adminPage.getByTestId("admin-confirm-yes").click();
    await adminPage.getByTestId("admin-notice").filter({ hasText: "Vendeur réactivé." }).waitFor();
    await adminPage.waitForFunction(() => document.querySelectorAll('[data-testid="vendor-row"][data-status="suspended"]').length === 0);
    const journal = await adminPage.getByTestId("admin-journal").innerText();
    assert.match(journal, /Réactivation/);
    assert.match(journal, /Rôle administrateur attribué · .* par commande admin:grant/);
    await checkClean(adminPage, "vendeurs admin");
    await shot(adminPage, "27-admin-journal");
    ok("8 vendeurs aux numéros masqués ; suspension avec confirmation puis réactivation, au journal d'administration (qui, quoi, quand)");
    await adminPage.goto(`${BASE}/admin/reglages`);
    await adminPage.getByTestId("admin-settings").waitFor();
    const settingsText = await adminPage.getByTestId("admin-settings").innerText();
    assert.match(settingsText, /Par défaut \(toutes catégories\)/);
    assert.match(settingsText, /15 %/);
    assert.match(settingsText, /Lecture seule/);
    assert.equal(await adminPage.getByTestId("admin-settings").locator("input, button, textarea").count(), 0, "lecture seule : aucun champ ni bouton");
    await shot(adminPage, "28-admin-reglages");
    await adminPage.goto(`${BASE}/admin/dossiers`);
    await adminPage.getByText("Bientôt disponible").first().waitFor();
    ok("réglages du boost en lecture seule ; « Dossiers » reste « Bientôt disponible »");
    // L'acheteur n'est pas administrateur : page 404 STANDARD de Next (notFound()), statut 404, sans titre « Administration » ni sélecteur d'espace (lot D3).
    const refusal = await buyer.goto(`${BASE}/admin`);
    assert.equal(refusal?.status(), 404, "statut HTTP 404 pour un compte ordinaire");
    await buyer.getByText("This page could not be found.").waitFor();
    const refusedTitle = await buyer.title();
    assert.equal(refusedTitle, "noma · Votre recherche, simplifiée", `titre de l'onglet : celui de l'application, pas « ${refusedTitle} »`);
    const refusedText = await buyer.evaluate(() => document.body.innerText);
    assert.equal(/Administration|Tableau de bord|Vendeurs et journal|Page introuvable/.test(refusedText), false, `aucun titre ni texte de l'administration : « ${refusedText.replace(/\s+/g, " ").slice(0, 120)} »`);
    assert.equal(await buyer.getByTestId("admin-dashboard").count(), 0);
    assert.equal(await buyer.locator("[data-role-switcher]").count(), 0, "la page 404 standard n'a ni sélecteur d'espace ni barre d'onglets de l'administration");
    info(`texte de la page 404 : « ${refusedText.replace(/\s+/g, " ").trim()} »`);
    const apiStatuses = await buyer.evaluate(async () => {
      const results: number[] = [];
      for (const path of ["/api/admin/summary", "/api/admin/vendors", "/api/admin/actions", "/api/admin/settings"]) results.push((await fetch(path)).status);
      return results;
    });
    assert.deepEqual(apiStatuses, [404, 404, 404, 404], "les routes d'administration répondent 404 à un compte ordinaire");
    const subPage = await buyer.goto(`${BASE}/admin/vendeurs`);
    assert.equal(subPage?.status(), 404);
    await buyer.getByText("This page could not be found.").waitFor();
    // Une page qui n'existe pas donne la MÊME page : l'existence de l'espace ne se devine pas.
    const unknown = await buyer.goto(`${BASE}/cette-page-n-existe-pas`);
    assert.equal(unknown?.status(), 404);
    assert.equal(await buyer.title(), refusedTitle, "même titre d'onglet qu'une adresse inconnue");
    assert.equal((await buyer.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").trim(), refusedText.replace(/\s+/g, " ").trim(), "même page qu'une adresse inconnue");
    ok("/admin chargé par l'admin démo ; pour l'acheteur : page 404 (statut 404, texte standard de Next, sans titre « Administration »), identique à une adresse inconnue, titre d'onglet compris, et 404 sur chaque route /api/admin/*");
    await shot(buyer, "29-admin-refuse-acheteur");

    step("D2 · Besoin marqué satisfait après la vente confirmée (proposé à l'acheteur, jamais automatique)");
    await buyer.goto(`${BASE}/`);
    await buyer.locator("[data-buyer-demands] a", { hasText: "iPhone 12" }).first().waitFor();
    await buyer.goto(buyerConversationUrl);
    await buyer.getByTestId("conversation-order").click();
    await buyer.waitForURL(/\/commandes\/[0-9a-f-]{36}$/);
    assert.match(await buyer.getByTestId("order-status").innerText(), /Confirmée/);
    await buyer.getByTestId("order-satisfy").waitFor();
    await buyer.getByTestId("order-satisfy-button").click();
    await buyer.getByTestId("order-notice").filter({ hasText: "Votre besoin est marqué comme satisfait." }).waitFor();
    assert.equal(await buyer.getByTestId("order-satisfy").count(), 0);
    ok("après la confirmation, l'acheteur peut marquer son besoin comme satisfait (jamais automatiquement)");
    await adminContext.close();

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
