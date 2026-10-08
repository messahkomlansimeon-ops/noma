import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { CatalogValidationError } from "../catalog/errors";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction, type SqlExecutor } from "../postgres/client";
import { WALLET_MAX_SAFE_AMOUNT } from "../wallet/config";
import { ENTITLEMENTS, PLAN_FREE_CODE, SUBSCRIPTION_LOCK_TIMEOUT_MS, type Entitlement } from "./config";
import { SubscriptionError } from "./errors";

/**
 * Plans et versions (lot PRO1). Une version publiée est IMMUABLE (déclencheur de la migration 0021) ; l'administration ajoute une version, qui s'applique aux NOUVELLES souscriptions
 * SEULEMENT : les abonnés actuels gardent leur version, donc leur prix, à chaque renouvellement (migrer les abonnés existants sera un lot futur, avec avis préalable et acceptation).
 * PRIX PROVISOIRES : les deux plans de départ attendent une décision du fondateur. Voir OFFRE-PRO.md.
 */

export interface PlanVersionView {
  planCode: string;
  versionId: string;
  version: number;
  name: string;
  /** XOF entiers. */
  monthlyPriceXof: bigint;
  promoCreditsXof: bigint;
  maxOnlineOffers: number;
  entitlements: Entitlement[];
  createdAt: Date;
}

interface PlanVersionRow {
  code: string;
  id: string;
  version: number;
  name: string;
  monthly_price_xof: string;
  promo_credits_xof: string;
  max_online_offers: number;
  entitlements: string[];
  created_at: Date;
}

const PLAN_VERSION_COLUMNS = `p.code, v.id, v.version, v.name, v.monthly_price_xof::text AS monthly_price_xof, v.promo_credits_xof::text AS promo_credits_xof,
  v.max_online_offers, v.entitlements, v.created_at`;

function mapPlanVersion(row: PlanVersionRow): PlanVersionView {
  return {
    planCode: row.code,
    versionId: row.id,
    version: row.version,
    name: row.name,
    monthlyPriceXof: BigInt(row.monthly_price_xof),
    promoCreditsXof: BigInt(row.promo_credits_xof),
    maxOnlineOffers: row.max_online_offers,
    entitlements: row.entitlements.filter((value): value is Entitlement => (ENTITLEMENTS as readonly string[]).includes(value)),
    createdAt: row.created_at,
  };
}

/** La version COURANTE (la plus récente) de chaque plan : le gratuit d'abord, puis les plans payants par prix croissant. */
export async function readCurrentPlanVersions(executor: SqlExecutor): Promise<PlanVersionView[]> {
  const result = await executor.query<PlanVersionRow>(
    `SELECT ${PLAN_VERSION_COLUMNS}
       FROM plan_versions v JOIN plans p ON p.id = v.plan_id
      WHERE v.version = (SELECT max(w.version) FROM plan_versions w WHERE w.plan_id = v.plan_id)
      ORDER BY (p.code = $1) DESC, v.monthly_price_xof, p.code`,
    [PLAN_FREE_CODE],
  );
  return result.rows.map(mapPlanVersion);
}

/** Toutes les versions de tous les plans (administration, lecture seule) : par plan, de la plus récente à la plus ancienne. */
export async function readAllPlanVersions(executor: SqlExecutor): Promise<PlanVersionView[]> {
  const result = await executor.query<PlanVersionRow>(
    `SELECT ${PLAN_VERSION_COLUMNS}
       FROM plan_versions v JOIN plans p ON p.id = v.plan_id
      ORDER BY (p.code = $1) DESC, p.code, v.version DESC`,
    [PLAN_FREE_CODE],
  );
  return result.rows.map(mapPlanVersion);
}

export interface NewPlanVersionInput {
  planCode: string;
  name: string;
  monthlyPriceXof: number;
  promoCreditsXof: number;
  maxOnlineOffers: number;
  entitlements: readonly string[];
  /** Administrateur qui crée la version (historique). */
  createdBy: string;
}

const PLAN_CODE = /^[a-z][a-z0-9_]{1,29}$/;
const CONTROL_OR_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function requireAmount(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || BigInt(value) > WALLET_MAX_SAFE_AMOUNT || value > 1_000_000_000) {
    throw new CatalogValidationError(`${field} doit être un entier compris entre ${min} et 1 000 000 000.`);
  }
  return value;
}

/** Validation d'une nouvelle version AVANT tout SQL (mêmes bornes que les CHECK de la migration, plus les règles propres au plan Gratuit). */
export function validateNewPlanVersion(input: NewPlanVersionInput): Required<Omit<NewPlanVersionInput, "createdBy">> & { createdBy: string } {
  if (typeof input.planCode !== "string" || !PLAN_CODE.test(input.planCode)) throw new CatalogValidationError("planCode invalide.");
  if (typeof input.name !== "string") throw new CatalogValidationError("name doit être un texte.");
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60 || CONTROL_OR_INVISIBLE.test(name)) throw new CatalogValidationError("name doit compter de 1 à 60 caractères visibles.");
  const price = requireAmount(input.monthlyPriceXof, "monthlyPriceXof", 0);
  const promo = requireAmount(input.promoCreditsXof, "promoCreditsXof", 0);
  if (typeof input.maxOnlineOffers !== "number" || !Number.isSafeInteger(input.maxOnlineOffers) || input.maxOnlineOffers < 1 || input.maxOnlineOffers > 100_000) {
    throw new CatalogValidationError("maxOnlineOffers doit être un entier compris entre 1 et 100 000.");
  }
  if (!Array.isArray(input.entitlements)) throw new CatalogValidationError("entitlements doit être une liste.");
  const entitlements = [...input.entitlements];
  if (entitlements.some((value) => typeof value !== "string" || !(ENTITLEMENTS as readonly string[]).includes(value)) || new Set(entitlements).size !== entitlements.length) {
    throw new CatalogValidationError(`entitlements : seuls ${ENTITLEMENTS.join(", ")} sont permis, sans doublon.`);
  }
  // Le plan Gratuit ne coûte rien, ne donne ni crédits ni droit ; un plan payant coûte quelque chose (sinon il ne se souscrirait pas).
  if (input.planCode === PLAN_FREE_CODE) {
    if (price !== 0 || promo !== 0 || entitlements.length > 0) throw new CatalogValidationError("Le plan Gratuit n'a ni prix, ni crédits promotionnels, ni droit.");
  } else if (price <= 0) {
    throw new CatalogValidationError("Un plan payant a un prix mensuel strictement positif.");
  }
  return {
    planCode: input.planCode, name, monthlyPriceXof: price, promoCreditsXof: promo, maxOnlineOffers: input.maxOnlineOffers,
    entitlements, createdBy: requireUuid(input.createdBy, "createdBy").toLowerCase(),
  };
}

/**
 * Ajoute une version à un plan (administration). Une seule transaction : verrou de la ligne du plan, numéro = dernière version + 1 (la base refuse un trou ou un doublon), insertion.
 * La version publiée n'est jamais modifiée ensuite. Elle ne s'applique qu'aux NOUVELLES souscriptions : les abonnés actuels gardent leur version et leur prix, renouvellements compris.
 */
export async function createPlanVersion(input: NewPlanVersionInput & { pool: Pool }): Promise<PlanVersionView> {
  const pool = requireTransactionPool(input.pool);
  const valid = validateNewPlanVersion(input);
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${SUBSCRIPTION_LOCK_TIMEOUT_MS}ms'`);
    const plan = await client.query<{ id: string }>("SELECT id FROM plans WHERE code = $1 FOR UPDATE", [valid.planCode]);
    if (!plan.rows[0]) throw new SubscriptionError("plan_not_found");
    const last = await client.query<{ n: number }>("SELECT COALESCE(max(version), 0)::int AS n FROM plan_versions WHERE plan_id = $1::uuid", [plan.rows[0].id]);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO plan_versions (id, plan_id, version, name, monthly_price_xof, promo_credits_xof, max_online_offers, entitlements, created_by)
       VALUES ($1::uuid, $2::uuid, $3::int, $4, $5::bigint, $6::bigint, $7::int, $8::text[], $9::uuid)
       RETURNING id`,
      [randomUUID(), plan.rows[0].id, last.rows[0].n + 1, valid.name, valid.monthlyPriceXof, valid.promoCreditsXof, valid.maxOnlineOffers, valid.entitlements, valid.createdBy],
    );
    const row = await client.query<PlanVersionRow>(
      `SELECT ${PLAN_VERSION_COLUMNS} FROM plan_versions v JOIN plans p ON p.id = v.plan_id WHERE v.id = $1::uuid`,
      [inserted.rows[0].id],
    );
    return mapPlanVersion(row.rows[0]);
  }, pool);
}
