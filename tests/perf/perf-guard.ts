/**
 * Garde de la commande de mesure `perf:boost` : elle écrit des centaines de milliers de lignes, donc elle ne s'exécute que sur une base JETABLE
 * dont le nom commence par `noma_perf_` (ni noma_dev, ni noma_test, ni noma_e2e, ni noma_essai…) et qui est sur CE poste. Refus AVANT toute
 * connexion ; le motif ne contient jamais l'adresse.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PERF_DATABASE_NAME = /^noma_perf_[a-z0-9_]{1,40}$/;

export function requirePerfDatabaseUrl(value: string | undefined): string {
  const text = value?.trim();
  if (!text) throw new Error("perf:boost : DATABASE_URL est obligatoire (base jetable noma_perf_*).");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("perf:boost : DATABASE_URL n'est pas une adresse valide.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("perf:boost : DATABASE_URL doit utiliser postgres:// ou postgresql://.");
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) throw new Error("perf:boost : la base doit être sur ce poste (localhost ou 127.0.0.1).");
  let name: string;
  try {
    name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("perf:boost : nom de base illisible.");
  }
  if (!PERF_DATABASE_NAME.test(name)) throw new Error("perf:boost : le nom de la base doit commencer par « noma_perf_ » (base jetable) ; toute autre base est refusée.");
  return text;
}
