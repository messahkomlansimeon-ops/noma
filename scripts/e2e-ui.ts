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
 * désactivé, « Solde insuffisant » et « Recharger » pour un vendeur sans crédit), puis le motif « déjà boostée ».
 *
 * Partie 3 (lots P2 et P2-bis) : porte-monnaie, recharge SIMULÉE et achat de boost, tout dans le navigateur. Autre produit : l'offre de A (la plus
 * chère, créée dans le navigateur) et le besoin de B ; A est la SEULE annonce : devis « Pour le moment, un boost ne ferait monter votre annonce chez aucun acheteur… » (aucun prix,
 * aucun « Acheter ») ; puis `dev:seed` ajoute 8 annonces d'exemple (vendeurs fictifs) : devis disponible avec « Mise en avant visible auprès de
 * 1 acheteur ». A sans crédit : « Solde insuffisant (0 FCFA) », « Recharger » → montants refusés (dont « 000000000500 » normalisé) → 2 000 FCFA →
 * page « paiement simulé » (bandeau SIMULATION) → « Confirmer le paiement » → retour à l'annonce. Devis RÉUTILISÉ (âgé de ≥ 30 s) : première
 * valeur du compte à rebours ≤ temps réellement restant (heure du serveur) ; veille simulée + retour au premier plan : solde, achats et devis
 * relus, compte à rebours ré-ancré ; « Relire mon solde ». Refus d'achat simulés (409, puis 429 « Trop de tentatives »). Un nouveau devis demandé
 * pendant la confirmation la referme (S5). Achat dont la demande n'atteint pas le serveur → « Aucun achat n'est enregistré » + « Vérifier /
 * réessayer » ; devis expiré à l'écran : la vérification reste possible (MÊME clé, double clic = UNE requête, réponse perdue après traitement →
 * l'écran retrouve l'achat tout seul) ; un devis lent calculé avant l'achat est ignoré à son arrivée (S4, S5). Second onglet périmé : 409
 * « quote_already_used » → l'écran se réconcilie (« Boost actif », un seul débit). Historique du porte-monnaie (une seule ligne d'achat, montants
 * signés colorés) ; B voit « Sponsorisé » ; recharge : 429 puis réponse perdue puis rechargement de la page → même clé d'idempotence (clé conservée
 * dans l'onglet, effacée à l'état terminal) ; échec simulé ; retour sûr pour CHAQUE valeur `next` hostile ; compte à rebours indifférent à
 * l'horloge murale (Date.now décalée de ±1 h) et expiration à l'écran (horloge monotone avancée) ; type d'opération inconnu → « Opération ».
 *
 * Partie 4 (lot P3) : (C) achat RETENU côté serveur (la demande d'achat n'est reçue par le serveur que 3,5 s après la réponse perdue) : l'écran dit
 * « Pas encore enregistré : l'achat peut encore aboutir. » (jamais « aucun débit »), relit les achats tout seul (2 s, 5 s, 10 s), retrouve l'achat
 * sans aucun clic, UNE seule requête d'achat de la page, UN seul débit (remboursement d'administration de l'achat précédent pour libérer l'annonce) ;
 * (D) deux onglets partageant une clé de recharge : l'onglet qui paie est « crédité » ; l'autre, au même montant, recrée UNE fois avec une clé NEUVE et
 * propose de payer (jamais « crédité » sans paiement) ; la page d'une recharge déjà terminée, rouverte ou rechargée après le paiement, dit « déjà créditée… une seule fois » (réussie) ou « terminée sans paiement » (échouée).
 *
 * Partie 5 (lot P3-bis) : (N1) un autre vendeur D du même produit achète en premier ; A (devis « disponible » calculé avant) est refusé à l'achat (409,
 * texte neutre), le devis redemandé est INDISPONIBLE (jamais le même « disponible »), plus aucun « Acheter », deux requêtes seulement (achat, devis),
 * aucune boucle ; (N4) la page d'une recharge rechargée après le paiement dit « déjà créditée… une seule fois », celle d'une recharge échouée rechargée
 * « terminée sans paiement » ; (N2) textes neutres du devis et du refus d'achat.
 * Captures d'écran dans NOMA_E2E_SHOTS.
 *
 * Variables : NOMA_E2E_BASE_URL (relais, défaut http://localhost:3212), NOMA_E2E_SERVER_LOG, NOMA_E2E_DATABASE_URL (noma_e2e,
 * pour boost:grant, dev:seed et boost:refund-purchase), NOMA_E2E_SHOTS (défaut /tmp/noma-e1b-shots), NOMA_E2E_CHROME (défaut /usr/bin/google-chrome-stable),
 * NOMA_E2E_WORKER_TIMEOUT_MS (défaut 600000 : la base noma_e2e grossit à chaque essai et le worker évalue chaque besoin contre toutes les
 * offres de la catégorie ; ~1 200 offres : plus de 4 minutes pour l'essai complet). Voir scripts/e2e-common.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  refundPurchaseByAdministration,
  seedExamplesByAdministration,
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
const WORKER_TIMEOUT_MS = Number(process.env.NOMA_E2E_WORKER_TIMEOUT_MS ?? "600000");
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

/**
 * Messages console « Failed to load resource » que le test PROVOQUE lui-même (requête coupée exprès, recharge inconnue : le navigateur
 * journalise tout 404). On vérifie qu'ils apparaissent, puis on les retire : tout AUTRE message console error fait échouer l'essai.
 */
async function expectingConsoleErrors<T>(label: string, pattern: RegExp, action: () => Promise<T>): Promise<T> {
  const start = consoleErrors.length;
  const result = await action();
  await sleep(400);
  const fresh = consoleErrors.splice(start);
  const expected = fresh.filter((text) => pattern.test(text));
  consoleErrors.push(...fresh.filter((text) => !pattern.test(text)));
  assert.ok(expected.length >= 1, `message console attendu absent (${label}) : ${pattern}`);
  info(`${expected.length} message(s) console error PROVOQUÉ(S) par le test (${label}), retirés du décompte`);
  return result;
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
      "/compte/porte-monnaie",
      "/paiement-simule/6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c",
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
    for (const label of ["Concurrence", "Acheteurs compatibles", "Places disponibles", "Durée", "Visibilité"]) assert.ok(explanation.includes(label), label);
    assert.ok(explanation.includes("Mise en avant visible auprès de 1 acheteur."), `ligne de portée : ${explanation}`);
    assert.equal(/milli/i.test(explanation), false);
    const validity = (await sellerPage.getByTestId("boost-validity").textContent()) ?? "";
    assert.match(validity, /^Prix valable encore \d+ min \d+ s$/);
    // Première valeur affichée : jamais au-delà de la validité du devis (900 s = 15 min 0 s), même si la page est ouverte depuis longtemps.
    const [, minutes, seconds] = /^Prix valable encore (\d+) min (\d+) s$/.exec(validity) ?? [];
    assert.ok(Number(minutes) * 60 + Number(seconds) <= 900, `première valeur du compte à rebours : « ${validity} » (attendu ≤ 15 min 0 s)`);
    ok(`devis 3 jours : montant « ${amountText} », facteurs en clair (concurrence, acheteurs compatibles, places, durée), « ${validity} »`);
    const buy = sellerPage.getByRole("button", { name: "Acheter", exact: true });
    assert.equal(await buy.isDisabled(), true);
    // isDisabled() accepte aussi aria-disabled : on exige l'attribut `disabled` réel du bouton (un clic ne peut rien déclencher).
    assert.equal(await buy.evaluate((element) => (element as HTMLButtonElement).disabled), true, "attribut disabled réel du bouton « Acheter »");
    assert.equal(await buy.getAttribute("aria-disabled"), "true");
    await sellerPage.getByTestId("boost-insufficient").waitFor();
    assert.equal((await sellerPage.getByTestId("boost-insufficient").textContent())?.includes("Solde insuffisant (0 FCFA)"), true);
    await sellerPage.getByRole("button", { name: "Recharger", exact: true }).waitFor();
    ok("vendeur sans crédit : bouton « Acheter » DÉSACTIVÉ, « Solde insuffisant (0 FCFA) » et bouton « Recharger »");
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

    // ─────────────────── Partie 3 (lot P2) : porte-monnaie, recharge simulée, achat de boost ───────────────────
    const norm = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
    const payTag = (Date.now() + 3).toString(36).slice(-5);
    const payProduct = { category: "Téléphones", brand: "Google", model: `Pixel 7 ${payTag}` };
    const payTitle = `Google Pixel 7 ${payTag} · offre de A`;
    const payTotal = 9;

    // Horloge de la page du vendeur : Date.now (horloge murale) et performance.now (horloge monotone) peuvent être décalées à volonté ; l'horloge
    // monotone peut aussi être GELÉE (une veille de l'appareil l'arrête : le temps passe, pas elle) puis reprise là où elle s'était arrêtée.
    await sellerPage.addInitScript(() => {
      const w = window as unknown as {
        __wallSkewMs: number;
        __perfSkewMs: number;
        __perfFrozen: boolean;
        __perfFrozenValue: number;
        __realPerf: () => number;
      };
      w.__wallSkewMs = 0;
      w.__perfSkewMs = 0;
      w.__perfFrozen = false;
      w.__perfFrozenValue = 0;
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + w.__wallSkewMs;
      const realPerf = performance.now.bind(performance);
      w.__realPerf = () => realPerf();
      performance.now = () => (w.__perfFrozen ? w.__perfFrozenValue : realPerf() + w.__perfSkewMs);
    });

    step("Vendeur A : publie une seconde offre (autre produit, la plus chère), sans aucun crédit");
    await sellerPage.goto(`${BASE}/vendeur/annonces`);
    await sellerPage.getByRole("button", { name: "Nouvelle annonce" }).last().click();
    const payForm = sellerPage.getByRole("dialog");
    await payForm.getByPlaceholder("iPhone 12 · 128 Go").fill(payTitle);
    await payForm.getByRole("button", { name: "Téléphones", exact: true }).click();
    await payForm.getByPlaceholder("Apple", { exact: true }).fill(payProduct.brand);
    await payForm.getByPlaceholder("iPhone 12", { exact: true }).fill(payProduct.model);
    await payForm.getByPlaceholder("150 000").fill("190 000");
    await payForm.getByPlaceholder("Marcory, Abidjan").fill("Abidjan");
    await payForm.getByRole("button", { name: "Publier l'annonce" }).click();
    await sellerPage.getByText("Annonce publiée").waitFor();
    const payCard = sellerPage.locator("div.rounded-2xl", { hasText: payTitle }).first();
    await payCard.getByText("En ligne", { exact: true }).waitFor();
    await payCard.getByRole("link", { name: /Acheteurs intéressés et boost/ }).click();
    await sellerPage.waitForURL(/\/vendeur\/annonces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const payOfferId = sellerPage.url().split("/").pop() as string;
    const payOfferPath = `/vendeur/annonces/${payOfferId}`;
    await sellerPage.getByTestId("boost-balance").waitFor();
    assert.equal(norm(await sellerPage.getByTestId("boost-balance-amount").textContent()), "0 FCFA");
    await sellerPage.getByTestId("boost-balance").getByRole("link", { name: "Mon porte-monnaie" }).waitFor();
    ok("seconde offre de A publiée à 190 000 FCFA ; la section boost montre « Votre solde : 0 FCFA » et le lien « Mon porte-monnaie »");

    step("Acheteur B : besoin actif pour ce produit ; une seule annonce comparable (celle de A)");
    await buyerPage.goto(`${BASE}/alerte/nouvelle`);
    await buyerPage.getByPlaceholder(/Un iPhone 12 en bon état/).fill(`Je cherche un ${payProduct.brand} ${payProduct.model}`);
    await buyerPage.getByRole("button", { name: "Téléphones", exact: true }).click();
    await buyerPage.getByPlaceholder("Apple", { exact: true }).fill(payProduct.brand);
    await buyerPage.getByPlaceholder("iPhone 12", { exact: true }).fill(payProduct.model);
    await buyerPage.getByPlaceholder("200 000").fill("250 000");
    await buyerPage.getByRole("button", { name: "Activer le besoin" }).click();
    await buyerPage.waitForURL("**/alertes");
    await buyerPage
      .locator("div.rounded-2xl", { hasText: `Je cherche un ${payProduct.brand} ${payProduct.model}` })
      .first()
      .getByRole("link", { name: "Voir les offres", exact: true })
      .click();
    await buyerPage.waitForURL(/\/besoins\/[0-9a-f-]{36}$/);
    const payResultsUrl = buyerPage.url();
    await refreshUntil(buyerPage, "l'offre de A dans les résultats de B", async () => (await cards.count()) >= 1);
    assert.equal(await cards.count(), 1);
    assert.equal(await buyerPage.getByText("Sponsorisé", { exact: true }).count(), 0);
    ok("B : 1 seule offre (celle de A), aucun badge « Sponsorisé »");

    step("Vendeur A : seule annonce pour ce produit → devis INDISPONIBLE « Pour le moment, un boost ne ferait monter votre annonce chez aucun acheteur… » (lot P2-bis, S1)");
    await refreshUntil(sellerPage, "le besoin de B dans « Acheteurs intéressés » (seconde offre)", async () => (await sellerPage.getByTestId("interested-buyer").count()) >= 1);
    const payDurations = sellerPage.getByRole("group", { name: "Durée du boost" });
    await payDurations.getByRole("button", { name: "24 h", exact: true }).click();
    await sellerPage.getByTestId("boost-unavailable").waitFor();
    const noEffect = norm(await sellerPage.getByTestId("boost-unavailable").textContent());
    assert.equal(noEffect, "Pour le moment, un boost ne ferait monter votre annonce chez aucun acheteur : leurs listes sont trop courtes, ou la place mise en avant y est déjà occupée par un boost acheté plus tôt.");
    assert.equal(noEffect.includes("no_visible_effect"), false, "jamais le code brut");
    assert.equal(await sellerPage.getByRole("button", { name: "Acheter", exact: true }).count(), 0, "aucun bouton d'achat : le devis n'a pas de prix");
    assert.equal(await sellerPage.getByTestId("boost-amount").count(), 0);
    ok("1 annonce + 1 besoin : devis 24 h indisponible, « Pour le moment, un boost ne ferait monter votre annonce chez aucun acheteur : leurs listes sont trop courtes, ou la place mise en avant y est déjà occupée par un boost acheté plus tôt. », aucun prix, aucun bouton « Acheter »");
    await shot(sellerPage, "13a-annonce-devis-sans-effet-visible");

    step("dev:seed : 8 annonces concurrentes d'exemple (vendeurs fictifs) ajoutées par la commande, comme dans ESSAYER.md");
    const seeded = await seedExamplesByAdministration({ category: "phones", brand: "google", model: payProduct.model, offers: 8 });
    assert.match(seeded, /8 annonce\(s\) d'exemple publiée\(s\), 0 déjà présente\(s\)/);
    ok(`dev:seed (base noma_e2e) : « ${seeded.split("\n")[0].replace(/base « [^»]+ »/, "base « … »").slice(0, 140)}… »`);
    await refreshUntil(buyerPage, `les ${payTotal} offres du nouveau produit dans les résultats de B`, async () => (await cards.count()) >= payTotal);
    assert.equal(await cards.count(), payTotal);
    assert.equal(await buyerPage.getByText("Sponsorisé", { exact: true }).count(), 0);
    const buyerResultsText = await buyerPage.locator("main").innerText();
    assert.equal(buyerResultsText.includes("+225") || buyerResultsText.includes("07 99 99"), false, "aucun numéro de vendeur fictif dans les résultats");
    ok(`B : ${payTotal} offres (celle de A + les 8 d'exemple), aucun badge « Sponsorisé » avant l'achat, aucun numéro de vendeur`);

    step("Vendeur A : devis, « Solde insuffisant » et « Recharger »");
    await payDurations.getByRole("button", { name: "3 jours", exact: true }).click();
    await sellerPage.getByTestId("boost-amount").waitFor();
    const reachExplanation = norm(await sellerPage.getByRole("list", { name: "Comment ce prix est calculé" }).innerText());
    assert.ok(reachExplanation.includes("Mise en avant visible auprès de 1 acheteur."), `ligne de portée absente : ${reachExplanation}`);
    assert.ok(reachExplanation.includes("n'entre pas dans le prix"), "la portée n'entre pas dans le prix");
    ok("devis 3 jours DISPONIBLE avec 9 offres : « Mise en avant visible auprès de 1 acheteur. » (n'entre pas dans le prix)");
    const quoteAmount = Number(norm(await sellerPage.getByTestId("boost-amount").textContent()).replace(/\D/g, ""));
    assert.ok(quoteAmount >= 500 && quoteAmount <= 2_000, `montant du devis 3 jours : ${quoteAmount} (attendu entre 500 et 2 000 pour que 2 000 FCFA suffisent)`);
    const fmt = (amount: number) => `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} FCFA`;
    await sellerPage.getByTestId("boost-insufficient").waitFor();
    const insufficient = norm(await sellerPage.getByTestId("boost-insufficient").textContent());
    assert.ok(insufficient.includes("Solde insuffisant (0 FCFA)"), insufficient);
    assert.ok(insufficient.includes(`Il vous manque ${fmt(quoteAmount)} pour ce boost.`), insufficient);
    const buyButton = sellerPage.getByRole("button", { name: "Acheter", exact: true });
    assert.equal(await buyButton.evaluate((element) => (element as HTMLButtonElement).disabled), true, "« Acheter » désactivé (solde insuffisant)");
    await sellerPage.getByRole("button", { name: "Recharger", exact: true }).waitFor();
    ok(`devis 3 jours : ${fmt(quoteAmount)} ; sans crédit : « Solde insuffisant (0 FCFA) », « Il vous manque ${fmt(quoteAmount)} », « Acheter » désactivé, « Recharger »`);
    await shot(sellerPage, "13-annonce-solde-insuffisant");

    step("« Recharger » : porte-monnaie, montant libre validé, 2 000 FCFA, page de paiement SIMULÉ");
    await sellerPage.getByRole("button", { name: "Recharger", exact: true }).click();
    await sellerPage.waitForURL(
      (url) =>
        url.pathname === "/compte/porte-monnaie" && url.searchParams.get("recharger") === "1" && url.searchParams.get("next") === payOfferPath,
    );
    await sellerPage.getByTestId("topup-panel").waitFor();
    assert.equal(norm(await sellerPage.getByTestId("wallet-balance").textContent()), "0 FCFA");
    assert.equal(await sellerPage.getByTestId("wallet-empty").count(), 1, "historique vide");
    assert.match(await sellerPage.getByTestId("topup-simulation-notice").innerText(), /la recharge est simulée : aucun argent réel/);
    ok("« Recharger » ouvre « Mon porte-monnaie » (panneau de recharge ouvert, retour mémorisé) : solde 0 FCFA, historique vide, mention « simulée : aucun argent réel »");
    for (const preset of ["1 000 FCFA", "2 000 FCFA", "5 000 FCFA", "10 000 FCFA"]) {
      await sellerPage.getByTestId("topup-panel").getByRole("button", { name: preset, exact: true }).waitFor();
    }
    ok("montants proposés : 1 000, 2 000, 5 000, 10 000 FCFA");
    const amountInput = sellerPage.getByTestId("topup-amount-input");
    const submit = sellerPage.getByTestId("topup-submit");
    for (const [typed, expected] of [
      ["550", /multiple de 100 FCFA/],
      ["400", /Le montant minimum est de 500 FCFA/],
      ["600000", /Le montant maximum est de 500\s000 FCFA/],
      ["12,5", /montant entier en FCFA, sans virgule ni lettre/],
      ["abc", /montant entier en FCFA, sans virgule ni lettre/],
    ] as const) {
      await amountInput.fill(typed);
      await sellerPage.getByTestId("topup-amount-error").waitFor();
      assert.match(await sellerPage.getByTestId("topup-amount-error").innerText(), expected, typed);
      assert.equal(await submit.isDisabled(), true, `« Continuer » désactivé pour ${typed}`);
    }
    await shot(sellerPage, "14-recharge-montant-refuse");
    ok("montant libre validé AVANT toute requête (550, 400, 600 000, « 12,5 », « abc » refusés avec un message clair, bouton désactivé)");
    // Lot P2-bis (M8) : des zéros de tête sont normalisés (« 000000000500 » = 500), jamais refusés comme « trop long » ni lus de travers.
    await amountInput.fill("000000000500");
    assert.equal(await sellerPage.getByTestId("topup-amount-error").count(), 0, "« 000000000500 » est accepté");
    assert.equal(await submit.isEnabled(), true);
    assert.match(norm(await submit.textContent()), /Continuer vers le paiement de 500 FCFA/);
    ok("« 000000000500 » : normalisé en 500 FCFA (bouton « Continuer vers le paiement de 500 FCFA »)");
    await amountInput.fill("2 500");
    assert.equal(await sellerPage.getByTestId("topup-amount-error").count(), 0);
    assert.equal(await submit.isDisabled(), false);
    await sellerPage.getByTestId("topup-preset-2000").click();
    assert.equal(await sellerPage.getByTestId("topup-preset-2000").getAttribute("aria-pressed"), "true");
    assert.equal(await amountInput.inputValue(), "2000");
    assert.match(norm(await submit.textContent()), /Continuer vers le paiement de 2 000 FCFA/);
    await submit.click();
    await sellerPage.waitForURL((url) => /^\/paiement-simule\/[0-9a-f-]{36}$/.test(url.pathname) && url.searchParams.get("next") === payOfferPath);
    const checkoutId = new URL(sellerPage.url()).pathname.split("/").pop() as string;
    const banner = sellerPage.getByTestId("sim-banner");
    await banner.waitFor();
    assert.equal(norm(await banner.textContent()), "SIMULATION — aucun argent réel");
    assert.equal(await banner.isVisible(), true);
    assert.equal(norm(await sellerPage.getByTestId("sim-amount").textContent()), "2 000 FCFA");
    const box = await banner.boundingBox();
    assert.ok(box && box.height >= 40 && box.width >= 300, `bandeau bien visible : ${JSON.stringify(box)}`);
    ok("2 000 FCFA → page /paiement-simule/<id> : bandeau « SIMULATION — aucun argent réel » (pleine largeur, visible), montant 2 000 FCFA");
    await shot(sellerPage, "15-paiement-simule-en-attente");

    step("Paiement simulé confirmé : porte-monnaie crédité, retour à l'annonce");
    await sellerPage.getByTestId("sim-confirm").click();
    await sellerPage.getByTestId("sim-result").waitFor();
    assert.equal(await sellerPage.getByTestId("sim-result").getAttribute("data-kind"), "succeeded");
    assert.equal(norm(await sellerPage.getByTestId("sim-result").textContent()), "Votre porte-monnaie a été crédité de 2 000 FCFA.");
    const returnLink = sellerPage.getByTestId("sim-return");
    assert.equal(norm(await returnLink.textContent()), "Retour à mon annonce");
    assert.equal(await returnLink.getAttribute("href"), payOfferPath);
    assert.equal(await sellerPage.getByTestId("sim-confirm").count(), 0, "plus de bouton une fois la recharge réussie");
    const served = (await (await sellerContext.request.get(`${BASE}/api/wallet/topups/${checkoutId}`)).json()) as { topup: { status: string; amountXof: number } };
    assert.deepEqual([served.topup.status, served.topup.amountXof], ["succeeded", 2_000], "le serveur confirme : recharge réussie de 2 000 FCFA");
    ok("« Confirmer le paiement » : « Votre porte-monnaie a été crédité de 2 000 FCFA. », lien « Retour à mon annonce » → l'annonce ; le serveur confirme (recharge réussie)");
    await shot(sellerPage, "16-paiement-simule-reussi");
    await sellerPage.reload();
    await sellerPage.getByTestId("sim-result").waitFor();
    assert.equal(await sellerPage.getByTestId("sim-result").getAttribute("data-kind"), "succeeded");
    ok("après rechargement de la page, l'état « réussi » vient du serveur (aucun bouton de paiement)");
    await returnLink.click();
    await sellerPage.waitForURL(`**${payOfferPath}`);

    step("Annonce : solde 2 000 FCFA, « Acheter » actif ; devis RÉUTILISÉ : compte à rebours juste dès la première valeur ; retour au premier plan ; horloge murale sans effet ; expiration à l'écran");
    await sellerPage.getByTestId("boost-balance").waitFor();
    assert.equal(norm(await sellerPage.getByTestId("boost-balance-amount").textContent()), "2 000 FCFA");
    // Lectures observées (solde, achats, devis) : « relire » doit réellement refaire la requête.
    const reads = { wallet: 0, purchases: 0, quotes: 0 };
    sellerPage.on("request", (request) => {
      if (request.method() !== "GET") return;
      if (/\/api\/wallet(\?.*)?$/.test(request.url())) reads.wallet += 1;
      else if (/\/boost-purchases(\?.*)?$/.test(request.url())) reads.purchases += 1;
      else if (/\/boost-quotes(\?.*)?$/.test(request.url())) reads.quotes += 1;
    });
    interface ApiQuote {
      id: string;
      durationCode: string;
      status: string;
      computedAt: string;
      expiresAt: string;
      expired: boolean;
    }
    const availableQuote = async (code: string): Promise<ApiQuote> => {
      const listed = (await (await sellerContext.request.get(`${BASE}/api/offers/${payOfferId}/boost-quotes?limit=10`)).json()) as { quotes: ApiQuote[] };
      const found = listed.quotes.find((quote) => quote.durationCode === code && quote.status === "available" && !quote.expired);
      assert.ok(found, `aucun devis ${code} valable côté serveur`);
      return found;
    };
    const countdownSeconds = (text: string | null): number => {
      const match = /^Prix valable encore (?:(\d+) min )?(\d+) s$/.exec(norm(text));
      assert.ok(match, `texte du compte à rebours : « ${norm(text)} »`);
      return Number(match[1] ?? 0) * 60 + Number(match[2]);
    };
    // Lot P2-bis (S3) : le devis demandé avant la recharge est RÉUTILISÉ par le serveur, déjà vieux à la réception. Sa validité réelle vient de
    // l'en-tête HTTP Date : la première valeur affichée ne dépasse JAMAIS le temps réellement restant (avant : 15 min 0 s quel que soit l'âge).
    const reusable = await availableQuote("3d");
    const reusableAge = Date.now() - Date.parse(reusable.computedAt);
    if (reusableAge < 30_000) await sleep(30_000 - reusableAge + 300);
    await payDurations.getByRole("button", { name: "3 jours", exact: true }).click();
    await sellerPage.getByTestId("boost-amount").waitFor();
    assert.equal(Number(norm(await sellerPage.getByTestId("boost-amount").textContent()).replace(/\D/g, "")), quoteAmount, "même devis (réutilisé : même prix)");
    const reusableLeft = () => (Date.parse(reusable.expiresAt) - Date.now()) / 1000;
    const firstShown = countdownSeconds(await sellerPage.getByTestId("boost-validity").textContent());
    assert.ok(Date.parse(reusable.expiresAt) - Date.parse(reusable.computedAt) >= 890_000, "devis disponible : validité totale ~15 min");
    assert.ok(firstShown <= reusableLeft() + 1.5, `première valeur affichée ${firstShown} s > temps réellement restant ${reusableLeft().toFixed(1)} s (devis réutilisé, âgé de ${Math.round(reusableAge / 1000)} s)`);
    assert.ok(firstShown >= reusableLeft() - 6, `première valeur affichée ${firstShown} s anormalement basse (restant ${reusableLeft().toFixed(1)} s)`);
    ok(`devis réutilisé âgé de ≥ 30 s : première valeur du compte à rebours ${firstShown} s ≤ temps réellement restant ${reusableLeft().toFixed(0)} s (ancré sur l'heure du serveur de la réponse, et non plus sur la fenêtre complète de 900 s)`);
    const payBuy = sellerPage.getByRole("button", { name: "Acheter", exact: true });
    assert.equal(await payBuy.isEnabled(), true);
    assert.equal(await sellerPage.getByTestId("boost-insufficient").count(), 0);
    ok(`solde 2 000 FCFA ≥ ${fmt(quoteAmount)} : « Acheter » actif, plus de « Solde insuffisant »`);
    await shot(sellerPage, "17-annonce-acheter-actif");
    const payValidity = sellerPage.getByTestId("boost-validity");
    // Retour au premier plan (S3, M6) : une veille fige l'horloge monotone ; au retour (visibilitychange) le solde, les achats et les devis sont
    // relus et le compte à rebours est ré-ancré sur l'heure du serveur. Veille simulée : l'horloge monotone de la page recule de 5 minutes.
    const waitUntil = async (label: string, condition: () => Promise<boolean>, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await condition()) return;
        await sleep(150);
      }
      throw new Error(`${label} : condition non atteinte en ${timeoutMs} ms`);
    };
    const readsBeforeReturn = { ...reads };
    await sellerPage.evaluate(() => {
      const w = window as unknown as { __perfFrozen: boolean; __perfFrozenValue: number };
      w.__perfFrozenValue = performance.now();
      w.__perfFrozen = true;
    });
    await sellerPage.waitForTimeout(6_000);
    const lagging = countdownSeconds(await payValidity.textContent());
    assert.ok(lagging >= reusableLeft() + 4, `veille simulée (horloge monotone gelée 6 s) : compte à rebours en retard (${lagging} s affichées, ${reusableLeft().toFixed(0)} s réelles)`);
    await sellerPage.evaluate(() => {
      // Reprise : l'horloge monotone repart de là où elle s'était arrêtée, puis l'écran revient au premier plan.
      const w = window as unknown as { __perfSkewMs: number; __perfFrozen: boolean; __perfFrozenValue: number; __realPerf: () => number };
      w.__perfSkewMs = w.__perfFrozenValue - w.__realPerf();
      w.__perfFrozen = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitUntil("compte à rebours ré-ancré au retour au premier plan", async () => countdownSeconds(await payValidity.textContent()) <= reusableLeft() + 2);
    await waitUntil("relecture du solde, des achats et des devis au retour au premier plan", async () => reads.wallet > readsBeforeReturn.wallet && reads.purchases > readsBeforeReturn.purchases && reads.quotes > readsBeforeReturn.quotes);
    const reanchored = countdownSeconds(await payValidity.textContent());
    assert.ok(reanchored >= reusableLeft() - 8, `compte à rebours ré-ancré anormalement bas : ${reanchored} s (réel ${reusableLeft().toFixed(0)} s)`);
    ok(`veille simulée (horloge monotone gelée 6 s : ${lagging} s affichées pour ${reusableLeft().toFixed(0)} s réelles) puis retour au premier plan : solde, achats et devis relus (${reads.wallet - readsBeforeReturn.wallet}/${reads.purchases - readsBeforeReturn.purchases}/${reads.quotes - readsBeforeReturn.quotes} requêtes), compte à rebours de nouveau ≤ temps réel (${reanchored} s)`);
    assert.equal(await payBuy.isEnabled(), true, "« Acheter » reste actif après le retour au premier plan");
    const balanceReads = reads.wallet;
    await sellerPage.getByTestId("boost-balance-refresh").click();
    await waitUntil("« Relire mon solde » refait la requête", async () => reads.wallet > balanceReads);
    assert.equal(norm(await sellerPage.getByTestId("boost-balance-refresh").textContent()), "Relire mon solde");
    assert.equal(norm(await sellerPage.getByTestId("boost-balance-amount").textContent()), "2 000 FCFA");
    ok("« Relire mon solde » : le solde est relu à la demande (2 000 FCFA)");
    const before = norm(await payValidity.textContent());
    assert.match(before, /^Prix valable encore \d+ min \d+ s$/);
    for (const skew of [3_600_000, -3_600_000, 86_400_000, -86_400_000]) {
      await sellerPage.evaluate((value) => ((window as unknown as { __wallSkewMs: number }).__wallSkewMs = value), skew);
      await sellerPage.waitForTimeout(2_200);
      const during = norm(await payValidity.textContent());
      assert.match(during, /^Prix valable encore \d+ min \d+ s$/, `horloge murale décalée de ${skew} ms : « ${during} »`);
      assert.equal(await payBuy.isEnabled(), true, `« Acheter » reste actif (horloge murale décalée de ${skew} ms)`);
    }
    await sellerPage.evaluate(() => ((window as unknown as { __wallSkewMs: number }).__wallSkewMs = 0));
    const afterSkew = norm(await payValidity.textContent());
    assert.notEqual(afterSkew, before, "le compte à rebours avance");
    ok(`l'horloge murale décalée de +1 h, −1 h, +24 h, −24 h est SANS effet : « ${before} » puis « ${afterSkew} », « Acheter » toujours actif`);
    // Expiration à l'écran : l'horloge MONOTONE avance de 16 minutes (plus que la fenêtre de 15 min) → « Ce devis a expiré », achat impossible.
    await sellerPage.evaluate(() => ((window as unknown as { __perfSkewMs: number }).__perfSkewMs = 16 * 60_000));
    await sellerPage.getByText("Ce devis a expiré. Demandez-en un nouveau.").waitFor();
    assert.equal(await payBuy.isDisabled(), true, "« Acheter » désactivé quand le devis a expiré à l'écran");
    await sellerPage.getByRole("button", { name: "Demander un nouveau devis" }).waitFor();
    await shot(sellerPage, "18-annonce-devis-expire");
    await sellerPage.getByRole("button", { name: "Demander un nouveau devis" }).click();
    await sellerPage.waitForFunction(() => /^Prix valable encore/.test(document.querySelector("[data-testid=boost-validity]")?.textContent ?? ""));
    assert.equal(await payBuy.isEnabled(), true);
    ok("devis expiré à l'écran (horloge monotone +16 min) : « Ce devis a expiré », « Acheter » désactivé, « Demander un nouveau devis » → prix à nouveau valable, « Acheter » actif");

    step("Refus d'achat (409 simulés dans le navigateur) : message simple, devis redemandé ou solde relu, confirmation refermée");
    let quoteRequests = 0;
    let walletReads = 0;
    sellerPage.on("request", (request) => {
      if (request.method() === "POST" && /\/boost-quotes$/.test(request.url())) quoteRequests += 1;
      if (request.method() === "GET" && /\/api\/wallet(\?.*)?$/.test(request.url())) walletReads += 1;
    });
    let refusal = "";
    let refusalStatus = 409;
    await sellerPage.route(/\/api\/offers\/[0-9a-f-]{36}\/boost-purchases$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({ status: refusalStatus, contentType: "application/json", body: JSON.stringify({ error: { code: refusal, message: "TEXTE-DU-SERVEUR-NE-PAS-AFFICHER" } }) });
    });
    const refusals = [
      ["quote_expired", /^Ce devis a expiré\. Demandez un nouveau prix pour acheter\.$/, "quote"],
      ["quote_already_used", /^Ce devis a déjà servi/, "quote"],
      ["offer_already_boosted", /^Cette annonce est déjà boostée\.$/, "quote"],
      ["insufficient_balance", /^Solde insuffisant : rechargez votre porte-monnaie, puis réessayez\.$/, "balance"],
    ] as const;
    for (const [code, message, follow] of refusals) {
      refusal = code;
      const quotesBefore = quoteRequests;
      const walletBefore = walletReads;
      await payBuy.click();
      await expectingConsoleErrors(`409 ${code} simulé : journalisé par le navigateur`, /status of 409/, async () => {
        await sellerPage.getByTestId("boost-confirm-button").click();
        await sellerPage.getByTestId("boost-buy-error").waitFor();
      });
      const shown = norm(await sellerPage.getByTestId("boost-buy-error").textContent());
      assert.match(shown, message, code);
      assert.equal(shown.includes(code) || shown.includes("TEXTE-DU-SERVEUR"), false, `ni le code brut ni le texte du serveur (${code})`);
      assert.equal(await sellerPage.getByTestId("boost-confirm").count(), 0, `confirmation refermée (${code})`);
      if (follow === "quote") {
        await sellerPage.waitForTimeout(800);
        assert.equal(quoteRequests, quotesBefore + 1, `un nouveau devis est redemandé (${code})`);
        await sellerPage.getByTestId("boost-quote").waitFor();
        assert.equal(await payBuy.isEnabled(), true, `nouveau prix affiché, « Acheter » actif (${code})`);
      } else {
        await sellerPage.waitForTimeout(600);
        assert.equal(walletReads, walletBefore + 1, `le solde est relu (${code})`);
        assert.equal(quoteRequests, quotesBefore, `aucun nouveau devis (${code})`);
      }
      ok(`409 ${code} : « ${shown} » ; ${follow === "quote" ? "nouveau devis demandé" : "solde relu"}, confirmation refermée, aucun code brut`);
    }
    // Lot P2-bis (M7) : trop de requêtes (429) : message simple et fixe ; refus définitif (pas un résultat inconnu), la confirmation reste ouverte.
    refusalStatus = 429;
    refusal = "too_many_requests";
    await payBuy.click();
    await expectingConsoleErrors("429 simulé : journalisé par le navigateur", /status of 429/, async () => {
      await sellerPage.getByTestId("boost-confirm-button").click();
      await sellerPage.getByTestId("boost-buy-error").waitFor();
    });
    assert.equal(norm(await sellerPage.getByTestId("boost-buy-error").textContent()), "Trop de tentatives, réessayez dans un instant.");
    assert.equal(await sellerPage.getByTestId("boost-unresolved").count(), 0, "un 429 est un refus définitif : aucune « vérification » à proposer");
    await sellerPage.getByTestId("boost-cancel-button").click();
    await sellerPage.getByTestId("boost-confirm").waitFor({ state: "detached" });
    ok("429 simulé : « Trop de tentatives, réessayez dans un instant. » (jamais le texte du serveur), aucune vérification proposée, confirmation annulée");
    await sellerPage.unroute(/\/api\/offers\/[0-9a-f-]{36}\/boost-purchases$/);
    assert.equal(norm(await sellerPage.getByTestId("boost-balance-amount").textContent()), "2 000 FCFA", "aucun débit réel : ces refus étaient simulés dans le navigateur");

    step("Second onglet de A : même annonce, même devis (il sera périmé quand le premier onglet aura acheté)");
    const secondTab = await sellerContext.newPage();
    secondTab.setDefaultTimeout(60_000);
    watch(secondTab);
    openPages.push(secondTab);
    await secondTab.goto(`${BASE}${payOfferPath}`);
    await secondTab.getByTestId("boost-balance").waitFor();
    await secondTab.getByRole("group", { name: "Durée du boost" }).getByRole("button", { name: "3 jours", exact: true }).click();
    await secondTab.getByTestId("boost-amount").waitFor();
    const secondBuy = secondTab.getByRole("button", { name: "Acheter", exact: true });
    assert.equal(await secondBuy.isEnabled(), true);
    assert.equal(Number(norm(await secondTab.getByTestId("boost-amount").textContent()).replace(/\D/g, "")), quoteAmount, "même devis dans les deux onglets");
    ok("second onglet : le même devis (même prix) est affiché, « Acheter » actif");

    step("Un nouveau devis demandé pendant la confirmation : confirmation FERMÉE, « Acheter » désactivé jusqu'à l'arrivée du prix (lot P2-bis, S5)");
    let holdQuoteMs = 0;
    let heldQuotesDelivered = 0;
    await sellerPage.route(/\/api\/offers\/[0-9a-f-]{36}\/boost-quotes$/, async (route) => {
      if (route.request().method() !== "POST" || holdQuoteMs === 0) {
        await route.continue();
        return;
      }
      // Le serveur calcule le devis tout de suite ; la page ne reçoit la réponse que plus tard (réponse « partie avant » ce qui suit).
      const response = await route.fetch();
      await sleep(holdQuoteMs);
      await route.fulfill({ response });
      heldQuotesDelivered += 1;
    });
    holdQuoteMs = 2_500;
    await payBuy.click();
    await sellerPage.getByTestId("boost-confirm").waitFor();
    await payDurations.getByRole("button", { name: "3 jours", exact: true }).click();
    await sellerPage.getByTestId("boost-confirm").waitFor({ state: "detached", timeout: 1_500 });
    assert.equal(await payBuy.isDisabled(), true, "« Acheter » désactivé tant que le nouveau prix n'est pas arrivé");
    assert.equal(await sellerPage.getByTestId("boost-confirm-button").count(), 0, "plus de bouton « Confirmer l'achat » à cliquer");
    await waitUntil("arrivée du devis demandé", async () => heldQuotesDelivered >= 1);
    await sellerPage.waitForFunction(() => !document.querySelector("[data-testid=boost-buy]")?.hasAttribute("disabled"));
    assert.equal(await sellerPage.getByTestId("boost-confirm").count(), 0, "la confirmation ne se rouvre pas toute seule");
    assert.equal(await payBuy.isEnabled(), true);
    holdQuoteMs = 0;
    ok("« Acheter » → confirmation ouverte → autre devis demandé (réponse retenue 2,5 s) : confirmation refermée, « Acheter » désactivé, puis réactivé à l'arrivée du prix");

    step("Réponse d'achat perdue AVANT le serveur, devis expiré à l'écran : « Vérifier / réessayer » avec la MÊME clé ; un devis lent est ignoré après l'achat (S4, S5)");
    const purchaseBodies: string[] = [];
    let purchaseMode: "drop_before" | "drop_after" | "pass" = "drop_before";
    await sellerPage.route(/\/api\/offers\/[0-9a-f-]{36}\/boost-purchases$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      purchaseBodies.push(route.request().postData() ?? "");
      if (purchaseMode === "drop_before") {
        // La demande n'atteint jamais le serveur : rien n'est débité, la page ne le sait pas.
        await route.abort("failed");
        return;
      }
      if (purchaseMode === "drop_after") {
        // Le serveur traite la demande (le porte-monnaie est débité), mais la page ne reçoit jamais la réponse.
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await payBuy.click();
    const confirmText = norm(await sellerPage.getByTestId("boost-confirm-text").textContent());
    assert.equal(confirmText, `Vous allez payer ${fmt(quoteAmount)} pour un boost de 3 jours. Solde après achat : ${fmt(2_000 - quoteAmount)}.`);
    ok(`confirmation : « ${confirmText} »`);
    await shot(sellerPage, "19-achat-confirmation");
    const confirmButton = sellerPage.getByTestId("boost-confirm-button");
    const readsBeforeFailure = { ...reads };
    await expectingConsoleErrors("requête d'achat coupée avant le serveur", /net::ERR_FAILED/, async () => {
      await confirmButton.click();
      await sellerPage.getByTestId("boost-buy-error").waitFor();
    });
    assert.equal(norm(await sellerPage.getByTestId("boost-buy-error").textContent()), "Connexion impossible. Vérifiez votre réseau et réessayez.");
    assert.equal(await sellerPage.getByTestId("boost-success").count(), 0);
    // S4 : après TOUT échec, solde, achats et devis sont relus ; aucun achat retrouvé → « Pas encore enregistré : l'achat peut encore aboutir. » (lot P3 : jamais « aucun débit »,
    // le serveur peut enregistrer l'achat après coup) et « Vérifier / réessayer ».
    await sellerPage.waitForFunction(() => (document.querySelector("[data-testid=boost-unresolved]")?.textContent ?? "").includes("Pas encore enregistré : l'achat peut encore aboutir."));
    assert.equal((await sellerPage.getByTestId("boost-unresolved").textContent() ?? "").includes("aucun débit"), false, "jamais « aucun débit » : le débit peut encore arriver");
    assert.ok(reads.wallet > readsBeforeFailure.wallet && reads.purchases > readsBeforeFailure.purchases && reads.quotes > readsBeforeFailure.quotes, "solde, achats et devis relus après l'échec");
    const verifyButton = sellerPage.getByTestId("boost-verify");
    assert.equal(norm(await verifyButton.textContent()), "Vérifier / réessayer");
    const untouched = (await (await sellerContext.request.get(`${BASE}/api/wallet`)).json()) as { balanceXof: number };
    assert.equal(untouched.balanceXof, 2_000, "la demande n'a jamais atteint le serveur : aucun débit");
    ok("réponse perdue avant le serveur : « Connexion impossible… », solde/achats/devis relus, « Pas encore enregistré : l'achat peut encore aboutir. » (jamais « aucun débit ») + « Vérifier / réessayer », solde serveur 2 000 FCFA");
    await shot(sellerPage, "20-achat-reponse-perdue");
    // Le devis expire à l'écran (horloge monotone +16 min) : la vérification reste possible avec la MÊME clé (le serveur rejoue la clé).
    await sellerPage.evaluate(() => ((window as unknown as { __perfSkewMs: number }).__perfSkewMs += 16 * 60_000));
    await sellerPage.getByText("Ce devis a expiré. Demandez-en un nouveau.").waitFor();
    assert.equal(await payBuy.isDisabled(), true, "« Acheter » désactivé : le devis a expiré à l'écran");
    assert.equal(await verifyButton.isEnabled(), true, "« Vérifier / réessayer » reste proposé malgré l'expiration à l'écran");
    ok("devis expiré à l'écran (horloge monotone +16 min) : « Acheter » désactivé mais « Vérifier / réessayer » toujours proposé");
    // S5 : un devis demandé (réponse retenue 6 s, calculée AVANT l'achat) ne doit rien afficher une fois l'achat réussi.
    holdQuoteMs = 6_000;
    heldQuotesDelivered = 0;
    purchaseMode = "drop_after";
    await sellerPage.getByRole("button", { name: "Demander un nouveau devis" }).click();
    await expectingConsoleErrors("réponse d'achat perdue après le traitement par le serveur", /net::ERR_FAILED/, async () => {
      await verifyButton.dblclick();
      await sellerPage.getByTestId("boost-success").waitFor();
    });
    assert.equal(purchaseBodies.length, 2, `requêtes d'achat : 1 (avant le serveur) + 1 seule malgré le double clic sur « Vérifier / réessayer » = 2, reçu ${purchaseBodies.length}`);
    const [firstBody, secondBody] = purchaseBodies.map((body) => JSON.parse(body) as { quoteId: string; idempotencyKey: string });
    assert.equal(secondBody.idempotencyKey, firstBody.idempotencyKey, "même clé d'idempotence à la vérification");
    assert.equal(secondBody.quoteId, firstBody.quoteId);
    assert.deepEqual(Object.keys(secondBody).sort(), ["idempotencyKey", "quoteId"], "aucun montant dans la requête");
    assert.match(firstBody.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    ok("« Vérifier / réessayer » en double clic : UNE seule requête, même clé d'idempotence, aucun montant envoyé ; l'écran retrouve l'achat tout seul (la réponse avait été perdue)");
    assert.match(norm(await sellerPage.getByTestId("boost-success").textContent()), /^Boost actif jusqu'au \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}/);
    assert.equal(
      norm(await sellerPage.getByTestId("boost-success-note").textContent()),
      "Votre boost est actif : votre annonce peut monter dans les résultats des acheteurs concernés, avec le badge « Sponsorisé », parmi des offres déjà pertinentes. Ce n'est pas une garantie de position ni de vente.",
    );
    assert.equal(await sellerPage.getByTestId("boost-unresolved").count(), 0, "plus de « Vérifier / réessayer » une fois l'achat retrouvé");
    assert.equal(await sellerPage.getByTestId("boost-buy-error").count(), 0, "plus d'erreur périmée");
    assert.equal(norm(await sellerPage.getByTestId("boost-balance-amount").textContent()), fmt(2_000 - quoteAmount));
    const debited = (await (await sellerContext.request.get(`${BASE}/api/wallet`)).json()) as { balanceXof: number };
    assert.equal(debited.balanceXof, 2_000 - quoteAmount, "un seul débit côté serveur");
    assert.equal(await sellerPage.getByTestId("boost-quote").count(), 0, "le devis consommé n'est plus proposé");
    assert.equal(await sellerPage.getByRole("button", { name: "Acheter", exact: true }).count(), 0);
    await sellerPage.getByTestId("boost-purchase-row").first().waitFor();
    assert.equal(await sellerPage.getByTestId("boost-purchase-row").count(), 1, "un seul achat dans l'historique de l'annonce");
    assert.match(norm(await sellerPage.getByTestId("boost-purchase-row").first().innerText()), new RegExp(`^3 jours · ${fmt(quoteAmount).replace(/ /g, "\\s")} Acheté le \\d{2}/\\d{2}/\\d{4} à \\d{2}:\\d{2} · jusqu'au`));
    assert.equal(await sellerPage.getByTestId("boost-purchase-refunded").count(), 0);
    // Le devis acheté est consommé : l'historique des devis le dit (« Acheté »), jamais « En cours de validité ».
    await sellerPage.getByTestId("boost-history").getByText("Acheté", { exact: true }).waitFor();
    assert.equal(await sellerPage.getByTestId("boost-history").getByText("En cours de validité", { exact: true }).count(), 0, "aucun devis consommé n'est dit « en cours de validité »");
    ok(`« Boost actif jusqu'au … » + précision « Ce n'est pas une garantie de position ni de vente » ; solde ${fmt(2_000 - quoteAmount)} ; 1 ligne d'achat ; le devis acheté est « Acheté » dans l'historique des devis`);
    await shot(sellerPage, "21-achat-boost-actif");
    // Le devis lent (calculé avant l'achat, « disponible ») arrive après le succès : il est ignoré.
    await waitUntil("arrivée du devis lent", async () => heldQuotesDelivered >= 1, 15_000);
    await sleep(800);
    assert.equal(await sellerPage.getByTestId("boost-quote").count(), 0, "la réponse tardive d'un devis ne s'affiche pas après un achat réussi");
    assert.equal(await sellerPage.getByRole("button", { name: "Acheter", exact: true }).count(), 0, "aucun « Acheter » sur une annonce déjà boostée");
    assert.equal(await sellerPage.getByTestId("boost-success").count(), 1, "le succès reste affiché");
    holdQuoteMs = 0;
    ok("le devis demandé AVANT l'achat (réponse retenue 6 s, « disponible ») arrive après le succès : ignoré, aucun prix ni « Acheter » affiché");
    await sellerPage.unroute(/\/api\/offers\/[0-9a-f-]{36}\/boost-purchases$/);
    await sellerPage.unroute(/\/api\/offers\/[0-9a-f-]{36}\/boost-quotes$/);

    step("Second onglet (écran périmé) : « Acheter » → 409 quote_already_used → l'écran se réconcilie (achat retrouvé), jamais deux débits (S4)");
    let secondPosts = 0;
    secondTab.on("request", (request) => {
      if (request.method() === "POST" && /\/boost-purchases$/.test(request.url())) secondPosts += 1;
    });
    assert.equal(await secondBuy.isEnabled(), true, "l'onglet périmé ne sait pas que le devis est acheté");
    await secondBuy.click();
    await expectingConsoleErrors("409 quote_already_used réel (second onglet)", /status of 409/, async () => {
      await secondTab.getByTestId("boost-confirm-button").click();
      await secondTab.getByTestId("boost-success").waitFor();
    });
    assert.equal(secondPosts, 1, "une seule tentative d'achat dans le second onglet");
    assert.match(norm(await secondTab.getByTestId("boost-success").textContent()), /^Boost actif jusqu'au \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}/);
    assert.equal(await secondTab.getByTestId("boost-buy-error").count(), 0, "aucune erreur périmée affichée");
    assert.equal(norm(await secondTab.getByTestId("boost-balance-amount").textContent()), fmt(2_000 - quoteAmount), "solde exact dans le second onglet");
    await secondTab.getByTestId("boost-purchase-row").first().waitFor();
    assert.equal(await secondTab.getByTestId("boost-purchase-row").count(), 1);
    assert.equal(await secondTab.getByRole("button", { name: "Acheter", exact: true }).count(), 0);
    const afterSecond = (await (await sellerContext.request.get(`${BASE}/api/wallet`)).json()) as { balanceXof: number };
    assert.equal(afterSecond.balanceXof, 2_000 - quoteAmount, "toujours UN seul débit côté serveur");
    const purchasesAfter = (await (await sellerContext.request.get(`${BASE}/api/offers/${payOfferId}/boost-purchases`)).json()) as { purchases: unknown[] };
    assert.equal(purchasesAfter.purchases.length, 1);
    ok("second onglet : 409 « quote_already_used » → « Boost actif jusqu'au … » (achat retrouvé), plus d'erreur, solde exact, 1 seul achat et 1 seul débit côté serveur");
    await shot(secondTab, "21b-second-onglet-reconcilie");
    await secondTab.close();
    openPages.splice(openPages.indexOf(secondTab), 1);

    step("« Mon porte-monnaie » : un SEUL débit malgré la réponse perdue et le double clic ; montants signés colorés");
    await sellerPage.getByTestId("boost-balance").getByRole("link", { name: "Mon porte-monnaie" }).click();
    await sellerPage.waitForURL((url) => url.pathname === "/compte/porte-monnaie" && url.searchParams.get("next") === payOfferPath);
    await sellerPage.getByTestId("wallet-row").first().waitFor();
    assert.equal(norm(await sellerPage.getByTestId("wallet-balance").textContent()), fmt(2_000 - quoteAmount));
    const rows = sellerPage.getByTestId("wallet-row");
    assert.equal(await rows.count(), 2, "deux lignes : l'achat et la recharge");
    assert.equal(await sellerPage.locator("[data-testid=wallet-row][data-kind=boost_purchase]").count(), 1, "UN seul achat de boost");
    assert.equal(await sellerPage.locator("[data-testid=wallet-row][data-kind=topup]").count(), 1);
    const purchaseRow = rows.nth(0);
    const topupRow = rows.nth(1);
    assert.match(norm(await purchaseRow.innerText()), new RegExp(`^Achat de boost \\d{2}/\\d{2}/\\d{4} à \\d{2}:\\d{2} −${fmt(quoteAmount).replace(/ /g, "\\s")}$`));
    assert.match(norm(await topupRow.innerText()), /^Recharge \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2} \+2 000 FCFA$/);
    const colorOf = (row: typeof rows) => row.getByTestId("wallet-row-amount").evaluate((element) => getComputedStyle(element).color);
    const debitColor = await colorOf(purchaseRow);
    const creditColor = await colorOf(topupRow);
    assert.equal(creditColor, "rgb(14, 95, 59)", "crédit en vert (forest)");
    assert.equal(debitColor, "rgb(194, 65, 12)", "débit en orange foncé (carrot-ink)");
    assert.equal(await purchaseRow.getByTestId("wallet-row-amount").getAttribute("data-tone"), "debit");
    assert.equal(await topupRow.getByTestId("wallet-row-amount").getAttribute("data-tone"), "credit");
    const walletText = await sellerPage.locator("main").innerText();
    for (const raw of ["boost_purchase", "topup", "boost_refund", "adjustment"]) assert.equal(walletText.includes(raw), false, `aucun code brut « ${raw} »`);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(walletText), false, "aucun identifiant à l'écran");
    ok(`solde ${fmt(2_000 - quoteAmount)} ; historique : « Achat de boost −${fmt(quoteAmount)} » (orange) puis « Recharge +2 000 FCFA » (vert), une seule ligne d'achat, aucun code brut`);
    await shot(sellerPage, "22-porte-monnaie-historique");
    await sellerPage.getByRole("link", { name: "Retour" }).click();
    await sellerPage.waitForURL(`**${payOfferPath}`);
    ok("le retour du porte-monnaie ramène à l'annonce (retour mémorisé par `next`)");

    step("Acheteur B : « Actualiser » → l'offre de A est « Sponsorisé » en tête");
    await buyerPage.getByRole("button", { name: "Actualiser" }).click();
    await buyerPage.getByText("Sponsorisé", { exact: true }).waitFor();
    assert.equal(await buyerPage.getByText("Sponsorisé", { exact: true }).count(), 1);
    assert.equal(await cards.first().getAttribute("data-sponsored"), "true");
    assert.ok((await cards.first().innerText()).includes("190"), "la carte sponsorisée est la seconde offre de A (190 000 FCFA)");
    assert.equal(await cards.count(), payTotal, "le boost n'ajoute ni ne retire aucune offre");
    const buyerResults = await buyerPage.locator("main").innerText();
    for (const secret of ["boost_purchase", "Achat de boost", "Porte-monnaie", "Solde"]) assert.equal(buyerResults.includes(secret), false, `B ne voit pas « ${secret} »`);
    ok("B : badge « Sponsorisé » sur l'offre achetée par A (en tête), aucune trace d'achat ni de solde côté acheteur");
    await shot(buyerPage, "23-acheteur-sponsorise-apres-achat");

    step("Échec simulé : message clair, aucun crédit, lien pour réessayer (retour mémorisé) ; clé de recharge conservée dans l'onglet (M5) ; 429 (M7)");
    await sellerPage.goto(`${BASE}/compte/porte-monnaie?recharger=1&next=${encodeURIComponent(payOfferPath)}`);
    await sellerPage.getByTestId("topup-panel").waitFor();
    // Création de la recharge : 1er essai refusé en 429 (message simple, M7), 2e essai dont la réponse est PERDUE (le serveur a créé l'intention),
    // puis rechargement de la page (M5 : la clé est conservée dans l'onglet), 3e essai : la MÊME clé d'idempotence aux trois essais (une seule intention).
    const topupBodies: string[] = [];
    let topupMode: "too_many" | "drop_after" | "pass" = "too_many";
    await sellerPage.route(/\/api\/wallet\/topups$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      topupBodies.push(route.request().postData() ?? "");
      if (topupMode === "too_many") {
        await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "too_many_requests", message: "TEXTE-DU-SERVEUR-NE-PAS-AFFICHER" } }) });
        return;
      }
      if (topupMode === "drop_after") {
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    const storedTopupKeys = () =>
      sellerPage.evaluate(() => Object.entries(window.sessionStorage).filter(([name]) => name.startsWith("noma:topup-key:")));
    await sellerPage.getByTestId("topup-preset-5000").click();
    await expectingConsoleErrors("création de recharge refusée en 429 (simulé)", /status of 429/, async () => {
      await sellerPage.getByTestId("topup-submit").click();
      await sellerPage.getByTestId("topup-error").waitFor();
    });
    assert.equal(norm(await sellerPage.getByTestId("topup-error").textContent()), "Trop de tentatives, réessayez dans un instant.");
    ok("recharge : 429 simulé → « Trop de tentatives, réessayez dans un instant. » (jamais le texte du serveur)");
    topupMode = "drop_after";
    await expectingConsoleErrors("création de recharge coupée exprès", /net::ERR_FAILED/, async () => {
      await sellerPage.getByTestId("topup-submit").click();
      await sellerPage.waitForFunction(() => /Connexion impossible/.test(document.querySelector("[data-testid=topup-error]")?.textContent ?? ""));
    });
    assert.equal(norm(await sellerPage.getByTestId("topup-error").textContent()), "Connexion impossible. Vérifiez votre réseau et réessayez.");
    assert.equal(await sellerPage.getByTestId("topup-submit").isEnabled(), true, "nouvel essai possible");
    const keysAfterLoss = await storedTopupKeys();
    assert.equal(keysAfterLoss.length, 1, `une clé de recharge conservée dans l'onglet : ${JSON.stringify(keysAfterLoss)}`);
    assert.equal(keysAfterLoss[0][0], "noma:topup-key:5000", "clé conservée PAR MONTANT");
    assert.equal(keysAfterLoss[0][1], (JSON.parse(topupBodies[0]) as { idempotencyKey: string }).idempotencyKey, "la clé conservée est celle des essais");
    await sellerPage.reload();
    await sellerPage.getByTestId("topup-panel").waitFor();
    topupMode = "pass";
    await sellerPage.getByTestId("topup-preset-5000").click();
    await sellerPage.getByTestId("topup-submit").click();
    await sellerPage.waitForURL((url) => url.pathname.startsWith("/paiement-simule/"));
    assert.equal(topupBodies.length, 3, `trois requêtes de création (429, réponse perdue, après rechargement) : ${topupBodies.length}`);
    const [firstTopup, secondTopup, thirdTopup] = topupBodies.map((body) => JSON.parse(body) as { amountXof: number; idempotencyKey: string });
    assert.equal(firstTopup.amountXof, 5_000);
    assert.equal(secondTopup.idempotencyKey, firstTopup.idempotencyKey, "même clé d'idempotence au nouvel essai de la recharge");
    assert.equal(thirdTopup.idempotencyKey, firstTopup.idempotencyKey, "même clé APRÈS un rechargement de la page (clé conservée dans l'onglet)");
    assert.deepEqual(Object.keys(thirdTopup).sort(), ["amountXof", "idempotencyKey"]);
    assert.match(firstTopup.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await sellerPage.unroute(/\/api\/wallet\/topups$/);
    ok("création de recharge : refus 429, réponse perdue, puis rechargement de la page et nouvel essai avec la MÊME clé d'idempotence (clé conservée dans l'onglet, une seule intention côté serveur)");
    await sellerPage.getByTestId("sim-fail").click();
    await sellerPage.getByTestId("sim-result").waitFor();
    assert.equal(await sellerPage.getByTestId("sim-result").getAttribute("data-kind"), "failed");
    // M5 : la recharge est terminée (échouée) : la clé du montant est oubliée, la prochaine recharge de 5 000 FCFA aura une clé neuve.
    await waitUntil("clé de recharge effacée à l'état terminal", async () => (await storedTopupKeys()).length === 0);
    ok("recharge terminée (échec simulé) : la clé conservée dans l'onglet est effacée");
    assert.match(norm(await sellerPage.getByTestId("sim-result").textContent()), /Le paiement a échoué\. Votre porte-monnaie n'a pas été crédité\. Vous pouvez réessayer\./);
    assert.equal(await sellerPage.getByTestId("sim-confirm").count(), 0);
    const retry = sellerPage.getByTestId("sim-retry");
    assert.equal(norm(await retry.textContent()), "Réessayer la recharge");
    assert.equal(await retry.getAttribute("href"), `/compte/porte-monnaie?recharger=1&next=${encodeURIComponent(payOfferPath)}`);
    ok("« Faire échouer le paiement » : « Le paiement a échoué. Votre porte-monnaie n'a pas été crédité. », lien « Réessayer la recharge » (panneau ouvert, retour mémorisé)");
    await shot(sellerPage, "24-paiement-simule-echoue");
    // Lot P3-bis (N4) : recharger la page d'une recharge ÉCHOUÉE (déjà terminée avant cette visite) : « terminée sans paiement », jamais d'alarme ni de crédit.
    await sellerPage.reload();
    await sellerPage.getByTestId("sim-result").waitFor();
    assert.equal(await sellerPage.getByTestId("sim-result").getAttribute("data-kind"), "failed");
    const failedReloaded = norm(await sellerPage.getByTestId("sim-result").textContent());
    assert.ok(failedReloaded.includes("Cette recharge est terminée sans paiement : aucun montant n'a été crédité."), failedReloaded);
    assert.equal(failedReloaded.includes("Le paiement a échoué"), false, "rechargée : plus le message de l'échec vécu sur la page");
    assert.equal(failedReloaded.includes("a été crédité de"), false);
    ok("rechargement de la page d'une recharge ÉCHOUÉE : « Cette recharge est terminée sans paiement : aucun montant n'a été crédité. » (lot P3-bis, N4)");
    await retry.click();
    await sellerPage.getByTestId("wallet-balance").waitFor();
    assert.equal(norm(await sellerPage.getByTestId("wallet-balance").textContent()), fmt(2_000 - quoteAmount));
    assert.equal(await sellerPage.getByTestId("wallet-row").count(), 2, "un paiement échoué n'ajoute aucune ligne");
    ok(`après l'échec : solde inchangé (${fmt(2_000 - quoteAmount)}), historique inchangé (2 lignes)`);

    step("Retour sûr : une adresse `next` hostile n'est jamais suivie ; recharge inconnue : message clair");
    await sellerPage.getByTestId("topup-preset-1000").click();
    await sellerPage.getByTestId("topup-submit").click();
    await sellerPage.waitForURL((url) => url.pathname.startsWith("/paiement-simule/"));
    const hostileId = new URL(sellerPage.url()).pathname.split("/").pop() as string;
    // Lot P2-bis (M9) : CHAQUE valeur hostile est vérifiée sur sa propre recharge (une recharge ne se confirme qu'une fois) : la première est celle de
    // 1 000 FCFA créée dans le navigateur, les autres sont créées par l'API (500 FCFA).
    const hostileValues = ["https://evil.example/x", "//evil.example/x", "javascript:alert(1)", "/connexion"];
    const hostileTopupIds = [hostileId];
    for (let index = 1; index < hostileValues.length; index += 1) {
      const created = await sellerContext.request.post(`${BASE}/api/wallet/topups`, { headers: { origin: BASE }, data: { amountXof: 500, idempotencyKey: randomUUID() } });
      assert.equal(created.status(), 201);
      hostileTopupIds.push(((await created.json()) as { topup: { id: string } }).topup.id);
    }
    const hostileExtra = hostileValues.length - 1;
    const checkedHostile: string[] = [];
    for (const [index, hostile] of hostileValues.entries()) {
      await sellerPage.goto(`${BASE}/paiement-simule/${hostileTopupIds[index]}?next=${encodeURIComponent(hostile)}`);
      await sellerPage.getByTestId("sim-confirm").waitFor();
      assert.equal(await sellerPage.getByTestId("sim-banner").isVisible(), true, `bandeau visible (next = ${hostile})`);
      await sellerPage.getByTestId("sim-confirm").click();
      await sellerPage.getByTestId("sim-return").waitFor();
      const safeHref = await sellerPage.getByTestId("sim-return").getAttribute("href");
      assert.equal(safeHref, "/compte/porte-monnaie", `valeur next « ${hostile} » : lien de retour ${safeHref}`);
      assert.equal(norm(await sellerPage.getByTestId("sim-return").textContent()), "Voir mon porte-monnaie", `texte du lien (next = ${hostile})`);
      const allHrefs = await sellerPage.locator("main a").evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).getAttribute("href") ?? ""));
      assert.equal(allHrefs.some((href) => /evil|javascript:|^\/\//.test(href)), false, `aucun lien hostile (next = ${hostile}) : ${allHrefs.join(" ")}`);
      checkedHostile.push(hostile);
      info(`next = « ${hostile} » : lien de retour « ${safeHref} », aucun lien hostile`);
    }
    assert.deepEqual(checkedHostile, hostileValues, "toutes les valeurs hostiles ont été vérifiées une à une");
    ok(`CHAQUE valeur \`next\` hostile vérifiée séparément (${hostileValues.map((value) => `« ${value} »`).join(", ")}) : le lien de retour reste « /compte/porte-monnaie » (jamais l'adresse reçue)`);
    await sellerPage.getByTestId("sim-return").click();
    await sellerPage.getByTestId("wallet-row").first().waitFor();
    assert.equal(norm(await sellerPage.getByTestId("wallet-balance").textContent()), fmt(2_000 - quoteAmount + 1_000 + hostileExtra * 500));
    assert.equal(await sellerPage.getByTestId("wallet-row").count(), 3 + hostileExtra);
    ok(`recharges de 1 000 FCFA et de ${hostileExtra} × 500 FCFA réussies : solde ${fmt(2_000 - quoteAmount + 1_000 + hostileExtra * 500)}, ${3 + hostileExtra} lignes`);
    await expectingConsoleErrors("recharge inconnue : 404 journalisé par le navigateur", /status of 404/, async () => {
      await sellerPage.goto(`${BASE}/paiement-simule/6f1d4f5c-9d2e-4d8e-8f56-0a8b9f0a1b2c`);
      await sellerPage.getByTestId("sim-result").waitFor();
    });
    assert.equal(await sellerPage.getByTestId("sim-result").getAttribute("data-kind"), "not_found");
    assert.equal(norm(await sellerPage.getByTestId("sim-result").textContent()), "Cette recharge est introuvable.");
    assert.equal(await sellerPage.getByTestId("sim-banner").isVisible(), true);
    ok("recharge inconnue : « Cette recharge est introuvable. », bandeau SIMULATION toujours visible, aucun bouton de paiement");
    await shot(sellerPage, "25-paiement-simule-introuvable");
    await sellerPage.goto(`${BASE}/compte`);
    await sellerPage.getByRole("link", { name: "Mon porte-monnaie" }).waitFor();
    await sellerPage.getByRole("link", { name: "Mon porte-monnaie" }).click();
    await sellerPage.waitForURL("**/compte/porte-monnaie");
    await sellerPage.getByTestId("wallet-balance").waitFor();
    ok("« Mon compte » → « Mon porte-monnaie » : le lien d'accès fonctionne");
    await sellerPage.goto(`${BASE}/vendeur/profil`);
    await sellerPage.getByRole("link", { name: "Mon porte-monnaie" }).click();
    await sellerPage.waitForURL((url) => url.pathname === "/compte/porte-monnaie" && url.searchParams.get("next") === "/vendeur/profil");
    ok("espace vendeur (« Compte ») → « Mon porte-monnaie » : lien d'accès, retour vers le profil vendeur");

    step("Historique long : « Voir plus » par curseur (20 lignes par page)");
    const extraTopups = 20;
    for (let index = 0; index < extraTopups; index += 1) {
      const created = await sellerContext.request.post(`${BASE}/api/wallet/topups`, {
        headers: { origin: BASE },
        data: { amountXof: 500, idempotencyKey: randomUUID() },
      });
      assert.equal(created.status(), 201);
      const topupId = ((await created.json()) as { topup: { id: string } }).topup.id;
      const confirmed = await sellerContext.request.post(`${BASE}/api/dev/fake-payments/${topupId}/confirm`, { headers: { origin: BASE } });
      assert.equal(confirmed.status(), 200);
    }
    await sellerPage.goto(`${BASE}/compte/porte-monnaie`);
    await sellerPage.getByTestId("wallet-row").first().waitFor();
    assert.equal(await sellerPage.getByTestId("wallet-row").count(), 20, "première page : 20 lignes");
    const more = sellerPage.getByRole("button", { name: "Voir plus", exact: true });
    await more.waitFor();
    assert.equal(norm(await sellerPage.getByTestId("wallet-balance").textContent()), fmt(2_000 - quoteAmount + 1_000 + hostileExtra * 500 + extraTopups * 500));
    await sellerPage.route(/\/api\/wallet\?.*cursor=/, async (route) => {
      await sleep(1_000);
      await route.continue();
    });
    await more.click();
    assert.equal(await sellerPage.getByRole("button", { name: "Chargement…", exact: true }).isDisabled(), true, "« Voir plus » désactivé pendant le chargement");
    await sellerPage.waitForFunction((expected) => document.querySelectorAll("[data-testid=wallet-row]").length === expected, 3 + hostileExtra + extraTopups);
    assert.equal(await sellerPage.getByRole("button", { name: "Voir plus", exact: true }).count(), 0, "plus de « Voir plus » une fois tout affiché");
    assert.equal(await sellerPage.locator("[data-testid=wallet-row][data-kind=topup]").count(), 2 + hostileExtra + extraTopups, `${2 + hostileExtra + extraTopups} recharges, sans doublon ni oubli`);
    assert.equal(await sellerPage.locator("[data-testid=wallet-row][data-kind=boost_purchase]").count(), 1, "toujours UN seul achat de boost");
    await sellerPage.unroute(/\/api\/wallet\?.*cursor=/);
    ok(`${3 + hostileExtra + extraTopups} lignes : 20 sur la première page, « Voir plus » (curseur, bouton désactivé pendant le chargement) ajoute les ${3 + hostileExtra + extraTopups - 20} dernières, sans doublon`);
    await shot(sellerPage, "26-porte-monnaie-voir-plus");

    step("Type d'opération inconnu (version future du serveur) : la ligne s'affiche « Opération » avec son montant, l'historique n'est pas rejeté (M10)");
    await sellerPage.route(/\/api\/wallet(\?.*)?$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { transactions: unknown[] };
      body.transactions.unshift({ id: randomUUID(), kind: "cadeau_surprise", amountXof: 300, createdAt: new Date().toISOString() });
      await route.fulfill({ response, json: body });
    });
    await sellerPage.goto(`${BASE}/compte/porte-monnaie`);
    await sellerPage.getByTestId("wallet-row").first().waitFor();
    assert.match(norm(await sellerPage.getByTestId("wallet-row").first().innerText()), /^Opération \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2} \+300 FCFA$/);
    assert.equal((await sellerPage.locator("main").innerText()).includes("cadeau_surprise"), false, "le code brut du serveur n'atteint jamais l'écran");
    assert.equal(await sellerPage.getByTestId("wallet-row").count(), 21, "le reste de l'historique s'affiche (20 lignes de la page + la ligne inconnue)");
    await sellerPage.unroute(/\/api\/wallet(\?.*)?$/);
    ok("type d'opération inconnu : ligne « Opération … +300 FCFA » (jamais le code brut), le reste de l'historique reste affiché");

    step("Achat RETENU côté serveur (3,5 s) alors que la réponse est perdue : « Pas encore enregistré », relectures automatiques à 2 s, 5 s, 10 s, puis l'achat apparaît tout seul ; UN seul débit (lot P3, C)");
    // Remboursement d'administration de l'achat précédent : l'annonce est de nouveau achetable et le crédit rendu.
    const earlier = (await (await sellerContext.request.get(`${BASE}/api/offers/${payOfferId}/boost-purchases`)).json()) as { purchases: Array<{ id: string }> };
    assert.equal(earlier.purchases.length, 1, "un achat à rembourser");
    const refundLine = await refundPurchaseByAdministration(earlier.purchases[0].id, "essai_retenu");
    assert.match(refundLine, /remboursé/);
    ok(`boost:refund-purchase (base noma_e2e) : ${refundLine.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, "<id>")}`);
    const balanceBefore = ((await (await sellerContext.request.get(`${BASE}/api/wallet`)).json()) as { balanceXof: number }).balanceXof;
    await sellerPage.goto(`${BASE}${payOfferPath}`);
    await payDurations.getByRole("button", { name: "3 jours", exact: true }).click();
    await sellerPage.getByTestId("boost-amount").waitFor();
    const retainedAmount = Number(norm(await sellerPage.getByTestId("boost-amount").textContent()).replace(/\D/g, ""));
    assert.ok(retainedAmount > 0 && balanceBefore >= retainedAmount, `solde ${balanceBefore} couvre le prix ${retainedAmount}`);
    const retainedMs = 3_500;
    const retainedBodies: string[] = [];
    const retainedServer: Array<Promise<number>> = [];
    await sellerPage.route(/\/api\/offers\/[0-9a-f-]{36}\/boost-purchases$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      // La page ne reçoit rien (réponse perdue) ; le serveur reçoit la MÊME requête 3,5 s plus tard : l'achat n'existe pas encore quand l'écran relit les achats.
      retainedBodies.push(route.request().postData() ?? "");
      const url = route.request().url();
      const body = route.request().postData() ?? "";
      retainedServer.push((async () => {
        await new Promise((resolve) => setTimeout(resolve, retainedMs));
        return (await sellerContext.request.post(url, { data: body, headers: { "content-type": "application/json", origin: new URL(BASE).origin } })).status();
      })());
      await route.abort("failed");
    });
    let purchasesReads = 0;
    sellerPage.on("response", (response) => {
      if (response.request().method() === "GET" && /\/api\/offers\/[0-9a-f-]{36}\/boost-purchases(\?.*)?$/.test(response.url())) purchasesReads += 1;
    });
    await payBuy.click();
    const retainedStartedAt = Date.now();
    await expectingConsoleErrors("achat retenu : réponse perdue", /net::ERR_FAILED/, async () => {
      await sellerPage.getByTestId("boost-confirm-button").click();
      await sellerPage.getByTestId("boost-unresolved").waitFor();
    });
    const unresolvedText = norm(await sellerPage.getByTestId("boost-unresolved").textContent());
    assert.ok(unresolvedText.includes("Pas encore enregistré : l'achat peut encore aboutir."), unresolvedText);
    assert.equal(unresolvedText.includes("aucun débit"), false, "jamais « aucun débit » : l'achat peut encore aboutir");
    assert.equal(await sellerPage.getByTestId("boost-success").count(), 0, "à ce moment, l'achat n'existe pas côté serveur");
    const readsAtFailure = purchasesReads;
    ok(`réponse perdue, achat encore absent du serveur : « ${unresolvedText.slice(0, 70)}… » (pas de « aucun débit »)`);
    await shot(sellerPage, "27-achat-retenu-pas-encore-enregistre");
    // Aucun clic : l'écran relit les achats tout seul (2 s, 5 s, 10 s) ; l'achat est enregistré par le serveur à 3,5 s et apparaît à la relecture de 5 s.
    await sellerPage.getByTestId("boost-success").waitFor({ timeout: 15_000 }).catch(() => {
      throw new Error("ACHAT RETENU : l'écran n'a pas retrouvé l'achat tout seul (relectures automatiques à 2 s, 5 s, 10 s absentes ou inopérantes)");
    });
    const found = (Date.now() - retainedStartedAt) / 1000;
    assert.ok(found >= 3.5 && found <= 12, `succès affiché après ${found.toFixed(1)} s (achat serveur à 3,5 s, relecture à 5 s)`);
    assert.ok(purchasesReads - readsAtFailure >= 1, `relectures automatiques des achats : ${purchasesReads - readsAtFailure}`);
    assert.match(norm(await sellerPage.getByTestId("boost-success").textContent()), /^Boost actif jusqu'au \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}/);
    assert.deepEqual(await Promise.all(retainedServer), [201], "une seule requête d'achat : celle du serveur, 201");
    assert.equal(retainedBodies.length, 1, "la page n'a envoyé qu'UNE requête d'achat : les relectures automatiques sont de simples lectures");
    const afterRetained = ((await (await sellerContext.request.get(`${BASE}/api/wallet`)).json()) as { balanceXof: number }).balanceXof;
    assert.equal(afterRetained, balanceBefore - retainedAmount, "UN seul débit");
    await sellerPage.getByTestId("boost-balance-amount").waitFor();
    await waitUntil("solde relu à l'écran", async () => norm(await sellerPage.getByTestId("boost-balance-amount").textContent()) === fmt(afterRetained));
    ok(`achat retenu : l'écran retrouve l'achat TOUT SEUL après ${found.toFixed(1)} s (aucun clic), une seule requête d'achat, un seul débit (${fmt(retainedAmount)}), solde ${fmt(afterRetained)}`);
    await shot(sellerPage, "28-achat-retenu-retrouve");
    await sellerPage.unroute(/\/api\/offers\/[0-9a-f-]{36}\/boost-purchases$/);

    step("Devis périmé (lot P3-bis, N1) : un autre vendeur D achète en premier ; A (devis « disponible » calculé avant) est refusé à l'achat, redemande un devis et obtient un devis INDISPONIBLE au texte neutre : plus aucune boucle");
    const apiOrigin = new URL(BASE).origin;
    // Libère l'annonce de A : les achats non remboursés sont remboursés par l'administration (le boost acheté est annulé, le crédit rendu).
    const heldPurchases = (await (await sellerContext.request.get(`${BASE}/api/offers/${payOfferId}/boost-purchases`)).json()) as { purchases: Array<{ id: string; refundedAt: string | null }> };
    for (const held of heldPurchases.purchases.filter((purchase) => purchase.refundedAt === null)) await refundPurchaseByAdministration(held.id, "essai_boucle");
    // Vendeur D (par l'API) : une annonce du MÊME produit (189 000 FCFA, juste moins chère que A), du crédit, un devis disponible.
    const sellerD = new RelaySession("vendeur D");
    const dApi = sellerD.client();
    await loginWithOtp(sellerD, uniquePhone("55"));
    const dBuilt = buildOfferInput({
      title: `${payProduct.brand} ${payProduct.model} · offre de D`, description: "", category: payProduct.category, brand: payProduct.brand, model: payProduct.model,
      variant: "", condition: "Occasion", location: "Abidjan", price: "189 000", available: true,
    });
    assert.ok(dBuilt.ok);
    const dCreated = await dApi.offers.create(dBuilt.input);
    const dOffer = await dApi.offers.publish(dCreated.id, dCreated.contentVersion);
    const dTopup = await dApi.wallet.createTopup({ amountXof: 5_000, idempotencyKey: randomUUID() });
    await dApi.devPayments.confirm(dTopup.topup.id);
    // A : crédit suffisant (recharge simulée par l'API) ; le besoin de B voit l'offre de D (10 offres : quota 1, aucun boost actif).
    const aTopup = await sellerContext.request.post(`${BASE}/api/wallet/topups`, { data: { amountXof: 5_000, idempotencyKey: randomUUID() }, headers: { origin: apiOrigin } });
    assert.equal(aTopup.status(), 201);
    const aTopupId = ((await aTopup.json()) as { topup: { id: string } }).topup.id;
    assert.equal((await sellerContext.request.post(`${BASE}/api/dev/fake-payments/${aTopupId}/confirm`, { headers: { origin: apiOrigin } })).status(), 200);
    await buyerPage.goto(payResultsUrl);
    await refreshUntil(buyerPage, "l'offre de D dans les résultats de B (10 offres)", async () => (await cards.count()) >= payTotal + 1);
    ok(`D : annonce à 189 000 FCFA et crédit 5 000 FCFA ; B voit ${payTotal + 1} offres (les 8 d'exemple, A et D), aucun boost actif`);
    // A (navigateur) : devis 24 h DISPONIBLE, calculé AVANT l'achat de D.
    await sellerPage.goto(`${BASE}${payOfferPath}`);
    await payDurations.getByRole("button", { name: "24 h", exact: true }).click();
    await sellerPage.getByTestId("boost-amount").waitFor();
    const staleAmount = norm(await sellerPage.getByTestId("boost-amount").textContent());
    assert.equal(await payBuy.isEnabled(), true, "A : « Acheter » actif sur un devis disponible");
    await shot(sellerPage, "28a-devis-avant-achat-de-d");
    // D achète d'abord : sa place mise en avant est prise (quota 1, ancienneté).
    const dQuote = await dApi.boostQuotes.create(dOffer.id, "24h");
    assert.equal(dQuote.status, "available", `devis de D : ${dQuote.status} ${String(dQuote.unavailableReason)}`);
    const dBought = await dApi.boostPurchases.create(dOffer.id, { quoteId: dQuote.id, idempotencyKey: randomUUID() });
    assert.equal(dBought.purchase.reused, false);
    ok(`D achète son boost de 24 h (${dBought.purchase.amountXof} FCFA) : le quota de la liste de B est pris`);
    // A achète avec son devis périmé : 409, message neutre, un SEUL nouveau devis est demandé, il est INDISPONIBLE ; aucune boucle.
    const loopPosts: string[] = [];
    const onRequest = (request: import("../poc/node_modules/playwright").Request) => {
      if (request.method() === "POST" && /boost-(quotes|purchases)$/.test(request.url())) loopPosts.push(request.url().split("/").pop()!);
    };
    sellerPage.on("request", onRequest);
    await expectingConsoleErrors("achat refusé 409 no_visible_effect (vrai refus du serveur)", /status of 409/, async () => {
      await payBuy.click();
      await sellerPage.getByTestId("boost-confirm-button").click();
      await sellerPage.getByTestId("boost-unavailable").waitFor();
    });
    const NO_EFFECT_PURCHASE = "Ce boost ne ferait plus monter votre annonce chez aucun acheteur (place déjà occupée par un boost acheté plus tôt, ou liste trop courte). Aucun débit. Demandez un nouveau prix plus tard.";
    const NO_EFFECT_QUOTE = "Pour le moment, un boost ne ferait monter votre annonce chez aucun acheteur : leurs listes sont trop courtes, ou la place mise en avant y est déjà occupée par un boost acheté plus tôt.";
    assert.equal(norm(await sellerPage.getByTestId("boost-buy-error").textContent()), NO_EFFECT_PURCHASE, "texte du refus d'achat (neutre)");
    assert.equal(norm(await sellerPage.getByTestId("boost-unavailable").textContent()), NO_EFFECT_QUOTE, "texte du devis (neutre)");
    assert.equal(await sellerPage.getByTestId("boost-quote").getAttribute("data-status"), "unavailable", "le devis redemandé n'est PLUS « disponible »");
    assert.equal(await sellerPage.getByTestId("boost-amount").count(), 0, "aucun prix");
    assert.equal(await payBuy.count(), 0, "plus aucun bouton « Acheter » : la boucle est rompue");
    assert.equal(norm(await sellerPage.getByTestId("boost-quote").textContent()).includes(staleAmount), false, "l'ancien prix n'est plus affiché");
    assert.deepEqual(loopPosts, ["boost-purchases", "boost-quotes"], `une demande d'achat refusée puis UN seul devis redemandé : ${loopPosts.join(",")}`);
    await sleep(4_000);
    assert.deepEqual(loopPosts, ["boost-purchases", "boost-quotes"], "aucune requête de plus pendant 4 s : aucune boucle");
    sellerPage.off("request", onRequest);
    ok("A : « Acheter » → 409 « Ce boost ne ferait plus monter… (place déjà occupée… ou liste trop courte). Aucun débit. » ; le devis redemandé est INDISPONIBLE (texte neutre), aucun « Acheter », 2 requêtes seulement (achat, devis), aucune boucle");
    await shot(sellerPage, "28c-devis-perime-sans-boucle");
    // Redemander encore : le devis indisponible (60 s) est renvoyé tel quel (200, reused), jamais un devis « disponible » ; le solde de A n'a pas bougé.
    const again = await sellerContext.request.post(`${BASE}/api/offers/${payOfferId}/boost-quotes`, { data: { durationCode: "24h" }, headers: { origin: apiOrigin } });
    const againBody = (await again.json()) as { quote: { status: string; unavailableReason: string | null; reused: boolean } };
    assert.deepEqual([again.status(), againBody.quote.status, againBody.quote.unavailableReason, againBody.quote.reused], [200, "unavailable", "no_visible_effect", true]);
    ok("redemander le devis : 200, indisponible (aucun effet visible), réutilisé — jamais le devis « disponible » périmé");

    step("Deux onglets qui partagent une clé de recharge : la recharge payée dans l'un ne s'affiche JAMAIS « créditée » dans l'autre sans paiement (lot P3, D)");
    const topupKey = "noma:topup-key:2000";
    const sellerBalance = async () => ((await (await sellerContext.request.get(`${BASE}/api/wallet`)).json()) as { balanceXof: number }).balanceXof;
    const balanceStart = await sellerBalance();
    const tab1 = sellerPage;
    await tab1.goto(`${BASE}/compte/porte-monnaie?recharger=1`);
    await tab1.getByTestId("topup-panel").waitFor();
    await tab1.getByTestId("topup-preset-2000").click();
    await tab1.getByTestId("topup-submit").click();
    await tab1.waitForURL((url) => url.pathname.startsWith("/paiement-simule/"));
    const sharedKey = await tab1.evaluate((name) => window.sessionStorage.getItem(name), topupKey);
    assert.match(String(sharedKey), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "l'onglet 1 conserve la clé de la recharge de 2 000 FCFA");
    const firstTopupId = new URL(tab1.url()).pathname.split("/").pop()!;
    // Onglet 2 = un onglet DUPLIQUÉ : il hérite du sessionStorage de l'onglet 1 (donc de la même clé).
    const tab2 = await sellerContext.newPage();
    openPages.push(tab2);
    watch(tab2);
    const tab2Posts: string[] = [];
    await tab2.route(/\/api\/wallet\/topups$/, async (route) => {
      if (route.request().method() === "POST") tab2Posts.push(route.request().postData() ?? "");
      await route.continue();
    });
    await tab2.goto(`${BASE}/compte/porte-monnaie?recharger=1`);
    await tab2.getByTestId("topup-panel").waitFor();
    await tab2.evaluate(([name, value]) => window.sessionStorage.setItem(name, value), [topupKey, String(sharedKey)]);
    // L'onglet 1 PAIE : « crédité » à juste titre.
    await tab1.getByTestId("sim-confirm").click();
    await tab1.getByTestId("sim-result").waitFor();
    assert.equal(norm(await tab1.getByTestId("sim-result").textContent()), `Votre porte-monnaie a été crédité de ${fmt(2_000)}.`);
    assert.equal(await sellerBalance(), balanceStart + 2_000, "recharge payée dans l'onglet 1 : +2 000 FCFA");
    // Lot P3-bis (N4) : celui qui vient de payer recharge la page : « déjà créditée… une seule fois », jamais « n'a rien ajouté » (alarmant, faux pour lui) ni un second crédit.
    await tab1.reload();
    await tab1.getByTestId("sim-result").waitFor();
    assert.equal(await tab1.getByTestId("sim-result").getAttribute("data-kind"), "succeeded");
    const paidReloaded = norm(await tab1.getByTestId("sim-result").textContent());
    assert.equal(paidReloaded, `Cette recharge a déjà été créditée sur votre porte-monnaie (${fmt(2_000)}, une seule fois).`, "rechargement après paiement : « déjà créditée »");
    assert.equal(paidReloaded.includes("n'a rien ajouté"), false, "plus de message alarmant");
    assert.equal(paidReloaded.includes("a été crédité de"), false, "« a été crédité de » reste réservé au paiement fait sur la page");
    assert.equal(await sellerBalance(), balanceStart + 2_000, "recharger la page ne crédite rien de plus");
    ok("rechargement de la page APRÈS le paiement : « Cette recharge a déjà été créditée sur votre porte-monnaie (2 000 FCFA, une seule fois). », solde inchangé (lot P3-bis, N4)");
    await shot(tab1, "28b-recharge-payee-rechargee");
    // L'onglet 2 (même clé) demande une NOUVELLE recharge de 2 000 FCFA : l'intention de la clé est déjà TERMINÉE ailleurs → clé neuve, nouvelle intention, à payer.
    await tab2.getByTestId("topup-preset-2000").click();
    await tab2.getByTestId("topup-submit").click();
    await tab2.waitForURL((url) => url.pathname.startsWith("/paiement-simule/") && !url.pathname.endsWith(firstTopupId));
    await tab2.getByTestId("sim-confirm").waitFor();
    assert.equal(tab2Posts.length, 2, `deux créations dans l'onglet 2 (clé partagée puis clé neuve) : ${tab2Posts.length}`);
    const [sharedPost, freshPost] = tab2Posts.map((body) => JSON.parse(body) as { amountXof: number; idempotencyKey: string });
    assert.equal(sharedPost.idempotencyKey, sharedKey, "premier envoi : la clé partagée");
    assert.notEqual(freshPost.idempotencyKey, sharedKey, "second envoi : clé NEUVE");
    assert.equal(await tab2.getByTestId("sim-result").count(), 0, "ONGLET 2 : aucun « crédité » : la page propose de PAYER");
    assert.equal((await tab2.locator("main").innerText()).includes("a été crédité"), false, "ONGLET 2 : jamais « crédité » sans paiement");
    assert.equal(await sellerBalance(), balanceStart + 2_000, "rien n'est crédité tant que l'onglet 2 n'a pas payé");
    ok("onglet 2 (clé partagée, recharge déjà payée dans l'onglet 1) : clé neuve, nouvelle recharge à payer (« Confirmer le paiement »), aucun « crédité », solde inchangé");
    await shot(tab2, "29-deux-onglets-nouvelle-recharge");
    await tab2.getByTestId("sim-confirm").click();
    await tab2.getByTestId("sim-result").waitFor();
    assert.equal(norm(await tab2.getByTestId("sim-result").textContent()), `Votre porte-monnaie a été crédité de ${fmt(2_000)}.`, "payée ici : « crédité »");
    assert.equal(await sellerBalance(), balanceStart + 4_000);
    // Rouvrir la page de l'ANCIENNE recharge (déjà terminée avant la visite) : jamais « crédité ».
    await tab2.goto(`${BASE}/paiement-simule/${firstTopupId}`);
    await tab2.getByTestId("sim-result").waitFor();
    const reopened = norm(await tab2.getByTestId("sim-result").textContent());
    assert.equal(await tab2.getByTestId("sim-result").getAttribute("data-kind"), "succeeded");
    assert.equal(reopened, `Cette recharge a déjà été créditée sur votre porte-monnaie (${fmt(2_000)}, une seule fois).`, "RECHARGE DÉJÀ TERMINÉE rouverte : « déjà créditée… une seule fois »");
    assert.equal(reopened.includes("a été crédité de"), false, "RECHARGE DÉJÀ TERMINÉE rouverte : jamais la phrase du paiement immédiat");
    assert.equal(reopened.includes("n'a rien ajouté"), false, "plus de message alarmant");
    assert.equal(await sellerBalance(), balanceStart + 4_000, "rouvrir la page ne crédite rien");
    ok("page d'une recharge déjà terminée rouverte : « Cette recharge a déjà été créditée sur votre porte-monnaie (… une seule fois). » (jamais « a été crédité de »), solde inchangé");
    await tab2.unroute(/\/api\/wallet\/topups$/);
    await tab2.close();

    await sellerContext.close();
    await buyerContext.close();

    assert.deepEqual(pageErrors, [], `erreurs de page : ${pageErrors.join(" | ")}`);
    const hydration = consoleErrors.filter((text) => /hydrat/i.test(text));
    assert.deepEqual(hydration, [], `erreurs d'hydratation : ${hydration.join(" | ")}`);
    assert.deepEqual(consoleErrors, [], `messages console error inattendus : ${consoleErrors.map((text) => text.slice(0, 160)).join(" || ")}`);
    ok("aucune exception de page, aucune erreur d'hydratation, aucun message console error inattendu (hors 401/403 d'accès refusé et les messages que le test provoque lui-même : requête coupée, 409 simulés, recharge inconnue)");
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
