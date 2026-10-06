import "server-only";

import type { Pool } from "pg";
import type { SqlExecutor } from "../postgres/client";
import { requireWalletPool } from "./ledger";

/**
 * Contrôle de réconciliation du portefeuille (lot P1a), en LECTURE SEULE : aucun INSERT, UPDATE ni DELETE. Il vérifie les
 * invariants du grand livre, le lien recharge ↔ intention de paiement ↔ événement du prestataire, et le solde de
 * provider_clearing. Un rapport ne contient AUCUNE donnée personnelle : ni propriétaire, ni téléphone ; seulement des
 * comptages et des identifiants techniques (transactions, comptes, intentions, événements) et des montants. Voir WALLET.md.
 *
 * Deux sortes de constats :
 *  - les ÉCARTS (`violations`) : un invariant est rompu, `ok` vaut faux, le script sort en code 1 ;
 *  - les AVERTISSEMENTS (`warnings`) : le journal contient des `payment.succeeded` que le système a REFUSÉS (montant
 *    différent, intention dans un état qui n'attendait pas de succès, intention inconnue) : de l'argent a peut-être été
 *    encaissé chez le prestataire sans crédit pour l'utilisateur. À traiter à la main. Ils ne changent pas `ok` ni le code de
 *    sortie, sauf avec l'option `--strict` du script.
 *
 * Solde de provider_clearing (formule exacte) :
 *   balance(provider_clearing) = - somme(amount_xof des intentions `succeeded`)
 *                                + somme(amount des écritures de provider_clearing appartenant à des transactions de type <> 'topup')
 */

export type WalletCheckCode =
  | "transaction_unbalanced"
  | "balance_mismatch"
  | "negative_user_balance"
  | "system_account_invalid"
  | "ledger_total_nonzero"
  | "provider_clearing_mismatch"
  | "succeeded_intent_without_topup"
  | "topup_without_succeeded_intent"
  | "topup_mismatch"
  | "succeeded_intent_without_applied_event"
  | "failed_intent_without_applied_event"
  | "applied_event_state_mismatch"
  | "duplicate_applied_event";

export type WalletCheckWarningCode =
  | "succeeded_event_rejected_amount"
  | "succeeded_event_rejected_state"
  | "succeeded_event_rejected_unknown_intent";

export interface WalletCheckViolation {
  code: WalletCheckCode;
  /** Nombre total d'écarts de ce type. */
  count: number;
  /** Au plus WALLET_CHECK_EXAMPLE_LIMIT exemples : identifiants techniques et montants (texte), jamais de donnée personnelle. */
  examples: Array<Record<string, string>>;
}

export interface WalletCheckWarning {
  code: WalletCheckWarningCode;
  /** Nombre total d'événements `payment.succeeded` refusés de ce type (le journal est immuable : ils restent comptés). */
  count: number;
  /** Au plus WALLET_CHECK_EXAMPLE_LIMIT exemples : identifiant d'événement, intention (vide si inconnue) et montant. */
  examples: Array<Record<string, string>>;
}

export interface WalletCheckReport {
  /** Vrai si AUCUN écart (les avertissements ne comptent pas). */
  ok: boolean;
  totals: { accounts: number; transactions: number; entries: number; paymentIntents: number; paymentEvents: number };
  violations: WalletCheckViolation[];
  warnings: WalletCheckWarning[];
}

export const WALLET_CHECK_EXAMPLE_LIMIT = 20;

/** Chaque requête renvoie les écarts (colonnes texte) ; `count(*) OVER ()` donne le total avant la limite d'exemples. */
const CHECKS: ReadonlyArray<{ code: WalletCheckCode; sql: string }> = [
  {
    // Somme des écritures ≠ 0, ou moins de deux écritures.
    code: "transaction_unbalanced",
    sql: `SELECT t.id::text AS transaction_id, count(e.id)::text AS entries, COALESCE(sum(e.amount), 0)::text AS total
            FROM wallet_transactions t LEFT JOIN wallet_entries e ON e.transaction_id = t.id
           GROUP BY t.id
          HAVING count(e.id) < 2 OR COALESCE(sum(e.amount), 0) <> 0`,
  },
  {
    // Solde enregistré ≠ somme des écritures du compte.
    code: "balance_mismatch",
    sql: `SELECT a.id::text AS account_id, a.kind AS kind, a.balance::text AS balance, COALESCE(sum(e.amount), 0)::text AS expected
            FROM wallet_accounts a LEFT JOIN wallet_entries e ON e.account_id = a.id
           GROUP BY a.id
          HAVING a.balance <> COALESCE(sum(e.amount), 0)`,
  },
  {
    code: "negative_user_balance",
    sql: `SELECT id::text AS account_id, balance::text AS balance FROM wallet_accounts WHERE kind = 'user' AND balance < 0`,
  },
  {
    // Exactement un compte de chaque type système (aucun manquant, aucun en double).
    code: "system_account_invalid",
    sql: `SELECT k.kind AS kind, (SELECT count(*) FROM wallet_accounts a WHERE a.kind = k.kind)::text AS found
            FROM (VALUES ('provider_clearing'), ('boost_revenue')) AS k(kind)
           WHERE (SELECT count(*) FROM wallet_accounts a WHERE a.kind = k.kind) <> 1`,
  },
  {
    // Partie double globale : tous les soldes ensemble valent zéro.
    code: "ledger_total_nonzero",
    sql: `SELECT sum(balance)::text AS total FROM wallet_accounts HAVING COALESCE(sum(balance), 0) <> 0`,
  },
  {
    // Solde de provider_clearing = - somme des intentions réussies + somme des écritures de provider_clearing hors recharges
    // (tous les comptes provider_clearing ensemble : un doublon est signalé à part par system_account_invalid).
    code: "provider_clearing_mismatch",
    sql: `SELECT q.balance::text AS balance, (q.other_total - q.succeeded_total)::text AS expected,
                q.succeeded_total::text AS succeeded_intents_total, q.other_total::text AS other_entries_total
            FROM (SELECT COALESCE((SELECT sum(a.balance) FROM wallet_accounts a WHERE a.kind = 'provider_clearing'), 0) AS balance,
                         COALESCE((SELECT sum(i.amount_xof) FROM payment_intents i WHERE i.status = 'succeeded'), 0) AS succeeded_total,
                         COALESCE((SELECT sum(e.amount) FROM wallet_entries e
                                     JOIN wallet_accounts a ON a.id = e.account_id
                                     JOIN wallet_transactions t ON t.id = e.transaction_id
                                    WHERE a.kind = 'provider_clearing' AND t.kind <> 'topup'), 0) AS other_total) q
           WHERE q.balance <> q.other_total - q.succeeded_total`,
  },
  {
    code: "succeeded_intent_without_topup",
    sql: `SELECT i.id::text AS intent_id, i.amount_xof::text AS amount
            FROM payment_intents i
           WHERE i.status = 'succeeded'
             AND NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.kind = 'topup' AND t.reference = 'topup:' || i.id::text)`,
  },
  {
    // Aucune recharge sans intention RÉUSSIE.
    code: "topup_without_succeeded_intent",
    sql: `SELECT t.id::text AS transaction_id
            FROM wallet_transactions t
           WHERE t.kind = 'topup'
             AND NOT EXISTS (SELECT 1 FROM payment_intents i WHERE 'topup:' || i.id::text = t.reference AND i.status = 'succeeded')`,
  },
  {
    // La recharge d'une intention réussie : deux écritures exactement, +montant sur le compte du propriétaire, -montant sur provider_clearing.
    code: "topup_mismatch",
    sql: `SELECT i.id::text AS intent_id, t.id::text AS transaction_id, i.amount_xof::text AS amount
            FROM payment_intents i
            JOIN wallet_transactions t ON t.kind = 'topup' AND t.reference = 'topup:' || i.id::text
           WHERE i.status = 'succeeded' AND NOT (
                 (SELECT count(*) FROM wallet_entries e WHERE e.transaction_id = t.id) = 2
             AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                          WHERE e.transaction_id = t.id AND a.kind = 'user' AND a.owner_id = i.owner_id AND e.amount = i.amount_xof)
             AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                          WHERE e.transaction_id = t.id AND a.kind = 'provider_clearing' AND e.amount = -i.amount_xof))`,
  },
  {
    // Une intention réussie a un payment.succeeded « applied » de même montant (exactement un : voir aussi duplicate_applied_event).
    code: "succeeded_intent_without_applied_event",
    sql: `SELECT i.id::text AS intent_id, i.amount_xof::text AS amount
            FROM payment_intents i
           WHERE i.status = 'succeeded'
             AND NOT EXISTS (SELECT 1 FROM payment_events ev
                              WHERE ev.intent_id = i.id AND ev.type = 'payment.succeeded' AND ev.outcome = 'applied' AND ev.amount_xof = i.amount_xof)`,
  },
  {
    // Une intention échouée a un payment.failed « applied » de même montant.
    code: "failed_intent_without_applied_event",
    sql: `SELECT i.id::text AS intent_id, i.amount_xof::text AS amount
            FROM payment_intents i
           WHERE i.status = 'failed'
             AND NOT EXISTS (SELECT 1 FROM payment_events ev
                              WHERE ev.intent_id = i.id AND ev.type = 'payment.failed' AND ev.outcome = 'applied' AND ev.amount_xof = i.amount_xof)`,
  },
  {
    // Réciproque : tout événement « applied » pointe une intention dans l'état qu'il produit, avec le même montant.
    code: "applied_event_state_mismatch",
    sql: `SELECT ev.provider_event_id AS event_id, COALESCE(ev.intent_id::text, '') AS intent_id, ev.type AS type,
                COALESCE(i.status, '') AS intent_status, ev.amount_xof::text AS amount
            FROM payment_events ev LEFT JOIN payment_intents i ON i.id = ev.intent_id
           WHERE ev.outcome = 'applied' AND NOT (
                 i.id IS NOT NULL AND i.amount_xof = ev.amount_xof
             AND ((ev.type = 'payment.succeeded' AND i.status = 'succeeded') OR (ev.type = 'payment.failed' AND i.status = 'failed')))`,
  },
  {
    // Un paiement (ou un échec) ne se déclare « appliqué » qu'une fois par intention.
    code: "duplicate_applied_event",
    sql: `SELECT intent_id::text AS intent_id, type AS type, count(*)::text AS applied_events
            FROM payment_events
           WHERE outcome = 'applied'
           GROUP BY intent_id, type HAVING count(*) > 1`,
  },
];

/** Événements payment.succeeded REFUSÉS : de l'argent a peut-être été encaissé sans crédit (à traiter à la main). */
const WARNINGS: ReadonlyArray<{ code: WalletCheckWarningCode; outcome: string }> = [
  { code: "succeeded_event_rejected_amount", outcome: "rejected_amount" },
  { code: "succeeded_event_rejected_state", outcome: "rejected_state" },
  { code: "succeeded_event_rejected_unknown_intent", outcome: "rejected_unknown_intent" },
];

/** Les requêtes de contrôle, sur un exécuteur quelconque (un client dans une transaction de test, par exemple). */
export async function runWalletCheck(executor: SqlExecutor): Promise<WalletCheckReport> {
  const violations: WalletCheckViolation[] = [];
  for (const check of CHECKS) {
    const result = await executor.query<Record<string, string>>(
      `SELECT q.*, count(*) OVER ()::text AS total_rows FROM (${check.sql}) q LIMIT ${WALLET_CHECK_EXAMPLE_LIMIT}`,
    );
    if (result.rows.length === 0) continue;
    violations.push({
      code: check.code,
      count: Number(result.rows[0].total_rows),
      examples: result.rows.map((row) => {
        const example = { ...row };
        delete example.total_rows;
        return example;
      }),
    });
  }
  const warnings: WalletCheckWarning[] = [];
  for (const warning of WARNINGS) {
    const result = await executor.query<Record<string, string>>(
      `SELECT q.*, count(*) OVER ()::text AS total_rows
         FROM (SELECT provider_event_id AS event_id, COALESCE(intent_id::text, '') AS intent_id, amount_xof::text AS amount
                 FROM payment_events
                WHERE type = 'payment.succeeded' AND outcome = '${warning.outcome}'
                ORDER BY received_at DESC, id DESC) q
        LIMIT ${WALLET_CHECK_EXAMPLE_LIMIT}`,
    );
    if (result.rows.length === 0) continue;
    warnings.push({
      code: warning.code,
      count: Number(result.rows[0].total_rows),
      examples: result.rows.map((row) => {
        const example = { ...row };
        delete example.total_rows;
        return example;
      }),
    });
  }
  const totals = await executor.query<{ accounts: string; transactions: string; entries: string; intents: string; events: string }>(
    `SELECT (SELECT count(*) FROM wallet_accounts)::text AS accounts, (SELECT count(*) FROM wallet_transactions)::text AS transactions,
            (SELECT count(*) FROM wallet_entries)::text AS entries, (SELECT count(*) FROM payment_intents)::text AS intents,
            (SELECT count(*) FROM payment_events)::text AS events`,
  );
  const row = totals.rows[0];
  return {
    ok: violations.length === 0,
    totals: {
      accounts: Number(row.accounts), transactions: Number(row.transactions), entries: Number(row.entries),
      paymentIntents: Number(row.intents), paymentEvents: Number(row.events),
    },
    violations,
    warnings,
  };
}

/** Contrôle complet dans UN instantané cohérent (REPEATABLE READ, lecture seule). */
export async function checkWalletIntegrity(pool: Pool): Promise<WalletCheckReport> {
  const checkedPool = requireWalletPool(pool);
  const client = await checkedPool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const report = await runWalletCheck(client);
    await client.query("COMMIT");
    return report;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* conserver l'erreur utile */ }
    throw error;
  } finally {
    client.release();
  }
}
