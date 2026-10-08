import { runCheckoutTest } from "../lib/server/wallet/sublymus/commands";

/**
 * COMMANDE DU FONDATEUR : ouvre UNE session de paiement RÉELLE de faible montant (plafond 500 XOF, référence noma-test-<horodatage>) et affiche le lien Wave. Usage :
 *   npm run wallet:provider-checkout-test -- --amount 100 --confirm-real-checkout
 * REFUSE de s'exécuter sans --confirm-real-checkout (avant tout appel réseau). Ne crédite rien dans noma et ne touche pas sa base. Variables lues dans l'ENVIRONNEMENT de la
 * commande : WAVE_API_KEY, NOMA_SUBLYMUS_MANAGER_ID, NOMA_SUBLYMUS_WALLET_ID, NOMA_PUBLIC_URL (https), NOMA_SUBLYMUS_BASE_URL (défaut : le vrai service). N'est lancée que par le
 * fondateur : les essais l'exécutent contre une FAUSSE API locale. Voir PAIEMENT-WAVE.md.
 */
runCheckoutTest({ env: process.env, out: (line) => console.log(line), err: (line) => console.error(line) }, process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error("Erreur inattendue.");
    process.exitCode = 1;
  },
);
