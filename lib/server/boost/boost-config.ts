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

/** Sources d'attribution (même liste que `chk_offer_boosts_source`). Aucun paiement : l'administration seule attribue. */
export const BOOST_SOURCES = ["admin_grant"] as const;

export type BoostSource = (typeof BOOST_SOURCES)[number];

/** Clé de la ligne de réglages par défaut ; une catégorie en minuscules la surcharge. */
export const BOOST_DEFAULT_SETTINGS_KEY = "default";

/** Espace du verrou consultatif par périmètre (distinct de ceux de migrations.ts et de persistence.ts : 1_314_664_945 à 947). */
export const BOOST_SCOPE_LOCK_NAMESPACE = 1_314_664_948;

/** Attente maximale d'un verrou ou d'une ligne verrouillée pendant une attribution. */
export const BOOST_LOCK_TIMEOUT_MS = 5_000;

/** Espace du verrou consultatif par OFFRE pour les cotations (distinct de BOOST_SCOPE_LOCK_NAMESPACE et des espaces de matching). */
export const BOOST_QUOTE_LOCK_NAMESPACE = 1_314_664_949;

/** Validité d'une cotation INDISPONIBLE (secondes) : courte, pour que l'indisponibilité ne soit pas figée. */
export const BOOST_UNAVAILABLE_QUOTE_SECONDS = 60;

/** Expiration automatique (lot 2I4) : nombre maximal de boosts échus marqués `expired` par balayage (1 à 1000, 200 par défaut). */
export const BOOST_EXPIRY_DEFAULT_LIMIT = 200;
export const BOOST_EXPIRY_MAX_LIMIT = 1_000;

/** Au-delà de ce retard (secondes), un boost échu resté `active` déclenche l'avertissement `boost_expiry_overdue` du statut. */
export const BOOST_EXPIRY_OVERDUE_SECONDS = 600;
