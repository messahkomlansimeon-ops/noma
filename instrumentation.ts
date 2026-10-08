/**
 * Démarrage du serveur Next (lot SMS1) : Next appelle `register` UNE fois, et le serveur n'accepte aucune requête tant qu'elle n'a pas terminé. En production (NODE_ENV exactement
 * « production »), une configuration SMS incohérente interdit le démarrage (fail closed) : NOMA_SMS_PROVIDER=meno sans NOMA_SMS_API_KEY ou avec une clé de format invalide,
 * NOMA_SMS_PROVIDER=console, valeur inconnue, base d'API non https, NOMA_PUBLIC_URL absente. Hors production, rien n'est vérifié. Les messages nomment la variable, jamais sa valeur.
 * Le worker du matching applique la même règle (scripts/matching-worker.ts). Voir SMS.md.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertSmsProductionConfig } = await import("./lib/server/sms/config");
  assertSmsProductionConfig(process.env);
}
