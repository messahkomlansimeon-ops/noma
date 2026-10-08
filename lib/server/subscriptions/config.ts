import "server-only";

/**
 * Configuration de code de l'offre Pro (lot PRO1) : abonnements, droits (entitlements), crédits promotionnels, import de catalogue. Voir OFFRE-PRO.md.
 *
 * PRIX PROVISOIRES : les prix, crédits promotionnels et limites des plans de départ vivent en base (`plan_versions`, migration 0021) ; ils attendent une décision du fondateur.
 */

/** Version du contrat de réponse HTTP (champ `contractVersion`). */
export const SUBSCRIPTION_CONTRACT_VERSION = "subscription/v1" as const;
export const CATALOG_IMPORT_CONTRACT_VERSION = "catalog-import/v1" as const;
export const ADMIN_PLANS_CONTRACT_VERSION = "admin-plans/v1" as const;

/** Codes des deux plans de départ. */
export const PLAN_FREE_CODE = "free" as const;
export const PLAN_PRO_CODE = "pro" as const;

/** Droits possibles d'une version de plan (liste blanche : même liste que `plan_entitlements_valid`, migration 0021). */
export const ENTITLEMENTS = ["badge_pro", "catalog_import", "priority_support_label"] as const;
export type Entitlement = (typeof ENTITLEMENTS)[number];

/** Délai de grâce après un renouvellement impayé : 72 heures à partir de la fin de la période. */
export const SUBSCRIPTION_GRACE_HOURS = 72;

/**
 * Espace du verrou consultatif PAR UTILISATEUR (distinct de 1_314_664_945 à 971 : 970 et 971 sont ceux des photos, intégration INT1) : il sérialise, pour un utilisateur, ses opérations d'abonnement (souscription,
 * renouvellement, fin, annulation, remboursement), le décompte de ses annonces en ligne à la publication et l'import de son catalogue. Il se prend AVANT la ligne de
 * l'abonnement, les lignes d'annonces, les émissions promotionnelles et les comptes du grand livre.
 */
export const SUBSCRIPTION_USER_LOCK_NAMESPACE = 1_314_664_972;

/** Attente maximale d'un verrou ou d'une ligne verrouillée. */
export const SUBSCRIPTION_LOCK_TIMEOUT_MS = 5_000;

/** Étape « subscriptions » du worker : abonnements à traiter et émissions à faire expirer par passage (1 à 500, 100 par défaut). */
export const SUBSCRIPTION_STEP_DEFAULT_LIMIT = 100;
export const SUBSCRIPTION_STEP_MAX_LIMIT = 500;

/** Corps maximal d'une requête de l'offre Pro (JSON), en octets. */
export const SUBSCRIPTION_HTTP_BODY_MAX_BYTES = 2_048;

// ───────────── import de catalogue ─────────────

/** Lignes de données d'un fichier d'import (l'en-tête n'en fait pas partie) : au-delà, le fichier est refusé en entier. */
export const IMPORT_MAX_ROWS = 200;
/** Taille maximale du texte du fichier, en octets UTF-8. */
export const IMPORT_MAX_BYTES = 256 * 1024;
/** Corps maximal de la requête d'import (le texte du fichier dans du JSON : un peu plus que le fichier). */
export const IMPORT_HTTP_BODY_MAX_BYTES = 320 * 1024;
