/**
 * Éléments partagés par les essais des mesures d'efficacité (lot M1) : acheteurs, vendeurs avec téléphone vérifié, annonces, besoins,
 * correspondances confirmées et fraîches (insérées comme le worker les aurait enregistrées), boosts et journaux écrits à des instants choisis.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createDemand, createOffer, createUser } from "../../lib/server/catalog";
import type { DemandRecord, JsonObject, OfferRecord } from "../../lib/server/catalog/types";
import { insertEvaluation } from "./boost-fixtures";

export { REACHABLE_LIST_SIZE, addReachableBuyer, insertEvaluation } from "./boost-fixtures";

export const PRODUCT = { category: "smartphones", brand: "Apple", model: "iPhone 13" } as const;

let phoneSequence = 0;

export interface Person { id: string; phone: string | null }

/** Un compte, avec un téléphone vérifié par défaut (`+22507` + 8 chiffres), sans téléphone si `phone: false`. */
export async function makePerson(pool: Pool, options: { phone?: boolean } = {}): Promise<Person> {
  const id = (await createUser({}, pool)).id;
  if (options.phone === false) return { id, phone: null };
  phoneSequence += 1;
  const phone = `+22507${String(phoneSequence).padStart(8, "0")}`;
  await pool.query("INSERT INTO phone_identities (phone_e164, user_id, verified_at) VALUES ($1, $2, clock_timestamp())", [phone, id]);
  return { id, phone };
}

export interface OfferOptions {
  status?: "published" | "paused" | "draft";
  availability?: "available" | "reserved" | "unavailable";
  price?: number;
  model?: string;
  attributes?: JsonObject | null;
  rawText?: string;
}

/**
 * Lot D1 : le catalogue refuse désormais une annonce dont un attribut ressemble à un numéro de téléphone. Les attributs demandés par un essai sont donc écrits APRÈS la
 * création, directement en base (des données plus anciennes que la règle) : les essais de l'affichage vérifient que le texte du vendeur n'est jamais servi brut, quoi
 * qu'il y ait en base.
 */
export async function makeOffer(pool: Pool, ownerId: string, options: OfferOptions = {}): Promise<OfferRecord> {
  const offer = await createFixtureOffer(pool, ownerId, { ...options, attributes: null });
  if (options.attributes === undefined || options.attributes === null) return offer;
  await pool.query("UPDATE offers SET attributes = $2::jsonb WHERE id = $1", [offer.id, JSON.stringify(options.attributes)]);
  return { ...offer, attributes: options.attributes };
}

function createFixtureOffer(pool: Pool, ownerId: string, options: OfferOptions = {}): Promise<OfferRecord> {
  return createOffer({
    ownerId,
    rawText: options.rawText ?? "RAW_SECRET_TEXT offre iPhone 13",
    category: PRODUCT.category,
    brand: PRODUCT.brand,
    model: options.model ?? PRODUCT.model,
    variant: "128 Go",
    condition: "good",
    location: "Cocody",
    attributes: options.attributes ?? null,
    price: { amount: options.price ?? 250_000, currency: "XOF" },
    status: options.status ?? "published",
    availabilityStatus: options.availability ?? "available",
    availabilityConfirmedAt: new Date(),
  }, pool);
}

/** Vieillit l'annonce : sa date de création recule (les statistiques ne reconnaissent aucun événement avant la création de l'annonce). */
export async function ageOffer(pool: Pool, offerId: string, days: number): Promise<void> {
  await pool.query("UPDATE offers SET created_at = clock_timestamp() - make_interval(days => $2::int) WHERE id = $1", [offerId, days]);
}

export function makeDemand(pool: Pool, ownerId: string, status: "active" | "satisfied" | "draft" = "active"): Promise<DemandRecord> {
  return createDemand({
    ownerId, rawText: "RAW_SECRET_TEXT demande iPhone 13", category: PRODUCT.category, brand: PRODUCT.brand, model: PRODUCT.model,
    condition: "good", location: "Cocody", budget: { amount: 300_000, currency: "XOF" }, status,
  }, pool);
}

/** Correspondance confirmée et fraîche (compatible, éligible, versions et moteur courants). */
export async function makeMatch(pool: Pool, offer: OfferRecord, demand: DemandRecord, score = 90): Promise<string> {
  return insertEvaluation(pool, { offer, demand, score });
}

/** Un acheteur, un besoin actif et la correspondance avec l'annonce. */
export async function makeBuyerMatch(pool: Pool, offer: OfferRecord, options: { score?: number } = {}): Promise<{ buyer: Person; demand: DemandRecord }> {
  const buyer = await makePerson(pool);
  const demand = await makeDemand(pool, buyer.id);
  await makeMatch(pool, offer, demand, options.score);
  return { buyer, demand };
}

export interface BoostOptions {
  status?: "active" | "expired" | "cancelled";
  /** Intervalles SQL par rapport à maintenant. */
  startsAgo?: string;
  endsIn?: string;
}

/** Un boost inséré directement (statut et fenêtre au choix) ; le périmètre est celui de l'annonce, normalisé. */
export async function makeBoost(pool: Pool, offer: OfferRecord, options: BoostOptions = {}): Promise<string> {
  const id = randomUUID();
  const status = options.status ?? "active";
  await pool.query(
    `INSERT INTO offer_boosts (id, offer_id, seller_id, scope_category, scope_brand, scope_model, status, duration_code, starts_at, ends_at, source, cancelled_at)
     VALUES ($1, $2, $3, lower(btrim($4)), lower(btrim($5)), lower(btrim($6)), $7, '24h', clock_timestamp() - $8::interval, clock_timestamp() + $9::interval, 'admin_grant',
             CASE WHEN $7 = 'cancelled' THEN clock_timestamp() END)`,
    [id, offer.id, offer.ownerId, offer.category, offer.brand, offer.model, status, options.startsAgo ?? "1 minute", options.endsIn ?? "1 day"],
  );
  return id;
}

export interface ExposureInput {
  boostId: string;
  offerId: string;
  demandId: string;
  viewerId: string;
  /** Intervalle SQL entre l'instant de la première apparition et maintenant (« 6 days »). La ligne est rangée au jour UTC de cet instant. */
  firstServedAgo?: string;
  /** Écart (en plus) entre la première et la dernière apparition, dans la même ligne (« 3 hours »). */
  lastAfterFirst?: string;
  servings?: number;
  sponsoredServings?: number;
  bestPosition?: number;
  bestGain?: number;
}

/** Une ligne du journal d'exposition, écrite directement à un instant choisi (la lecture des résultats l'écrit par `recordBoostExposures`). */
export async function insertExposure(pool: Pool, input: ExposureInput): Promise<void> {
  const servings = input.servings ?? 1;
  await pool.query(
    `INSERT INTO boost_exposures (boost_id, offer_id, demand_id, viewer_id, served_day, first_served_at, last_served_at, servings, sponsored_servings, best_position, best_gain)
     SELECT $1, $2, $3, $4, (t.first AT TIME ZONE 'UTC')::date, t.first, t.first + $5::interval, $6, $7, $8, $9
       FROM (SELECT clock_timestamp() - $10::interval AS first) t`,
    [
      input.boostId, input.offerId, input.demandId, input.viewerId, input.lastAfterFirst ?? "0 seconds", servings,
      Math.min(input.sponsoredServings ?? servings, servings), input.bestPosition ?? 0, input.bestGain ?? 2, input.firstServedAgo ?? "1 hour",
    ],
  );
}

export interface ViewInput {
  offerId: string;
  demandId: string;
  viewerId: string;
  boostId?: string | null;
  views?: number;
  boostedViews?: number;
  /** Jours avant aujourd'hui (UTC). */
  daysAgo?: number;
}

export async function insertView(pool: Pool, input: ViewInput): Promise<void> {
  const views = input.views ?? 1;
  const boosted = input.boostedViews ?? (input.boostId ? views : 0);
  await pool.query(
    `INSERT INTO offer_views (offer_id, demand_id, viewed_day, viewer_id, boost_id, views, boosted_views, first_at, last_at)
     SELECT $1, $2, ((clock_timestamp() AT TIME ZONE 'UTC')::date - $3::int), $4, $5, $6, $7,
            clock_timestamp() - make_interval(days => $3::int), clock_timestamp() - make_interval(days => $3::int)`,
    [input.offerId, input.demandId, input.daysAgo ?? 0, input.viewerId, input.boostId ?? null, views, boosted],
  );
}

export interface ContactInput {
  offerId: string;
  demandId: string;
  viewerId: string;
  boostId?: string | null;
  reveals?: number;
  /** Jours avant maintenant (premier contact ; le dernier est le même instant). */
  daysAgo?: number;
}

export async function insertContact(pool: Pool, input: ContactInput): Promise<void> {
  await pool.query(
    `INSERT INTO offer_contacts (offer_id, demand_id, viewer_id, boost_id, reveals, first_contact_at, last_contact_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp() - make_interval(days => $6::int), clock_timestamp() - make_interval(days => $6::int))`,
    [input.offerId, input.demandId, input.viewerId, input.boostId ?? null, input.reveals ?? 1, input.daysAgo ?? 0],
  );
}

export const TRUNCATE_METRICS_TABLES =
  "TRUNCATE offer_views, offer_contacts, boost_exposures, boost_quotes, offer_boosts, matching_evaluations, matching_jobs, matching_outbox_events, phone_identities, demands, offers, users CASCADE";
