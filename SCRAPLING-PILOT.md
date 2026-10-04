# Pilote Scrapling — extraction CoinAfrique

Date : 3 octobre 2026  
Statut : **candidat pour un essai réel limité ; Cheerio reste actif en production**

## Périmètre

Le pilote compare uniquement l'extraction d'un HTML déjà téléchargé par Noma. Il ne remplace ni `safeFetch`, ni le cache, ni le classement, ni les connecteurs actifs. Aucun appel IA, proxy, navigateur ou accès à CoinAfrique n'a été effectué.

Versions mesurées : Node 26.8.1, Python 3.14.7, Scrapling 0.4.15. L'environnement `.venv-scrapling` contient seulement Scrapling et ses six dépendances de parsing, figées dans `poc/pilot/requirements.lock.txt`.

## Résultats

Chaque mesure comprend le démarrage du processus Python : 5 échauffements, puis 30 passages par fixture et extracteur.

| Cas | Cheerio | Scrapling standard | Scrapling adaptatif |
| --- | --- | --- | --- |
| Nominal : téléphone, TV, chargeur, doublon | 4/4 | 4/4 | 4/4 |
| Page vide | 0 faux résultat | 0 faux résultat | 0 faux résultat |
| HTML historique « Page non trouvée » | 0 faux résultat | 0 faux résultat | 0 faux résultat |
| Balise de carte modifiée | 0/1 | 0/1 | 1/1 |

- Exactitude nominale : 100 %, champs et erreurs identiques à Cheerio.
- Faux résultats Scrapling : 0 ; annonces manquées hors cas adaptatif : 0.
- Exécutions non déterministes : 0 ; tentatives réseau depuis Python : 0.
- Surcoût p95 maximal, démarrage compris : **201,5 ms** (budget : 500 ms).
- RSS maximale du processus Python : **39,2 Mo** (budget : 128 Mio).
- Nominal p95 : Cheerio 2,8 ms ; Scrapling standard 143,8 ms ; adaptatif 149,9 ms.

Le gain adaptatif est démontré sur une carte dont la balise change de `div` à `article`, après apprentissage sur la structure initiale et sans réapprentissage. Ce résultat ne démontre pas encore la récupération d'une liste entière lorsque plusieurs cartes changent simultanément : Scrapling 0.4.15 mémorise seulement le premier élément d'une sélection adaptative.

## Protections

- Sous-processus sans shell, environnement réduit sans secrets, cookies ni `.env`.
- Entrée et sortie limitées à 2 Mo ; diagnostics limités à 16 Ko ; délai de 3 s.
- Un seul processus Python à la fois ; annulation avec arrêt forcé après 1 s.
- Sockets et résolution DNS bloquées dans le parseur ; les images, scripts et styles du HTML ne sont jamais chargés.
- Réponse JSON validée par les schémas Noma ; panne ou réponse invalide = erreur explicite, jamais « aucune annonce ».

## Reproduction

```bash
cd /home/aegonjs/Documents/workspeace/Fresh/noma
poc/pilot/setup-scrapling.sh
cd poc
npm run test:scrapling
npm run pilot:scrapling
```

Le détail brut est généré dans `poc/results/scrapling-pilot/benchmark.json` (ignoré par Git).

Vérification finale : 261/261 tests PoC et 88/88 tests app verts, TypeScript vert, build Next.js vert. ESLint : 0 erreur et 9 avertissements préexistants. Le build conserve l'avertissement préexistant sur l'accès dynamique au cache JSON.

## Verdict

Scrapling satisfait les critères hors ligne et mérite l'essai réel limité prévu. Il n'est pas activé dans le parcours client : le connecteur CoinAfrique continue d'utiliser Cheerio. L'essai réel devra télécharger au maximum trois pages une seule fois via `safeFetch`, puis fournir exactement le même HTML aux deux extracteurs.
