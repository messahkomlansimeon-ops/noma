/**
 * Budget IA prévisionnel (Lot 4) — réservation de 0,05 $ par recherche IA
 * (prévisionnel, JAMAIS présenté comme un plafond fournisseur garanti),
 * réconciliation au coût connu, réserve conservée si la facturation est
 * incertaine ou si le processus est interrompu. Montants en microdollars.
 */
import { dayKey, withTransaction, type GuardDatabase } from "./db";

/** Dépense connue du jour (ledger), microdollars. */
export function spentMicros(db: GuardDatabase, day: string): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount_micros), 0) AS total FROM ledger WHERE day = ?")
    .get(day) as { total: number | bigint };
  return Number(row.total);
}

/** Réserves NON résolues — TOUTES, quel que soit leur jour : elles comptent
 *  contre le solde courant jusqu'à réconciliation, y compris après un
 *  changement de jour ou un redémarrage. */
export function reservedMicros(db: GuardDatabase): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(amount_micros), 0) AS total FROM reservations WHERE resolved_at IS NULL",
    )
    .get() as { total: number | bigint };
  return Number(row.total);
}

/** Solde prévisionnel restant pour le jour donné. */
export function availableMicros(
  db: GuardDatabase,
  dailyBudgetMicros: number,
  day: string,
): number {
  return Math.max(0, dailyBudgetMicros - spentMicros(db, day) - reservedMicros(db));
}

export type ReserveOutcome =
  | { reserved: true; amountMicros: number }
  /** Solde insuffisant → recherche SANS IA (le secours web reste possible). */
  | { reserved: false; availableMicros: number };

/** Réserve ATOMIQUE d'un montant avant une recherche IA. Refuse (sans
 *  réserve) si le solde prévisionnel du jour ne couvre pas le montant. */
export function reserveForSearch(
  db: GuardDatabase,
  searchId: string,
  amountMicros: number,
  dailyBudgetMicros: number,
  now: Date,
  timezone = "Africa/Abidjan",
): ReserveOutcome {
  const day = dayKey(now, timezone);
  return withTransaction(db, (): ReserveOutcome => {
    const available = availableMicros(db, dailyBudgetMicros, day);
    if (available < amountMicros) return { reserved: false, availableMicros: available };
    db.prepare(
      "INSERT INTO reservations (search_id, amount_micros, day, created_at) VALUES (?, ?, ?, ?)",
    ).run(searchId, amountMicros, day, now.toISOString());
    return { reserved: true, amountMicros };
  });
}

export type ReconcileOutcome =
  /** Coût connu : la réserve est soldée, la dépense RÉELLE intégralement
   *  comptabilisée (le budget est prévisionnel : un dépassement est
   *  enregistré tel quel, jamais tronqué à la réserve). */
  | { status: "settled"; spentMicros: number }
  /** Facturation incertaine (coût inconnu) : la réserve est CONSERVÉE. */
  | { status: "reserve-kept" };

/** Réconciliation en fin de recherche. `totalCostKnown = false` (au moins
 *  un coût d'appel inconnu) → réserve conservée, aucune dépense comptée. */
export function reconcileReservation(
  db: GuardDatabase,
  searchId: string,
  totalCostKnown: boolean,
  costMicros: number,
  now: Date,
): ReconcileOutcome {
  return withTransaction(db, (): ReconcileOutcome => {
    const row = db
      .prepare("SELECT amount_micros, day FROM reservations WHERE search_id = ? AND resolved_at IS NULL")
      .get(searchId) as { amount_micros: number | bigint; day: string } | undefined;
    if (!row) return { status: "settled", spentMicros: 0 };
    if (!totalCostKnown) return { status: "reserve-kept" };
    // dépense réelle ENTIÈRE — même au-delà de la réserve prévisionnelle
    const spent = Math.max(0, Math.round(costMicros));
    db.prepare("UPDATE reservations SET resolved_at = ?, spent_micros = ? WHERE search_id = ?")
      .run(now.toISOString(), spent, searchId);
    db.prepare(
      "INSERT INTO ledger (search_id, kind, amount_micros, day, ts) VALUES (?, 'spent', ?, ?, ?)",
    ).run(searchId, spent, row.day, now.toISOString());
    return { status: "settled", spentMicros: spent };
  });
}

/** Liste des réserves non résolues (diagnostic — aucune donnée personnelle). */
export function unresolvedReservations(db: GuardDatabase): {
  searchId: string;
  amountMicros: number;
  day: string;
  createdAt: string;
}[] {
  return db
    .prepare(
      "SELECT search_id, amount_micros, day, created_at FROM reservations WHERE resolved_at IS NULL ORDER BY created_at",
    )
    .all()
    .map((r) => ({
      searchId: r.search_id as string,
      amountMicros: Number(r.amount_micros),
      day: r.day as string,
      createdAt: r.created_at as string,
    }));
}