import "server-only";

/**
 * Configuration de code des notifications de nouvelles correspondances et du suivi des besoins (lot N1). Voir NOTIFICATIONS.md.
 */

export const NOTIFICATIONS_CONTRACT_VERSION = "notifications/v1";
export const NOTIFICATION_PREFERENCES_CONTRACT_VERSION = "notification-preferences/v1";
export const DEMAND_TRACKING_CONTRACT_VERSION = "demand-tracking/v1";

/** Au plus ce nombre de notifications `new_match` par besoin et par jour UTC ; au-delà, un seul résumé (`new_matches_digest`). */
export const NEW_MATCH_DAILY_CAP_PER_DEMAND = 20;
/** Au plus ce nombre de notifications `new_match` par UTILISATEUR (tous besoins confondus) et par jour UTC ; au-delà, les annonces vont dans le résumé de leur besoin. */
export const NEW_MATCH_DAILY_CAP_PER_USER = 50;

/**
 * Rythme des envois EXTERNES (simulés) par utilisateur. Ce qui ne peut pas partir est REPORTÉ, jamais écarté pour cause de plafond :
 *  - fenêtre de collecte : un premier envoi en attente n'est envoyable qu'après 15 minutes, pour regrouper les rafales ;
 *  - au moins 4 heures entre deux messages au même utilisateur ;
 *  - au plus 3 messages par jour UTC.
 * Un message emporte TOUT ce qui est en attente pour l'utilisateur.
 */
export const EXTERNAL_COLLECTION_WINDOW_MS = 15 * 60_000;
export const EXTERNAL_MIN_INTERVAL_MS = 4 * 3_600_000;
export const EXTERNAL_DAILY_CAP_PER_USER = 3;

/** Heures calmes (UTC = Afrique/Abidjan) : de 22 h (inclus) à 7 h (exclu), aucun envoi externe ; reporté à 7 h. */
export const QUIET_HOURS_START_UTC = 22;
export const QUIET_HOURS_END_UTC = 7;

/** Tentatives d'envoi (appels au transport) avant l'état `failed`, et attente après chaque échec (croissante). */
export const DELIVERY_MAX_ATTEMPTS = 3;
export const DELIVERY_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5 * 60_000, 30 * 60_000]);

/** Un envoi encore en attente après ce délai (heures calmes, report, pannes, absence de transport) sort du canal externe : `skipped` (`expired`). La notification reste dans l'application. */
export const DELIVERY_MAX_AGE_MS = 48 * 3_600_000;

/**
 * Durée maximale d'un appel au transport, utilisateurs traités par cycle, lignes prises par message (un message emporte tout ce qui est en attente, jusqu'à cette borne ;
 * le reste part dans le message suivant), lignes expirées par cycle.
 */
export const TRANSPORT_TIMEOUT_MS = 5_000;
export const NOTIFY_USERS_PER_CYCLE = 20;
export const NOTIFY_ROWS_PER_USER = 5_000;
export const NOTIFY_EXPIRY_BATCH = 500;

/** Suivi d'un besoin : durée par défaut, prolongation, et plafond (à partir de maintenant). */
export const TRACKING_DEFAULT_DAYS = 30;
export const TRACKING_EXTEND_DAYS = 30;
export const TRACKING_MAX_DAYS = 90;

/** Lecture : taille de page et nombre maximal d'identifiants marqués lus en une requête. */
export const NOTIFICATIONS_PAGE_DEFAULT_LIMIT = 20;
export const NOTIFICATIONS_PAGE_MAX_LIMIT = 50;
export const NOTIFICATIONS_READ_MAX_IDS = 100;

/** Rétention : notifications lues depuis plus de 90 jours OU créées depuis plus de 180 jours ; envois créés depuis plus de 180 jours. */
export const NOTIFICATIONS_READ_RETENTION_DAYS = 90;
export const NOTIFICATIONS_RETENTION_DAYS = 180;
export const DELIVERIES_RETENTION_DAYS = 180;

/** Variable qui autorise `notifications:purge` quand NODE_ENV vaut `production`. */
export const NOTIFICATIONS_PURGE_PRODUCTION_VARIABLE = "NOMA_NOTIFICATIONS_PURGE_PRODUCTION";

/** Variable du transport simulé : valeur exacte « 1 » ET NODE_ENV=development (même verrou que l'OTP de développement). */
export const DEV_NOTIFY_FLAG = "NOMA_DEV_NOTIFY_CONSOLE";

/** Canal simulé : celui des lignes de l'outbox (colonne `channel`, contrainte de la migration 0019). */
export const SIMULATED_CHANNEL = "sms_sim" as const;
/** Canal du transport SMS réel « meno » (lot SMS1) : étiquette du transport seulement, jamais écrite dans l'outbox. */
export const MENO_CHANNEL = "sms_meno" as const;
export type NotificationChannel = typeof SIMULATED_CHANNEL | typeof MENO_CHANNEL;

/** Espaces des verrous consultatifs (voir la liste 1_314_664_945 à 954 déjà utilisée). */
export const NOTIFICATION_CAP_LOCK_NAMESPACE = 1_314_664_955;
export const NOTIFICATION_USER_LOCK_NAMESPACE = 1_314_664_956;

/** Texte fixe : tant qu'aucun vrai transport n'existe, il est affiché avec les préférences. */
export const EXTERNAL_NOTICE = "Les envois par SMS ne sont pas encore disponibles : ils sont simulés en développement.";

/** Texte affiché avec les préférences quand le transport SMS réel est configuré (lot SMS1). */
export const EXTERNAL_NOTICE_REAL = "Un SMS regroupé vous prévient des nouvelles annonces : au plus 3 par jour, jamais entre 22 h et 7 h.";

/** Migration requise par les étapes et les routes de ce lot. */
export const NOTIFICATIONS_MIGRATION = "0019_notifications";
