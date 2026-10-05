/**
 * En-têtes d'un reverse proxy de confiance simulés par `e2e:ui` : ils ne doivent JAMAIS quitter l'origine du serveur
 * de test (le navigateur peut charger des ressources d'autres origines ; le secret ne doit pas leur être envoyé).
 * Fonctions pures, testées dans tests/client/e2e-proxy-headers.test.ts.
 */

/** Vrai si `requestUrl` a exactement la même origine (schéma, hôte, port) que `baseUrl` ; faux si l'une est illisible. */
export function isServerOrigin(requestUrl: string, baseUrl: string): boolean {
  try {
    return new URL(requestUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** Copie des en-têtes, avec les en-têtes du proxy ajoutés (en remplaçant tout homonyme) seulement pour l'origine du serveur. */
export function proxyHeadersFor(
  requestUrl: string,
  baseUrl: string,
  headers: Record<string, string>,
  proxyHeaders: Record<string, string>,
): Record<string, string> {
  const result = { ...headers };
  if (!isServerOrigin(requestUrl, baseUrl)) return result;
  const replaced = new Set(Object.keys(proxyHeaders).map((name) => name.toLowerCase()));
  for (const name of Object.keys(result)) if (replaced.has(name.toLowerCase())) delete result[name];
  return { ...result, ...proxyHeaders };
}
