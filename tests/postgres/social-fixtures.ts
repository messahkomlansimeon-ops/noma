/**
 * Éléments partagés par les essais du lot D2 (favoris, messagerie, commandes, administration) : schéma jetable migré, connexion par code (vraies sessions), requêtes
 * HTTP vers les gestionnaires, comptes avec correspondance confirmée.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { requestOtp, verifyOtp, type SendOtpInput } from "../../lib/server/auth";
import type { DemandRecord, OfferRecord } from "../../lib/server/catalog/types";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { makeDemand, makeMatch, makeOffer, type OfferOptions } from "./metrics-fixtures";
import {
  createTemporarySchemaName, openVerifiedTestDatabase, quoteTemporarySchema, type DedicatedTestDatabase,
} from "./test-database";

export const ORIGIN = "https://noma.test";
export const SECRET = randomBytes(32);
export const NOT_FOUND = { error: { code: "resource_not_found", message: "Ressource introuvable." } };

export interface TestSchema {
  admin: Pool;
  pool: Pool;
  target: DedicatedTestDatabase;
  schema: string;
  /** Un pool de plus (même schéma), à fermer par l'appelant. */
  extraPool(max?: number): Pool;
  close(): Promise<void>;
}

/** Un schéma jetable migré jusqu'au bout, avec un pool de plusieurs connexions (les essais de concurrence en ont besoin). */
export async function openTestSchema(max = 8): Promise<TestSchema> {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  const schema = createTemporarySchemaName();
  const quoted = quoteTemporarySchema(schema);
  await opened.pool.query(`CREATE SCHEMA ${quoted}`);
  const make = (size: number): Pool => new Pool({ connectionString: opened.target.connectionString, max: size, options: `-c search_path=${schema}` });
  const pool = make(max);
  const extras: Pool[] = [];
  await runMigrations(pool);
  return {
    admin: opened.pool,
    pool,
    target: opened.target,
    schema,
    extraPool(size = 4) {
      const extra = make(size);
      extras.push(extra);
      return extra;
    },
    async close() {
      for (const extra of extras) await extra.end().catch(() => {});
      await pool.end().catch(() => {});
      await opened.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => {});
      await opened.pool.end().catch(() => {});
    },
  };
}

export interface Login { userId: string; cookie: string; phone: string }

let phoneSequence = 0;
let ipSequence = 0;

/** Un compte réel : connexion par code (session valide), numéro `+22507` + 8 chiffres. */
export async function login(pool: Pool): Promise<Login> {
  phoneSequence += 1;
  ipSequence += 1;
  const phone = `+22507${String(70_000_000 + phoneSequence * 37).padStart(8, "0")}`;
  let delivery: SendOtpInput | undefined;
  const requested = await requestOtp(phone, {
    pool, authSecret: SECRET, requestIp: `198.51.100.${(ipSequence % 250) + 1}`, sendOtp: async (input) => { delivery = input; },
  });
  assert.ok(delivery);
  const verified = await verifyOtp(requested.challengeId, delivery.code, { pool, authSecret: SECRET });
  return { userId: verified.userId, cookie: `noma_auth=${verified.sessionToken}`, phone };
}

export interface Call { cookie?: string | null; origin?: string | null; body?: unknown; rawBody?: string; query?: string; signal?: AbortSignal }

export function request(method: "GET" | "POST" | "DELETE" | "PUT", path: string, call: Call = {}): Request {
  const headers: Record<string, string> = {};
  if (call.cookie) headers.cookie = call.cookie;
  const origin = call.origin === undefined ? ORIGIN : call.origin;
  if (method !== "GET" && origin !== null) headers.origin = origin;
  const raw = call.rawBody ?? (call.body !== undefined ? JSON.stringify(call.body) : undefined);
  if (raw !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${path}${call.query ?? ""}`, { method, headers, ...(raw !== undefined ? { body: raw } : {}), ...(call.signal ? { signal: call.signal } : {}) });
}

export interface Reply { status: number; json: unknown; text: string; headers: Headers }

/** Lit une réponse JSON ordinaire : vérifie `no-store`, `nosniff` et le type. */
export async function reply(response: Response): Promise<Reply> {
  const text = await response.text();
  assert.equal(response.headers.get("cache-control"), "no-store", `Cache-Control sur ${response.status}`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `nosniff sur ${response.status}`);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  return { status: response.status, json: JSON.parse(text), text, headers: response.headers };
}

export interface Market {
  buyer: Login;
  seller: Login;
  offer: OfferRecord;
  demand: DemandRecord;
}

/** Un acheteur, un vendeur, une annonce publiée du vendeur et un besoin actif de l'acheteur dont l'annonce est une correspondance confirmée et fraîche. */
export async function makeMarket(pool: Pool, options: OfferOptions = {}): Promise<Market> {
  const buyer = await login(pool);
  const seller = await login(pool);
  const offer = await makeOffer(pool, seller.userId, options);
  const demand = await makeDemand(pool, buyer.userId);
  await makeMatch(pool, offer, demand);
  return { buyer, seller, offer, demand };
}

/** Une annonce de plus du même vendeur, correspondant au besoin de l'acheteur. */
export async function addMatchingOffer(pool: Pool, market: Market, options: OfferOptions = {}): Promise<OfferRecord> {
  const offer = await makeOffer(pool, market.seller.userId, options);
  await makeMatch(pool, offer, market.demand);
  return offer;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function count(pool: Pool, table: string, where = "TRUE"): Promise<number> {
  return (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;
}

/** Vide les données métier (les comptes et leurs sessions restent d'un essai à l'autre). */
export function resetSocial(pool: Pool): Promise<unknown> {
  return pool.query(
    "TRUNCATE notifications, messages, conversations, orders, favorites, offer_views, offer_contacts, boost_exposures, offer_boosts, matching_evaluations, matching_jobs, matching_outbox_events, demands, offers CASCADE",
  );
}
