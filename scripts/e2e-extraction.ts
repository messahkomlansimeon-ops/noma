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
 *   9. une annonce archivée n'affiche pas la carte ; aucune exception de page ni message console inattendu.
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
    // 401/403/404/409 : refus attendus de l'API (le test provoque lui-même le 409 de fraîcheur).
    if (message.type() === "error" && !/status of 40[1349]/.test(message.text())) consoleErrors.push(message.text());
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
