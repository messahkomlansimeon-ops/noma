/**
 * Quotas publics (Lot 4) — par session (cookie sécurisé) et par empreinte
 * IP pseudonymisée : 2 démarrages/minute, 10/jour, 1 recherche active ;
 * global : 2 recherches simultanées. Refus SANS file d'attente avec
 * Retry-After. Toutes les décisions passent par UNE transaction atomique
 * (admission) pour éliminer les course conditions.
 */
import { dayKey, withTransaction, type GuardDatabase } from "./db";

export type AdmissionRejection =
  | "rate-minute"
  | "rate-day"
  | "already-active"
  | "global-saturated";

export interface AdmissionInput {
  sessionId: string;
  ipHash: string;
  now: Date;
  timezone?: string;
  /** TTL de grâce : les recherches actives plus anciennes sont considérées
   *  mortes (crash) et nettoyées. */
  activeSearchTtlMs: number;
  startsPerMinute: number;
  startsPerDay: number;
  maxConcurrentSearches: number;
}

export interface AdmissionOutcome {
  allowed: boolean;
  rejection?: AdmissionRejection;
  /** Secondes avant nouvelle tentative (refus sans file d'attente). */
  retryAfterSeconds?: number;
  searchId?: string;
}

const minuteWindow = (now: Date): string => {
  const d = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  return d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
};

const secondsUntilNextMinute = (now: Date): number =>
  Math.max(1, Math.ceil((60_000 - (now.getTime() % 60_000)) / 1000));

/** Secondes jusqu'au prochain changement de jour (fuseau du budget) —
 *  calcul DIRECT (aucun balayage seconde par seconde : un refus quotidien
 *  ne doit jamais bloquer le serveur). Une correction compense le décalage
 *  horaire éventuel à minuit (fuseaux avec heure d'été). */
export function secondsUntilNextDay(now: Date, timezone: string): number {
  const offsetAt = (date: Date): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(date);
    const get = (type: string): number =>
      Number(parts.find((p) => p.type === type)?.value ?? "0");
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) - date.getTime();
  };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  // mur local : minuit du lendemain, ramené en UTC avec le décalage du jour
  const nextMidnightWall = Date.UTC(get("year"), get("month") - 1, get("day") + 1);
  const target = nextMidnightWall - offsetAt(new Date(nextMidnightWall - offsetAt(now)));
  return Math.max(1, Math.round((target - now.getTime()) / 1000));
}

const bumpAttempt = (
  db: GuardDatabase,
  scope: string,
  windowKey: string,
): number => {
  db.prepare(
    `INSERT INTO attempts (scope, window_key, count) VALUES (?, ?, 1)
     ON CONFLICT(scope, window_key) DO UPDATE SET count = count + 1`,
  ).run(scope, windowKey);
  const row = db
    .prepare("SELECT count FROM attempts WHERE scope = ? AND window_key = ?")
    .get(scope, windowKey) as { count: number | bigint };
  return Number(row.count);
};

/** Admission d'un démarrage de recherche — compteur d'essais incrémenté
 *  même en cas de refus (anti-marteau), décision atomique. */
export function admitSearch(db: GuardDatabase, input: AdmissionInput): AdmissionOutcome {
  const tz = input.timezone ?? "Africa/Abidjan";
  const day = dayKey(input.now, tz);
  const minute = minuteWindow(input.now);
  return withTransaction(db, (): AdmissionOutcome => {
    // nettoyage opportuniste des recherches actives mortes (crash process)
    db.prepare("DELETE FROM active_searches WHERE started_at < ?")
      .run(input.now.getTime() - input.activeSearchTtlMs);

    const sessionMinute = bumpAttempt(db, `session:${minute}`, input.sessionId);
    if (sessionMinute > input.startsPerMinute) {
      return { allowed: false, rejection: "rate-minute", retryAfterSeconds: secondsUntilNextMinute(input.now) };
    }
    const sessionDay = bumpAttempt(db, `session:day:${day}`, input.sessionId);
    if (sessionDay > input.startsPerDay) {
      return { allowed: false, rejection: "rate-day", retryAfterSeconds: secondsUntilNextDay(input.now, tz) };
    }
    const ipMinute = bumpAttempt(db, `ip:${minute}`, input.ipHash);
    if (ipMinute > input.startsPerMinute) {
      return { allowed: false, rejection: "rate-minute", retryAfterSeconds: secondsUntilNextMinute(input.now) };
    }
    const ipDay = bumpAttempt(db, `ip:day:${day}`, input.ipHash);
    if (ipDay > input.startsPerDay) {
      return { allowed: false, rejection: "rate-day", retryAfterSeconds: secondsUntilNextDay(input.now, tz) };
    }

    const activeForSession = db
      .prepare("SELECT COUNT(*) AS n FROM active_searches WHERE session_id = ?")
      .get(input.sessionId) as { n: number | bigint };
    if (Number(activeForSession.n) > 0) {
      return { allowed: false, rejection: "already-active" };
    }
    const globalActive = db
      .prepare("SELECT COUNT(*) AS n FROM active_searches")
      .get() as { n: number | bigint };
    if (Number(globalActive.n) >= input.maxConcurrentSearches) {
      // refus sans file d'attente : nouvelle tentative quand une place se libère
      return { allowed: false, rejection: "global-saturated", retryAfterSeconds: 15 };
    }

    const searchId = `s-${input.now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(
      "INSERT INTO active_searches (session_id, search_id, ip_hash, started_at) VALUES (?, ?, ?, ?)",
    ).run(input.sessionId, searchId, input.ipHash, input.now.getTime());
    return { allowed: true, searchId };
  });
}

/** Libération en fin de recherche (arrêt, déconnexion, échéance). */
export function releaseActive(db: GuardDatabase, sessionId: string, searchId: string): void {
  withTransaction(db, () => {
    db.prepare("DELETE FROM active_searches WHERE session_id = ? AND search_id = ?")
      .run(sessionId, searchId);
  });
}

export function activeSearches(db: GuardDatabase): { sessionId: string; searchId: string; startedAt: number }[] {
  return db
    .prepare("SELECT session_id, search_id, started_at FROM active_searches")
    .all()
    .map((r) => ({ sessionId: r.session_id as string, searchId: r.search_id as string, startedAt: Number(r.started_at) }));
}