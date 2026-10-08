import { runProviderCheck } from "../lib/server/wallet/sublymus/commands";

/**
 * COMMANDE DU FONDATEUR (lecture seule) : vérifie la clé Sublymus et lit le portefeuille. Usage : npm run wallet:provider-check
 * Variables lues dans l'ENVIRONNEMENT de la commande (jamais dans git) : WAVE_API_KEY, NOMA_SUBLYMUS_MANAGER_ID, et NOMA_SUBLYMUS_BASE_URL (défaut : le vrai service).
 * Affiche « clé valide, portefeuille X, solde Y ». N'écrit rien, ne touche pas la base de noma, n'affiche jamais la clé. Code de sortie : 0 succès, 1 échec, 2 usage.
 * N'est lancée que par le fondateur : les essais l'exécutent contre une FAUSSE API locale. Voir PAIEMENT-WAVE.md.
 */
runProviderCheck({ env: process.env, out: (line) => console.log(line), err: (line) => console.error(line) }).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error("Erreur inattendue.");
    process.exitCode = 1;
  },
);
