import "server-only";

import type { Pool } from "pg";
import type { PaymentProvider, PreparedCheckout } from "../payment-provider";
import type { PaymentIntent } from "../topups";
import { SublymusApiError, SublymusClient, type SublymusCheckout, type SublymusIntentSummary } from "./client";
import { SUBLYMUS_PROVIDER, SUBLYMUS_REFERENCE_PREFIX, type SublymusConfig } from "./config";

/**
 * Prestataire « sublymus » (lot PAY1) : une recharge ouvre UNE session Wave chez Sublymus (`POST /v1/checkout/complex`), avec la référence `noma-topup-<intention>`, stable et
 * unique ; le lien reçu est enregistré puis le navigateur y est redirigé. Le crédit n'a lieu QUE sur webhook ou rattrapage authentifiés (webhook.ts, catchup.ts), jamais au
 * retour du navigateur. Voir PAIEMENT-WAVE.md.
 */

export interface SublymusProvider extends PaymentProvider {
  readonly config: SublymusConfig;
  readonly client: SublymusClient;
}

/** Adresses de retour du navigateur : HTTPS (hors poste local), construites sur NOMA_PUBLIC_URL. Affichage seulement : elles ne créditent jamais. */
export function returnUrls(publicUrl: string, intentId: string): { successUrl: string; errorUrl: string } {
  return {
    successUrl: `${publicUrl}/paiement-retour/${intentId}?resultat=succes`,
    errorUrl: `${publicUrl}/paiement-retour/${intentId}?resultat=echec`,
  };
}

export function createSublymusProvider(config: SublymusConfig, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): SublymusProvider {
  // Le vrai service n'est admis qu'en PRODUCTION (la configuration refuse déjà toute autre adresse que locale hors production).
  const client = new SublymusClient(config, { fetch: options.fetch, timeoutMs: options.timeoutMs, allowRealHost: config.production });

  /** Enregistre la session une seule fois (la première écriture gagne) ; renvoie le lien qui fait foi. */
  async function storeCheckout(pool: Pool, intent: PaymentIntent, checkout: Pick<SublymusCheckout, "paymentIntentId" | "checkoutUrl">): Promise<string> {
    try {
      const updated = await pool.query<{ checkout_url: string }>(
        `UPDATE sublymus_checkouts
            SET sublymus_intent_id = $2, checkout_url = $3, checkout_created_at = clock_timestamp(),
                -- Un webhook a pu terminer la session avant l'enregistrement du lien : le statut d'une session terminée ne régresse JAMAIS vers « WAVE_CREATED ».
                provider_status = CASE WHEN provider_status IN ('COMPLETED', 'FAILED') OR catchup_done_at IS NOT NULL THEN provider_status ELSE 'WAVE_CREATED' END
          WHERE intent_id = $1::uuid AND checkout_url IS NULL AND (sublymus_intent_id IS NULL OR sublymus_intent_id = $2)
          RETURNING checkout_url`,
        [intent.id, checkout.paymentIntentId, checkout.checkoutUrl],
      );
      if (updated.rows[0]) return updated.rows[0].checkout_url;
    } catch (error) {
      // Le même identifiant Sublymus pour une AUTRE intention : réponse incohérente, on ne l'enregistre pas.
      if ((error as { code?: string }).code === "23505") throw new SublymusApiError("invalid_response");
      throw error;
    }
    const existing = await pool.query<{ checkout_url: string | null }>("SELECT checkout_url FROM sublymus_checkouts WHERE intent_id = $1::uuid", [intent.id]);
    if (existing.rows[0]?.checkout_url) return existing.rows[0].checkout_url;
    throw new SublymusApiError("invalid_response");
  }

  /** La référence existe déjà chez Sublymus (409) : on retrouve la session en attente (même référence, même montant) si la recherche en donne le lien. */
  function adoptable(found: SublymusIntentSummary[], intent: PaymentIntent): SublymusIntentSummary | null {
    const exact = found.filter((entry) => entry.externalReference === intent.providerReference);
    if (exact.length !== 1) return null;
    const [entry] = exact;
    return entry.status === "WAVE_CREATED" && entry.amountXof === intent.amountXof && entry.currency === "XOF" && entry.checkoutUrl !== null ? entry : null;
  }

  return {
    kind: SUBLYMUS_PROVIDER,
    label: "Paiement par Wave",
    tracksCheckout: true,
    config,
    client,
    referenceFor: (intentId) => `${SUBLYMUS_REFERENCE_PREFIX}${intentId}`,
    async prepareCheckout({ pool, intent }): Promise<PreparedCheckout> {
      const row = await pool.query<{ checkout_url: string | null }>("SELECT checkout_url FROM sublymus_checkouts WHERE intent_id = $1::uuid", [intent.id]);
      if (row.rows[0]?.checkout_url) return { checkoutUrl: row.rows[0].checkout_url };
      // Une intention terminée ou échue n'ouvre aucune session : le client en demandera une neuve.
      if (intent.status !== "pending") return { checkoutUrl: null };
      const urls = returnUrls(config.publicUrl, intent.id);
      try {
        const checkout = await client.createCheckout({
          amountXof: intent.amountXof,
          externalReference: intent.providerReference,
          description: "Recharge du porte-monnaie noma",
          successUrl: urls.successUrl,
          errorUrl: urls.errorUrl,
          label: "Recharge noma",
        });
        return { checkoutUrl: await storeCheckout(pool, intent, checkout) };
      } catch (error) {
        if (!(error instanceof SublymusApiError) || error.kind !== "conflict") throw error;
        const entry = adoptable(await client.findIntents(intent.providerReference), intent);
        if (entry === null || entry.checkoutUrl === null) throw error;
        return { checkoutUrl: await storeCheckout(pool, intent, { paymentIntentId: entry.id, checkoutUrl: entry.checkoutUrl }) };
      }
    },
  };
}
