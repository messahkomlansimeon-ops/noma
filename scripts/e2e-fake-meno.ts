/**
 * FAUX serveur Meno pour les essais navigateur (lot SMS1) : aucun appel réel, aucune vraie clé. Lancé AVANT `dev:try` par le script d'essai (voir SMS.md) ; le serveur de l'application
 * est ensuite lancé avec NOMA_SMS_PROVIDER=meno, NOMA_SMS_API_KEY=<la clé d'essai> et NOMA_SMS_BASE_URL=<l'adresse écrite par ce script>. Les scripts `e2e:core`, `e2e:ui` et `e2e:demo` lisent alors
 * les codes OTP dans le fichier NOMA_E2E_MENO_CAPTURE (une ligne JSON {at,to,content} par SMS accepté).
 *
 * Variables : NOMA_E2E_FAKE_MENO_KEY (clé d'essai attendue, obligatoire), NOMA_E2E_MENO_CAPTURE (fichier de capture, obligatoire),
 *             NOMA_E2E_FAKE_MENO_URL_FILE (fichier où écrire l'adresse de base, obligatoire). S'arrête sur SIGINT/SIGTERM.
 */
import { writeFileSync } from "node:fs";
import { isValidSmsApiKey } from "../lib/server/sms/config";
import { startFakeMeno } from "../tests/server/fake-meno";

async function main(): Promise<void> {
  const apiKey = process.env.NOMA_E2E_FAKE_MENO_KEY ?? "";
  const captureFile = process.env.NOMA_E2E_MENO_CAPTURE ?? "";
  const urlFile = process.env.NOMA_E2E_FAKE_MENO_URL_FILE ?? "";
  if (!isValidSmsApiKey(apiKey) || captureFile === "" || urlFile === "") {
    console.error("e2e-fake-meno : NOMA_E2E_FAKE_MENO_KEY (clé d'essai valide), NOMA_E2E_MENO_CAPTURE et NOMA_E2E_FAKE_MENO_URL_FILE sont requis.");
    process.exitCode = 2;
    return;
  }
  writeFileSync(captureFile, "");
  const fake = await startFakeMeno({ apiKey, captureFile });
  writeFileSync(urlFile, fake.baseUrl);
  console.log(`e2e-fake-meno prêt : ${fake.baseUrl} (capture ${captureFile})`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await fake.close();
}

main().catch(() => {
  console.error("e2e-fake-meno : erreur inattendue.");
  process.exitCode = 1;
});
