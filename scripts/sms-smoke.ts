import { closePostgresPool } from "../lib/server/postgres/client";
import { runSmoke } from "../lib/server/sms/smoke";

/**
 * `npm run sms:smoke -- --to +225XXXXXXXXXX --confirm-real-send` : envoi RÉEL d'un SMS de test (15 F CFA), réservé au fondateur. Voir SMS.md et lib/server/sms/smoke.ts.
 * Aucune migration, aucune écriture hors du journal `sms_sends`.
 */
runSmoke(process.argv.slice(2), process.env)
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    // Ni message ni charge utile : ils pourraient contenir l'hôte ou des identifiants.
    console.error("sms:smoke erreur inattendue.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgresPool();
  });
