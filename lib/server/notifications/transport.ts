import "server-only";

import { DEV_NOTIFY_FLAG, SIMULATED_CHANNEL, type NotificationChannel } from "./config";
import { createNotificationResolverWithMeno } from "../sms/transports";

type Environment = Record<string, string | undefined>;

/**
 * Port d'envoi hors de l'application (lot N1). Un transport reçoit UN message regroupé : le nombre d'annonces, un lien vers /notifications et une clé
 * d'idempotence déterministe (la même pour les mêmes envois : un vrai fournisseur pourra dédoublonner). Il ne reçoit JAMAIS de titre, de prix, de
 * numéro ni de texte libre. Une erreur levée (ou un dépassement du délai) est un échec de tentative.
 * Seule implémentation : le transport de développement (console). Aucun vrai SMS n'existe : voir NOTIFICATIONS.md, « Ce qui manque pour un vrai SMS ».
 */
export interface NotificationMessage {
  userId: string;
  count: number;
  link: string;
  idempotencyKey: string;
}

export interface NotificationTransport {
  readonly channel: NotificationChannel;
  /** Durée maximale d'un appel (lot SMS1) ; défaut : TRANSPORT_TIMEOUT_MS (5 s). Un vrai fournisseur peut en demander davantage. */
  readonly timeoutMs?: number;
  send(message: NotificationMessage): Promise<void>;
}

export { NotificationBudgetError, NotificationUncertainError } from "./errors";

/** Identifiant de compte tronqué pour la console : 8 caractères au plus, jamais l'identifiant entier. */
export function maskUserId(userId: string): string {
  return `${String(userId).replace(/[^0-9a-fA-F]/g, "").slice(0, 8).toLowerCase()}…`;
}

/** Avertissement fixe (une seule fois par résolveur) quand le drapeau est présent hors développement. */
export const DEV_NOTIFY_REFUSED_WARNING =
  "[notify:dev] NOMA_DEV_NOTIFY_CONSOLE=1 ignoré : le transport de notification de développement exige NODE_ENV=development ; aucun envoi externe n'est possible.";

/** Le transport de développement n'existe que dans la combinaison exacte NODE_ENV=development + drapeau « 1 » (même verrou que le transport OTP). */
export function isDevNotifyConsoleEnabled(env: Environment): boolean {
  return env.NODE_ENV === "development" && env[DEV_NOTIFY_FLAG] === "1";
}

/**
 * Transport qui écrit UNE ligne sur la sortie du processus : identifiant tronqué, nombre d'annonces, lien. Rien d'autre (ni titre, ni prix, ni
 * numéro, ni identifiant complet, ni clé d'idempotence).
 */
export function createDevConsoleTransport(write: (line: string) => void): NotificationTransport {
  return {
    channel: SIMULATED_CHANNEL,
    async send(message: NotificationMessage): Promise<void> {
      const noun = message.count === 1 ? "annonce" : "annonces";
      write(`[notify:dev] envoi simulé à ${maskUserId(message.userId)} : ${message.count} ${noun}, lien ${message.link}`);
    },
  };
}

export interface NotificationTransportResolverOptions {
  /** Sortie de la ligne d'envoi (défaut : console.log). */
  write?: (line: string) => void;
  /** Sortie de l'avertissement (défaut : console.warn). */
  warn?: (line: string) => void;
}

/**
 * Résolveur appelé à chaque cycle (l'environnement est relu à l'usage) :
 * - drapeau « 1 » avec NODE_ENV=development : le transport de développement ;
 * - drapeau « 1 » avec toute autre valeur de NODE_ENV (production comprise) : REFUS, aucun transport, avertissement fixe journalisé UNE seule fois ;
 * - sinon : aucun transport, aucun message.
 * Sans transport, aucun envoi externe n'a lieu.
 */
export function createNotificationTransportResolver(
  options: NotificationTransportResolverOptions = {},
): (env: Environment) => NotificationTransport | undefined {
  const write = options.write ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  let warned = false;
  let transport: NotificationTransport | undefined;
  return (env) => {
    if (env[DEV_NOTIFY_FLAG] !== "1") return undefined;
    if (!isDevNotifyConsoleEnabled(env)) {
      if (!warned) {
        warned = true;
        warn(DEV_NOTIFY_REFUSED_WARNING);
      }
      return undefined;
    }
    transport ??= createDevConsoleTransport(write);
    return transport;
  };
}

/** Résolveur du transport de DÉVELOPPEMENT seul (console), inchangé depuis N1. */
export const resolveDevNotificationTransport = createNotificationTransportResolver();

/**
 * Résolveur du runtime : branché uniquement dans l'étape « notify » du runner (le worker) et dans les préférences (disponibilité affichée). Lot SMS1 : le transport SMS réel
 * « meno » s'il est configuré (NOMA_SMS_PROVIDER=meno + clé), sinon le transport de développement ci-dessus.
 */
export const resolveNotificationTransport = createNotificationResolverWithMeno(resolveDevNotificationTransport);
