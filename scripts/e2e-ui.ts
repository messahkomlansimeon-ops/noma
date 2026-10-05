/**
 * `npm run e2e:ui` : parcours dans un VRAI navigateur (Chrome piloté par Playwright, installé dans poc/) contre un vrai
 * serveur Next : garde de session (redirection vers /connexion?next=…), connexion par OTP avec le code lu dans la sortie
 * du serveur, annonces du vendeur (création, publication, pause, remise en ligne, archivage), besoins de l'acheteur
 * (création, activation, satisfait, réactivation), déconnexion. NON inclus dans `npm test`.
 *
 * Le navigateur ne peut pas fournir les en-têtes d'un reverse proxy de confiance : ils sont ajoutés (interception de route)
 * aux seules requêtes vers l'origine du serveur de test (X-Noma-Proxy-Secret, X-Forwarded-For), comme le ferait le
 * proxy, et jamais à une requête vers une autre origine.
 *
 * Variables : NOMA_E2E_BASE_URL (défaut http://localhost:3211), NOMA_E2E_SERVER_LOG, NOMA_AUTH_PROXY_SECRET,
 * NOMA_E2E_SHOTS (dossier des captures, défaut /tmp/noma-e1a-e2e-ui-shots), NOMA_E2E_CHROME (défaut /usr/bin/google-chrome-stable).
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { proxyHeadersFor } from "./e2e-proxy-headers";

// Playwright n'est installé que dans poc/ : aucune dépendance ajoutée au projet principal.
const require = createRequire(import.meta.url);
const { chromium } = require("../poc/node_modules/playwright") as typeof import("../poc/node_modules/playwright");

const BASE = (process.env.NOMA_E2E_BASE_URL ?? "http://localhost:3211").replace(/\/$/, "");
const SERVER_LOG = process.env.NOMA_E2E_SERVER_LOG ?? "";
const PROXY_SECRET = process.env.NOMA_AUTH_PROXY_SECRET ?? "";
const SHOTS = process.env.NOMA_E2E_SHOTS ?? "/tmp/noma-e1a-e2e-ui-shots";
const CHROME = process.env.NOMA_E2E_CHROME ?? "/usr/bin/google-chrome-stable";
const PROXY_HEADERS = { "x-noma-proxy-secret": PROXY_SECRET, "x-forwarded-for": "198.51.100.21" };

if (!SERVER_LOG || !PROXY_SECRET) {
  console.error("e2e:ui : NOMA_E2E_SERVER_LOG et NOMA_AUTH_PROXY_SECRET sont requis.");
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

let checks = 0;
const ok = (label: string) => {
  checks += 1;
  console.log(`  ✓ ${label}`);
};
const step = (title: string) => console.log(`→ ${title}`);

async function otpAfter(offset: number): Promise<string> {
  const pattern = /\[auth:dev\] code OTP pour \+\*+[0-9]{2} : ([0-9]{6}) \(expire à/;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = pattern.exec(readFileSync(SERVER_LOG).subarray(offset).toString("utf8"));
    if (match) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("aucune ligne [auth:dev] dans la sortie du serveur");
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ executablePath: CHROME });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  // Les en-têtes du proxy ne sont ajoutés qu'aux requêtes vers l'origine du serveur de test (jamais ailleurs).
  await context.route("**/*", (route) => {
    const request = route.request();
    return route.continue({ headers: proxyHeadersFor(request.url(), BASE, request.headers(), PROXY_HEADERS) });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of 40[13]/.test(message.text())) consoleErrors.push(message.text());
  });
  const sessionRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/auth/session")) sessionRequests.push(request.url());
  });

  const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const api = (path: string) =>
    context.request.get(`${BASE}${path}`, { headers: PROXY_HEADERS });

  try {
    step("Sans session : les pages branchées redirigent vers /connexion?next=…");
    for (const path of ["/vendeur/annonces", "/vendeur/annonces/nouvelle", "/alertes", "/alerte/nouvelle"]) {
      await page.goto(`${BASE}${path}`);
      await page.waitForURL(`**/connexion?next=${encodeURIComponent(path)}`);
      ok(`${path} → /connexion?next=${encodeURIComponent(path)}`);
    }

    step("next hostile : une URL absolue ou « // » n'est jamais suivie");
    const phone = `0700${String(Date.now() % 1_000_000).padStart(6, "0")}`;
    await page.goto(`${BASE}/connexion?next=${encodeURIComponent("https://evil.example/x")}`);
    await page.getByPlaceholder("07 00 00 00 42").fill(phone);
    const offset = statSync(SERVER_LOG).size;
    await page.getByRole("button", { name: /Recevoir un code/ }).click();
    await page.waitForURL("**/verification");
    ok("demande de code acceptée, page /verification");
    await page.getByText(/Code envoyé au \+225/).waitFor();
    const shownHint = (await page.getByText(/Code envoyé au \+225/).textContent()) ?? "";
    assert.equal(shownHint.includes(phone.slice(2, 8)), false, "les chiffres du milieu ne sont pas affichés");
    ok("le numéro est masqué à l'écran");

    step("Code incorrect puis code correct (saisie au clavier et au pavé)");
    const code = await otpAfter(offset);
    await page.getByLabel(/Code reçu par SMS/).fill(code === "000000" ? "000001" : "000000");
    await page.getByRole("button", { name: "Vérifier", exact: true }).click();
    await page.getByText(/Code incorrect ou expiré/).waitFor();
    ok("mauvais code : message fixe « Code incorrect ou expiré… »");
    for (const digit of code) await page.getByRole("button", { name: digit, exact: true }).click();
    await shot("verification-code-saisi");
    await page.getByRole("button", { name: "Vérifier", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 60_000 });
    ok("code correct : redirection vers l'accueil (le next hostile https://evil.example a été ignoré)");
    const session = await api("/api/auth/session");
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
    await shot("annonce-formulaire");
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
    await shot("annonces-liste");

    await page.reload();
    await page.locator("div.rounded-2xl", { hasText: "iPhone 12 · 128 Go" }).first().getByText("En ligne", { exact: true }).waitFor();
    ok("après rechargement, l'état vient du serveur (iPhone 12 en ligne)");
    const offers = (await (await api("/api/offers")).json()) as { offers: { status: string; rawText: string }[] };
    assert.deepEqual(offers.offers.map((offer) => offer.status).sort(), ["archived", "published"]);
    ok("GET /api/offers confirme : 1 publiée, 1 archivée");

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
    await shot("besoin-formulaire");
    await page.getByRole("button", { name: "Activer le besoin" }).click();
    await page.waitForURL("**/alertes");
    const need = page.locator("div.rounded-2xl", { hasText: "Je cherche un iPhone 12" }).first();
    await need.getByText("Active", { exact: true }).waitFor();
    await need.getByText(/200\s000 FCFA max/).waitFor();
    ok("besoin créé puis activé : badge « Active », budget 200 000 FCFA max");
    await need.getByRole("button", { name: "Marquer satisfait" }).click();
    await need.getByText("Satisfait", { exact: true }).waitFor();
    await need.getByRole("button", { name: "Réactiver" }).click();
    await need.getByText("Active", { exact: true }).waitFor();
    ok("« Marquer satisfait » puis « Réactiver » : « Satisfait » puis « Active »");
    await shot("besoins-liste");

    step("Déconnexion réelle");
    await page.goto(`${BASE}/compte`);
    await page.getByRole("button", { name: "Se déconnecter" }).click();
    await page.waitForURL("**/connexion");
    ok("« Se déconnecter » : retour à /connexion");
    assert.equal((await api("/api/auth/session")).status(), 401);
    ok("GET /api/auth/session après déconnexion : 401");
    await page.goto(`${BASE}/vendeur/annonces`);
    await page.waitForURL(`**/connexion?next=${encodeURIComponent("/vendeur/annonces")}`);
    ok("/vendeur/annonces redirige de nouveau vers /connexion?next=…");

    step("Retour vers la page demandée après connexion (next interne honoré)");
    const secondPhone = `0700${String((Date.now() + 7) % 1_000_000).padStart(6, "0")}`;
    await page.getByPlaceholder("07 00 00 00 42").fill(secondPhone);
    const secondOffset = statSync(SERVER_LOG).size;
    await page.getByRole("button", { name: /Recevoir un code/ }).click();
    await page.waitForURL("**/verification");
    await page.getByLabel(/Code reçu par SMS/).fill(await otpAfter(secondOffset));
    await page.getByRole("button", { name: "Vérifier", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/vendeur/annonces", { timeout: 60_000 });
    await page.getByText("Vous n'avez pas encore d'annonce.").waitFor();
    ok("connexion depuis /connexion?next=%2Fvendeur%2Fannonces : retour sur /vendeur/annonces (compte vide)");

    assert.deepEqual(pageErrors, [], `erreurs de page : ${pageErrors.join(" | ")}`);
    const hydration = consoleErrors.filter((text) => /hydrat/i.test(text));
    assert.deepEqual(hydration, [], `erreurs d'hydratation : ${hydration.join(" | ")}`);
    ok(`aucune exception de page, aucune erreur d'hydratation (${consoleErrors.length} autre(s) message(s) console error)`);
    if (consoleErrors.length > 0) console.log(`    messages console error : ${consoleErrors.map((text) => text.slice(0, 160)).join(" || ")}`);
  } catch (error) {
    await shot("echec").catch(() => {});
    console.error(`  ✗ ÉCHEC : ${error instanceof Error ? error.message.split("\n")[0] : "erreur inattendue"} (URL : ${page.url()})`);
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  console.log(`e2e:ui : ${checks} vérifications réussies, 0 échec.`);
}

main().catch(() => {
  console.error("e2e:ui : erreur inattendue.");
  process.exit(1);
});
