import "server-only";

import type { Pool, PoolClient } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import {
  MATCHING_CURRENT_CLOCK_CTE,
  MATCHING_FRESHNESS_FROM,
  buildMatchingFreshnessPredicate,
  resolveMatchingFreshnessParams,
} from "../matching/persistence";
import { withPostgresTransaction } from "../postgres/client";
import { readAttributedBoostId } from "./attribution";
import { CONTACT_DAILY_SELLER_LIMIT, CONTACT_LOCK_NAMESPACE, CONTACT_TRANSACTION_TIMEOUT } from "./config";
import { MetricsError } from "./errors";

/**
 * Contact du vendeur (lot M1) : l'acheteur, depuis la fiche d'une annonce de SES correspondances, obtient le numéro VÉRIFIÉ du vendeur. Un contact =
 * une ligne de `offer_contacts` (annonce, besoin) : premier contact, nombre de révélations, attribution au boost AU PREMIER CONTACT. Le vendeur
 * ne voit qu'un compteur, jamais l'identité de l'acheteur. Voir MESURES.md.
 */

export interface OfferContactInput {
  pool: Pool;
  /** L'acheteur : propriétaire du besoin. */
  viewerId: string;
  demandId: string;
  offerId: string;
}

export interface OfferContactResult {
  /** Numéro vérifié du vendeur, E.164. */
  phone: string;
  /** Vrai la première fois que CE besoin contacte CETTE annonce. */
  firstContact: boolean;
}

export interface OfferContactLinks {
  telUrl: string;
  whatsappUrl: string;
}

const E164 = /^\+[1-9][0-9]{1,14}$/;

/** Liens `tel:` et `https://wa.me/<chiffres>` d'un numéro E.164 (lève si le numéro n'est pas E.164). */
export function buildContactLinks(phone: string): OfferContactLinks {
  if (!E164.test(phone)) throw new RangeError("Numéro non conforme à E.164.");
  return { telUrl: `tel:${phone}`, whatsappUrl: `https://wa.me/${phone.slice(1)}` };
}

type Access = { ok: true; sellerId: string } | { ok: false; reason: "not_found" | "offer_not_available" };

/**
 * Accès au contact : MÊME prédicat que la lecture des correspondances (`buildMatchingFreshnessPredicate`, correspondance confirmée et fraîche de CE
 * besoin, propriétaire du besoin = l'acheteur). Si ce prédicat échoue parce que l'annonce n'est plus en ligne (en pause, archivée) ou plus disponible
 * (vendue), ET que cet acheteur avait cette annonce parmi ses correspondances confirmées (`h`), le refus est `offer_not_available` (409) : l'acheteur la
 * connaissait déjà. Dans tous les autres cas (annonce jamais correspondante, besoin d'un autre, besoin clos, vendeur lui-même, évaluation périmée d'une
 * annonce restée en ligne) : `not_found` (404 indiscernable).
 */
async function readAccess(client: PoolClient, input: { viewerId: string; demandId: string; offerId: string }): Promise<Access> {
  const freshness = buildMatchingFreshnessPredicate(resolveMatchingFreshnessParams(), 4);
  const fresh = await client.query<{ seller_id: string }>(
    `WITH ${MATCHING_CURRENT_CLOCK_CTE}
     SELECT o.owner_id AS seller_id
       FROM ${MATCHING_FRESHNESS_FROM}
      WHERE e.demand_id = $1::uuid AND e.offer_id = $2::uuid AND d.owner_id = $3::uuid
        AND e.is_confirmed_match = TRUE
        AND ${freshness.conditions.join("\n        AND ")}
      LIMIT 1`,
    [input.demandId, input.offerId, input.viewerId, ...freshness.values],
  );
  if (fresh.rows[0]) return { ok: true, sellerId: fresh.rows[0].seller_id };
  const gone = await client.query(
    `SELECT 1
       FROM demands d
       JOIN offers o ON o.id = $2::uuid AND o.owner_id <> d.owner_id
      WHERE d.id = $1::uuid AND d.owner_id = $3::uuid AND d.status = 'active'
        AND NOT (o.status = 'published' AND o.availability_status IS DISTINCT FROM 'unavailable')
        AND EXISTS (SELECT 1 FROM matching_evaluations h
                     WHERE h.demand_id = d.id AND h.offer_id = o.id AND h.is_confirmed_match = TRUE)`,
    [input.demandId, input.offerId, input.viewerId],
  );
  return gone.rowCount ? { ok: false, reason: "offer_not_available" } : { ok: false, reason: "not_found" };
}

/**
 * Révèle le numéro vérifié du vendeur. Une transaction courte, sérialisée par acheteur (verrou consultatif : la limite quotidienne est exacte) :
 *  - `resource_not_found` : accès refusé (voir `readAccess`), rien n'est écrit ;
 *  - `offer_not_available` : annonce en pause, retirée ou vendue, rien n'est révélé ni écrit ;
 *  - `contact_unavailable` : le vendeur n'a pas de numéro vérifié, rien n'est écrit ;
 *  - `rate_limited` : l'acheteur a déjà révélé `CONTACT_DAILY_SELLER_LIMIT` vendeurs DISTINCTS pour la première fois aujourd'hui (jour UTC) ; un vendeur
 *    déjà révélé (CETTE annonce et ce besoin, ou n'importe quelle annonce de ce vendeur pour cet acheteur) l'est de nouveau sans compter ;
 *  - sinon : numéro renvoyé, `reveals` + 1 ; premier contact : ligne écrite avec l'attribution au boost.
 */
export async function revealOfferContact(input: OfferContactInput): Promise<OfferContactResult> {
  const pool = requireTransactionPool(input.pool);
  const viewerId = requireUuid(input.viewerId, "viewerId").toLowerCase();
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${CONTACT_TRANSACTION_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [CONTACT_LOCK_NAMESPACE, viewerId]);

    const access = await readAccess(client, { viewerId, demandId, offerId });
    if (!access.ok) throw new MetricsError(access.reason === "offer_not_available" ? "offer_not_available" : "resource_not_found");

    const phone = await client.query<{ phone_e164: string }>(
      "SELECT phone_e164 FROM phone_identities WHERE user_id = $1::uuid AND verified_at IS NOT NULL",
      [access.sellerId],
    );
    if (!phone.rows[0]) throw new MetricsError("contact_unavailable");

    const again = await client.query(
      `UPDATE offer_contacts SET reveals = reveals + 1, last_contact_at = clock_timestamp()
        WHERE offer_id = $1::uuid AND demand_id = $2::uuid RETURNING reveals`,
      [offerId, demandId],
    );
    if (again.rowCount) return { phone: phone.rows[0].phone_e164, firstContact: false };

    const known = await client.query(
      `SELECT 1 FROM offer_contacts c JOIN offers o ON o.id = c.offer_id
        WHERE c.viewer_id = $1::uuid AND o.owner_id = $2::uuid LIMIT 1`,
      [viewerId, access.sellerId],
    );
    if (!known.rowCount) {
      const today = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (
           SELECT o.owner_id
             FROM offer_contacts c JOIN offers o ON o.id = c.offer_id
            WHERE c.viewer_id = $1::uuid
            GROUP BY o.owner_id
           HAVING min(c.first_contact_at) >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
         ) revealed_today`,
        [viewerId],
      );
      if (today.rows[0].n >= CONTACT_DAILY_SELLER_LIMIT) throw new MetricsError("rate_limited");
    }

    const boostId = await readAttributedBoostId(client, { offerId, demandId });
    await client.query(
      `INSERT INTO offer_contacts (offer_id, demand_id, viewer_id, boost_id, reveals, first_contact_at, last_contact_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, clock_timestamp(), clock_timestamp())`,
      [offerId, demandId, viewerId, boostId],
    );
    return { phone: phone.rows[0].phone_e164, firstContact: true };
  }, pool);
}
