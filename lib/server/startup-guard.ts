import { assertSmsProductionConfig, type Environment } from "./sms/config";
import { assertPaymentConfiguration } from "./wallet/sublymus/config";

/**
 * Contrôles de configuration au démarrage du serveur (appelés par `register` de instrumentation.ts) : SMS (lot SMS1) puis paiement (lot PAY1).
 *
 * Hors production : l'exception du contrôle est relancée telle quelle (affichée par `next dev`).
 * En production : le message FIXE du contrôle (il nomme les variables à corriger, JAMAIS leurs valeurs) est journalisé, puis le processus est TERMINÉ avec le code 1.
 * Raison : sous `next start`, une exception levée par `register` laissait le processus vivant, qui répondait 500 à tout au lieu de tomber (constat d'audit commun SMS et paiement).
 * Si `exit` revenait malgré tout (essais), l'exception est relancée : le démarrage n'est jamais réputé réussi après un refus.
 */
export interface StartupIo {
  log: (message: string) => void;
  exit: (code: number) => unknown;
}

const defaultIo: StartupIo = {
  log: (message) => console.error(message),
  exit: (code) => process.exit(code),
};

const CHECKS: ReadonlyArray<readonly [label: string, run: (env: Environment) => unknown]> = [
  ["SMS", assertSmsProductionConfig],
  ["paiement", assertPaymentConfiguration],
];

export function runStartupChecks(env: Environment = process.env, io: StartupIo = defaultIo): void {
  for (const [label, run] of CHECKS) {
    try {
      run(env);
    } catch (error) {
      if (env.NODE_ENV !== "production") throw error;
      io.log(`Démarrage refusé : configuration ${label} invalide en production : ${error instanceof Error ? error.message : "cause inconnue"}`);
      io.exit(1);
      throw error;
    }
  }
}
