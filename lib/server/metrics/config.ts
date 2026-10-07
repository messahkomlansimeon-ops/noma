/**
 * Configuration de code des mesures d'efficacité (lot M1). Voir MESURES.md.
 */

/**
 * Base de l'arrondi des statistiques publiées (lot M1-quater) : un compte (acheteurs uniques OU événements) de 0 à BASE − 1 est publié « moins de BASE » ; à partir de BASE
 * il est arrondi au multiple de BASE le plus proche (la moitié vers le haut) et publié « environ N ». Aucun compte exact n'est jamais publié. Voir MESURES.md.
 */
export const COUNT_ROUNDING_BASE = 5;

/**
 * Plus grand compte publié « environ 5 » (la première tranche s'étend de 5 à 8 au lieu de 5 à 7). Pourquoi 8 et pas 7 : deux comptes « moins de 5 » valent au plus 4 + 4 = 8 ;
 * si 8 était publié « environ 10 » (8 à 12), un total « environ 10 » dont deux parties sont « moins de 5 » donnerait 4 et 4 EXACTEMENT (constat de l'adversaire,
 * MESURES.md « Ce que l'adversaire prouve »). Avec 8 dans la première tranche, aucun total publié ne borne ses parties d'en bas (jusqu'à 6 parties).
 */
export const COUNT_FIRST_BUCKET_MAX = 8;

/** Un pourcentage n'est publié que si le numérateur ET le dénominateur PUBLIÉS (arrondis) valent au moins ce nombre ; il est arrondi à la dizaine de pour cent. */
export const RATIO_MIN_PUBLISHED_COUNT = 10;
export const RATIO_ROUNDING_PERCENT = 10;

/**
 * Fenêtre d'attribution : une ouverture ou un contact n'est attribué à un boost que si le journal d'exposition montre que l'annonce a été
 * servie SPONSORISÉE à ce besoin dans les `ATTRIBUTION_WINDOW_DAYS` jours précédents.
 */
export const ATTRIBUTION_WINDOW_DAYS = 7;

/** Rétention du journal d'exposition et des ouvertures et contacts : au-delà, `npm run metrics:purge` supprime les lignes. */
export const METRICS_RETENTION_DAYS = 400;

/** Contacts : au plus ce nombre de vendeurs DISTINCTS révélés pour la première fois, par acheteur et par jour UTC. */
export const CONTACT_DAILY_SELLER_LIMIT = 20;

/** Plafond de durée de l'écriture du journal des ouvertures (comme le journal d'exposition) et du contrôle d'un contact. */
export const METRICS_WRITE_TIMEOUT = "2s";
export const CONTACT_TRANSACTION_TIMEOUT = "5s";

/** Espace du verrou consultatif qui sérialise les contacts d'un même acheteur (limite quotidienne exacte). Distinct de 1_314_664_945 à 953. */
export const CONTACT_LOCK_NAMESPACE = 1_314_664_954;

/** Périodes des statistiques : 7 et 30 derniers jours UTC (aujourd'hui compris), puis tout l'historique conservé (rétention comprise). */
export const STATS_PERIODS = ["7d", "30d", "all"] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];
export const STATS_PERIOD_DAYS: Readonly<Record<StatsPeriod, number | null>> = Object.freeze({ "7d": 7, "30d": 30, all: null });

/** Nombre de boosts détaillés dans les statistiques (les plus récents d'abord). */
export const STATS_BOOST_LIMIT = 20;

/** Variable qui autorise `metrics:purge` quand NODE_ENV vaut `production` (refus sinon, même en simulation). */
export const PURGE_PRODUCTION_VARIABLE = "NOMA_METRICS_PURGE_PRODUCTION";
