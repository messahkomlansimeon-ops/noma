import "server-only";

import { maskPayer, maskPayerPartial } from "./anomalies";
import { SublymusApiError, SublymusClient } from "./client";
import { CHECKOUT_TEST_MAX_XOF, SUBLYMUS_DEFAULT_BASE_URL, SUBLYMUS_IDENTIFIER, SUBLYMUS_TEST_REFERENCE_PREFIX, isLoopbackUrl } from "./config";

/**
 * COMMANDES DU FONDATEUR (lot PAY1) : `wallet:provider-check`, `wallet:provider-checkout-test` et `wallet:provider-intent-check`. Elles parlent au VRAI Sublymus DÈS QUE la clé est
 * dans l'environnement de la commande (adresse par défaut : le vrai service) : elles ne sont lancées que par le fondateur, jamais par un essai (les essais les passent contre la
 * FAUSSE API locale, avec une clé inventée, sous NODE_ENV=test, où SEULE une adresse de boucle locale est admise). Aucune ne touche la base de noma : aucune connexion, aucune
 * écriture. Elles ne journalisent et n'affichent jamais la clé.
 */

type Environment = Record<string, string | undefined>;
export interface CommandIo {
  env: Environment;
  fetch?: typeof fetch;
  /** Ligne de sortie standard. */
  out: (line: string) => void;
  /** Ligne d'erreur. */
  err: (line: string) => void;
  now?: () => Date;
}

const IDENTIFIER = SUBLYMUS_IDENTIFIER;

function plainOrigin(value: string, allowLoopbackHttp = true): string | null {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== "")) return null;
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
    if (url.protocol === "https:" || (allowLoopbackHttp && url.protocol === "http:" && loopback)) return url.origin;
    return null;
  } catch {
    return null;
  }
}

interface BaseSettings {
  apiKey: string;
  managerId: string;
  baseUrl: string;
}

/** Réglages communs (clé, gestionnaire, adresse) ; `problems` nomme les variables à corriger, jamais leurs valeurs. */
function readBase(env: Environment): { ok: true; settings: BaseSettings } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const apiKey = env.WAVE_API_KEY?.trim() ?? "";
  if (apiKey === "") problems.push("WAVE_API_KEY est obligatoire (dans l'environnement de cette commande).");
  else if (apiKey.length > 512 || /[\s\u0000-\u001f\u007f]/.test(apiKey)) problems.push("WAVE_API_KEY a une forme invalide.");
  const managerId = env.NOMA_SUBLYMUS_MANAGER_ID?.trim() ?? "";
  if (managerId === "") problems.push("NOMA_SUBLYMUS_MANAGER_ID est obligatoire.");
  else if (!IDENTIFIER.test(managerId)) problems.push("NOMA_SUBLYMUS_MANAGER_ID a une forme invalide.");
  const rawBase = env.NOMA_SUBLYMUS_BASE_URL?.trim();
  const baseUrl = rawBase === undefined || rawBase === "" ? SUBLYMUS_DEFAULT_BASE_URL : plainOrigin(rawBase);
  if (baseUrl === null) problems.push("NOMA_SUBLYMUS_BASE_URL doit être une simple origine https (http n'est admis que sur ce poste).");
  // Un essai (NODE_ENV=test) n'atteint JAMAIS le vrai service ni aucune autre adresse : seule la fausse API, en boucle locale, est admise.
  else if (env.NODE_ENV === "test" && !isLoopbackUrl(baseUrl)) problems.push("NODE_ENV=test : NOMA_SUBLYMUS_BASE_URL doit désigner la fausse API locale (boucle locale), jamais le vrai service ni une autre adresse.");
  return problems.length > 0 ? { ok: false, problems } : { ok: true, settings: { apiKey, managerId, baseUrl: baseUrl as string } };
}

function describeFailure(error: unknown): string {
  if (error instanceof SublymusApiError) {
    switch (error.kind) {
      case "auth": return "la clé est refusée par Sublymus (401 ou 403) : vérifiez WAVE_API_KEY et NOMA_SUBLYMUS_MANAGER_ID.";
      case "timeout": return "Sublymus n'a pas répondu à temps.";
      case "network": return "Sublymus est injoignable (réseau).";
      case "invalid_response": return "la réponse de Sublymus ne ressemble pas au contrat attendu.";
      case "not_found": return "adresse introuvable chez Sublymus (404).";
      case "real_host_forbidden": return "adresse du vrai service refusée dans ce contexte.";
      case "rate_limited": return "Sublymus limite le débit (429) : réessayez plus tard.";
      case "server": return "Sublymus a une erreur interne (5xx).";
      default: return `Sublymus a refusé la requête (${error.status ?? "?"}).`;
    }
  }
  return "erreur inattendue.";
}

const formatXof = (amount: bigint): string => `${amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} XOF`;

/**
 * `npm run wallet:provider-check` : LECTURE SEULE. `GET /v1/wallets/main` (puis le solde du portefeuille) avec la clé de l'environnement. Affiche
 * « clé valide, portefeuille X, solde Y ». N'écrit rien nulle part (ni chez Sublymus : seulement des GET, ni chez nous). Code de sortie : 0 succès, 1 échec, 2 usage.
 */
export async function runProviderCheck(io: CommandIo): Promise<number> {
  const base = readBase(io.env);
  if (!base.ok) {
    for (const problem of base.problems) io.err(problem);
    return 2;
  }
  const client = new SublymusClient({ apiKey: base.settings.apiKey, managerId: base.settings.managerId, walletId: "-", baseUrl: base.settings.baseUrl }, { fetch: io.fetch, allowRealHost: io.env.NODE_ENV !== "test" });
  try {
    const wallet = await client.getMainWallet();
    io.out(`clé valide, portefeuille ${wallet.id}, solde ${wallet.balanceXof === null ? "non lisible" : formatXof(wallet.balanceXof)}`);
    return 0;
  } catch (error) {
    io.err(`Échec : ${describeFailure(error)}`);
    return 1;
  }
}

export interface CheckoutTestOptions {
  amountXof: number;
  confirmed: boolean;
}

/** Arguments de la commande : `--amount <entier>` (défaut 100) et `--confirm-real-checkout`. Tout autre argument est refusé. */
export function parseCheckoutTestArgs(argv: readonly string[]): { ok: true; options: CheckoutTestOptions } | { ok: false; message: string } {
  let amount = 100;
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm-real-checkout") confirmed = true;
    else if (arg === "--amount") {
      const value = argv[index + 1];
      if (value === undefined || !/^[0-9]{1,9}$/.test(value)) return { ok: false, message: "--amount attend un entier de XOF (par exemple --amount 100)." };
      amount = Number(value);
      index += 1;
    } else return { ok: false, message: `Argument inconnu : ${arg.slice(0, 40)}.` };
  }
  return { ok: true, options: { amountXof: amount, confirmed } };
}

/**
 * `npm run wallet:provider-checkout-test -- --amount 100 --confirm-real-checkout` : crée UNE session de paiement RÉELLE de faible montant (plafond 500 XOF) avec la référence
 * `noma-test-<horodatage>` et affiche le lien. REFUSE de s'exécuter sans `--confirm-real-checkout`, avant tout appel réseau. Ne crédite RIEN dans noma (aucune base). Si la session de
 * test est payée, Sublymus enverra un webhook que noma journalisera comme « référence inconnue » (attendu : la référence de test n'est celle d'aucune recharge).
 */
export async function runCheckoutTest(io: CommandIo, argv: readonly string[]): Promise<number> {
  const parsed = parseCheckoutTestArgs(argv);
  if (!parsed.ok) {
    io.err(parsed.message);
    return 2;
  }
  const { amountXof, confirmed } = parsed.options;
  if (!confirmed) {
    io.err("Refus : cette commande ouvre une VRAIE session de paiement Wave. Relancez avec --confirm-real-checkout si c'est bien ce que vous voulez.");
    return 2;
  }
  if (!Number.isSafeInteger(amountXof) || amountXof < 1 || amountXof > CHECKOUT_TEST_MAX_XOF) {
    io.err(`Refus : le montant du test va de 1 à ${CHECKOUT_TEST_MAX_XOF} XOF (plafond de sécurité).`);
    return 2;
  }
  const base = readBase(io.env);
  const problems = base.ok ? [] : [...base.problems];
  const walletId = io.env.NOMA_SUBLYMUS_WALLET_ID?.trim() ?? "";
  if (walletId === "") problems.push("NOMA_SUBLYMUS_WALLET_ID est obligatoire.");
  else if (!IDENTIFIER.test(walletId)) problems.push("NOMA_SUBLYMUS_WALLET_ID a une forme invalide.");
  const publicRaw = io.env.NOMA_PUBLIC_URL?.trim() ?? "";
  const publicUrl = publicRaw === "" ? null : plainOrigin(publicRaw);
  if (publicUrl === null) problems.push("NOMA_PUBLIC_URL est obligatoire et doit être une simple origine https.");
  if (problems.length > 0 || !base.ok || publicUrl === null) {
    for (const problem of problems) io.err(problem);
    return 2;
  }
  const reference = `${SUBLYMUS_TEST_REFERENCE_PREFIX}${(io.now ?? (() => new Date()))().getTime()}`;
  const client = new SublymusClient({ apiKey: base.settings.apiKey, managerId: base.settings.managerId, walletId, baseUrl: base.settings.baseUrl }, { fetch: io.fetch, allowRealHost: io.env.NODE_ENV !== "test" });
  try {
    const checkout = await client.createCheckout({
      amountXof: BigInt(amountXof),
      externalReference: reference,
      description: "Test de paiement noma (fondateur)",
      successUrl: `${publicUrl}/compte/porte-monnaie?paiement=test`,
      errorUrl: `${publicUrl}/compte/porte-monnaie?paiement=test`,
      label: "Test noma",
    });
    io.out(`Session RÉELLE créée : ${formatXof(checkout.amountXof)}, référence ${reference}.`);
    io.out(`Lien de paiement Wave : ${checkout.checkoutUrl}`);
    io.out("Rien n'est crédité dans noma. Si vous payez, le webhook sera journalisé comme « référence inconnue » (attendu).");
    // Vérification de l'hypothèse « payerId = gestionnaire » (lecture seule) : le fondateur voit si la valeur réelle correspond.
    try {
      const found = (await client.findIntents(reference)).filter((entry) => entry.externalReference === reference);
      const payer = found[0]?.payerId ?? null;
      io.out(payer === null ? "payerId : absent de la recherche." : `payerId reçu : ${maskPayer(payer)} (${payer === base.settings.managerId ? "identique à" : "DIFFÉRENT de"} NOMA_SUBLYMUS_MANAGER_ID).`);
    } catch {
      io.out("payerId : vérification indisponible.");
    }
    return 0;
  } catch (error) {
    io.err(`Échec : ${describeFailure(error)}`);
    return 1;
  }
}

/** Arguments de `wallet:provider-intent-check` : `--reference <référence>` (obligatoire). Tout autre argument est refusé. */
export function parseIntentCheckArgs(argv: readonly string[]): { ok: true; reference: string } | { ok: false; message: string } {
  let reference: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--reference") return { ok: false, message: `Argument inconnu : ${arg.slice(0, 40)}.` };
    const value = argv[index + 1];
    if (value === undefined || !IDENTIFIER.test(value) || reference !== null) return { ok: false, message: "--reference attend UNE référence (par exemple --reference noma-test-1760000000000)." };
    reference = value;
    index += 1;
  }
  return reference === null ? { ok: false, message: "--reference <référence> est obligatoire (celle affichée par wallet:provider-checkout-test)." } : { ok: true, reference };
}

/**
 * `npm run wallet:provider-intent-check -- --reference <référence>` : LECTURE SEULE (un seul GET /v1/intents?external_reference=). Relit chez Sublymus la session de cette référence
 * EXACTE (la recherche de Sublymus est partielle) et affiche son statut, son montant, sa devise, son système source et le payerId (masqué en partie) en disant s'il correspond au
 * gestionnaire. À lancer APRÈS avoir payé la session du test : voir PAIEMENT-WAVE.md. Code de sortie : 0 session trouvée, 1 échec ou introuvable, 2 usage.
 */
export async function runIntentCheck(io: CommandIo, argv: readonly string[]): Promise<number> {
  const parsed = parseIntentCheckArgs(argv);
  if (!parsed.ok) {
    io.err(parsed.message);
    return 2;
  }
  const base = readBase(io.env);
  if (!base.ok) {
    for (const problem of base.problems) io.err(problem);
    return 2;
  }
  const client = new SublymusClient({ apiKey: base.settings.apiKey, managerId: base.settings.managerId, walletId: "-", baseUrl: base.settings.baseUrl }, { fetch: io.fetch, allowRealHost: io.env.NODE_ENV !== "test" });
  try {
    const found = (await client.findIntents(parsed.reference)).filter((entry) => entry.externalReference === parsed.reference);
    if (found.length === 0) {
      io.err("Aucune session ne porte exactement cette référence chez Sublymus (la recherche est partielle : seules les références identiques comptent).");
      return 1;
    }
    if (found.length > 1) io.out(`ATTENTION : ${found.length} sessions portent cette référence chez Sublymus.`);
    for (const entry of found.slice(0, 5)) {
      io.out(`session ${entry.id} : statut ${entry.status}, montant ${entry.amountXof === null ? "illisible" : formatXof(entry.amountXof)}, devise ${entry.currency ?? "absente"}, système source ${entry.sourceSystem ?? "absent"}.`);
      io.out(entry.payerId === null
        ? "payerId : absent de la réponse de Sublymus."
        : `payerId reçu : ${maskPayerPartial(entry.payerId)} (${entry.payerId === base.settings.managerId ? "IDENTIQUE à" : "DIFFÉRENT de"} NOMA_SUBLYMUS_MANAGER_ID).`);
    }
    io.out("Lecture seule : rien n'a été modifié, ni chez Sublymus ni dans noma.");
    return 0;
  } catch (error) {
    io.err(`Échec : ${describeFailure(error)}`);
    return 1;
  }
}
