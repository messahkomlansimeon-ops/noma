import "server-only";

import type { SqlExecutor } from "../../postgres/client";

/** Lien de paiement Wave enregistré pour une intention (null : pas de session, ou intention d'un autre prestataire). À n'appeler que pour le PROPRIÉTAIRE de l'intention. */
export async function readCheckoutUrl(executor: SqlExecutor, intentId: string): Promise<string | null> {
  const result = await executor.query<{ checkout_url: string | null }>("SELECT checkout_url FROM sublymus_checkouts WHERE intent_id = $1::uuid", [intentId]);
  return result.rows[0]?.checkout_url ?? null;
}
