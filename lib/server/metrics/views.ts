import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction } from "../postgres/client";
import { readAttributedBoostId } from "./attribution";
import { METRICS_WRITE_TIMEOUT } from "./config";

/**
 * Journal des OUVERTURES de la fiche d'une annonce (lot M1). Une ligne de `offer_views` = les lectures réussies de la fiche d'UNE annonce par UN besoin
 * un jour UTC ; « ouverture » veut dire page SERVIE, pas lecture prouvée. Voir MESURES.md.
 */

export interface OfferViewInput {
  offerId: string;
  demandId: string;
  /** Propriétaire du besoin (l'acheteur) : vérifié par la requête elle-même. */
  viewerId: string;
}

/**
 * Enregistre une ouverture dans une transaction COURTE et plafonnée en durée (`METRICS_WRITE_TIMEOUT`) : lecture de l'attribution puis UN SEUL
 * `INSERT … ON CONFLICT (offer_id, demand_id, viewed_day) DO UPDATE` (views + 1 ; boosted_views + 1 si attribuée ; last_at maintenant). Le vendeur
 * d'une annonce n'est JAMAIS compté : rien n'est écrit si le viewer en est le propriétaire, ni si le besoin n'est pas celui du viewer. Renvoie vrai si
 * une ouverture a été écrite. L'appelant attrape toute erreur : l'enregistrement ne doit JAMAIS casser la lecture de la fiche.
 */
export async function recordOfferView(pool: Pool, input: OfferViewInput): Promise<boolean> {
  const targetPool = requireTransactionPool(pool);
  const offerId = requireUuid(input.offerId, "offerId").toLowerCase();
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  const viewerId = requireUuid(input.viewerId, "viewerId").toLowerCase();
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${METRICS_WRITE_TIMEOUT}'`);
    const boostId = await readAttributedBoostId(client, { offerId, demandId });
    const written = await client.query(
      `INSERT INTO offer_views (offer_id, demand_id, viewed_day, viewer_id, boost_id, views, boosted_views, first_at, last_at)
       SELECT o.id, d.id, (clock_timestamp() AT TIME ZONE 'UTC')::date, d.owner_id, $4::uuid, 1,
              CASE WHEN $4::uuid IS NULL THEN 0 ELSE 1 END, clock_timestamp(), clock_timestamp()
         FROM offers o, demands d
        WHERE o.id = $1::uuid AND d.id = $2::uuid AND d.owner_id = $3::uuid AND o.owner_id <> d.owner_id
       ON CONFLICT (offer_id, demand_id, viewed_day) DO UPDATE SET
         views = offer_views.views + 1,
         boosted_views = offer_views.boosted_views + EXCLUDED.boosted_views,
         boost_id = COALESCE(EXCLUDED.boost_id, offer_views.boost_id),
         last_at = clock_timestamp()`,
      [offerId, demandId, viewerId, boostId],
    );
    return (written.rowCount ?? 0) > 0;
  }, targetPool);
}
