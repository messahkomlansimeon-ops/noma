/**
 * `npm run e2e:extraction` : les propositions d'extraction du catalogue, dans un VRAI navigateur (Chrome piloté par Playwright, installé dans poc/) contre un vrai serveur Next lancé par
 * `npm run dev:try`, À TRAVERS LE RELAIS DE DÉVELOPPEMENT et la vraie base PostgreSQL. NON inclus dans `npm test`.
 *
 * Parcours :
 *   1. un vendeur crée une annonce AVEC SEULEMENT UN TEXTE (« iPhone 12 128 Go noir, très bon état, 165 000 FCFA à Cocody ») ; la carte « Remplir la fiche depuis mon texte » est sur la page de l'annonce ;
 *   2. « Analyser mon texte » : les lignes (catégorie, marque, modèle, état, lieu, prix, stockage) sont proposées avec l'extrait du texte ; cochées d'avance sauf catégorie et état, montrés mais
 *      NON applicables (le serveur écrit des codes que le reste de noma ne comprend pas) ; la fiche n'a PAS changé (lecture de l'API) ;
 *   3. on décoche le lieu, « Appliquer » : message de succès, la page montre le prix, l'API montre la marque, le modèle, le prix et le stockage, mais PAS le lieu (non coché) ; le texte brut est intact ;
 *   4. une seconde analyse ne propose plus que le lieu applicable (le reste est déjà identique) ; le recharger de la page retrouve l'analyse sans la recalculer ;
 *   5. texte ambigu (« Samsung Galaxy S21 ou S22, 200000 », sans devise) : la ligne du prix est montrée mais DÉSACTIVÉE, rien d'autre n'est bloqué, et le prix n'est pas appliqué ;
 *   6. fraîcheur : après l'analyse, le texte est modifié par l'API ; « Appliquer » est refusé avec un message fixe et la carte demande une nouvelle analyse ; la fiche reste telle quelle ;
 *   7. une valeur DÉJÀ saisie n'est pas cochée d'avance et n'est pas écrasée tant qu'on ne la coche pas ;
 *   8. un besoin d'acheteur (« Je cherche un iPhone 12 64 Go, budget max 150 000 FCFA, 2 unités, à Abidjan ») : même carte sur la page du besoin, budget et quantité appliqués ;
 *   9. une annonce archivée n'affiche pas la carte ;
 *  10. un autre utilisateur n'obtient que des 404 sans contenu sur la fiche d'autrui, et la page n'affiche ni carte ni texte ;
 *  11. panne de l'analyse (503 puis coupure réseau simulées) : message fixe sans détail du serveur, bouton réutilisable, fiche intacte ;
 *  12. non-régression du matching : le besoin saisi au formulaire (Téléphones, Apple) trouve toujours l'annonce remplie par l'extraction, catégorie « Téléphones » intacte ;
 *  13. texte modifié à la main : le rechargement ne ressort pas l'ancienne analyse et l'historique la marque périmée ;
 *  14. session expirée pendant « Appliquer » : retour à /connexion sans message d'erreur ; puis aucune exception de page ni message console inattendu.
 *
 * Variables : NOMA_E2E_BASE_URL (relais), NOMA_E2E_SERVER_LOG, NOMA_E2E_SHOTS, NOMA_E2E_CHROME (défaut /usr/bin/google-chrome-stable). Voir scripts/e2e-common.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { E2E_BASE, E2E_MENO_MODE, E2E_SERVER_LOG, awaitOtpLine, otpSourceSize } from "./e2e-common";

const require = createRequire(import.meta.url);
const { chromium } = require("../poc/node_modules/playwright") as typeof import("../poc/node_modules/playwright");
type Page = import("../poc/node_modules/playwright").Page;
type BrowserContext = import("../poc/node_modules/playwright").BrowserContext;
type Route = import("../poc/node_modules/playwright").Route;

const BASE = E2E_BASE;
const ORIGIN = new URL(BASE).origin;
const SHOTS = process.env.NOMA_E2E_SHOTS ?? "/tmp/noma-extraction-shots";
const CHROME = process.env.NOMA_E2E_CHROME ?? "/usr/bin/google-chrome-stable";
const VIEWPORT = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } as const;
const NBSP = " ";

if (!E2E_SERVER_LOG) {
  console.error("e2e:extraction : NOMA_E2E_SERVER_LOG est requis.");
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

let checks = 0;
const ok = (label: string) => {
  checks += 1;
  console.log(`  ✓ ${label}`);
};
const step = (title: string) => console.log(`→ ${title}`);

const pageErrors: string[] = [];
const consoleErrors: string[] = [];

function watch(page: Page): void {
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    // 401/403/404/409 : refus attendus de l'API (le test provoque lui-même le 409 de fraîcheur, le 404 d'une fiche étrangère, le 401 d'une session expirée) ;
    // 503 et net::ERR_FAILED : la panne simulée à l'étape 11.
    if (message.type() === "error" && !/status of (40[1349]|503)|net::ERR_FAILED/.test(message.text())) consoleErrors.push(message.text());
  });
}

async function loginViaUi(page: Page, localPhone: string, next: string): Promise<void> {
  await page.goto(`${BASE}/connexion?next=${encodeURIComponent(next)}`);
  await page.getByPlaceholder("07 00 00 00 42").fill(localPhone);
  const offset = otpSourceSize();
  await page.getByRole("button", { name: /Recevoir un code/ }).click();
  await page.waitForURL("**/verification");
  const { code } = await awaitOtpLine(offset);
  await page.getByLabel(/Code reçu par SMS/).fill(code);
  await page.getByRole("button", { name: "Vérifier", exact: true }).click();
  await page.waitForURL((url) => url.pathname === next, { timeout: 60_000 });
}

const localPhone = (offset: number) => `0700${String((Date.now() + offset) % 1_000_000).padStart(6, "0")}`;

type Json = Record<string, unknown>;

async function call(context: BrowserContext, method: "get" | "post" | "patch", path: string, data?: unknown): Promise<{ status: number; body: Json }> {
  const options = { headers: { origin: ORIGIN }, ...(data === undefined ? {} : { data }) };
  const response = await context.request[method](`${BASE}${path}`, options);
  let body: Json = {};
  try {
    body = (await response.json()) as Json;
  } catch {
    body = {};
  }
  return { status: response.status(), body };
}

async function createOffer(context: BrowserContext, rawText: string, extra: Json = {}): Promise<{ id: string; contentVersion: number }> {
  const created = await call(context, "post", "/api/offers", { rawText, ...extra });
  assert.equal(created.status, 201, `création de l'annonce : ${JSON.stringify(created.body).slice(0, 200)}`);
  const offer = created.body.offer as { id: string; contentVersion: number };
  return { id: offer.id, contentVersion: offer.contentVersion };
}

async function readOffer(context: BrowserContext, id: string): Promise<Json> {
  const response = await call(context, "get", `/api/offers/${id}`);
  assert.equal(response.status, 200);
  return response.body.offer as Json;
}

const card = (page: Page) => page.getByTestId("extraction-card");
const rowIds = async (page: Page): Promise<string[]> => (await page.getByTestId("extraction-row").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-row") ?? ""))).sort();
const check = (page: Page, id: string) => page.getByTestId(`extraction-check-${id}`);

async function main(): Promise<void> {
  const browser = await chromium.launch({ executablePath: CHROME });
  const vendorContext = await browser.newContext({ ...VIEWPORT });
  const buyerContext = await browser.newContext({ ...VIEWPORT });
  const vendor = await vendorContext.newPage();
  const buyer = await buyerContext.newPage();
  for (const page of [vendor, buyer]) {
    page.setDefaultTimeout(60_000);
    watch(page);
  }
  const shot = (target: Page, name: string) => target.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

  try {
    step("Connexion du vendeur et de l'acheteur dans le navigateur");
    await loginViaUi(vendor, localPhone(0), "/vendeur/annonces/nouvelle");
    await loginViaUi(buyer, localPhone(17), "/alerte/nouvelle");
    ok(`vendeur et acheteur connectés (codes lus ${E2E_MENO_MODE ? "dans les SMS reçus par le faux serveur Meno" : "dans le journal du serveur"})`);

    step("1. Une annonce créée avec seulement un texte : la carte est sur sa page");
    const text = "iPhone 12 128 Go noir, très bon état, 165 000 FCFA à Cocody";
    const first = await createOffer(vendorContext, text);
    await vendor.goto(`${BASE}/vendeur/annonces/${first.id}`);
    await card(vendor).waitFor();
    assert.match(await card(vendor).innerText(), /Remplir la fiche depuis mon texte/);
    assert.equal(await vendor.getByTestId("extraction-row").count(), 0, "aucune ligne avant l'analyse");
    assert.equal(await vendor.getByTestId("extraction-apply").count(), 0);
    ok("la carte « Remplir la fiche depuis mon texte » est présente, sans ligne ni bouton d'application avant l'analyse");

    step("2. Analyse : lignes proposées et cochées d'avance, fiche inchangée");
    await vendor.getByTestId("extraction-analyze").click();
    await vendor.getByTestId("extraction-row").first().waitFor();
    assert.deepEqual(await rowIds(vendor), ["attr:storage_capacity", "field:brand", "field:category", "field:condition", "field:location", "field:model", "field:price"]);
    const rowsText = await card(vendor).innerText();
    for (const expected of ["Téléphones", "Apple", "iphone 12", "Très bon état", "cocody", `165${NBSP}000 FCFA`, "128 Go", "« 165 000 FCFA »", "« 128 Go »"]) {
      assert.ok(rowsText.replace(/\s/g, " ").includes(expected.replace(/\s/g, " ")), `la carte montre « ${expected} »`);
    }
    for (const id of await rowIds(vendor)) {
      const vocabulary = id === "field:category" || id === "field:condition";
      assert.equal(await check(vendor, id).isChecked(), !vocabulary, `${id} ${vocabulary ? "non coché" : "coché d'avance (champ vide)"}`);
      assert.equal(await check(vendor, id).isDisabled(), vocabulary, `${id} ${vocabulary ? "désactivé" : "activé"}`);
    }
    assert.match(await vendor.locator('[data-row="field:category"]').innerText(), /formulaire de la fiche/);
    assert.match(await vendor.getByTestId("extraction-apply").innerText(), /Appliquer la sélection \(5\)/);
    const untouched = await readOffer(vendorContext, first.id);
    assert.deepEqual([untouched.brand, untouched.model, untouched.price, untouched.contentVersion], [null, null, null, first.contentVersion]);
    ok("7 lignes avec l'extrait exact du texte : 5 cochées (marque, modèle, lieu, prix, stockage), catégorie et état montrés mais désactivés ; la fiche n'a pas bougé (version identique)");
    await shot(vendor, "1-analyse");

    step("3. On décoche le lieu puis on applique");
    await check(vendor, "field:location").uncheck();
    assert.match(await vendor.getByTestId("extraction-apply").innerText(), /\(4\)/);
    await vendor.getByTestId("extraction-apply").click();
    await vendor.getByTestId("extraction-done").waitFor();
    assert.match(await vendor.getByTestId("extraction-done").innerText(), /4 informations reportées/);
    await vendor.getByText(`165${NBSP}000 FCFA`).first().waitFor();
    const applied = await readOffer(vendorContext, first.id);
    assert.deepEqual([applied.brand, applied.model], ["Apple", "iphone 12"]);
    assert.deepEqual([applied.category, applied.condition], [null, null], "catégorie et état (codes) ne sont jamais écrits : le reste de noma ne les comprendrait pas");
    assert.deepEqual(applied.price, { amount: 165000, currency: "XOF" });
    assert.equal(applied.location, null, "le lieu n'était pas coché : il n'est pas écrit");
    assert.equal(applied.rawText, text, "le texte écrit par le vendeur est intact");
    assert.equal(applied.contentVersion, first.contentVersion + 1);
    assert.deepEqual((applied.attributes as Json).storage_capacity, { value: 128, unit: "GB", sourceUnit: "Go" });
    ok("4 informations reportées ; marque, modèle, prix et stockage écrits par le serveur, lieu NON écrit, catégorie et état NON écrits, texte brut intact, version +1, le prix s'affiche dans l'en-tête de la page");
    await shot(vendor, "2-applique");

    step("4. Seconde analyse : il ne reste que le lieu ; le rechargement retrouve l'analyse sans la recalculer");
    await vendor.getByTestId("extraction-done").waitFor();
    await vendor.getByTestId("extraction-analyze").click();
    await vendor.getByTestId("extraction-row").first().waitFor();
    assert.deepEqual(await rowIds(vendor), ["field:category", "field:condition", "field:location"]);
    assert.equal(await check(vendor, "field:location").isChecked(), true);
    await vendor.reload();
    await card(vendor).waitFor();
    await vendor.getByTestId("extraction-row").first().waitFor();
    assert.deepEqual(await rowIds(vendor), ["field:category", "field:condition", "field:location"]);
    assert.equal((await readOffer(vendorContext, first.id)).contentVersion, first.contentVersion + 1, "lire ou recharger n'a rien modifié");
    ok("la seconde analyse ne propose que le lieu (le reste est identique) ; après rechargement la proposition est relue depuis l'historique");

    step("5. Texte ambigu et sans devise : la ligne du prix est montrée mais désactivée");
    const ambiguous = await createOffer(vendorContext, "Samsung Galaxy S21 ou S22, 200000");
    await vendor.goto(`${BASE}/vendeur/annonces/${ambiguous.id}`);
    await vendor.getByTestId("extraction-analyze").click();
    await vendor.getByTestId("extraction-row").first().waitFor();
    assert.ok((await rowIds(vendor)).includes("field:price"));
    assert.equal(await check(vendor, "field:price").isDisabled(), true);
    assert.equal(await check(vendor, "field:price").isChecked(), false);
    assert.match(await vendor.locator('[data-row="field:price"]').innerText(), /Non applicable/);
    assert.match(await vendor.locator('[data-row="field:price"]').innerText(), /devise/);
    assert.equal(await check(vendor, "field:brand").isEnabled(), true, "les autres lignes ne sont pas bloquées");
    await vendor.getByTestId("extraction-apply").click();
    await vendor.getByTestId("extraction-done").waitFor();
    const samsung = await readOffer(vendorContext, ambiguous.id);
    assert.equal(samsung.brand, "Samsung");
    assert.equal(samsung.price, null, "un montant sans devise n'est jamais appliqué");
    ok("devise inconnue : ligne « Non applicable » désactivée, le reste s'applique, le prix reste vide (aucune devise supposée)");

    step("6. Fraîcheur : le texte change après l'analyse, l'application est refusée");
    const fresh = await createOffer(vendorContext, "Tecno Spark 10 64 Go, bon état, 60 000 FCFA");
    await vendor.goto(`${BASE}/vendeur/annonces/${fresh.id}`);
    await vendor.getByTestId("extraction-analyze").click();
    await vendor.getByTestId("extraction-row").first().waitFor();
    const edited = await call(vendorContext, "patch", `/api/offers/${fresh.id}`, { expectedContentVersion: fresh.contentVersion, rawText: "Tecno Spark 10 128 Go, très bon état, 70 000 FCFA" });
    assert.equal(edited.status, 200, JSON.stringify(edited.body).slice(0, 200));
    await vendor.getByTestId("extraction-apply").click();
    await vendor.getByTestId("extraction-error").waitFor();
    assert.match(await vendor.getByTestId("extraction-error").innerText(), /a changé depuis l'analyse/);
    assert.equal(await vendor.getByTestId("extraction-row").count(), 0, "les lignes périmées disparaissent");
    const staleOffer = await readOffer(vendorContext, fresh.id);
    assert.deepEqual([staleOffer.brand, staleOffer.price], [null, null], "rien n'a été écrit");
    await vendor.getByTestId("extraction-analyze").click();
    await vendor.getByTestId("extraction-row").first().waitFor();
    assert.match(await card(vendor).innerText(), /70[\s ]000 FCFA/);
    ok("409 : message fixe « a changé depuis l'analyse », lignes retirées, rien d'écrit ; une nouvelle analyse propose le NOUVEAU prix (70 000 FCFA)");

    step("7. Une valeur déjà saisie n'est pas cochée d'avance ni écrasée");
    const typed = await createOffer(vendorContext, "iPhone 13 256 Go neuf 300 000 FCFA", { brand: "Marque saisie à la main" });
    await vendor.goto(`${BASE}/vendeur/annonces/${typed.id}`);
    await vendor.getByTestId("extraction-analyze").click();
    await vendor.getByTestId("extraction-row").first().waitFor();
    assert.equal(await check(vendor, "field:brand").isChecked(), false, "marque déjà saisie : pas cochée");
    assert.match(await vendor.locator('[data-row="field:brand"]').innerText(), /Actuellement : Marque saisie à la main/);
    assert.equal(await check(vendor, "field:model").isChecked(), true);
    await vendor.getByTestId("extraction-apply").click();
    await vendor.getByTestId("extraction-done").waitFor();
    assert.equal((await readOffer(vendorContext, typed.id)).brand, "Marque saisie à la main");
    ok("la marque saisie à la main est montrée (« Actuellement : … »), non cochée, et reste intacte après l'application des autres lignes");

    step("8. Un besoin d'acheteur : même carte, budget et quantité");
    const demandCreated = await call(buyerContext, "post", "/api/demands", { rawText: "Je cherche un iPhone 12 64 Go, budget max 150 000 FCFA, 2 unités, à Abidjan" });
    assert.equal(demandCreated.status, 201, JSON.stringify(demandCreated.body).slice(0, 200));
    const demand = demandCreated.body.demand as { id: string; contentVersion: number };
    const activated = await call(buyerContext, "post", `/api/demands/${demand.id}/activate`, { expectedContentVersion: demand.contentVersion });
    assert.equal(activated.status, 200, JSON.stringify(activated.body).slice(0, 200));
    await buyer.goto(`${BASE}/besoins/${demand.id}`);
    await card(buyer).waitFor();
    await buyer.getByTestId("extraction-analyze").click();
    await buyer.getByTestId("extraction-row").first().waitFor();
    const demandRows = await rowIds(buyer);
    assert.ok(demandRows.includes("field:budget") && demandRows.includes("field:quantity") && !demandRows.includes("field:price"), demandRows.join(","));
    await shot(buyer, "3-besoin-analyse");
    await buyer.getByTestId("extraction-apply").click();
    await buyer.getByTestId("extraction-done").waitFor();
    const appliedDemand = (await call(buyerContext, "get", `/api/demands/${demand.id}`)).body.demand as Json;
    assert.deepEqual(appliedDemand.budget, { amount: 150000, currency: "XOF" });
    assert.equal(appliedDemand.quantity, 2);
    assert.equal(appliedDemand.brand, "Apple");
    ok("besoin : budget 150 000 FCFA, quantité 2 et marque écrits par le serveur ; pas de ligne « prix » sur un besoin");

    step("9. Une annonce archivée n'a pas la carte");
    const toArchive = await createOffer(vendorContext, "Canapé 3 places gris, très bon état, 90 000 FCFA");
    assert.equal((await call(vendorContext, "post", `/api/offers/${toArchive.id}/archive`, { expectedContentVersion: toArchive.contentVersion })).status, 200);
    await vendor.goto(`${BASE}/vendeur/annonces/${toArchive.id}`);
    await vendor.getByText("Mon annonce").first().waitFor();
    await vendor.waitForLoadState("networkidle");
    assert.equal(await card(vendor).count(), 0);
    ok("annonce archivée : la carte n'est pas affichée");

    step("10. Un autre utilisateur ne voit rien de la fiche d'autrui");
    const mine = await createOffer(vendorContext, "Nokia 3310 neuf, 15 000 FCFA à Yopougon");
    const stranger = [
      await call(buyerContext, "get", `/api/offers/${mine.id}/extraction-proposals`),
      await call(buyerContext, "post", `/api/offers/${mine.id}/extraction-proposals`, {}),
    ];
    assert.deepEqual(stranger.map((reply) => reply.status), [404, 404], "404 indistinguable d'une fiche absente");
    assert.equal(JSON.stringify(stranger.map((reply) => reply.body)).includes("Nokia"), false, "aucun contenu de la fiche dans la réponse");
    await buyer.goto(`${BASE}/vendeur/annonces/${mine.id}`);
    await buyer.waitForLoadState("networkidle");
    assert.equal(await card(buyer).count(), 0, "pas de carte sur la page de la fiche d'autrui");
    assert.equal(await buyer.getByText("Nokia 3310").count(), 0, "le texte du vendeur n'est pas affiché à un étranger");
    ok("fiche d'autrui : lecture et analyse refusées en 404 sans contenu, aucune carte ni texte sur la page");

    step("11. Panne de l'analyse : message fixe, la carte reste utilisable");
    const flaky = await createOffer(vendorContext, "Itel A60 32 Go, bon état, 45 000 FCFA");
    await vendor.goto(`${BASE}/vendeur/annonces/${flaky.id}`);
    await card(vendor).waitFor();
    const proposeUrl = new RegExp(`/api/offers/${flaky.id}/extraction-proposals$`);
    const onlyPost = (respond: (route: Route) => Promise<void>) => (route: Route) => (route.request().method() === "POST" ? respond(route) : route.continue());
    await vendor.route(proposeUrl, onlyPost((route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "internal_error", message: "détail interne SECRET" } }) })));
    await vendor.getByTestId("extraction-analyze").click();
    await vendor.getByTestId("extraction-error").waitFor();
    const outage = await vendor.getByTestId("extraction-error").innerText();
    assert.ok(outage.trim().length > 0 && !/SECRET|internal_error/.test(outage), `message fixe, jamais le texte du serveur : « ${outage} »`);
    assert.equal(await vendor.getByTestId("extraction-row").count(), 0);
    await vendor.unroute(proposeUrl);
    await vendor.route(proposeUrl, onlyPost((route) => route.abort("failed")));
    await vendor.getByTestId("extraction-analyze").click();
    await vendor.getByTestId("extraction-error").waitFor();
    assert.equal(await vendor.getByTestId("extraction-analyze").isEnabled(), true, "le bouton redevient actif après une coupure réseau");
    await vendor.unroute(proposeUrl);
    await vendor.getByTestId("extraction-analyze").click();
    await vendor.getByTestId("extraction-row").first().waitFor();
    assert.equal(await vendor.getByTestId("extraction-error").count(), 0, "l'erreur disparaît quand l'analyse réussit");
    assert.equal((await readOffer(vendorContext, flaky.id)).contentVersion, flaky.contentVersion, "une panne n'écrit rien");
    ok("503 puis coupure réseau : message fixe sans détail du serveur, aucune ligne, bouton réutilisable ; l'essai suivant réussit et la fiche n'a jamais bougé");

    step("12. Non-régression du matching : une annonce remplie par l'extraction reste trouvée par un besoin saisi au formulaire");
    const phoneOffer = await createOffer(vendorContext, "iPhone 12 128 Go noir, très bon état, 165 000 FCFA à Cocody", { category: "Téléphones" });
    const published = await call(vendorContext, "post", `/api/offers/${phoneOffer.id}/publish`, { expectedContentVersion: phoneOffer.contentVersion });
    assert.equal(published.status, 200, JSON.stringify(published.body).slice(0, 200));
    const wanted = await call(buyerContext, "post", "/api/demands", { rawText: "Je cherche un iPhone 12", category: "Téléphones", brand: "Apple" });
    assert.equal(wanted.status, 201, JSON.stringify(wanted.body).slice(0, 200));
    const wantedDemand = wanted.body.demand as { id: string; contentVersion: number };
    const wantedActive = await call(buyerContext, "post", `/api/demands/${wantedDemand.id}/activate`, { expectedContentVersion: wantedDemand.contentVersion });
    assert.equal(wantedActive.status, 200, JSON.stringify(wantedActive.body).slice(0, 200));
    type MatchItem = { candidateId: string; compatibilityStatus: string; candidate: Json };
    const matchFor = async (): Promise<MatchItem | undefined> => {
      const reply = await call(buyerContext, "get", `/api/demands/${wantedDemand.id}/matches?limit=50`);
      assert.equal(reply.status, 200, JSON.stringify(reply.body).slice(0, 200));
      return (reply.body.items as MatchItem[]).find((item) => item.candidateId === phoneOffer.id);
    };
    const before = await matchFor();
    assert.ok(before, "l'annonce est trouvée par le besoin avant l'extraction");
    await vendor.goto(`${BASE}/vendeur/annonces/${phoneOffer.id}`);
    await vendor.getByTestId("extraction-analyze").click();
    await vendor.getByTestId("extraction-row").first().waitFor();
    await vendor.getByTestId("extraction-apply").click();
    await vendor.getByTestId("extraction-done").waitFor();
    const filled = await readOffer(vendorContext, phoneOffer.id);
    assert.equal(filled.category, "Téléphones", "la catégorie saisie au formulaire n'est pas remplacée par un code");
    assert.equal(filled.brand, "Apple");
    const after = await matchFor();
    assert.ok(after, "l'annonce est toujours trouvée par le besoin après l'extraction");
    assert.equal(after.candidate.category, "Téléphones");
    assert.notEqual(after.compatibilityStatus, "incompatible", `statut après extraction : ${after.compatibilityStatus} (avant : ${before.compatibilityStatus})`);
    ok(`le besoin (Téléphones, Apple) trouve toujours l'annonce après l'extraction : statut ${before.compatibilityStatus} → ${after.compatibilityStatus}, catégorie « Téléphones » intacte`);

    step("13. Le texte modifié à la main rend l'ancienne analyse périmée, même après un rechargement");
    const aged = await createOffer(vendorContext, "Oppo A57 64 Go, bon état, 80 000 FCFA");
    await vendor.goto(`${BASE}/vendeur/annonces/${aged.id}`);
    await vendor.getByTestId("extraction-analyze").click();
    await vendor.getByTestId("extraction-row").first().waitFor();
    const reedited = await call(vendorContext, "patch", `/api/offers/${aged.id}`, { expectedContentVersion: aged.contentVersion, rawText: "Oppo A57 128 Go, très bon état, 90 000 FCFA" });
    assert.equal(reedited.status, 200, JSON.stringify(reedited.body).slice(0, 200));
    await vendor.reload();
    await card(vendor).waitFor();
    await vendor.getByTestId("extraction-analyze").waitFor();
    assert.equal(await vendor.getByTestId("extraction-row").count(), 0, "aucune ligne de l'ancienne analyse");
    assert.equal(await vendor.getByTestId("extraction-apply").count(), 0, "aucun bouton d'application sur une analyse périmée");
    const history = await call(vendorContext, "get", `/api/offers/${aged.id}/extraction-proposals?limit=5`);
    assert.equal(history.status, 200);
    const past = history.body.extractionProposals as Json[];
    assert.ok(past.length >= 1 && past.every((item) => item.isStale === true), "l'historique marque l'ancienne analyse périmée");
    ok("après modification du texte, le rechargement ne ressort pas l'ancienne analyse et l'historique la marque périmée");

    step("14. Session expirée pendant l'application : retour à la connexion, rien d'appliqué");
    const lapsed = await createOffer(vendorContext, "Infinix Hot 30 128 Go, neuf, 110 000 FCFA");
    await vendor.goto(`${BASE}/vendeur/annonces/${lapsed.id}`);
    await vendor.getByTestId("extraction-analyze").click();
    await vendor.getByTestId("extraction-row").first().waitFor();
    await vendorContext.clearCookies();
    await vendor.getByTestId("extraction-apply").click();
    await vendor.waitForURL((url) => url.pathname.startsWith("/connexion"), { timeout: 60_000 });
    assert.equal(await vendor.getByTestId("extraction-error").count(), 0, "pas de message d'erreur parasite sur la page de connexion");
    ok("cookies supprimés avant « Appliquer » : redirection vers /connexion, sans message d'erreur");

    assert.deepEqual(pageErrors, [], "aucune exception de page");
    assert.deepEqual(consoleErrors, [], "aucun message console inattendu");
    ok("aucune exception de page, aucun message console error inattendu");
  } finally {
    await browser.close();
  }
  console.log(`\ne2e:extraction : ${checks} vérifications réussies. Captures dans ${SHOTS}.`);
}

main().catch((error) => {
  console.error(`\ne2e:extraction : ÉCHEC — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
