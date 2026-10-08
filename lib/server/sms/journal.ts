import "server-only";

import type { Pool, PoolClient, QueryResultRow } from "pg";
import { budgetVerdict, type SmsBudgetAudience, type SmsBudgetCounts, type SmsBudgetPlan, type SmsBudgetScope } from "./budget";
import type { MenoSendOutcome, SmsFinalStatus } from "./meno";

/**
 * Journal des envois SMS (table `sms_sends`, migration 0024). Une ligne par action métier (clé d'idempotence UNIQUE), écrite AVANT l'appel au fournisseur.
 * Jamais le texte, jamais le numéro en clair : seulement son empreinte HMAC et ses deux derniers chiffres.
 */

export type SmsPurpose = "otp" | "notification" | "smoke";
export type SmsRowStatus = "pending" | SmsFinalStatus;

export interface SmsSendRow extends QueryResultRow {
  id: string;
  purpose: SmsPurpose;
  reference: string;
  idempotency_key: string;
  provider_id: string | null;
  status: SmsRowStatus;
  http_status: number | null;
  error_code: string | null;
  attempts: number;
  phone_hash: string;
  phone_last2: string;
  audience: SmsBudgetAudience | null;
  created_at: Date;
  updated_at: Date;
}

export interface ReserveInput {
  purpose: SmsPurpose;
  reference: string;
  idempotencyKey: string;
  phoneHash: string;
  phoneLast2: string;
  now: Date;
  /** Début du jour UTC de `now` (les budgets du jour comptent les envois créés depuis cet instant). */
  dayStart: Date;
  /** Budgets du jour (plafond total découpé en codes / notifications, voir budget.ts). */
  budget: SmsBudgetPlan;
  /** Pour un code de connexion : le numéro a-t-il DÉJÀ un compte ? `null`/absent = non établi, traité comme un numéro inconnu. */
  audience?: SmsBudgetAudience | null;
}

export type Reservation =
  | { kind: "new"; id: string }
  | { kind: "existing"; row: SmsSendRow }
  | { kind: "budget"; scope: SmsBudgetScope };

/** Espace du verrou consultatif qui sérialise le comptage des budgets et l'insertion (voir la liste des espaces déjà utilisés : 945 à 960, 970 à 972, 981, 982, 990). */
export const SMS_BUDGET_LOCK_NAMESPACE = 1_314_664_977;

const HOUR_MS = 3_600_000;

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Compteurs des budgets (envois pending, accepted, uncertain) : du jour UTC, et de l'heure glissante pour les numéros inconnus (même au-delà de minuit). */
export async function readBudgetCounts(executor: Pick<Pool | PoolClient, "query">, dayStart: Date, now: Date): Promise<SmsBudgetCounts> {
  const hourStart = new Date(now.getTime() - HOUR_MS);
  const result = await executor.query<{ total: number; codes: number; new_numbers: number; new_hour: number; notifications: number }>(
    `SELECT count(*) FILTER (WHERE created_at >= $1::timestamptz)::int AS total,
            count(*) FILTER (WHERE created_at >= $1::timestamptz AND purpose = 'otp')::int AS codes,
            count(*) FILTER (WHERE created_at >= $1::timestamptz AND purpose = 'otp' AND audience IS DISTINCT FROM 'existing')::int AS new_numbers,
            count(*) FILTER (WHERE created_at > $2::timestamptz AND purpose = 'otp' AND audience IS DISTINCT FROM 'existing')::int AS new_hour,
            count(*) FILTER (WHERE created_at >= $1::timestamptz AND purpose = 'notification')::int AS notifications
       FROM sms_sends
      WHERE created_at >= LEAST($1::timestamptz, $2::timestamptz) AND status IN ('pending', 'accepted', 'uncertain')`,
    [dayStart, hourStart],
  );
  const row = result.rows[0];
  return { total: row.total, codes: row.codes, newNumbers: row.new_numbers, newNumbersHour: row.new_hour, notifications: row.notifications };
}

/**
 * Réserve la ligne du journal AVANT l'appel, dans UNE transaction sérialisée par un verrou consultatif (lot SMS1-bis, M1) : le comptage des budgets et l'insertion ne peuvent plus
 * s'entrecroiser, donc le plafond est EXACT même sous forte concurrence (plusieurs processus, plusieurs pools).
 *  - clé d'idempotence déjà connue et non `failed` : la ligne est rendue telle quelle (aucun contrôle de budget : aucun nouvel envoi) ;
 *  - clé nouvelle : contrôle des budgets (total, codes / notifications, part des numéros inconnus, lissage horaire), puis insertion `pending` ;
 *  - clé connue en `failed` (rien n'est parti) : la REPRISE repasse par le même contrôle de budget (C2), puis la ligne redevient `pending` datée de la reprise ;
 *  - budget refusé : AUCUNE écriture, motif rendu (`kind: "budget"`).
 */
export async function reserveSend(pool: Pool, input: ReserveInput): Promise<Reservation> {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock($1::int, 0)", [SMS_BUDGET_LOCK_NAMESPACE]);

    const found = await client.query<SmsSendRow>("SELECT * FROM sms_sends WHERE idempotency_key = $1 FOR UPDATE", [input.idempotencyKey]);
    const known = found.rows[0];
    // Une ligne non `failed` est rendue telle quelle ; une ligne `failed` d'un AUTRE destinataire ou d'une autre finalité aussi (conflit de clé : jamais reprise ici).
    if (known && (known.status !== "failed" || known.phone_hash !== input.phoneHash || known.purpose !== input.purpose)) {
      await client.query("COMMIT");
      return { kind: "existing", row: known };
    }

    const counts = await readBudgetCounts(client, input.dayStart, input.now);
    const scope = budgetVerdict(input.budget, counts, input.purpose, input.audience ?? null);
    if (scope) {
      await client.query("COMMIT");
      return { kind: "budget", scope };
    }

    if (known) {
      // Reprise d'un envoi `failed` : même clé, même ligne, mais datée de la reprise (le budget et le coût sont ceux du jour de l'envoi).
      const resumed = await client.query<{ id: string }>(
        `UPDATE sms_sends
            SET status = 'pending', error_code = NULL, http_status = NULL, audience = $3::text,
                created_at = GREATEST($2::timestamptz, created_at), updated_at = GREATEST($2::timestamptz, created_at)
          WHERE id = $1::uuid AND status = 'failed'
          RETURNING id`,
        [known.id, input.now, input.audience ?? null],
      );
      await client.query("COMMIT");
      return resumed.rowCount ? { kind: "new", id: resumed.rows[0].id } : { kind: "existing", row: known };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO sms_sends (purpose, reference, idempotency_key, phone_hash, phone_last2, audience, status, attempts, created_at, updated_at)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $7::text, 'pending', 0, $6::timestamptz, $6::timestamptz)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [input.purpose, input.reference, input.idempotencyKey, input.phoneHash, input.phoneLast2, input.now, input.audience ?? null],
    );
    if (inserted.rowCount) {
      await client.query("COMMIT");
      return { kind: "new", id: inserted.rows[0].id };
    }
    const raced = await client.query<SmsSendRow>("SELECT * FROM sms_sends WHERE idempotency_key = $1", [input.idempotencyKey]);
    await client.query("COMMIT");
    // Ne devrait jamais arriver sous le verrou ; par prudence, la ligne trouvée prime (jamais un second envoi pour la même clé).
    if (raced.rowCount) return { kind: "existing", row: raced.rows[0] };
    return { kind: "budget", scope: "total" };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      released = true;
      client.release(new Error("rollback failed"));
    }
    throw error;
  } finally {
    if (!released) client.release();
  }
}

/** Un envoi resté `pending` depuis plus longtemps que `staleBefore` (processus mort pendant l'appel) devient `uncertain` : le message est peut-être parti. */
export async function markInterrupted(pool: Pool, id: string, staleBefore: Date, now: Date): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sms_sends SET status = 'uncertain', error_code = 'interrupted', updated_at = GREATEST($3::timestamptz, created_at)
      WHERE id = $1::uuid AND status = 'pending' AND updated_at < $2::timestamptz`,
    [id, staleBefore, now],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Écrit le résultat. Jamais d'écrasement d'un statut final : seule une ligne `pending` change. Renvoie faux si la ligne n'était plus `pending`. */
export async function finishSend(pool: Pool, id: string, outcome: Pick<MenoSendOutcome, "status" | "httpStatus" | "errorCode" | "providerId" | "attempts">, now: Date): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sms_sends
        SET status = $2::text, http_status = $3::int, error_code = $4::text,
            provider_id = COALESCE($5::text, provider_id), attempts = attempts + $6::int,
            updated_at = GREATEST($7::timestamptz, created_at)
      WHERE id = $1::uuid AND status = 'pending'`,
    [id, outcome.status, outcome.httpStatus, outcome.errorCode, outcome.providerId, outcome.attempts, now],
  );
  return (result.rowCount ?? 0) === 1;
}
