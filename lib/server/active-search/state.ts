import "server-only";

import { CatalogNotFoundError } from "../catalog/errors";
import { requireUuid } from "../catalog/validation";
import type { SqlExecutor } from "../postgres/client";
import { productKeyString } from "../external/product-key";
import { TRACKING_MAX_DAYS } from "../notifications/config";
import { WALLET_MAX_SAFE_AMOUNT } from "../wallet/config";
import { INSTANT_TEXT_SQL } from "../subscriptions/time";
import { acceleratedCapacity, capacityAllows, externalCollectionAvailable, type Environment } from "./availability";
import { ELIGIBILITY_COLUMNS, demandIneligibility, eligibilityKeyOf, type DemandEligibilityInput, type DemandIneligibility } from "./eligibility";
import {
  ACTIVE_SEARCH_DURATION_DAYS,
  ACTIVE_SEARCH_MAX_HORIZON_DAYS,
  ACTIVE_SEARCH_NOTICE_DAYS,
  ACTIVE_SEARCH_PRICE_XOF,
  ACTIVE_SEARCH_TRACKING_MAX_DAYS,
} from "./config";

/**
 * État de la recherche active d'un besoin (lot RA1), en LECTURE. Une période compte (« en vigueur ») si son statut est `active`, qu'elle n'est pas remboursée, que son début est passé
 * et que sa fin ne l'est pas, ET que le besoin est ACTIF. Règle unique pour le besoin « satisfait » (lot RA1-bis) : il SUSPEND l'option (aucune notification, aucune accélération, la période
 * continue de courir et la réactivation du besoin la reprend : le résultat ne dépend jamais du passage du worker) ; seul l'ARCHIVAGE l'arrête, sans remboursement. Les extensions sont
 * CONTIGUËS : la « chaîne » en vigueur va du début de la période courante à la fin de la dernière période qui s'enchaîne.
 */

const DAY_MS = 86_400_000;

export interface PeriodRow {
  id: string;
  number: number;
  startsAt: Date;
  endsAt: Date;
  /** Mêmes instants en texte ISO UTC à la microseconde : une extension commence EXACTEMENT là où la chaîne se termine. */
  startsAtText: string;
  endsAtText: string;
}

export interface Coverage {
  /** Période qui couvre l'instant `now` ; null si aucune. */
  current: PeriodRow | null;
  /** Fin de la chaîne contiguë qui commence à la période courante ; null si aucune période ne couvre `now`. */
  chainEnd: PeriodRow | null;
}

/** Fonction PURE : la période courante et la fin de la chaîne contiguë, parmi des périodes en vigueur (non arrêtées, non remboursées). */
export function computeCoverage(periods: readonly PeriodRow[], now: Date): Coverage {
  const sorted = [...periods].sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime() || left.number - right.number);
  const current = sorted.find((period) => period.startsAt.getTime() <= now.getTime() && period.endsAt.getTime() > now.getTime()) ?? null;
  if (current === null) return { current: null, chainEnd: null };
  let end = current;
  for (let guard = 0; guard < 64; guard++) {
    const next = sorted.find((period) => period.number !== end.number && period.startsAt.getTime() === end.endsAt.getTime());
    if (!next) break;
    end = next;
  }
  return { current, chainEnd: end };
}

export type ExtendBlockedReason = Exclude<DemandIneligibility, "mission_carrier"> | "capacity" | "max_horizon";

export interface ActiveSearchState {
  demandId: string;
  demandStatus: string;
  /** Option en vigueur MAINTENANT (besoin actif, période courante). */
  active: boolean;
  /**
   * Option SUSPENDUE : le besoin est « satisfait » alors qu'une période court encore. Rien n'est notifié ni accéléré, la période continue de courir (sans prolongation ni remboursement) et
   * la réactivation du besoin la reprend telle quelle, que le worker soit passé ou non. Seul l'archivage arrête l'option.
   */
  suspended: boolean;
  startsAt: Date | null;
  /** Fin de la chaîne en vigueur (la dernière période payée qui s'enchaîne). */
  endsAt: Date | null;
  remainingDays: number | null;
  /** Nombre de périodes payées pour ce besoin (toutes, remboursées ou non). */
  purchasedPeriods: number;
  /** Fin qu'aurait l'option après un achat maintenant ; null si un achat est impossible. */
  nextEndsAt: Date | null;
  canPurchase: boolean;
  blockedReason: ExtendBlockedReason | null;
  /** Fin maximale (maintenant + 180 jours). */
  maxEndsAt: Date;
  /** L'avis d'échéance est dû (moins de 3 jours avant la fin de la chaîne). */
  expiringSoon: boolean;
  priceXof: number;
  durationDays: number;
  /** Solde en crédits PAYÉS de l'acheteur (les crédits promotionnels ne paient jamais cette option). */
  balanceXof: number;
  readAt: Date;
}

/** Les tables de la migration 0028 existent-elles ? Une base pas encore migrée n'est jamais une erreur : rien n'est en vigueur. */
export async function activeSearchSchemaPresent(executor: SqlExecutor): Promise<boolean> {
  const result = await executor.query<{ present: boolean }>(
    "SELECT (to_regclass('active_search_purchases') IS NOT NULL AND to_regclass('active_search_state') IS NOT NULL AND to_regclass('active_search_seen') IS NOT NULL) AS present",
  );
  return result.rows[0]?.present === true;
}

interface PeriodQueryRow {
  id: string;
  number: number;
  starts_at: Date;
  ends_at: Date;
  starts_at_text: string;
  ends_at_text: string;
}

export function toPeriod(row: PeriodQueryRow): PeriodRow {
  return { id: row.id, number: row.number, startsAt: row.starts_at, endsAt: row.ends_at, startsAtText: row.starts_at_text, endsAtText: row.ends_at_text };
}

export const PERIOD_COLUMNS = `p.id, p.number, p.starts_at, p.ends_at, ${INSTANT_TEXT_SQL("p.starts_at")} AS starts_at_text, ${INSTANT_TEXT_SQL("p.ends_at")} AS ends_at_text`;

/** Périodes EN VIGUEUR d'un besoin (statut actif, non remboursées), pour calculer la couverture. */
export async function readLivePeriods(executor: SqlExecutor, demandId: string, options: { lock?: boolean } = {}): Promise<PeriodRow[]> {
  const result = await executor.query<PeriodQueryRow>(
    `SELECT ${PERIOD_COLUMNS} FROM active_search_purchases p
      WHERE p.demand_id = $1::uuid AND p.status = 'active' AND p.refunded_at IS NULL
      ORDER BY p.starts_at, p.number${options.lock ? " FOR UPDATE" : ""}`,
    [demandId],
  );
  return result.rows.map(toPeriod);
}

function jsonInteger(value: string | number | bigint): number {
  const amount = BigInt(value);
  if (amount > WALLET_MAX_SAFE_AMOUNT || amount < -WALLET_MAX_SAFE_AMOUNT) throw new RangeError("montant hors des entiers sûrs");
  return Number(amount);
}

/**
 * État de la recherche active d'un besoin DU propriétaire (un besoin d'autrui ou inconnu : la même erreur « introuvable »). Lecture seule ; n'écrit rien. `env` : l'environnement qui dit
 * si la collecte externe peut fournir des annonces (défaut : `process.env`). Raison d'un achat impossible (`blockedReason`), dans l'ordre : éligibilité du besoin (`demand_not_active`,
 * `no_product_key`, `unavailable`, une seule fonction pour l'achat et l'écran ; le besoin porteur d'une mission est « introuvable » comme celui d'autrui), capacité de collecte accélérée (`capacity`), horizon de 180 jours (`max_horizon`).
 */
export async function readActiveSearchState(input: { executor: SqlExecutor; ownerId: string; demandId: string; now?: Date; env?: Environment }): Promise<ActiveSearchState> {
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  const now = input.now ?? new Date();
  const demand = await input.executor.query<DemandEligibilityInput>(
    `SELECT ${ELIGIBILITY_COLUMNS} FROM demands d WHERE d.id = $1::uuid AND d.owner_id = $2::uuid`,
    [demandId, ownerId],
  );
  const row = demand.rows[0];
  if (!row) throw new CatalogNotFoundError("demande");
  const present = await activeSearchSchemaPresent(input.executor);
  const available = present ? await externalCollectionAvailable(input.executor, input.env ?? process.env) : false;
  // La MÊME fonction que l'achat décide si le besoin peut recevoir l'option (eligibility.ts).
  const ineligible = demandIneligibility(row, { collectionAvailable: available });
  // Le besoin PORTEUR d'une mission n'est pas un besoin de l'acheteur : MÊME réponse qu'un besoin d'autrui (404), jamais un motif (lot MV1).
  if (ineligible === "mission_carrier") throw new CatalogNotFoundError("demande");
  const demandActive = row.status === "active" && !row.archived;
  const demandSuspended = row.status === "satisfied" && !row.archived;
  const periods = present && (demandActive || demandSuspended) ? await readLivePeriods(input.executor, demandId) : [];
  const total = present
    ? (await input.executor.query<{ n: number }>("SELECT count(*)::int AS n FROM active_search_purchases WHERE demand_id = $1::uuid", [demandId])).rows[0].n
    : 0;
  const balance = await input.executor.query<{ balance: string }>("SELECT balance::text AS balance FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1::uuid", [ownerId]);
  const coverage = computeCoverage(periods, now);
  const maxEndsAt = new Date(now.getTime() + ACTIVE_SEARCH_MAX_HORIZON_DAYS * DAY_MS);
  const base = coverage.chainEnd === null ? now : coverage.chainEnd.endsAt;
  const nextEndsAt = new Date(base.getTime() + ACTIVE_SEARCH_DURATION_DAYS * DAY_MS);
  let blockedReason: ExtendBlockedReason | null = null;
  // Sans la migration 0028, la collecte n'est jamais « disponible » : `unavailable` (jamais une erreur).
  if (ineligible !== null) blockedReason = ineligible;
  else {
    const key = eligibilityKeyOf(row);
    const capacity = await acceleratedCapacity(input.executor, input.env ?? process.env, now);
    if (key !== null && !capacityAllows(capacity, productKeyString(key))) blockedReason = "capacity";
    else if (nextEndsAt.getTime() > maxEndsAt.getTime()) blockedReason = "max_horizon";
  }
  const chainEnd = coverage.chainEnd;
  return {
    demandId,
    demandStatus: row.status,
    active: demandActive && coverage.current !== null,
    suspended: demandSuspended && coverage.current !== null,
    startsAt: coverage.current === null ? null : coverage.current.startsAt,
    endsAt: chainEnd === null ? null : chainEnd.endsAt,
    remainingDays: chainEnd === null ? null : Math.max(0, Math.ceil((chainEnd.endsAt.getTime() - now.getTime()) / DAY_MS)),
    purchasedPeriods: total,
    nextEndsAt: blockedReason === null ? nextEndsAt : null,
    canPurchase: blockedReason === null,
    blockedReason,
    maxEndsAt,
    expiringSoon: demandActive && chainEnd !== null && chainEnd.endsAt.getTime() - now.getTime() <= ACTIVE_SEARCH_NOTICE_DAYS * DAY_MS,
    priceXof: ACTIVE_SEARCH_PRICE_XOF,
    durationDays: ACTIVE_SEARCH_DURATION_DAYS,
    balanceXof: balance.rows[0] ? jsonInteger(balance.rows[0].balance) : 0,
    readAt: now,
  };
}

/** Plafond du suivi (jours) d'un besoin : 180 PENDANT que la recherche active est en vigueur, 90 sinon. */
export async function trackingMaxDaysFor(executor: SqlExecutor, demandId: string, now: Date): Promise<number> {
  if (!(await activeSearchSchemaPresent(executor))) return TRACKING_MAX_DAYS;
  const live = await executor.query(
    `SELECT 1 FROM active_search_purchases p JOIN demands d ON d.id = p.demand_id
      WHERE p.demand_id = $1::uuid AND p.status = 'active' AND p.refunded_at IS NULL AND p.starts_at <= $2::timestamptz AND p.ends_at > $2::timestamptz
        AND d.status = 'active' AND d.archived_at IS NULL
      LIMIT 1`,
    [demandId, now],
  );
  return live.rowCount ? ACTIVE_SEARCH_TRACKING_MAX_DAYS : TRACKING_MAX_DAYS;
}
