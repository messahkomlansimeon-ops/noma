/**
 * Éléments partagés par les essais des missions d'achat en volume (lot MV1) : schéma jetable migré, gestionnaires HTTP des missions et du social, mission lancée avec son besoin
 * porteur, annonces correspondantes insérées comme le worker les aurait enregistrées (évaluations confirmées et fraîches), quantité d'une annonce, passage du temps.
 */

import assert from "node:assert/strict";
import type { Pool } from "pg";
import { getDemandById, type DemandRecord, type OfferRecord } from "../../lib/server/catalog";
import { createMissionsHttpHandlers, type MissionsHttpHandlers } from "../../lib/server/missions/http";
import { createSocialHttpHandlers, type SocialHttpHandlers } from "../../lib/server/social/http";
import { insertEvaluation } from "./boost-fixtures";
import { makeOffer, makePerson, type OfferOptions, type Person } from "./metrics-fixtures";
import { login, openTestSchema, reply, request, resetSocial, type Login, type Reply, type TestSchema } from "./social-fixtures";

export { login, reply, request, openTestSchema, resetSocial };
export type { Login, Reply, TestSchema };

export const ENV = { NOMA_AUTH_ORIGIN: "https://noma.test" };

/** Budgets DISTINCTIFS : leurs chiffres ne figurent dans aucune réponse lisible par un vendeur (essais de confidentialité). */
export const UNIT_BUDGET = 173_456;
export const TOTAL_BUDGET = 1_234_567;

export function missionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "smartphones",
    brand: "Apple",
    model: "iPhone 13",
    variant: "128 Go",
    condition: "good",
    quantity: 6,
    unit: "pièce",
    unitBudgetXof: UNIT_BUDGET,
    totalBudgetXof: TOTAL_BUDGET,
    location: "Cocody",
    deadlineDays: 30,
    ...overrides,
  };
}

export interface Handlers {
  missions: MissionsHttpHandlers;
  social: SocialHttpHandlers;
}

export function makeHandlers(pool: Pool): Handlers {
  return {
    missions: createMissionsHttpHandlers({ pool, env: ENV, log: () => {} }),
    social: createSocialHttpHandlers({ pool, env: ENV, log: () => {} }),
  };
}

type Json = Record<string, unknown>;
export const missionOf = (answer: Reply): Json => (answer.json as { mission: Json }).mission;
export const proposalOf = (answer: Reply): Json => (answer.json as { proposal: Json }).proposal;
export const orderOf = (answer: Reply): Json => (answer.json as { order: Json }).order;
export const errorCode = (answer: Reply): string => (answer.json as { error: { code: string } }).error.code;

export const createMissionCall = async (h: Handlers, cookie: string | null, body: unknown = missionBody(), origin?: string | null): Promise<Reply> =>
  reply(await h.missions.create(request("POST", "/api/missions", { cookie, body, origin })));
export const listMissionsCall = async (h: Handlers, cookie: string | null): Promise<Reply> => reply(await h.missions.list(request("GET", "/api/missions", { cookie })));
export const readMissionCall = async (h: Handlers, cookie: string | null, id: string): Promise<Reply> => reply(await h.missions.read(request("GET", `/api/missions/${id}`, { cookie }), id));
export const updateMissionCall = async (h: Handlers, cookie: string | null, id: string, body: unknown, origin?: string | null): Promise<Reply> =>
  reply(await h.missions.update(request("PUT", `/api/missions/${id}`, { cookie, body, origin }), id));
export const actMissionCall = async (h: Handlers, cookie: string | null, id: string, action: unknown, origin?: string | null): Promise<Reply> =>
  reply(await h.missions.act(request("POST", `/api/missions/${id}`, { cookie, body: { action }, origin }), id));
export const proposalCall = async (h: Handlers, cookie: string | null, id: string): Promise<Reply> => reply(await h.missions.proposal(request("GET", `/api/missions/${id}/proposal`, { cookie }), id));

export interface LiveMission {
  id: string;
  demandId: string;
  carrier: DemandRecord;
}

/** Une mission créée ET lancée (201), son besoin porteur relu. */
export async function startMission(pool: Pool, h: Handlers, buyer: Login, overrides: Record<string, unknown> = {}): Promise<LiveMission> {
  const answer = await createMissionCall(h, buyer.cookie, { ...missionBody(overrides), activate: true });
  assert.equal(answer.status, 201, answer.text);
  const mission = missionOf(answer);
  assert.equal(mission.status, "active");
  const carrier = await getDemandById(buyer.userId, mission.demandId as string, pool);
  assert.ok(carrier);
  return { id: mission.id as string, demandId: carrier.id, carrier };
}

export interface Candidate {
  offer: OfferRecord;
  seller: Person;
}

/** Une annonce d'un vendeur (nouveau par défaut), avec sa quantité annoncée, correspondance confirmée et fraîche du besoin porteur. */
export async function addCandidate(
  pool: Pool,
  live: LiveMission,
  options: { price?: number | null; quantity?: number | null; score?: number; seller?: Person; offer?: OfferOptions } = {},
): Promise<Candidate> {
  const seller = options.seller ?? (await makePerson(pool));
  const offer = await makeOffer(pool, seller.id, { price: options.price === null ? undefined : options.price ?? 150_000, ...options.offer });
  if (options.price === null) await pool.query("UPDATE offers SET price_amount = NULL, price_currency = NULL WHERE id = $1", [offer.id]);
  if (options.quantity !== undefined && options.quantity !== null) await pool.query("UPDATE offers SET quantity = $2 WHERE id = $1", [offer.id, options.quantity]);
  await insertEvaluation(pool, { offer, demand: live.carrier, score: options.score ?? 90 });
  return { offer, seller };
}

export const count = async (pool: Pool, table: string, where = "TRUE"): Promise<number> =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;

/** Le temps passe : les gardes de la mission (contenu figé après le brouillon) sont suspendues le temps de la modification, dans le schéma d'essai seulement. */
export async function withoutMissionGuard<T>(pool: Pool, work: () => Promise<T>): Promise<T> {
  await pool.query("ALTER TABLE missions DISABLE TRIGGER trg_missions_transition");
  try {
    return await work();
  } finally {
    await pool.query("ALTER TABLE missions ENABLE TRIGGER trg_missions_transition");
  }
}

/** Fait échoir la mission : son échéance recule d'une heure. */
export async function makeDue(pool: Pool, missionId: string): Promise<void> {
  await withoutMissionGuard(pool, () => pool.query("UPDATE missions SET deadline_at = clock_timestamp() - interval '1 hour' WHERE id = $1", [missionId]));
}

/** Fait croire que la dernière notification de la mission date d'hier (un nouveau jour UTC commence). */
export async function ageCoverageNotifications(pool: Pool, missionId: string): Promise<void> {
  await pool.query("UPDATE notifications SET digest_day = digest_day - 1, created_at = created_at - interval '1 day' WHERE mission_id = $1", [missionId]);
}

/** Termine le matching du besoin porteur (les essais insèrent les évaluations à la main : aucun événement ni job n'est en attente). */
export async function settle(pool: Pool, demandId: string): Promise<void> {
  await pool.query("DELETE FROM matching_jobs WHERE resource_id = $1", [demandId]);
  await pool.query("UPDATE matching_outbox_events SET dispatch_status = 'projected', dispatched_at = clock_timestamp() WHERE aggregate_id = $1 AND dispatch_status = 'pending'", [demandId]);
}

/** Fait croire que la mission a pris fin il y a `hours` heures (délai de libération du besoin porteur : 24 h) ; les gardes sont suspendues le temps de la modification. */
export async function ageClosedMission(pool: Pool, missionId: string, hours: number): Promise<void> {
  await withoutMissionGuard(pool, () =>
    pool.query("UPDATE missions SET closed_at = clock_timestamp() - make_interval(hours => $2::int) WHERE id = $1", [missionId, hours]),
  );
}

/** L'état du besoin porteur (« active » ou « archived »), lu en base. */
export async function carrierStatus(pool: Pool, demandId: string): Promise<string> {
  return (await pool.query<{ status: string }>("SELECT status FROM demands WHERE id = $1", [demandId])).rows[0].status;
}
