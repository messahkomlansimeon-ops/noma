/**
 * Configuration de code du boost (lot 2I1). Les RÉGLAGES (ratio de places, plafonds, part promue, seuil de
 * pertinence) sont en base (`boost_settings`, modifiables depuis l'administration) ; ici seulement ce qui ne se
 * règle pas à chaud : les durées possibles, la source d'attribution et l'espace du verrou consultatif.
 * Voir BOOST.md.
 */

/** Codes de durée acceptés (même liste que le CHECK `chk_offer_boosts_duration_code`). */
export const BOOST_DURATION_CODES = ["24h", "3d", "7d"] as const;

export type BoostDurationCode = (typeof BOOST_DURATION_CODES)[number];

/** Durée de chaque code, en secondes (ends_at = starts_at + durée, calculé par PostgreSQL). */
export const BOOST_DURATION_SECONDS: Readonly<Record<BoostDurationCode, number>> = Object.freeze({
  "24h": 24 * 3600,
  "3d": 3 * 24 * 3600,
  "7d": 7 * 24 * 3600,
});

/**
 * Sources acceptées par `grantOfferBoost` : l'administration seule attribue sans achat. Le boost `purchase` n'est créé que par
 * `purchaseOfferBoost` (lot P1b), dans la transaction qui débite le portefeuille : il n'est donc PAS dans cette liste.
 */
export const BOOST_SOURCES = ["admin_grant"] as const;

export type BoostSource = (typeof BOOST_SOURCES)[number];

/** Sources d'un boost ENREGISTRÉ (même liste que `chk_offer_boosts_source`, migration 0015) : attribution d'administration ou achat. */
export const BOOST_RECORD_SOURCES = ["admin_grant", "purchase"] as const;

export type BoostRecordSource = (typeof BOOST_RECORD_SOURCES)[number];

/** Clé de la ligne de réglages par défaut ; une catégorie en minuscules la surcharge. */
export const BOOST_DEFAULT_SETTINGS_KEY = "default";

/** Espace du verrou consultatif par périmètre (distinct de ceux de migrations.ts et de persistence.ts : 1_314_664_945 à 947). */
export const BOOST_SCOPE_LOCK_NAMESPACE = 1_314_664_948;

/** Attente maximale d'un verrou ou d'une ligne verrouillée pendant une attribution. */
export const BOOST_LOCK_TIMEOUT_MS = 5_000;

/** Espace du verrou consultatif par OFFRE pour les cotations (distinct de BOOST_SCOPE_LOCK_NAMESPACE et des espaces de matching). */
export const BOOST_QUOTE_LOCK_NAMESPACE = 1_314_664_949;

/**
 * Espace du verrou consultatif d'IDEMPOTENCE d'un achat de boost (lot P1b), par (vendeur, clé d'idempotence). Distinct de 1_314_664_945
 * à 1_314_664_950 (migrations, matching, boosts, recharges du portefeuille).
 */
export const BOOST_PURCHASE_LOCK_NAMESPACE = 1_314_664_951;

/** Validité d'une cotation INDISPONIBLE (secondes) : courte, pour que l'indisponibilité ne soit pas figée. */
export const BOOST_UNAVAILABLE_QUOTE_SECONDS = 60;

/** Expiration automatique (lot 2I4) : nombre maximal de boosts échus marqués `expired` par balayage (1 à 1000, 200 par défaut). */
export const BOOST_EXPIRY_DEFAULT_LIMIT = 200;
export const BOOST_EXPIRY_MAX_LIMIT = 1_000;

/** Au-delà de ce retard (secondes), un boost échu resté `active` déclenche l'avertissement `boost_expiry_overdue` du statut. */
export const BOOST_EXPIRY_OVERDUE_SECONDS = 600;

/**
 * Espace du verrou consultatif par VENDEUR qui sérialise le comptage et l'écriture d'un devis calculé (limite de débit, lot P3) : pris APRÈS le
 * verrou de cotation de l'offre, tenu quelques millisecondes (comptage + INSERT). Distinct de 1_314_664_945 à 951.
 */
export const BOOST_QUOTE_RATE_NAMESPACE = 1_314_664_952;

/** Limite de débit des devis : au plus `BOOST_QUOTE_RATE_LIMIT` devis CALCULÉS (écrits) par vendeur sur `BOOST_QUOTE_RATE_WINDOW_SECONDS` secondes. */
export const BOOST_QUOTE_RATE_LIMIT = 20;
export const BOOST_QUOTE_RATE_WINDOW_SECONDS = 60;

/**
 * Calculs de portée simultanés (par processus) : au-delà, les demandes de devis attendent un créneau au plus `BOOST_REACH_QUEUE_WAIT_MS`, puis
 * sont refusées (503). Garde des connexions du pool et de la boucle d'événements pour les autres requêtes (porte-monnaie, annonces…).
 */
export const BOOST_REACH_MAX_CONCURRENCY = 4;
export const BOOST_REACH_QUEUE_WAIT_MS = 5_000;

/** `Retry-After` (secondes) d'une vérification de portée non terminée à temps (`reach_check_unavailable`, lot P3-bis) : court, la nouvelle tentative est légère. */
export const BOOST_REACH_RETRY_AFTER_SECONDS = 2;

/**
 * Revérification de la portée d'un devis RÉUTILISÉ (lot M1, réserve du lot P3-bis) : le résultat « atteignable » est gardé en mémoire
 * `BOOST_REUSE_RECHECK_CACHE_MS` par devis, et les revérifications réellement calculées sont limitées à `BOOST_REUSE_RECHECK_LIMIT` par vendeur sur
 * `BOOST_REUSE_RECHECK_WINDOW_MS` (au-delà : `rate_limited`, 429). Par processus, comme le créneau de calcul de portée qu'elles protègent.
 */
export const BOOST_REUSE_RECHECK_CACHE_MS = 10_000;
export const BOOST_REUSE_RECHECK_LIMIT = 60;
export const BOOST_REUSE_RECHECK_WINDOW_MS = 60_000;
/** Bornes de la mémoire (entrées de devis, vendeurs suivis) : jamais de croissance sans fin. */
export const BOOST_REUSE_RECHECK_MAX_ENTRIES = 5_000;
