/**
 * Éléments partagés par les essais de cotation et d'achat de boost (lot P2-bis).
 *
 * Une cotation n'est « disponible » que si le boost ferait MONTER l'offre dans la liste d'au moins un acheteur : il faut donc des listes
 * lisibles par la lecture des résultats (résumés d'évaluation bien formés, pertinence calculable) et assez longues (quota de places promues
 * floor(0,15 × N) ≥ 1, soit 7 offres au moins), avec l'offre cotée classée APRÈS les autres de même pertinence.
 */

/** Résumés d'évaluation bien formés (la lecture des résultats les contrôle champ par champ). */
export const EVALUATION_SUMMARY_JSON = JSON.stringify({
  eligibilityReasons: [],
  criteriaSummary: { matchedCount: 2, mismatchedCount: 0, unknownCount: 0, totalExploitableCriteria: 2 },
});
export const SCORING_SUMMARY_JSON = JSON.stringify({
  totalApplicableWeight: 3, matchedWeight: 3, mismatchedWeight: 0, unknownWeight: 0, applicableCriteriaCount: 3,
  matchedCount: 3, mismatchedCount: 0, unknownCount: 0, notApplicableCount: 0, duplicateCount: 0,
});
export const PREFERENCES_SUMMARY_JSON = JSON.stringify({
  preferenceScore: null, preferenceCoverage: 0, totalPreferencesCount: 0, matchedCount: 0, mismatchedCount: 0, unknownCount: 0, contributions: [],
});

/** Longueur de liste par défaut d'un acheteur « atteignable » : floor(0,15 × 7) = 1 place promue. */
export const REACHABLE_LIST_SIZE = 7;
