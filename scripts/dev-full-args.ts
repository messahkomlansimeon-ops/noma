/**
 * Arguments de `next dev` lancé par `dev:full` et `dev:try` (lot FIN1).
 *
 * `next dev` écoute par défaut sur TOUTES les interfaces (0.0.0.0, voir `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`, option `-H` / `--hostname`) : sur un réseau
 * partagé, n'importe qui joignait directement le serveur (sans passer par le relais de confiance qui ajoute et nettoie les en-têtes). Il n'écoute donc plus QUE sur la boucle locale
 * (127.0.0.1) : le navigateur passe par le relais (http://localhost:3212, lui-même sur 127.0.0.1 seulement).
 * `NOMA_DEV_NEXT_HOSTNAME` ne sert qu'à `dev:full` lancé à la main (par exemple `0.0.0.0` pour essayer depuis un téléphone du même réseau, à vos risques) : `dev:try` le fixe à 127.0.0.1
 * quoi que dise l'environnement.
 */

export const NEXT_DEV_HOSTNAME = "127.0.0.1";

const HOSTNAME = /^[A-Za-z0-9.:\-\[\]]{1,253}$/;

/** Nom d'hôte demandé pour `next dev` : celui de `NOMA_DEV_NEXT_HOSTNAME` s'il est lisible, sinon 127.0.0.1. */
export function nextDevHostname(env: Record<string, string | undefined>): string {
  const wanted = env.NOMA_DEV_NEXT_HOSTNAME?.trim();
  return wanted && HOSTNAME.test(wanted) ? wanted : NEXT_DEV_HOSTNAME;
}

/** Les arguments de `next dev` (le port vient de la variable PORT). */
export function nextDevArgs(env: Record<string, string | undefined>): string[] {
  return ["dev", "-H", nextDevHostname(env)];
}
