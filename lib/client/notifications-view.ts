/**
 * Présentation des notifications et du suivi d'un besoin (lot N1) : libellés et règles en fonctions PURES, sans React, testées isolément. Trois écrans :
 *  - la page « Notifications » (liste, non-lues en gras, « Tout marquer comme lu », lien vers la fiche dans le contexte du besoin) ;
 *  - la pastille du nombre de non-lues de la navigation (rafraîchie à l'arrivée sur une page et au retour au premier plan, JAMAIS plus d'une fois par minute) ;
 *  - le suivi d'un besoin (« Suivi actif jusqu'au … », prolonger, pause, reprise) et les préférences d'envoi (page Compte).
 *
 * Règles : tout en mots simples ; jamais d'identifiant ni de numéro à l'écran ; un lien ne mène QUE à une page interne reconstruite depuis les identifiants ;
 * « pause » et « fin du suivi » n'arrêtent que les notifications (les résultats du besoin restent à jour). Voir NOTIFICATIONS.md.
 */

import type { DemandTracking, NotificationItem, NotificationPreferences, TrackingAction } from "./api";
import { formatMoney } from "./catalog-view";
import { offerDetailPath } from "./metrics-view";
import { formatDateFr, formatDateTimeFr } from "./wallet-view";

export const NOTIFICATIONS_PAGE_TITLE = "Notifications";
export const NOTIFICATIONS_LOADING = "Chargement de vos notifications…";
export const EMPTY_NOTIFICATIONS_MESSAGE = "Aucune notification pour le moment.";
export const EMPTY_NOTIFICATIONS_HINT = "Quand une nouvelle annonce correspond à l'un de vos besoins, elle apparaît ici.";
export const MARK_ALL_READ_LABEL = "Tout marquer comme lu";
export const MARK_ALL_READ_DONE = "Toutes vos notifications sont marquées comme lues.";
/** Après « Tout marquer comme lu » quand d'autres notifications sont arrivées depuis le chargement de l'écran : elles restent non lues. */
export const MARK_SHOWN_READ_DONE = "Les notifications affichées sont marquées comme lues. D'autres sont arrivées depuis.";
export const LOAD_MORE_LABEL = "Voir plus";
export const OPEN_LISTING_LABEL = "Voir l'annonce";
export const OPEN_NEED_LABEL = "Voir mon besoin";
export const UNREAD_SR_LABEL = "non lue";

// ───────────── pastille de la navigation ─────────────

/** Plus d'une requête par minute : aucun sondage serré. */
export const UNREAD_REFRESH_MIN_INTERVAL_MS = 60_000;
/** Au-delà, la pastille dit « 99+ ». */
export const UNREAD_BADGE_CAP = 99;

/** Texte de la pastille : rien pour zéro (ou un compte illisible), le nombre jusqu'à 99, « 99+ » au-delà. */
export function unreadBadgeLabel(count: number | null): string | null {
  if (count === null || !Number.isSafeInteger(count) || count <= 0) return null;
  return count > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(count);
}

/** Texte lu par un lecteur d'écran pour la pastille. */
export function unreadBadgeAccessibleLabel(count: number | null): string {
  if (count === null || !Number.isSafeInteger(count) || count <= 0) return "Notifications";
  return count === 1 ? "Notifications : 1 non lue" : `Notifications : ${count > UNREAD_BADGE_CAP ? `plus de ${UNREAD_BADGE_CAP}` : count} non lues`;
}

export interface UnreadRefresher {
  /**
   * Relit le nombre de non-lues SAUF si une lecture a déjà été tentée depuis moins d'une minute (réussie ou non : une panne ne provoque jamais de rafale)
   * ou si `force` est vrai. Les appels simultanés partagent UNE seule requête. Une erreur garde le dernier compte connu.
   */
  refresh(options?: { force?: boolean }): Promise<void>;
  /** Compte connu par ailleurs (réponse de « marquer comme lu », page de la liste) : met la pastille à jour sans requête. */
  set(count: number): void;
  subscribe(listener: () => void): () => void;
  /** Dernier compte connu ; null tant qu'aucune lecture n'a abouti. */
  get(): number | null;
}

export interface UnreadRefresherOptions {
  /** Lit le nombre de non-lues (une requête). */
  fetchCount: () => Promise<number>;
  /** Horloge en millisecondes (injectable : tests). */
  now?: () => number;
  minIntervalMs?: number;
}

export function createUnreadRefresher(options: UnreadRefresherOptions): UnreadRefresher {
  const now = options.now ?? (() => Date.now());
  const minInterval = options.minIntervalMs ?? UNREAD_REFRESH_MIN_INTERVAL_MS;
  let count: number | null = null;
  let lastAttemptAt: number | null = null;
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: number) => {
    if (next === count) return;
    count = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    refresh(refreshOptions = {}) {
      if (inFlight) return inFlight;
      const at = now();
      if (refreshOptions.force !== true && lastAttemptAt !== null && at - lastAttemptAt < minInterval && at >= lastAttemptAt) return Promise.resolve();
      lastAttemptAt = at;
      inFlight = options
        .fetchCount()
        .then(
          (next) => {
            if (Number.isSafeInteger(next) && next >= 0) publish(next);
          },
          () => {
            // Panne : on garde le dernier compte connu ; la prochaine tentative attend une minute (sauf demande explicite).
          },
        )
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    set(next) {
      if (Number.isSafeInteger(next) && next >= 0) publish(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => count,
  };
}

// ───────────── liste ─────────────

export interface NotificationRowView {
  id: string;
  kind: NotificationItem["kind"];
  /** « Apple iPhone 12 128 Go » ou « 8 nouvelles annonces ». */
  title: string;
  /** « 150 000 FCFA » ou le texte d'un résumé ; null s'il n'y a rien à dire. */
  subtitle: string | null;
  dateText: string;
  unread: boolean;
  /** Page interne reconstruite depuis les identifiants (jamais le lien tel quel) ; null si un identifiant est illisible. */
  href: string | null;
  linkLabel: string;
}

export function summaryTitle(count: number): string {
  return count === 1 ? "1 nouvelle annonce pour ce besoin" : `${count} nouvelles annonces pour ce besoin`;
}

export function notificationRow(item: NotificationItem): NotificationRowView {
  const date = formatDateTimeFr(item.createdAt);
  if (item.kind === "new_matches_digest") {
    return {
      id: item.id,
      kind: item.kind,
      title: summaryTitle(item.count ?? 0),
      subtitle: "Au-delà de 20 annonces par jour (50 pour tous vos besoins), elles sont regroupées ici.",
      dateText: date,
      unread: item.readAt === null,
      href: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.demandId) ? `/besoins/${item.demandId}` : null,
      linkLabel: OPEN_NEED_LABEL,
    };
  }
  return {
    id: item.id,
    kind: item.kind,
    title: item.title ?? "Nouvelle annonce",
    subtitle: formatMoney(item.price),
    dateText: date,
    unread: item.readAt === null,
    href: item.offerId === null ? null : offerDetailPath(item.demandId, item.offerId),
    linkLabel: OPEN_LISTING_LABEL,
  };
}

/** Ajoute une page à la liste sans doublon (un identifiant déjà présent garde sa première occurrence). */
export function mergeNotificationPages(current: readonly NotificationItem[], next: readonly NotificationItem[]): NotificationItem[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...next.filter((item) => !seen.has(item.id))];
}

/**
 * Date de la plus récente notification affichée (`YYYY-MM-DDTHH:MM:SS.mmmZ`), celle que « Tout marquer comme lu » envoie (`upTo`) : ce qui est arrivé après le chargement
 * reste non lu. Null s'il n'y a rien d'affiché.
 */
export function newestCreatedAt(items: readonly NotificationItem[]): string | null {
  let newest = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const at = Date.parse(item.createdAt);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return Number.isFinite(newest) ? new Date(newest).toISOString() : null;
}

/** Marque localement ces notifications comme lues (`{ upTo }` : celles créées avant ou à cette date, à la milliseconde, comme le serveur) ; une notification déjà lue garde sa date. */
export function markReadLocally(items: readonly NotificationItem[], target: { upTo: string } | readonly string[], readAt: string): NotificationItem[] {
  if (Array.isArray(target)) {
    const ids = new Set(target as readonly string[]);
    return items.map((item) => (item.readAt === null && ids.has(item.id) ? { ...item, readAt } : item));
  }
  const limit = Date.parse((target as { upTo: string }).upTo);
  return items.map((item) => (item.readAt === null && Date.parse(item.createdAt) <= limit ? { ...item, readAt } : item));
}

/** Nombre de notifications non lues parmi celles affichées. */
export function unreadInList(items: readonly NotificationItem[]): number {
  return items.filter((item) => item.readAt === null).length;
}

export type NotificationsListState = "loading" | "empty" | "list";

export function notificationsListState(input: { loaded: boolean; itemCount: number }): NotificationsListState {
  if (!input.loaded) return "loading";
  return input.itemCount === 0 ? "empty" : "list";
}

// ───────────── suivi d'un besoin ─────────────

export const TRACKING_TITLE = "Suivi de ce besoin";
export const TRACKING_NOTE = "Pendant une pause ou après la fin du suivi, les résultats restent à jour : seules les notifications s'arrêtent.";
export const TRACKING_LOADING = "Chargement du suivi…";
export const TRACKING_EXTEND_LABEL = "Prolonger de 30 jours";
export const TRACKING_PAUSE_LABEL = "Mettre en pause";
export const TRACKING_RESUME_LABEL = "Reprendre";
export const TRACKING_AT_MAXIMUM = "Déjà au maximum : 90 jours à partir d'aujourd'hui.";

export interface TrackingView {
  /** Phrase d'état : « Suivi actif jusqu'au 05/11/2026 », « Suivi en pause », « Suivi terminé le … ». */
  headline: string;
  /** Précision sous la phrase (ce qui se passe, ce qu'il faut faire). */
  detail: string;
  tone: "active" | "paused" | "ended" | "closed";
  canPause: boolean;
  canResume: boolean;
  canExtend: boolean;
  /** Le suivi est déjà à son maximum (rien à prolonger). */
  atMaximum: boolean;
  /** Le suivi n'a de sens que pour un besoin actif. */
  applicable: boolean;
}

/** Vrai si l'échéance est déjà celle du plafond (à la minute près : le serveur renvoie des instants différents d'une milliseconde). */
function isAtMaximum(tracking: Pick<DemandTracking, "until" | "maxUntil">): boolean {
  return Date.parse(tracking.until) >= Date.parse(tracking.maxUntil) - 60_000;
}

export function trackingView(tracking: DemandTracking): TrackingView {
  if (tracking.demandStatus !== "active") {
    return {
      headline: "Suivi arrêté",
      detail: "Le suivi ne s'applique qu'à un besoin actif. Réactivez le besoin pour être prévenu de nouvelles annonces.",
      tone: "closed",
      canPause: false,
      canResume: false,
      canExtend: false,
      atMaximum: false,
      applicable: false,
    };
  }
  const atMaximum = isAtMaximum(tracking);
  const ended = !tracking.paused && Date.parse(tracking.until) <= Date.parse(tracking.readAt);
  if (tracking.paused) {
    return {
      headline: "Suivi en pause",
      detail: "Vos résultats restent à jour, mais vous ne recevez plus de notification pour ce besoin.",
      tone: "paused",
      canPause: false,
      canResume: true,
      canExtend: !atMaximum,
      atMaximum,
      applicable: true,
    };
  }
  if (ended) {
    return {
      headline: `Suivi terminé le ${formatDateFr(tracking.until)}`,
      detail: "Vos résultats restent à jour, mais vous ne recevez plus de notification. Prolongez le suivi pour en recevoir de nouveau.",
      tone: "ended",
      canPause: false,
      canResume: false,
      canExtend: true,
      atMaximum: false,
      applicable: true,
    };
  }
  return {
    headline: `Suivi actif jusqu'au ${formatDateFr(tracking.until)}`,
    detail: "Vous êtes prévenu quand une nouvelle annonce correspond à ce besoin.",
    tone: "active",
    canPause: true,
    canResume: false,
    canExtend: !atMaximum,
    atMaximum,
    applicable: true,
  };
}

const TRACKING_DONE: Readonly<Record<TrackingAction, string>> = Object.freeze({
  extend: "Suivi prolongé",
  pause: "Suivi mis en pause",
  resume: "Suivi repris",
});

export function trackingActionDone(action: TrackingAction): string {
  return TRACKING_DONE[action];
}

// ───────────── préférences d'envoi (page Compte) ─────────────

export const PREFERENCES_TITLE = "Notifications par SMS";
export const PREFERENCES_LABEL = "Me prévenir par SMS (simulé)";
export const PREFERENCES_HINT = "Désactivé par défaut. Au plus 3 messages par jour, regroupés, jamais entre 22 h et 7 h.";
export const PREFERENCES_UNAVAILABLE = "Aucun envoi n'est possible dans cet environnement : le choix est enregistré, rien n'est envoyé.";
export const PREFERENCES_LOADING = "Chargement de vos préférences…";
/** Texte fixe du serveur, repris à l'identique (testé contre le serveur). */
export const EXTERNAL_NOTICE = "Les envois par SMS ne sont pas encore disponibles : ils sont simulés en développement.";

export function preferencesView(preferences: NotificationPreferences): { enabled: boolean; notice: string; extra: string | null } {
  return {
    enabled: preferences.externalEnabled,
    notice: preferences.notice,
    extra: preferences.externalAvailable ? null : PREFERENCES_UNAVAILABLE,
  };
}
