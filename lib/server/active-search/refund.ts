import "server-only";

import type { Pool } from "pg";
import { CatalogValidationError } from "../catalog/errors";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction } from "../postgres/client";
import { currentInstant } from "../subscriptions/time";
import { postWalletTransaction } from "../wallet/ledger";
import { ACTIVE_SEARCH_LOCK_TIMEOUT_MS, ACTIVE_SEARCH_USER_LOCK_NAMESPACE } from "./config";
import { ActiveSearchError } from "./errors";

/**
 * REMBOURSEMENT INTÉGRAL d'un achat de recherche active (administration, aucune route HTTP ; commande `active-search:refund`). Même mécanisme que les remboursements de boost et
 * d'abonnement : une transaction du grand livre `search_refund` (revenus de la recherche active −prix, acheteur +prix en crédits PAYÉS), référence `search_refund:<id>` (UNIQUE :
 * un seul remboursement par achat, même en cas de deux appels simultanés). Aucun prorata, aucun remboursement automatique. Le plus RÉCENT achat d'un besoin se rembourse d'abord
 * (`later_period_exists` sinon) : ainsi la chaîne en vigueur ne garde jamais un trou. Si la période est encore en vigueur, elle s'arrête (`stop_reason = refunded`) ; le suivi revient au
 * plafond de 90 jours et la collecte accélérée cesse au prochain entretien (la couverture ignore les périodes remboursées dès maintenant).
 * Ordre des verrous : utilisateur → ligne du besoin → achat → comptes du grand livre (comme l'achat).
 */

const REASON_CODE = /^[a-z_]{1,40}$/;

export interface ActiveSearchRefundResult {
  purchaseId: string;
  demandId: string;
  refundedAmount: bigint;
  /** La période était en vigueur : elle est arrêtée par ce remboursement. */
  stopped: boolean;
  /** Crédits payés de l'acheteur après le remboursement. */
  balance: bigint;
}

export async function refundActiveSearchPurchase(input: { pool: Pool; purchaseId: string; reasonCode: string; now?: Date }): Promise<ActiveSearchRefundResult> {
  const pool = requireTransactionPool(input.pool);
  const purchaseId = requireUuid(input.purchaseId, "purchaseId").toLowerCase();
  if (typeof input.reasonCode !== "string" || !REASON_CODE.test(input.reasonCode)) {
    throw new CatalogValidationError("reasonCode doit être un code en minuscules et tirets bas (1 à 40 caractères).");
  }
  const reasonCode = input.reasonCode;
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${ACTIVE_SEARCH_LOCK_TIMEOUT_MS}ms'`);
    const owner = await client.query<{ user_id: string; demand_id: string }>("SELECT user_id, demand_id FROM active_search_purchases WHERE id = $1::uuid", [purchaseId]);
    if (!owner.rows[0]) throw new ActiveSearchError("purchase_not_found");
    const { user_id: userId, demand_id: demandId } = owner.rows[0];
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [ACTIVE_SEARCH_USER_LOCK_NAMESPACE, userId]);
    await client.query("SELECT 1 FROM demands WHERE id = $1::uuid FOR UPDATE", [demandId]);
    const now = await currentInstant(client, input.now);
    const found = await client.query<{ number: number; price: string; status: string; refunded: boolean }>(
      "SELECT number, price_xof::text AS price, status, (refunded_at IS NOT NULL) AS refunded FROM active_search_purchases WHERE id = $1::uuid FOR UPDATE",
      [purchaseId],
    );
    const purchase = found.rows[0];
    if (!purchase) throw new ActiveSearchError("purchase_not_found");
    if (purchase.refunded) throw new ActiveSearchError("already_refunded");
    const later = await client.query(
      "SELECT 1 FROM active_search_purchases WHERE demand_id = $1::uuid AND number > $2::int AND refunded_at IS NULL LIMIT 1",
      [demandId, purchase.number],
    );
    if (later.rowCount) throw new ActiveSearchError("later_period_exists");
    const price = BigInt(purchase.price);
    const posted = await postWalletTransaction(client, {
      kind: "search_refund",
      reference: `search_refund:${purchaseId}`,
      metadata: { activeSearchId: purchaseId, reasonCode },
      entries: [
        { account: { kind: "active_search_revenue" }, amount: -price },
        { account: { kind: "user", ownerId: userId }, amount: price },
      ],
    });
    // Un état final reste final (déclencheur) : une période encore en vigueur devient `stopped` ; une période déjà terminée ou arrêtée garde son statut et reçoit la date de remboursement.
    const stopped = purchase.status === "active";
    const updated = stopped
      ? await client.query(
          `UPDATE active_search_purchases SET status = 'stopped', stopped_at = $2::timestamptz, stop_reason = 'refunded', refunded_at = $2::timestamptz, refund_transaction_id = $3::uuid
            WHERE id = $1::uuid AND refunded_at IS NULL`,
          [purchaseId, now, posted.id],
        )
      : await client.query(
          "UPDATE active_search_purchases SET refunded_at = $2::timestamptz, refund_transaction_id = $3::uuid WHERE id = $1::uuid AND refunded_at IS NULL",
          [purchaseId, now, posted.id],
        );
    if (!updated.rowCount) throw new ActiveSearchError("already_refunded");
    const balance = await client.query<{ balance: string }>("SELECT balance::text AS balance FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1::uuid", [userId]);
    return { purchaseId, demandId, refundedAmount: price, stopped, balance: BigInt(balance.rows[0]?.balance ?? "0") };
  }, pool);
}
