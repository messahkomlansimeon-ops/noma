import "server-only";

import type { PoolClient } from "pg";
import type { SqlExecutor } from "../postgres/client";
import { requireUuid } from "../catalog/validation";

/**
 * Crédits promotionnels (lot PRO1) : lecture, réservation (verrou) et répartition d'un achat de boost. Voir OFFRE-PRO.md.
 *
 * Une ÉMISSION (`promo_grants`) naît avec une période d'abonnement payée et expire à la fin de cette période. Son reste = montant + restitutions − dépenses − expiré
 * (`promo_grant_remaining`). Un achat de boost dépense les crédits promotionnels EN PREMIER (émission qui expire la première), les crédits payés complètent.
 * Seules les émissions NON expirées à l'instant de la BASE sont dépensables : le solde du sous-compte promotionnel du grand livre peut contenir, un instant, des crédits échus
 * que l'étape « subscriptions » n'a pas encore écrits comme expirés ; ils ne se dépensent jamais.
 */

export interface SpendablePromoGrant {
  id: string;
  expiresAt: Date;
  /** Reste dépensable (XOF, > 0). */
  remaining: bigint;
}

export interface PromoAllocation {
  grantId: string;
  amount: bigint;
}

export interface BoostPriceSplit {
  /** Part payée en crédits payés. */
  paid: bigint;
  /** Part payée en crédits promotionnels. */
  promo: bigint;
  /** Répartition de la part promotionnelle entre les émissions (celle qui expire la première d'abord). */
  allocations: PromoAllocation[];
}

const ZERO = BigInt(0);

/**
 * Répartition PURE d'un prix : les crédits promotionnels d'abord, dans l'ordre donné (émission qui expire la première), jusqu'à concurrence du prix ; les crédits payés pour le
 * reste. `promo + paid = price`, jamais de part négative, jamais plus que le reste d'une émission.
 */
export function splitBoostPrice(price: bigint, grants: readonly SpendablePromoGrant[]): BoostPriceSplit {
  if (typeof price !== "bigint" || price <= ZERO) throw new RangeError("price doit être un bigint strictement positif.");
  let left = price;
  const allocations: PromoAllocation[] = [];
  for (const grant of grants) {
    if (left === ZERO) break;
    if (grant.remaining <= ZERO) continue;
    const take = grant.remaining < left ? grant.remaining : left;
    allocations.push({ grantId: grant.id, amount: take });
    left -= take;
  }
  const promo = price - left;
  return { paid: left, promo, allocations };
}

/**
 * Verrouille (FOR UPDATE) les émissions DÉPENSABLES de l'utilisateur puis relit leur reste dans une NOUVELLE instruction (un reste calculé avant l'attente du verrou serait périmé
 * si un achat concurrent vient de dépenser). Ordre des verrous : après les lignes de boost, AVANT les comptes du grand livre (voir purchase.ts).
 */
export async function lockSpendablePromoGrants(client: PoolClient, userId: string): Promise<SpendablePromoGrant[]> {
  const user = requireUuid(userId, "userId").toLowerCase();
  const locked = await client.query<{ id: string }>(
    `SELECT g.id FROM promo_grants g
      WHERE g.user_id = $1::uuid AND g.expired_at IS NULL AND g.expires_at > clock_timestamp()
      ORDER BY g.expires_at, g.id
      FOR UPDATE OF g`,
    [user],
  );
  if (locked.rows.length === 0) return [];
  const rows = await client.query<{ id: string; expires_at: Date; remaining: string }>(
    `SELECT g.id, g.expires_at, promo_grant_remaining(g.id)::text AS remaining
       FROM promo_grants g
      WHERE g.id = ANY($1::uuid[]) AND g.expired_at IS NULL AND g.expires_at > clock_timestamp()
      ORDER BY g.expires_at, g.id`,
    [locked.rows.map((row) => row.id)],
  );
  return rows.rows
    .map((row) => ({ id: row.id, expiresAt: row.expires_at, remaining: BigInt(row.remaining) }))
    .filter((grant) => grant.remaining > ZERO);
}

/** Inscrit les dépenses d'un achat (un mouvement `spend` par émission), APRÈS la ligne `boost_purchases` (clé étrangère). */
export async function recordPromoSpends(
  client: PoolClient,
  input: { purchaseId: string; transactionId: string; allocations: readonly PromoAllocation[] },
): Promise<void> {
  for (const allocation of input.allocations) {
    await client.query(
      `INSERT INTO promo_movements (id, grant_id, kind, amount_xof, purchase_id, transaction_id)
       VALUES (gen_random_uuid(), $1::uuid, 'spend', $2::bigint, $3::uuid, $4::uuid)`,
      [allocation.grantId, allocation.amount.toString(), input.purchaseId, input.transactionId],
    );
  }
}

export interface PromoSummary {
  /** Crédits promotionnels dépensables maintenant (somme des restes des émissions non expirées). */
  balance: bigint;
  /** Échéance la plus proche parmi les émissions qui ont un reste ; null s'il n'y en a pas. */
  expiresAt: Date | null;
}

/** Solde promotionnel dépensable de l'utilisateur et sa prochaine échéance. */
export async function readPromoSummary(executor: SqlExecutor, userId: string): Promise<PromoSummary> {
  const user = requireUuid(userId, "userId").toLowerCase();
  const result = await executor.query<{ balance: string; expires_at: Date | null }>(
    `SELECT COALESCE(sum(r.remaining), 0)::text AS balance, min(r.expires_at) FILTER (WHERE r.remaining > 0) AS expires_at
       FROM (SELECT g.expires_at, promo_grant_remaining(g.id) AS remaining
               FROM promo_grants g
              WHERE g.user_id = $1::uuid AND g.expired_at IS NULL AND g.expires_at > clock_timestamp()) r
      WHERE r.remaining > 0`,
    [user],
  );
  return { balance: BigInt(result.rows[0].balance), expiresAt: result.rows[0].expires_at };
}
