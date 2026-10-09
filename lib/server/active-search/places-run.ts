import "server-only";

import type { Pool } from "pg";
import { withPostgresTransaction, type SqlExecutor } from "../postgres/client";
import { currentInstant } from "../subscriptions/time";
import { ACTIVE_SEARCH_ADMISSION_HOOK_LOCK_TIMEOUT_MS, ACTIVE_SEARCH_LOCK_TIMEOUT_MS } from "./config";
import { acceleratedLimit, acceleratedLimitForConnectors, type Environment } from "./availability";
import { lockAdmission, reconcileAcceleratedPlaces, type ReconcileResult } from "./places";
import { activeSearchSchemaPresent } from "./state";

/**
 * Points d'appel de la fonction unique d'attribution des places (places.ts) hors de l'achat (lot RA1-ter) :
 *  - `reconcilePlacesForCycle` : à chaque cycle de la collecte (collect.ts), AVANT la synchronisation des surveillances. Transaction propre, verrou global d'admission attendu au plus
 *    `ACTIVE_SEARCH_LOCK_TIMEOUT_MS` ; avec retrait des places au-delà de la capacité (les vrais connecteurs du cycle font autorité sur les quotas). Lève si le verrou n'est pas obtenu :
 *    l'appelant journalise un code et poursuit (les places restent celles du passage précédent, jamais plus que la capacité d'alors) ;
 *  - `reconcilePlacesAfterDemandChange` : depuis le catalogue, dans la transaction du changement, quand un besoin est RÉACTIVÉ, passe à « satisfait » ou change de clé produit. Ne lève JAMAIS
 *    (point de sauvegarde : le changement du besoin ne dépend jamais de l'accélération) ; sans retrait pour capacité (l'environnement de l'appelant ne fait pas autorité sur les quotas).
 */

/** Réattribue les places pour un cycle de collecte. `connectorCodes` : les connecteurs réellement disponibles pour ce cycle. */
export async function reconcilePlacesForCycle(pool: Pool, input: { connectorCodes: readonly string[]; now: Date }): Promise<ReconcileResult | null> {
  if (!(await activeSearchSchemaPresent(pool))) return null;
  // Essai à blanc d'abord, par des instructions uniques sur le pool (comme le reste de l'étape « collect » : aucune connexion dédiée, aucun verrou) : presque toujours, il n'y a rien à faire.
  const limit = await acceleratedLimitForConnectors(pool, input.connectorCodes);
  const probe = await reconcileAcceleratedPlaces(pool, { now: input.now, limit, trim: true, dryRun: true });
  if (probe.granted + probe.transferred + probe.released + probe.trimmed === 0) return probe;
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${ACTIVE_SEARCH_LOCK_TIMEOUT_MS}ms'`);
    await lockAdmission(client);
    // L'état est relu sous le verrou : un autre processus a pu attribuer ou libérer des places depuis l'essai à blanc.
    return reconcileAcceleratedPlaces(client, { now: input.now, limit: await acceleratedLimitForConnectors(client, input.connectorCodes), trim: true });
  }, pool);
}

/**
 * Le besoin `demandId` vient de changer (statut ou clé produit) dans la transaction `client`. S'il porte ou peut porter une place (une option en vigueur, ou une place à son nom), les places
 * sont réattribuées tout de suite ; sinon rien. Retourne le résultat, ou null si rien n'a été fait (ou si le verrou n'a pas été obtenu à temps : la synchronisation s'en chargera).
 */
export async function reconcilePlacesAfterDemandChange(client: SqlExecutor, demandId: string, env: Environment = process.env): Promise<ReconcileResult | null> {
  if (!(await activeSearchSchemaPresent(client))) return null;
  const concerned = await client.query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM active_search_purchases WHERE demand_id = $1::uuid AND status = 'active' AND refunded_at IS NULL)
                 OR EXISTS (SELECT 1 FROM active_search_places WHERE demand_id = $1::uuid)`,
    [demandId],
  );
  if (!concerned.rowCount) return null;
  await client.query("SAVEPOINT active_search_places");
  try {
    const previous = (await client.query<{ value: string }>("SELECT current_setting('lock_timeout') AS value")).rows[0].value;
    await client.query(`SET LOCAL lock_timeout = '${ACTIVE_SEARCH_ADMISSION_HOOK_LOCK_TIMEOUT_MS}ms'`);
    await lockAdmission(client);
    await client.query("SELECT set_config('lock_timeout', $1, true)", [previous]);
    const now = new Date(await currentInstant(client));
    const limit = await acceleratedLimit(client, env);
    const result = await reconcileAcceleratedPlaces(client, { now, limit, trim: false });
    await client.query("RELEASE SAVEPOINT active_search_places");
    return result;
  } catch {
    // Verrou non obtenu à temps ou panne passagère : le changement du besoin reste valable, la synchronisation des surveillances réattribuera les places au prochain cycle.
    await client.query("ROLLBACK TO SAVEPOINT active_search_places");
    await client.query("RELEASE SAVEPOINT active_search_places");
    return null;
  }
}
