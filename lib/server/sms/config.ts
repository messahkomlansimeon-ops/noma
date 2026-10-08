/**
 * Configuration du fournisseur SMS « Meno » (lot SMS1). Module PUR (aucun import serveur, aucun accès réseau ou base) : il est lu par le démarrage (instrumentation.ts),
 * par les gardes de production et par les transports. Voir SMS.md.
 *
 * Variables :
 *   NOMA_SMS_PROVIDER   none (défaut, ou vide) | console | meno. « console » ne désigne AUCUN fournisseur : les transports de développement restent commandés par
 *                       NOMA_DEV_OTP_CONSOLE et NOMA_DEV_NOTIFY_CONSOLE ; il est refusé en production.
 *   NOMA_SMS_API_KEY    clé du fournisseur (SECRET : serveur seulement, jamais dans Git, jamais côté navigateur).
 *   NOMA_SMS_BASE_URL   base de l'API (défaut https://meno.sublymus.com/api/external/sms) ; https exigé en production.
 *   NOMA_PUBLIC_URL     origine publique de l'application, pour le lien des notifications (obligatoire si le transport meno est actif en production).
 *   NOMA_SMS_DAILY_CAP  plafond TOTAL d'envois par jour UTC, tous usages (défaut 1000 = 15 000 F CFA au plus ; entier de 1 à 100000).
 *   NOMA_SMS_NOTIFICATION_SHARE_PERCENT   part du plafond réservée aux notifications (défaut 40 ; entier de 1 à 90) ; le reste est le budget des codes de connexion.
 *   NOMA_SMS_EXISTING_RESERVE_PERCENT     part du budget des codes réservée aux numéros qui ont DÉJÀ un compte (défaut 50 ; entier de 0 à 90).
 *
 * Le branchement est DÉSACTIVÉ par défaut : il n'est actif que si NOMA_SMS_PROVIDER=meno ET une clé au format valide est définie, ET (lot SMS1-bis) seulement si NODE_ENV vaut
 * exactement « production » OU si la base de l'API désigne CE poste (faux serveur : 127.0.0.1, localhost, [::1]). Un environnement de développement, de recette ou de test qui
 * hérite de la vraie clé n'envoie donc jamais de vrai SMS.
 */

import { SMS_DEFAULT_EXISTING_RESERVE_PERCENT, SMS_DEFAULT_NOTIFICATION_SHARE_PERCENT, isValidExistingReservePercent, isValidNotificationSharePercent, planBudgets, type SmsBudgetPlan } from "./budget";
import { isSingleSegmentSms } from "./gsm7";
import { notificationMessage } from "./notification-text";

export type Environment = Record<string, string | undefined>;

export const SMS_PROVIDER_VARIABLE = "NOMA_SMS_PROVIDER";
export const SMS_API_KEY_VARIABLE = "NOMA_SMS_API_KEY";
export const SMS_BASE_URL_VARIABLE = "NOMA_SMS_BASE_URL";
export const PUBLIC_URL_VARIABLE = "NOMA_PUBLIC_URL";
export const SMS_DAILY_CAP_VARIABLE = "NOMA_SMS_DAILY_CAP";
export const SMS_NOTIFICATION_SHARE_VARIABLE = "NOMA_SMS_NOTIFICATION_SHARE_PERCENT";
export const SMS_EXISTING_RESERVE_VARIABLE = "NOMA_SMS_EXISTING_RESERVE_PERCENT";

export const MENO_DEFAULT_BASE_URL = "https://meno.sublymus.com/api/external/sms";
export const SMS_DEFAULT_DAILY_CAP = 1_000;
export const SMS_MAX_DAILY_CAP = 100_000;
/** Chemin du lien des notifications (celui de `EXTERNAL_MESSAGE_LINK`, vérifié par un test) et plus grand nombre d'annonces d'un message (borne large : 5 chiffres). */
export const NOTIFICATION_LINK_PATH = "/notifications";
export const NOTIFICATION_WORST_CASE_COUNT = 99_999;
/** Prix d'un SMS accepté (information : le prix réel est lu dans GET /usage). */
export const SMS_UNIT_PRICE_XOF = 15;

/**
 * Format de la clé : le fournisseur ne documente pas de format précis. Contrôle volontairement LÂCHE, qui attrape les coquilles (guillemets, espaces, retour à la ligne,
 * valeur d'exemple « <...> », clé tronquée) : 16 à 256 caractères d'un jeu sûr pour un en-tête HTTP.
 */
export const SMS_API_KEY_FORMAT = /^[A-Za-z0-9_.~+/=:-]{16,256}$/;

export type SmsProvider = "none" | "console" | "meno" | "invalid";

export interface SmsConfig {
  provider: SmsProvider;
  /** Clé lue (rognée) ; null si absente. Peut être invalide : voir `keyValid`. */
  apiKey: string | null;
  keyValid: boolean;
  /** Base de l'API, sans « / » final. */
  baseUrl: string;
  baseUrlValid: boolean;
  baseUrlHttps: boolean;
  /** La base de l'API désigne CE poste (127.0.0.1, localhost, ::1) : un faux serveur local. */
  baseUrlLocal: boolean;
  /** NODE_ENV tel quel, SANS rognage (absent = chaîne vide) : « production » doit être exact, comme pour `assertSmsProductionConfig`. */
  nodeEnv: string;
  /** Origine publique de l'application (sans « / » final), ou null. */
  publicUrl: string | null;
  publicUrlValid: boolean;
  dailyCap: number;
  dailyCapValid: boolean;
  notificationSharePercent: number;
  existingReservePercent: number;
  /** Les deux pourcentages sont valides. */
  budgetSharesValid: boolean;
  /** Budgets du jour dérivés du plafond total (valeurs par défaut si une part est invalide : le branchement est alors inactif). */
  budget: SmsBudgetPlan;
}

export function isValidSmsApiKey(value: unknown): value is string {
  return typeof value === "string" && SMS_API_KEY_FORMAT.test(value);
}

/** Même règle que lib/server/auth/config.ts (requireAuthSecret) : base64 canonique d'au moins 32 octets (module pur : pas d'import serveur ici). */
export function isValidAuthSecretEncoding(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const encoded = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return false;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.toString("base64") === encoded && decoded.byteLength >= 32;
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parseHttpUrl(value: string): { href: string; https: boolean; origin: string; hostname: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.hostname === "") return null;
  return { href: url.href.replace(/\/+$/, ""), https: url.protocol === "https:", origin: url.origin, hostname: url.hostname.toLowerCase() };
}

export function readSmsConfig(env: Environment = process.env): SmsConfig {
  const rawProvider = (env[SMS_PROVIDER_VARIABLE] ?? "").trim();
  const provider: SmsProvider = rawProvider === "" || rawProvider === "none" ? "none" : rawProvider === "console" ? "console" : rawProvider === "meno" ? "meno" : "invalid";

  const rawKey = (env[SMS_API_KEY_VARIABLE] ?? "").trim();
  const apiKey = rawKey === "" ? null : rawKey;

  const rawBase = (env[SMS_BASE_URL_VARIABLE] ?? "").trim();
  const base = parseHttpUrl(rawBase === "" ? MENO_DEFAULT_BASE_URL : rawBase);

  const rawPublic = (env[PUBLIC_URL_VARIABLE] ?? "").trim();
  // L'origine publique n'a ni chemin, ni requête, ni identifiants : « https://noma.exemple ».
  const publicUrlParsed = rawPublic === "" ? null : parseHttpUrl(rawPublic);
  const publicUrlValid = publicUrlParsed !== null && publicUrlParsed.href === publicUrlParsed.origin;

  const rawCap = (env[SMS_DAILY_CAP_VARIABLE] ?? "").trim();
  const capNumber = rawCap === "" ? SMS_DEFAULT_DAILY_CAP : /^[0-9]{1,6}$/.test(rawCap) ? Number(rawCap) : Number.NaN;
  const dailyCapValid = Number.isSafeInteger(capNumber) && capNumber >= 1 && capNumber <= SMS_MAX_DAILY_CAP;
  const effectiveCap = dailyCapValid ? capNumber : SMS_DEFAULT_DAILY_CAP;

  const share = readPercent(env[SMS_NOTIFICATION_SHARE_VARIABLE], SMS_DEFAULT_NOTIFICATION_SHARE_PERCENT);
  const reserve = readPercent(env[SMS_EXISTING_RESERVE_VARIABLE], SMS_DEFAULT_EXISTING_RESERVE_PERCENT);
  const shareValid = isValidNotificationSharePercent(share);
  const reserveValid = isValidExistingReservePercent(reserve);

  return {
    provider,
    apiKey,
    keyValid: isValidSmsApiKey(apiKey),
    baseUrl: base ? base.href : MENO_DEFAULT_BASE_URL,
    baseUrlValid: base !== null,
    baseUrlHttps: base?.https === true,
    baseUrlLocal: base !== null && LOCAL_HOSTS.has(base.hostname),
    nodeEnv: env.NODE_ENV ?? "",
    publicUrl: publicUrlValid && publicUrlParsed ? publicUrlParsed.href : null,
    publicUrlValid,
    dailyCap: effectiveCap,
    dailyCapValid,
    notificationSharePercent: shareValid ? share : SMS_DEFAULT_NOTIFICATION_SHARE_PERCENT,
    existingReservePercent: reserveValid ? reserve : SMS_DEFAULT_EXISTING_RESERVE_PERCENT,
    budgetSharesValid: shareValid && reserveValid,
    budget: planBudgets(effectiveCap, shareValid ? share : SMS_DEFAULT_NOTIFICATION_SHARE_PERCENT, reserveValid ? reserve : SMS_DEFAULT_EXISTING_RESERVE_PERCENT),
  };
}

/** Pourcentage entier lu tel quel (vide = défaut) ; NaN si la valeur n'est pas un entier décimal de 1 à 3 chiffres. */
function readPercent(value: string | undefined, fallback: number): number {
  const raw = (value ?? "").trim();
  if (raw === "") return fallback;
  return /^[0-9]{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
}

/**
 * Le transport meno est actif UNIQUEMENT si NOMA_SMS_PROVIDER=meno ET une clé au format valide est définie (et une base d'API, un plafond et des parts valides). Sans clé : jamais
 * actif, quel que soit le reste. C'est l'unique porte d'activation : les résolveurs de transport, l'administration et le script de test passent tous par elle.
 * Garde-fou (lot SMS1-bis, C4) : il n'est actif que si NODE_ENV vaut EXACTEMENT « production » OU si la base de l'API désigne CE poste (faux serveur : 127.0.0.1, localhost, [::1],
 * noms exacts). NODE_ENV=development, absent, staging, « Test », test, etc. avec la vraie base : aucun transport. Une suite de tests ou un serveur de recette lancé avec une vraie clé
 * dans l'environnement n'envoie donc jamais de vrai SMS.
 */
export function isMenoActive(config: SmsConfig): boolean {
  if (config.nodeEnv !== "production" && !config.baseUrlLocal) return false;
  return config.provider === "meno" && config.apiKey !== null && config.keyValid && config.baseUrlValid && config.dailyCapValid && config.budgetSharesValid;
}

/** Motif (texte fixe, sans valeur) pour lequel `NOMA_SMS_PROVIDER=meno` n'est PAS actif ; null si actif ou si meno n'est pas demandé. */
export function menoInactiveReason(config: SmsConfig): string | null {
  if (config.provider !== "meno") return null;
  if (config.apiKey === null) return `${SMS_API_KEY_VARIABLE} est absente`;
  if (!config.keyValid) return `${SMS_API_KEY_VARIABLE} a un format invalide`;
  if (!config.baseUrlValid) return `${SMS_BASE_URL_VARIABLE} est invalide`;
  if (!config.dailyCapValid) return `${SMS_DAILY_CAP_VARIABLE} est invalide`;
  if (!config.budgetSharesValid) return `${SMS_NOTIFICATION_SHARE_VARIABLE} ou ${SMS_EXISTING_RESERVE_VARIABLE} est invalide`;
  if (config.nodeEnv !== "production" && !config.baseUrlLocal) return `hors production, ${SMS_BASE_URL_VARIABLE} doit désigner ce poste (aucun vrai SMS hors NODE_ENV=production)`;
  return null;
}

/**
 * Production (NODE_ENV exactement « production ») : REFUS DE DÉMARRER (fail closed) si la configuration SMS est incohérente. Rien n'est vérifié hors production. Messages fixes :
 * ils nomment la variable, jamais sa valeur. Appelée par instrumentation.ts (démarrage du serveur), par le worker et par assertProductionConfig.
 *  - NOMA_SMS_PROVIDER : « none », vide ou « meno » ; « console » et toute autre valeur sont refusés ;
 *  - avec « meno » : clé présente ET au format valide, NOMA_SMS_BASE_URL en https, NOMA_PUBLIC_URL (origine https, sans chemin), NOMA_SMS_DAILY_CAP valide,
 *    NOMA_AUTH_SECRET valide (il signe l'empreinte des numéros du journal des envois).
 */
export function assertSmsProductionConfig(env: Environment = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const config = readSmsConfig(env);
  if (config.provider === "invalid") throw new Error(`${SMS_PROVIDER_VARIABLE} invalide en production (none ou meno)`);
  if (config.provider === "console") throw new Error(`${SMS_PROVIDER_VARIABLE}=console interdit en production`);
  if (config.provider !== "meno") return;
  if (config.apiKey === null) throw new Error(`${SMS_API_KEY_VARIABLE} requis en production avec ${SMS_PROVIDER_VARIABLE}=meno`);
  if (!config.keyValid) throw new Error(`${SMS_API_KEY_VARIABLE} invalide (format)`);
  if (!config.baseUrlValid || !config.baseUrlHttps) throw new Error(`${SMS_BASE_URL_VARIABLE} invalide en production (https exigé)`);
  if (!config.publicUrlValid || !config.publicUrl?.startsWith("https://")) {
    throw new Error(`${PUBLIC_URL_VARIABLE} requis en production avec ${SMS_PROVIDER_VARIABLE}=meno (origine https de l'application, sans chemin)`);
  }
  if (!config.dailyCapValid) throw new Error(`${SMS_DAILY_CAP_VARIABLE} invalide (entier de 1 à ${SMS_MAX_DAILY_CAP})`);
  if (!isValidNotificationSharePercent(readPercent(env[SMS_NOTIFICATION_SHARE_VARIABLE], SMS_DEFAULT_NOTIFICATION_SHARE_PERCENT))) throw new Error(`${SMS_NOTIFICATION_SHARE_VARIABLE} invalide (entier de 1 à 90)`);
  if (!isValidExistingReservePercent(readPercent(env[SMS_EXISTING_RESERVE_VARIABLE], SMS_DEFAULT_EXISTING_RESERVE_PERCENT))) throw new Error(`${SMS_EXISTING_RESERVE_VARIABLE} invalide (entier de 0 à 90)`);
  // M2 : la notification au pire cas (plus grand nombre d'annonces, lien complet) doit tenir en UN segment ; sinon chaque envoi serait refusé AVANT l'appel, en silence.
  if (!isSingleSegmentSms(notificationMessage(NOTIFICATION_WORST_CASE_COUNT, `${config.publicUrl}${NOTIFICATION_LINK_PATH}`))) {
    throw new Error(`${PUBLIC_URL_VARIABLE} trop longue : la notification par SMS ne tiendrait pas dans un seul segment (raccourcissez l'adresse)`);
  }
  if (!isValidAuthSecretEncoding(env.NOMA_AUTH_SECRET)) throw new Error("NOMA_AUTH_SECRET requis en production avec NOMA_SMS_PROVIDER=meno");
}
