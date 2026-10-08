import "server-only";

import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { FAKE_PROVIDER } from "./config";
import { resolveFakePaymentConfig } from "./fake-provider";
import { createSublymusProvider, type SublymusProvider } from "./sublymus/provider";
import { PaymentConfigError, resolvePaymentSelection, type PaymentProviderKind } from "./sublymus/config";
import type { PaymentIntent, TopupProviderSpec } from "./topups";

/**
 * PORT « prestataire de paiement » (lot PAY1). Le prestataire fictif (`fake-provider.ts`) et le prestataire réel « sublymus » (`sublymus/provider.ts`) l'implémentent ; le
 * choix se fait par NOMA_PAYMENT_PROVIDER (fake | sublymus), défaut : fictif, jamais en production. Le grand livre ne connaît AUCUN prestataire : chaque événement de paiement,
 * quelle que soit son origine, passe par `applyProviderEventInTransaction` (topups.ts), la même écriture de partie double. Voir PAIEMENT-WAVE.md.
 */

export interface PreparedCheckout {
  /** Lien de paiement EXTERNE (https, Wave) vers lequel rediriger le navigateur ; null pour le prestataire fictif (page de paiement simulé) ou si la session n'a pas pu être ouverte. */
  checkoutUrl: string | null;
}

export interface PaymentProvider extends TopupProviderSpec {
  readonly kind: PaymentProviderKind;
  /** Texte affiché à l'écran pour dire par quel moyen on paie. */
  readonly label: string;
  /**
   * Prépare le paiement d'une intention EN ATTENTE déjà créée (hors de toute transaction SQL) : fictif, rien ; Sublymus, ouvre (ou retrouve) la session Wave. Une erreur du
   * prestataire se propage (`SublymusApiError`) : l'intention reste en attente et la même clé d'idempotence réessaiera.
   */
  prepareCheckout(input: { pool: Pool; intent: PaymentIntent }): Promise<PreparedCheckout>;
}

/** Prestataire fictif : aucune session externe, référence aléatoire, aucun rattrapage. */
export function createFakeProvider(): PaymentProvider {
  return {
    kind: FAKE_PROVIDER,
    label: "Paiement simulé",
    tracksCheckout: false,
    referenceFor: () => `fakepay_${randomBytes(12).toString("hex")}`,
    prepareCheckout: async () => ({ checkoutUrl: null }),
  };
}

type Environment = Record<string, string | undefined>;

export type ResolvedProvider =
  | { active: true; provider: PaymentProvider; sublymus: SublymusProvider | null }
  | { active: false; reason: "inactive" };

/**
 * Prestataire ACTIF selon l'environnement (relu à chaque requête). `inactive` : aucun prestataire utilisable (fictif hors développement ou sans son secret). Lève
 * `PaymentConfigError` si la configuration est refusée (à journaliser et à traiter comme « paiement indisponible »).
 */
export function resolvePaymentProvider(env: Environment, options: { fetch?: typeof fetch } = {}): ResolvedProvider {
  const selection = resolvePaymentSelection(env);
  if (selection.provider === "sublymus") {
    const sublymus = createSublymusProvider(selection.config, { fetch: options.fetch });
    return { active: true, provider: sublymus, sublymus };
  }
  return resolveFakePaymentConfig(env).enabled ? { active: true, provider: createFakeProvider(), sublymus: null } : { active: false, reason: "inactive" };
}

export { PaymentConfigError };
