/**
 * Démarrage du serveur Next (lots SMS1 et PAY1) : Next appelle `register` UNE fois, et le serveur n'accepte aucune requête tant qu'elle n'a pas terminé.
 * Deux contrôles de configuration, dans cet ordre (voir lib/server/startup-guard.ts) :
 *  - SMS (lot SMS1) : en production (NODE_ENV exactement « production »), une configuration SMS incohérente interdit le démarrage (NOMA_SMS_PROVIDER=meno sans NOMA_SMS_API_KEY ou avec
 *    une clé de format invalide, NOMA_SMS_PROVIDER=console, valeur inconnue, base d'API non https, NOMA_PUBLIC_URL absente) ; hors production, rien n'est vérifié ;
 *  - paiement (lot PAY1) : NOMA_PAYMENT_PROVIDER=sublymus sans ses variables, ou prestataire fictif demandé en production, interdit le démarrage.
 * Les messages nomment la variable, jamais sa valeur. Le worker du matching applique les mêmes règles (scripts/matching-worker.ts).
 * Correctif transversal : en production, une exception levée par `register` laisse le processus `next start` VIVANT, qui répond alors 500 à tout (constat d'audit). Le contrôle
 * journalise donc le message fixe puis TERMINE LE PROCESSUS (code 78, EX_CONFIG) : un déploiement mal configuré ne sert aucune requête et le superviseur (systemd) le voit tomber.
 * Hors production, l'exception est relancée telle quelle (affichée par `next dev`). Voir DEPLOIEMENT.md, SMS.md et PAIEMENT-WAVE.md.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupChecks } = await import("./lib/server/startup-guard");
  runStartupChecks(process.env);
}
