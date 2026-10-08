import "server-only";

import type { Pool } from "pg";
import { parseAnalysis } from "./analysis";
import { EXTERNAL_GROUP_LOCK_NAMESPACE } from "./config";
import { isDuplicatePair, type DuplicateCandidate } from "./duplicates";
import type { WatchRow } from "./types";

/**
 * Regroupement des doublons entre sources (lot EXT1). Exécuté APRÈS le stockage de TOUTES les sources interrogées pour une surveillance : deux sources stockées en parallèle ne
 * se voient pas l'une l'autre avant leur validation, donc le regroupement ne peut pas se faire pendant le stockage d'une seule.
 *
 * Toutes les annonces non « gone » trouvées par la surveillance sont comparées deux à deux (`isDuplicatePair` : sources différentes, même adresse OU prix à 2 % près + mêmes nombres +
 * titre proche). Les paires forment des composantes (union) ; chaque composante de plus d'une annonce reçoit UN groupe (le plus petit identifiant des groupes déjà posés, sinon un
 * nouveau). Rien n'est supprimé ni modifié d'autre que `duplicate_group_id` : les annonces et leurs observations d'origine restent. Un groupe posé n'est jamais défait ici ; la
 * lecture revérifie chaque membre (`collapseDuplicates`). Un verrou consultatif court sérialise deux regroupements simultanés (une annonce peut appartenir à deux surveillances), et
 * TOUTES les annonces à modifier sont verrouillées d'un coup, triées par identifiant (même ordre que l'écriture d'une réponse de source : aucun interblocage).
 */

interface GroupRow {
  id: string;
  source_code: string;
  price_amount: string | null;
  price_currency: string | null;
  canonical_url: string;
  duplicate_group_id: string | null;
  analysis: unknown;
}

/** Composantes connexes d'un graphe de paires (union-find). */
export function connectedComponents(size: number, pairs: ReadonlyArray<readonly [number, number]>): number[][] {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (node: number): number => {
    let root = node;
    while (parent[root] !== root) root = parent[root];
    let cursor = node;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  for (const [left, right] of pairs) {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  const components = new Map<number, number[]>();
  for (let index = 0; index < size; index++) {
    const root = find(index);
    components.set(root, [...(components.get(root) ?? []), index]);
  }
  return [...components.values()];
}

/** Renvoie le nombre d'annonces nouvellement rattachées à un groupe. */
export async function groupWatchDuplicates(pool: Pool, watch: Pick<WatchRow, "id" | "product_key">): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int, 1)", [EXTERNAL_GROUP_LOCK_NAMESPACE]);
    const rows = await client.query<GroupRow>(
      `SELECT l.id, l.source_code, l.price_amount::text AS price_amount, l.price_currency, l.canonical_url, l.duplicate_group_id, a.analysis
         FROM source_observations o
         JOIN external_listings l ON l.id = o.listing_id
         JOIN external_analyses a ON a.content_hash = l.content_hash
        WHERE o.watch_id = $1::uuid AND l.availability_status <> 'gone'
        ORDER BY l.id`,
      [watch.id],
    );
    const entries: Array<{ row: GroupRow; candidate: DuplicateCandidate }> = [];
    for (const row of rows.rows) {
      const analysis = parseAnalysis(row.analysis);
      if (analysis === null) continue;
      entries.push({
        row,
        candidate: {
          sourceCode: row.source_code, priceAmount: row.price_amount === null ? null : Number(row.price_amount), priceCurrency: row.price_currency, tokens: analysis.tokens, url: row.canonical_url,
        },
      });
    }
    const pairs: Array<[number, number]> = [];
    for (let left = 0; left < entries.length; left++) {
      for (let right = left + 1; right < entries.length; right++) {
        if (isDuplicatePair(entries[left].candidate, entries[right].candidate)) pairs.push([left, right]);
      }
    }
    const plans: Array<{ members: GroupRow[]; existingGroups: string[] }> = [];
    for (const component of connectedComponents(entries.length, pairs)) {
      if (component.length < 2) continue;
      const members = component.map((index) => entries[index].row);
      const existingGroups = [...new Set(members.map((row) => row.duplicate_group_id).filter((group): group is string => group !== null))].sort();
      plans.push({ members, existingGroups });
    }
    if (plans.length > 0) {
      // Tous les verrous d'un coup, dans l'ordre des identifiants (jamais composante par composante).
      await client.query("SELECT id FROM external_listings WHERE id = ANY($1::uuid[]) OR duplicate_group_id = ANY($2::uuid[]) ORDER BY id FOR UPDATE", [
        plans.flatMap((plan) => plan.members.map((row) => row.id)), plans.flatMap((plan) => plan.existingGroups),
      ]);
    }
    let attached = 0;
    for (const { members, existingGroups } of plans) {
      let groupId: string;
      if (existingGroups.length > 0) {
        groupId = existingGroups[0];
      } else {
        const created = await client.query<{ id: string }>("INSERT INTO duplicate_groups (product_key) VALUES ($1) RETURNING id", [watch.product_key]);
        groupId = created.rows[0].id;
      }
      const changing = members.filter((row) => row.duplicate_group_id !== groupId);
      if (changing.length === 0 && existingGroups.length === 1) continue;
      await client.query("UPDATE external_listings SET duplicate_group_id = $1::uuid WHERE id = ANY($2::uuid[]) OR duplicate_group_id = ANY($3::uuid[])", [
        groupId, members.map((row) => row.id), existingGroups,
      ]);
      attached += changing.length;
    }
    await client.query("DELETE FROM duplicate_groups g WHERE NOT EXISTS (SELECT 1 FROM external_listings l WHERE l.duplicate_group_id = g.id)");
    await client.query("COMMIT");
    return attached;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
