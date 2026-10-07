/**
 * Configuration de code des favoris, de la messagerie en direct et des commandes (lot D2). Voir MESSAGERIE.md.
 */

export const FAVORITES_CONTRACT_VERSION = "favorites/v1" as const;
export const CONVERSATIONS_CONTRACT_VERSION = "conversations/v1" as const;
export const ORDERS_CONTRACT_VERSION = "orders/v1" as const;
export const ORDER_SALES_CONTRACT_VERSION = "offer-sales/v1" as const;

/** Favoris : au plus ce nombre par utilisateur. */
export const FAVORITES_LIMIT = 200;

/** Messages : au plus 30 par minute et 300 par jour UTC et par utilisateur ; au plus 20 nouvelles conversations par jour UTC et par acheteur. */
export const MESSAGES_PER_MINUTE = 30;
export const MESSAGES_PER_DAY = 300;
export const NEW_CONVERSATIONS_PER_DAY = 20;

/** Lecture des messages : taille d'une page. */
export const MESSAGES_PAGE_DEFAULT = 50;
export const MESSAGES_PAGE_MAX = 100;
/** Liste des conversations : les plus récentes d'abord. */
export const CONVERSATIONS_LIST_LIMIT = 50;
/** Aperçu du dernier message dans la liste (caractères). */
export const MESSAGE_PREVIEW_LENGTH = 100;

/** Corps des requêtes JSON : un message de 1000 caractères tient dans 8 Ko même en UTF-8 ; une déclaration de commande dans 1 Ko. */
export const MESSAGE_BODY_MAX_BYTES = 8_192;
export const ORDER_BODY_MAX_BYTES = 1_024;

/** Flux en direct : canal PostgreSQL, battement, plafond de flux ouverts par utilisateur (par processus). */
export const MESSAGES_CHANNEL = "noma_messages";
/** Battement (lot D3 : abaissé de 25 s à 15 s) : un flux dont le client a disparu sans fermer la connexion est détecté au plus tard au battement suivant. */
export const STREAM_HEARTBEAT_MS = 15_000;
export const STREAM_MAX_PER_USER = 5;
/** Attente (millisecondes) avant que le client rouvre le flux : indiquée au navigateur (champ `retry:`). */
export const STREAM_RETRY_MS = 3_000;

/** Commandes : prix convenu (XOF, entier). */
export const ORDER_MIN_PRICE = 1;
export const ORDER_MAX_PRICE = 100_000_000;
export const ORDERS_LIST_LIMIT = 50;

/**
 * Espaces des verrous consultatifs (voir la liste 1_314_664_945 à 956 déjà utilisée) : envois d'un même utilisateur, ouvertures de conversations d'un même acheteur,
 * favoris d'un même utilisateur.
 */
export const MESSAGE_SEND_LOCK_NAMESPACE = 1_314_664_957;
export const CONVERSATION_OPEN_LOCK_NAMESPACE = 1_314_664_958;
export const FAVORITES_LOCK_NAMESPACE = 1_314_664_959;

export const SOCIAL_TRANSACTION_TIMEOUT = "5s";
