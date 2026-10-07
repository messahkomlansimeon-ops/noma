import "server-only";

import type { SqlExecutor } from "../postgres/client";
import { ATTRIBUTION_WINDOW_DAYS } from "./config";

/**
 * Attribution d'une ouverture ou d'un contact à un boost (lot M1). Règle : le boost du journal d'exposition (`boost_exposures`, 0013) qui a servi
 * cette offre SPONSORISÉE à CE besoin dans les `ATTRIBUTION_WINDOW_DAYS` jours précédents ; sinon null (organique). Le boost n'a pas besoin
 * d'être encore actif : l'acheteur a vu l'annonce sponsorisée dans la fenêtre. Plusieurs boosts : le plus récent.
 *
 * Fenêtre : `first_served_at` (première apparition de la ligne du jour) est la borne SÛRE — l'apparition sponsorisée a eu lieu à ou après cet
 * instant, donc dans la fenêtre dès que `first_served_at` l'est. Conséquence (documentée dans MESURES.md) : une ligne dont la première
 * apparition du jour précède la borne n'est pas retenue, même si une apparition sponsorisée plus tardive du même jour la respecterait (sous-attribution
 * d'au plus une journée, jamais de sur-attribution).
 */
export async function readAttributedBoostId(
  executor: SqlExecutor,
  input: { offerId: string; demandId: string },
): Promise<string | null> {
  const result = await executor.query<{ boost_id: string }>(
    `SELECT e.boost_id
       FROM boost_exposures e
      WHERE e.offer_id = $1::uuid AND e.demand_id = $2::uuid
        AND e.sponsored_servings > 0
        AND e.first_served_at >= clock_timestamp() - make_interval(days => $3::int)
      ORDER BY e.last_served_at DESC, e.boost_id DESC
      LIMIT 1`,
    [input.offerId, input.demandId, ATTRIBUTION_WINDOW_DAYS],
  );
  return result.rows[0]?.boost_id ?? null;
}
