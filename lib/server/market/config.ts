/**
 * Configuration de code de l'historique des prix et des statistiques de marché (lot H1). Voir HISTORIQUE-PRIX.md.
 */

/** Périodes publiées, en jours UTC (aujourd'hui compris) : une période de N jours couvre de « aujourd'hui − (N − 1) » à aujourd'hui. */
export const MARKET_PERIODS = [30, 90, 365] as const;
export type MarketPeriod = (typeof MARKET_PERIODS)[number];
export const MARKET_DEFAULT_PERIOD: MarketPeriod = 90;

/** Les deux sources de relevés : le prix affiché d'une annonce publiée, le prix convenu d'une vente confirmée. Seuls les prix des ANNONCES sont publiés (HISTORIQUE-PRIX.md). */
export const MARKET_SOURCES = ["listing", "sale"] as const;
export type MarketSource = (typeof MARKET_SOURCES)[number];

/**
 * Seuils de confidentialité des prix demandés. L'unité statistique est le VENDEUR : une seule valeur par vendeur et par période (la médiane des derniers prix de ses annonces de la
 * période), pour qu'un seul vendeur, quel que soit son nombre d'annonces, ne déplace jamais la médiane de plus d'une position. Toutes les statistiques se calculent sur ces valeurs
 * par vendeur, APRÈS retrait des prix atypiques :
 *  - médiane de la période : au moins 5 vendeurs distincts ;
 *  - fourchette (Q1, Q3) : au moins 10 vendeurs ;
 *  - un point de tendance (médiane hebdomadaire) : au moins 20 vendeurs dans la semaine (relevé de 15 à 20 à l'intégration : la fuite d'un adversaire qui connaît les prix ronds baisse, voir HISTORIQUE-PRIX.md).
 * Sous un seuil : « pas assez de données », aucun chiffre. Les prix de vente ne sont PAS publiés : aucun seuil de vente n'existe.
 */
export const MARKET_MIN_SELLERS = 5;
export const MARKET_RANGE_MIN_SELLERS = 10;
export const MARKET_TREND_MIN_SELLERS = 20;

/** Prix atypiques : une valeur par vendeur hors de [Q1 − 1,5 × IQR ; Q3 + 1,5 × IQR] est écartée avant toute publication. */
export const MARKET_OUTLIER_IQR_FACTOR = 1.5;

/** Q1 et Q3 sont arrondis au multiple de 5 % de la médiane (médiane / 20) ; une borne publiée n'est jamais ≤ 0 (sinon la fourchette n'est pas publiée). */
export const MARKET_RANGE_STEPS_PER_MEDIAN = 20;

/** Les prix publiés (médiane, points de tendance) et chaque prix avant calcul sont arrondis à ce pas, en FCFA (le multiple le plus proche, la moitié vers le haut). */
export const MARKET_PRICE_ROUNDING_XOF = 500;

/** Tendance : la période est découpée en blocs de 7 jours consécutifs finissant aujourd'hui ; les jours restants (période mod 7) les plus anciens n'y figurent pas. */
export const MARKET_TREND_BLOCK_DAYS = 7;

/** Longueur maximale d'un paramètre de clé produit dans la requête (caractères). */
export const MARKET_PARAM_MAX_LENGTH = 80;

/** Limite de débit de la route : au plus 60 lectures par minute et par utilisateur (mémoire du processus). */
export const MARKET_RATE_LIMIT = 60;
export const MARKET_RATE_WINDOW_MS = 60_000;
export const MARKET_RATE_MAX_USERS = 10_000;

/** Relevé quotidien : le jour COURANT seulement (aucun rattrapage) ; annonces traitées par lot. */
export const MARKET_OBSERVE_BATCH = 500;
export const MARKET_OBSERVE_STATEMENT_TIMEOUT = "20s";

/** Migration dont dépend l'étape « market » du worker (sans elle : étape ignorée, jamais une erreur). */
export const MARKET_REQUIRED_MIGRATION = "0023_price_observations";

/** Rétention : les relevés de plus de 3 ans (1 095 jours) sont supprimés par `npm run metrics:purge -- --apply`. */
export const MARKET_RETENTION_DAYS = 1095;

/** Tableau d'administration : les clés produit les plus relevées sur les 90 derniers jours. */
export const MARKET_ADMIN_KEY_LIMIT = 20;
export const MARKET_ADMIN_PERIOD: MarketPeriod = 90;

export const MARKET_CONTRACT_VERSION = "market/v3" as const;
export const MARKET_ADMIN_CONTRACT_VERSION = "market-admin/v3" as const;
