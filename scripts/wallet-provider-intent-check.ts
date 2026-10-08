import { runIntentCheck } from "../lib/server/wallet/sublymus/commands";

/**
 * COMMANDE DU FONDATEUR (lecture seule) : relit chez Sublymus la session d'une référence APRÈS paiement et affiche son statut, son montant et le payerId (masqué en partie), en disant
 * s'il correspond au gestionnaire. Usage :
 *   npm run wallet:provider-intent-check -- --reference noma-test-<horodatage>
 * Un seul GET /v1/intents?external_reference=. Variables lues dans l'ENVIRONNEMENT de la commande : WAVE_API_KEY, NOMA_SUBLYMUS_MANAGER_ID, NOMA_SUBLYMUS_BASE_URL (défaut : le vrai
 * service). N'écrit rien, ne touche pas la base de noma, n'affiche jamais la clé. Code de sortie : 0 session trouvée, 1 échec ou introuvable, 2 usage. N'est lancée que par le fondateur :
 * les essais l'exécutent contre une FAUSSE API locale. Voir PAIEMENT-WAVE.md.
 */
runIntentCheck({ env: process.env, out: (line) => console.log(line), err: (line) => console.error(line) }, process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error("Erreur inattendue.");
    process.exitCode = 1;
  },
);
