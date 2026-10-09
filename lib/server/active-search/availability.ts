import "server-only";

import type { SqlExecutor } from "../postgres/client";
import { ALLOWED_SOURCE_TYPE } from "../external/config";
import { resolveConnectors } from "../external/registry";
import { readAcceleratedKeys } from "../external/watches";
import { acceleratedWatchLimit } from "./config";

/**
 * Disponibilité de la collecte externe et capacité de collecte accélérée (lot RA1-bis).
 *
 *  - `externalCollectionAvailable` : la collecte peut-elle fournir quelque chose ? Il faut au moins un CONNECTEUR résolu (`resolveConnectors` : aucun en production, aucun sans
 *    `NOMA_EXTERNAL_FAKE=1`) ET une SOURCE active qui lui correspond. Aujourd'hui, en production : jamais. `dev:try` active les connecteurs fictifs (démonstration) : l'option y est disponible.
 *  - `acceleratedCapacity` : combien de surveillances accélérées le quota des sources peut porter (`acceleratedWatchLimit` du plus petit quota des sources actives) et lesquelles ont déjà une
 *    PLACE (table `active_search_places`, lot RA1-ter : voir places.ts, qui maintient seul l'invariant « jamais plus de places que la capacité »). Une clé qui a déjà une place n'ajoute rien
 *    (la surveillance est partagée) : ce contrôle d'admission ne refuse qu'une NOUVELLE clé quand toutes les places sont prises.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

/** Quotas journaliers des sources ACTIVES qui ont un des connecteurs donnés (par leurs codes). */
async function sourceQuotas(executor: SqlExecutor, connectorCodes: readonly string[]): Promise<number[]> {
  if (connectorCodes.length === 0) return [];
  const rows = await executor.query<{ daily_quota: number }>(
    "SELECT daily_quota FROM external_sources WHERE enabled = TRUE AND type = $1 AND code = ANY($2::text[])",
    [ALLOWED_SOURCE_TYPE, [...connectorCodes]],
  );
  return rows.rows.map((row) => row.daily_quota);
}

async function activeSourceQuotas(executor: SqlExecutor, env: Environment): Promise<number[]> {
  return sourceQuotas(executor, resolveConnectors({ ...env }).map((connector) => connector.code));
}

/** Nombre de surveillances accélérées que les sources de ces connecteurs peuvent porter (0 si aucune source n'est active). */
export async function acceleratedLimitForConnectors(executor: SqlExecutor, connectorCodes: readonly string[]): Promise<number> {
  const quotas = await sourceQuotas(executor, connectorCodes);
  return quotas.length === 0 ? 0 : acceleratedWatchLimit(Math.min(...quotas));
}

/** Même capacité, pour les connecteurs que l'environnement donne (aucun en production ni sans `NOMA_EXTERNAL_FAKE=1`). */
export async function acceleratedLimit(executor: SqlExecutor, env: Environment): Promise<number> {
  return acceleratedLimitForConnectors(executor, resolveConnectors({ ...env }).map((connector) => connector.code));
}

export async function externalCollectionAvailable(executor: SqlExecutor, env: Environment): Promise<boolean> {
  return (await activeSourceQuotas(executor, env)).length > 0;
}

export interface AcceleratedCapacity {
  /** Surveillances accélérées que les quotas peuvent porter (0 si aucune source n'est active). */
  maxWatches: number;
  /** Clés produit qui ont déjà une place de collecte accélérée (porteur actif avec option en vigueur). */
  keys: string[];
}

export async function acceleratedCapacity(executor: SqlExecutor, env: Environment, now: Date): Promise<AcceleratedCapacity> {
  return { maxWatches: await acceleratedLimit(executor, env), keys: await readAcceleratedKeys(executor, now) };
}

/** Une clé qui a déjà une place est toujours admise (rien de plus à collecter) ; une NOUVELLE clé l'est seulement s'il reste une place. */
export function capacityAllows(capacity: AcceleratedCapacity, keyText: string): boolean {
  return capacity.keys.includes(keyText) || capacity.keys.length < capacity.maxWatches;
}
