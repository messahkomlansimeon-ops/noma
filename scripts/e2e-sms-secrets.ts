/**
 * Contrôle automatique « la clé du fournisseur n'apparaît nulle part où elle ne doit pas » (lot SMS1), exécuté APRÈS un essai navigateur lancé avec le faux serveur Meno :
 *  - aucun fichier JavaScript servi au navigateur (pages principales et leurs scripts) ne contient la clé d'essai, le nom des variables SMS, ni l'adresse du fournisseur ;
 *  - ni la sortie du serveur (NOMA_E2E_SERVER_LOG) ni le fichier de capture du faux serveur ne contiennent la clé d'essai.
 * Variables : NOMA_E2E_DIRECT_URL (Next, adresse directe), NOMA_E2E_FAKE_MENO_KEY, NOMA_E2E_SERVER_LOG, NOMA_E2E_MENO_CAPTURE. Code de sortie 1 au moindre indice.
 */
import { readFileSync } from "node:fs";

const direct = (process.env.NOMA_E2E_DIRECT_URL ?? "").replace(/\/$/, "");
const key = process.env.NOMA_E2E_FAKE_MENO_KEY ?? "";
const serverLog = process.env.NOMA_E2E_SERVER_LOG ?? "";
const capture = process.env.NOMA_E2E_MENO_CAPTURE ?? "";
const PAGES = ["/", "/connexion", "/verification", "/vendeur", "/admin", "/admin/sms", "/notifications", "/favoris", "/messages", "/commandes", "/compte"];
const FORBIDDEN = ["NOMA_SMS_API_KEY", "NOMA_SMS_PROVIDER", "NOMA_SMS_BASE_URL", "meno.sublymus", "Idempotency-Key"];

async function main(): Promise<void> {
  if (!direct || !key || !serverLog || !capture) throw new Error("variables manquantes");
  const scripts = new Set<string>();
  for (const page of PAGES) {
    const response = await fetch(`${direct}${page}`, { redirect: "manual" }).catch(() => null);
    if (!response) continue;
    const html = await response.text();
    for (const match of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+\.js[^"]*)"/g)) scripts.add(match[1]);
    for (const match of html.matchAll(/\/_next\/static\/[^"'\\ ]+\.js/g)) scripts.add(match[0]);
    if (html.includes(key)) throw new Error(`la clé apparaît dans la page ${page}`);
  }
  let bytes = 0;
  for (const path of scripts) {
    const response = await fetch(`${direct}${path}`).catch(() => null);
    if (!response || !response.ok) continue;
    const text = await response.text();
    bytes += text.length;
    if (text.includes(key)) throw new Error(`la clé apparaît dans le script ${path.slice(0, 80)}`);
    for (const word of FORBIDDEN) if (text.includes(word)) throw new Error(`« ${word} » apparaît dans le script ${path.slice(0, 80)}`);
  }
  if (scripts.size < 5) throw new Error(`trop peu de scripts contrôlés (${scripts.size})`);
  for (const [label, path] of [["la sortie du serveur", serverLog], ["le fichier de capture", capture]] as const) {
    if (readFileSync(path, "utf8").includes(key)) throw new Error(`la clé apparaît dans ${label}`);
  }
  console.log(`e2e-sms-secrets : ${scripts.size} scripts (${bytes} caractères) et ${PAGES.length} pages contrôlés ; la clé d'essai n'apparaît ni dans le navigateur, ni dans la sortie du serveur, ni dans la capture.`);
}

main().catch((error: unknown) => {
  console.error(`e2e-sms-secrets : ÉCHEC : ${error instanceof Error ? error.message : "erreur"}`);
  process.exitCode = 1;
});
