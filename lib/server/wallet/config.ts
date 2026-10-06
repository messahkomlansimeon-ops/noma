import "server-only";

/**
 * Configuration de code du portefeuille (lot P1a). Monnaie : francs CFA (XOF), 1 crédit = 1 XOF, entiers uniquement :
 * côté JavaScript les montants sont des `bigint`, côté PostgreSQL des BIGINT. Voir WALLET.md.
 */

export const WALLET_CURRENCY = "XOF" as const;

/** Version du contrat de réponse HTTP (champ `contractVersion`). */
export const WALLET_CONTRACT_VERSION = "wallet/v1";

/** Plus grand montant représentable sans perte côté JSON (2^53 - 1), identique aux CHECK de la migration 0014. */
export const WALLET_MAX_SAFE_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

// ───────────── recharge ─────────────

/** Montant d'une recharge : entier de TOPUP_MIN_XOF à TOPUP_MAX_XOF inclus, multiple de TOPUP_STEP_XOF. */
export const TOPUP_MIN_XOF = 500;
export const TOPUP_MAX_XOF = 500_000;
export const TOPUP_STEP_XOF = 100;

/** Intentions en attente (non échues) qu'un utilisateur peut avoir en même temps. */
export const TOPUP_MAX_PENDING = 5;

/** Durée de validité d'une intention de paiement (secondes). */
export const TOPUP_EXPIRY_SECONDS = 30 * 60;

/** Expiration (balayage) : nombre maximal d'intentions échues marquées `expired` par appel (1 à 1000, 200 par défaut). */
export const TOPUP_EXPIRY_DEFAULT_LIMIT = 200;
export const TOPUP_EXPIRY_MAX_LIMIT = 1_000;

/** Page de l'historique (GET /api/wallet). */
export const WALLET_HISTORY_DEFAULT_LIMIT = 20;
export const WALLET_HISTORY_MAX_LIMIT = 50;

// ───────────── verrous ─────────────

/**
 * Espace du verrou consultatif par utilisateur pour la création d'intentions (distinct de 1_314_664_945 à 949 : migrations,
 * matching, boosts). Il sérialise, pour un utilisateur, la lecture de la clé d'idempotence, le décompte des intentions en attente
 * et l'insertion.
 */
export const WALLET_TOPUP_LOCK_NAMESPACE = 1_314_664_950;

/** Attente maximale d'un verrou ou d'une ligne verrouillée. */
export const WALLET_LOCK_TIMEOUT_MS = 5_000;

// ───────────── prestataire fictif ─────────────

export const FAKE_PROVIDER = "fake" as const;
export const FAKE_SIGNATURE_HEADER = "x-noma-fake-signature";
/** Tolérance de l'horodatage d'un événement (secondes, de part et d'autre de l'heure du serveur). */
export const FAKE_SIGNATURE_TOLERANCE_SECONDS = 300;
/** Corps maximal d'un webhook, en octets. */
export const FAKE_WEBHOOK_MAX_BODY_BYTES = 8 * 1024;
/** Taille minimale du secret, en octets. */
export const FAKE_SECRET_MIN_BYTES = 32;
