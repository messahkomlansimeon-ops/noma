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
 *
 * Achats de boost (lot P1b) : chaque transaction `boost_purchase` ↔ exactement UNE ligne boost_purchases de même montant (deux écritures :
 * vendeur −montant, boost_revenue +montant) ; chaque achat ↔ une cotation disponible qui lui correspond (offre, vendeur, durée, montant)
 * et un boost `purchase` du même vendeur, de la même offre et de la même durée, dont la FENÊTRE est exactement celle payée (durée exacte du
 * code, début à l'instant de l'achat à 60 s près : `boost_purchase_window_mismatch`) ; chaque boost `purchase` ↔ un achat ; chaque
 * transaction `boost_refund` ↔ un achat remboursé du même montant (deux écritures : boost_revenue −montant, vendeur +montant) ; le boost
 * d'un achat remboursé n'est plus actif. Solde de boost_revenue (formule exacte) :
 *   balance(boost_revenue) = somme(amount_xof des achats) - somme(amount_xof des achats remboursés)
 *                            + somme(amount des écritures de boost_revenue appartenant à des transactions de type 'adjustment')
 * (toute autre écriture de boost_revenue rompt l'égalité).
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
  | "duplicate_applied_event"
  | "boost_purchase_transaction_orphan"
  | "boost_purchase_mismatch"
  | "boost_purchase_quote_mismatch"
  | "boost_purchase_boost_mismatch"
  | "boost_purchase_window_mismatch"
  | "purchase_boost_without_purchase"
  | "boost_refund_transaction_orphan"
  | "boost_refund_mismatch"
  | "refunded_purchase_boost_active"
  | "boost_revenue_mismatch";

export type WalletCheckWarningCode =
  | "succeeded_event_rejected_amount"
  | "succeeded_event_rejected_state"
  | "succeeded_event_rejected_unknown_intent"
  | "adjustment_credits_user_account";

export interface WalletCheckViolation {
  code: WalletCheckCode;
  /** Nombre total d'écarts de ce type. */
  count: number;
  /** Au plus WALLET_CHECK_EXAMPLE_LIMIT exemples : identifiants techniques et montants (texte), jamais de donnée personnelle. */
  examples: Array<Record<string, string>>;
}

export interface WalletCheckWarning {
  code: WalletCheckWarningCode;
  /**
   * Nombre total de constats de ce type (le journal et le grand livre sont immuables : ils restent comptés) : événements
   * `payment.succeeded` refusés, ou écritures d'ajustement qui créditent un compte utilisateur.
   */
  count: number;
  /**
   * Au plus WALLET_CHECK_EXAMPLE_LIMIT exemples : pour un événement refusé, identifiant d'événement, intention (vide si inconnue) et
   * montant ; pour un ajustement, transaction, compte (identifiants techniques), montant et code de motif.
   */
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
  {
    // Achat de boost : chaque transaction `boost_purchase` appartient à exactement UN achat dont elle porte la référence.
    code: "boost_purchase_transaction_orphan",
    sql: `SELECT t.id::text AS transaction_id, t.reference AS reference
            FROM wallet_transactions t
           WHERE t.kind = 'boost_purchase'
             AND (SELECT count(*) FROM boost_purchases p WHERE p.transaction_id = t.id AND t.reference = 'boost_purchase:' || p.id::text) <> 1`,
  },
  {
    // Chaque achat a sa transaction : deux écritures exactement, vendeur −montant, boost_revenue +montant.
    code: "boost_purchase_mismatch",
    sql: `SELECT p.id::text AS purchase_id, COALESCE(t.id::text, '') AS transaction_id, p.amount_xof::text AS amount
            FROM boost_purchases p LEFT JOIN wallet_transactions t ON t.id = p.transaction_id
           WHERE NOT (
                 t.id IS NOT NULL AND t.kind = 'boost_purchase' AND t.reference = 'boost_purchase:' || p.id::text
             AND (SELECT count(*) FROM wallet_entries e WHERE e.transaction_id = t.id) = 2
             AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                          WHERE e.transaction_id = t.id AND a.kind = 'user' AND a.owner_id = p.seller_id AND e.amount = -p.amount_xof)
             AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                          WHERE e.transaction_id = t.id AND a.kind = 'boost_revenue' AND e.amount = p.amount_xof))`,
  },
  {
    // Le prix payé est celui de la cotation (disponible, de la même offre, du même vendeur, de la même durée).
    code: "boost_purchase_quote_mismatch",
    sql: `SELECT p.id::text AS purchase_id, p.quote_id::text AS quote_id, p.amount_xof::text AS amount, COALESCE(q.amount::text, '') AS quote_amount
            FROM boost_purchases p LEFT JOIN boost_quotes q ON q.id = p.quote_id
           WHERE NOT (q.id IS NOT NULL AND q.status = 'available' AND q.amount = p.amount_xof AND q.duration_code = p.duration_code
                      AND q.offer_id = p.offer_id AND q.seller_id = p.seller_id)`,
  },
  {
    // Chaque achat a son boost : source `purchase`, même vendeur, même offre, même durée.
    code: "boost_purchase_boost_mismatch",
    sql: `SELECT p.id::text AS purchase_id, p.boost_id::text AS boost_id
            FROM boost_purchases p LEFT JOIN offer_boosts b ON b.id = p.boost_id
           WHERE NOT (b.id IS NOT NULL AND b.source = 'purchase' AND b.seller_id = p.seller_id AND b.offer_id = p.offer_id
                      AND b.duration_code = p.duration_code)`,
  },
  {
    // La fenêtre du boost est celle qui a été payée : ends_at − starts_at = durée EXACTE du code de l'achat (24 h, 3 j, 7 j), et starts_at
    // égal à l'instant de l'achat à 60 s près (le boost est inséré dans la même transaction que la ligne d'achat : l'écart réel est de
    // quelques millisecondes ; 60 s est une borne large, les attentes de verrou étant limitées à 5 s).
    code: "boost_purchase_window_mismatch",
    sql: `SELECT p.id::text AS purchase_id, b.id::text AS boost_id,
                 extract(epoch FROM b.ends_at - b.starts_at)::text AS boost_seconds,
                 (CASE p.duration_code WHEN '24h' THEN 86400 WHEN '3d' THEN 259200 WHEN '7d' THEN 604800 END)::text AS expected_seconds,
                 extract(epoch FROM p.created_at - b.starts_at)::text AS start_offset_seconds
            FROM boost_purchases p JOIN offer_boosts b ON b.id = p.boost_id
           WHERE extract(epoch FROM b.ends_at - b.starts_at) <> (CASE p.duration_code WHEN '24h' THEN 86400 WHEN '3d' THEN 259200 WHEN '7d' THEN 604800 END)
              OR b.starts_at > p.created_at OR p.created_at - b.starts_at > interval '60 seconds'`,
  },
  {
    // Aucun boost `purchase` sans achat (un boost payé sans débit).
    code: "purchase_boost_without_purchase",
    sql: `SELECT b.id::text AS boost_id, b.offer_id::text AS offer_id
            FROM offer_boosts b
           WHERE b.source = 'purchase' AND (SELECT count(*) FROM boost_purchases p WHERE p.boost_id = b.id) <> 1`,
  },
  {
    // Chaque transaction `boost_refund` appartient à exactement UN achat remboursé dont elle porte la référence.
    code: "boost_refund_transaction_orphan",
    sql: `SELECT t.id::text AS transaction_id, t.reference AS reference
            FROM wallet_transactions t
           WHERE t.kind = 'boost_refund'
             AND (SELECT count(*) FROM boost_purchases p
                   WHERE p.refund_transaction_id = t.id AND p.refunded_at IS NOT NULL AND t.reference = 'boost_refund:' || p.id::text) <> 1`,
  },
  {
    // Chaque achat remboursé a son remboursement INTÉGRAL : deux écritures, boost_revenue −montant, vendeur +montant.
    code: "boost_refund_mismatch",
    sql: `SELECT p.id::text AS purchase_id, COALESCE(t.id::text, '') AS refund_transaction_id, p.amount_xof::text AS amount
            FROM boost_purchases p LEFT JOIN wallet_transactions t ON t.id = p.refund_transaction_id
           WHERE (p.refunded_at IS NOT NULL OR p.refund_transaction_id IS NOT NULL) AND NOT (
                 p.refunded_at IS NOT NULL AND t.id IS NOT NULL AND t.kind = 'boost_refund' AND t.reference = 'boost_refund:' || p.id::text
             AND (SELECT count(*) FROM wallet_entries e WHERE e.transaction_id = t.id) = 2
             AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                          WHERE e.transaction_id = t.id AND a.kind = 'boost_revenue' AND e.amount = -p.amount_xof)
             AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                          WHERE e.transaction_id = t.id AND a.kind = 'user' AND a.owner_id = p.seller_id AND e.amount = p.amount_xof))`,
  },
  {
    // Un achat remboursé n'a plus de boost actif (il a été annulé, ou était déjà expiré ou annulé).
    code: "refunded_purchase_boost_active",
    sql: `SELECT p.id::text AS purchase_id, b.id::text AS boost_id
            FROM boost_purchases p JOIN offer_boosts b ON b.id = p.boost_id
           WHERE p.refunded_at IS NOT NULL AND b.status = 'active'`,
  },
  {
    // Solde de boost_revenue = achats − remboursements + écritures de boost_revenue des ajustements (formule du commentaire de tête).
    code: "boost_revenue_mismatch",
    sql: `SELECT q.balance::text AS balance, (q.purchases_total - q.refunds_total + q.adjustments_total)::text AS expected,
                q.purchases_total::text AS purchases_total, q.refunds_total::text AS refunds_total, q.adjustments_total::text AS adjustments_total
            FROM (SELECT COALESCE((SELECT sum(a.balance) FROM wallet_accounts a WHERE a.kind = 'boost_revenue'), 0) AS balance,
                         COALESCE((SELECT sum(p.amount_xof) FROM boost_purchases p), 0) AS purchases_total,
                         COALESCE((SELECT sum(p.amount_xof) FROM boost_purchases p WHERE p.refunded_at IS NOT NULL), 0) AS refunds_total,
                         COALESCE((SELECT sum(e.amount) FROM wallet_entries e
                                     JOIN wallet_accounts a ON a.id = e.account_id
                                     JOIN wallet_transactions t ON t.id = e.transaction_id
                                    WHERE a.kind = 'boost_revenue' AND t.kind = 'adjustment'), 0) AS adjustments_total) q
           WHERE q.balance <> q.purchases_total - q.refunds_total + q.adjustments_total`,
  },
];

/** Événements payment.succeeded REFUSÉS : de l'argent a peut-être été encaissé sans crédit (à traiter à la main). */
const REJECTED_EVENT_WARNINGS: ReadonlyArray<{ code: WalletCheckWarningCode; outcome: string }> = [
  { code: "succeeded_event_rejected_amount", outcome: "rejected_amount" },
  { code: "succeeded_event_rejected_state", outcome: "rejected_state" },
  { code: "succeeded_event_rejected_unknown_intent", outcome: "rejected_unknown_intent" },
];

/**
 * Avertissements, dans l'ordre du rapport : les événements refusés, puis les ajustements qui créditent un compte utilisateur.
 * Un ajustement est une écriture d'administration SANS contrepartie métier (ni recharge, ni remboursement d'achat) : il crée de la
 * valeur pour un utilisateur à partir de boost_revenue. Chaque crédit de ce genre doit pouvoir être justifié (motif `reasonCode`).
 */
const WARNINGS: ReadonlyArray<{ code: WalletCheckWarningCode; sql: string }> = [
  ...REJECTED_EVENT_WARNINGS.map((warning) => ({
    code: warning.code,
    sql: `SELECT provider_event_id AS event_id, COALESCE(intent_id::text, '') AS intent_id, amount_xof::text AS amount
            FROM payment_events
           WHERE type = 'payment.succeeded' AND outcome = '${warning.outcome}'
           ORDER BY received_at DESC, id DESC`,
  })),
  {
    code: "adjustment_credits_user_account",
    sql: `SELECT t.id::text AS transaction_id, a.id::text AS account_id, e.amount::text AS amount,
                 COALESCE(t.metadata ->> 'reasonCode', '') AS reason_code
            FROM wallet_entries e
            JOIN wallet_accounts a ON a.id = e.account_id
            JOIN wallet_transactions t ON t.id = e.transaction_id
           WHERE t.kind = 'adjustment' AND a.kind = 'user' AND e.amount > 0
           ORDER BY t.created_at DESC, t.id DESC, e.id DESC`,
  },
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
      `SELECT q.*, count(*) OVER ()::text AS total_rows FROM (${warning.sql}) q LIMIT ${WALLET_CHECK_EXAMPLE_LIMIT}`,
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
