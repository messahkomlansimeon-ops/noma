/**
 * `npm run e2e:pay` (lot PAY1) : une RECHARGE par le prestataire « sublymus » (Wave), dans un vrai navigateur (Chrome piloté par Playwright, 390 px de large), contre un vrai serveur
 * Next lancé par `npm run dev:try` À TRAVERS LE RELAIS, configuré avec NOMA_PAYMENT_PROVIDER=sublymus et branché sur une FAUSSE API Sublymus LOCALE (scripts/sublymus-fake-api.ts,
 * démarrée par ce script, boucle locale). AUCUN appel réel à Sublymus ni à Wave : clé, secret et identifiants sont INVENTÉS par le lanceur. NON inclus dans `npm test`. Parcours :
 *   1. l'écran dit « Paiement par Wave », Wave seulement, sans parler de simulation ;
 *   2. choix d'un montant : le navigateur est REDIRIGÉ vers le lien Wave de la fausse API (page Wave interceptée localement) ; la session créée porte la référence noma-topup-<intention>,
 *      les splits dont la somme vaut le montant, des adresses de retour sur NOMA_PUBLIC_URL ;
 *   3. retour du navigateur (adresses de succès ET d'échec) : « Paiement en cours de confirmation », le solde reste à 0 (le retour ne crédite jamais) ;
 *   4. webhook SYNTHÉTIQUE signé avec le secret de test : 200, la page de retour passe à « Paiement confirmé », le solde est crédité UNE fois ; le rejeu ne crédite pas ;
 *      une signature fausse est refusée (401) ; un montant modifié ne crédite rien ;
 *   5. page /admin/paiements (l'administrateur est créé par admin:grant) : la recharge payée, l'anomalie « montant différent » à traiter (sans donnée personnelle), puis marquée traitée ;
 *   6. wallet:check sans écart ; ni la clé ni le secret dans la sortie du serveur.
 * Variables (posées par le lanceur) : NOMA_E2E_BASE_URL (relais), NOMA_E2E_SERVER_LOG, NOMA_E2E_DATABASE_URL, NOMA_E2E_PAY_API_KEY, NOMA_E2E_PAY_MANAGER_ID, NOMA_E2E_PAY_WALLET_ID,
 * NOMA_E2E_PAY_SECRET, NOMA_E2E_PAY_FAKE_PORT, NOMA_E2E_SHOTS, NOMA_E2E_CHROME.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { E2E_BASE, E2E_SERVER_LOG, awaitOtpLine, e2eDatabaseUrl, uniquePhone, walletCheckByAdministration } from "./e2e-common";
import { startFakeSublymusApi, type FakeIntent } from "./sublymus-fake-api";

const require = createRequire(import.meta.url);
const { chromium } = require("../poc/node_modules/playwright") as typeof import("../poc/node_modules/playwright");
type Page = import("../poc/node_modules/playwright").Page;

const BASE = E2E_BASE;
const SHOTS = process.env.NOMA_E2E_SHOTS ?? "/var/tmp/noma-pay1-shots";
const CHROME = process.env.NOMA_E2E_CHROME ?? "/usr/bin/google-chrome-stable";
const VIEWPORT = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } as const;

const API_KEY = process.env.NOMA_E2E_PAY_API_KEY ?? "";
const MANAGER_ID = process.env.NOMA_E2E_PAY_MANAGER_ID ?? "";
const WALLET_ID = process.env.NOMA_E2E_PAY_WALLET_ID ?? "";
const SECRET = process.env.NOMA_E2E_PAY_SECRET ?? "";
const FAKE_PORT = Number(process.env.NOMA_E2E_PAY_FAKE_PORT ?? "0");

if (!E2E_SERVER_LOG || !API_KEY || !MANAGER_ID || !WALLET_ID || !SECRET || !FAKE_PORT) {
  console.error("e2e:pay : NOMA_E2E_SERVER_LOG et NOMA_E2E_PAY_* (clé, gestionnaire, portefeuille, secret, port de la fausse API) sont requis.");
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
    if (message.type() === "error" && !/status of 40[134]/.test(message.text()) && !/Failed to load resource/.test(message.text())) consoleErrors.push(message.text());
  });
}

async function loginViaUi(page: Page, localPhone: string, next: string): Promise<void> {
  await page.goto(`${BASE}/connexion?next=${encodeURIComponent(next)}`);
  await page.getByPlaceholder("07 00 00 00 42").fill(localPhone);
  const offset = statSync(E2E_SERVER_LOG).size;
  await page.getByRole("button", { name: /Recevoir un code/ }).click();
  await page.waitForURL("**/verification");
  const { code } = await awaitOtpLine(offset);
  await page.getByLabel(/Code reçu par SMS/).fill(code);
  await page.getByRole("button", { name: "Vérifier", exact: true }).click();
  await page.waitForURL((url) => url.pathname === next.split("?")[0], { timeout: 60_000 });
}

const wallet = (page: Page) => page.evaluate(async () => {
  const response = await fetch("/api/wallet");
  return (await response.json()) as { balanceXof: number; paymentMode: string; transactions: Array<{ kind: string; amountXof: number }> };
});

/** COMMANDE D'ADMINISTRATION `admin:grant` sur la base noma_e2e (le seul moyen d'attribuer le rôle). */
function grantAdminRole(phone: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", DATABASE_URL: e2eDatabaseUrl(), NODE_OPTIONS: "--conditions=react-server" };
    const child = spawn(process.execPath, ["--import", "./poc/node_modules/tsx/dist/loader.mjs", "scripts/admin-grant.ts", phone], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => reject(new Error("admin:grant : lancement impossible")));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`admin:grant a refusé ou échoué (code ${code}) : ${out.trim().slice(0, 200)}`))));
  });
}

async function postWebhook(signed: { body: string; headers: Record<string, string> }): Promise<{ status: number; text: string }> {
  const response = await fetch(`${BASE}/api/webhooks/sublymus`, { method: "POST", headers: signed.headers, body: signed.body });
  return { status: response.status, text: await response.text() };
}

async function main(): Promise<void> {
  const api = await startFakeSublymusApi({ apiKey: API_KEY, managerId: MANAGER_ID, walletId: WALLET_ID, port: FAKE_PORT, requireHttpsUrls: false });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const context = await browser.newContext({ ...VIEWPORT });
    // La page de Wave n'existe pas ici : l'adresse du faux lien est interceptée et servie localement (aucun accès au réseau).
    await context.route("https://pay.wave.example/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Wave (essai)</title><h1 data-testid=\"fake-wave\">Fausse page Wave</h1>" }));
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    watch(page);
    const digits = uniquePhone("91").replace("+225", "");
    const local = `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 6)} ${digits.slice(6, 8)} ${digits.slice(8, 10)}`;

    step("Compte neuf : porte-monnaie, prestataire actif Wave");
    await loginViaUi(page, local, "/compte/porte-monnaie");
    assert.equal((await wallet(page)).paymentMode, "sublymus");
    assert.equal((await wallet(page)).balanceXof, 0);
    await page.goto(`${BASE}/compte/porte-monnaie?recharger=1`);
    const notice = page.getByTestId("topup-provider-notice");
    await notice.waitFor();
    assert.equal(await notice.getAttribute("data-provider"), "sublymus");
    const noticeText = (await notice.innerText()).replace(/\s+/g, " ");
    assert.match(noticeText, /^Paiement par Wave : vous êtes redirigé vers Wave pour payer/);
    assert.match(noticeText, /Wave seulement : pas d'Orange Money ni de MTN/);
    assert.equal(/simul/i.test(noticeText), false, "aucune promesse de simulation avec le vrai prestataire");
    assert.equal(await page.getByTestId("topup-simulation-notice").count(), 0);
    ok("l'écran dit « Paiement par Wave », Wave seulement, sans parler de simulation");

    step("Recharge de 5 000 FCFA : redirection vers le lien Wave de la fausse API");
    await page.getByTestId("topup-preset-5000").click();
    await Promise.all([
      page.waitForURL(/^https:\/\/pay\.wave\.example\/c\/pi_[0-9a-f]+$/),
      page.getByTestId("topup-submit").click(),
    ]);
    await page.getByTestId("fake-wave").waitFor();
    const created = [...api.intents.values()].at(-1) as FakeIntent;
    assert.equal(page.url(), created.waveCheckoutUrl);
    assert.equal(api.requests.filter((entry) => entry.method === "POST").length, 1, "une seule session ouverte");
    const sent = api.requests.filter((entry) => entry.method === "POST").at(-1)!;
    assert.equal(sent.authorization, `Bearer ${API_KEY}`);
    const body = sent.body as Record<string, unknown>;
    assert.equal(body.amount, 5_000);
    assert.match(String(body.external_reference), /^noma-topup-[0-9a-f-]{36}$/);
    const splits = body.splits as Array<Record<string, unknown>>;
    assert.equal(splits.reduce((sum, split) => sum + Number(split.amount), 0), 5_000);
    assert.equal(splits[0].wallet_id, WALLET_ID);
    const intentId = String(body.external_reference).slice("noma-topup-".length);
    assert.equal(body.success_url, `${BASE}/paiement-retour/${intentId}?resultat=succes`);
    assert.equal(body.error_url, `${BASE}/paiement-retour/${intentId}?resultat=echec`);
    ok(`redirigé vers ${created.waveCheckoutUrl.replace(/pi_[0-9a-f]+/, "pi_…")} ; session : 5 000 FCFA, référence noma-topup-<intention>, splits = montant, retours sur l'adresse publique`);

    step("Retour du navigateur (succès, puis échec) : « Paiement en cours de confirmation », rien n'est crédité");
    await page.goto(String(body.success_url));
    const result = page.getByTestId("return-result");
    await result.waitFor();
    assert.equal(await result.getAttribute("data-kind"), "pending");
    assert.equal((await page.getByTestId("return-title").innerText()).trim(), "Paiement en cours de confirmation");
    assert.match((await result.innerText()).replace(/\s+/g, " "), /Montant : 5\s000\sFCFA/);
    await page.screenshot({ path: `${SHOTS}/01-retour-en-cours.png` });
    await sleep(7_000);
    assert.equal(await result.getAttribute("data-kind"), "pending", "toujours en attente : aucun crédit sans confirmation authentifiée");
    assert.equal((await wallet(page)).balanceXof, 0);
    await page.goto(String(body.error_url));
    await result.waitFor();
    assert.equal(await result.getAttribute("data-kind"), "pending");
    assert.match((await result.innerText()).replace(/\s+/g, " "), /ne semble pas avoir abouti/);
    assert.equal((await wallet(page)).balanceXof, 0);
    ok("retours de succès et d'échec : « Paiement en cours de confirmation », solde à 0 après plusieurs relectures");

    step("Webhook synthétique : signature fausse refusée, montant modifié sans crédit, puis webhook valide : solde crédité UNE fois");
    const good = api.webhook({ intent: created, secret: SECRET, webhookId: `wh_e2e_${Date.now()}` });
    const forged = { body: good.body, headers: { ...good.headers, "x-wave-signature": "0".repeat(64) } };
    const refused = await postWebhook(forged);
    assert.equal(refused.status, 401);
    assert.deepEqual(JSON.parse(refused.text), { error: { code: "unauthorized", message: "Non autorisé." } });
    const tampered = api.webhook({ intent: created, secret: SECRET, data: { amount: 4_999 }, webhookId: `wh_e2e_amount_${Date.now()}` });
    assert.equal((await postWebhook(tampered)).status, 200);
    assert.equal((await wallet(page)).balanceXof, 0, "un montant modifié ne crédite rien");
    await page.goto(String(body.success_url));
    await result.waitFor();
    assert.equal(await result.getAttribute("data-kind"), "pending");
    const accepted = await postWebhook(good);
    assert.equal(accepted.status, 200);
    assert.deepEqual(JSON.parse(accepted.text), { received: true });
    await page.waitForFunction(() => document.querySelector('[data-testid="return-result"]')?.getAttribute("data-kind") === "succeeded", undefined, { timeout: 30_000 });
    assert.equal((await page.getByTestId("return-title").innerText()).trim(), "Paiement confirmé");
    assert.match((await result.innerText()).replace(/\s+/g, " "), /crédité de 5\s000\sFCFA, une seule fois/);
    await page.screenshot({ path: `${SHOTS}/02-retour-confirme.png` });
    assert.equal((await wallet(page)).balanceXof, 5_000);
    ok("signature fausse : 401 sans détail ; montant modifié : aucun crédit ; webhook valide : « Paiement confirmé », solde 5 000 FCFA");

    step("Rejeu du webhook : un seul crédit ; le porte-monnaie affiche la recharge");
    for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await postWebhook(good)).status, 200);
    const afterReplay = await wallet(page);
    assert.equal(afterReplay.balanceXof, 5_000);
    assert.equal(afterReplay.transactions.filter((entry) => entry.kind === "topup").length, 1);
    await page.goto(`${BASE}/compte/porte-monnaie`);
    await page.getByTestId("wallet-balance").waitFor();
    assert.match((await page.getByTestId("wallet-balance").innerText()).replace(/\s+/g, " "), /^5\s000\sFCFA$/);
    await page.screenshot({ path: `${SHOTS}/03-porte-monnaie.png` });
    ok("3 rejeux : toujours 5 000 FCFA, une seule recharge dans l'historique");

    step("Administration des paiements : recharge payée, anomalie « montant différent » à traiter (sans donnée personnelle), puis traitée");
    await grantAdminRole(`+225${digits}`);
    await page.goto(`${BASE}/admin`);
    await page.getByTestId("admin-payments-link").click();
    await page.waitForURL("**/admin/paiements");
    await page.getByTestId("admin-payments").waitFor();
    assert.equal(await page.getByTestId("admin-payments-provider").getAttribute("data-provider"), "sublymus");
    assert.match((await page.getByTestId("admin-payments-provider").innerText()).trim(), /Wave via Sublymus/);
    assert.equal((await page.getByTestId("admin-payments-open-count").innerText()).trim(), "(1)");
    assert.equal(await page.locator('[data-testid="admin-payments-anomaly"][data-kind="amount_mismatch"]').count(), 1);
    const anomalyText = (await page.getByTestId("admin-payments-anomaly").innerText()).replace(/\s+/g, " ");
    assert.match(anomalyText, /Montant différent de la recharge/);
    assert.match(anomalyText, /attendu 5\s000\sFCFA/);
    assert.match(anomalyText, /reçu 4\s999\sFCFA/);
    assert.equal(await page.locator('[data-testid="admin-payments-intent"][data-status="succeeded"]').count(), 1);
    const adminText = await page.evaluate(() => document.body.innerText);
    for (const personal of [digits, local, `noma-topup-${intentId}`, intentId, API_KEY, SECRET, MANAGER_ID]) assert.equal(adminText.includes(personal), false, `donnée interne affichée : ${personal.slice(0, 8)}…`);
    assert.match((await page.getByTestId("admin-payments-webhooks").innerText()).replace(/\s+/g, " "), /Webhooks Sublymus : \d+ reçu\(s\) ces dernières 24 h/);
    assert.equal(await page.getByTestId("admin-payments-catchup").getAttribute("data-warn"), "false");
    await page.screenshot({ path: `${SHOTS}/04-admin-paiements.png` });
    await page.getByTestId("admin-payments-resolve").click();
    await page.getByTestId("admin-payments-no-anomaly").waitFor();
    assert.equal((await page.getByTestId("admin-payments-open-count").innerText()).trim(), "(0)");
    ok("/admin/paiements : recharge payée, anomalie « montant différent » (5 000 attendus, 4 999 reçus) sans aucune donnée personnelle, marquée traitée");

    step("Contrôles : wallet:check sans écart ; ni la clé ni le secret dans la sortie du serveur ; aucune erreur dans le navigateur");
    const report = await walletCheckByAdministration();
    assert.match(report, /aucun écart/);
    const serverLog = readFileSync(E2E_SERVER_LOG, "utf8");
    assert.equal(serverLog.includes(API_KEY), false, "la clé de l'API n'est jamais écrite par le serveur");
    assert.equal(serverLog.includes(SECRET), false, "le secret de signature n'est jamais écrit par le serveur");
    assert.deepEqual(pageErrors, [], "aucune exception de page");
    assert.deepEqual(consoleErrors, [], "aucune erreur de console");
    ok("wallet:check : aucun écart ; clé et secret absents du journal du serveur ; aucune erreur de page ni de console");
  } finally {
    await browser.close().catch(() => {});
    await api.close();
  }
  console.log(`\ne2e:pay : ${checks} vérifications réussies. Captures dans ${SHOTS}.`);
}

main().catch((error: unknown) => {
  console.error(`e2e:pay : ÉCHEC — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
