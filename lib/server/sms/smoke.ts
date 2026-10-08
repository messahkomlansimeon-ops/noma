import "server-only";

import { randomBytes } from "node:crypto";
import { isMenoActive, menoInactiveReason, readSmsConfig, type Environment } from "./config";
import { SMOKE_MESSAGE } from "./messages";
import { resolveMenoSender, type SmsSender } from "./sender";
import { isAllowedRecipient, maskRecipient } from "./validation";

/**
 * `npm run sms:smoke -- --to +225XXXXXXXXXX --confirm-real-send` (lot SMS1) : envoi RÉEL d'UN SMS de test (15 F CFA). Réservé au fondateur, avec son accord. Aucune option par défaut :
 * il ne s'exécute que si LES DEUX options sont présentes, que la clé est définie (NOMA_SMS_PROVIDER=meno + NOMA_SMS_API_KEY), que DATABASE_URL est définie (l'envoi est journalisé
 * comme tous les autres) et que NODE_ENV n'est pas « test ». Chaque lancement est un nouvel envoi (nouvelle clé d'idempotence `smoke-…`). Jamais d'affichage de la clé ni du numéro.
 */

export const SMOKE_CONFIRM_OPTION = "--confirm-real-send";

export type SmokeArguments = { ok: true; to: string } | { ok: false; reason: string };

/** Lecture stricte des arguments : `--to <numéro>` (ou `--to=<numéro>`) et `--confirm-real-send`, rien d'autre. */
export function parseSmokeArguments(argv: readonly string[]): SmokeArguments {
  let to: string | null = null;
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === SMOKE_CONFIRM_OPTION) {
      confirmed = true;
    } else if (argument === "--to") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { ok: false, reason: "--to attend un numéro au format +225XXXXXXXXXX." };
      to = value;
      index += 1;
    } else if (argument.startsWith("--to=")) {
      to = argument.slice("--to=".length);
    } else {
      return { ok: false, reason: "argument inconnu. Usage : npm run sms:smoke -- --to +225XXXXXXXXXX --confirm-real-send" };
    }
  }
  if (!confirmed) return { ok: false, reason: `envoi RÉEL (15 F CFA) : ajoutez ${SMOKE_CONFIRM_OPTION} pour confirmer. Aucun SMS n'a été envoyé.` };
  if (to === null || !isAllowedRecipient(to)) return { ok: false, reason: "--to doit être un numéro ivoirien au format +225XXXXXXXXXX (10 chiffres). Aucun SMS n'a été envoyé." };
  return { ok: true, to };
}

/** Refus de l'environnement (texte fixe, sans valeur) ou null. */
export function smokeEnvironmentRefusal(env: Environment): string | null {
  if (env.NODE_ENV === "test") return "refus : NODE_ENV=test (aucun vrai SMS depuis les tests).";
  const config = readSmsConfig(env);
  if (config.provider !== "meno") return "refus : NOMA_SMS_PROVIDER doit valoir meno.";
  if (config.apiKey === null) return "refus : NOMA_SMS_API_KEY est absente.";
  if (!isMenoActive(config)) return `refus : ${menoInactiveReason(config) ?? "configuration SMS inactive"}.`;
  if ((env.DATABASE_URL ?? "").trim() === "") return "refus : DATABASE_URL est requise (l'envoi est journalisé dans sms_sends ; migration 0024 appliquée).";
  return null;
}

export interface SmokeDependencies {
  sender?: SmsSender;
  write?: (line: string) => void;
}

/** Exécute l'essai ; renvoie le code de sortie (0 : SMS accepté par l'opérateur, 1 : refus ou résultat incertain, 2 : refus avant tout envoi). */
export async function runSmoke(argv: readonly string[], env: Environment, dependencies: SmokeDependencies = {}): Promise<number> {
  const write = dependencies.write ?? ((line: string) => console.log(line));
  const parsed = parseSmokeArguments(argv);
  if (!parsed.ok) {
    write(`sms:smoke ${parsed.reason}`);
    return 2;
  }
  const refusal = smokeEnvironmentRefusal(env);
  if (refusal) {
    write(`sms:smoke ${refusal} Aucun SMS n'a été envoyé.`);
    return 2;
  }
  const sender = dependencies.sender ?? resolveMenoSender(env);
  if (!sender) {
    write("sms:smoke refus : fournisseur inactif. Aucun SMS n'a été envoyé.");
    return 2;
  }
  const key = `smoke-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
  write(`sms:smoke envoi RÉEL d'un SMS de test vers ${maskRecipient(parsed.to)} (15 F CFA)…`);
  const result = await sender.send({ purpose: "smoke", reference: key, idempotencyKey: key, to: parsed.to, content: SMOKE_MESSAGE, deadlineMs: 30_000 });
  write(`sms:smoke résultat : ${result.status}${result.errorCode ? ` (${result.errorCode})` : ""}, http ${result.httpStatus ?? "-"}, ${result.attempts} requête(s)${result.providerId ? `, identifiant ${result.providerId}` : ""}.`);
  if (result.status === "accepted") {
    write("sms:smoke accepté par l'opérateur : ce n'est PAS une preuve de livraison. Vérifiez la réception sur le téléphone.");
    return 0;
  }
  if (result.status === "uncertain") write("sms:smoke résultat INCERTAIN : le SMS est peut-être parti. Ne relancez pas : rapprochez-le dans /admin/sms.");
  return 1;
}
