/**
 * Réglages de la collecte d'annonces externes mutualisée (lot EXT1). Module PUR (aucun accès à la base), partagé par la collecte, la mise en relation et les écrans.
 * Voir COLLECTE-EXTERNE.md.
 *
 * AUCUNE collecte réelle : seules des sources FICTIVES existent. Le réseau sortant n'est jamais appelé.
 */

export const EXTERNAL_LISTINGS_CONTRACT_VERSION = "external-listings/v1" as const;
export const ADMIN_COLLECTION_CONTRACT_VERSION = "admin-collection/v1" as const;

/** Seul type de source admis (contrainte de la migration 0025). Une source réelle exige un futur lot : liste blanche validée (droit, conditions d'utilisation, robots.txt, quotas, consentement). */
export const ALLOWED_SOURCE_TYPE = "fake" as const;

/** Une collecte toutes les 6 heures par surveillance (modifiable surveillance par surveillance). */
export const WATCH_DEFAULT_FREQUENCY_SECONDS = 6 * 3_600;
/** Requêtes par jour et PAR SOURCE pour une surveillance (6 h de fréquence : 4 collectes par jour). */
export const WATCH_DEFAULT_DAILY_BUDGET = 4;
/**
 * Quand aucune source n'a pu être interrogée (disjoncteur ouvert, source occupée, délai minimal trop long, aucune source active), ou qu'une source a été refusée pour son délai minimal
 * ou parce qu'elle était occupée, nouvelle tentative dans 10 minutes. Quand SEUL le quota du jour de la source ou le budget du jour de la surveillance empêche la collecte, la
 * surveillance est reprogrammée au prochain minuit UTC (les compteurs sont par jour UTC) : inutile de la réserver toutes les 10 minutes.
 */
export const WATCH_RETRY_SECONDS = 600;
/** Bail posé sur une surveillance pendant sa collecte : si le processus meurt, elle redevient due à l'échéance. Un jeton de bail empêche un exécuteur retardataire de la clore. */
export const WATCH_CLAIM_LEASE_SECONDS = 600;

/**
 * Disjoncteur par source : 3 échecs de suite, puis 30 minutes de pause. Le premier essai après la pause décide (réussite : fermé ; échec : rouvert aussitôt). Il n'y a qu'UN essai
 * décisif à la fois : son « jeton » (`external_sources.breaker_trial_until`) est pris sous le verrou de la ligne de la source et vaut `BREAKER_TRIAL_LEASE_MS` ; si le processus qui
 * l'a pris meurt, le jeton expire et un autre essai est permis.
 */
export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_PAUSE_MS = 30 * 60_000;
export const BREAKER_TRIAL_LEASE_MS = 60_000;

/** Une annonce qui manque à 3 collectes réussies de suite passe à « gone ». Une panne de la source n'est jamais une absence. */
export const GONE_AFTER_MISSED_COLLECTS = 3;

/** Regroupement entre sources : écart de prix d'au plus 2 % du plus bas des deux prix, titres proches (Jaccard des mots significatifs). */
export const DUPLICATE_PRICE_TOLERANCE = 0.02;
export const DUPLICATE_TITLE_SIMILARITY = 0.6;

/** Annonces gardées par recherche et par source (le reste est ignoré). */
export const MAX_LISTINGS_PER_SEARCH = 50;
/** Entrées de la réponse d'une source LUES (nettoyées) : 4 fois la limite ; le reste est écarté AVANT tout nettoyage (une réponse énorme ne bloque pas le processus). */
export const MAX_RAW_ENTRIES_PER_SEARCH = 4 * MAX_LISTINGS_PER_SEARCH;
/** Délai d'une recherche auprès d'une source : au-delà, échec « timeout » (la source est comptée en échec, les autres continuent). */
export const SEARCH_TIMEOUT_MS = 8_000;
/**
 * Attente maximale avant une requête pour respecter le délai minimal d'une source. Au-delà, la requête est REFUSÉE (motif « intervalle », quota et budget non consommés) : le
 * délai minimal d'une source n'est jamais raccourci.
 */
export const MAX_SOURCE_WAIT_MS = 5_000;
/** Attente maximale d'un verrou de la ligne d'une source (réservation d'une requête) : au-delà la source est « occupée », sans erreur d'infrastructure. */
export const SOURCE_LOCK_TIMEOUT_MS = 2_000;

/**
 * Étape « collect » d'un cycle du worker : surveillances traitées au plus par cycle, et budget de temps (10 s) APRÈS lequel aucune surveillance nouvelle n'est commencée (les
 * surveillances réservées mais non commencées sont rendues, sans quota ni budget consommés). Une surveillance déjà commencée est toujours terminée.
 */
export const STEP_MAX_WATCHES = 3;
export const STEP_TIME_BUDGET_MS = 10_000;

/** Une annonce externe n'est montrée que si une collecte réussie l'a VUE (présente dans la réponse d'une source) il y a moins de 48 h (`last_seen_at`). */
export const VISIBLE_MAX_AGE_MS = 48 * 3_600_000;

/** Date de publication admise : du 1er janvier 2000 à demain ; hors de cette plage la date est écartée (l'annonce est gardée sans date). */
export const LISTED_AT_MIN_MS = Date.UTC(2000, 0, 1);
export const LISTED_AT_FUTURE_TOLERANCE_MS = 24 * 3_600_000;

/** Candidats évalués par lecture d'un besoin (les plus récemment vus d'abord) et taille des pages. */
export const MATCH_CANDIDATE_LIMIT = 300;
export const EXTERNAL_PAGE_DEFAULT = 6;
export const EXTERNAL_PAGE_MAX = 30;

/** Conservation des journaux de collecte et des compteurs d'usage. */
export const RUNS_RETENTION_DAYS = 30;
export const USAGE_RETENTION_DAYS = 14;
/** Dernières erreurs montrées à l'administrateur. */
export const ADMIN_RECENT_ERRORS = 15;

/** Espaces des verrous consultatifs de ce lot (voir la liste des espaces dans scripts/demo-seed-plan.ts ; 1_314_664_981 et 982 sont réservés à la collecte externe). */
export const EXTERNAL_ANALYSIS_LOCK_NAMESPACE = 1_314_664_981;
export const EXTERNAL_GROUP_LOCK_NAMESPACE = 1_314_664_982;

/** Propriétaire fictif des annonces externes dans l'évaluation de compatibilité : aucun compte réel (un acheteur n'est jamais son propre vendeur). */
export const EXTERNAL_OWNER_ID = "00000000-0000-4000-8000-000000000000";

/** Variable d'environnement qui autorise les connecteurs FICTIFS dans le worker (jamais en production). */
export const FAKE_CONNECTORS_ENV = "NOMA_EXTERNAL_FAKE";
