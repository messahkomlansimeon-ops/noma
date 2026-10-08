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
 *
 * Offre Pro (lot PRO1) : le portefeuille a un SOUS-COMPTE PROMOTIONNEL par utilisateur (`user_promo`) et quatre comptes système (`subscription_revenue`, `promo_issuance`,
 * `promo_consumed`, `promo_expired`). Contrôles ajoutés (voir OFFRE-PRO.md) :
 *  - un achat de boost peut être payé en partie par des crédits promotionnels : `boost_purchase_mismatch` et `boost_refund_mismatch` vérifient les écritures attendues (part payée :
 *    vendeur / boost_revenue ; part promotionnelle : user_promo / promo_consumed, et au remboursement user_promo ou promo_expired) ; `boost_revenue_mismatch` ne compte que la part PAYÉE ;
 *  - un solde promotionnel n'est jamais négatif (`negative_promo_balance`), égal à la somme des restes de ses émissions (`promo_balance_mismatch`), un reste d'émission n'est jamais
 *    négatif (`promo_remaining_negative`) ;
 *  - chaque émission correspond à sa période et à son écriture (`promo_grant_mismatch`, `promo_grant_missing`) ; chaque expiration est écrite au grand livre pour le reste exact
 *    (`promo_expiry_mismatch`, `promo_expiry_incomplete`), jamais avant l'échéance (`promo_expired_early`), jamais une dépense après l'expiration (`promo_spent_after_expiry`) ;
 *  - les mouvements promotionnels d'un achat couvrent exactement sa part promotionnelle (`promo_purchase_mismatch`, `promo_movement_mismatch`) ;
 *  - aucun type de transaction ne touche un compte promotionnel hors de son rôle (`promo_account_misuse` : ni recharge, ni ajustement, ni retrait) ;
 *  - soldes des comptes système (formules exactes) : `promo_issuance` = − émissions ; `promo_consumed` = dépenses − restitutions − pertes ; `promo_expired` = expirations + pertes ;
 *    `subscription_revenue` = périodes payées − périodes remboursées ;
 *  - périodes d'abonnement : écritures du débit (`subscription_period_mismatch`), du remboursement (`subscription_refund_mismatch`), transactions orphelines, état de l'abonnement égal à sa
 *    dernière période (`subscription_state_mismatch`).
 * Avertissements : `promo_expiry_overdue` (une émission échue depuis plus de 15 minutes n'est pas encore expirée : le worker retarde) et `subscription_overdue` (un abonnement échu depuis
 * plus d'une heure n'est pas encore traité).
 *
 * Paiement Sublymus / Wave (lot PAY1, migration 0026) : le crédit d'une recharge passe par la MÊME écriture que le prestataire fictif (les contrôles de recharge ci-dessus valent donc
 * pour lui : équilibre, une transaction `topup` par intention réussie, événement appliqué, solde de provider_clearing). Contrôles ajoutés : toute intention Sublymus a sa ligne de
 * session (`sublymus_checkout_missing`) qui porte SA référence (`sublymus_checkout_mismatch`) ; toute intention Sublymus réussie a été créditée par un webhook authentifié ou un
 * rattrapage, jamais autrement (`sublymus_credit_origin_unknown` : par exemple un retour du navigateur) ; aucun événement Sublymus n'est rattaché à une intention d'un autre
 * prestataire (`sublymus_event_provider_mismatch`). Avertissements : `sublymus_anomaly_open` (anomalies de rapprochement à traiter : montant, devise, statut, référence
 * inconnue… rien n'a été crédité) et `sublymus_catchup_overdue` (rattrapage échu depuis plus de 15 minutes : le worker retarde).
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
  | "boost_revenue_mismatch"
  | "negative_promo_balance"
  | "promo_balance_mismatch"
  | "promo_remaining_negative"
  | "promo_grant_mismatch"
  | "promo_grant_missing"
  | "promo_expiry_mismatch"
  | "promo_expiry_incomplete"
  | "promo_expired_early"
  | "promo_spent_after_expiry"
  | "promo_purchase_mismatch"
  | "promo_movement_mismatch"
  | "promo_account_misuse"
  | "promo_issuance_mismatch"
  | "promo_consumed_mismatch"
  | "promo_expired_mismatch"
  | "subscription_revenue_mismatch"
  | "subscription_period_mismatch"
  | "subscription_charge_transaction_orphan"
  | "subscription_refund_mismatch"
  | "subscription_refund_transaction_orphan"
  | "promo_expiry_transaction_orphan"
  | "subscription_state_mismatch"
  | "subscription_live_duplicate"
  | "sublymus_checkout_missing"
  | "sublymus_checkout_mismatch"
  | "sublymus_credit_origin_unknown"
  | "sublymus_event_provider_mismatch";

export type WalletCheckWarningCode =
  | "succeeded_event_rejected_amount"
  | "succeeded_event_rejected_state"
  | "succeeded_event_rejected_unknown_intent"
  | "adjustment_credits_user_account"
  | "promo_expiry_overdue"
  | "subscription_overdue"
  | "sublymus_anomaly_open"
  | "sublymus_catchup_overdue";

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
    // Les comptes de l'offre Pro (lot PRO1) sont recréés à la demande : au plus un de chacun (zéro est permis, aucune écriture n'ayant pu les toucher).
    sql: `SELECT k.kind AS kind, (SELECT count(*) FROM wallet_accounts a WHERE a.kind = k.kind)::text AS found
            FROM (VALUES ('provider_clearing', 1), ('boost_revenue', 1), ('subscription_revenue', 0), ('promo_issuance', 0), ('promo_consumed', 0), ('promo_expired', 0)) AS k(kind, minimum)
           WHERE (SELECT count(*) FROM wallet_accounts a WHERE a.kind = k.kind) NOT BETWEEN k.minimum AND 1`,
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
    // Réciproque : tout événement « applied » pointe une intention dans l'état qu'il produit, avec le même montant (exception Sublymus : un échec supplanté par un paiement réussi).
    code: "applied_event_state_mismatch",
    sql: `SELECT ev.provider_event_id AS event_id, COALESCE(ev.intent_id::text, '') AS intent_id, ev.type AS type,
                COALESCE(i.status, '') AS intent_status, ev.amount_xof::text AS amount
            FROM payment_events ev LEFT JOIN payment_intents i ON i.id = ev.intent_id
           WHERE ev.outcome = 'applied' AND NOT (
                 i.id IS NOT NULL AND i.amount_xof = ev.amount_xof
             AND ((ev.type = 'payment.succeeded' AND i.status = 'succeeded')
                  OR (ev.type = 'payment.failed' AND (i.status = 'failed'
                      -- Lot PAY1 : un échec SUPPLANTÉ par un paiement réussi arrivé ensuite (Sublymus seulement) reste un événement appliqué.
                      OR (i.status = 'succeeded' AND i.provider = 'sublymus' AND EXISTS (
                            SELECT 1 FROM payment_events later WHERE later.intent_id = i.id AND later.type = 'payment.succeeded' AND later.outcome = 'applied' AND later.received_at >= ev.received_at))))))`,
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
    // Chaque achat a sa transaction : part payée (vendeur −payé, boost_revenue +payé) et part promotionnelle (user_promo −promo, promo_consumed +promo), rien d'autre
    // (lot PRO1 : la règle exacte est celle de la fonction `boost_purchase_ledger_matches_v2`).
    code: "boost_purchase_mismatch",
    sql: `SELECT p.id::text AS purchase_id, COALESCE(t.id::text, '') AS transaction_id, p.amount_xof::text AS amount, p.promo_xof::text AS promo_amount
            FROM boost_purchases p LEFT JOIN wallet_transactions t ON t.id = p.transaction_id
           WHERE t.id IS NULL OR NOT boost_purchase_ledger_matches_v2(t.id, 'boost_purchase', p.id, p.seller_id, p.paid_xof, p.promo_xof)`,
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
    // Chaque achat remboursé a son remboursement INTÉGRAL : part payée rendue (boost_revenue −payé, vendeur +payé) et part promotionnelle (promo_consumed −promo ; rendue au
    // sous-compte si l'émission était valable, sinon perdue : promo_expired), règle exacte de `boost_purchase_ledger_matches_v2`.
    code: "boost_refund_mismatch",
    sql: `SELECT p.id::text AS purchase_id, COALESCE(t.id::text, '') AS refund_transaction_id, p.amount_xof::text AS amount
            FROM boost_purchases p LEFT JOIN wallet_transactions t ON t.id = p.refund_transaction_id
           WHERE (p.refunded_at IS NOT NULL OR p.refund_transaction_id IS NOT NULL) AND NOT (
                 p.refunded_at IS NOT NULL AND t.id IS NOT NULL
             AND boost_purchase_ledger_matches_v2(t.id, 'boost_refund', p.id, p.seller_id, p.paid_xof, p.promo_xof))`,
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
                         COALESCE((SELECT sum(p.paid_xof) FROM boost_purchases p), 0) AS purchases_total,
                         COALESCE((SELECT sum(p.paid_xof) FROM boost_purchases p WHERE p.refunded_at IS NOT NULL), 0) AS refunds_total,
                         COALESCE((SELECT sum(e.amount) FROM wallet_entries e
                                     JOIN wallet_accounts a ON a.id = e.account_id
                                     JOIN wallet_transactions t ON t.id = e.transaction_id
                                    WHERE a.kind = 'boost_revenue' AND t.kind = 'adjustment'), 0) AS adjustments_total) q
           WHERE q.balance <> q.purchases_total - q.refunds_total + q.adjustments_total`,
  },
  // ───────────── offre Pro : crédits promotionnels (lot PRO1) ─────────────
  {
    code: "negative_promo_balance",
    sql: `SELECT id::text AS account_id, balance::text AS balance FROM wallet_accounts WHERE kind = 'user_promo' AND balance < 0`,
  },
  {
    // Solde promotionnel = somme des restes des émissions de son propriétaire (reste = montant + restitutions − dépenses − expiré).
    code: "promo_balance_mismatch",
    sql: `SELECT a.id::text AS account_id, a.balance::text AS balance, COALESCE(r.total, 0)::text AS expected
            FROM wallet_accounts a
            LEFT JOIN (SELECT g.user_id, sum(promo_grant_remaining(g.id)) AS total FROM promo_grants g GROUP BY g.user_id) r ON r.user_id = a.owner_id
           WHERE a.kind = 'user_promo' AND a.balance <> COALESCE(r.total, 0)`,
  },
  {
    code: "promo_remaining_negative",
    sql: `SELECT g.id::text AS grant_id, promo_grant_remaining(g.id)::text AS remaining FROM promo_grants g WHERE promo_grant_remaining(g.id) < 0`,
  },
  {
    // Chaque émission : sa période (même utilisateur, mêmes crédits, début et échéance de la période, même transaction) et ses deux écritures (user_promo +montant, promo_issuance −montant).
    code: "promo_grant_mismatch",
    sql: `SELECT g.id::text AS grant_id, g.period_id::text AS period_id, g.amount_xof::text AS amount
            FROM promo_grants g LEFT JOIN subscription_periods p ON p.id = g.period_id
           WHERE NOT (
                 p.id IS NOT NULL AND p.user_id = g.user_id AND p.promo_credits_xof = g.amount_xof AND p.starts_at = g.granted_at AND p.ends_at = g.expires_at
             AND p.transaction_id = g.grant_transaction_id
             AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                          WHERE e.transaction_id = g.grant_transaction_id AND a.kind = 'user_promo' AND a.owner_id = g.user_id AND e.amount = g.amount_xof)
             AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                          WHERE e.transaction_id = g.grant_transaction_id AND a.kind = 'promo_issuance' AND e.amount = -g.amount_xof))`,
  },
  {
    // Une période qui a émis des crédits promotionnels a son émission.
    code: "promo_grant_missing",
    sql: `SELECT p.id::text AS period_id, p.promo_credits_xof::text AS amount
            FROM subscription_periods p
           WHERE p.promo_credits_xof > 0 AND NOT EXISTS (SELECT 1 FROM promo_grants g WHERE g.period_id = p.id)`,
  },
  {
    // Une émission close : si le reste retiré est positif, sa transaction (promo_expiry, ou le remboursement de la période) retire exactement ce reste du sous-compte
    // (user_promo −reste, promo_expired +reste) ; un `promo_expiry` ne compte que ces deux écritures.
    code: "promo_expiry_mismatch",
    sql: `SELECT g.id::text AS grant_id, g.expired_xof::text AS expired, COALESCE(g.expiry_transaction_id::text, '') AS transaction_id
            FROM promo_grants g LEFT JOIN wallet_transactions t ON t.id = g.expiry_transaction_id
           WHERE g.expired_at IS NOT NULL AND g.expired_xof > 0 AND NOT (
                 t.id IS NOT NULL
             AND ((g.expiry_reason = 'period_end' AND t.kind = 'promo_expiry' AND t.reference = 'promo_expiry:' || g.id::text
                   AND (SELECT count(*) FROM wallet_entries e WHERE e.transaction_id = t.id) = 2)
               OR (g.expiry_reason = 'refund' AND t.kind = 'subscription_refund'))
             AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                          WHERE e.transaction_id = t.id AND a.kind = 'user_promo' AND a.owner_id = g.user_id AND e.amount = -g.expired_xof)
             AND EXISTS (SELECT 1 FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
                          WHERE e.transaction_id = t.id AND a.kind = 'promo_expired' AND e.amount = g.expired_xof))`,
  },
  {
    // Une émission close n'a plus de reste.
    code: "promo_expiry_incomplete",
    sql: `SELECT g.id::text AS grant_id, promo_grant_remaining(g.id)::text AS remaining FROM promo_grants g WHERE g.expired_at IS NOT NULL AND promo_grant_remaining(g.id) <> 0`,
  },
  {
    // Une expiration de fin de période n'est jamais écrite avant l'échéance (jamais d'effacement anticipé).
    code: "promo_expired_early",
    sql: `SELECT g.id::text AS grant_id FROM promo_grants g WHERE g.expiry_reason = 'period_end' AND g.expired_at < g.expires_at`,
  },
  {
    // Aucune dépense après l'échéance de l'émission ni après son expiration.
    code: "promo_spent_after_expiry",
    sql: `SELECT m.id::text AS movement_id, g.id::text AS grant_id
            FROM promo_movements m JOIN promo_grants g ON g.id = m.grant_id
           WHERE m.kind = 'spend' AND (m.created_at >= g.expires_at OR (g.expired_at IS NOT NULL AND m.created_at >= g.expired_at))`,
  },
  {
    // La part promotionnelle d'un achat est couverte par ses dépenses ; remboursé : par autant de restitutions et de pertes, jamais avant.
    code: "promo_purchase_mismatch",
    sql: `SELECT p.id::text AS purchase_id, p.promo_xof::text AS promo_amount,
                COALESCE(sum(m.amount_xof) FILTER (WHERE m.kind = 'spend'), 0)::text AS spent,
                COALESCE(sum(m.amount_xof) FILTER (WHERE m.kind IN ('restore', 'lapse')), 0)::text AS returned
            FROM boost_purchases p LEFT JOIN promo_movements m ON m.purchase_id = p.id
           GROUP BY p.id
          HAVING COALESCE(sum(m.amount_xof) FILTER (WHERE m.kind = 'spend'), 0) <> p.promo_xof
              OR COALESCE(sum(m.amount_xof) FILTER (WHERE m.kind IN ('restore', 'lapse')), 0) <> CASE WHEN p.refunded_at IS NOT NULL THEN p.promo_xof ELSE 0 END`,
  },
  {
    // Un mouvement porte la transaction de l'achat (dépense) ou du remboursement (restitution, perte) du MÊME vendeur que son émission.
    code: "promo_movement_mismatch",
    sql: `SELECT m.id::text AS movement_id, m.kind AS kind, m.amount_xof::text AS amount
            FROM promo_movements m
            JOIN promo_grants g ON g.id = m.grant_id
            JOIN boost_purchases p ON p.id = m.purchase_id
           WHERE NOT (p.seller_id = g.user_id
                      AND ((m.kind = 'spend' AND m.transaction_id = p.transaction_id) OR (m.kind IN ('restore', 'lapse') AND m.transaction_id = p.refund_transaction_id)))`,
  },
  {
    // Un compte promotionnel ou de revenus d'abonnement n'est touché que par les types de transaction de son rôle, dans le bon sens (même règle que le déclencheur de la base).
    code: "promo_account_misuse",
    sql: `SELECT e.id::text AS entry_id, t.id::text AS transaction_id, t.kind AS transaction_kind, a.kind AS account_kind, e.amount::text AS amount
            FROM wallet_entries e
            JOIN wallet_accounts a ON a.id = e.account_id
            JOIN wallet_transactions t ON t.id = e.transaction_id
           WHERE a.kind IN ('user_promo', 'promo_issuance', 'promo_consumed', 'promo_expired', 'subscription_revenue')
             AND NOT COALESCE(CASE a.kind
                   WHEN 'user_promo' THEN (t.kind IN ('subscription_charge', 'boost_refund') AND e.amount > 0)
                                       OR (t.kind IN ('boost_purchase', 'promo_expiry', 'subscription_refund') AND e.amount < 0)
                   WHEN 'promo_issuance' THEN t.kind = 'subscription_charge' AND e.amount < 0
                   WHEN 'promo_consumed' THEN (t.kind = 'boost_purchase' AND e.amount > 0) OR (t.kind = 'boost_refund' AND e.amount < 0)
                   WHEN 'promo_expired' THEN t.kind IN ('promo_expiry', 'subscription_refund', 'boost_refund') AND e.amount > 0
                   WHEN 'subscription_revenue' THEN (t.kind = 'subscription_charge' AND e.amount > 0) OR (t.kind = 'subscription_refund' AND e.amount < 0)
                 END, FALSE)`,
  },
  {
    // promo_issuance = − somme des émissions.
    code: "promo_issuance_mismatch",
    sql: `SELECT q.balance::text AS balance, (-q.granted)::text AS expected
            FROM (SELECT COALESCE((SELECT sum(a.balance) FROM wallet_accounts a WHERE a.kind = 'promo_issuance'), 0) AS balance,
                         COALESCE((SELECT sum(g.amount_xof) FROM promo_grants g), 0) AS granted) q
           WHERE q.balance <> -q.granted`,
  },
  {
    // promo_consumed = dépenses − restitutions − pertes.
    code: "promo_consumed_mismatch",
    sql: `SELECT q.balance::text AS balance, (q.spent - q.restored - q.lapsed)::text AS expected
            FROM (SELECT COALESCE((SELECT sum(a.balance) FROM wallet_accounts a WHERE a.kind = 'promo_consumed'), 0) AS balance,
                         COALESCE((SELECT sum(m.amount_xof) FROM promo_movements m WHERE m.kind = 'spend'), 0) AS spent,
                         COALESCE((SELECT sum(m.amount_xof) FROM promo_movements m WHERE m.kind = 'restore'), 0) AS restored,
                         COALESCE((SELECT sum(m.amount_xof) FROM promo_movements m WHERE m.kind = 'lapse'), 0) AS lapsed) q
           WHERE q.balance <> q.spent - q.restored - q.lapsed`,
  },
  {
    // promo_expired = expirations (et annulations par remboursement de période) + pertes.
    code: "promo_expired_mismatch",
    sql: `SELECT q.balance::text AS balance, (q.expired + q.lapsed)::text AS expected
            FROM (SELECT COALESCE((SELECT sum(a.balance) FROM wallet_accounts a WHERE a.kind = 'promo_expired'), 0) AS balance,
                         COALESCE((SELECT sum(g.expired_xof) FROM promo_grants g), 0) AS expired,
                         COALESCE((SELECT sum(m.amount_xof) FROM promo_movements m WHERE m.kind = 'lapse'), 0) AS lapsed) q
           WHERE q.balance <> q.expired + q.lapsed`,
  },
  {
    // subscription_revenue = périodes payées − périodes remboursées.
    code: "subscription_revenue_mismatch",
    sql: `SELECT q.balance::text AS balance, (q.charged - q.refunded)::text AS expected
            FROM (SELECT COALESCE((SELECT sum(a.balance) FROM wallet_accounts a WHERE a.kind = 'subscription_revenue'), 0) AS balance,
                         COALESCE((SELECT sum(p.price_xof) FROM subscription_periods p), 0) AS charged,
                         COALESCE((SELECT sum(p.price_xof) FROM subscription_periods p WHERE p.refunded_at IS NOT NULL), 0) AS refunded) q
           WHERE q.balance <> q.charged - q.refunded`,
  },
  {
    // Chaque période a son débit : vendeur −prix, subscription_revenue +prix, et l'émission promotionnelle de la période (user_promo +crédits, promo_issuance −crédits).
    code: "subscription_period_mismatch",
    sql: `SELECT p.id::text AS period_id, COALESCE(t.id::text, '') AS transaction_id, p.price_xof::text AS amount
            FROM subscription_periods p LEFT JOIN wallet_transactions t ON t.id = p.transaction_id
           WHERE t.id IS NULL OR NOT subscription_period_ledger_matches(t.id, 'subscription_charge', p.id, p.user_id, p.price_xof, p.promo_credits_xof)`,
  },
  {
    code: "subscription_charge_transaction_orphan",
    sql: `SELECT t.id::text AS transaction_id, t.reference AS reference
            FROM wallet_transactions t
           WHERE t.kind = 'subscription_charge'
             AND (SELECT count(*) FROM subscription_periods p WHERE p.transaction_id = t.id AND t.reference = 'subscription_charge:' || p.id::text) <> 1`,
  },
  {
    // Chaque période remboursée a son remboursement INTÉGRAL (et le reste promotionnel inutilisé annulé, le cas échéant).
    code: "subscription_refund_mismatch",
    sql: `SELECT p.id::text AS period_id, COALESCE(t.id::text, '') AS refund_transaction_id, p.price_xof::text AS amount
            FROM subscription_periods p LEFT JOIN wallet_transactions t ON t.id = p.refund_transaction_id
           WHERE (p.refunded_at IS NOT NULL OR p.refund_transaction_id IS NOT NULL) AND NOT (
                 p.refunded_at IS NOT NULL AND t.id IS NOT NULL
             AND subscription_period_ledger_matches(t.id, 'subscription_refund', p.id, p.user_id, p.price_xof,
                   COALESCE((SELECT max(g.expired_xof) FROM promo_grants g WHERE g.period_id = p.id AND g.expiry_transaction_id = t.id), 0)))`,
  },
  {
    code: "subscription_refund_transaction_orphan",
    sql: `SELECT t.id::text AS transaction_id, t.reference AS reference
            FROM wallet_transactions t
           WHERE t.kind = 'subscription_refund'
             AND (SELECT count(*) FROM subscription_periods p
                   WHERE p.refund_transaction_id = t.id AND p.refunded_at IS NOT NULL AND t.reference = 'subscription_refund:' || p.id::text) <> 1`,
  },
  {
    code: "promo_expiry_transaction_orphan",
    sql: `SELECT t.id::text AS transaction_id, t.reference AS reference
            FROM wallet_transactions t
           WHERE t.kind = 'promo_expiry'
             AND (SELECT count(*) FROM promo_grants g WHERE g.expiry_transaction_id = t.id AND t.reference = 'promo_expiry:' || g.id::text) <> 1`,
  },
  {
    // Un abonnement a la version, le début et la fin de sa DERNIÈRE période payée.
    code: "subscription_state_mismatch",
    sql: `SELECT s.id::text AS subscription_id, s.status AS status
            FROM subscriptions s
            LEFT JOIN LATERAL (SELECT * FROM subscription_periods p WHERE p.subscription_id = s.id ORDER BY p.number DESC LIMIT 1) lp ON TRUE
           WHERE lp.id IS NULL OR s.plan_version_id <> lp.plan_version_id OR s.current_period_start <> lp.starts_at OR s.current_period_end <> lp.ends_at`,
  },
  {
    code: "subscription_live_duplicate",
    sql: `SELECT user_id::text AS user_id, count(*)::text AS live FROM subscriptions WHERE status IN ('active', 'past_due') GROUP BY user_id HAVING count(*) > 1`,
  },
  {
    // Lot PAY1 : toute intention Sublymus a sa ligne de session (créée avec elle, dans la même transaction).
    code: "sublymus_checkout_missing",
    sql: `SELECT i.id::text AS intent_id, i.status AS status FROM payment_intents i
           WHERE i.provider = 'sublymus' AND NOT EXISTS (SELECT 1 FROM sublymus_checkouts c WHERE c.intent_id = i.id)`,
  },
  {
    // Lot PAY1 : la ligne de session appartient à une intention Sublymus et porte SA référence (`noma-topup-<identifiant>`).
    code: "sublymus_checkout_mismatch",
    sql: `SELECT c.intent_id::text AS intent_id, i.provider AS provider
            FROM sublymus_checkouts c JOIN payment_intents i ON i.id = c.intent_id
           WHERE i.provider <> 'sublymus' OR i.provider_reference <> c.external_reference OR c.external_reference <> 'noma-topup-' || i.id::text`,
  },
  {
    // Lot PAY1 : une intention Sublymus réussie a été créditée par un webhook authentifié (`wh_…`) ou par le rattrapage (`sublymus_poll_…`), jamais autrement (un retour du navigateur ne crédite pas).
    code: "sublymus_credit_origin_unknown",
    sql: `SELECT i.id::text AS intent_id, i.amount_xof::text AS amount
            FROM payment_intents i
           WHERE i.provider = 'sublymus' AND i.status = 'succeeded'
             AND NOT EXISTS (SELECT 1 FROM payment_events ev
                              WHERE ev.intent_id = i.id AND ev.provider = 'sublymus' AND ev.type = 'payment.succeeded' AND ev.outcome = 'applied'
                                AND (ev.provider_event_id LIKE 'wh\\_%' OR ev.provider_event_id LIKE 'sublymus\\_poll\\_%'))`,
  },
  {
    // Lot PAY1 : un événement Sublymus ne se rattache jamais à une intention d'un autre prestataire.
    code: "sublymus_event_provider_mismatch",
    sql: `SELECT ev.provider_event_id AS event_id, ev.intent_id::text AS intent_id
            FROM payment_events ev JOIN payment_intents i ON i.id = ev.intent_id
           WHERE ev.provider <> i.provider`,
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
  {
    // Lot PRO1 : une émission promotionnelle échue depuis plus de 15 minutes n'est pas encore expirée (le worker retarde) : le reste n'est pas dépensable (l'échéance prime),
    // mais l'expiration n'est pas encore écrite au grand livre.
    code: "promo_expiry_overdue",
    sql: `SELECT g.id::text AS grant_id, g.expires_at::text AS expires_at, promo_grant_remaining(g.id)::text AS remaining
            FROM promo_grants g WHERE g.expired_at IS NULL AND g.expires_at < clock_timestamp() - interval '15 minutes'
           ORDER BY g.expires_at, g.id`,
  },
  {
    // Lot PAY1 : anomalies de rapprochement à traiter (rien n'a été crédité) : voir la page /admin/paiements.
    code: "sublymus_anomaly_open",
    sql: `SELECT a.id::text AS anomaly_id, a.kind AS kind, a.origin AS origin, COALESCE(a.intent_id::text, '') AS intent_id,
                 COALESCE(a.expected_amount_xof::text, '') AS expected, COALESCE(a.received_amount_xof::text, '') AS received
            FROM sublymus_anomalies a WHERE a.resolved_at IS NULL ORDER BY a.created_at DESC, a.id DESC`,
  },
  {
    // Lot PAY1 : rattrapage échu depuis plus de 15 minutes (le worker retarde) : une recharge payée dont le webhook s'est perdu attend.
    code: "sublymus_catchup_overdue",
    sql: `SELECT c.intent_id::text AS intent_id, c.next_catchup_at::text AS next_at, c.catchup_attempts::text AS attempts
            FROM sublymus_checkouts c JOIN payment_intents i ON i.id = c.intent_id
           WHERE c.next_catchup_at IS NOT NULL AND i.status IN ('pending', 'expired', 'failed') AND c.next_catchup_at < clock_timestamp() - interval '15 minutes'
           ORDER BY c.next_catchup_at, c.intent_id`,
  },
  {
    // Lot PRO1 : un abonnement échu depuis plus d'une heure n'est pas encore traité (renouvellement, grâce ou fin) : le worker retarde.
    code: "subscription_overdue",
    sql: `SELECT s.id::text AS subscription_id, s.status AS status, s.current_period_end::text AS period_end
            FROM subscriptions s WHERE s.status IN ('active', 'past_due') AND s.current_period_end < clock_timestamp() - interval '1 hour'
           ORDER BY s.current_period_end, s.id`,
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
