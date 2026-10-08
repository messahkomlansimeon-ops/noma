import "server-only";

/**
 * Configuration du prestataire de paiement RÉEL « sublymus » (Wave via wallet.sublymus.com, lot PAY1). Voir PAIEMENT-WAVE.md.
 *
 * RÈGLES ABSOLUES de ce fichier :
 *  - aucune clé, aucun secret, aucun identifiant n'est écrit dans le code : tout vient de l'environnement du serveur ;
 *  - le branchement est DÉSACTIVÉ par défaut (NOMA_PAYMENT_PROVIDER absent ou « fake » : le prestataire fictif) ;
 *  - hors production, le prestataire n'accepte QUE une adresse de l'API qui est sur ce poste (boucle locale) : un développement ou un essai ne contacte JAMAIS le vrai Sublymus
 *    (la création d'une session de paiement ouvrirait une VRAIE session Wave : il n'existe pas de bac à sable) ;
 *  - un message de refus nomme les variables à corriger, jamais leurs valeurs.
 */

export const SUBLYMUS_PROVIDER = "sublymus" as const;
export const FAKE_PROVIDER_KIND = "fake" as const;

export type PaymentProviderKind = typeof FAKE_PROVIDER_KIND | typeof SUBLYMUS_PROVIDER;

/** Adresse du vrai service (configurable par NOMA_SUBLYMUS_BASE_URL : les essais la pointent sur la FAUSSE API locale). */
export const SUBLYMUS_DEFAULT_BASE_URL = "https://wallet.sublymus.com";

/** Webhook Sublymus → noma. */
export const SUBLYMUS_WEBHOOK_PATH = "/api/webhooks/sublymus";
export const SUBLYMUS_SIGNATURE_HEADER = "x-wave-signature";
export const SUBLYMUS_EVENT_HEADER = "x-wave-event";
export const SUBLYMUS_MANAGER_HEADER = "x-manager-id";
export const SUBLYMUS_WEBHOOK_ID_HEADER = "x-webhook-id";
export const SUBLYMUS_EVENTS = ["payment.completed", "payment.failed"] as const;
export type SublymusEventName = (typeof SUBLYMUS_EVENTS)[number];

/** Corps maximal d'un webhook, en octets (lu en entier, jamais plus). */
export const SUBLYMUS_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

/** Secret de signature : au moins 32 caractères. */
export const SUBLYMUS_SECRET_MIN_CHARS = 32;

/** Délai maximal d'un appel à Sublymus (millisecondes) et taille maximale d'une réponse lue (octets). */
export const SUBLYMUS_REQUEST_TIMEOUT_MS = 10_000;
export const SUBLYMUS_RESPONSE_MAX_BYTES = 256 * 1024;

/** Système source déclaré à la création et vérifié au retour. */
export const SUBLYMUS_SOURCE_SYSTEM = "NOMA";

/** Référence externe d'une recharge : `noma-topup-<identifiant de l'intention>` (unique, stable, jamais réutilisée avec un autre montant). */
export const SUBLYMUS_REFERENCE_PREFIX = "noma-topup-";
/** Référence de la commande du fondateur (session de test, jamais créditée). */
export const SUBLYMUS_TEST_REFERENCE_PREFIX = "noma-test-";

/** Plafond du montant de la session de test du fondateur (XOF). */
export const CHECKOUT_TEST_MAX_XOF = 500;

/** Rattrapage : première tentative après 2 minutes, attente doublée à chaque tentative (plafond 1 heure), fenêtre de 24 heures. */
export const CATCHUP_FIRST_DELAY_MS = 2 * 60_000;
export const CATCHUP_MAX_DELAY_MS = 60 * 60_000;
export const CATCHUP_WINDOW_MS = 24 * 60 * 60_000;
export const CATCHUP_DEFAULT_LIMIT = 20;
export const CATCHUP_MAX_LIMIT = 100;
/**
 * Budget de temps d'un passage du rattrapage (millisecondes) : au-delà, le passage s'arrête et les intentions non examinées restent dues. Il borne le temps pris dans le cycle du
 * worker quand Sublymus est lent (sans lui, 20 intentions x 10 s de délai d'appel = plus de trois minutes).
 */
export const CATCHUP_PASS_BUDGET_MS = 20_000;

/**
 * Domaines du lien de paiement Wave : le lien reçu de Sublymus n'est enregistré, puis servi au navigateur, que si son hôte est un SOUS-DOMAINE de l'un d'eux (par exemple
 * pay.wave.com). Liste modifiable ICI, dans le code (jamais par l'environnement). Elle ne s'applique pas à la fausse API locale des essais (adresse de boucle locale).
 */
export const SUBLYMUS_LINK_DOMAINS: readonly string[] = Object.freeze(["wave.com"]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Hôte en minuscules, point final retiré (« WALLET.SUBLYMUS.COM. » et « wallet.sublymus.com » désignent le même service). */
export function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

/** Vrai si l'adresse est une adresse de BOUCLE LOCALE (ce poste) : la seule admise pour la fausse API hors production. Adresse illisible : faux. */
export function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Vrai si l'hôte du lien de paiement est un sous-domaine d'un domaine de SUBLYMUS_LINK_DOMAINS (point final et casse normalisés). */
export function isWaveLinkHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  return SUBLYMUS_LINK_DOMAINS.some((domain) => normalized.endsWith(`.${domain}`));
}

/**
 * UNE SEULE expression pour tout identifiant venu de Sublymus ou choisi avec lui (lot PAY1-ter, N7) : identifiant d'intention (réponse à la création, liste de recherche, `data.id` d'un
 * webhook), gestionnaire, portefeuille, référence : lettres, chiffres, `.`, `_`, `:` et `-`, 1 à 100 caractères. La contrainte `chk_sublymus_checkouts_sublymus_intent` de la
 * migration 0026 porte EXACTEMENT la même expression (un test compare les deux) : un identifiant que le code accepte (`pi.abc123`, `pi:abc123`) ne fait jamais échouer l'écriture en base.
 */
export const SUBLYMUS_IDENTIFIER = /^[A-Za-z0-9._:-]{1,100}$/;
const IDENTIFIER = SUBLYMUS_IDENTIFIER;

type Environment = Record<string, string | undefined>;

export interface SublymusConfig {
  apiKey: string;
  managerId: string;
  walletId: string;
  webhookSecret: string;
  /** Origine publique de noma, sans barre finale (https en production) : sert aux adresses de retour du navigateur. */
  publicUrl: string;
  /** Adresse de l'API Sublymus, sans barre finale. */
  baseUrl: string;
  production: boolean;
}

export type PaymentSelection = { provider: typeof FAKE_PROVIDER_KIND } | { provider: typeof SUBLYMUS_PROVIDER; config: SublymusConfig };

/** Refus de configuration : `problems` nomme les variables à corriger (jamais une valeur). */
export class PaymentConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Configuration du paiement refusée :\n - ${problems.join("\n - ")}`);
    this.name = "PaymentConfigError";
    this.problems = problems;
  }
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/** Origine d'une URL de base : refuse identifiants, chemin, paramètres et ancre. Renvoie null si l'URL n'est pas une simple origine. */
function plainOrigin(url: URL): string | null {
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

/**
 * Sélection du prestataire (NOMA_PAYMENT_PROVIDER) et validation. `fake` (ou absent) : le prestataire fictif, seul défaut ; en production il est INTERDIT (refus explicite).
 * `sublymus` : exige WAVE_API_KEY, NOMA_SUBLYMUS_MANAGER_ID, NOMA_SUBLYMUS_WALLET_ID, SUBLYMUS_WEBHOOK_SECRET (32 caractères au moins) et NOMA_PUBLIC_URL (https en
 * production) ; en production NOMA_SUBLYMUS_BASE_URL (défaut : le vrai service) doit être en https ; hors production elle DOIT être sur ce poste (fausse API locale).
 * Toute autre valeur est refusée. Lève `PaymentConfigError`.
 */
export function resolvePaymentSelection(env: Environment): PaymentSelection {
  const production = env.NODE_ENV === "production";
  const selected = env.NOMA_PAYMENT_PROVIDER?.trim() ?? "";
  if (selected === "" || selected === FAKE_PROVIDER_KIND) {
    if (production && selected === FAKE_PROVIDER_KIND) {
      throw new PaymentConfigError(["NOMA_PAYMENT_PROVIDER=fake : le prestataire fictif est interdit en production (utilisez sublymus, ou retirez la variable : aucune recharge ne sera possible)."]);
    }
    return { provider: FAKE_PROVIDER_KIND };
  }
  if (selected !== SUBLYMUS_PROVIDER) {
    throw new PaymentConfigError(["NOMA_PAYMENT_PROVIDER doit valoir fake ou sublymus."]);
  }

  const problems: string[] = [];
  const apiKey = env.WAVE_API_KEY?.trim() ?? "";
  if (apiKey === "") problems.push("WAVE_API_KEY est obligatoire (clé de l'API Sublymus).");
  else if (apiKey.length > 512 || /[\s\u0000-\u001f\u007f]/.test(apiKey)) problems.push("WAVE_API_KEY a une forme invalide (espace ou caractère de contrôle, ou trop longue).");

  const managerId = env.NOMA_SUBLYMUS_MANAGER_ID?.trim() ?? "";
  if (managerId === "") problems.push("NOMA_SUBLYMUS_MANAGER_ID est obligatoire (identifiant du gestionnaire).");
  else if (!IDENTIFIER.test(managerId)) problems.push("NOMA_SUBLYMUS_MANAGER_ID a une forme invalide.");

  const walletId = env.NOMA_SUBLYMUS_WALLET_ID?.trim() ?? "";
  if (walletId === "") problems.push("NOMA_SUBLYMUS_WALLET_ID est obligatoire (portefeuille qui reçoit les paiements).");
  else if (!IDENTIFIER.test(walletId)) problems.push("NOMA_SUBLYMUS_WALLET_ID a une forme invalide.");

  const webhookSecret = env.SUBLYMUS_WEBHOOK_SECRET?.trim() ?? "";
  if (webhookSecret === "") problems.push("SUBLYMUS_WEBHOOK_SECRET est obligatoire (secret de signature des webhooks).");
  else if (webhookSecret.length < SUBLYMUS_SECRET_MIN_CHARS) problems.push(`SUBLYMUS_WEBHOOK_SECRET doit contenir au moins ${SUBLYMUS_SECRET_MIN_CHARS} caractères.`);

  let publicUrl = "";
  const publicRaw = env.NOMA_PUBLIC_URL?.trim() ?? "";
  if (publicRaw === "") problems.push("NOMA_PUBLIC_URL est obligatoire (adresse publique de noma, https).");
  else {
    const url = parseUrl(publicRaw);
    const origin = url ? plainOrigin(url) : null;
    if (!url || origin === null) problems.push("NOMA_PUBLIC_URL doit être une simple origine (https://exemple.ci), sans chemin, paramètre ni identifiant.");
    else if (url.protocol !== "https:" && (production || !(url.protocol === "http:" && isLoopback(url)))) {
      problems.push("NOMA_PUBLIC_URL doit être en https (http n'est admis que sur ce poste, hors production).");
    } else publicUrl = origin;
  }

  let baseUrl: string = SUBLYMUS_DEFAULT_BASE_URL;
  const baseRaw = env.NOMA_SUBLYMUS_BASE_URL?.trim();
  if (baseRaw !== undefined && baseRaw !== "") {
    const url = parseUrl(baseRaw);
    const origin = url ? plainOrigin(url) : null;
    if (!url || origin === null || (url.protocol !== "https:" && url.protocol !== "http:")) problems.push("NOMA_SUBLYMUS_BASE_URL doit être une simple origine http(s), sans chemin, paramètre ni identifiant.");
    else if (production && url.protocol !== "https:") problems.push("NOMA_SUBLYMUS_BASE_URL doit être en https en production.");
    else if (!production && !isLoopback(url)) problems.push("Hors production, NOMA_SUBLYMUS_BASE_URL doit désigner ce poste (localhost) : un essai ne contacte jamais le vrai service.");
    else baseUrl = origin;
  } else if (!production) {
    problems.push("Hors production, NOMA_SUBLYMUS_BASE_URL est obligatoire et doit désigner ce poste (fausse API locale) : un essai ne contacte jamais le vrai service.");
  }

  if (problems.length > 0) throw new PaymentConfigError(problems);
  return { provider: SUBLYMUS_PROVIDER, config: { apiKey, managerId, walletId, webhookSecret, publicUrl, baseUrl, production } };
}

/**
 * Contrôle de DÉMARRAGE (instrumentation du serveur, worker) : lève `PaymentConfigError` si la configuration du paiement est refusée. Un serveur mal configuré ne démarre pas
 * (message clair) au lieu de découvrir l'erreur à la première recharge.
 */
export function assertPaymentConfiguration(env: Environment): PaymentSelection {
  return resolvePaymentSelection(env);
}
