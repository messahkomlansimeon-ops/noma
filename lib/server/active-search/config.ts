import "server-only";

import { VISIBLE_MAX_AGE_MS } from "../external/config";

/**
 * Configuration de code de la RECHERCHE ACTIVE payante (lot RA1). Voir RECHERCHE-ACTIVE.md.
 *
 * PRIX PROVISOIRE : 2 000 FCFA pour 30 jours, par besoin. C'est une valeur de départ en attente d'une décision du fondateur ; le prix payé est CONSERVÉ sur chaque achat
 * (`active_search_purchases.price_xof`), donc le modifier ne touche jamais un achat existant.
 */

export const ACTIVE_SEARCH_CONTRACT_VERSION = "active-search/v1" as const;

/** Prix d'une période (XOF, entier) et sa durée. L'option se paie en crédits PAYÉS uniquement : jamais en crédits promotionnels. */
export const ACTIVE_SEARCH_PRICE_XOF = 2_000;
export const ACTIVE_SEARCH_DURATION_DAYS = 30;

/** La fin de l'option (la dernière période payée) ne dépasse jamais maintenant + 180 jours : au plus 6 périodes de 30 jours d'avance. */
export const ACTIVE_SEARCH_MAX_HORIZON_DAYS = 180;
/** Suivi des notifications d'un besoin : prolongeable jusqu'à 180 jours (au lieu de 90) PENDANT que l'option est active. */
export const ACTIVE_SEARCH_TRACKING_MAX_DAYS = 180;
/** Avis d'échéance : 3 jours avant la fin de la dernière période. */
export const ACTIVE_SEARCH_NOTICE_DAYS = 3;

/**
 * Surveillance de marché d'un besoin qui a l'option : collecte jusqu'à toutes les heures (au lieu de 6 h), avec un budget de 24 requêtes par jour et par source (au lieu de 4). Le quota
 * journalier de chaque SOURCE (200 par défaut) s'applique toujours : il borne le nombre de surveillances accélérées qu'une source peut servir. La surveillance est PARTAGÉE : les autres
 * acheteurs du même produit en profitent sans payer (voulu : la collecte est mutualisée).
 */
export const ACTIVE_SEARCH_WATCH_FREQUENCY_SECONDS = 3_600;
export const ACTIVE_SEARCH_WATCH_DAILY_BUDGET = 24;

/**
 * Part MAXIMALE du quota journalier de chaque source que les surveillances ACCÉLÉRÉES peuvent consommer (en pour cent). La moitié reste RÉSERVÉE aux surveillances ordinaires : quelle que soit
 * la façon dont les options s'accumulent (un acheteur peut en cumuler beaucoup), elles ne peuvent pas épuiser la source. Elle est appliquée DEUX fois : à l'achat (contrôle d'admission, `capacity`)
 * et à chaque requête (`reserveRequest` refuse une requête accélérée au-delà de la part). Avec le quota par défaut (200) : 100 requêtes accélérées par jour et par source, soit 4 produits accélérés
 * de 24 requêtes.
 */
export const ACTIVE_SEARCH_ACCELERATED_QUOTA_SHARE_PERCENT = 50;

/** Part accélérée du quota journalier d'une source (entier, arrondi à l'inférieur). */
export function acceleratedQuotaShare(dailyQuota: number): number {
  return Math.floor((Math.max(0, dailyQuota) * ACTIVE_SEARCH_ACCELERATED_QUOTA_SHARE_PERCENT) / 100);
}

/** Nombre de surveillances accélérées que le quota (le plus petit des sources actives) peut porter. */
export function acceleratedWatchLimit(smallestDailyQuota: number): number {
  return Math.floor(acceleratedQuotaShare(smallestDailyQuota) / ACTIVE_SEARCH_WATCH_DAILY_BUDGET);
}

/** Une collecte « réussie » compte pour le relevé de l'existant si elle a eu lieu dans la fenêtre de fraîcheur des annonces (48 h : au-delà, aucune annonce n'est plus visible). */
export const ACTIVE_SEARCH_FRESH_COLLECTION_MS = VISIBLE_MAX_AGE_MS;

/** Annonces d'autres sites notifiées au plus par besoin et par balayage (le reste attend le balayage suivant : jamais marqué vu sans avoir été traité). */
export const ACTIVE_SEARCH_NOTIFY_BATCH = 50;

/**
 * Étape « activeSearch » du worker (APRÈS « collect ») : budget de temps du balayage des besoins (aucun besoin n'est commencé passé ce délai : il attend le cycle suivant) et nombre de
 * besoins balayés au plus par passage. L'étape n'allonge donc le cycle que de quelques secondes (budget + le besoin en cours), jamais de la durée d'une collecte.
 */
export const ACTIVE_SEARCH_STEP_BUDGET_MS = 3_000;
export const ACTIVE_SEARCH_STEP_MAX_DEMANDS = 25;
/** Attente maximale d'un verrou (ligne, plafond de notifications) pendant le balayage d'un besoin : au-delà, le besoin est repris au passage suivant (jamais une erreur). */
export const ACTIVE_SEARCH_SCAN_LOCK_TIMEOUT_MS = 2_000;

/**
 * Espace du verrou consultatif de la recherche active (distinct de 1_314_664_945 à 982) : PAR UTILISATEUR, il sérialise les achats d'options d'un même utilisateur (double clic, deux onglets),
 * avant la ligne du besoin, les achats existants et les comptes du grand livre ; PAR BESOIN (clé `scan:<besoin>`, verrou TENTÉ sans attente), il empêche deux balayages simultanés du même besoin.
 */
export const ACTIVE_SEARCH_USER_LOCK_NAMESPACE = 1_314_664_990;
export const ACTIVE_SEARCH_LOCK_TIMEOUT_MS = 5_000;

/** Corps maximal d'une requête d'achat (JSON), en octets. */
export const ACTIVE_SEARCH_HTTP_BODY_MAX_BYTES = 1_024;
