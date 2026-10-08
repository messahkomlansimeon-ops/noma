/**
 * Éléments partagés par les essais de la collecte d'annonces externes (lot EXT1) : besoins actifs, horloge pilotée, attente instantanée, garde du réseau sortant.
 */

import assert from "node:assert/strict";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createDemand, createUser } from "../../lib/server/catalog";
import type { DemandRecord } from "../../lib/server/catalog/types";
import type { ListingAnalysis } from "../../lib/server/external/analysis";
import { analyzeContent } from "../../lib/server/external/analysis";
import type { Analyzer } from "../../lib/server/external/store";

export { createFakeConnectors, createFakeConnector, FAKE_SOURCE_A, FAKE_SOURCE_B, type FakeConnector } from "../../lib/server/external/fake-connectors";

export interface DemandOptions {
  ownerId?: string;
  category?: string;
  brand?: string;
  model?: string;
  variant?: string | null;
  location?: string | null;
  budget?: number | null;
  status?: "active" | "draft";
  rawText?: string;
}

/** Clé d'empreinte des identifiants externes en essai (le serveur la dérive de NOMA_AUTH_SECRET ; les essais en donnent une, jamais le secret réel). */
export const TEST_PSEUDONYM_KEY = Buffer.from("noma-test-external-id-key-0123456789abcdef", "utf8");

/** Une barrière : `wait` se résout quand `open()` est appelé. */
export function barrier(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

export const IPHONE = { category: "Téléphones", brand: "Apple", model: "iPhone 12" } as const;

/** Un besoin (actif par défaut) d'un nouvel utilisateur ou de `ownerId`. */
export async function makeDemand(pool: Pool, options: DemandOptions = {}): Promise<DemandRecord> {
  const ownerId = options.ownerId ?? (await createUser({}, pool)).id;
  return createDemand(
    {
      ownerId,
      rawText: options.rawText ?? `Je cherche un ${options.model ?? IPHONE.model}`,
      category: options.category ?? IPHONE.category,
      brand: options.brand ?? IPHONE.brand,
      model: options.model ?? IPHONE.model,
      variant: options.variant ?? null,
      location: options.location === undefined ? "Abidjan" : options.location,
      budget: options.budget === null ? null : { amount: options.budget ?? 200_000, currency: "XOF" },
      status: options.status ?? "active",
    },
    pool,
  );
}

/** Horloge pilotée par l'essai. */
export function fixedClock(start: Date = new Date()): { now: () => Date; advance: (ms: number) => void; set: (date: Date) => void } {
  let current = start.getTime();
  return { now: () => new Date(current), advance: (ms) => void (current += ms), set: (date) => void (current = date.getTime()) };
}

/** Attente instantanée qui garde la trace des délais demandés. */
export function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}

/** Analyseur qui compte ses appels (une analyse = un appel). */
export function countingAnalyzer(): { analyze: Analyzer; calls: Array<{ title: string | null }> } {
  const calls: Array<{ title: string | null }> = [];
  const analyze: Analyzer = (content): ListingAnalysis => {
    calls.push({ title: content.title });
    return analyzeContent(content);
  };
  return { analyze, calls };
}

export const count = async (pool: Pool, table: string, where = "TRUE"): Promise<number> => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;

/** Vide les tables de la collecte (les sources fictives de la migration restent). */
export async function resetExternal(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE source_observations, external_listings, duplicate_groups, external_analyses, external_collect_runs, external_source_usage, market_watch_usage, market_watches CASCADE");
  await pool.query("DELETE FROM external_sources WHERE code NOT IN ('demo_a', 'demo_b')");
  await pool.query("UPDATE external_sources SET enabled = TRUE, consecutive_failures = 0, breaker_open_until = NULL, last_request_at = NULL, last_success_at = NULL, last_failure_at = NULL, last_error_code = NULL, daily_quota = 200, min_interval_ms = 0");
}

/** Vide les besoins et leurs dépendances (pour que seuls les besoins d'un essai créent des surveillances). */
export async function resetDemands(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE matching_evaluations, matching_jobs, matching_outbox_events, notifications, demands, offers CASCADE");
}

// ───────────── garde du réseau sortant ─────────────

export interface NetworkGuard {
  /** Tentatives de connexion sortante (hors boucle locale et sockets Unix) : doit rester vide. */
  attempts: string[];
  restore(): void;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

/** Fonctions de résolution de noms de `dns` et de `dns.promises` (`lookup` est traitée à part : la boucle locale est permise). */
const DNS_RESOLVERS = [
  "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv",
  "resolveTxt", "reverse",
] as const;

/**
 * Installe un garde du réseau sortant : tout appel à `fetch`, `http.request`, `https.request`, `dns.lookup`, `dns.resolve*`, `dns.promises.*` (lookup et resolve*), `dgram` (UDP) ou
 * toute connexion TCP vers autre chose que la boucle locale (PostgreSQL d'essai) est ENREGISTRÉ puis refusé. Le garde est testé lui-même (voir `selfTestNetworkGuard`).
 */
export function installNetworkGuard(): NetworkGuard {
  const attempts: string[] = [];
  const restorers: Array<() => void> = [];
  const originals = {
    fetch: globalThis.fetch,
    connect: net.Socket.prototype.connect,
    httpRequest: http.request,
    httpsRequest: https.request,
    lookup: dns.lookup,
    promisesLookup: dnsPromises.lookup,
    createSocket: dgram.createSocket,
    send: dgram.Socket.prototype.send,
  };
  const refuse = (label: string): never => {
    attempts.push(label);
    throw new Error(`réseau sortant refusé par le garde d'essai : ${label}`);
  };
  globalThis.fetch = ((input: unknown) => {
    attempts.push(`fetch ${typeof input === "string" ? input : String((input as { url?: string }).url ?? input)}`);
    return Promise.reject(new Error("réseau sortant refusé par le garde d'essai : fetch"));
  }) as typeof fetch;
  net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]) {
    // Node passe parfois les arguments déjà normalisés : un tableau [options, rappel].
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    let host: string | undefined;
    let isPath = false;
    if (typeof first === "object" && first !== null) {
      const options = first as { host?: string; path?: string; port?: number };
      if (typeof options.path === "string") isPath = true;
      host = options.host ?? "localhost";
    } else if (typeof first === "number" || (typeof first === "string" && /^[0-9]+$/.test(first))) {
      host = typeof args[1] === "string" ? args[1] : "localhost";
    } else if (typeof first === "string") {
      isPath = true;
    }
    if (!isPath && (host === undefined || !LOOPBACK.has(host))) return refuse(`connexion TCP vers ${host ?? "?"}`);
    return (originals.connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  http.request = ((...args: unknown[]) => refuse(`http.request ${String(args[0])}`)) as typeof http.request;
  https.request = ((...args: unknown[]) => refuse(`https.request ${String(args[0])}`)) as typeof https.request;
  dns.lookup = ((hostname: string, ...rest: unknown[]) => {
    if (net.isIP(hostname) === 0 && !LOOPBACK.has(hostname)) {
      attempts.push(`dns.lookup ${hostname}`);
      const callback = rest[rest.length - 1];
      if (typeof callback === "function") return (callback as (error: Error) => void)(new Error("réseau sortant refusé par le garde d'essai : dns"));
    }
    return (originals.lookup as (...a: unknown[]) => unknown)(hostname, ...rest);
  }) as typeof dns.lookup;
  dnsPromises.lookup = ((hostname: string, ...rest: unknown[]) => {
    if (net.isIP(hostname) === 0 && !LOOPBACK.has(hostname)) {
      attempts.push(`dns.promises.lookup ${hostname}`);
      return Promise.reject(new Error("réseau sortant refusé par le garde d'essai : dns.promises.lookup"));
    }
    return (originals.promisesLookup as (...a: unknown[]) => Promise<unknown>)(hostname, ...rest);
  }) as typeof dnsPromises.lookup;
  for (const name of DNS_RESOLVERS) {
    const callbackStyle = dns as unknown as Record<string, unknown>;
    const promiseStyle = dnsPromises as unknown as Record<string, unknown>;
    const originalCallback = callbackStyle[name];
    const originalPromise = promiseStyle[name];
    callbackStyle[name] = (target: unknown, ...rest: unknown[]) => {
      attempts.push(`dns.${name} ${String(target)}`);
      const callback = rest[rest.length - 1];
      if (typeof callback === "function") return (callback as (error: Error) => void)(new Error(`réseau sortant refusé par le garde d'essai : dns.${name}`));
      throw new Error(`réseau sortant refusé par le garde d'essai : dns.${name}`);
    };
    promiseStyle[name] = (target: unknown) => {
      attempts.push(`dns.promises.${name} ${String(target)}`);
      return Promise.reject(new Error(`réseau sortant refusé par le garde d'essai : dns.promises.${name}`));
    };
    restorers.push(() => {
      callbackStyle[name] = originalCallback;
      promiseStyle[name] = originalPromise;
    });
  }
  dgram.createSocket = ((...args: unknown[]) => refuse(`dgram.createSocket ${String(args[0])}`)) as typeof dgram.createSocket;
  dgram.Socket.prototype.send = ((...args: unknown[]) => refuse(`dgram.send ${String(args[args.length - 2] ?? "?")}`)) as typeof dgram.Socket.prototype.send;
  return {
    attempts,
    restore() {
      globalThis.fetch = originals.fetch;
      net.Socket.prototype.connect = originals.connect;
      http.request = originals.httpRequest;
      https.request = originals.httpsRequest;
      dns.lookup = originals.lookup;
      dnsPromises.lookup = originals.promisesLookup;
      dgram.createSocket = originals.createSocket;
      dgram.Socket.prototype.send = originals.send;
      for (const restore of restorers) restore();
    },
  };
}

/**
 * Le garde fonctionne : il enregistre et refuse fetch, http, une connexion TCP externe, dns.lookup, dns.promises.lookup, dns.resolve*, dns.promises.resolve*, dgram (création et
 * envoi), et laisse passer la boucle locale.
 */
export async function selfTestNetworkGuard(guard: NetworkGuard): Promise<void> {
  const before = guard.attempts.length;
  await assert.rejects(() => fetch("https://exemple-externe.example/annonce"), /garde d'essai/);
  assert.throws(() => net.connect({ host: "203.0.113.7", port: 443 }), /garde d'essai/);
  assert.throws(() => http.request("http://203.0.113.7/"), /garde d'essai/);
  assert.throws(() => https.request("https://203.0.113.7/"), /garde d'essai/);
  await new Promise<void>((resolve, reject) => dns.lookup("exemple-externe.example", (error) => (error && /garde d'essai/.test(error.message) ? resolve() : reject(error ?? new Error("dns.lookup non refusé")))));
  await assert.rejects(() => dnsPromises.lookup("exemple-externe.example"), /garde d'essai/);
  await new Promise<void>((resolve, reject) => dns.resolve4("exemple-externe.example", (error) => (error && /garde d'essai/.test(error.message) ? resolve() : reject(error ?? new Error("dns.resolve4 non refusé")))));
  await assert.rejects(() => dnsPromises.resolve4("exemple-externe.example"), /garde d'essai/);
  await assert.rejects(() => dnsPromises.resolveTxt("exemple-externe.example"), /garde d'essai/);
  await assert.rejects(() => dnsPromises.reverse("203.0.113.7"), /garde d'essai/);
  assert.throws(() => dgram.createSocket("udp4"), /garde d'essai/);
  assert.equal(guard.attempts.length, before + 11, "onze tentatives externes enregistrées");
  guard.attempts.length = before;
  // La boucle locale reste permise (PostgreSQL d'essai) : une connexion refusée par le système n'est pas une tentative externe.
  await new Promise<void>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 1 });
    socket.once("error", () => resolve());
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
  });
  assert.equal(guard.attempts.length, before, "la boucle locale n'est pas une tentative externe");
}

export const newId = (): string => randomUUID();
