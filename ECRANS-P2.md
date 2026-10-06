# ECRANS-P2.md — Porte-monnaie, recharge simulée et achat de boost (lots P2 et P2-bis)

Les écrans de l'argent de noma : « Mon porte-monnaie » (solde, historique, recharge), la page de **paiement simulé** et l'**achat d'un
boost** dans « Booster cette annonce ». Le lot P2 ne modifiait **aucun module serveur** : les écrans consomment les routes de `WALLET.md`
(`wallet/v1`) et de `BOOST-PURCHASE.md` (`boost-purchase/v1`). Le lot **P2-bis** (corrections après audit, voir « Lot P2-bis » plus bas) modifie
les modules du boost : un devis n'est « disponible » que si le boost ferait réellement monter l'annonce (`BOOST-PRICING.md`, migration `0016`).
**Aucun argent réel** : le seul prestataire est le prestataire FICTIF, actif seulement en développement. Pour l'essayer : `ESSAYER.md`.

## Écrans

| Écran | Rôle |
| --- | --- |
| `/compte/porte-monnaie` (`app/(buyer)/compte/porte-monnaie/page.tsx`) | Gardé par `SessionGate`. Solde en FCFA, historique en mots simples (Recharge, Achat de boost, Remboursement de boost, Ajustement), montant signé coloré (vert +, orange −) et date, « Voir plus » par curseur. « Recharger » ouvre le panneau : 1 000, 2 000, 5 000, 10 000 FCFA ou un montant libre validé AVANT toute requête (500 à 500 000, multiple de 100, message clair), mention « la recharge est simulée ». `?recharger=1` ouvre le panneau, `?next=` mémorise le retour (nettoyé par `safeNextPath`). 503 `payment_unavailable` : « La recharge n'est pas disponible pour le moment. » |
| `/paiement-simule/[id]` (`app/paiement-simule/[id]/page.tsx`) | Gardé. Bandeau orange pleine largeur **« SIMULATION — aucun argent réel »**, montant, « Confirmer le paiement » / « Faire échouer le paiement » (`/api/dev/fake-payments/{id}/confirm` et `/fail`). L'état affiché est TOUJOURS relu par `GET /api/wallet/topups/{id}` : réussi → « Votre porte-monnaie a été crédité de X FCFA. » + lien de retour (`next` nettoyé, sinon le porte-monnaie) ; échoué ou expiré → message + « Réessayer la recharge ». Fictif inactif (503), recharge inconnue ou d'autrui (404) : message clair, aucun bouton de paiement. Pas de layout propre (un layout de plus ajouterait une route de layout aux types générés). |
| `/vendeur/annonces/[id]`, « Booster cette annonce » (`components/vendor/boost-section.tsx`) | Solde et lien « Mon porte-monnaie ». « Acheter » actif seulement pour un devis disponible, non expiré à l'écran, dont le prix est couvert par le solde connu ; sinon « Solde insuffisant (X FCFA) » (X = le solde actuel), « Il vous manque Y FCFA » et « Recharger » (revient ensuite à l'annonce). Clic → confirmation (« Vous allez payer X FCFA pour un boost de D. Solde après achat : Z FCFA. ») → `POST boost-purchases`. Succès → « Boost actif jusqu'au … » et la précision « Votre boost est actif : votre annonce peut monter dans les résultats des acheteurs concernés, avec le badge « Sponsorisé », parmi des offres déjà pertinentes. Ce n'est pas une garantie de position ni de vente. », solde mis à jour, historique des achats de l'annonce (date, durée, montant, « Remboursé le … »). Refus → message simple ; devis redemandé pour `quote_expired`, `quote_already_used`, `offer_already_boosted`… ; solde relu pour `insufficient_balance` ; « Trop de tentatives, réessayez dans un instant. » pour un 429. |
| Liens | « Mon porte-monnaie » dans `/compte` (acheteur) et `/vendeur/profil` (vendeur), et dans la section boost. Aucun autre écran de démonstration modifié. |

## Couche cliente (`lib/client/api.ts`) et modules purs

`api.wallet.overview({cursor?, limit?})`, `api.wallet.createTopup({amountXof, idempotencyKey})`, `api.wallet.topup(id)`,
`api.devPayments.confirm(id)` / `.fail(id)`, `api.boostPurchases.create(offerId, {quoteId, idempotencyKey})` / `.list(offerId)`. Même style qu'E1b :
validation AVANT la requête (UUID ; montant = entier sûr strictement positif, tout autre nombre est refusé ; le prix d'un achat ne vient
JAMAIS du client), réponses relues champ par champ avec `contractVersion` (montants entiers sûrs, types et statuts en liste blanche,
aucun identifiant interne), `ApiError` depuis le corps seul. `describeApiError` : contextes `wallet` et `purchase`, un message simple par
code (`insufficient_balance`, `quote_expired`, `quote_already_used`, `no_slot_available`, `seller_boost_limit_reached`, `offer_already_boosted`,
`offer_not_eligible`, `too_many_pending_topups`, `payment_unavailable`, `idempotency_conflict`, `boost_purchase_unavailable`…), jamais le code brut
(un code inconnu donne le message générique).

`lib/client/wallet-view.ts` (fonctions pures, `tests/client/wallet-view.test.ts`) : montants et dates, libellés, validation du montant de
recharge, clés d'idempotence, adresses et retours sûrs, états de la page simulée, logique « Acheter actif ? », texte de confirmation, suites
d'un refus, **compte à rebours ancré**. `lib/client/boost-view.ts` ne garde plus de fonction à horloge murale (le bouton « Acheter » toujours
désactivé a disparu).

## Règles

- **Clé d'idempotence** : un UUID v4 par tentative (`crypto.randomUUID`, repli `getRandomValues`), créé UNE fois — par montant pour une
  recharge, par devis pour un achat — et réutilisé à chaque nouvel essai (panne réseau, réponse perdue). La clé d'une RECHARGE est conservée dans
  `sessionStorage` de l'onglet (`noma:topup-key:<montant>`, accès protégé par try/catch) : un rechargement de la page rejoue la même intention ;
  elle est effacée quand la recharge est terminale (réussie, échouée ou expirée). La clé d'un ACHAT reste en mémoire de la page.
- **Pas de double envoi** : verrou synchrone (`useRef`) ET bouton réellement `disabled` (« Achat en cours… ») pendant la requête.
- **Compte à rebours ancré** : restant à la réception = `expiresAt` − heure du serveur (en-tête HTTP `Date` de la réponse, résolution 1 s, donc on
  retire 1 s), borné par `expiresAt − computedAt` (et 1 h) ; restant à l'instant t = restant à la réception − (`performance.now()` − réception).
  Un devis RÉUTILISÉ, déjà vieux à la réception, n'affiche donc plus sa fenêtre entière. En-tête absent ou incohérent avec le devis : ancienne
  règle (fenêtre = `expiresAt − computedAt`). L'horloge murale (`Date.now`, `new Date`) n'y entre jamais ; dates illisibles = devis expiré. Au retour
  au premier plan (`visibilitychange`, après une veille qui fige l'horloge monotone), solde, achats et devis sont relus et le compte à rebours est
  ré-ancré. Le serveur reste juge (`quote_expired`).
- **Retour sûr** : tout `next` passe par `safeNextPath` ; le chemin de paiement renvoyé par le serveur doit être `/paiement-simule/<uuid>`.
- **Montants** : entiers, « 2 000 FCFA » ; jamais de flottant.

## Lot P2-bis (corrections après audit)

| Point | Changement |
| --- | --- |
| S1 — portée visible | Un devis n'est `available` que si ≥ 1 acheteur verrait l'offre monter (`lib/server/boost/reach.ts`, logique de `placement.ts` réutilisée). Sinon motif `no_visible_effect` : « Pas encore assez d'annonces comparables : un boost ne changerait rien à l'ordre des résultats. » (aucun prix, aucun « Acheter »). DTO `inputs.reachableBuyers`, ligne « Mise en avant visible auprès de X acheteur(s). » (n'entre pas dans le prix). Migration `0016`. Détails : `BOOST-PRICING.md`, `BOOST-HTTP.md`. |
| S2 — annonces d'exemple | `npm run dev:seed -- --category phones --brand apple --model "iphone 12" --offers 8` : annonces de vendeurs fictifs (`+225 07 99 99 99 01` à `50`) par les vrais services du catalogue, rejouable sans doublon ; refus sans rien écrire hors développement, sans `DATABASE_URL`, base non locale, base `noma_dev` ou ne commençant pas par `noma_`. Étape ajoutée à `ESSAYER.md`. |
| S3 — devis réutilisé | Compte à rebours ancré sur l'en-tête `Date` (voir « Règles »), ré-ancré au retour au premier plan (`visibilitychange`). |
| S4 — achat à résultat inconnu | Après TOUT échec d'achat (réseau ou refus), solde, achats de l'annonce et historique des devis sont relus ; l'achat est cherché parmi les achats (retrouvé : succès affiché, jamais d'erreur périmée ; cas de la réponse perdue et du devis acheté depuis un autre onglet). Tant qu'un achat a échoué sans réponse : « Aucun achat n'est enregistré pour ce devis (aucun débit)… » + « Vérifier / réessayer » avec la MÊME clé, même si le devis a expiré à l'écran. L'erreur d'achat est effacée au rafraîchissement. |
| S5 — pas d'achat pendant un nouveau prix | Dès qu'un devis est demandé, la confirmation est fermée et « Acheter » est désactivé ; la réponse d'un devis parti avant un achat réussi est ignorée (garde de génération). |
| M5 | Clé de recharge persistée par montant dans `sessionStorage` (voir « Règles »). |
| M6 | Bouton « Relire mon solde » et relecture au retour au premier plan. |
| M7 | 429 des contextes `wallet` et `purchase` : « Trop de tentatives, réessayez dans un instant. » |
| M8 | « 000000000500 » est normalisé en 500 FCFA. |
| M9 | `e2e:ui` vérifie CHAQUE valeur `next` hostile (une recharge par valeur). |
| M10 | Type d'opération inconnu : ligne « Opération » avec son montant validé, l'historique n'est pas rejeté. |

## `dev:try`

`NOMA_FAKE_PAYMENTS=1` est toujours posé et `NOMA_FAKE_PAYMENT_SECRET` (32 octets au moins) est généré s'il n'est pas fourni (jamais affiché ;
fourni mais trop court : refus). Le fictif reste soumis à la liste d'autorisation du serveur (`NODE_ENV` = `development` ou `test`) : `dev:try`
refuse déjà de démarrer ailleurs.

## Vérification

| Commande | Contenu |
| --- | --- |
| `npm run test:client` | 238 tests (dont `wallet-view` et les nouveaux appels de `api.ts`). |
| `npm run test:dev-proxy` | 51 tests (dont paiement simulé de `dev:try` et le guide `ESSAYER.md`). |
| `npm run test:dev-seed` | 29 tests : partie pure de `dev:seed` (arguments, garde-fous, vendeurs fictifs, plan), refus en processus enfant, et exécution réelle sur un schéma temporaire de la base de test (8 annonces, rejeu, `--offers 10`, autre produit, reprise d'un brouillon). |
| `npm run e2e:core` | 124 vérifications. À travers le relais (`dev:try`, base `noma_e2e`) : recharge refusée hors bornes, idempotence, 404 entre comptes, confirmation fictive, rejeux sans second crédit, échec simulé ; achat refusé sans crédit (409), 201, rejeu 200 « reused », un seul débit, devis consommé ; historique (23 lignes, pages de 20 et de 5 suivies par curseur) ; « Sponsorisé » côté acheteur ; `wallet:check` (deux fois) ; P2-bis : une annonce + un besoin → devis `no_visible_effect` (aucun prix, achat 409 `quote_unavailable`), `dev:seed` (8 annonces d'exemple) → devis disponible avec `reachableBuyers` = 1, relance sans doublon. |
| `npm run e2e:ui` | 102 vérifications. Vrai Chrome, à travers le relais : parcours complet décrit dans l'en-tête du script (devis sans effet visible, `dev:seed`, solde insuffisant, recharge 2 000, page simulée, devis réutilisé juste, retour au premier plan, refus 409 et 429 simulés, confirmation refermée par un nouveau devis, achat perdu avant le serveur + « Vérifier / réessayer » avec devis expiré à l'écran, double clic, devis lent ignoré, second onglet périmé, un seul débit, historique, « Voir plus », « Sponsorisé », clé de recharge conservée après rechargement, échec simulé, CHAQUE `next` hostile, horloge décalée, type d'opération inconnu) ; aucun message console error inattendu. Captures dans `/tmp/noma-p2bis-shots/`. |

**Durée des essais** : la base `noma_e2e` grossit à chaque essai (le worker évalue chaque besoin contre toutes les offres de sa catégorie) : `e2e:core` est passé de
32 s à 3 min, `e2e:ui` de 1 min 20 s à 5 min (environ 1 200 offres). Les délais d'attente du worker par défaut sont relevés (`NOMA_E2E_WORKER_TIMEOUT_MS` : 300 000 ms pour `e2e:core`,
600 000 ms pour `e2e:ui`) ; vider la file du worker avant un essai (`npm run matching:status` : plus aucun job `pending` ni `running`) et
purger `noma_e2e` redonne la vitesse (non fait par ce lot).

Le montage est celui du lot E1b : copie de l'arbre (`rsync` sans `/.git`, `/.next`, `/data`, `/.claude`), `npm run dev:try` dans la copie (ports 3211 et 3212),
base `noma_e2e` recréée à neuf avant chaque série (`dropdb`, `createdb`, `npm run db:migrate` : 16 migrations, jusqu'à `0016`), `NOMA_E2E_DATABASE_URL` pour `wallet:check`, `boost:grant` et `dev:seed`. Chaque redémarrage de `dev:try` remet les quotas de codes OTP à zéro.

## Limites connues

- **Devis réutilisé** : corrigé au lot P2-bis (compte à rebours ancré sur l'en-tête `Date`). Sans en-tête exploitable (absent, illisible, incohérent avec le
  devis), l'écran retombe sur l'ancienne règle et peut afficher plus que la validité réelle ; le serveur reste juge (`quote_expired`, nouveau devis demandé).
  La résolution de l'en-tête est la seconde : l'écran peut afficher jusqu'à 1 s de moins que le temps réel, jamais plus.
- La clé d'idempotence d'un ACHAT vit en mémoire de la page : après un rechargement, la bannière « Vérifier / réessayer » n'existe plus ; l'historique des
  achats de l'annonce montre l'achat s'il a abouti, et le devis consommé n'est plus proposé. Un achat dont la demande n'a jamais atteint le serveur est
  simplement à refaire (aucun débit).
- **La portée visible n'est pas recalculée à l'achat** : un devis `available` promet qu'au moment de son calcul un acheteur voyait l'offre monter ; l'état des
  listes peut changer ensuite (`BOOST-PURCHASE.md`, « Limites »).
- Un achat n'est ni annulable ni remboursable depuis l'écran (remboursement d'administration seulement, `BOOST-PURCHASE.md`).
- Le porte-monnaie de l'espace vendeur s'ouvre dans la mise en page acheteur (même route `/compte/porte-monnaie`), avec un retour vers l'écran d'origine.
- Une réponse 4xx du serveur (409, 404) est journalisée par le navigateur dans sa console (« Failed to load resource ») : l'application ne les masque pas.
- Les écrans ne sont pas testés en unitaire : leur logique est dans des fonctions pures testées, les pages sont couvertes par `e2e:ui`.
- `lib/server/wallet/http.ts` contient encore le commentaire « la page viendra au lot P2 » (module serveur non modifié par ce lot).
- Vrai prestataire, traitement juridique et comptable des crédits, limites de débit : voir `WALLET.md` (inchangé).
