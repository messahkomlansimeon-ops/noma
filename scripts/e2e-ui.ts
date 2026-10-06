/**
 * `npm run e2e:ui` : parcours dans un VRAI navigateur (Chrome piloté par Playwright, installé dans poc/) contre un vrai
 * serveur Next, À TRAVERS LE RELAIS DE DÉVELOPPEMENT (scripts/dev-proxy.ts) : le navigateur n'envoie aucun en-tête du proxy
 * de confiance (aucune interception de route), c'est le relais qui les écrit. NON inclus dans `npm test`.
 *
 * Partie 1 : garde de session (redirection vers /connexion?next=…), connexion par OTP avec le code lu dans la sortie du serveur,
 * annonces du vendeur (création, publication, pause, remise en ligne, archivage), besoins de l'acheteur (création, activation,
 * satisfait, réactivation), liens vers les nouveaux écrans, déconnexion.
 *
 * Partie 2 (lot E1b) : le même produit proposé par un vendeur concurrent C (22 offres créées par l'API) et par le vendeur A
 * (créée dans le navigateur, la plus chère) ; l'acheteur B (autre contexte de navigateur) voit les résultats de son besoin avec
 * leurs indicateurs (20 par page, puis « Voir plus » par curseur : 23 offres sans doublon), puis, après un boost
 * d'administration (`boost:grant`, aucun paiement), le badge « Sponsorisé » ; A voit les
 * « Acheteurs intéressés » (sans aucune identité) et le devis de boost (montant, facteurs, compte à rebours, bouton « Acheter »
 * désactivé, « Paiement bientôt disponible »), puis le motif « déjà boostée ». Captures d'écran dans NOMA_E2E_SHOTS.
 *
 * Variables : NOMA_E2E_BASE_URL (relais, défaut http://localhost:3212), NOMA_E2E_SERVER_LOG, NOMA_E2E_DATABASE_URL (noma_e2e,
 * pour boost:grant), NOMA_E2E_SHOTS (défaut /tmp/noma-e1b-shots), NOMA_E2E_CHROME (défaut /usr/bin/google-chrome-stable),
 * NOMA_E2E_WORKER_TIMEOUT_MS (défaut 180000). Voir scripts/e2e-common.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { buildOfferInput } from "../lib/client/catalog-view";
import {
  E2E_BASE,
  E2E_SERVER_LOG,
  RelaySession,
  awaitOtpLine,
  grantBoostByAdministration,
  loginWithOtp,
  uniquePhone,
} from "./e2e-common";

// Playwright n'est installé que dans poc/ : aucune dépendance ajoutée au projet principal.
const require = createRequire(import.meta.url);
const { chromium } = require("../poc/node_modules/playwright") as typeof import("../poc/node_modules/playwright");
type Page = import("../poc/node_modules/playwright").Page;
type BrowserContext = import("../poc/node_modules/playwright").BrowserContext;

const BASE = E2E_BASE;
const SHOTS = process.env.NOMA_E2E_SHOTS ?? "/tmp/noma-e1b-shots";
const CHROME = process.env.NOMA_E2E_CHROME ?? "/usr/bin/google-chrome-stable";
const WORKER_TIMEOUT_MS = Number(process.env.NOMA_E2E_WORKER_TIMEOUT_MS ?? "180000");
/** Offres du vendeur concurrent C : 22, plus celle de A = 23 résultats (la page en montre 20, « Voir plus » charge les 3 autres). */
const RIVAL_OFFERS = 22;
const VIEWPORT = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } as const;

if (!E2E_SERVER_LOG) {
  console.error("e2e:ui : NOMA_E2E_SERVER_LOG est requis.");
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

let checks = 0;
const ok = (label: string) => {
  checks += 1;
  console.log(`  ✓ ${label}`);
};
const info = (label: string) => console.log(`    · ${label}`);
const step = (title: string) => console.log(`→ ${title}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pageErrors: string[] = [];
const consoleErrors: string[] = [];

/** Surveille les exceptions de page et les erreurs de console d'une page (hors 401/403 attendus). */
function watch(page: Page): void {
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of 40[13]/.test(message.text())) consoleErrors.push(message.text());
  });
}

/** Saisit un numéro, lit le code dans la sortie du serveur, le saisit et attend la page de destination. */
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

const localPhone = (offset: number) => `0700${String((Date.now() + offset) % 1_000_000).padStart(6, "0")}`;

/** Appuie sur « Actualiser » jusqu'à ce que la condition soit vraie (le worker de matching travaille en arrière-plan). */
async function refreshUntil(page: Page, label: string, condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WORKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await condition()) return;
    const button = page.getByRole("button", { name: "Actualiser" }).first();
    if (await button.isEnabled()) await button.click();
    await sleep(2_000);
  }
  throw new Error(`${label} : délai de ${WORKER_TIMEOUT_MS} ms dépassé`);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ executablePath: CHROME });
  const context = await browser.newContext({ ...VIEWPORT });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  watch(page);
  const sessionRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/auth/session")) sessionRequests.push(request.url());
  });

  const shot = (target: Page, name: string) => target.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const api = (ctx: BrowserContext, path: string) => ctx.request.get(`${BASE}${path}`);
  const openPages: Page[] = [page];

  try {
    step("Sans session : les pages branchées redirigent vers /connexion?next=…");
    const guarded = [
      "/vendeur/annonces",
      "/vendeur/annonces/nouvelle",
      "/vendeur/annonces/6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c",
      "/alertes",
      "/alerte/nouvelle",
      "/besoins/6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c",
    ];
    for (const path of guarded) {
      await page.goto(`${BASE}${path}`);
      await page.waitForURL(`**/connexion?next=${encodeURIComponent(path)}`);
      ok(`${path} → /connexion?next=${encodeURIComponent(path)}`);
    }

    step("next hostile : une URL absolue ou « // » n'est jamais suivie");
    const phone = localPhone(0);
    await page.goto(`${BASE}/connexion?next=${encodeURIComponent("https://evil.example/x")}`);
    await page.getByPlaceholder("07 00 00 00 42").fill(phone);
    const offset = statSync(E2E_SERVER_LOG).size;
    await page.getByRole("button", { name: /Recevoir un code/ }).click();
    await page.waitForURL("**/verification");
    ok("demande de code acceptée À TRAVERS LE RELAIS (aucun en-tête de proxy envoyé par le navigateur), page /verification");
    await page.getByText(/Code envoyé au \+225/).waitFor();
    const shownHint = (await page.getByText(/Code envoyé au \+225/).textContent()) ?? "";
    assert.equal(shownHint.includes(phone.slice(2, 8)), false, "les chiffres du milieu ne sont pas affichés");
    ok("le numéro est masqué à l'écran");

    step("Code incorrect puis code correct (saisie au clavier et au pavé)");
    const { code } = await awaitOtpLine(offset);
    await page.getByLabel(/Code reçu par SMS/).fill(code === "000000" ? "000001" : "000000");
    await page.getByRole("button", { name: "Vérifier", exact: true }).click();
    await page.getByText(/Code incorrect ou expiré/).waitFor();
    ok("mauvais code : message fixe « Code incorrect ou expiré… »");
    for (const digit of code) await page.getByRole("button", { name: digit, exact: true }).click();
    await shot(page, "01-verification-code-saisi");
    await page.getByRole("button", { name: "Vérifier", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 60_000 });
    ok("code correct : redirection vers l'accueil (le next hostile https://evil.example a été ignoré)");
    const session = await api(context, "/api/auth/session");
    assert.equal(session.status(), 200);
    ok("GET /api/auth/session : 200 dans le navigateur");

    step("Annonces du vendeur : liste réelle et actions");
    sessionRequests.length = 0;
    await page.goto(`${BASE}/vendeur/annonces`);
    await page.getByText("Vous n'avez pas encore d'annonce.").waitFor();
    ok("liste réelle vide pour un nouveau compte");
    assert.ok(sessionRequests.length >= 1 && sessionRequests.length <= 3, `requêtes de session : ${sessionRequests.length}`);
    ok(`la garde interroge la session ${sessionRequests.length} fois (≤ 3 : React Strict Mode en développement), sans boucle`);

    await page.getByRole("button", { name: "Nouvelle annonce" }).last().click();
    const sheet = page.getByRole("dialog");
    await sheet.getByPlaceholder("iPhone 12 · 128 Go").fill("iPhone 12 · 128 Go");
    await sheet.getByRole("button", { name: "Téléphones", exact: true }).click();
    await sheet.getByPlaceholder("Apple", { exact: true }).fill("Apple");
    await sheet.getByPlaceholder("iPhone 12", { exact: true }).fill("iPhone 12");
    await sheet.getByPlaceholder("150 000").fill("150 000");
    await sheet.getByPlaceholder("Marcory, Abidjan").fill("Abidjan");
    await shot(page, "02-annonce-formulaire");
    await sheet.getByRole("button", { name: "Publier l'annonce" }).click();
    await page.getByText("Annonce publiée").waitFor();
    const card = page.locator("div.rounded-2xl", { hasText: "iPhone 12 · 128 Go" }).first();
    await card.getByText("En ligne", { exact: true }).waitFor();
    await card.getByText(/150\s000 FCFA/).waitFor();
    ok("annonce créée puis publiée : badge « En ligne », prix 150 000 FCFA");

    await page.getByRole("button", { name: "Nouvelle annonce" }).last().click();
    await page.getByRole("dialog").getByPlaceholder("iPhone 12 · 128 Go").fill("Galaxy A54 brouillon");
    await page.getByRole("dialog").getByRole("button", { name: "Enregistrer en brouillon" }).click();
    const draft = page.locator("div.rounded-2xl", { hasText: "Galaxy A54 brouillon" }).first();
    await draft.getByText("Brouillon", { exact: true }).waitFor();
    ok("brouillon enregistré : badge « Brouillon », prix « à compléter »");

    await card.getByRole("button", { name: "Mettre en pause" }).click();
    await card.getByText("En pause", { exact: true }).waitFor();
    ok("« Mettre en pause » : badge « En pause » (version de contenu transmise)");
    await card.getByRole("button", { name: "Remettre en ligne" }).click();
    await card.getByText("En ligne", { exact: true }).waitFor();
    ok("« Remettre en ligne » : badge « En ligne »");

    await draft.getByRole("button", { name: "Archiver" }).click();
    await draft.getByRole("button", { name: "Confirmer l'archivage" }).click();
    await page.getByText("Annonce archivée").waitFor();
    await page.getByRole("button", { name: /Archivées · 1/ }).waitFor();
    ok("archivage en deux appuis : l'annonce passe sous « Archivées · 1 »");
    await shot(page, "03-annonces-liste");

    await page.reload();
    await page.locator("div.rounded-2xl", { hasText: "iPhone 12 · 128 Go" }).first().getByText("En ligne", { exact: true }).waitFor();
    ok("après rechargement, l'état vient du serveur (iPhone 12 en ligne)");
    const offers = (await (await api(context, "/api/offers")).json()) as { offers: { status: string; rawText: string }[] };
    assert.deepEqual(offers.offers.map((offer) => offer.status).sort(), ["archived", "published"]);
    ok("GET /api/offers confirme : 1 publiée, 1 archivée");

    step("Lien « Acheteurs intéressés et boost » depuis « Mes annonces »");
    await page
      .locator("div.rounded-2xl", { hasText: "iPhone 12 · 128 Go" })
      .first()
      .getByRole("link", { name: /Acheteurs intéressés et boost/ })
      .click();
    await page.waitForURL(/\/vendeur\/annonces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await page.getByRole("heading", { name: "Acheteurs intéressés" }).waitFor();
    await page.getByRole("heading", { name: "Booster cette annonce" }).waitFor();
    ok("la page de l'annonce s'ouvre : sections « Acheteurs intéressés » et « Booster cette annonce »");
    await page.goto(`${BASE}/vendeur/annonces`);
    await page.locator("div.rounded-2xl", { hasText: "iPhone 12 · 128 Go" }).first().getByRole("button", { name: "Mettre en pause" }).click();
    await page.locator("div.rounded-2xl", { hasText: "iPhone 12 · 128 Go" }).first().getByText("En pause", { exact: true }).waitFor();
    await page.locator("div.rounded-2xl", { hasText: "iPhone 12 · 128 Go" }).first().getByRole("link", { name: /Acheteurs intéressés et boost/ }).click();
    await page.getByTestId("boost-not-eligible").waitFor();
    assert.match((await page.getByTestId("boost-not-eligible").textContent()) ?? "", /Le devis n'est proposé que pour une annonce en ligne/);
    assert.equal(await page.getByRole("group", { name: "Durée du boost" }).count(), 0, "aucun choix de durée pour une annonce en pause");
    ok("annonce en pause : « Le devis n'est proposé que pour une annonce en ligne. », aucun choix de durée, aucune demande de devis");
    await page.getByText(/Cette annonce est en pause/).waitFor();
    ok("annonce en pause : « Acheteurs intéressés » dit qu'il faut la remettre en ligne (le serveur ne sert rien pour une annonce hors ligne)");
    await shot(page, "04-annonce-en-pause-devis-refuse");
    await page.goto(`${BASE}/vendeur/annonces`);
    await page.locator("div.rounded-2xl", { hasText: "iPhone 12 · 128 Go" }).first().getByRole("button", { name: "Remettre en ligne" }).click();
    await page.locator("div.rounded-2xl", { hasText: "iPhone 12 · 128 Go" }).first().getByText("En ligne", { exact: true }).waitFor();

    step("Besoins de l'acheteur : création, activation, satisfait, réactivation");
    await page.goto(`${BASE}/alertes`);
    await page.getByText("Vous n'avez pas encore de besoin.").waitFor();
    await page.getByRole("link", { name: /Nouveau besoin/ }).click();
    await page.waitForURL("**/alerte/nouvelle");
    await page.getByPlaceholder(/Un iPhone 12 en bon état/).fill("Je cherche un iPhone 12 en bon état");
    await page.getByRole("button", { name: "Téléphones", exact: true }).click();
    await page.getByPlaceholder("Apple", { exact: true }).fill("Apple");
    await page.getByPlaceholder("iPhone 12", { exact: true }).fill("iPhone 12");
    await page.getByPlaceholder("200 000").fill("200 000");
    await shot(page, "05-besoin-formulaire");
    await page.getByRole("button", { name: "Activer le besoin" }).click();
    await page.waitForURL("**/alertes");
    const need = page.locator("div.rounded-2xl", { hasText: "Je cherche un iPhone 12" }).first();
    await need.getByText("Active", { exact: true }).waitFor();
    await need.getByText(/200\s000 FCFA max/).waitFor();
    ok("besoin créé puis activé : badge « Active », budget 200 000 FCFA max");
    await need.getByRole("button", { name: "Marquer satisfait" }).click();
    await need.getByText("Satisfait", { exact: true }).waitFor();
    await need.getByRole("link", { name: "Détails", exact: true }).click();
    await page.waitForURL(/\/besoins\/[0-9a-f-]{36}$/);
    await page.getByText(/Ce besoin est marqué satisfait/).waitFor();
    ok("besoin satisfait : la page de résultats dit de le réactiver (aucun appel de correspondances pour un besoin non actif)");
    await page.goBack();
    await page.waitForURL("**/alertes");
    await page.locator("div.rounded-2xl", { hasText: "Je cherche un iPhone 12" }).first().getByRole("button", { name: "Réactiver" }).click();
    await page.locator("div.rounded-2xl", { hasText: "Je cherche un iPhone 12" }).first().getByText("Active", { exact: true }).waitFor();
    ok("« Marquer satisfait » puis « Réactiver » : « Satisfait » puis « Active »");
    await shot(page, "06-besoins-liste");
    await page.locator("div.rounded-2xl", { hasText: "Je cherche un iPhone 12" }).first().getByRole("link", { name: "Voir les offres", exact: true }).click();
    await page.waitForURL(/\/besoins\/[0-9a-f-]{36}$/);
    await page.getByRole("heading", { name: /Offres correspondantes|offre/ }).waitFor();
    ok("« Voir les offres » ouvre la page de résultats du besoin");
    await shot(page, "07-besoin-resultats-compte-seul");

    step("Déconnexion réelle");
    await page.goto(`${BASE}/compte`);
    await page.getByRole("button", { name: "Se déconnecter" }).click();
    await page.waitForURL("**/connexion");
    ok("« Se déconnecter » : retour à /connexion");
    assert.equal((await api(context, "/api/auth/session")).status(), 401);
    ok("GET /api/auth/session après déconnexion : 401");
    await page.goto(`${BASE}/vendeur/annonces`);
    await page.waitForURL(`**/connexion?next=${encodeURIComponent("/vendeur/annonces")}`);
    ok("/vendeur/annonces redirige de nouveau vers /connexion?next=…");

    step("Retour vers la page demandée après connexion (next interne honoré)");
    const secondPhone = localPhone(7);
    await page.getByPlaceholder("07 00 00 00 42").fill(secondPhone);
    const secondOffset = statSync(E2E_SERVER_LOG).size;
    await page.getByRole("button", { name: /Recevoir un code/ }).click();
    await page.waitForURL("**/verification");
    await page.getByLabel(/Code reçu par SMS/).fill((await awaitOtpLine(secondOffset)).code);
    await page.getByRole("button", { name: "Vérifier", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/vendeur/annonces", { timeout: 60_000 });
    await page.getByText("Vous n'avez pas encore d'annonce.").waitFor();
    ok("connexion depuis /connexion?next=%2Fvendeur%2Fannonces : retour sur /vendeur/annonces (compte vide)");
    await context.close();

    // ─────────────────────────── Partie 2 : correspondances, « Sponsorisé », devis de boost ───────────────────────────
    const tag = Date.now().toString(36).slice(-5);
    const product = { category: "Téléphones", brand: "Samsung", model: `Galaxy S21 ${tag}` };
    const offerTitle = `Samsung Galaxy S21 ${tag} · offre de A`;

    step(`Vendeur concurrent C (par l'API, à travers le relais) : ${RIVAL_OFFERS} offres « ${product.brand} ${product.model} » de 100 000 à 163 000 FCFA`);
    const rival = new RelaySession("vendeur concurrent C");
    const rivalApi = rival.client();
    await loginWithOtp(rival, uniquePhone("53"));
    for (let index = 0; index < RIVAL_OFFERS; index += 1) {
      const built = buildOfferInput({
        title: `${product.brand} ${product.model} · offre ${index + 1}`,
        description: "",
        category: product.category,
        brand: product.brand,
        model: product.model,
        variant: "",
        condition: "Occasion",
        location: "Abidjan",
        price: String(100_000 + index * 3_000),
        available: true,
      });
      assert.ok(built.ok);
      const created = await rivalApi.offers.create(built.input);
      await rivalApi.offers.publish(created.id, created.contentVersion);
    }
    ok(`${RIVAL_OFFERS} offres publiées par C`);

    step("Vendeur A (navigateur) : publie l'offre la plus chère, puis regarde la page de son annonce");
    const sellerContext = await browser.newContext({ ...VIEWPORT });
    const sellerPage = await sellerContext.newPage();
    sellerPage.setDefaultTimeout(60_000);
    watch(sellerPage);
    openPages.push(sellerPage);
    await loginViaUi(sellerPage, localPhone(101), "/vendeur/annonces", (url) => url.pathname === "/vendeur/annonces");
    await sellerPage.getByText("Vous n'avez pas encore d'annonce.").waitFor();
    await sellerPage.getByRole("button", { name: "Nouvelle annonce" }).last().click();
    const form = sellerPage.getByRole("dialog");
    await form.getByPlaceholder("iPhone 12 · 128 Go").fill(offerTitle);
    await form.getByRole("button", { name: "Téléphones", exact: true }).click();
    await form.getByPlaceholder("Apple", { exact: true }).fill(product.brand);
    await form.getByPlaceholder("iPhone 12", { exact: true }).fill(product.model);
    await form.getByPlaceholder("150 000").fill("190 000");
    await form.getByPlaceholder("Marcory, Abidjan").fill("Abidjan");
    await form.getByRole("button", { name: "Publier l'annonce" }).click();
    await sellerPage.getByText("Annonce publiée").waitFor();
    const sellerCard = sellerPage.locator("div.rounded-2xl", { hasText: offerTitle }).first();
    await sellerCard.getByText("En ligne", { exact: true }).waitFor();
    ok(`offre de A publiée à 190 000 FCFA (plus chère que les ${RIVAL_OFFERS} offres de C)`);
    await sellerCard.getByRole("link", { name: /Acheteurs intéressés et boost/ }).click();
    await sellerPage.waitForURL(/\/vendeur\/annonces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const offerId = sellerPage.url().split("/").pop() as string;
    await sellerPage.getByTestId("interested-count").waitFor();
    assert.equal((await sellerPage.getByTestId("interested-count").textContent())?.trim(), "Aucun besoin d'acheteur ne correspond pour le moment");
    ok("« Acheteurs intéressés » : « Aucun besoin d'acheteur ne correspond pour le moment » (aucun besoin ne correspond encore)");
    const durations = sellerPage.getByRole("group", { name: "Durée du boost" });
    for (const label of ["24 h", "3 jours", "7 jours"]) await durations.getByRole("button", { name: label, exact: true }).waitFor();
    ok("choix de durée : 24 h, 3 jours, 7 jours");
    await durations.getByRole("button", { name: "24 h", exact: true }).click();
    await sellerPage.getByTestId("boost-unavailable").waitFor();
    const noBuyer = (await sellerPage.getByTestId("boost-unavailable").textContent()) ?? "";
    assert.equal(noBuyer.trim(), "Aucun acheteur compatible pour le moment : un boost ne serait pas utile.");
    assert.equal(noBuyer.includes("no_compatible_buyer"), false);
    // Premier devis (indisponible : valable 60 s) : la première valeur affichée ne dépasse jamais 1 min 0 s, même si la page est ouverte depuis un moment.
    const firstValidity = ((await sellerPage.getByTestId("boost-validity").textContent()) ?? "").trim();
    const firstMatch = /^Résultat valable encore (?:(\d+) min )?(\d+) s$/.exec(firstValidity);
    assert.ok(firstMatch, `texte de validité : « ${firstValidity} »`);
    assert.ok(Number(firstMatch[1] ?? 0) * 60 + Number(firstMatch[2]) <= 60, `première valeur du compte à rebours : « ${firstValidity} » (attendu ≤ 1 min 0 s)`);
    assert.equal(await sellerPage.getByRole("button", { name: "Acheter" }).count(), 0, "aucun bouton d'achat pour un devis indisponible");
    ok("devis indisponible : motif en clair « Aucun acheteur compatible pour le moment… » (jamais le code brut)");
    await shot(sellerPage, "08-annonce-devis-indisponible-aucun-acheteur");

    step("Acheteur B (autre contexte de navigateur) : active un besoin pour ce produit et ouvre ses résultats");
    const buyerContext = await browser.newContext({ ...VIEWPORT });
    const buyerPage = await buyerContext.newPage();
    buyerPage.setDefaultTimeout(60_000);
    watch(buyerPage);
    openPages.push(buyerPage);
    const buyerLocalPhone = localPhone(202);
    await loginViaUi(buyerPage, buyerLocalPhone, "/alerte/nouvelle", (url) => url.pathname === "/alerte/nouvelle");
    await buyerPage.getByPlaceholder(/Un iPhone 12 en bon état/).fill(`Je cherche un ${product.brand} ${product.model}`);
    await buyerPage.getByRole("button", { name: "Téléphones", exact: true }).click();
    await buyerPage.getByPlaceholder("Apple", { exact: true }).fill(product.brand);
    await buyerPage.getByPlaceholder("iPhone 12", { exact: true }).fill(product.model);
    await buyerPage.getByPlaceholder("200 000").fill("250 000");
    await buyerPage.getByRole("button", { name: "Activer le besoin" }).click();
    await buyerPage.waitForURL("**/alertes");
    const buyerNeed = buyerPage.locator("div.rounded-2xl", { hasText: `Je cherche un ${product.brand} ${product.model}` }).first();
    await buyerNeed.getByText("Active", { exact: true }).waitFor();
    await buyerNeed.getByRole("link", { name: "Voir les offres", exact: true }).click();
    await buyerPage.waitForURL(/\/besoins\/[0-9a-f-]{36}$/);
    ok("B : besoin activé, « Voir les offres » ouvre la page de résultats");
    // Le worker de matching travaille en arrière-plan : « Recherche en cours… » puis les résultats (bouton Actualiser).
    const cards = buyerPage.getByTestId("match-card");
    const total = RIVAL_OFFERS + 1;
    let sawProcessing = false;
    let sawMore = false;
    let checkedBusy = false;
    // Seule la page 2 (curseur) est retardée : on peut ainsi voir l'état « chargement » de « Voir plus » (aucune en-tête ajoutée).
    await buyerPage.route(/\/stored-matches\?.*cursor=/, async (route) => {
      await sleep(1_500);
      await route.continue();
    });
    await refreshUntil(buyerPage, `les ${total} offres dans les résultats de B`, async () => {
      if ((await buyerPage.getByText("Recherche en cours…").count()) > 0) sawProcessing = true;
      const count = await cards.count();
      if (count < 20) return false;
      // Première page pleine (20) : « Voir plus » suit le curseur du serveur et ajoute les offres suivantes.
      const more = buyerPage.getByRole("button", { name: "Voir plus" });
      if ((await more.count()) > 0) {
        sawMore = true;
        await more.click();
        if (!checkedBusy) {
          checkedBusy = true;
          // Pendant « Voir plus », « Actualiser » et le bouton lui-même sont désactivés (pas de course entre les deux).
          assert.equal(await buyerPage.getByRole("button", { name: "Actualiser" }).isDisabled(), true, "« Actualiser » désactivé pendant « Voir plus »");
          assert.equal(await buyerPage.getByRole("button", { name: "Chargement…" }).evaluate((element) => (element as HTMLButtonElement).disabled), true);
        }
        await sleep(2_000);
        return (await cards.count()) >= total;
      }
      return count >= total;
    });
    info(`état « Recherche en cours… » vu avant les résultats : ${sawProcessing ? "oui" : "non (résultats déjà prêts)"}`);
    assert.equal(sawMore, true, "la page n'a proposé « Voir plus » qu'au-delà de 20 offres");
    assert.equal(await cards.count(), total);
    const prices = new Set((await cards.locator(".font-display").allInnerTexts()).map((text) => text.replace(/\s/g, "")));
    assert.equal(prices.size, total, "« Voir plus » n'a introduit aucun doublon : une offre par prix distinct");
    assert.equal(await buyerPage.getByRole("button", { name: "Voir plus" }).count(), 0, "plus de « Voir plus » une fois toutes les offres affichées");
    assert.equal((await buyerPage.getByTestId("results-count").textContent())?.trim(), `${total} offres correspondent à votre besoin`);
    assert.equal(checkedBusy, true);
    ok("pendant « Voir plus » : « Actualiser » et « Chargement… » sont désactivés (aucune course entre les deux)");
    ok(`les résultats de B : 20 offres sur la première page, puis « Voir plus » (curseur) en ajoute ${total - 20} : ${total} offres sans doublon (${RIVAL_OFFERS} de C et celle de A)`);
    assert.equal(await buyerPage.getByText("Sponsorisé", { exact: true }).count(), 0);
    assert.equal(await buyerPage.locator("[data-sponsored=true]").count(), 0);
    ok("aucun badge « Sponsorisé » tant qu'aucun boost n'existe");
    const firstCardText = (await cards.first().innerText()).replace(/\s+/g, " ");
    assert.match(firstCardText, /Samsung Galaxy S21/);
    assert.match(firstCardText, /\d[\d\s ]* FCFA/);
    assert.match(firstCardText, /Compatibilité \d+ %/);
    assert.match(firstCardText, /(Prix (en dessous du marché|dans la moyenne du marché|au-dessus du marché|non renseigné)|Marché insuffisant)/);
    assert.match(firstCardText, /Disponibilité/);
    assert.match(firstCardText, /Confiance (élevée|moyenne|faible)/);
    ok(`chaque offre affiche titre, prix, compatibilité et indicateurs en mots simples (1re offre : « ${firstCardText.slice(0, 150)}… »)`);
    const resultsText = await buyerPage.locator("main").innerText();
    for (const raw of ["confirmed_recent", "in_market", "above_market", "below_market", "gte_30d", "lt_7d", "insufficient"]) {
      assert.equal(resultsText.includes(raw), false, `aucun code brut « ${raw} » à l'écran`);
    }
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(resultsText), false, "aucun identifiant (UUID) à l'écran");
    assert.equal(resultsText.includes("+225") || resultsText.includes("0700"), false, "aucun téléphone à l'écran");
    ok("aucun code brut, aucun identifiant, aucun téléphone dans les résultats de B");
    await shot(buyerPage, "09-besoin-resultats-sans-boost");
    const aboveMarket = await buyerPage.getByText("Prix au-dessus du marché", { exact: true }).count();
    info(`offres « Prix au-dessus du marché » : ${aboveMarket}`);

    step("Vendeur A : « Acheteurs intéressés » (sans identité) et devis de boost");
    await refreshUntil(sellerPage, "le besoin de B dans « Acheteurs intéressés »", async () => {
      return (await sellerPage.getByTestId("interested-buyer").count()) >= 1;
    });
    assert.equal((await sellerPage.getByTestId("interested-count").textContent())?.trim(), "1 besoin d'acheteur correspond à votre annonce");
    assert.match((await sellerPage.getByTestId("interested-note").textContent()) ?? "", /un même acheteur peut en avoir plusieurs/);
    const buyerRowText = (await sellerPage.getByTestId("interested-buyer").first().innerText()).replace(/\s+/g, " ");
    assert.match(buyerRowText, /Samsung Galaxy S21/);
    assert.match(buyerRowText, /Budget : jusqu'à 250\s000 FCFA/);
    assert.match(buyerRowText, /Compatibilité \d+ %/);
    const sellerText = await sellerPage.locator("main").innerText();
    for (const secret of [buyerLocalPhone, buyerLocalPhone.slice(1), buyerLocalPhone.slice(-8), "+225", "owner"]) {
      assert.equal(sellerText.includes(secret), false, `le vendeur ne voit pas « ${secret} »`);
    }
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(sellerText), false, "aucun identifiant (UUID) à l'écran du vendeur");
    ok("« 1 besoin d'acheteur correspond à votre annonce » (on compte des besoins, pas des acheteurs) : produit, budget 250 000 FCFA, compatibilité, sans nom, ni téléphone, ni identifiant");
    await durations.getByRole("button", { name: "3 jours", exact: true }).click();
    await sellerPage.getByTestId("boost-amount").waitFor();
    const amountText = ((await sellerPage.getByTestId("boost-amount").textContent()) ?? "").replace(/\s/g, " ").trim();
    assert.match(amountText, /^\d[\d ]* FCFA$/);
    const explanation = ((await sellerPage.getByRole("list", { name: "Comment ce prix est calculé" }).innerText()) ?? "").replace(/\s+/g, " ");
    for (const label of ["Concurrence", "Acheteurs compatibles", "Places disponibles", "Durée"]) assert.ok(explanation.includes(label), label);
    assert.equal(/milli/i.test(explanation), false);
    const validity = (await sellerPage.getByTestId("boost-validity").textContent()) ?? "";
    assert.match(validity, /^Prix valable encore \d+ min \d+ s$/);
    // Première valeur affichée : jamais au-delà de la validité du devis (900 s = 15 min 0 s), même si la page est ouverte depuis longtemps.
    const [, minutes, seconds] = /^Prix valable encore (\d+) min (\d+) s$/.exec(validity) ?? [];
    assert.ok(Number(minutes) * 60 + Number(seconds) <= 900, `première valeur du compte à rebours : « ${validity} » (attendu ≤ 15 min 0 s)`);
    ok(`devis 3 jours : montant « ${amountText} », facteurs en clair (concurrence, acheteurs compatibles, places, durée), « ${validity} »`);
    const buy = sellerPage.getByRole("button", { name: "Acheter" });
    assert.equal(await buy.isDisabled(), true);
    // isDisabled() accepte aussi aria-disabled : on exige l'attribut `disabled` réel du bouton (un clic ne peut rien déclencher).
    assert.equal(await buy.evaluate((element) => (element as HTMLButtonElement).disabled), true, "attribut disabled réel du bouton « Acheter »");
    assert.equal(await buy.getAttribute("aria-disabled"), "true");
    assert.equal(await sellerPage.getByTestId("boost-buy-note").textContent(), "Paiement bientôt disponible");
    ok("bouton « Acheter » DÉSACTIVÉ, mention « Paiement bientôt disponible » (aucun paiement)");
    await sellerPage.waitForTimeout(2_200);
    const later = (await sellerPage.getByTestId("boost-validity").textContent()) ?? "";
    assert.notEqual(later, validity, "le compte à rebours avance");
    ok(`le compte à rebours avance : « ${validity} » puis « ${later} »`);
    await sellerPage.getByTestId("boost-history").waitFor();
    assert.equal(await sellerPage.getByTestId("boost-history").locator("li").count(), 2, "historique : le devis indisponible puis le devis disponible");
    ok("historique des devis : 2 entrées (24 h indisponible, 3 jours disponible)");
    await shot(sellerPage, "10-annonce-acheteurs-et-devis");

    step("Boost d'administration (boost:grant, aucun paiement) : l'acheteur B voit « Sponsorisé »");
    const line = await grantBoostByAdministration(offerId, "3d");
    ok(`boost:grant (base noma_e2e) : ${line.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, "<id>")}`);
    await buyerPage.getByRole("button", { name: "Actualiser" }).click();
    await buyerPage.getByText("Sponsorisé", { exact: true }).waitFor();
    assert.equal(await buyerPage.getByText("Sponsorisé", { exact: true }).count(), 1);
    assert.equal(await buyerPage.locator("[data-sponsored=true]").count(), 1);
    const sponsoredCard = cards.first();
    assert.equal(await sponsoredCard.getAttribute("data-sponsored"), "true", "l'offre sponsorisée est en tête de liste");
    const notice = "Mis en avant par le vendeur, parmi des résultats déjà pertinents";
    assert.ok((await sponsoredCard.innerText()).includes(notice));
    assert.equal(await sponsoredCard.getByText("Sponsorisé", { exact: true }).getAttribute("title"), notice);
    assert.ok((await sponsoredCard.innerText()).includes("190"), "la carte sponsorisée est l'offre de A (190 000 FCFA)");
    assert.ok((await cards.count()) >= 20, "la première page reste pleine (20 offres) : le boost n'ajoute ni ne retire aucune offre");
    ok("badge « Sponsorisé » visible sur l'offre de A (en tête), avec « Mis en avant par le vendeur, parmi des résultats déjà pertinents » et la même info-bulle");
    await shot(buyerPage, "11-besoin-resultats-sponsorise");

    step("Vendeur A : le devis après le boost dit « déjà boostée »");
    // 7 jours n'a jamais été demandé : un devis neuf est calculé (une cotation encore valable serait réutilisée telle quelle).
    await durations.getByRole("button", { name: "7 jours", exact: true }).click();
    await sellerPage.getByTestId("boost-unavailable").waitFor();
    await sellerPage.waitForFunction(() => document.querySelector("[data-testid=boost-unavailable]")?.textContent?.includes("déjà boostée"));
    assert.equal(((await sellerPage.getByTestId("boost-unavailable").textContent()) ?? "").trim(), "Cette annonce est déjà boostée.");
    ok("devis indisponible : « Cette annonce est déjà boostée. » (jamais le code offer_already_boosted)");
    await shot(sellerPage, "12-annonce-devis-deja-boostee");
    await sellerContext.close();
    await buyerContext.close();

    assert.deepEqual(pageErrors, [], `erreurs de page : ${pageErrors.join(" | ")}`);
    const hydration = consoleErrors.filter((text) => /hydrat/i.test(text));
    assert.deepEqual(hydration, [], `erreurs d'hydratation : ${hydration.join(" | ")}`);
    ok(`aucune exception de page, aucune erreur d'hydratation (${consoleErrors.length} autre(s) message(s) console error)`);
    if (consoleErrors.length > 0) console.log(`    messages console error : ${consoleErrors.map((text) => text.slice(0, 160)).join(" || ")}`);
  } catch (error) {
    for (const [index, open] of openPages.entries()) await shot(open, `99-echec-${index + 1}`).catch(() => {});
    console.error(
      `  ✗ ÉCHEC : ${error instanceof Error ? error.message.split("\n")[0] : "erreur inattendue"} (URL : ${openPages.map((open) => open.url()).join(" | ")})`,
    );
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  console.log(`e2e:ui : ${checks} vérifications réussies, 0 échec.`);
}

main().catch((error: unknown) => {
  console.error(`e2e:ui : erreur inattendue : ${error instanceof Error ? error.message.split("\n")[0] : "inconnue"}`);
  process.exit(1);
});
