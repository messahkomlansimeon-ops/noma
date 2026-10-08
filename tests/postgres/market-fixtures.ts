/**
 * Éléments partagés par les essais de l'historique des prix (lot H1) : relevés insérés directement (jeux CONNUS, jours choisis), acteurs distincts, produit de référence.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { makePerson, type Person } from "./metrics-fixtures";

export const MARKET_NOW = new Date(Date.UTC(2030, 5, 15, 12));
export const MARKET_TODAY = "2030-06-15";

export const PRODUCT_TEXT = { category: "Téléphones", brand: "Apple", model: "iPhone 12", variant: "128 Go", condition: "Occasion" } as const;

export interface ObservationInput {
  source?: "listing" | "sale";
  referenceId?: string;
  /** Jour UTC AAAA-MM-JJ ou nombre de jours AVANT `MARKET_TODAY`. */
  day: string | number;
  price: number;
  sellerId: string | null;
  buyerId?: string | null;
  category?: string;
  brand?: string;
  model?: string;
  variant?: string | null;
  condition?: string | null;
}

export function dayBefore(days: number, from: string = MARKET_TODAY): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Écrit UN relevé (les clés sont normalisées par la fonction de la base, comme les déclencheurs). */
export async function insertObservation(pool: Pool, input: ObservationInput): Promise<string> {
  const text = { ...PRODUCT_TEXT, ...Object.fromEntries(Object.entries(input).filter(([key]) => ["category", "brand", "model", "variant", "condition"].includes(key))) } as Record<string, string | null>;
  const referenceId = input.referenceId ?? randomUUID();
  const source = input.source ?? "listing";
  await pool.query(
    `INSERT INTO price_observations (source, reference_id, observed_on, category_key, brand_key, model_key, variant_key, condition_key, label, price_xof, seller_id, buyer_id)
     VALUES ($1, $2::uuid, $3::date, price_key_part($4), price_key_part($5), price_key_part($6), price_key_part($7), price_key_part($8), $9, $10, $11, $12)`,
    [
      source, referenceId, typeof input.day === "number" ? dayBefore(input.day) : input.day, text.category, text.brand, text.model, text.variant, text.condition,
      `${text.brand} ${text.model}`, input.price, input.sellerId, source === "sale" ? (input.buyerId ?? null) : null,
    ],
  );
  return referenceId;
}

export interface Actors { sellers: Person[]; buyers: Person[] }

/** `sellers` vendeurs et `buyers` acheteurs distincts (comptes réels, sans téléphone). */
export async function makeActors(pool: Pool, sellers: number, buyers: number): Promise<Actors> {
  const make = async (count: number): Promise<Person[]> => {
    const list: Person[] = [];
    for (let index = 0; index < count; index += 1) list.push(await makePerson(pool, { phone: false }));
    return list;
  };
  return { sellers: await make(sellers), buyers: await make(buyers) };
}

/** Vide les relevés et le journal du relevé quotidien. */
export function resetObservations(pool: Pool): Promise<unknown> {
  return pool.query("TRUNCATE price_observations, price_observation_runs");
}
