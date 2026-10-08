import { assertSmsProductionConfig } from "./sms/config";

/**
 * Configuration des protections publiques (Lot 4) — variables d'environnement
 * et interrupteurs serveur. Module SERVEUR uniquement : ne jamais importer
 * depuis le bundle navigateur.
 */

export interface TurnstileConfig {
  /** Clé secrète siteverify — absente en production = refus systématique. */
  secret: string;
  /** Action attendue du widget (défaut : « search »). */
  expectedAction: string;
  /** Domaines attendus du siteverify (hostname). */
  expectedHostnames: string[];
  /** Dérivation pour les tests/dev local — JAMAIS honorée en production. */
  disabledForTests: boolean;
}

export interface GuardConfig {
  /** Chemin SQLite persistant (quotas, réservations, dépenses). */
  dbPath: string;
  /** Budget QUOTIDIEN PRÉVISIONNEL en microdollars (défaut : 1 $). */
  dailyBudgetMicros: number;
  /** Réservation PRÉVISIONNELLE par recherche IA en microdollars (0,05 $). */
  reserveMicros: number;
  /** Démarrages max par session et par empreinte IP. */
  startsPerMinute: number;
  startsPerDay: number;
  /** Recherches simultanées globales (défaut : 2). */
  maxConcurrentSearches: number;
  /** Durée de grâce d'une recherche active (crash → ligne nettoyée). */
  activeSearchTtlMs: number;
  /** Interrupteur serveur : recherches désactivées (503). */
  searchDisabled: boolean;
  /** Interrupteur serveur : IA désactivée (recherche sans scoring IA). */
  aiDisabled: boolean;
  turnstile: TurnstileConfig;
  /** Adresses IP du reverse proxy autorisées à poser X-Forwarded-For.
   *  Vide = aucun en-tête n'est cru (IP = adresse de connexion directe). */
  trustedProxies: string[];
  /** Secret partagé avec LE reverse proxy : présent ET transmis via
   *  x-noma-proxy-secret, X-Forwarded-For est cru (production). */
  proxySecret: string;
  /** Secret HMAC de pseudonymisation IP — l'IP en clair n'est jamais
   *  stockée ni journalisée, seule l'empreinte l'est. */
  ipSecret: string;
  /** Fuseau du budget quotidien (défaut : Africa/Abidjan). */
  budgetTimezone: string;
}

const USD = 1_000_000; // microdollars

export const MICRO_USD = USD;

const parseUsd = (value: string | undefined, fallback: number): number => {
  if (!value) return Math.round(fallback * USD);
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * USD) : Math.round(fallback * USD);
};

const boolFlag = (value: string | undefined): boolean => value === "1" || value === "true";

export function loadConfig(env: Record<string, string | undefined> = process.env): GuardConfig {
  const production = env.NODE_ENV === "production";
  const turnstileSecret = env.NOMA_TURNSTILE_SECRET ?? "";
  const devTurnstileOff =
    boolFlag(env.NOMA_TURNSTILE_DISABLED) && !production;

  return {
    dbPath: env.NOMA_DB_PATH ?? "./data/noma-guard.sqlite",
    dailyBudgetMicros: parseUsd(env.NOMA_DAILY_BUDGET_USD, 1),
    reserveMicros: parseUsd(env.NOMA_SEARCH_RESERVE_USD, 0.05),
    startsPerMinute: 2,
    startsPerDay: 10,
    maxConcurrentSearches: 2,
    activeSearchTtlMs: 10 * 60 * 1000,
    searchDisabled: boolFlag(env.NOMA_SEARCH_DISABLED),
    aiDisabled: boolFlag(env.NOMA_AI_DISABLED),
    turnstile: {
      secret: turnstileSecret,
      expectedAction: env.NOMA_TURNSTILE_ACTION ?? "search",
      expectedHostnames: (env.NOMA_TURNSTILE_HOSTNAMES ?? "localhost")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      disabledForTests: devTurnstileOff,
    },
    trustedProxies: (env.NOMA_TRUSTED_PROXIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    proxySecret: env.NOMA_PROXY_SECRET ?? "",
    ipSecret: env.NOMA_IP_SECRET ?? (production ? "" : "dev-ip-secret"),
    budgetTimezone: env.NOMA_BUDGET_TZ ?? "Africa/Abidjan",
  };
}

/**
 * Variables d'environnement INTERDITES en production (contournements de développement). Liste reprise dans la section
 * « INTERDIT en production » de deploy/env.production.example (un test vérifie qu'elles y figurent toutes).
 */
export const PRODUCTION_FORBIDDEN_ENV: readonly string[] = Object.freeze([
  "NOMA_FAKE_PAYMENTS",
  "NOMA_FAKE_PAYMENT_SECRET",
  "NOMA_DEV_OTP_CONSOLE",
  "NOMA_DEV_NOTIFY_CONSOLE",
  "NOMA_DEV_PROXY",
  "NOMA_FAKE_SOURCES",
  "NOMA_TURNSTILE_DISABLED",
]);

/** Production : la configuration anti-bot doit être complète et aucune variable de développement ne doit être définie,
 *  sinon l'app refuse de démarrer (fail closed). Exécutée à la création du singleton de `guard()` (premier appel de
 *  /api/search dans le processus), seulement quand NODE_ENV vaut exactement « production ». Les messages sont fixes : ils
 *  nomment la variable (texte de la liste ci-dessus), jamais sa valeur. */
export function assertProductionConfig(cfg: GuardConfig, env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV !== "production") return;
  if (!cfg.turnstile.secret) {
    throw new Error("NOMA_TURNSTILE_SECRET requis en production");
  }
  if (!cfg.ipSecret) {
    throw new Error("NOMA_IP_SECRET requis en production");
  }
  for (const name of PRODUCTION_FORBIDDEN_ENV) {
    const value = env[name];
    if (value !== undefined && value !== "") throw new Error(`${name} interdit en production`);
  }
  // Fournisseur SMS (lot SMS1) : meno sans clé valide, console ou valeur inconnue = refus de démarrer.
  assertSmsProductionConfig(env);
}