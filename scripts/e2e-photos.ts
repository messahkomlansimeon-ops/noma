/**
 * `npm run e2e:photos` (lot PH1) : photos des annonces dans un VRAI navigateur (Chrome piloté par Playwright, installé dans poc/) contre un vrai serveur Next, À TRAVERS LE RELAIS DE
 * DÉVELOPPEMENT. NON inclus dans `npm test`.
 *
 * Parcours : un vendeur publie une annonce AVEC deux photos choisies dans le formulaire (un JPEG portant un EXIF avec GPS et une orientation « portrait », un PNG portant des textes) ;
 * la page de l'annonce montre les deux photos (couverture, ordre, ajout d'une troisième puis suppression, refus en mots simples d'un faux JPEG et d'une photo trop petite) ; un acheteur
 * dont le besoin correspond voit la VIGNETTE dans ses résultats et la GALERIE sur la fiche (images réellement décodées par le navigateur, orientation conservée) ; les en-têtes du fichier
 * servi sont vérifiés et AUCUNE donnée GPS ne subsiste dans les octets servis ni dans le dossier de stockage ; un autre acheteur et un visiteur sans session reçoivent un 404 INDISCERNABLE ;
 * l'annonce en pause n'est plus servie à l'acheteur (mais l'est au vendeur), puis de nouveau une fois remise en ligne ; plafonds (5 Mo, SVG, bombe annoncée) refusés à travers le relais.
 *
 * Variables : NOMA_E2E_BASE_URL (relais), NOMA_E2E_SERVER_LOG, NOMA_E2E_SHOTS, NOMA_E2E_CHROME (défaut /usr/bin/google-chrome-stable), NOMA_E2E_WORKER_TIMEOUT_MS,
 * NOMA_MEDIA_DIR (le MÊME dossier que le serveur : le script y lit les fichiers stockés). Voir scripts/e2e-common.ts et PHOTOS.md.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { E2E_BASE, E2E_SERVER_LOG, RelaySession, awaitOtpLine, loginWithOtp, otpSourceSize, pollUntil, uniquePhone } from "./e2e-common";
import {
  EXIF_DATE, EXIF_MAKE, GPS_LATITUDE_BYTES, GPS_LONGITUDE_BYTES, KITCHEN_FORBIDDEN, XMP_GPS_TEXT, buildKitchenJpeg, buildKitchenPng, buildKitchenWebp, buildPng, containsBytes,
} from "./photo-fixtures";

const require = createRequire(import.meta.url);
const { chromium } = require("../poc/node_modules/playwright") as typeof import("../poc/node_modules/playwright");
type Page = import("../poc/node_modules/playwright").Page;
type BrowserContext = import("../poc/node_modules/playwright").BrowserContext;

const BASE = E2E_BASE;
const SHOTS = process.env.NOMA_E2E_SHOTS ?? "/tmp/noma-ph1-shots";
const CHROME = process.env.NOMA_E2E_CHROME ?? "/usr/bin/google-chrome-stable";
const WORKER_TIMEOUT_MS = Number(process.env.NOMA_E2E_WORKER_TIMEOUT_MS ?? "300000");
const MEDIA_DIR = process.env.NOMA_MEDIA_DIR ?? "";
const VIEWPORT = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } as const;
const UUID_TEXT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

if (!E2E_SERVER_LOG) {
  console.error("e2e:photos : NOMA_E2E_SERVER_LOG est requis.");
  process.exit(2);
}
if (!MEDIA_DIR) {
  console.error("e2e:photos : NOMA_MEDIA_DIR est requis (le dossier de stockage du serveur testé).");
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

let checks = 0;
const ok = (label: string) => {
  checks += 1;
  console.log(`  ✓ ${label}`);
};
const step = (title: string) => console.log(`→ ${title}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pageErrors: string[] = [];
const consoleErrors: string[] = [];

function watch(page: Page): void {
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of 40[13]/.test(message.text())) consoleErrors.push(message.text());
  });
}

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

const localPhone = (offset: number) => `0700${String((Date.now() + offset) % 1_000_000).padStart(6, "0")}`;

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

/** Taille décodée par le navigateur d'une image de la page (0 × 0 si elle ne se charge pas). */
async function decodedSize(page: Page, selector: string): Promise<[number, number]> {
  return page.evaluate(async (query) => {
    const image = document.querySelector<HTMLImageElement>(query);
    if (!image) return [0, 0] as [number, number];
    try {
      await image.decode();
    } catch {
      return [0, 0] as [number, number];
    }
    return [image.naturalWidth, image.naturalHeight] as [number, number];
  }, selector);
}

/** Les octets, les types et les en-têtes d'une photo servie, lus par l'API du contexte (donc avec ses cookies). */
async function fetchPhoto(context: BrowserContext, photoId: string) {
  const response = await context.request.get(`${BASE}/api/media/${photoId}`);
  return { response, status: response.status(), bytes: new Uint8Array(await response.body()) };
}

function assertNoLocation(bytes: Uint8Array, label: string): void {
  for (const [name, needle] of [
    ["latitude GPS", GPS_LATITUDE_BYTES], ["longitude GPS", GPS_LONGITUDE_BYTES], ["marque de l'appareil", EXIF_MAKE], ["date de prise de vue", EXIF_DATE], ["XMP", XMP_GPS_TEXT], ["texte GPS", "GPS Latitude"], ["en-tête xpacket", "xpacket"],
  ] as const) {
    assert.equal(containsBytes(bytes, needle), false, `${label} : ${name} subsiste dans le fichier`);
  }
  for (const needle of KITCHEN_FORBIDDEN) assert.equal(containsBytes(bytes, needle), false, `${label} : « ${needle} » subsiste dans le fichier (profil de couleur compris)`);
}

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
  const tag = Date.now().toString(36).slice(-5);
  const title = `iPhone 12 photos ${tag}`;

  try {
    step("Connexion du vendeur et de l'acheteur dans le navigateur");
    await loginViaUi(vendor, localPhone(0), "/vendeur/annonces/nouvelle", (url) => url.pathname === "/vendeur/annonces/nouvelle");
    await loginViaUi(buyer, localPhone(13), "/alerte/nouvelle", (url) => url.pathname === "/alerte/nouvelle");
    ok("vendeur et acheteur connectés (codes lus dans le journal du serveur)");

    step("Le vendeur publie une annonce avec DEUX photos choisies dans le formulaire");
    // Fichiers « cuisine » : EXIF/GPS, XMP, commentaire HTML, faux profil ICC (JPEG APP2, PNG iCCP au nom piégé, WebP ICCP) remplis de « GPS », « Canon », « 0708091011 », « Cocody », « Apple Inc. ».
    const jpeg = buildKitchenJpeg({ width: 300, height: 200 });
    const png = buildKitchenPng({ width: 320, height: 240 });
    const webp = buildKitchenWebp({ width: 400, height: 300 });
    for (const [label, bytes] of [["JPEG", jpeg], ["PNG", png], ["WebP", webp]] as const) {
      assert.ok(containsBytes(bytes, "0708091011") && containsBytes(bytes, "Cocody") && containsBytes(bytes, "Canon"), `${label} de départ : le secret est dans le fichier`);
    }
    assert.ok(containsBytes(jpeg, "ICC_PROFILE") && containsBytes(png, "iCCP") && containsBytes(webp, "ICCP"), "les trois fichiers de départ portent un profil de couleur piégé");
    await vendor.getByPlaceholder("iPhone 12 · 128 Go").fill(title);
    await vendor.getByRole("button", { name: "Téléphones", exact: true }).click();
    await vendor.getByPlaceholder("Apple", { exact: true }).fill("Apple");
    await vendor.getByPlaceholder("iPhone 12", { exact: true }).fill("iPhone 12");
    await vendor.getByPlaceholder("150 000").fill("150 000");
    await vendor.getByPlaceholder("Marcory, Abidjan").fill("Abidjan");
    await vendor.getByText("N'écrivez pas votre numéro sur les photos : l'acheteur vous contacte par noma.").first().waitFor();
    ok("le rappel « N'écrivez pas votre numéro sur les photos : l'acheteur vous contacte par noma. » est affiché dans le formulaire");
    await vendor.getByTestId("picked-input").setInputFiles([
      { name: "../../evil.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpeg) },
      { name: "facade.png", mimeType: "image/png", buffer: Buffer.from(png) },
    ]);
    await vendor.getByTestId("picked-tile").nth(1).waitFor();
    assert.equal(await vendor.getByTestId("picked-tile").count(), 2);
    await vendor.getByText("2 photos sur 6").waitFor();
    ok("deux photos choisies : deux aperçus, « 2 photos sur 6 », la première est la couverture");
    await shot(vendor, "01-formulaire-deux-photos");
    await vendor.getByRole("button", { name: "Publier l'annonce" }).click();
    await vendor.getByText("Annonce publiée").waitFor();
    await vendor.waitForURL((url) => url.pathname === "/vendeur/annonces");
    ok("annonce créée, photos envoyées une à une, annonce publiée");
    const offers = (await (await vendorContext.request.get(`${BASE}/api/offers`)).json()) as { offers: { id: string; status: string; rawText: string }[] };
    const offer = offers.offers.find((entry) => entry.rawText.includes(title));
    assert.ok(offer && offer.status === "published", "l'annonce est publiée");
    const offerId = offer.id;

    step("Page de l'annonce (vendeur) : gestion des photos");
    await vendor.goto(`${BASE}/vendeur/annonces/${offerId}`);
    await vendor.getByTestId("photo-tile").nth(1).waitFor();
    assert.equal(await vendor.getByTestId("photo-tile").count(), 2);
    await vendor.getByTestId("photo-count").getByText("2 photos sur 6").waitFor();
    // Le champ d'ajout est désactivé pendant un envoi : on attend qu'il soit libre avant d'y déposer un fichier (sinon le choix serait ignoré, comme pour un vrai utilisateur).
    const idle = () => vendor.waitForFunction(() => document.querySelector<HTMLInputElement>('[data-testid="photo-add-input"]')?.disabled === false);
    const tileIds = async () => vendor.getByTestId("photo-tile").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-photo-id") ?? ""));
    const [firstId, secondId] = await tileIds();
    assert.match(firstId, new RegExp(`^${UUID_TEXT}$`));
    assert.equal(await vendor.getByTestId("photo-tile").nth(0).getAttribute("data-cover"), "true");
    ok("deux photos listées, la première est la couverture (identifiants de photos : des UUID tirés par le serveur)");
    // Les fichiers sont réellement décodés par Chrome ; l'orientation « portrait » du JPEG est conservée (300 × 200 enregistrés, 200 × 300 affichés).
    const [w0, h0] = await decodedSize(vendor, `[data-photo-id="${firstId}"] img`);
    assert.deepEqual([w0, h0], [200, 300], "JPEG : décodé par le navigateur, orientation conservée (EXIF réduit à l'orientation)");
    const [w1, h1] = await decodedSize(vendor, `[data-photo-id="${secondId}"] img`);
    assert.deepEqual([w1, h1], [320, 240], "PNG nettoyé : décodé par le navigateur");
    ok("les deux fichiers nettoyés sont décodés par le navigateur ; l'orientation du JPEG est conservée (affiché 200 × 300)");
    await shot(vendor, "02-page-annonce-photos");

    // Ordre : mettre la deuxième en couverture, puis revenir.
    await vendor.getByTestId("photo-tile").nth(1).getByTestId("photo-cover-button").click();
    await vendor.waitForFunction(([id]) => document.querySelector('[data-cover="true"]')?.getAttribute("data-photo-id") === id, [secondId]);
    assert.deepEqual(await tileIds(), [secondId, firstId]);
    ok("« Mettre en couverture » : la deuxième photo passe en tête (ordre enregistré par le serveur)");
    await vendor.reload();
    await vendor.getByTestId("photo-tile").nth(1).waitFor();
    assert.deepEqual(await tileIds(), [secondId, firstId]);
    await vendor.getByTestId("photo-tile").nth(1).getByTestId("photo-cover-button").click();
    await vendor.waitForFunction(([id]) => document.querySelector('[data-cover="true"]')?.getAttribute("data-photo-id") === id, [firstId]);
    assert.deepEqual(await tileIds(), [firstId, secondId]);
    ok("l'ordre survit au rechargement ; la première photo redevient la couverture");

    // Refus en mots simples : un faux JPEG (le serveur lit les octets) et une photo trop petite. Le navigateur journalise tout refus HTTP (415, 422) : ces deux messages sont PROVOQUÉS par le test,
    // vérifiés puis retirés du décompte ; toute AUTRE erreur de console fait échouer l'essai.
    const consoleBefore = consoleErrors.length;
    await idle();
    await vendor.getByTestId("photo-add-input").setInputFiles([{ name: "fausse.jpg", mimeType: "image/jpeg", buffer: Buffer.from("<html><script>alert(1)</script></html>") }]);
    await vendor.getByTestId("photo-error").getByText("Ce format n'est pas accepté : envoyez une photo JPEG, PNG ou WebP.").waitFor();
    ok("un faux JPEG (du HTML) est refusé par le serveur : « Ce format n'est pas accepté : envoyez une photo JPEG, PNG ou WebP. »");
    await idle();
    await vendor.getByTestId("photo-add-input").setInputFiles([{ name: "minuscule.png", mimeType: "image/png", buffer: Buffer.from(buildPng({ width: 100, height: 100 })) }]);
    await vendor.getByText("Cette photo est trop petite : 200 pixels au moins de chaque côté.").first().waitFor();
    ok("une photo de 100 × 100 est refusée : « Cette photo est trop petite : 200 pixels au moins de chaque côté. »");
    const provoked = consoleErrors.splice(consoleBefore);
    assert.ok(provoked.some((text) => /status of 415/.test(text)) && provoked.some((text) => /status of 422/.test(text)), `messages console attendus (415 et 422) : ${provoked.join(" | ")}`);
    consoleErrors.push(...provoked.filter((text) => !/status of 41[5]|status of 42[2]/.test(text)));
    await idle();
    await vendor.getByTestId("photo-add-input").setInputFiles([{ name: "image.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }]);
    await vendor.getByTestId("photo-message").getByText("Ce format n'est pas accepté : choisissez une photo JPEG, PNG ou WebP.").waitFor();
    ok("un SVG est refusé dès le choix du fichier (JPEG, PNG ou WebP seulement)");
    assert.equal(await vendor.getByTestId("photo-tile").count(), 2, "aucun de ces refus n'a ajouté une photo");

    // Ajout d'un WebP puis suppression en deux temps.
    await idle();
    await vendor.getByTestId("photo-add-input").setInputFiles([{ name: "detail.webp", mimeType: "image/webp", buffer: Buffer.from(webp) }]);
    await vendor.getByTestId("photo-tile").nth(2).waitFor();
    await vendor.getByTestId("photo-count").getByText("3 photos sur 6").waitFor();
    const thirdId = (await tileIds())[2];
    assert.deepEqual(await decodedSize(vendor, `[data-photo-id="${thirdId}"] img`), [400, 300]);
    const servedWebp = await fetchPhoto(vendorContext, thirdId);
    assert.equal(servedWebp.response.headers()["content-type"], "image/webp");
    assertNoLocation(servedWebp.bytes, "WebP servi");
    ok("un WebP ajouté depuis la page de l'annonce : « 3 photos sur 6 », décodé par le navigateur");
    await vendor.getByTestId("photo-tile").nth(2).getByTestId("photo-delete").click();
    await vendor.getByTestId("photo-tile").nth(2).getByTestId("photo-delete-confirm").click();
    await vendor.getByTestId("photo-count").getByText("2 photos sur 6").waitFor();
    assert.equal(await vendor.getByTestId("photo-tile").count(), 2);
    ok("suppression en deux temps (« Supprimer » puis « Confirmer ») : retour à « 2 photos sur 6 »");

    // Les octets servis et le dossier de stockage ne portent aucune coordonnée.
    const own = await fetchPhoto(vendorContext, firstId);
    assert.equal(own.status, 200);
    const headers = own.response.headers();
    assert.equal(headers["content-type"], "image/jpeg");
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(headers["content-disposition"], "inline");
    assert.equal(headers["content-security-policy"], "default-src 'none'; sandbox");
    assert.equal(headers["cache-control"], "private, max-age=300");
    assert.equal(headers["cross-origin-resource-policy"], "same-origin");
    // Next.js ajoute ses propres entrées à Vary (rsc, next-router-state-tree…) : « Cookie » doit y figurer.
    assert.ok((headers.vary ?? "").split(",").map((token) => token.trim().toLowerCase()).includes("cookie"), `Vary : ${headers.vary}`);
    assertNoLocation(own.bytes, "JPEG servi");
    assertNoLocation((await fetchPhoto(vendorContext, secondId)).bytes, "PNG servi");
    ok("en-têtes du fichier servi : Content-Type image/jpeg, nosniff, inline, CSP « default-src 'none'; sandbox », Cache-Control « private, max-age=300 », Vary: Cookie ; aucune coordonnée GPS ni profil de couleur piégé dans les octets servis (JPEG, PNG, WebP)");

    step("L'acheteur : son besoin correspond, il voit la vignette dans ses résultats et la galerie sur la fiche");
    await buyer.getByPlaceholder(/Un iPhone 12 en bon état/).fill("Je cherche un iPhone 12 en bon état");
    await buyer.getByRole("button", { name: "Téléphones", exact: true }).click();
    await buyer.getByPlaceholder("Apple", { exact: true }).fill("Apple");
    await buyer.getByPlaceholder("iPhone 12", { exact: true }).fill("iPhone 12");
    await buyer.getByPlaceholder("200 000").fill("200 000");
    await buyer.getByRole("button", { name: "Activer le besoin" }).click();
    await buyer.waitForURL("**/alertes");
    await buyer.locator("div.rounded-2xl", { hasText: "Je cherche un iPhone 12" }).first().getByRole("link", { name: "Voir les offres", exact: true }).click();
    await buyer.waitForURL(/\/besoins\/[0-9a-f-]{36}$/);
    // L'acheteur ne voit pas le texte libre de l'annonce, seulement sa fiche épurée (« Apple iPhone 12 ») : la base d'essai ne contient que cette annonce.
    await refreshUntil(buyer, "l'annonce du vendeur dans les résultats", async () => (await buyer.getByTestId("match-card").count()) > 0);
    assert.equal(await buyer.getByTestId("match-card").count(), 1);
    const card = buyer.getByTestId("match-card").first();
    await card.getByTestId("photo-cover").waitFor();
    const coverSrc = (await card.getByTestId("photo-cover").getAttribute("src")) ?? "";
    assert.equal(coverSrc, `/api/media/${firstId}`, "la vignette est la couverture (première photo)");
    assert.deepEqual(await decodedSize(buyer, `[data-testid="match-card"] [data-testid="photo-cover"]`), [200, 300]);
    assert.equal(await card.getByTestId("photo-cover").getAttribute("loading"), "lazy");
    ok("résultats : la carte de l'annonce porte la vignette de couverture (/api/media/…), chargement paresseux, image décodée");
    await shot(buyer, "03-resultats-vignette");

    await card.getByTestId("match-detail-link").click();
    await buyer.getByTestId("offer-detail").waitFor();
    await buyer.getByTestId("photo-gallery").waitFor();
    assert.equal(await buyer.getByTestId("gallery-thumb").count(), 2);
    assert.equal(await buyer.getByTestId("gallery-main").getAttribute("src"), `/api/media/${firstId}`);
    assert.deepEqual(await decodedSize(buyer, `[data-testid="gallery-main"]`), [200, 300]);
    await buyer.getByTestId("gallery-thumb").nth(1).click();
    await buyer.waitForFunction(([src]) => document.querySelector('[data-testid="gallery-main"]')?.getAttribute("src") === src, [`/api/media/${secondId}`]);
    assert.deepEqual(await decodedSize(buyer, `[data-testid="gallery-main"]`), [320, 240]);
    ok("fiche : galerie de deux photos (la première en grand, vignettes dessous) ; la deuxième vignette affiche le PNG, décodé");
    await shot(buyer, "04-fiche-galerie");
    const html = await buyer.content();
    assert.equal(/sha256|offer_id|owner/i.test(html), false, "la page ne contient ni empreinte ni identifiant de propriétaire");

    step("Accès : l'acheteur légitime, un autre acheteur, un visiteur, un identifiant inconnu");
    const legit = await fetchPhoto(buyerContext, firstId);
    assert.equal(legit.status, 200);
    assert.equal(legit.response.headers()["x-content-type-options"], "nosniff");
    assertNoLocation(legit.bytes, "photo servie à l'acheteur");
    const stranger = new RelaySession("autre acheteur");
    await loginWithOtp(stranger, uniquePhone("31"));
    const visitor = new RelaySession("visiteur");
    const unknown = "00000000-0000-4000-8000-000000000000";
    const seen = async (session: RelaySession, id: string) => {
      const response = await session.fetch(`/api/media/${id}`);
      return { status: response.status, text: await response.text(), cache: response.headers.get("cache-control"), type: response.headers.get("content-type") };
    };
    const reference = await seen(stranger, unknown);
    assert.equal(reference.status, 404);
    for (const [label, session] of [["autre acheteur", stranger], ["visiteur sans session", visitor]] as const) {
      assert.deepEqual(await seen(session, firstId), reference, `${label} : 404 indiscernable`);
      assert.deepEqual(await seen(session, secondId), reference, `${label} : 404 indiscernable (2ᵉ photo)`);
    }
    assert.deepEqual(await seen(stranger, "..%2F..%2Fetc%2Fpasswd"), reference, "un identifiant en `../` (encodé) répond le même 404 JSON");
    ok("un autre acheteur et un visiteur reçoivent le MÊME 404 que pour un identifiant inconnu (même corps, mêmes en-têtes)");

    step("Annonce en pause : plus servie à l'acheteur, toujours au vendeur");
    await vendor.goto(`${BASE}/vendeur/annonces`);
    const mine = vendor.locator("div.rounded-2xl", { hasText: title }).first();
    await mine.getByRole("button", { name: "Mettre en pause" }).click();
    await mine.getByText("En pause", { exact: true }).waitFor();
    assert.equal((await fetchPhoto(buyerContext, firstId)).status, 404);
    assert.equal((await fetchPhoto(vendorContext, firstId)).status, 200);
    ok("annonce en pause : 404 pour l'acheteur, 200 pour le vendeur");
    await mine.getByRole("button", { name: "Remettre en ligne" }).click();
    await mine.getByText("En ligne", { exact: true }).waitFor();
    // Remettre en ligne ouvre une nouvelle version du contenu : la correspondance n'est « fraîche » qu'une fois réévaluée par le worker (même règle que la fiche).
    await pollUntil("photo de nouveau servie à l'acheteur", async () => ((await fetchPhoto(buyerContext, firstId)).status === 200 ? true : null), 120_000);
    ok("annonce remise en ligne : de nouveau servie à l'acheteur dès que le worker a réévalué la correspondance");

    step("Plafonds à travers le relais : 5 Mo, SVG, bombe annoncée, origine");
    const vendorApi = new RelaySession("vendeur API");
    await loginWithOtp(vendorApi, uniquePhone("32"));
    const apiOffer = (await (await vendorApi.fetch("/api/offers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rawText: `Annonce plafonds ${tag}`, category: "Téléphones", brand: "Apple", model: "iPhone 12", price: { amount: 150000, currency: "XOF" } }) })).json()) as { offer: { id: string } };
    const post = (bytes: Uint8Array, init: { origin?: string | null; type?: string } = {}) =>
      vendorApi.fetch(`/api/offers/${apiOffer.offer.id}/photos`, { method: "POST", origin: init.origin, headers: { "content-type": init.type ?? "application/octet-stream" }, body: bytes as unknown as BodyInit });
    // Un refus renvoyé AVANT d'avoir lu un gros corps peut fermer la connexion que le client réutilisait : une requête coupée net (ECONNRESET) est rejouée une fois ; seuls des refus (sans effet) passent par là.
    const refused = async (bytes: Uint8Array, init: { origin?: string | null; type?: string } = {}): Promise<Response> => {
      try {
        return await post(bytes, init);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        await sleep(300);
        return post(bytes, init);
      }
    };
    const big = await refused(new Uint8Array(6 * 1024 * 1024));
    assert.equal(big.status, 413);
    ok("6 Mo : refusé (413) à travers le relais");
    const svg = await refused(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { type: "image/png" });
    assert.equal(svg.status, 415);
    ok("un SVG déclaré « image/png » est refusé (415) : le type vient des octets");
    const bomb = await refused(buildPng({ width: 200, height: 200, declared: { width: 50_000, height: 50_000 } }));
    assert.equal(bomb.status, 422);
    assert.equal(((await bomb.json()) as { error: { code: string } }).error.code, "too_large_dimensions");
    ok("un en-tête qui annonce 50 000 × 50 000 est refusé (422 too_large_dimensions)");
    const lying = await refused(buildPng({ width: 200, height: 200, declared: { width: 8_000, height: 5_000 } }));
    assert.equal(lying.status, 422);
    const lyingBody = (await lying.json()) as { error: { code: string; message: string } };
    assert.equal(lyingBody.error.code, "too_large_dimensions");
    assert.match(lyingBody.error.message, /4 100 pixels au plus de chaque côté\. Choisissez une photo plus petite ou réduisez-la\./);
    const heavy = await refused(buildPng({ width: 200, height: 200, declared: { width: 4_100, height: 3_049 } }));
    assert.equal(heavy.status, 422);
    assert.equal(((await heavy.json()) as { error: { code: string } }).error.code, "too_many_pixels");
    ok("un en-tête qui annonce 8 000 × 5 000 (la bombe de l'auditeur) ou plus de 12,5 millions de pixels est refusé en mots simples (422)");
    assert.equal((await refused(buildPng({ width: 200, height: 200 }), { origin: "https://evil.example" })).status, 403);
    ok("une origine étrangère est refusée (403) avant toute lecture");
    const replayBytes = buildPng({ width: 260, height: 260, pattern: "checker" });
    const created = await post(replayBytes);
    const replay = await post(replayBytes);
    assert.deepEqual([created.status, replay.status], [201, 200]);
    ok("le même fichier envoyé deux fois : 201 puis 200 (rejeu idempotent, une seule photo)");

    step("Dossier de stockage : seulement des UUID, aucune donnée GPS");
    const names = readdirSync(MEDIA_DIR);
    assert.ok(names.length >= 3, `${names.length} fichiers`);
    for (const name of names) {
      assert.match(name, new RegExp(`^${UUID_TEXT}$`), `nom de fichier : ${name}`);
      assertNoLocation(new Uint8Array(readFileSync(join(MEDIA_DIR, name))), name);
    }
    ok(`${names.length} fichier(s) stocké(s), tous nommés d'un UUID, aucun ne contient de coordonnées GPS, de marque d'appareil ni de XMP`);

    assert.deepEqual(pageErrors, [], `exceptions de page : ${pageErrors.join(" | ")}`);
    assert.deepEqual(consoleErrors, [], `erreurs de console : ${consoleErrors.join(" | ")}`);
    ok("aucune exception de page ni erreur de console pendant tout le parcours");
  } finally {
    await browser.close();
  }
  console.log(`\ne2e:photos : ${checks} vérifications réussies.`);
}

main().catch((error: unknown) => {
  console.error("e2e:photos : ÉCHEC", error);
  process.exit(1);
});
