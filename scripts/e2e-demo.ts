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
 *   9. LOT MV1 : missions d'achat en volume (voir le pas « MV1 » plus bas : mission de démonstration, création avec refus d'un numéro, proposition anonyme, « Écrire » pré-rempli, déclaration,
 *      confirmation côté vendeur, progression, pause et reprise).
 *   8. LOT D3 : le visiteur anonyme ne provoque aucun 401 ni aucune erreur dans la console du navigateur ; l'onglet Admin n'existe pas pour l'acheteur et le vendeur.
 *   9. LOT PRO1 (à la fin, dans quatre navigateurs : vendeur démo, second vendeur, acheteur, admin) : le vendeur démo est Pro (badge « Vendeur Pro » dans les résultats, texte honnête sur la fiche,
 *      page « Offre Pro » aux prix PROVISOIRES, crédits promotionnels, achat d'un boost payé avec les crédits promotionnels EN PREMIER) ; import de catalogue par CSV (aperçu, application, rejeu, numéro
 *      de téléphone refusé) ; un second vendeur, sans le droit, est refusé à l'import, recharge son porte-monnaie par le paiement simulé puis souscrit à l'offre Pro (double clic : un seul débit),
 *      reçoit ses crédits promotionnels et le badge ; administration /admin/offres (abonnés arrondis, revenus du mois, nouvelle version), refusée à l'acheteur (page 404 standard) ; wallet:check sans écart.
 *  11. LOT RA1 (recherche active payante, prix PROVISOIRE, argent simulé) : la carte « Recherche active » de la page d'un besoin (règles dites AVANT l'achat), achat avec confirmation et double clic (UN seul débit
 *      de 2 000 FCFA, crédits payés), suivi prolongeable jusqu'à 180 jours, `active-search:simulate` (annonce fictive d'un autre site) → notification « Autre site » dans /notifications et sur l'accueil (lien vers le
 *      besoin, jamais vers le site), besoin satisfait = option suspendue puis reprise à la réactivation, administration /admin/recherche-active (arrondi à 5 près, revenus du mois), 404 indiscernable pour autrui ET pour le besoin
 *      PORTEUR d'une mission (lot MV1 : ni lecture ni achat, carte absente de sa page), page 404 standard pour l'acheteur ; wallet:check sans écart. (Les connecteurs fictifs sont actifs dans `dev:try` : sans eux l'option est « pas encore disponible ».)
 *  10. LOT H1, H1-bis et H1-ter : `demo:seed` écrit 90 jours de relevés de prix synthétiques (rejouable : 0 relevé au rejeu) ; la fiche d'une annonce montre l'encart « Prix demandés dans les annonces »
 *      REMPLI (médiane, fourchette « la moitié des prix demandés est entre … », effectif « environ N annonces d'environ M vendeurs », période, comparabilité, phrase sur ce que contiennent les chiffres, mini-courbe
 *      SVG de 12 semaines, bouton de période), SANS aucune ligne de ventes ni « prix du marché » ; le formulaire d'annonce du vendeur affiche « Prix demandés dans les annonces pour ce
 *      produit : médiane X (environ N annonces d'environ M vendeurs, 90 jours). Comparé à : … », dit « tous états confondus » quand l'état est décoché et disparaît pour un produit sans données ; /admin/marche
 *      (administrateur seulement) donne par produit les prix demandés et un NOMBRE arrondi de ventes confirmées, jamais un prix de vente.
 * Captures dans NOMA_E2E_SHOTS (défaut /var/tmp/noma-d1-shots).
 *
 * Variables : NOMA_E2E_BASE_URL (relais, défaut http://localhost:3212), NOMA_E2E_SERVER_LOG, NOMA_E2E_DATABASE_URL (noma_e2e, pour demo:seed), NOMA_E2E_SHOTS, NOMA_E2E_CHROME.
 * Voir scripts/e2e-common.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { E2E_BASE, E2E_SERVER_LOG, activeSearchSimulateByAdministration, awaitOtpLine, demoSeedByAdministration, otpSourceSize, waitForValue, walletCheckByAdministration } from "./e2e-common";

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
  const offset = otpSourceSize();
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

/** Taille décodée par le navigateur de chaque image qui répond au sélecteur (chargement forcé : les vignettes sont paresseuses). */
async function decodedSizes(page: Page, selector: string): Promise<Array<[number, number]>> {
  return page.locator(selector).evaluateAll(async (nodes) =>
    Promise.all(
      nodes.map(async (node) => {
        const image = node as HTMLImageElement;
        image.loading = "eager";
        try {
          await image.decode();
        } catch {
          return [0, 0] as [number, number];
        }
        return [image.naturalWidth, image.naturalHeight] as [number, number];
      }),
    ),
  );
}

async function main(): Promise<void> {
  step("demo:seed sur la base noma_e2e, puis rejeu à l'identique");
  const first = await demoSeedByAdministration();
  assert.match(first, /demo:seed : base « noma_e2e » : (\d+) annonce\(s\) publiée\(s\)/);
  assert.match(first, /3 message\(s\) écrit\(s\), favori ajouté, commande de démonstration proposée au vendeur démo, rôle admin attribué au compte Admin démo/);
  assert.match(first, /offre Pro : vendeur démo abonné \(crédits promotionnels émis\)/);
  assert.match(first, /photos : 30 photo\(s\) synthétique\(s\) ajoutée\(s\) \(0 déjà présente\(s\)\), une par annonce/);
  // `dev:try` active les connecteurs FICTIFS (lot RA1-bis) : le worker peut déjà avoir collecté une partie des annonces des trois surveillances pendant que `demo:seed` écrit ; ce qui compte est
  // que l'ensemble (créées + déjà présentes) soit complet, puis stable au rejeu.
  const externalFirst = /demo:seed : collecte externe \(sources FICTIVES, aucun réseau\) : 3 surveillance\(s\) pour l'acheteur démo, (\d+) annonce\(s\) externe\(s\) créée\(s\) \((\d+) déjà présente\(s\)\), 0 panne\(s\) de source/.exec(first);
  assert.ok(externalFirst, "collecte externe du premier passage");
  const externalTotal = Number(externalFirst[1]) + Number(externalFirst[2]);
  assert.ok(externalTotal >= 6, `annonces externes des trois surveillances (${externalTotal})`);
  const created = Number(/: (\d+) annonce\(s\) publiée\(s\)/.exec(first)?.[1]);
  const history = Number(/historique des prix : (\d+) relevé\(s\) synthétique\(s\) écrit\(s\)/.exec(first)?.[1]);
  assert.ok(history > 1_000, `historique des prix synthétique écrit (${history} relevés)`);
  info(first.split("\n")[0]);
  const second = await demoSeedByAdministration();
  assert.match(second, /0 annonce\(s\) publiée\(s\) \(30 déjà présente\(s\)\), 0 besoin\(s\) activé\(s\) \(14 déjà présent\(s\)\), 0 compte\(s\) créé\(s\) \(27 déjà présent\(s\)\)/);
  assert.match(second, /0 ouverture\(s\) et 0 contact\(s\) fictifs écrits, crédits déjà présents, boost déjà actif/);
  assert.match(second, /0 message\(s\) écrit\(s\), favori déjà présent, commande de démonstration déjà active, rôle admin déjà attribué/);
  assert.match(second, /historique des prix : 0 relevé\(s\) synthétique\(s\) écrit\(s\) \(annonces et ventes fictives des 90 derniers jours ; déjà présents\)/);
  assert.match(second, /offre Pro : vendeur démo déjà abonné/, "rejeu : le vendeur démo n'est jamais abonné deux fois");
  assert.match(second, /photos : 0 photo\(s\) synthétique\(s\) ajoutée\(s\) \(30 déjà présente\(s\)\), une par annonce/);
  assert.match(second, new RegExp(`3 surveillance\\(s\\) pour l'acheteur démo, 0 annonce\\(s\\) externe\\(s\\) créée\\(s\\) \\(${externalTotal} déjà présente\\(s\\)\\)`), "rejeu : aucune annonce externe de plus, toutes déjà présentes");
  ok(`premier passage : ${created} annonce(s) et ${history} relevé(s) de prix synthétiques ; rejeu : 0 annonce, 0 besoin, 0 compte, 0 ouverture, 0 contact, crédits et boost déjà présents`);

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
    await waitForValue("résumé des notifications non lues de l'accueil", async () => (await buyer.locator("[data-unread-summary]").innerText({ timeout: 1_000 })).replace(/\s+/g, " ").trim(), (value) => /3 notifications non lues/.test(value), "/3 notifications non lues/");
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
    // Lot PRO1 : le vendeur démo est abonné Pro : son annonce porte le badge « Vendeur Pro » (texte honnête au survol), aucune autre.
    assert.equal(await buyer.getByTestId("pro-badge").count(), 1, "UN badge « Vendeur Pro » : l'annonce du vendeur démo");
    assert.equal(await sponsored.getByTestId("pro-badge").count(), 1, "le badge est sur l'annonce du vendeur démo");
    assert.equal(await sponsored.getByTestId("pro-badge").locator("span[title]").getAttribute("title"), "Abonné à l'offre Pro de noma. Ce n'est pas une garantie de qualité.");
    ok("badge « Vendeur Pro » sur l'annonce du vendeur démo seulement, texte honnête au survol");
    // Lot PH1 : chaque carte porte la vignette de la photo synthétique de l'annonce, réellement décodée par le navigateur.
    assert.equal(await buyer.getByTestId("photo-cover").count(), 9, "une vignette par carte");
    assert.deepEqual(await decodedSizes(buyer, '[data-testid="match-card"] [data-testid="photo-cover"]'), Array.from({ length: 9 }, () => [480, 360]));
    ok("lot PH1 : les 9 cartes montrent la vignette de leur annonce (PNG synthétique 480 × 360 décodé par le navigateur)");
    // Lot EXT1 : la section « Sur d'autres sites » (annonces des sources FICTIVES), à part, avec la mention et des liens sortants sûrs.
    await buyer.getByTestId("external-section").waitFor();
    assert.equal(((await buyer.getByTestId("external-section").getByRole("heading").first().textContent()) ?? "").trim(), "Sur d'autres sites");
    assert.equal(await buyer.getByTestId("external-card").count(), 4, "quatre annonces d'autres sites dans le budget, à Abidjan, pour le produit (le doublon des deux sources n'est montré qu'une fois)");
    assert.equal(await buyer.locator('[aria-label="Offres correspondant à votre besoin"] [data-testid="external-card"]').count(), 0, "jamais dans la liste des résultats noma");
    assert.equal(await buyer.getByTestId("match-card").count(), 9, "la section externe n'ajoute rien à la liste noma");
    const mentions = await buyer.getByTestId("external-mention").allInnerTexts();
    assert.equal(mentions.length, 4);
    for (const mention of mentions) assert.match(mention, /^Annonce trouvée sur Annonces Démo [AB] : noma ne garantit ni le prix ni la disponibilité ; vous serez redirigé vers le site\.$/);
    const links = buyer.getByTestId("external-link");
    assert.equal(await links.count(), 4);
    for (let index = 0; index < 4; index += 1) {
      const link = links.nth(index);
      assert.equal(await link.getAttribute("target"), "_blank");
      assert.equal(await link.getAttribute("rel"), "noopener noreferrer nofollow");
      assert.match((await link.getAttribute("href")) ?? "", /^https:\/\/annonces-demo-[ab]\.example\/annonce\/demo_[ab]-/);
    }
    const externalText = await buyer.getByTestId("external-section").innerText();
    assert.equal(/Sponsoris|Contacter|favori|tel:/i.test(externalText), false, "aucune action de noma ni mise en avant dans la section externe");
    assert.equal(await buyer.getByTestId("external-section").locator('a[href^="tel:"], a[href*="wa.me"], button:not([data-testid="external-more"])').count(), 0);
    assert.match(externalText.replace(/\s+/g, " "), /Aussi trouvée sur Annonces Démo B/, "le doublon entre sources est présenté une fois");
    assert.equal((externalText.match(/Vue le \d{2}\/\d{2}\/\d{4}/g) ?? []).length, 4, "lot EXT1-bis : chaque annonce porte sa date de dernière VUE (« Vue le jj/mm/aaaa »)");
    assert.equal(/0708091011|07 08 09 10 11|appelez/i.test(await buyer.evaluate(() => document.body.innerText)), false, "le numéro de téléphone de l'annonce piégée n'est jamais affiché");
    ok("section « Sur d'autres sites » : 4 annonces fictives à part, mention obligatoire, liens en nouvel onglet (noopener noreferrer nofollow), aucun numéro, aucune action de noma");
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
    assert.equal(await buyer.getByTestId("pro-badge").count(), 1);
    assert.equal((await buyer.getByTestId("pro-badge-notice").innerText()).trim(), "Abonné à l'offre Pro de noma. Ce n'est pas une garantie de qualité.");
    ok("fiche : badge « Vendeur Pro » avec, écrit dessous, « Abonné à l'offre Pro de noma. Ce n'est pas une garantie de qualité. »");
    await buyer.getByTestId("photo-gallery").waitFor();
    assert.deepEqual(await decodedSizes(buyer, '[data-testid="gallery-main"]'), [[480, 360]]);
    ok("lot PH1 : la fiche montre la galerie (une photo) de l'annonce, décodée par le navigateur");
    await checkClean(buyer, "fiche");
    await shot(buyer, "04-fiche-acheteur");

    step("H1 · Fiche : l'encart « Prix demandés dans les annonces » est rempli (médiane, fourchette, période, comparabilité, mini-courbe) et ne montre AUCUNE vente");
    const marketCard = buyer.getByTestId("market-card");
    await marketCard.waitFor();
    await buyer.waitForFunction(() => document.querySelector('[data-testid="market-card"]')?.getAttribute("data-state") === "ready", undefined, { timeout: 60_000 });
    const marketText = (await marketCard.innerText()).replace(/[\u00a0\u202f]/g, " ");
    assert.match(marketText, /Prix demandés dans les annonces/);
    assert.equal(/prix du marché/i.test(marketText), false, "jamais « prix du marché »");
    assert.match(marketText, /Sur les 90 derniers jours/);
    const clean = async (testId: string): Promise<string> => (await buyer.getByTestId(testId).innerText()).replace(/[\u00a0\u202f]/g, " ");
    const listingsMedian = await clean("market-listings-median");
    assert.match(listingsMedian, /^\d{3} \d{3} FCFA$/, "médiane des prix demandés");
    assert.equal(Number(listingsMedian.replace(/\D/g, "")) % 500, 0, `${listingsMedian} : arrondi à 500 FCFA`);
    assert.match(await clean("market-listings-range"), /^La moitié des prix demandés est entre \d{3} \d{3} FCFA et \d{3} \d{3} FCFA$/);
    const countText = await clean("market-listings-count");
    assert.match(countText, /^environ \d+ annonces d'environ \d+ vendeurs$/);
    // Lot H1-ter : l'unité est le vendeur. Le produit phare de la démonstration compte assez de vendeurs fictifs distincts (au moins 20 affichés, le minimum d'un point de tendance ; la démonstration en donne 24) pour que la tendance s'affiche.
    assert.ok(Number(/d'environ (\d+) vendeurs/.exec(countText)?.[1]) >= 20, `${countText} : au moins 20 vendeurs pour le produit phare`);
    assert.equal(await clean("market-listings-compared"), "Comparé à : iPhone 12 128 Go, Occasion");
    assert.equal(await clean("market-asking-note"), "Ce sont des prix demandés par les vendeurs, pas des prix payés.");
    assert.equal(await clean("market-note"), "Calculé sur au moins 5 vendeurs différents, une seule valeur par vendeur (la médiane de ses annonces), prix atypiques écartés, chiffres arrondis (prix à 500 FCFA, effectifs à 5 près).");
    assert.equal(/Aucune annonce ni vente n'est montrée/.test(marketText), false, "l'ancienne phrase inexacte n'existe plus");
    const listingsBlock = await clean("market-listings");
    assert.equal(/\b(?<!environ )(?<!moins de )\d+ (annonces|vendeurs)\b/.test(listingsBlock), false, "jamais un effectif exact (annonces ou vendeurs, dans le bloc des annonces)");
    assert.equal(/\b(minimum|maximum|le moins cher|le plus cher)\b/i.test(marketText), false, "ni minimum ni maximum");
    assert.equal(await buyer.locator('[data-testid^="market-sales"]').count(), 0, "aucun élément de ventes");
    assert.equal(/ventes? confirmées?/i.test(marketText), false, "aucune ligne « Ventes confirmées »");
    const listingsTrend = buyer.getByTestId("market-listings-trend");
    await listingsTrend.waitFor();
    assert.equal(Number(await listingsTrend.getAttribute("data-points")), 12, "mini-courbe : 12 semaines (au moins 20 vendeurs par semaine)");
    assert.ok((await listingsTrend.evaluate((svg) => svg.querySelectorAll("path").length)) >= 1 && (await listingsTrend.getAttribute("aria-label"))?.startsWith("Tendance"), "tracé SVG et texte alternatif");
    await buyer.getByTestId("market-period-30").click();
    await buyer.waitForFunction(() => document.querySelector('[data-testid="market-period"]')?.textContent === "Sur les 30 derniers jours", undefined, { timeout: 30_000 });
    await buyer.getByTestId("market-period-365").click();
    await buyer.waitForFunction(() => document.querySelector('[data-testid="market-period"]')?.textContent === "Sur la dernière année", undefined, { timeout: 30_000 });
    await buyer.getByTestId("market-period-90").click();
    await buyer.waitForFunction(() => document.querySelector('[data-testid="market-period"]')?.textContent === "Sur les 90 derniers jours", undefined, { timeout: 30_000 });
    assert.equal(UUID.test(marketText), false, "aucun identifiant dans l'encart");
    ok(`encart « Prix demandés dans les annonces » : médiane ${listingsMedian} (arrondie à 500), fourchette, effectif « environ N annonces d'environ M vendeurs », période, comparabilité, phrase sur les chiffres, mini-courbe de 12 semaines, aucune vente ; 30 jours, 365 jours puis 90 jours`);
    await checkClean(buyer, "fiche avec les prix demandés");
    await shot(buyer, "04b-fiche-prix-du-marche");
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
    assert.deepEqual(await decodedSizes(vendor, '[data-vendor-offers] [data-testid="photo-cover"]'), Array.from({ length: 4 }, () => [480, 360]));
    ok("lot PH1 : les 4 annonces du tableau de bord montrent leur vignette (photo synthétique décodée)");
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

    step("H1 · Formulaire d'annonce : l'indication « Prix demandés dans les annonces pour ce produit »");
    await vendor.goto(`${BASE}/vendeur/annonces/nouvelle`);
    await vendor.getByRole("heading", { name: "Nouvelle annonce" }).waitFor();
    assert.equal(await vendor.getByTestId("market-hint").count(), 0, "pas d'indication tant que le produit n'est pas saisi");
    await vendor.getByRole("button", { name: "Téléphones", exact: true }).click();
    await vendor.getByPlaceholder("Apple", { exact: true }).fill("Apple");
    await vendor.getByPlaceholder("iPhone 12", { exact: true }).fill("iPhone 12");
    await vendor.getByPlaceholder("128 Go", { exact: true }).fill("128 Go");
    const hint = vendor.getByTestId("market-hint");
    await hint.waitFor({ timeout: 60_000 });
    const hintText = (await hint.innerText()).replace(/[\u00a0\u202f]/g, " ");
    assert.match(hintText, /^Prix demandés dans les annonces pour ce produit : médiane \d{3} \d{3} FCFA \(environ \d+ annonces d'environ \d+ vendeurs, 90 jours\)\. Comparé à : iPhone 12 128 Go, Occasion\.$/);
    assert.equal(/prix du marché/i.test(hintText), false, "jamais « prix du marché »");
    assert.equal(Number(/médiane ([\d ]+) FCFA/.exec(hintText)?.[1].replace(/\D/g, "")) % 500, 0, "médiane arrondie à 500 FCFA");
    await checkClean(vendor, "formulaire d'annonce avec l'indication des prix demandés");
    await shot(vendor, "08b-formulaire-prix-demandes");
    // L'état décoché : « tous états confondus » est dit.
    await vendor.getByRole("button", { name: "Occasion", exact: true }).click();
    await vendor.waitForFunction(() => /tous états confondus\.$/.test(document.querySelector('[data-testid="market-hint"]')?.textContent ?? ""), undefined, { timeout: 60_000 });
    const openHint = (await vendor.getByTestId("market-hint").innerText()).replace(/[\u00a0\u202f]/g, " ");
    assert.match(openHint, /Comparé à : iPhone 12 128 Go, tous états confondus\.$/);
    // Un produit sans données : l'indication disparaît.
    await vendor.getByPlaceholder("iPhone 12", { exact: true }).fill("Zzz 99 inconnu");
    await hint.waitFor({ state: "detached", timeout: 60_000 });
    ok(`formulaire : « ${hintText} » ; « tous états confondus » quand l'état est décoché ; elle disparaît pour un produit sans données`);

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
    // Lot PRO1 : le vendeur démo est Pro : ses 5 000 FCFA de crédits promotionnels paient le boost EN PREMIER.
    const boostPrice = Number((await vendor.getByTestId("boost-amount").innerText()).replace(/[^\d]/g, ""));
    assert.ok(boostPrice > 0 && boostPrice < 25_000, `prix du boost lu : ${boostPrice}`);
    const promoUsed = Math.min(boostPrice, 5_000);
    assert.match((await vendor.getByTestId("boost-promo-balance").innerText()).replace(/\s/g, " "), /et 5 000 FCFA de crédits promotionnels \(dépensés en premier\)/);
    await vendor.getByTestId("boost-buy").click();
    const confirmText = (await vendor.getByTestId("boost-confirm-text").innerText()).replace(/\s/g, " ");
    assert.match(confirmText, /de crédits promotionnels \(dépensés en premier\)/, "la confirmation dit que les crédits promotionnels sont dépensés en premier");
    await vendor.getByTestId("boost-confirm-button").click();
    await vendor.getByTestId("boost-success").waitFor({ timeout: 60_000 });
    ok(`devis du boost du Galaxy S21 disponible (effet visible démontré), achat payé d'abord avec les crédits promotionnels (${promoUsed} FCFA sur ${boostPrice}), « Boost actif »`);
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
    await waitForValue("pastille des messages du vendeur (une conversation non lue)", async () => (await vendor.getByTestId("messages-badge").first().innerText({ timeout: 1_000 })).trim(), (value) => value === "1", '"1"');
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
    assert.equal(await tile("accounts"), "27", "27 comptes : 3 de démonstration, 7 vendeurs, 11 acheteurs et 6 vendeurs d'historique fictifs");
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
    // Lot EXT1 : /admin/collecte, en lecture seule (sources fictives, surveillances, annonces, erreurs), sans bouton d'activation.
    await adminPage.getByRole("link", { name: /Collecte externe/ }).click();
    await adminPage.waitForURL(/\/admin\/collecte$/);
    await adminPage.getByTestId("admin-collection").waitFor();
    assert.equal(((await adminPage.getByRole("heading", { level: 1 }).textContent()) ?? "").trim(), "Collecte externe");
    assert.match(await adminPage.getByTestId("admin-collection-note").innerText(), /Lecture seule\. Seules des sources FICTIVES existent/);
    await adminPage.getByTestId("collection-source").first().waitFor();
    assert.deepEqual(await adminPage.getByTestId("collection-source").evaluateAll((nodes) => nodes.map((node) => `${node.getAttribute("data-source")}:${node.getAttribute("data-state")}`)), ["demo_a:closed", "demo_b:closed"]);
    const sourcesText = await adminPage.getByTestId("admin-collection").innerText();
    assert.match(sourcesText, /Annonces Démo A/);
    assert.match(sourcesText, /Annonces Démo B/);
    assert.match(sourcesText, /Source fictive/);
    for (const quota of await adminPage.getByTestId("collection-quota").allInnerTexts()) assert.match(quota, /^\d+ \/ 200 requêtes aujourd'hui$/);
    assert.match(await adminPage.getByTestId("collection-watches").innerText(), /3 surveillance\(s\) : 3 active\(s\), 0 en pause, 0 due\(s\) maintenant/);
    assert.match(await adminPage.getByTestId("collection-watches").innerText(), /\d+ annonce\(s\) disponible\(s\), 0 disparue\(s\)/);
    assert.match(await adminPage.getByTestId("collection-errors").innerText(), /Aucune erreur récente\./);
    assert.equal(await adminPage.getByTestId("admin-collection").locator("input, button, textarea, select").count(), 0, "lecture seule : aucun bouton d'activation d'une source");
    assert.equal(/réelle|activer/i.test(sourcesText.replace(/Seules des sources FICTIVES[^.]*\./, "")), false, "aucune invitation à activer une source réelle");
    await checkSwitcherDoesNotOverlap(adminPage, "collecte externe");
    await checkClean(adminPage, "collecte externe");
    await shot(adminPage, "24b-admin-collecte");
    ok("/admin/collecte : 2 sources fictives fermées avec leur quota, 3 surveillances actives, aucune erreur, aucun bouton d'activation");
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
    step("H1 · Administration : le tableau « Marché » (prix demandés, NOMBRE arrondi de ventes confirmées, aucun prix de vente)");
    await adminPage.goto(`${BASE}/admin`);
    await adminPage.getByTestId("admin-market-link").click();
    await adminPage.getByTestId("admin-market-table").waitFor();
    assert.ok((await adminPage.locator("[data-market-row]").count()) >= 10 && (await adminPage.locator("[data-market-row]").count()) <= 20, "au plus 20 produits");
    const iphoneRow = adminPage.locator("[data-market-row]").filter({ hasText: "Apple iPhone 12 · 128 Go · Occasion" }).first();
    await iphoneRow.waitFor();
    assert.match((await iphoneRow.getByTestId("admin-market-listings").innerText()).replace(/[\u00a0\u202f]/g, " "), /\d{3} \d{3} FCFA\s+environ \d+ annonces d'environ \d+ vendeurs/);
    const salesCell = (await iphoneRow.getByTestId("admin-market-sales").innerText()).replace(/[\u00a0\u202f]/g, " ");
    assert.match(salesCell, /^environ \d+ ventes confirmées$/, "un nombre arrondi de ventes");
    assert.equal(/FCFA|\d{4,}/.test(salesCell), false, "aucun prix de vente");
    const tableText = await adminPage.getByTestId("admin-market").innerText();
    assert.match(tableText, /les prix de vente ne sont pas publiés/);
    await checkClean(adminPage, "tableau Marché de l'administration");
    await shot(adminPage, "28b-admin-marche");
    ok("tableau « Marché » : prix demandés par produit, « environ N ventes confirmées » sans aucun prix");
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
      for (const path of ["/api/admin/summary", "/api/admin/vendors", "/api/admin/actions", "/api/admin/settings", "/api/admin/market"]) results.push((await fetch(path)).status);
      return results;
    });
    assert.deepEqual(apiStatuses, [404, 404, 404, 404, 404], "les routes d'administration (dont /api/admin/market, les ventes confirmées) répondent 404 à un compte ordinaire");
    assert.equal(await buyer.evaluate(async () => (await fetch("/api/admin/collection")).status), 404, "lot EXT1 : /api/admin/collection répond 404 à un compte ordinaire");
    const collecteRefused = await buyer.goto(`${BASE}/admin/collecte`);
    assert.equal(collecteRefused?.status(), 404, "lot EXT1 : /admin/collecte est une page 404 pour un compte ordinaire");
    assert.equal(/Collecte externe/.test(await buyer.evaluate(() => document.body.innerText)), false);
    const subPage = await buyer.goto(`${BASE}/admin/vendeurs`);
    assert.equal(subPage?.status(), 404);
    await buyer.getByText("This page could not be found.").waitFor();
    const marketPage = await buyer.goto(`${BASE}/admin/marche`);
    assert.equal(marketPage?.status(), 404);
    await buyer.getByText("This page could not be found.").waitFor();
    assert.equal(await buyer.getByTestId("admin-market-table").count(), 0, "l'acheteur ne voit pas le tableau « Marché »");
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
    // La session de l'administrateur démo reste ouverte : le bloc PRO1 final la réutilise (un second code pour le même numéro serait refusé par le délai de renvoi).

    step("MV1 · Missions d'achat en volume : mission de démonstration, création, proposition, « Écrire » pré-rempli, déclaration, confirmation côté vendeur, progression");
    // 1. La mission de démonstration (10 Samsung Galaxy S21, 135 000 FCFA l'unité) apparaît dans « Mes missions », partiellement couverte.
    await buyer.goto(`${BASE}/missions`);
    await buyer.getByTestId("mission-row").first().waitFor();
    assert.equal(await buyer.getByTestId("mission-row").count(), 1, "la mission de démonstration seulement");
    const seededRow = buyer.getByTestId("mission-row").first();
    assert.match(await seededRow.innerText(), /10 × Samsung Galaxy S21/);
    assert.match(await seededRow.getByTestId("mission-coverage").innerText(), /La proposition couvre 5 sur 10 \(50 %\)/);
    assert.match(await seededRow.getByTestId("mission-secured").innerText(), /0 sur 10 achetés/);
    await checkSwitcherDoesNotOverlap(buyer, "Mes missions");
    await checkClean(buyer, "Mes missions");
    await shot(buyer, "30-mes-missions");
    ok("« Mes missions » : la mission de démonstration (10 Samsung Galaxy S21), proposition couvrant 5 sur 10 (50 %), 0 sur 10 achetés");
    await seededRow.locator("a").click();
    await buyer.waitForURL(/\/missions\/[0-9a-f-]{36}$/);
    // La suspension puis la réactivation d'un vendeur fictif (étape d'administration plus haut) fait recalculer ses annonces par le worker : la proposition, relue en direct, retrouve ses cinq
    // lignes dès que ce calcul est fini (la liste « Mes missions » garde la couverture lue avant).
    const seededUntil = Date.now() + 90_000;
    for (;;) {
      await buyer.getByTestId("mission-detail").waitFor();
      await buyer.getByTestId("proposal-coverage").waitFor();
      if ((await buyer.getByTestId("proposal-line").count()) === 5) break;
      assert.ok(Date.now() < seededUntil, `la proposition de démonstration n'a que ${await buyer.getByTestId("proposal-line").count()} ligne(s) après 90 s`);
      await sleep(3_000);
      await buyer.reload();
    }
    assert.equal(await buyer.getByTestId("proposal-line").count(), 5, "cinq vendeurs");
    const vendors = await buyer.getByTestId("line-vendor").allInnerTexts();
    assert.deepEqual(vendors.map((text) => text.trim().toLowerCase()), ["vendeur 1", "vendeur 2", "vendeur 3", "vendeur 4", "vendeur 5"], "vendeurs anonymes");
    const reasons = await buyer.getByTestId("proposal-reasons").innerText();
    assert.match(reasons, /pas encore assez d'annonces/);
    assert.match(reasons, /dépassent votre budget par unité/);
    assert.match(await buyer.getByTestId("no-payment-notice").first().innerText(), /noma ne gère aucun paiement de l'objet/);
    const seededText = await buyer.evaluate(() => document.body.innerText);
    assert.equal(/0788888801|07 88 88 88 01|\+225/.test(seededText.replace(/\s/g, " ")), false, "aucun numéro de vendeur dans la proposition");
    await checkClean(buyer, "page d'une mission");
    await shot(buyer, "31-mission-demonstration");
    ok("page de la mission : cinq lignes (Vendeur 1 à 5, sans identité ni numéro), raisons en mots simples, « aucun paiement ne passe par noma »");

    // 2. Création : un numéro de téléphone dans un champ est refusé à l'écran ; puis une mission iPhone 12 (8 voulus, 165 000 FCFA est le prix de l'annonce du vendeur démo).
    await buyer.goto(`${BASE}/missions/nouvelle`);
    await buyer.getByTestId("mission-field-category").fill("Téléphones");
    await buyer.getByTestId("mission-field-brand").fill("Apple");
    await buyer.getByTestId("mission-field-model").fill("0708091011");
    await buyer.getByTestId("mission-field-quantity").fill("8");
    await buyer.getByTestId("mission-field-unitBudgetXof").fill("170 000");
    await buyer.getByTestId("mission-field-totalBudgetXof").fill("1 400 000");
    await buyer.getByTestId("mission-field-location").fill("Abidjan");
    await buyer.getByTestId("mission-submit").click();
    assert.match(await buyer.getByTestId("mission-problem-model").innerText(), /Pas de numéro de téléphone dans la mission \(champ : modèle\)/);
    assert.match(buyer.url(), /\/missions\/nouvelle$/, "rien n'est créé");
    await shot(buyer, "32-mission-numero-refuse");
    await buyer.getByTestId("mission-field-model").fill("iPhone 12");
    await buyer.getByTestId("mission-field-quantity").fill("1");
    await buyer.getByTestId("mission-submit").click();
    assert.match(await buyer.getByTestId("mission-problem-quantity").innerText(), /nombre entier de 2 à 10 000/);
    await buyer.getByTestId("mission-field-quantity").fill("8");
    await buyer.getByTestId("mission-submit").click();
    await buyer.waitForURL(/\/missions\/[0-9a-f-]{36}$/);
    await buyer.getByTestId("mission-detail").waitFor();
    assert.equal(await buyer.getByTestId("mission-title").innerText(), "8 × Apple iPhone 12");
    assert.match(await buyer.getByTestId("mission-status").innerText(), /En cours/);
    const missionUrl = buyer.url();
    ok("création : un numéro de téléphone et une quantité hors bornes sont refusés à l'écran (rien n'est créé) ; la mission « 8 × Apple iPhone 12 » est lancée");

    // 3. La proposition apparaît quand le calcul des correspondances du besoin porteur est terminé (le worker tourne : on relit la page).
    const lineCount = async (): Promise<number> => buyer.getByTestId("proposal-line").count();
    const waitedUntil = Date.now() + 120_000;
    for (;;) {
      await buyer.reload();
      await buyer.getByTestId("mission-detail").waitFor();
      await sleep(1_500);
      if ((await lineCount()) >= 7) break;
      assert.ok(Date.now() < waitedUntil, `la proposition n'a que ${await lineCount()} ligne(s) après 120 s`);
      await sleep(3_000);
    }
    assert.equal(await lineCount(), 7, "sept annonces d'iPhone 12 à 170 000 FCFA ou moins (une par vendeur)");
    assert.match(await buyer.getByTestId("proposal-coverage").innerText(), /La proposition couvre 7 sur 8 \(87 %\)/);
    const demoLine = buyer.getByTestId("proposal-line").filter({ has: buyer.getByTestId("line-subtotal").filter({ hasText: /^165.000 FCFA$/ }) });
    assert.equal(await demoLine.count(), 1, "l'annonce du vendeur démo (165 000 FCFA) est l'une des lignes");
    await checkClean(buyer, "proposition iPhone 12");
    await shot(buyer, "33-proposition-iphone12");
    ok("proposition : 7 lignes (vendeurs anonymes), couverture 7 sur 8 (87 %), dont l'annonce du vendeur démo à 165 000 FCFA");

    // 4. « Écrire » : la conversation s'ouvre avec un message PRÉ-REMPLI (quantité et prix visés), modifiable ; rien n'est envoyé.
    await demoLine.getByTestId("line-write").click();
    await buyer.waitForURL(/\/messages\/[0-9a-f-]{36}\?quantite=1&prix=165000$/);
    await buyer.getByTestId("conversation-title").waitFor();
    const draft = await buyer.getByTestId("message-input").inputValue();
    assert.match(draft.replace(/\s/g, " "), /^Bonjour, je souhaite acheter 1 unité de « Apple iPhone 12 128 Go » à 165 000 FCFA l'unité\./);
    assert.equal(/170.?000|1.?400.?000|budget|mission|total/i.test(draft), false, "le message ne dit ni le budget ni la mission");
    assert.equal(await buyer.getByTestId("message-bubble").count(), 0, "rien n'a été envoyé automatiquement");
    await shot(buyer, "34-ecrire-prerempli");
    await buyer.getByTestId("message-input").fill(`${draft} Je peux passer demain.`);
    assert.equal(await buyer.getByTestId("message-bubble").count(), 0, "modifier le message ne l'envoie pas");
    await buyer.getByTestId("message-send").click();
    await buyer.getByTestId("message-bubble").filter({ hasText: "Je peux passer demain." }).waitFor();
    ok("« Écrire » ouvre la conversation avec le message pré-rempli (quantité et prix visés, ni budget ni mission) ; il est modifiable et ne part que quand l'acheteur l'envoie");

    // 5. « Déclarer l'achat » depuis la ligne : quantité modifiable, prix par unité, « aucun paiement ne passe par noma ».
    await buyer.goto(missionUrl);
    await buyer.getByTestId("proposal-line").first().waitFor();
    const line = buyer.getByTestId("proposal-line").filter({ has: buyer.getByTestId("line-subtotal").filter({ hasText: /^165.000 FCFA$/ }) });
    await line.getByTestId("line-declare").click();
    assert.equal(await line.getByTestId("line-declare-quantity").inputValue(), "1");
    assert.equal(await line.getByTestId("line-declare-price").inputValue(), "165000");
    assert.match(await line.getByTestId("line-declare-form").innerText(), /noma ne gère aucun paiement de l'objet/);
    await line.getByTestId("line-declare-quantity").fill("0");
    assert.equal(await line.getByTestId("line-declare-submit").isDisabled(), true, "quantité 0 : refusée avant l'envoi");
    await line.getByTestId("line-declare-price").fill("171 000");
    await line.getByTestId("line-declare-quantity").fill("2");
    assert.equal(await line.getByTestId("line-declare-submit").isDisabled(), true, "prix au-dessus du budget par unité : refusé avant l'envoi");
    assert.match(await line.getByTestId("line-problem").innerText(), /Ce prix dépasse votre budget par unité/);
    await line.getByTestId("line-declare-quantity").fill("9");
    await line.getByTestId("line-declare-price").fill("165 000");
    assert.equal(await line.getByTestId("line-declare-submit").isDisabled(), true, "quantité au-delà de ce qu'il reste à acheter : refusée avant l'envoi");
    assert.match(await line.getByTestId("line-problem").innerText(), /Il ne reste que 8 à acheter/);
    await line.getByTestId("line-declare-quantity").fill("2");
    await line.getByTestId("line-declare-submit").click();
    // L'achat déclaré quitte les lignes de la proposition (elle ne répartit plus que le RESTE) et passe dans « Déjà acheté ou en attente ».
    await buyer.getByTestId("engaged-line").waitFor();
    assert.equal(await buyer.getByTestId("engaged-line").count(), 1);
    assert.match(await buyer.getByTestId("engaged-status").innerText(), /Achat déclaré : 2, en attente du vendeur/);
    assert.match(await buyer.getByTestId("proposal-engaged").innerText(), /Déjà acheté ou en attente/);
    assert.equal(await demoLine.count(), 0, "l'annonce déjà commandée n'est pas reproposée");
    assert.match(await buyer.getByTestId("proposal-committed").innerText(), /2 déjà achetés ou en attente, 6 à acheter/);
    assert.match(await buyer.getByTestId("mission-secured").innerText(), /0 sur 8 achetés/, "une commande proposée n'est pas sécurisée");
    assert.match(await buyer.getByTestId("mission-detail").innerText(), /2 en attente de confirmation/);
    await shot(buyer, "35-achat-declare");
    ok("achat déclaré (2 × 165 000 FCFA) : un prix au-dessus du budget par unité et une quantité au-delà de ce qu'il reste sont refusés à l'écran ; l'achat passe dans « Déjà acheté ou en attente » (« en attente du vendeur ») et n'est plus reproposé ; 0 sur 8 achetés tant que le vendeur n'a pas confirmé");

    // 6. Côté vendeur : la commande dit la quantité demandée ; jamais la mission, le budget ni les autres vendeurs.
    await vendor.goto(`${BASE}/vendeur/commandes`);
    await vendor.getByTestId("order-row").first().waitFor();
    const missionOrder = vendor.getByTestId("order-row").filter({ hasText: "2 × 165" });
    assert.equal(await missionOrder.count(), 1);
    await missionOrder.click();
    await vendor.waitForURL(/\/vendeur\/commandes\/[0-9a-f-]{36}$/);
    await vendor.getByTestId("order-detail").waitFor();
    assert.match((await vendor.getByTestId("order-quantity-line").innerText()).replace(/\s/g, " "), /Quantité demandée : 2 · Total 330 000 FCFA/);
    const vendorOrderText = (await vendor.evaluate(() => document.body.innerText)).replace(/\s/g, " ");
    assert.equal(/mission|170 000|1 400 000|Vendeur [0-9]|8 ×/i.test(vendorOrderText), false, `le vendeur ne voit ni la mission, ni le budget, ni les autres vendeurs : « ${vendorOrderText.slice(0, 200)} »`);
    assert.equal(await vendor.getByTestId("order-mission-link").count(), 0);
    await checkClean(vendor, "commande de mission côté vendeur");
    await shot(vendor, "36-commande-mission-vendeur");
    await vendor.getByTestId("order-confirm").click();
    await vendor.getByTestId("order-notice").waitFor();
    assert.match(await vendor.getByTestId("order-status").innerText(), /Confirmée/);
    ok("le vendeur voit « Quantité demandée : 2 · Total 330 000 FCFA », jamais la mission, le budget ni les autres vendeurs ; il confirme");

    // 7. La progression : 2 sur 8 achetés.
    await buyer.goto(missionUrl);
    await buyer.getByTestId("mission-secured").waitFor();
    assert.match(await buyer.getByTestId("mission-secured").innerText(), /2 sur 8 achetés/);
    assert.equal(await buyer.getByTestId("mission-secured").locator("xpath=following::*[@role='progressbar'][1]").getAttribute("aria-valuenow"), "25");
    assert.match(await buyer.getByTestId("mission-order").first().innerText(), /Confirmé/);
    assert.match(await buyer.getByTestId("engaged-status").innerText(), /Achat confirmé : 2/);
    assert.match(await buyer.getByTestId("proposal-committed").innerText(), /2 déjà achetés ou en attente, 6 à acheter/);
    assert.match(await buyer.getByTestId("proposal-coverage").innerText(), /La proposition couvre 8 sur 8 \(100 %\)/, "2 achetés + les 6 autres annonces : la proposition ne répartit que le reste");
    assert.equal(await buyer.getByTestId("proposal-line").count(), 6, "l'annonce achetée n'est plus une ligne de la proposition");
    await shot(buyer, "37-progression");
    await buyer.goto(`${BASE}/missions`);
    await buyer.getByTestId("mission-row").first().waitFor();
    const rows = await buyer.getByTestId("mission-row").allInnerTexts();
    assert.ok(rows.some((text) => /8 × Apple iPhone 12/.test(text) && /2 sur 8 achetés/.test(text)), "la liste montre 2 sur 8 achetés");
    ok("la quantité sécurisée passe de 0 à 2 sur 8 (barre à 25 %) après la confirmation du vendeur, dans la page de la mission comme dans la liste");

    // 8. Pause puis reprise.
    await buyer.goto(missionUrl);
    await buyer.getByTestId("mission-pause").click();
    await buyer.getByTestId("mission-notice").filter({ hasText: "Mission en pause." }).waitFor();
    await buyer.getByTestId("mission-resume").waitFor();
    assert.match(await buyer.getByTestId("mission-status").innerText(), /En pause/);
    await buyer.getByTestId("mission-resume").click();
    await buyer.getByTestId("mission-pause").waitFor();
    assert.match(await buyer.getByTestId("mission-status").innerText(), /En cours/);
    ok("pause puis reprise de la mission depuis l'écran");

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

    // ── LOT PRO1 : offre Pro, crédits promotionnels, import de catalogue ───────────────────────────────
    const fr = (text: string): string => text.replace(/\s/g, " ");
    const priceFor = (paidAfter: number): string => `${paidAfter.toLocaleString("fr-FR")} FCFA`.replace(/\s/g, " ");
    step("PRO1 · Porte-monnaie du vendeur démo : crédits et crédits promotionnels séparés, le boost payé d'abord en crédits promotionnels");
    const promoLeft = 5_000 - promoUsed;
    const paidLeft = 25_000 - (boostPrice - promoUsed);
    await vendor.goto(`${BASE}/compte/porte-monnaie`);
    await vendor.getByTestId("wallet-balance").waitFor();
    assert.equal(fr(await vendor.getByTestId("wallet-balance").innerText()), priceFor(paidLeft), "crédits payés : seul le reste du prix a été débité");
    assert.equal(fr(await vendor.getByTestId("wallet-promo-balance").innerText()), priceFor(promoLeft), "crédits promotionnels restants");
    if (promoLeft > 0) assert.match(fr(await vendor.getByTestId("wallet-promo-expiry").innerText()), /^jusqu'au \d\d\/\d\d\/\d{4} à \d\d:\d\d$/);
    assert.match(await vendor.getByTestId("wallet-promo").innerText(), /ni remboursables ni retirables/);
    const boostRow = vendor.locator('[data-testid="wallet-row"][data-kind="boost_purchase"]').first();
    assert.match(fr(await boostRow.getByTestId("wallet-row-promo").innerText()), /promotionnels|crédits promotionnels/);
    const subscriptionRow = vendor.locator('[data-testid="wallet-row"][data-kind="subscription_charge"]').first();
    await subscriptionRow.waitFor();
    assert.equal(await vendor.locator('[data-testid="wallet-row"][data-kind="subscription_charge"]').count(), 1, "une seule souscription du vendeur démo");
    await checkClean(vendor, "porte-monnaie du vendeur démo");
    await shot(vendor, "30-porte-monnaie-promotionnel");
    ok(`porte-monnaie : crédits ${priceFor(paidLeft)} et crédits promotionnels ${priceFor(promoLeft)} séparés, règles dites, ligne de l'abonnement et du boost avec leur part promotionnelle`);

    step("PRO1 · Page « Offre Pro » du vendeur démo : état, comparaison aux prix provisoires, crédits promotionnels");
    await vendor.goto(`${BASE}/vendeur/offre-pro`);
    await vendor.getByTestId("pro-status").waitFor();
    assert.equal(await vendor.getByTestId("pro-status").getAttribute("data-source"), "subscription");
    assert.match(await vendor.getByTestId("pro-status").innerText(), /Offre Pro active/);
    assert.match(fr(await vendor.getByTestId("pro-status").innerText()), /Renouvellement automatique : 10 000 FCFA le \d\d\/\d\d\/\d{4}, avec vos crédits\./);
    assert.equal(fr(await vendor.getByTestId("pro-promo-amount").innerText()), priceFor(promoLeft));
    assert.match(await vendor.getByTestId("pro-prices-notice").innerText(), /^Prix provisoires/);
    const table = fr(await vendor.getByTestId("pro-plan-table").innerText());
    assert.match(table, /Gratuit/);
    assert.match(table, /10 000 FCFA par mois/);
    assert.match(table, /100 au plus/);
    assert.equal(await vendor.getByTestId("pro-subscribe").count(), 0, "déjà abonné : aucun bouton de souscription");
    await vendor.getByTestId("pro-import-link").waitFor();
    await checkClean(vendor, "page Offre Pro");
    await shot(vendor, "31-offre-pro-vendeur-demo");
    ok("offre Pro active, renouvellement automatique annoncé, crédits promotionnels restants, tableau Gratuit / Pro aux prix PROVISOIRES, lien d'import (droit présent)");

    step("PRO1 · Import de catalogue (vendeur démo) : aperçu à blanc, application, rejeu, numéro de téléphone refusé");
    const CSV = [
      "titre,description,categorie,marque,modele,variante,etat,localisation,prix,disponible",
      "Casque audio Sony WH-1000XM4,Très bon état avec sa housse,Électronique,Sony,WH-1000XM4,,Occasion,Cocody,95000,oui",
      "Enceinte portable,,Électronique,07 08 09 10 11,,,,,35000,oui",
      "Clavier mécanique,,Électronique,Logitech,,,,,abc,oui",
    ].join("\n");
    await vendor.goto(`${BASE}/vendeur/annonces/import`);
    await vendor.getByTestId("import-text").fill(CSV);
    assert.equal(await vendor.getByTestId("import-apply").isEnabled(), false, "pas d'application avant l'aperçu");
    await vendor.getByTestId("import-preview").click();
    const report = vendor.getByTestId("import-report");
    await report.waitFor();
    assert.equal(await report.getAttribute("data-mode"), "preview");
    assert.match(await report.innerText(), /Aperçu : rien n'a encore été créé/);
    assert.match(fr(await vendor.getByTestId("import-summary").innerText()), /1 annonce serait créée et 2 lignes seraient refusées\./);
    const rejectedText = fr(await vendor.getByTestId("import-rejected").innerText());
    assert.match(rejectedText, /Ligne 3 : pas de numéro de téléphone dans l'annonce/);
    assert.match(rejectedText, /Ligne 4 : le prix n'est pas valide\./);
    assert.equal(/0708091011|07 08 09 10 11|abc|Enceinte|Clavier/.test(rejectedText), false, "le rapport ne reprend aucune donnée du fichier");
    await checkClean(vendor, "aperçu de l'import");
    await shot(vendor, "32-import-apercu");
    assert.equal(await vendor.getByTestId("import-apply").isEnabled(), true);
    // Un texte modifié efface l'aperçu : on n'applique jamais un fichier qu'on n'a pas prévisualisé.
    await vendor.getByTestId("import-text").fill(`${CSV}\n`);
    assert.equal(await vendor.getByTestId("import-apply").isEnabled(), false);
    await vendor.getByTestId("import-text").fill(CSV);
    await vendor.getByTestId("import-preview").click();
    await vendor.getByTestId("import-report").waitFor();
    await vendor.getByTestId("import-apply").click();
    await vendor.waitForFunction(() => document.querySelector('[data-testid="import-report"]')?.getAttribute("data-mode") === "apply");
    assert.match(fr(await vendor.getByTestId("import-summary").innerText()), /1 annonce créée et 2 lignes refusées\./);
    await vendor.getByTestId("import-listings-link").waitFor();
    await shot(vendor, "33-import-applique");
    await vendor.getByTestId("import-preview").click();
    await vendor.waitForFunction(() => document.querySelector('[data-testid="import-report"]')?.getAttribute("data-replayed") === "true");
    assert.match(await vendor.getByTestId("import-report").innerText(), /Ce fichier a déjà été importé/);
    assert.equal(await vendor.getByTestId("import-apply").isEnabled(), false, "un fichier déjà importé ne se réapplique pas");
    await vendor.goto(`${BASE}/vendeur`);
    await vendor.locator("[data-vendor-offers] a", { hasText: "Casque audio Sony" }).first().waitFor();
    assert.equal(await vendor.locator('[data-vendor-offers] a[href^="/vendeur/annonces/"]').count(), 5, "l'annonce importée est en ligne : 5 annonces");
    ok("import CSV : aperçu (1 créée, 2 refusées dont un numéro de téléphone), application, rejeu « déjà importé » sans rien recréer, l'annonce est en ligne");

    step("PRO1 · Second vendeur sans le droit : import refusé, solde insuffisant, recharge simulée, souscription (double clic : un seul débit), crédits promotionnels, badge");
    const secondContext = await browser.newContext({ ...VIEWPORT });
    const second2 = await secondContext.newPage();
    second2.setDefaultTimeout(60_000);
    watch(second2);
    await loginViaUi(second2, "07 88 88 88 01", "/vendeur/offre-pro", (url) => url.pathname === "/vendeur/offre-pro");
    await second2.getByTestId("pro-status").waitFor();
    assert.equal(await second2.getByTestId("pro-status").getAttribute("data-source"), "free");
    assert.match(await second2.getByTestId("pro-status").innerText(), /Vous êtes sur l'offre Gratuit/);
    assert.match(fr(await second2.getByTestId("pro-status").innerText()), /\d+ annonces? en ligne sur 10/);
    await second2.getByTestId("pro-insufficient").waitFor();
    assert.equal(await second2.getByTestId("pro-subscribe").isDisabled(), true, "solde insuffisant : « Passer à l'offre Pro » est inactif");
    assert.match(await second2.getByTestId("pro-insufficient").innerText(), /Solde insuffisant \(0 FCFA\)/);
    assert.equal(await second2.getByTestId("pro-import-link").count(), 0, "pas de lien d'import sans le droit");
    await shot(second2, "34-offre-pro-second-vendeur");
    await second2.goto(`${BASE}/vendeur/annonces/import`);
    await second2.getByTestId("import-text").fill(CSV);
    await second2.getByTestId("import-preview").click();
    await second2.getByTestId("import-error").waitFor();
    assert.match(await second2.getByTestId("import-error").innerText(), /L'import de catalogue est réservé à l'offre Pro\./);
    assert.equal(await second2.getByTestId("import-report").count(), 0, "rien n'est importé sans le droit");
    ok("second vendeur : « Solde insuffisant (0 FCFA) », bouton inactif, aucun lien d'import ; import refusé : « réservé à l'offre Pro »");
    // Recharge de 10 000 FCFA par le paiement simulé.
    await second2.goto(`${BASE}/compte/porte-monnaie?recharger=1`);
    await second2.getByTestId("topup-preset-10000").click();
    await second2.getByTestId("topup-submit").click();
    await second2.waitForURL(/\/paiement-simule\/[0-9a-f-]{36}/);
    await second2.getByTestId("sim-confirm").click();
    await second2.getByTestId("sim-result").waitFor();
    assert.equal(await second2.getByTestId("sim-result").getAttribute("data-kind"), "succeeded");
    await second2.goto(`${BASE}/vendeur/offre-pro`);
    await second2.getByTestId("pro-subscribe").waitFor();
    await second2.waitForFunction(() => document.querySelector('[data-testid="pro-subscribe"]')?.hasAttribute("disabled") === false);
    await second2.getByTestId("pro-subscribe").click();
    await second2.getByTestId("pro-confirmation").waitFor();
    assert.match(fr(await second2.getByTestId("pro-confirmation").innerText()), /Vous allez payer 10 000 FCFA avec vos crédits pour un mois d'offre Pro\. Solde après paiement : 0 FCFA\. Vous recevez 5 000 FCFA de crédits promotionnels pour cette période\./);
    assert.match(await second2.getByTestId("pro-confirmation").innerText(), /Prix provisoires/);
    await shot(second2, "35-offre-pro-confirmation");
    // Double clic : le bouton se désactive, un seul débit.
    await second2.getByTestId("pro-confirm").dblclick();
    await second2.getByTestId("pro-done").waitFor({ timeout: 60_000 });
    assert.match(await second2.getByTestId("pro-done").innerText(), /Votre abonnement est actif/);
    assert.equal(await second2.getByTestId("pro-status").getAttribute("data-source"), "subscription");
    assert.equal(fr(await second2.getByTestId("pro-promo-amount").innerText()), "5 000 FCFA");
    assert.match(await second2.getByTestId("pro-promo-expiry").innerText(), /valables jusqu'au/);
    await second2.getByTestId("pro-import-link").waitFor();
    assert.equal(fr(await second2.getByTestId("pro-balance").innerText()), "0 FCFA", "UN seul débit de 10 000 FCFA");
    await second2.goto(`${BASE}/compte/porte-monnaie`);
    await second2.getByTestId("wallet-balance").waitFor();
    assert.equal(fr(await second2.getByTestId("wallet-balance").innerText()), "0 FCFA");
    assert.equal(fr(await second2.getByTestId("wallet-promo-balance").innerText()), "5 000 FCFA");
    assert.equal(await second2.locator('[data-testid="wallet-row"][data-kind="subscription_charge"]').count(), 1, "une seule ligne d'abonnement : jamais deux débits");
    assert.match(fr(await second2.locator('[data-testid="wallet-row"][data-kind="subscription_charge"]').innerText()), /Abonnement Pro[\s\S]*−10 000 FCFA[\s\S]*\+5 000 FCFA promotionnels/);
    await shot(second2, "36-porte-monnaie-abonnement");
    ok("recharge simulée de 10 000 FCFA, souscription avec confirmation (prix provisoires), double clic : UN débit, 5 000 FCFA de crédits promotionnels avec leur échéance, lien d'import");
    // Le second vendeur peut maintenant importer (aperçu seulement).
    await second2.goto(`${BASE}/vendeur/annonces/import`);
    await second2.getByTestId("import-text").fill("titre,prix\nLampe de bureau,8000");
    await second2.getByTestId("import-preview").click();
    await second2.getByTestId("import-report").waitFor();
    assert.match(fr(await second2.getByTestId("import-summary").innerText()), /1 annonce serait créée et 0 ligne serait refusée\./);
    ok("après la souscription, le droit d'import est ouvert (aperçu)");

    step("PRO1 · Badge « Vendeur Pro » côté acheteur : les deux vendeurs abonnés (le vendeur démo et le second vendeur), aucun autre");
    await buyer.goto(`${BASE}/`);
    await buyer.locator("[data-buyer-demands] a", { hasText: "Galaxy S21" }).first().click();
    await buyer.waitForURL(/\/besoins\/[0-9a-f-]{36}$/);
    await buyer.getByTestId("match-card").first().waitFor();
    // L'administration (étape D2) a suspendu puis réactivé le vendeur démo : ses annonces reviennent dans les résultats dès que le worker a rejoué ses évaluations.
    for (let attempt = 0; attempt < 30 && (await buyer.getByTestId("match-card").count()) < 8; attempt += 1) {
      await sleep(2_000);
      await buyer.reload();
      await buyer.getByTestId("match-card").first().waitFor();
    }
    assert.equal(await buyer.getByTestId("match-card").count(), 8);
    assert.equal(await buyer.getByTestId("pro-badge").count(), 2, "deux annonces de vendeurs Pro parmi les huit : celle du vendeur démo et celle du second vendeur (abonné à l'instant)");
    assert.equal(await buyer.getByTestId("match-card").filter({ hasText: "Sponsorisé" }).getByTestId("pro-badge").count(), 1, "le badge est sur l'annonce du vendeur démo (boostée)");
    assert.equal(await buyer.getByTestId("match-card").filter({ hasNotText: "Sponsorisé" }).getByTestId("pro-badge").count(), 1, "l'autre badge est sur l'annonce du second vendeur, qui était sans badge avant sa souscription");
    await checkClean(buyer, "résultats avec badge Pro");
    await shot(buyer, "37-resultats-badge-pro");
    ok("côté acheteur : 8 annonces Galaxy S21, deux badges « Vendeur Pro » (le vendeur démo et le second vendeur, abonné à l'instant), aucun autre");
    await secondContext.close();

    step("PRO1 · Administration des offres : /admin/offres (abonnés arrondis, revenus du mois, nouvelle version) ; refusée à l'acheteur");
    const proAdmin = adminPage;
    await proAdmin.goto(`${BASE}/admin`);
    await proAdmin.getByTestId("admin-dashboard").waitFor();
    await proAdmin.getByTestId("admin-offers-link").click();
    await proAdmin.waitForURL("**/admin/offres");
    await proAdmin.getByTestId("admin-offers").waitFor();
    assert.match(await proAdmin.getByTestId("admin-offers-provisional").innerText(), /^Prix provisoires/);
    assert.match(fr(await proAdmin.getByTestId("admin-offers-provisional").innerText()), /Les abonnés actuels gardent leur prix|les abonnés actuels gardent leur prix/, "l'administration dit que les abonnés actuels gardent leur prix");
    const subscribersTile = fr(await proAdmin.locator('[data-tile="subscribers"] [data-tile-value]').innerText());
    assert.equal(subscribersTile, "moins de 5", "deux abonnés : arrondis à 5 près, présentés « moins de 5 » (jamais le compte exact, jamais « environ 0 »)");
    assert.equal(fr(await proAdmin.locator('[data-tile="revenue"] [data-tile-value]').innerText()), "20 000 FCFA", "revenus d'abonnement du mois : deux abonnements de 10 000 FCFA");
    assert.equal(await proAdmin.locator('[data-testid="admin-version"]').count(), 2, "une version du plan Gratuit et une du plan Pro");
    const adminText = fr(await proAdmin.getByTestId("admin-offers").innerText());
    assert.match(adminText, /Version 1 · Pro/);
    assert.match(adminText, /10 000 FCFA par mois · crédits promotionnels : 5 000 FCFA par mois · 100 au plus annonces en ligne/);
    await checkClean(proAdmin, "administration des offres");
    await shot(proAdmin, "38-admin-offres");
    // Nouvelle version du plan Pro : s'applique aux renouvellements, pas à la période déjà payée.
    await proAdmin.getByTestId("new-version-plan").selectOption("pro");
    await proAdmin.getByTestId("new-version-name").fill("Pro");
    await proAdmin.getByTestId("new-version-monthlyPriceXof").fill("12000");
    await proAdmin.getByTestId("new-version-promoCreditsXof").fill("6000");
    await proAdmin.getByTestId("new-version-maxOnlineOffers").fill("150");
    await proAdmin.getByTestId("new-version-right-badge_pro").check();
    await proAdmin.getByTestId("new-version-right-catalog_import").check();
    await proAdmin.getByTestId("new-version-submit").click();
    await proAdmin.getByTestId("new-version-message").filter({ hasText: "Nouvelle version créée" }).waitFor();
    await proAdmin.locator('[data-testid="admin-version"][data-version="2"]').waitFor();
    assert.match(fr(await proAdmin.locator('[data-testid="admin-version"][data-version="2"]').innerText()), /12 000 FCFA par mois · crédits promotionnels : 6 000 FCFA par mois · 150 au plus annonces en ligne/);
    assert.match(fr(await proAdmin.locator('[data-testid="admin-version"][data-version="1"]').filter({ hasText: "Version 1 · Pro" }).innerText()), /10 000 FCFA par mois · crédits promotionnels : 5 000 FCFA par mois/, "la version 1 est inchangée");
    assert.equal(await proAdmin.locator('[data-testid="admin-version"] input, [data-testid="admin-version"] button').count(), 0, "une version publiée n'a aucun champ ni bouton de modification");
    await shot(proAdmin, "39-admin-offres-nouvelle-version");
    await vendor.goto(`${BASE}/vendeur/offre-pro`);
    await vendor.getByTestId("pro-status").waitFor();
    assert.match(fr(await vendor.getByTestId("pro-status").innerText()), /Renouvellement automatique : 10 000 FCFA le/, "les abonnés actuels gardent leur prix : la version 2 à 12 000 FCFA ne s'applique qu'aux nouvelles souscriptions");
    assert.equal(/12 000/.test(fr(await vendor.getByTestId("pro-status").innerText())), false, "l'écran de l'abonné n'annonce jamais le prix de la version 2");
    ok("administration : abonnés « moins de 5 » (arrondi à 5 près), revenus du mois 20 000 FCFA, versions en lecture seule, nouvelle version créée (v1 inchangée) ; l'abonné existant garde son prix : renouvellement annoncé à 10 000 FCFA, pas à 12 000");
    // Lot D3 : /admin/offres est sous le gabarit de l'espace d'administration : page 404 STANDARD de Next pour l'acheteur, sans titre ni sélecteur d'espace (donc aucun onglet Admin).
    const offersRefusal = await buyer.goto(`${BASE}/admin/offres`);
    assert.equal(offersRefusal?.status(), 404, "statut HTTP 404 pour un compte ordinaire");
    await buyer.getByText("This page could not be found.").waitFor();
    const offersRefusedText = await buyer.evaluate(() => document.body.innerText);
    assert.equal(/Offres Pro|Prix provisoires|Abonnés|Administration|Page introuvable/.test(offersRefusedText), false, "aucun texte de l'administration des offres sur la page 404");
    assert.equal(await buyer.locator("[data-role-switcher]").count(), 0, "ni sélecteur d'espace ni onglet Admin");
    const planStatuses = await buyer.evaluate(async () => [(await fetch("/api/admin/plans")).status, (await fetch("/api/admin/plans/pro/versions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status]);
    assert.deepEqual(planStatuses, [404, 404], "l'acheteur reçoit le 404 indiscernable sur les routes d'administration des offres");
    ok("/admin/offres refusée à l'acheteur : page 404 standard (statut 404, sans titre ni onglet Admin) et 404 sur les routes d'administration des offres");
    step("RA1 · Recherche active (option payante, prix PROVISOIRE) : carte de la page d'un besoin, achat, annonce d'un autre site notifiée, administration");
    // (Le besoin « iPhone 12 » a été satisfait par la commande confirmée de l'étape D2 : l'option se propose sur un besoin ACTIF, le Galaxy S21.)
    await buyer.goto(`${BASE}/`);
    await buyer.locator("[data-buyer-demands] a", { hasText: "Galaxy S21" }).first().click();
    await buyer.waitForURL(/\/besoins\/[0-9a-f-]{36}$/);
    const raDemandId = /\/besoins\/([0-9a-f-]{36})$/.exec(buyer.url())?.[1] ?? "";
    assert.match(raDemandId, UUID);
    await buyer.getByTestId("active-search-card").waitFor();
    assert.equal(await buyer.getByTestId("active-search-card").getAttribute("data-tone"), "off");
    assert.equal(await buyer.getByTestId("active-search-headline").innerText(), "Recherche active : désactivée");
    const raRules = fr(await buyer.getByTestId("active-search-rules").innerText());
    assert.match(raRules, /Elle se paie avec vos crédits, pas avec vos crédits promotionnels\./);
    assert.match(raRules, /Aucun renouvellement automatique/);
    assert.match(raRules, /Si le besoin est marqué satisfait, l'option est suspendue : rien n'est notifié, mais la période continue de courir, sans prolongation ni remboursement, et elle reprend si vous réactivez le besoin\./);
    assert.match(raRules, /Si le besoin est archivé, l'option s'arrête sans remboursement\./);
    assert.match(raRules, /Aucun remboursement automatique\./);
    assert.match(await buyer.getByTestId("active-search-price-notice").innerText(), /^Prix provisoire/);
    assert.match(fr(await buyer.getByTestId("active-search-benefits").innerText()), /NOUVELLE annonce d'un autre site[\s\S]*jusqu'à toutes les heures au lieu de toutes les 6 heures[\s\S]*180 jours au lieu de 90/);
    assert.equal(fr(await buyer.getByTestId("active-search-buy").innerText()), "Activer — 2 000 FCFA pour 30 jours");
    await checkClean(buyer, "page d'un besoin avec la carte « Recherche active »");
    await shot(buyer, "40-recherche-active-carte");
    ok("carte « Recherche active » : désactivée, ce que l'option apporte, règles dites AVANT l'achat (crédits payés, aucun renouvellement, suspension si satisfait, arrêt sans remboursement si archivé), « Prix provisoire »");
    // Achat : confirmation (montant, fin, solde après) puis double clic : UN seul débit.
    await buyer.getByTestId("active-search-buy").click();
    await buyer.getByTestId("active-search-confirmation").waitFor();
    assert.match(fr(await buyer.getByTestId("active-search-confirmation").innerText()), /Activer la recherche active : 2 000 FCFA seront débités de vos crédits payés, jusqu'au \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}\. Il vous restera 8 000 FCFA\./);
    await shot(buyer, "41-recherche-active-confirmation");
    await buyer.getByTestId("active-search-confirm").dblclick();
    await buyer.getByTestId("active-search-done").waitFor({ timeout: 60_000 });
    assert.match(await buyer.getByTestId("active-search-done").innerText(), /^Recherche active activée jusqu'au \d{2}\/\d{2}\/\d{4}\.$/);
    assert.equal(await buyer.getByTestId("active-search-card").getAttribute("data-active"), "true");
    assert.match(fr(await buyer.getByTestId("active-search-buy").innerText()), /^Prolonger de 30 jours — 2 000 FCFA$/);
    await buyer.goto(`${BASE}/compte/porte-monnaie`);
    await buyer.getByTestId("wallet-balance").waitFor();
    assert.equal(fr(await buyer.getByTestId("wallet-balance").innerText()), "8 000 FCFA", "UN seul débit de 2 000 FCFA sur 10 000");
    assert.equal(await buyer.locator('[data-testid="wallet-row"][data-kind="search_purchase"]').count(), 1, "une seule ligne d'achat : jamais deux débits");
    assert.match(fr(await buyer.locator('[data-testid="wallet-row"][data-kind="search_purchase"]').innerText()), /Recherche active[\s\S]*−2 000 FCFA/);
    await shot(buyer, "42-porte-monnaie-recherche-active");
    ok("achat confirmé (montant, fin, solde après), double clic : UN débit de 2 000 FCFA en crédits payés, option en vigueur, « Prolonger de 30 jours »");
    // Le suivi du besoin est maintenant prolongeable jusqu'à 180 jours.
    const raTracking = await buyer.evaluate(async (id) => (await (await fetch(`/api/demands/${id}/tracking`)).json()) as { tracking: { maxUntil: string; readAt: string } }, raDemandId);
    const raDays = Math.round((Date.parse(raTracking.tracking.maxUntil) - Date.parse(raTracking.tracking.readAt)) / 86_400_000);
    assert.equal(raDays, 180, "plafond du suivi de 180 jours pendant l'option");
    ok("suivi du besoin prolongeable jusqu'à 180 jours pendant l'option");
    // Une annonce fictive d'un autre site apparaît : le VRAI service la collecte et notifie.
    const simulated = await activeSearchSimulateByAdministration(raDemandId);
    assert.match(simulated, /1 notification\(s\) d'annonce d'un autre site créée\(s\)/);
    await buyer.goto(`${BASE}/notifications`);
    await buyer.getByTestId("notifications-heading").waitFor();
    const externalRow = buyer.locator('[data-testid="notification-row"][data-kind="new_external_match"]');
    await externalRow.first().waitFor();
    assert.equal(await externalRow.count(), 1, "une seule notification d'annonce d'un autre site");
    assert.equal(await externalRow.getByTestId("notification-badge").innerText(), "Autre site");
    assert.match(fr(await externalRow.innerText()), /Voir mon besoin/);
    assert.match(fr(await externalRow.innerText()), /Annonces Démo A, autre site/);
    assert.equal(await externalRow.locator("a").getAttribute("href"), `/besoins/${raDemandId}`, "le lien mène à la page du besoin, jamais au site de l'annonce");
    assert.equal((await buyer.content()).includes("annonces-demo-a.example"), false, "aucune adresse d'un autre site dans la page");
    await checkClean(buyer, "notifications avec une annonce d'un autre site");
    await shot(buyer, "43-notification-autre-site");
    await buyer.goto(`${BASE}/`);
    await buyer.locator("[data-unread-summary]").waitFor();
    await buyer.getByText(/^Autre site : /).first().waitFor();
    assert.match(fr(await buyer.locator("body").innerText()), /Autre site : /);
    await shot(buyer, "44-accueil-autre-site");
    ok("`active-search:simulate` : UNE notification « Autre site » (pastille, source, lien vers le besoin, aucune adresse externe) dans /notifications et sur l'accueil");
    // Lot RA1-bis : un besoin marqué SATISFAIT suspend l'option (la carte le dit, sans bouton d'achat) ; réactivé, l'option reprend telle quelle.
    const raTransition = (action: "satisfy" | "activate") => buyer.evaluate(async ({ id, action: verb }) => {
      const read = (await (await fetch(`/api/demands/${id}`)).json()) as { demand: { contentVersion: number } };
      const response = await fetch(`/api/demands/${id}/${verb}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedContentVersion: read.demand.contentVersion }) });
      return response.status;
    }, { id: raDemandId, action });
    assert.equal(await raTransition("satisfy"), 200);
    await buyer.goto(`${BASE}/besoins/${raDemandId}`);
    await buyer.getByTestId("active-search-card").waitFor();
    assert.equal(await buyer.getByTestId("active-search-card").getAttribute("data-tone"), "paused");
    assert.match(await buyer.getByTestId("active-search-headline").innerText(), /^Recherche active suspendue jusqu'au \d{2}\/\d{2}\/\d{4}$/);
    assert.match(fr(await buyer.getByTestId("active-search-detail").innerText()), /marqué satisfait : rien n'est notifié tant qu'il ne redevient pas actif\. La période continue de courir/);
    assert.equal(await buyer.getByTestId("active-search-buy").count(), 0, "aucun achat pendant la suspension");
    await shot(buyer, "46-recherche-active-suspendue");
    assert.equal(await raTransition("activate"), 200);
    await buyer.goto(`${BASE}/besoins/${raDemandId}`);
    await buyer.getByTestId("active-search-card").waitFor();
    assert.equal(await buyer.getByTestId("active-search-card").getAttribute("data-tone"), "active");
    assert.equal(await buyer.getByTestId("active-search-card").getAttribute("data-active"), "true");
    assert.match(fr(await buyer.getByTestId("active-search-buy").innerText()), /^Prolonger de 30 jours — 2 000 FCFA$/);
    ok("besoin satisfait : option SUSPENDUE (carte « suspendue jusqu'au », aucun achat) ; réactivé : l'option reprend, « Prolonger de 30 jours » (aucun remboursement, aucun nouveau débit)");
    // 404 indiscernable pour autrui ; page 404 standard et 404 JSON pour l'acheteur sur l'administration.
    const foreign = await vendor.evaluate(async (id) => {
      const known = await fetch(`/api/demands/${id}/active-search`);
      const unknown = await fetch("/api/demands/00000000-0000-4000-8000-000000000001/active-search");
      return { known: [known.status, await known.text()], unknown: [unknown.status, await unknown.text()] };
    }, raDemandId);
    assert.deepEqual(foreign.known, foreign.unknown, "le besoin d'un autre acheteur est indiscernable d'un besoin inconnu");
    assert.equal(foreign.known[0], 404);
    const adminRefused = await buyer.goto(`${BASE}/admin/recherche-active`);
    assert.equal(adminRefused?.status(), 404, "statut HTTP 404 pour un compte ordinaire");
    await buyer.getByText("This page could not be found.").waitFor();
    assert.equal(/Recherche active|Options en vigueur|Revenus du mois/.test(await buyer.evaluate(() => document.body.innerText)), false, "aucun texte de l'administration sur la page 404");
    assert.equal(await buyer.evaluate(async () => (await fetch("/api/admin/active-search")).status), 404);
    ok("autrui : 404 indiscernable d'un besoin inconnu ; /admin/recherche-active refusée à l'acheteur (page 404 standard, route 404)");
    // Intégration avec les missions (lots MV1 et RA1) : le besoin PORTEUR d'une mission n'est pas un besoin de l'acheteur (il le voit dans « Mes missions »). L'option ne s'y lit ni ne s'y achète :
    // MÊME 404 qu'un besoin inconnu, en lecture comme en achat (rien n'est débité), et la carte « Recherche active » n'est pas affichée sur sa page.
    // (Aucune fonction nommée dans le corps : le code est sérialisé vers le navigateur, où l'aide `__name` de l'outil de compilation n'existe pas.)
    const carrierProbe = await buyer.evaluate(async () => {
      const list = (await (await fetch("/api/missions")).json()) as { missions: Array<{ demandId: string | null }> };
      const carrierId = list.missions.find((entry) => entry.demandId !== null)?.demandId ?? "";
      const results: Array<[number, string]> = [];
      for (const id of [carrierId, "00000000-0000-4000-8000-000000000001"]) {
        const response = await fetch(`/api/demands/${id}/active-search`);
        results.push([response.status, await response.text()]);
      }
      for (const id of [carrierId, "00000000-0000-4000-8000-000000000001"]) {
        const response = await fetch(`/api/demands/${id}/active-search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), expectedPriceXof: 2000 }) });
        results.push([response.status, await response.text()]);
      }
      return { carrierId, get: [results[0], results[1]], post: [results[2], results[3]] };
    });
    assert.match(carrierProbe.carrierId, UUID, "le besoin porteur d'une mission de l'acheteur");
    assert.equal(carrierProbe.get[0][0], 404);
    assert.deepEqual(carrierProbe.get[0], carrierProbe.get[1], "lecture : le besoin porteur est indiscernable d'un besoin inconnu");
    assert.equal(carrierProbe.post[0][0], 404);
    assert.deepEqual(carrierProbe.post[0], carrierProbe.post[1], "achat : le besoin porteur est indiscernable d'un besoin inconnu");
    await buyer.goto(`${BASE}/besoins/${carrierProbe.carrierId}`);
    await buyer.locator("main, [data-testid], h1").first().waitFor();
    await sleep(2_500);
    assert.equal(await buyer.getByTestId("active-search-card").count(), 0, "aucune carte « Recherche active » sur le besoin porteur d'une mission");
    assert.equal(await buyer.getByTestId("active-search-error").count(), 0, "ni message d'erreur ni « Réessayer »");
    ok("besoin PORTEUR d'une mission : GET et POST de l'option répondent le MÊME 404 qu'un besoin inconnu (aucun débit), la carte « Recherche active » n'est pas affichée sur sa page");
    // Administration : options en vigueur arrondies à 5 près, revenus du mois.
    await adminPage.goto(`${BASE}/admin`);
    await adminPage.getByTestId("admin-active-search-link").click();
    await adminPage.waitForURL("**/admin/recherche-active");
    await adminPage.getByTestId("admin-active-search").waitFor();
    assert.match(await adminPage.getByTestId("admin-active-search-provisional").innerText(), /Prix provisoire : 2 000 FCFA pour 30 jours/);
    assert.equal(fr(await adminPage.locator('[data-tile="active"] [data-tile-value]').innerText()), "moins de 5", "une option en vigueur : arrondi à 5 près, jamais le compte exact");
    assert.equal(fr(await adminPage.locator('[data-tile="revenue"] [data-tile-value]').innerText()), "2 000 FCFA", "revenus du mois lus dans le grand livre");
    await checkClean(adminPage, "administration de la recherche active");
    await shot(adminPage, "45-admin-recherche-active");
    ok("administration : options en vigueur « moins de 5 » (arrondi à 5 près), revenus du mois 2 000 FCFA, prix provisoire annoncé");

    await adminContext.close();
    const checkOutput = await walletCheckByAdministration();
    assert.match(checkOutput, /aucun écart/);
    ok("wallet:check : aucun écart après les abonnements, les crédits promotionnels, le boost, l'import et la recherche active");

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
