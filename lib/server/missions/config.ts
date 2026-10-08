import "server-only";

/**
 * Configuration de code des missions d'achat en volume (lot MV1). Voir MISSIONS.md. Les bornes métier (quantités, budgets, durées, plafonds) sont dans `lib/missions-rules.ts`,
 * partagé avec les écrans.
 */

export { MISSIONS_CONTRACT_VERSION } from "../../missions-rules";

/** Migration requise par l'étape et les routes de ce lot. */
export const MISSIONS_MIGRATION = "0027_missions";

/**
 * Espace du verrou consultatif des créations et activations d'un même acheteur (plafonds exacts). Liste 1_314_664_945 à 960 déjà utilisée par les lots précédents ; celui-ci est pris
 * volontairement à l'écart (985) pour ne jamais entrer en collision avec un espace réservé par un lot en cours (981 est celui de la collecte externe) : un test du dépôt vérifie qu'aucun
 * espace n'est déclaré deux fois. Les achats d'une même mission s'attendent par le verrou de LIGNE de la mission (`FOR UPDATE`), pas par un verrou consultatif.
 */
export const MISSION_OWNER_LOCK_NAMESPACE = 1_314_664_985;

/** Durée maximale d'une transaction de mission. */
export const MISSION_TRANSACTION_TIMEOUT = "5s";

/**
 * Liste « Mes missions » : les missions OUVERTES (brouillons, actives, en pause) d'abord, jusqu'à `MISSIONS_OPEN_LIMIT` par page (toutes, en pratique : 5 actives au plus et 20 créations
 * par jour), puis les closes par pages de `MISSIONS_LIST_LIMIT`, avec un curseur. Les plus récentes d'abord dans chaque groupe.
 */
export const MISSIONS_LIST_LIMIT = 50;
export const MISSIONS_OPEN_LIMIT = 200;
/** Commandes d'une mission servies avec elle. */
export const MISSION_ORDERS_LIMIT = 100;

/** Étape « missions » du runner : missions échues fermées, missions réévaluées, notifications écrites par cycle. */
export const MISSIONS_STEP_EXPIRY_BATCH = 50;
export const MISSIONS_STEP_EVALUATION_BATCH = 20;
export const MISSIONS_STEP_NOTIFY_BATCH = 50;
export const MISSIONS_STEP_RELEASE_BATCH = 50;

/**
 * Délai entre la FIN d'une mission (terminée, annulée, échue) et l'archivage de son besoin porteur : le vendeur dont la confirmation termine la mission ne doit pas le deviner en
 * voyant le besoin disparaître de ses correspondances à cet instant. Intervalle SQL.
 */
export const MISSION_CARRIER_RELEASE_DELAY = "24 hours";

/** Fenêtre de classement lue pour une proposition (celle du tri par pertinence). */
export { RELEVANCE_WINDOW as MISSION_PROPOSAL_WINDOW } from "../matching/relevance-config";
