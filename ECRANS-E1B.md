# ECRANS-E1B.md — Correspondances, « Sponsorisé » et devis de boost branchés, application utilisable dans un navigateur (lot E1b)

> **Mise à jour (lot P2)** : le porte-monnaie, la recharge simulée et l'**achat de boost** existent (voir `ECRANS-P2.md`). Le bouton
> « Acheter » n'est plus toujours désactivé (il suit le devis et le solde) et le compte à rebours d'un devis n'utilise plus l'horloge
> de l'appareil (horloge monotone ancrée à la réception). Lot P2-bis : un devis n'est « disponible » que si le boost ferait réellement monter
> l'annonce chez au moins un acheteur (motif « Pour le moment, un boost ne ferait monter votre annonce chez aucun acheteur… », ligne « Mise en avant visible auprès de X acheteur(s) »,
> `npm run dev:seed` pour ajouter des annonces d'exemple : `ESSAYER.md`, `BOOST-PRICING.md`). Les paragraphes ci-dessous décrivent l'état du lot E1b.
>
> **Mise à jour (lots M1 à M1-quater)** : chaque carte de résultats a un lien « Voir l'annonce » vers la **fiche** (`/besoins/[id]/offres/[offerId]`, contact du vendeur) ; l'écran de l'annonce du vendeur
> gagne la section « Ce que produit votre annonce » ; les comptes d'acheteurs du devis (« acheteurs compatibles », « visible auprès de X acheteur(s) ») sont **arrondis** (contrat `boost-quote/v2`) :
> « moins de 5 acheteurs » de 0 à 4, « environ 15 acheteurs » à partir de 5 (multiple de 5 le plus proche ; « environ 5 » de 5 à 8). Voir `MESURES.md`.
>
> **Titre de « Acheteurs intéressés » (lot M1-quater, SUPPRIMÉ au lot D3 : plus aucun compte au-dessus de la liste, une phrase « Chaque ligne est le besoin d'un acheteur, sans son identité. » ; texte historique ci-dessous)** : il suivait le même arrondi — « Moins de 5 besoins d'acheteurs correspondent à votre annonce » de 1 à 4 besoins, « Environ 10 besoins d'acheteurs correspondent à votre
> annonce » à partir de 5 (5 à 8 → 5, 9 à 12 → 10…) ; tant qu'il reste des pages : « Au moins N besoins… » (N arrondi vers le bas à 5 près) ; « Aucun besoin d'acheteur ne correspond pour le moment » pour 0 (la liste est alors vide). La **liste
> des besoins reste affichée** (budget, lieu : c'est le produit). Le facteur demande du devis ne redonne plus un petit nombre d'acheteurs (D' = 5 de 1 à 5 acheteurs, `BOOST-PRICING.md`).

Ce lot rend l'application utilisable de bout en bout dans un vrai navigateur (relais de développement, commande unique
`npm run dev:try`), affiche les correspondances à l'acheteur et au vendeur, et le devis de boost au vendeur. **Aucune modification
du comportement des modules serveur** (auth, catalogue, matching, boost) : l'écran consomme les routes déjà livrées.
Pour l'essayer sans être développeur : `ESSAYER.md`.

## Relais de développement (`scripts/dev-proxy.ts`)

La demande de code OTP exige les en-têtes d'un reverse proxy de confiance (`X-Noma-Proxy-Secret`, `X-Forwarded-For`, voir
`AUTH-SERVER.md`) : un navigateur qui parle directement à `next dev` reçoit 503. Le relais joue ce rôle en local.

| Règle | Détail |
| --- | --- |
| Démarrage | Refuse si `NODE_ENV=production` ou si `NOMA_DEV_PROXY` ne vaut pas exactement `1`, ou si le secret (`NOMA_AUTH_PROXY_SECRET`, repli `NOMA_PROXY_SECRET`) a moins de 32 octets. `createDevProxy` lève aussi en production (défense en profondeur : un appel direct ne contourne pas la garde). |
| Écoute | `127.0.0.1` SEULEMENT (adresse figée dans le code, aucune option) ; port 3212 par défaut (`NOMA_DEV_PROXY_PORT`). |
| Cible | `http://127.0.0.1:3211` par défaut (`NOMA_DEV_PROXY_TARGET`) ; **uniquement une adresse `http://` du poste** (127.0.0.1 ou localhost, sans identifiants ni chemin) : le secret ne part jamais vers une autre machine. |
| En-têtes | Supprime TOUJOURS `x-noma-proxy-secret` et `x-forwarded-for` reçus du client (toutes casses, doublons compris), puis écrit son secret et l'adresse de la connexion cliente (`::ffff:` retiré). Supprime aussi en entrée `Forwarded`, `X-Real-IP`, `X-Forwarded-Host` et `X-Forwarded-Proto` (jamais crus, jamais relayés, rien ne les remplace). `Host` est réécrit vers la cible ; les en-têtes de saut (`Connection`, `Transfer-Encoding`…) et `Expect` ne sont pas relayés ; `Set-Cookie` (plusieurs), `Location` et `Content-Type` passent. Un `Location` qui désigne la cible elle-même (`http://127.0.0.1:<port>` ou `http://localhost:<port>`, origine EXACTE suivie de `/`, `?`, `#` ou de rien) est réécrit vers l'origine PUBLIQUE configurée du relais (option `publicOrigin`, variable `NOMA_DEV_PROXY_PUBLIC_ORIGIN`, défaut `http://localhost:<port d'écoute>`) : jamais déduite de l'en-tête `Host` fourni par le client. |
| Flux | Requête et réponse relayées EN CONTINU (le NDJSON de `/api/search` arrive au fil de l'eau) ; la coupure du client est propagée à la cible ; une cible qui coupe en pleine réponse est vue du client (pas de réponse tronquée présentée comme complète) ; cible injoignable : 502 JSON fixe. Les mises à niveau WebSocket (rechargement à chaud de `next dev`) passent par la même politique d'en-têtes. |
| Journal | Démarrage et codes d'erreur système seulement ; ni le secret reçu, ni le secret envoyé, ni les adresses demandées. Un abandon du client (onglet fermé en pleine réponse) n'est pas journalisé : seule une vraie cible injoignable l'est (« cible injoignable (ECONNREFUSED) »). |

**N'exposez jamais le port du relais** par un tunnel (loca.lt, ngrok…) ni une redirection de port : toute personne qui l'atteint devient un client de confiance pour l'authentification.

Aucune dépendance : `node:http` et `node:net`. Tests : `npm run test:dev-proxy` (deux mini-serveurs HTTP, sans Next).

## `npm run dev:try` (`scripts/dev-try.ts`)

Une commande lance `dev:full` (Next sur 3211 + worker du matching) ET le relais sur 3212 (dans le même processus). Réglages posés :
`NODE_ENV=development`, `NOMA_DEV_OTP_CONSOLE=1`, `NOMA_DEV_PROXY=1`, `NOMA_AUTH_ORIGIN=http://localhost:3212`, `PORT=3211`.
`NOMA_AUTH_SECRET` et `NOMA_AUTH_PROXY_SECRET` sont lus dans l'environnement s'ils existent (et validés), sinon générés au hasard à chaque
démarrage (avertissement : les sessions ne survivent pas à un redémarrage) ; `NOMA_PROXY_SECRET` reçoit la même valeur que le secret du relais.
**`DATABASE_URL` est obligatoire** (aucune valeur par défaut) ; aucune migration n'est appliquée.

Montage ENTIÈREMENT simulé : `NOMA_FAKE_SOURCES=1`, `NOMA_AI_DISABLED=1` et `NOMA_TURNSTILE_DISABLED=1` sont toujours posées (quoi que dise
l'environnement) : la recherche rapide montre des résultats d'exemple, sans contacter de vrai site (le route n'active les fausses sources que si
le captcha est désactivé hors production).

Refus clairs (code de sortie 1, avant tout démarrage) : `NODE_ENV` défini, non vide et différent de `development` (production, test…) ;
`DATABASE_URL` absent de l'environnement de lancement (**vérifié avant toute lecture de fichier : aucun `.env*` n'est lu par `dev:try`**, un `.env.local` ne
choisit donc jamais la base) ; `DATABASE_URL` qui ne désigne pas une base de CE poste (127.0.0.1, localhost, `::1`, y compris par les paramètres
`host` et `hostaddr`) ; « Un serveur next dev tourne déjà dans ce dossier (port 3210) : arrêtez-le ou utilisez une copie. » quand `.next/dev/lock`
désigne un processus vivant (un verrou d'un processus disparu est ignoré) ; port 3211 ou 3212 occupé. Quand Next répond, un encadré affiche
l'adresse `http://localhost:3212` et rappelle que le code de connexion s'affiche dans le terminal. Ctrl+C (SIGINT) arrête Next, le worker et le relais.
Si `dev:full` (Next ou le worker) ou le relais se termine de lui-même, pendant le démarrage comme après, tout est arrêté aussitôt avec un message clair
et le code de sortie 1 (plus d'attente de 180 s). La racine du projet est celle du script (pas le dossier courant). Variable RÉSERVÉE AUX TESTS :
`NOMA_DEV_TRY_LOCK_DIR` (dossier où chercher `.next/dev/lock`) ; `NOMA_DEV_FULL_NEXT_SCRIPT` (faux Next, voir `dev-full.ts`) est transmise à `dev:full`.

## Couche cliente (`lib/client/api.ts`)

| Appel | Route | Règles |
| --- | --- | --- |
| `api.demands.storedMatches(id, { sort, cursor, limit })` | `GET /api/demands/{id}/stored-matches` | UUID validé ; `sort` (`score` ou `relevance`), `cursor` (1 à 512 caractères, encodé), `limit` (1 à 100) vérifiés AVANT toute requête (`invalid_id` / `invalid_argument`, statut 0). |
| `api.offers.storedMatches(id, { … })` | `GET /api/offers/{id}/stored-matches` | idem. |
| `api.boostQuotes.create(offerId, durationCode)` | `POST /api/offers/{id}/boost-quotes` | durée `24h`, `3d` ou `7d` vérifiée avant l'envoi ; 201 (créé) et 200 (réutilisé) acceptés ; un devis INDISPONIBLE est un succès. |
| `api.boostQuotes.list(offerId, { limit })` | `GET /api/offers/{id}/boost-quotes` | `limit` 1 à 50. |

Les réponses sont relues champ par champ (liste blanche, contrats `matching-stored-http/v1` et `boost-quote/v1` vérifiés) : un champ ajouté un jour par
le serveur, ou un identifiant de propriétaire qui y figurerait, n'atteint jamais l'écran. `ApiError` vient du corps seulement (comme avant) ;
`describeApiError` gagne les contextes `matches` et `boost` (messages fixes).

## Écrans

| Écran | Branchement |
| --- | --- |
| `/besoins/[id]` (`app/(buyer)/besoins/[id]/page.tsx`, `components/matches/match-parts.tsx`) | Gardé par `SessionGate`. Lien « Voir les offres » sur chaque besoin de « Mes besoins » (`/alertes`). `GET stored-matches?sort=relevance` ; « Voir plus » par curseur ; « Recherche en cours… » + « Actualiser » quand le worker n'a pas fini ; état vide ; besoin non actif : message sans appel de correspondances. Chaque offre : titre (marque, modèle, variante), prix, compatibilité en % avec sa barre, indicateurs en mots simples (prix par rapport au marché, disponibilité, confiance), jamais d'identifiant ni de téléphone. Badge « Sponsorisé » (orange, distinct, icône, bordure) avec « Mis en avant par le vendeur, parmi des résultats déjà pertinents » (et la même info-bulle) UNIQUEMENT quand `sponsored` est vrai. |
| `/vendeur/annonces/[id]` (`app/(vendor)/vendeur/annonces/[id]/page.tsx`, `components/vendor/interested-buyers.tsx`, `components/vendor/boost-section.tsx`) | Gardé. Lien « Acheteurs intéressés et boost » sur chaque annonce de « Mes annonces ». « Acheteurs intéressés » : nombre et liste des BESOINS correspondants (produit, budget, compatibilité, confiance par tranche), SANS identité ni téléphone. Le compte est en besoins, jamais en acheteurs (un acheteur peut avoir plusieurs besoins ; l'écran sert à vendre un boost payant : on ne surestime pas) : « 1 besoin d'acheteur correspond à votre annonce », « 3 besoins d'acheteurs correspondent… », « Au moins 20 besoins… », « Aucun besoin d'acheteur ne correspond pour le moment », avec une note qui le rappelle ; « Voir plus », « Actualiser », état « processing ». Annonce hors ligne : message, aucun appel. « Booster cette annonce » : 24 h / 3 jours / 7 jours → `POST boost-quotes` ; montant en FCFA, explication en clair des quatre facteurs (concurrence, acheteurs compatibles, places, durée), compte à rebours de validité (remis à l'heure à la réception de chaque devis, et jamais affiché au-delà de la durée de validité du devis : `remainingValidityMs`), motif d'indisponibilité en clair, historique des devis ; bouton « Acheter » DÉSACTIVÉ + « Paiement bientôt disponible » (aucun appel de paiement n'existe). |
| `lib/client/match-view.ts`, `lib/client/boost-view.ts` | Libellés et règles de présentation, fonctions pures testées (`npm run test:client`). |
| « Voir plus » et « Actualiser » | Un compteur de génération (`createGenerationGuard`, `mergeIfCurrent`) fait ignorer toute réponse d'une génération antérieure : la page 2 d'un instant T0 n'est jamais fusionnée avec la page 1 de T1 ; « Actualiser » invalide les « Voir plus » en cours ; les deux boutons sont désactivés pendant un chargement. |

Aucun écran de démonstration n'est modifié (aucun lien vers une page fictive n'a eu à être retiré : les pages `/vendeur/demandes`, `/offre/[id]`… ne sont pas
remplacées par ces écrans).

## Vérification de bout en bout

Tous les essais passent par le relais : ni `e2e:core` ni `e2e:ui` n'envoient eux-mêmes un en-tête de proxy de confiance. Montage utilisé : copie de l'arbre
(rsync sans `/.git`, `/.next`, `/data`), `dev:full` (Next 3211 + worker) et `npm run dev:proxy` (3212), base `noma_e2e`, `NOMA_AUTH_ORIGIN=http://localhost:3212`.
Chaque redémarrage du serveur avec un secret d'authentification neuf remet les quotas de codes OTP par IP à zéro (toutes les connexions portent l'adresse
127.0.0.1 : limite partagée de 60 défis non vérifiés par quart d'heure glissant depuis le lot SMS1-ter, 20 demandes auparavant).

| Commande | Rôle |
| --- | --- |
| `npm run e2e:core` | Comme avant, à travers le relais, plus : indicateurs et `sponsored` faux ; usurpation des en-têtes de confiance sans effet ; accès direct à Next sans relais → 503 ; scénario « mise en avant » (produit unique, 8 offres d'un vendeur concurrent, l'offre du vendeur A la plus chère, devis 201 puis 200 réutilisé, 409 pour une annonce en pause, `boost:grant`, offre « sponsorisée » en tête avec quota `floor(0,15 × N)`, aucune identité dans aucune réponse). `NOMA_E2E_SEARCH_STREAM=1` ajoute le contrôle du flux NDJSON de `/api/search`. |
| `npm run e2e:ui` | Vrai navigateur (Chrome via Playwright de `poc/`) sans aucun en-tête injecté : parcours E1a, liens vers les nouveaux écrans, puis scénario à deux contextes de navigateur (vendeur A, acheteur B) et un vendeur concurrent créé par l'API (22 offres) : résultats avec indicateurs, « Voir plus » (23 offres sans doublon), badge « Sponsorisé » après `boost:grant`, acheteurs intéressés sans identité, devis (montant, facteurs, compte à rebours, « Acheter » désactivé), motif « déjà boostée ». Captures dans `/tmp/noma-e1b-shots/`. |
| `npm run e2e:search-release` | Inchangé ; peut aussi être lancé à travers le relais (la coupure TCP est propagée jusqu'à la libération de la place). |

`NOMA_E2E_DATABASE_URL` (base du serveur testé, DOIT se terminer par `/noma_e2e`) sert à la commande d'administration `boost:grant` lancée par les essais.

## Tests

| Commande | Contenu |
| --- | --- |
| `npm run test:client` | Suite sans base : couche cliente (dont `storedMatches` et `boostQuotes`), garde de session, vues du catalogue, `match-view`, `boost-view`, téléphone et parcours OTP, en-têtes de l'e2e. Incluse dans `npm test`. |
| `npm run test:dev-proxy` | Relais (en-têtes injectés et usurpés supprimés, refus en production et sans drapeau, écoute 127.0.0.1, flux progressif, coupure propagée, aucun secret dans les journaux, mise à niveau) et `dev:try` (préparation de l'environnement, verrou de `next dev`, ports). Incluse dans `npm test`. |

## Limites connues

- Le compte à rebours d'un devis se calcule avec l'horloge de l'appareil (la réponse du serveur ne porte pas l'heure courante) ; il est remis à l'heure à chaque devis reçu et borné par la durée de validité du devis, mais une horloge d'appareil très décalée reste imprécise.
- Une cotation disponible encore valable est réutilisée telle quelle par le serveur, même si l'annonce vient d'être boostée (comportement de `BOOST-PRICING.md`) : l'écran affiche alors le montant d'origine ; le bouton « Acheter » reste désactivé.
- Les résultats de l'acheteur sont triés par pertinence (seul tri qui applique « Sponsorisé ») ; la page ne propose pas de choix de tri. Un curseur de pertinence expire après 1 h (message « Actualisez la page »).
- L'actualisation des résultats est manuelle (« Actualiser ») ; pas de rafraîchissement automatique.
- Le titre d'une offre dans les résultats est « marque modèle variante » : le serveur n'envoie pas le texte brut de l'annonce.
- `next dev` écoute sur toutes les interfaces (comportement de `next dev` que `dev:full` ne change pas) : seul le relais est limité à 127.0.0.1 ; un accès direct à Next sans le secret du relais reçoit 503 sur la connexion.
- Les pages React ne sont pas testées en unitaire : leur logique est dans des fonctions pures testées, les pages sont couvertes par `e2e:ui`.
- `scripts/e2e-proxy-headers.ts` et son test ne sont plus utilisés par `e2e:ui` (plus d'en-têtes injectés par le navigateur) ; laissés en place.
- Paiement, achat, crédit : inexistants (hors périmètre).
