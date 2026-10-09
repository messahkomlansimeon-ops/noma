# Administration (lots D2 et D3)

`/admin` (tableau de bord), `/admin/vendeurs`, `/admin/reglages` ; `/admin/dossiers` reste « Bientôt disponible ». Routes `/api/admin/*` dans `lib/server/admin/http.ts`.

## Le rôle

- Colonne `users.is_admin` (migration `0020`, FAUX partout). **Elle ne s'attribue que par la commande** `npm run admin:grant -- "<numéro>"` (numéro vérifié du compte, saisie libre normalisée) ; `demo:seed` utilise la même fonction pour le compte Admin démo (`+225 07 00 00 03 03`).
- Un **déclencheur** refuse tout `UPDATE` ou `INSERT` qui ferait passer `is_admin` à VRAI sans le réglage de transaction posé par cette commande : aucun écran, aucune route, aucun autre code ne peut l'attribuer.
- La commande **refuse de s'exécuter en production** (`NODE_ENV=production`) sans `NOMA_ADMIN_GRANT_PRODUCTION=1`, et pour toute valeur de `NODE_ENV` autre qu'absente, `development` ou `test` ; elle ne répète jamais la valeur reçue. Chaque attribution est écrite au journal (`admin_actions`, source `command`).

## Les routes

TOUTES : `no-store`, origine vérifiée sur les écritures (**avant** la session), et le **même `404 « Ressource introuvable. »`** pour un visiteur sans session, un compte ordinaire ou un administrateur suspendu : l'existence de l'espace ne se devine pas. **Lot D3** : un compte connecté qui n'est pas administrateur obtient, sur `/admin` et ses sous-pages, la **page 404 standard de Next** (« 404 », puis « This page could not be found. » ; `notFound()` appelé par le gabarit `app/(admin)/layout.tsx` avant tout affichage : statut HTTP 404, aucun titre « Administration », aucun sélecteur d'espace ; **lot D3-bis : la même page `app/not-found.tsx` qu'une adresse inconnue, avec le même titre d'onglet, celui de l'application**). Un visiteur sans session est renvoyé vers la connexion par la garde de session de la page. Si un 404 arrive des routes pendant la session (rôle retiré), l'écran appelle lui aussi `notFound()`.

- `GET /api/admin/summary` : comptes (actifs, suspendus), annonces par statut, besoins actifs, correspondances confirmées et fraîches, boosts actifs, crédits en circulation (somme des soldes des comptes utilisateurs), recharges du jour (nombre et montant, jour UTC), conversations et messages du jour, commandes confirmées et en attente, état du worker (résumé de `matching:status` : schéma, événements et tâches en attente, échecs définitifs, avertissements, dernière tâche terminée).
- `GET /api/admin/vendors?limit&offset` : les comptes qui ont au moins une annonce, du plus récent au plus ancien, 20 par page (50 au plus) : annonces, date d'inscription, statut. Le numéro est **masqué DANS la requête** (`+`, des points, deux derniers chiffres) : le numéro complet ne quitte jamais la base pour cette lecture.
- `POST /api/admin/vendors/{id}/suspend|reactivate` : réutilise `updateUser` (statut `users` existant : suspension = évaluations invalidées et session refusée ; réactivation = événement `user.reactivated`, donc le **balayage de réactivation** du worker). Le changement de statut et la ligne du journal sont écrits dans **la même transaction**. Un administrateur ne se suspend pas (ni lui-même) : `409 target_protected`. Idempotent (rien de journalisé si le statut ne change pas). L'écran demande une confirmation.
- `GET /api/admin/actions` : le **journal d'administration** (`admin_actions` : qui (numéro masqué ; « commande » pour `admin:grant`), quoi, quand) ; non modifiable (déclencheur).
- `GET /api/admin/settings` : réglages du boost par catégorie (`boost_settings` et `boost_pricing_settings`), **lecture seule** (aucune route d'écriture).

## Le sélecteur d'espace (lot D3)

L'onglet **Admin** du sélecteur d'espace (Acheteur / Vendeur / Admin) n'est affiché qu'aux administrateurs : le sélecteur lit `GET /api/auth/session`, qui répond **toujours 200** (`{ "authenticated": false }` sans session valide, `{ "authenticated": true, "userId": …, "isAdmin": … }` sinon ; `isAdmin` est un booléen seulement). Le visiteur anonyme ne provoque donc plus de 401 dans la console du navigateur. Ce n'est qu'une commodité d'interface : l'autorisation réelle reste celle des routes `/api/admin/*`, qui relisent la base.

## Offres Pro (lot PRO1)

`/admin/offres` (lien depuis l'aperçu) et `GET /api/admin/plans`, `POST /api/admin/plans/{code}/versions` : versions des plans en lecture seule, création d'une nouvelle version, abonnés arrondis à 5
près, revenus d'abonnement du mois. La page est sous le gabarit gardé de l'espace d'administration (page 404 standard de Next pour tout non-administrateur, aucun onglet Admin) ; les routes
répondent le même 404. Prix **provisoires** : une nouvelle version ne s'applique qu'aux nouvelles souscriptions, **les abonnés actuels gardent leur prix**. Voir `OFFRE-PRO.md`.

## Recherche active (lot RA1)

`/admin/recherche-active` (lien depuis l'aperçu) et `GET /api/admin/active-search` : besoins avec une option payante en vigueur (**arrondis à 5 près**, jamais un compte exact) et **revenus nets du mois** (achats − remboursements, lus dans le grand livre). Même gabarit gardé que `/admin/offres` (page 404 standard de Next pour tout non-administrateur) ; la route répond le même 404 à un visiteur, un compte ordinaire ou un administrateur suspendu, et ne fait que lire. Le remboursement est la commande `npm run active-search:refund`. Prix **provisoire**. Voir `RECHERCHE-ACTIVE.md`.

## Paiements (lot PAY1)

`/admin/paiements` et `GET /api/admin/payments`, `POST /api/admin/payments/anomalies/{id}/resolve` : recharges récentes, **anomalies de rapprochement à traiter** (marquées traitées une
fois, avec l'administrateur et la date), état du rattrapage et des webhooks Sublymus. Même garde que les autres pages d'administration (page 404 standard pour tout non-administrateur,
même 404 sur les routes). L'API expose l'**identifiant de la recharge** (aléatoire) mais **aucune donnée personnelle** : ni propriétaire, ni numéro, ni référence chez Sublymus, ni
identifiant de payeur. Voir `PAIEMENT-WAVE.md`.

## Limites assumées

- Un `404` JSON rapide sur `/api/admin/*` révèle l'existence des routes (pas de données) : la réponse est identique pour tout non-administrateur, mais elle diffère de celle d'une URL inconnue servie par Next.
- Le verrou d'attribution de `is_admin` repose sur un réglage de session (`noma.admin_grant`) : un accès SQL direct à la base peut le contourner. L'accès direct à la base est de toute façon un accès total ; le déclencheur protège contre le code applicatif, pas contre l'administrateur de la base.

Pas de retrait du rôle depuis l'application (ni de commande `--revoke`) ; la suspension n'est proposée que dans la liste des vendeurs ; « Dossiers de modération » n'est pas branché.
