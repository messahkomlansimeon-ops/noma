# MESURES.md — Mesures d'efficacité : fiche d'annonce, contact, ouvertures, statistiques du vendeur (lots M1, M1-bis, M1-ter et M1-quater)

AUDIT-EVOLUTION-SCOUTR.md §6 « Mesure et économie » et §7 (lot 4, critère de sortie « mesures d'efficacité disponibles ») : un acheteur
doit pouvoir **ouvrir une vraie fiche d'annonce et contacter le vendeur** ; le vendeur doit voir **ce que son annonce et son boost produisent**.
Ce lot ajoute la fiche, le contact, trois journaux et les statistiques du vendeur, avec une **protection des acheteurs par l'arrondi des comptes publiés**. Il complète
`BOOST-METRICS.md` (journal d'exposition, lot 2I4) sans le modifier. Aucun paiement, aucun appel externe, aucune dépendance. Le lot **M1-bis** corrige les
constats de l'audit du lot M1 : facteur demande du devis, titre des besoins, journal des ouvertures après la réponse, garde de la purge. Le lot **M1-ter** remplace la
suppression complémentaire de M1-bis (que l'audit a contournée : constat K1) par un treillis de cellules calculé et le prouve contre un adversaire indépendant. Le lot **M1-quater**
remplace TOUTE la suppression par l'**arrondi à 5 près** (méthode standard de protection des statistiques : simple, lisible pour le vendeur, elle ne masque plus l'essentiel : la mesure d'efficacité du
boost, presque toujours masquée par le treillis, redevient lisible) et **retire** le treillis (`cells.ts`, la suppression de `privacy.ts`, les identités linéaires, le point fixe). L'adversaire
indépendant (`tests/server/metrics-adversary*.ts`) est gardé et adapté : « Ce que l'adversaire prouve » dit exactement ce qui l'est, et ce qui ne l'est pas.

Code : `lib/server/metrics/` (`config.ts`, `privacy.ts` — l'arrondi, une petite fonction pure —, `attribution.ts`, `views.ts`, `contacts.ts`, `stats.ts`, `purge.ts`, `offer-detail.ts`, `http.ts`),
`lib/server/matching/stored-matches.ts` (`readStoredOfferForDemand`), `lib/server/boost/recheck-guard.ts`, migration
`database/migrations/0018_offer_metrics.sql`, `scripts/metrics-purge.ts`, routes `app/api/demands/[id]/offers/[offerId]/route.ts`,
`.../contact/route.ts` et `app/api/offers/[id]/stats/route.ts`, écrans `app/(buyer)/besoins/[id]/offres/[offerId]/page.tsx` et
`components/vendor/offer-stats.tsx`, modules purs `lib/client/metrics-view.ts`. Tests : `npm run test:metrics` (dont l'arrondi, les statistiques sur base),
`test:metrics-adversary` (l'adversaire), `test:metrics-http`, `test:metrics-purge`, `test:client`, `test:boost-pricing`, `test:boost-quotes`, `test:boost-http`, `e2e:core` et `e2e:ui`.


## Définitions exactes

Un « acheteur » est un compte (le propriétaire d'un besoin) : **deux besoins du même acheteur comptent pour un seul acheteur** dans tous les
comptes d'acheteurs uniques. Les jours sont des **jours UTC**.

| Terme | Définition exacte | Source |
| --- | --- | --- |
| **Besoins correspondants** | Besoins dont la correspondance avec l'annonce est confirmée ET fraîche **à la lecture** (même prédicat que `stored-matches`). Un instantané, pas une période ; des besoins, pas des acheteurs. | `matching_evaluations` |
| **Apparition servie** | Une page de résultats (tri par pertinence, sens besoin) a servi l'annonce à un acheteur **pendant qu'elle avait un boost effectif**. | `boost_exposures` (0013) |
| **Acheteur exposé** | Acheteur à qui l'annonce a été servie au moins une fois dans la période. « Exposé sponsorisé » : au moins une apparition avec gain de places. | `boost_exposures` |
| **Ouverture** | Une lecture **réussie** de la fiche par l'acheteur, dans le contexte de l'un de ses besoins : la page a été **servie**. Ce n'est **pas** la preuve qu'elle a été lue. | `offer_views` |
| **Acheteur unique ayant ouvert** | Acheteur distinct ayant au moins une ouverture dans la période. | `offer_views` |
| **Contact** | Une révélation du numéro vérifié du vendeur à l'acheteur. « Contact unique » : acheteur distinct ayant au moins un premier contact dans la période (jour du premier contact). « Révélation » : chaque nouvel appui, premier ou non. | `offer_contacts` |
| **Attribué au boost** | Voir « Attribution ». Tout le reste est **organique**. | |

**Une vente n'est pas mesurée** : aucun mot, colonne ni écran ne parle de vente dans ce lot (une vente déclarée reste distincte d'une transaction
confirmée, §6 de l'audit ; elle viendra avec son propre lot).

### Taux : par période et par boost (lot M1-quater)

Chaque taux est un **pourcentage arrondi à la dizaine de pour cent** (« environ 70 % »), **calculé sur les deux nombres PUBLIÉS** (déjà arrondis), jamais sur les valeurs exactes, et **publié seulement si les deux nombres
publiés valent au moins 10** (au moins 9 comptes exacts : 9 → « environ 10 ») ; sinon la réponse est `{ "kind": "insufficient" }` et l'écran dit « pas assez d'acheteurs pour un pourcentage ». Pourquoi sur les nombres publiés : un
pourcentage calculé sur les valeurs exactes **laisse retrouver une différence de 1 à 4 acheteurs** (exemple démontré par l'adversaire : 12 acheteurs servis dont 11 ont ouvert → « environ 10 », « environ 10 » et « 90 % » ne laissent
qu'une valeur possible à la différence, 1 ; la règle initiale de la décision, « ratios sur les valeurs exactes arrondis à la dizaine », échoue ainsi sur des mondes tirés au hasard ; un seuil de dénominateur plus élevé n'y change rien : l'analyse de deux comptes emboîtés
(couples jusqu'à 80) trouve 6 à 12 différences retrouvées sur 314 pour six seuils essayés, de 10 à 30, et aucune avec les nombres publiés). Une fonction des seuls chiffres publiés n'apprend rien de plus à qui les lit (post-traitement).
Précision : un pourcentage peut s'écarter du taux exact (jusqu'à 23,5 points sur 2 000 mondes réalistes de 10 à 30 acheteurs, 7,2 points en moyenne : « environ 80 % » pour 75 %, 100 % pour 11 sur 12).

| Taux | Numérateur | Dénominateur | Existence |
| --- | --- | --- | --- |
| `openRate` d'une période | acheteurs qui ont ouvert ET à qui l'annonce a été servie (pendant un boost) dans la période | acheteurs à qui l'annonce a été servie dans la période | `null` quand aucun boost ne peut avoir servi l'annonce dans la période (donc sans boost) |
| `contactRate` d'une période | acheteurs qui ont contacté ET ouvert dans la période | acheteurs qui ont ouvert dans la période | toujours (les contacts passent par la fiche) |
| `openRate` d'un boost | acheteurs dont une ouverture est **attribuée à ce boost** | acheteurs servis **sponsorisés** par ce boost | `null` pour un boost qui n'a pas commencé |
| `contactRate` d'un boost | acheteurs dont un contact est **attribué à ce boost** | acheteurs servis **sponsorisés** par ce boost | `null` pour un boost qui n'a pas commencé |

Les numérateurs sont des sous-ensembles de leurs dénominateurs par construction (l'attribution exige une apparition SPONSORISÉE ; on ne compte que les acheteurs présents dans les deux ensembles de la période) : un taux ne dépasse jamais 100 %.
Les recoupements des taux par période (`openerBuyersExposed`, `contactBuyersOpened`) sont comptés par la requête `readPeriod` ; ils ne sont publiés que par ces pourcentages.

### Périodes

`7d` et `30d` = les 7 ou 30 derniers jours UTC, **aujourd'hui compris** (premier jour : aujourd'hui − 6 ou − 29, renvoyé dans `since`) ; `all` = tout
l'historique conservé (400 jours au plus, voir « Rétention »). Une ouverture se range par son jour, une apparition par son jour servi, un contact par le jour
de son **premier** contact. **Rien n'existe avant la création de l'annonce** : pour une annonce de 5 jours, 7 jours, 30 jours et « depuis la publication » ont les MÊMES chiffres.
Une période n'a de ligne d'exposition, de part attribuée et de taux d'ouverture que si un boost de l'annonce a pu servir (ou attribuer) dans cette période : sinon `null` (voir `stats.ts`, `canServe` et `canAttribute`).

## Arrondi des comptes publiés (lot M1-quater)

### Ce que l'arrondi protège, et ce qu'il ne protège pas

**Modèle de menace.** Le vendeur ne reçoit **jamais** une identité d'acheteur : ni nom, ni téléphone, ni identifiant de compte ou de besoin. Il voit déjà chaque
**besoin correspondant** à son annonce (budget, lieu : c'est le produit, la liste « Acheteurs intéressés »), et un acheteur qui le contacte l'appelle directement.
L'arrondi protège ceci, et seulement ceci : **une statistique PUBLIÉE ne décrit jamais un petit nombre d'acheteurs (0 à 4) précisément, ni seule, ni par différence entre chiffres emboîtés publiés au même moment** (une seule réponse lue ;
l'adversaire, ci-dessous, le démontre sur des mondes de 1 à 30 acheteurs). Il ne protège **pas** :

- contre **l'observation répétée dans le temps sur un très petit périmètre** : la différence entre deux LECTURES successives n'est pas traitée (documenté, assumé). Un vendeur qui rafraîchit sa page peut voir un
  « moins de 5 » devenir « environ 5 » (le cinquième acheteur est arrivé), ou un « environ 5 » devenir « environ 10 » : il apprend QU'un acheteur de plus est arrivé à un seuil d'arrondi, jamais QUI, ni ce qu'il a fait. Avec un
  seul besoin correspondant, c'est l'action de cet acheteur qui se devine alors par l'horaire (K3) ; le vendeur voit déjà ce besoin et peut appeler l'acheteur qui le contacte ;
- contre un **vendeur qui crée ses propres comptes acheteurs** (attaque sybille, K4) : l'application ne peut pas distinguer ces comptes. Chaque compte exige un numéro de téléphone **vérifié par code OTP** ; avec quelques comptes
  le vendeur franchit les seuils à volonté, et avec un compte sybille qui contacte son annonce il retrouve par soustraction le nombre d'acheteurs réels à l'arrondi près. L'arrondi renchérit cette attaque, il ne l'empêche pas ;
- les **mondes que l'adversaire n'énumère pas** (taille, comportements d'acheteur, nombre de boosts : voir « Ce que l'adversaire prouve ») ;
- **la liste des besoins** elle-même : elle reste affichée, anonyme (budget, lieu), même pour un ou deux besoins : c'est le produit. Depuis le lot D3 **aucun compte n'est affiché au-dessus de la liste** (le titre arrondi « Environ 10 besoins… » contredisait les lignes visibles) ; seul le chiffre `activeMatches.needs` des statistiques est arrondi. L'arrondi protège les **statistiques** (apparitions, ouvertures, contacts, ventes), pas la liste, qui montre les besoins un par un, sans identité ;
- **le prix d'un devis à partir de 6 acheteurs** (voir « Devis ») : le facteur demande est fonction du nombre exact de 6 acheteurs et plus, même quand le compte publié est « environ 5 ».

### Règle R1 : comptes d'acheteurs uniques ET comptes d'événements

Aucun compte exact n'est jamais publié dans les statistiques du vendeur ni dans les devis. Un compte (acheteurs uniques, ou événements : apparitions, ouvertures, révélations) est publié :

| Compte exact | Publié | Forme (JSON) |
| --- | --- | --- |
| 0, 1, 2, 3 ou 4 | « moins de 5 » (zéro compris) | `{ "kind": "below", "bound": 5 }` |
| 5, 6, 7 ou 8 | « environ 5 » | `{ "kind": "approx", "value": 5 }` |
| 9 à 12 | « environ 10 » | `{ "kind": "approx", "value": 10 }` |
| 13 à 17 | « environ 15 » | `{ "kind": "approx", "value": 15 }` |
| au-delà | le multiple de 5 le plus proche (la moitié arrondie vers le haut) : 18 à 22 → 20, 23 à 27 → 25… | `{ "kind": "approx", "value": N }` |

**Écart à la décision : la première tranche va de 5 à 8** (la décision disait « le multiple de 5 le plus proche », donc 8 → 10). Pourquoi : deux comptes « moins de 5 » valent au plus 4 + 4 = 8 ; si 8 était publié « environ 10 »
(8 à 12), **un total « environ 10 » dont deux parties sont « moins de 5 » donnerait 4 et 4 EXACTEMENT**. L'adversaire l'a trouvé (sur des mondes tirés au hasard, puis sur un monde construit) : 8 acheteurs qui ont ouvert, 4 attribués au boost et 4 organiques ; ou 4 ouvreurs attribués pour chacun de deux boosts
(le total attribué « environ 10 », les deux boosts « moins de 5 » : tous les 4 se retrouvent). Avec 8 dans la première tranche, **aucun total publié ne borne ses parties d'en bas, jusqu'à 6 parties « moins de 5 »** (un total de 4k vaut au plus
4k, et la tranche qui le contient commence toujours sous 4k tant que k ≤ 6 ; à 7 parties 28 s'arrondit à 30, la tranche « 28 à 32 » commence à 28 : la limite). L'erreur d'un « environ N » est donc d'au plus 3 (5 à 8 → 5) puis 2 ;
le test `tests/server/metrics-adversary.test.ts` (« TÉMOIN : l'arrondi au plus proche… ») rejoue la règle initiale et la met en échec. C'est la règle la plus simple trouvée qui garde l'utilité (les parts attribuées de 5 ou plus restent publiées) : l'arrondi
aléatoire déterministe par cellule exigerait un secret serveur et rendrait les chiffres de deux lectures incohérents ; une base plus grande (10) ferait perdre « environ 5 » (6 contacts, 5 attribués).

La **part organique** (total moins part attribuée) et la **part attribuée** sont toutes deux publiées (R3) ; le total moins la part attribuée est une différence de deux chiffres emboîtés que l'adversaire protège (au moins deux valeurs possibles).

Les chiffres que le vendeur ne lit plus : `bestPosition`, `bestGain` et `activeDays` ne sont **pas** publiés (la meilleure place d'UNE page d'acheteur) ; ils restent dans la commande d'administration `boost:stats`, qui reste **brute** (comme `readOfferBoostExposureStats`).

### Devis (R5)

`inputs.compatibleBuyers` et `inputs.reachableBuyers` des devis suivent la même règle (0 compris : « moins de 5 » ; le motif `no_compatible_buyer` ou `no_visible_effect` dit l'absence d'acheteur ou d'effet). Contrat `boost-quote/v2`
(`BOOST-HTTP.md`). La cotation enregistrée garde le compte EXACT (c'est l'entrée du prix, pour l'administration), seul le DTO l'arrondit. Le **facteur demande** du prix utilise D' = 5 pour 1 ≤ D ≤ 5 (le prix est identique de 1 à 5 acheteurs), D' = 0
pour 0 (aucun prix), D' = D au-delà (`BOOST-PRICING.md`). **Limite assumée** : à partir de 6 acheteurs, le prix reste fonction du nombre exact (`demandMilli = 1500` ⇒ D = 6) : le prix laisse retrouver D dès 6, même quand le compte publié est
« environ 5 » ; ce que le prix ne donne jamais, c'est un nombre de 1 à 4 acheteurs, ni la différence entre 1 et 5. La commande `boost:stats` et `readOfferBoostExposureStats` restent **brutes** (administration).

### Besoins correspondants (R6)

`activeMatches.needs` suit R1 (le contrat de l'API le porte toujours ; **lot D3-bis : la page d'une annonce ne l'affiche plus**, ni au-dessus de la liste ni dans la section « Ce que produit votre annonce » : la liste fait foi). **Lot D3** : l'écran « Acheteurs intéressés » n'affiche plus de titre arrondi au-dessus de la liste (« Moins de 5 besoins… », « Environ 10 besoins… », « Au moins N besoins… » sont supprimés) : une phrase dit « Chaque ligne est le besoin d'un acheteur, sans son identité. », « Voir plus » charge la suite (il n'apparaît qu'au-delà de 20 besoins : la liste se lit par pages de 20), « Aucun besoin d'acheteur ne correspond pour le moment » s'affiche pour 0. La **liste des besoins reste affichée** (budget, lieu : c'est le produit).

**Tableau de bord du vendeur (lot D3)** : le total « environ N besoins d'acheteurs correspondent à vos annonces en ligne » (le tableau de bord n'a pas de liste, il garde ce compte) compte les besoins **distincts** (un besoin qui correspond à plusieurs annonces semblables du vendeur compte une fois : 10 couples pour 2 besoins se publient « moins de 5 »), arrondi comme les autres mesures ; le compte par annonce est celui de sa propre liste, arrondi.

### Écran (R7)

Textes en clair : « moins de 5 », « environ 15 », « environ 70 % », « pas assez d'acheteurs pour un pourcentage ». Une phrase : « Pour protéger les acheteurs, les chiffres sont arrondis à 5 près et les petits nombres ne sont pas détaillés. »
Quand les ouvertures, les contacts et les apparitions de tout l'historique sont tous « moins de 5 », l'écran dit « Encore peu d'activité : les petits nombres ne sont pas détaillés. ». Plus aucun « moins de 3 » nulle part ; le seuil `privacyThreshold` n'existe plus
dans la réponse (chaque compte porte sa propre borne).

### Ce que l'adversaire prouve (`tests/server/metrics-adversary*.ts`, `npm run test:metrics-adversary`)

Le test **n'importe rien de `privacy.ts`** : seulement la fonction de publication (`buildOfferStats`, via un adaptateur) et un générateur de mondes. Il pose un adversaire qui lit **une seule réponse** (la réponse JSON complète) et connaît tout ce que sait le vendeur : ses boosts
et leurs dates, la date de lecture, les règles d'attribution, la définition de chaque chiffre et la règle d'arrondi.

- **Un monde** est un multiensemble d'acheteurs ; chacun est décrit par ses événements atomiques sur quatre jours (il y a 45, 10, 5 et 1 jours) : apparitions servies pendant les jours d'un boost (aucune, 1 non sponsorisée, 1 sponsorisée, 2 non sponsorisées,
  2 dont 1 sponsorisée, 2 sponsorisées, par boost et par jour), **au plus une ouverture par jour** (organique ou attribuée à un boost éligible) et **au plus un contact** (un jour, organique ou attribué, 1 ou 2 révélations). **Neuf structures** : sans boost ;
  1 boost ancien, entre 7 et 30 jours, récent, à cheval sur 30 jours et 7 jours ; 2 boosts (jours 10 et 5, ou 45 et 1) ; une annonce de 6 jours avec un boost récent ; une annonce de 20 jours. De 83 à 11 987 profils d'acheteurs distincts par structure ;
  chaque monde a 16 chiffres par période (dont les deux recoupements des taux) et 8 par boost.
- **Mondes vrais** : 1 080 mondes de 1 à 6 acheteurs et 1 080 mondes de 7 à 30 acheteurs par passage de la suite (9 structures × 120 × 2 familles, graine fixe), plus des mondes construits (le jeu K1 de l'audit, des totaux de 6 à 13 acheteurs, deux boosts de 4 ouvreurs, le cas « 12 exposés dont
  11 ont ouvert »), plus 6 passages hors suite de 7 200 mondes (voir « Passages longs »). Les mondes vrais ne sont pas **saturés** : un monde où chaque acheteur a ouvert tous les jours (borne du modèle : une ouverture par jour, deux révélations) ou dont une zone « a sans b »
  (période longue moins courte) atteint cette borne est écarté, parce que cette borne est une propriété du modèle que l'adversaire réel n'a pas (une ligne `offer_views` compte plusieurs ouvertures d'un même jour).
- **Critère (a)** : pour **chaque chiffre du modèle de valeur vraie 1 à 4** (acheteurs ou événements, publié ou non) **et chaque différence de deux chiffres emboîtés de valeur vraie 1 à 4** (total moins part, période longue moins courte, total moins boost), il existe au moins
  **deux mondes qui publient exactement la même réponse** et lui donnent deux valeurs différentes (des **témoins**, vérifiés en rejouant la publication). Aucun 1, 2, 3 ou 4 exact ne se déduit donc d'une réponse. Recherche : marche « min-conflits » dans l'ensemble des mondes cohérents (chaque compte publié
  borne la valeur exacte à un intervalle : « moins de 5 » : 0 à 4, « environ 10 » : 9 à 12), jusqu'à 36 acheteurs ; une quantité sans témoin après 3 passes (30 000, 150 000 puis 300 000 mondes évalués) est « non résolue » et compte comme un **échec** (jamais comme une preuve de sûreté).
- **Critère (b), témoins qui échouent** : (1) la publication du lot M1-bis (copie figée) échoue toujours à ce test par identités linéaires exactes (`all.openersOrganic = 1`, `all.opensOrganic = 1`, `all.openersAttributed = 3`, `all.opensAttributed = 6` sur le jeu K1), sur une large part des mondes à boost et sur tous les mondes sans boost ;
  (2) **l'arrondi au plus proche sans la tranche 5 à 8** (la règle initiale) échoue sur deux boosts de 4 ouvreurs (les deux valeurs 4 se retrouvent) ; (3) **le pourcentage calculé sur les valeurs exactes** (la règle initiale R2) échoue sur « 12 exposés dont 11 ont ouvert » (la différence 1 se retrouve) et sur 11 mondes tirés au hasard sur 1 200 de 10 à 16 acheteurs ; la production réussit sur chacun de ces mondes.
- **Critère (c), utilité** : sur 2 000 mondes réalistes de 10 à 30 acheteurs (tous servis sponsorisés ou 30 à 90 % seulement, toute l'activité dans les 7 derniers jours), la part attribuée au boost (ouvreurs, ouvertures, contacts, par période et par boost) est publiée « environ N » dans **100 %** des cas où elle vaut au moins 5 (9 640 parts sur 9 640),
  et les taux sont publiés dans 100 % des cas où leurs deux termes valent au moins 10 (3 017 sur 3 017). Le cas de l'audit (16 ouvreurs dont 12 attribués, 6 contacts dont 5 attribués, 20 acheteurs servis dont 17 sponsorisés) : « environ 15 » ouvreurs, « environ 10 » attribués, « environ 5 » contacts,
  « environ 5 » contacts attribués, taux d'ouverture « environ 80 % » (période) et « environ 70 % » (boost), taux de contact « pas assez d'acheteurs pour un pourcentage ».
- **Passages longs, hors suite** (`NOMA_ADVERSARY_SEED=n NOMA_ADVERSARY_WORLDS=400 npm run test:metrics-adversary`) : les graines 1 à 6 (7 200 mondes chacune, 3 600 de 1 à 6 acheteurs et 3 600 de 7 à 30 acheteurs : **43 200 mondes, 3 494 016 quantités protégées examinées**) sont toutes certifiées (aucune quantité sans second témoin). Sondes : `NOMA_ADVERSARY_ZEROS=1` protège aussi les valeurs vraies de 0 ; elle **n'est pas revendiquée** (un monde de 25 acheteurs dont 17 contacts attribués
  et 8 organiques laisse le zéro organique non résolu en 3 passes).
- **Ce qui n'est PAS prouvé** : les **lectures successives** ; la **sybille** ; les mondes de **plus de 30 acheteurs** (l'adversaire cherche jusqu'à 36 acheteurs ; l'analyse des totaux de 6 parties s'étend, sans test, à des mondes de toute taille : le total d'au plus 4k n'est jamais borné d'en bas tant que k ≤ 6) ;
  des comportements d'acheteur **hors du modèle** (plusieurs ouvertures le même jour, plusieurs contacts sur des besoins différents, plus de 2 révélations ou de 2 apparitions par jour et par boost, événements à d'autres jours que les quatre testés) ; **plus de 2 boosts** (l'adversaire n'en énumère pas davantage ; le raisonnement vaut jusqu'à 6 parties) ;
  les groupes dérivés autres que la différence de deux cellules emboîtées (unions, intersections de trois cellules) ; **le prix d'un devis à partir de 6 acheteurs** (fonction du nombre exact). La preuve par témoins est exacte pour chaque monde testé et jamais pour « tous les mondes » : un adversaire plus riche que ce modèle n'est pas exclu.

## Fiche d'une annonce (acheteur) — `GET /api/demands/{id}/offers/{offerId}`

**Accès** : réservé au propriétaire du besoin, besoin **actif**, et seulement si l'annonce figure dans **ses** correspondances confirmées et fraîches (même
prédicat et même fenêtre de lecture que `stored-matches`, `readStoredOfferForDemand`). Dans **tous** les autres cas — autre acheteur, besoin d'autrui, besoin clos
(brouillon, satisfait, archivé), annonce hors correspondances, annonce en pause, vendue ou archivée, évaluation périmée, vendeur lui-même, annonce ou besoin
inconnus — la réponse est le **même 404** (`resource_not_found`, corps identique, testé octet pour octet) : on ne peut pas parcourir les annonces hors correspondance.
(Un besoin n'a pas de statut « en pause » dans le modèle : `draft`, `active`, `satisfied`, `archived` ; seul `active` donne accès.)
Une annonce confirmée et fraîche mais au-delà des 200 correspondances triées est servie quand même (`sponsored` faux).

**DTO** (`contractVersion: "demand-offer/v1"`, liste blanche) : `item` (l'élément de correspondance **exactement tel que la liste des résultats le sert** : fiche produit épurée —
catégorie, marque, modèle, variante, état, quantité, localisation, prix, disponibilité —, compatibilité, indicateurs en clair, pertinence, `sponsored`), `details.createdAt`
et `details.attributes`, `readAt`. **Jamais** : identifiant ou téléphone du vendeur, texte brut de l'annonce (la description peut contenir un numéro), métadonnées d'extraction,
identifiant de boost, identifiant d'un tiers. `sponsored` est **relu** : le placement est recalculé à chaque lecture (pertinence, boosts effectifs, quota, ancienneté, même
fonction `applyBoost` que la liste), jamais déduit d'un paramètre du client ; la lecture de la fiche n'ajoute aucune apparition au journal d'exposition.

**Attributs publics** : clés simples (`[A-Za-z][A-Za-z0-9_]{0,39}` : forme historique conservée à l'affichage ; depuis le lot D3, la PUBLICATION n'accepte plus que `[a-z_]` : un nom comme « tel_0708 » est refusé, mais une annonce enregistrée avant le lot D3 avec une clé de l'ancienne forme reste affichée, ses valeurs étant contrôlées), valeurs scalaires (texte de 80 caractères au plus sans caractère de contrôle ou de direction,
nombre, booléen) ou `{ value, unit }` ; 12 au plus, ordre alphabétique ; **tout texte qui ressemble à un numéro de téléphone est écarté** (règle du lot D3, section « Numéros de téléphone » ci-dessous ; une date `2026-10-06` reste). **Photos** : le modèle d'annonce n'a pas de photo (aucune colonne) ; le DTO n'en porte donc pas et l'écran montre la
vignette neutre. **Date** : `createdAt` est la date de **création** de l'annonce ; le modèle ne conserve pas de date de mise en ligne distincte (écran : « Annonce du … »).

## Ouvertures — `offer_views`

Chaque lecture réussie de la fiche est enregistrée côté serveur **APRÈS l'envoi de la réponse** (`after()` de `next/server`, le mécanisme officiel de Next.js :
`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md` ; avec `next start`, il est entièrement pris en charge), dans une transaction courte et séparée (`statement_timeout` 2 s), en UN
`INSERT … ON CONFLICT (offer_id, demand_id, viewed_day) DO UPDATE` : une ligne par annonce, besoin et jour UTC, `views` + 1 à chaque lecture (la déduplication par jour est donc
celle des **lignes** ; les acheteurs uniques se comptent à part). Colonnes : `viewer_id`, `views`, `boosted_views`, `boost_id`, `first_at`, `last_at`.

- **Le vendeur n'est jamais compté** : l'écriture ne s'applique que si l'acheteur est le propriétaire du besoin ET n'est pas le propriétaire de l'annonce (la fiche répond d'ailleurs 404 au vendeur).
- **Un journal en panne ne casse jamais la fiche** : toute erreur (table absente `42P01`, délai `57014`, verrou, erreur inattendue) est attrapée ; seul un **code** est journalisé
  (`[metrics-http] offer_view_ignored_<code>`), jamais un message, **un seul code par ouverture perdue**. La réponse est identique avec ou sans journal (testé par comparaison avec une réponse témoin) et
  **ne dépend plus du journal** : une table `offer_views` verrouillée ne retarde plus la fiche (la fiche répondait en 2 s avant le lot M1-bis ; elle répond en moins de 300 ms, testé), et l'écriture
  qui suit reste plafonnée à 2 s. L'ouverture est écrite dès que le verrou tombe si le délai le permet ; sinon elle est abandonnée avec le code `57014`. Une ouverture perdue n'est pas rejouée : le journal est un compteur.
  Le planificateur est injectable (`schedule` de `createMetricsHttpHandlers`) : les essais `node:test` n'ont pas de requête Next (`after()` y lève « called outside a request scope ») ; la route réelle utilise
  `after()` par défaut (`scheduleAfterResponse`), et si `after()` lève, la fiche répond quand même et un code est journalisé.

## Attribution au boost

Une ouverture ou un contact est attribué au boost du journal d'exposition **qui a servi cette annonce SPONSORISÉE à ce besoin dans les 7 jours précédents**
(`sponsored_servings > 0`, `first_served_at ≥ maintenant − 7 jours`, `readAttributedBoostId`) ; plusieurs boosts : celui servi le plus récemment ; le boost n'a pas besoin d'être encore actif
(l'acheteur l'a vu sponsorisé dans la fenêtre) ; sinon NULL = organique. Un acheteur qui n'a jamais vu l'annonce sponsorisée (autre besoin, apparition non sponsorisée, plus de 7 jours) est organique.

- **Fenêtre sûre** : le journal d'exposition range une ligne par boost, besoin et jour ; la borne retenue est la **première** apparition de la ligne du jour. L'apparition sponsorisée a eu lieu à
  cet instant ou après : si la borne est dans la fenêtre, l'apparition l'est certainement. Conséquence : au plus **un jour** de sous-attribution à la limite de la fenêtre, jamais de sur-attribution.
- **Ouvertures** : attribution à CHAQUE ouverture (`boosted_views` compte les ouvertures attribuées d'une ligne du jour, `boost_id` garde le dernier boost attribué). Un acheteur est « attribué » dans
  une période s'il a au moins une ouverture attribuée, « organique » sinon : les deux parts forment une partition des acheteurs.
- **Contacts** : attribution **au premier contact seulement** ; un nouveau contact ne la change jamais.

## Contact — `POST /api/demands/{id}/offers/{offerId}/contact`

Corps vide (ou `{}`). **L'origine est vérifiée AVANT la session** (403 sans cookie, comme les autres POST), puis la session (401), les identifiants et le corps (400).
Même contrôle d'accès que la fiche, avec une nuance voulue : une annonce **en pause, retirée ou vendue** que cet acheteur avait parmi ses correspondances confirmées (même si le worker a
déjà périmé l'évaluation) répond **409 `offer_not_available`** (rien n'est révélé ni écrit) ; une annonce jamais correspondante reste 404, de même qu'un besoin clos ou un vendeur qui se contacte lui-même.
**Choix assumé (M4)** : la fiche répond 404 dans ce même cas, mais le contact garde le 409, parce qu'il aide l'acheteur qui avait déjà vu l'annonce à comprendre qu'elle n'est plus disponible (au lieu
d'un « introuvable » qu'il prendrait pour une panne). **Portée** : le 409 n'est servi qu'à un acheteur qui a eu **cette annonce parmi ses propres correspondances confirmées**, jamais à un autre compte ;
il révèle donc seulement que l'annonce n'est plus en ligne pour quelqu'un qui la connaissait déjà, sans numéro ni identité. Il distingue « annonce passée par ses correspondances puis retirée » de « jamais
correspondante » (404) : c'est la seule information en plus.

Réponse 200 (`contractVersion: "offer-contact/v1"`) : le numéro **vérifié** du vendeur (E.164) et deux liens reconstruits depuis ce numéro, `tel:<numéro>` et `https://wa.me/<chiffres>` ;
`Cache-Control: no-store` partout, et l'écran ne garde le numéro qu'en mémoire de la page (aucun stockage navigateur). Un vendeur sans numéro vérifié : 409 `contact_unavailable`, rien d'écrit.
Message d'écran : « Le vendeur verra que vous l'avez contacté via noma. » — le vendeur voit un compteur, jamais l'identité de l'acheteur.

`offer_contacts` : une ligne unique par (annonce, besoin) : `viewer_id`, `boost_id` (au premier contact), `reveals`, `first_contact_at`, `last_contact_at`.

**Limite** : au plus **20 vendeurs DISTINCTS** révélés **pour la première fois** par acheteur et par jour UTC → **429 `rate_limited`** (message simple, `Retry-After` = secondes jusqu'à minuit UTC).
**Portée réelle contre la récolte de numéros (M3)** : la limite est **par compte vérifié et par jour UTC**, pas par personne. La récolte de numéros croît donc **proportionnellement au
nombre de comptes**, chaque compte exigeant un **numéro de téléphone vérifié par code OTP** : 1 compte = 20 vendeurs par jour, 20 comptes = 400 numéros par jour. De plus, le jour UTC se
renouvelle à minuit : un compte peut révéler 20 vendeurs à 23 h 59 UTC puis 20 autres à 00 h 00 UTC (40 en deux minutes). Aucune limite par appareil, par adresse réseau ni par
personne n'existe dans ce lot ; ce choix est assumé (le coût d'un compte est celui d'un numéro vérifié) et noté dans « Limites ».
Un vendeur déjà révélé à cet acheteur (cette annonce, ou une autre annonce du même vendeur) l'est de nouveau **sans compter** ; un autre acheteur n'est pas touché. La limite est **exacte sous
concurrence** (verrou consultatif par acheteur, espace `1_314_664_954` : 25 demandes simultanées donnent exactement 20 succès et 5 refus, testé).

## Statistiques du vendeur — `GET /api/offers/{id}/stats`

Réservée au propriétaire (**404** pour l'annonce d'un autre et pour une annonce inconnue, réponse identique). `contractVersion: "offer-stats/v1"` (jamais publié avant ce lot : la forme est celle de M1-quater), un seul instantané en lecture seule :
`activeMatches.needs` (compte arrondi : « moins de 5 » de 0 à 4, sinon « environ N »), `periods` (`7d`, `30d`, `all` dans cet ordre), `boosts` (20 au plus, du plus récent au plus ancien ; **vide sans boost**). **Plus de `privacyThreshold`** : chaque compte porte sa propre forme (`{ "kind": "below", "bound": 5 }` ou `{ "kind": "approx", "value": N }`).

Par période : `exposure` (apparitions, apparitions sponsorisées, acheteurs exposés, acheteurs exposés sponsorisés ; **`null`** quand aucun boost ne peut avoir servi l'annonce dans la période, donc **toujours `null` sans boost**), `opens` (total, acheteurs uniques,
**attribuées au boost**, **organiques** ; les deux parts valent **`null`** quand aucun boost ne peut avoir attribué une ouverture : tout est organique), `contacts` (acheteurs uniques, révélations, attribués, organiques ; mêmes `null`) et `ratios` (`openRate`, `null` sans boost qui ait pu servir ; `contactRate`, toujours présent : `{ "kind": "percent", "value": 70 }`
ou `{ "kind": "insufficient" }`).
Par boost : `exposure` (apparitions, apparitions sponsorisées, acheteurs exposés, exposés sponsorisés), `attributed` (ouvertures, ouvreurs, contacts, révélations attribués) et `ratios` (`openRate`, `contactRate`) ; `exposure`, `attributed` et les deux taux valent `null` pour un
boost qui n'a pas commencé. **Plus de meilleure place, de gain maximal ni de jours actifs.** **Aucun `viewer_id`, aucun identifiant de besoin ou d'acheteur, aucun téléphone** n'est lu ni renvoyé (testé sur la sortie brute), et **aucun nombre nu** : tout nombre de la réponse est une borne (5), un compte arrondi (multiple de 5) ou un pourcentage (multiple de 10)
(testé sur la sortie brute, par la couche HTTP, par la couche cliente et par `e2e:core`). Le serveur lit l'instant de la lecture (horloge de la base) pour placer chaque boost sur la ligne du temps ; il ne sort pas.

**L'exposition n'est journalisée que pendant un boost** (`BOOST-METRICS.md`) : sans boost, **aucune ligne d'exposition n'existe** ; les ouvertures et les contacts, eux, sont mesurés avec ou sans boost.

Écran « Ce que produit votre annonce » (`/vendeur/annonces/[id]`, `components/vendor/offer-stats.tsx`) : mots simples, trois périodes, bloc « Par boost » (absent sans boost : « Aucun boost sur cette annonce : tout est organique. », et aucune phrase sur l'attribution ni l'exposition), une phrase qui explique l'attribution
(« Les ouvertures et les contacts sont attribués au boost seulement si l'acheteur avait vu votre annonce sponsorisée dans les 7 jours qui précèdent… », avec un boost seulement), une phrase sur l'exposition (comptée pendant un boost seulement), une sur le sens d'« ouverture » (page servie, pas lue ; aucune vente mesurée)
et une sur l'arrondi (« Pour protéger les acheteurs, les chiffres sont arrondis à 5 près et les petits nombres ne sont pas détaillés. »). Un boost qui n'a pas commencé : « Ce boost n'a pas encore commencé : rien à mesurer pour le moment. ».

## Rétention — `npm run metrics:purge`

`boost_exposures`, `offer_views` et `offer_contacts` ne sont conservés que **400 jours**. `npm run metrics:purge` est une **simulation** (compte, ne supprime rien) ; `npm run metrics:purge -- --apply`
supprime, par lots de 5 000 lignes, les lignes dont le **jour UTC** (jour servi, jour d'ouverture, jour du **dernier** contact) précède aujourd'hui − 400 jours : une ligne de 400 jours pile est gardée, celle de 401 jours
est supprimée (testé aux bornes 399 / 400 / 401 jours dans chaque table). Tout autre argument, répété ou mal écrit, est refusé (code 1) sans rien supprimer. La commande ne s'exécute que si **`NODE_ENV` est
absent, `development` ou `test` (casse exacte)** : toute autre valeur (`Production`, `PRODUCTION`, `prod`, `staging`, vide…) est **refusée, simulation comprise**, même avec la variable de production ; seul
`NODE_ENV=production` avec **`NOMA_METRICS_PURGE_PRODUCTION=1`** est permis (sans elle : refus, simulation comprise). `DATABASE_URL` est obligatoire ; aucun message brut, et la valeur reçue n'est jamais répétée. **Les statistiques agrégées ne sont pas conservées au-delà** : elles sont recalculées
à la demande depuis ces lignes, donc elles disparaissent avec elles (« depuis la publication » = tout ce qui reste dans la fenêtre de 400 jours). Les index de purge (`served_day`, `viewed_day`, `last_contact_at`) sont dans la migration 0018.

## Réserve du lot précédent (D6) : revérification de la portée d'un devis réutilisé

La revérification de la portée faite quand un devis « disponible » est réutilisé (lot P3-bis) garde en mémoire **10 s par devis** le résultat « atteignable » (jamais « non atteignable » ni « indéterminé » :
ils ne sont pas retenus), et les revérifications **réellement calculées** comptent dans une limite de **60 par vendeur et par minute** (fenêtre glissante) : au-delà, `rate_limited` (429, message des devis).
Mémoire et compteurs sont **par processus** (comme le créneau de calcul de portée qu'ils protègent) et bornés (5 000 entrées) ; une relance du serveur les remet à zéro (`lib/server/boost/recheck-guard.ts`).
La cotation d'un devis **neuf** garde sa limite de 20 par minute. Les essais d'avant le lot, qui enchaînent des revérifications du même devis en changeant le monde entre deux, reçoivent une garde sans mémoire.

## Migration 0018

`offer_views` et `offer_contacts` (clés `(offer_id, demand_id, viewed_day)` et `(offer_id, demand_id)`, `ON DELETE CASCADE` des annonces, besoins et comptes ; `boost_id` en `ON DELETE SET NULL`),
CHECK : `views ≥ 1`, `0 ≤ boosted_views ≤ views`, `reveals ≥ 1`, `last ≥ first` ; index de lecture du vendeur `(offer_id, jour)`, d'attribution `(boost_id)`, de la limite quotidienne `(viewer_id, first_contact_at)` et de purge ;
index `idx_boost_exposures_served_day` sur le journal de 0013 (aucune colonne ni donnée de 0013 n'est modifiée). Additive : elle n'est requise que par ces routes ; le matching et le boost ne la lisent pas.

## Limites

- **« Ouverture » = page servie**, pas lecture prouvée : plusieurs onglets ou rafraîchissements montent `views` (les acheteurs uniques sont comptés à part).
- **Aucune vente** n'est mesurée ; aucun favori, aucune conversation, aucune impression « réellement visible ».
- **Exposition journalisée seulement pendant un boost** ; une annonce non boostée n'a ni apparitions ni acheteurs exposés dans les statistiques (la réponse n'a alors aucune ligne d'exposition).
- **Observation répétée** : la différence entre deux lectures successives sur un très petit périmètre n'est pas traitée, ni le **vendeur qui crée ses propres comptes acheteurs** (voir « Ce que l'arrondi protège, et ce qu'il ne protège pas »). **Aucune détection de fraude** :
  deux comptes d'une même personne comptent pour deux acheteurs. La divulgation entre chiffres publiés au même moment est, elle, traitée et prouvée contre l'adversaire décrit plus haut, **dans les limites de cet adversaire** (mondes de 30 acheteurs au plus testés, quatre jours, au plus 2 boosts, un comportement d'acheteur par jour borné).
- **Un pourcentage est approximatif** : calculé sur des nombres déjà arrondis (écart moyen de 7 points, jusqu'à 24 sur les mondes réalistes testés) ; pour de petits effectifs (moins de 9 acheteurs) il n'existe pas.
- **Le prix d'un devis laisse retrouver D à partir de 6 acheteurs** (facteur demande fonction du nombre exact).
- **Plus de 20 boosts** : seuls les 20 plus récents sont détaillés.
- **Devis anciens** : un devis écrit avant le lot M1-quater garde son `demand_milli` d'alors (D exact avant M1-bis, D' = 3 sous M1-bis ; aucune migration de données) ; il n'existe plus de nouveau devis de ce genre, et les devis valent 60 s à 1 h. Aucune
  donnée de production n'existe encore.
- **Récolte de numéros** : 20 vendeurs par compte vérifié et par jour UTC, donc proportionnelle au nombre de comptes (voir « Contact »).
- **Attribution à la journée** : sous-attribution possible d'au plus un jour à la limite de 7 jours ; un jour avec deux boosts différents attribués à la même ligne garde le dernier boost.
- **Date de l'annonce = création** ; **pas de photo** ; **pas de statut de besoin « en pause »**.
- **D6 par processus** : plusieurs instances du serveur multiplient la limite de revérifications (60 par instance et par minute).
- **Une panne du journal des ouvertures perd l'ouverture** (pas de rejeu ; l'écriture se fait après la réponse, `after()`, et n'est jamais attendue) ; le contact, lui, est atomique avec son journal (la révélation et la ligne sont écrites dans une même transaction : pas de numéro révélé sans trace).
- **La fiche recalcule le classement** de la fenêtre de pertinence (comme une page de résultats : indicateurs de 200 offres au plus) pour relire `sponsored` ; aucune limite de débit propre n'est posée sur cette lecture.
- **Contact = intention déclarée**, pas une mise en relation prouvée : l'application ne sait pas si l'acheteur a vraiment appelé ou écrit.
- Les pages React ne sont pas testées en unitaire : leur logique est dans `lib/client/metrics-view.ts` (testé) ; les écrans sont couverts par `e2e:ui`.

## Numéros de téléphone cachés (lot D3 : règle réécrite)

Règle UNIQUE (`lib/phone-text.ts`, module pur partagé par la publication, l'affichage et les notifications), bâtie autour des numéros **ivoiriens et internationaux explicites**. Avant le lot D3, huit chiffres « à moins de quatre caractères les uns des autres » suffisaient : la règle refusait « 2400×1080 », « 12 500 000 FCFA », « Réf. 9300-1234 », un EAN ou un IMEI, et laissait passer « 07 O8 09 10 11 » (lettre O) ou « 07x08x09x10x11 ».

- **Normalisation** : NFKC ; caractères invisibles et marques combinantes ôtés (espace de largeur nulle, sélecteur de variante, cadre de touche d'emoji) ; chiffres de TOUS les alphabets (`\p{Nd}`, valeur exacte) et dingbats numérotés ramenés à l'ASCII ; **sosies de chiffres** (O, o, О, о, Ο, ο → 0 ; l, I, і, ı, | → 1) lus comme des chiffres seulement dans un mot qui ne porte que des chiffres et des sosies (« O7 », « l0 », « ll »), jamais dans « Olivier » ni « S21 » ; le texte est contrôlé sous ses deux lectures.
- **Est un numéro** : (a) 10 chiffres d'un numéro ivoirien (premiers chiffres 01, 05, 07, 21, 25 ou 27), groupes et séparateurs quelconques ; (b) un indicatif « 00225 » ou « 225 » suivi de 8 ou 10 chiffres ; (c) « + » suivi de 8 à 15 chiffres ; (d′) **lot D3-bis** : quatre groupes de DEUX chiffres exactement, séparés SEULEMENT par des symboles ou des espaces (jamais par une lettre ni un mot) et dont le PREMIER commence par 0 (« 07 08 09 10 », « 06 12 34 56 78 »). Deux groupes se suivent s'ils sont séparés par au plus 3 caractères qui ne sont ni chiffres ni lettres, ou, pour (a), (b) et (c) seulement, par une lettre (ou un mot de 8 lettres au plus : « x », « et », « puis ») entre deux groupes de 1 ou 2 chiffres dans une suite d'au moins 4 groupes (« 07x08x09x10x11 » reste un numéro ; « 07x08x09x10 », huit chiffres, n'en est plus un). L'ancienne règle (d), quatre groupes de deux chiffres quelconques, refusait « Coque compatible iPhone 11 12 13 14 », « TV 32 40 43 50 pouces », « Galaxy S21 S22 S23 S24 », « tailles 38 40 42 44 », « du 01/10 au 15/10 ».
- **N'est pas un numéro** : une quantité à milliers groupés par 3 (« 12 500 000 », « 12.500.000 »). **Lot D3-bis** : chaque quantité est NEUTRALISÉE comme un jeton AVANT les règles (a) à (d′) ; deux quantités ne se fusionnent donc jamais en un numéro (« 250 000 - 1 300 000 », « Prix 1 250 000 - 1 300 000 FCFA » : le préfixe 25 ne fait pas un numéro de fixe). Exceptions, où la quantité reste soumise aux règles : précédée d'un « + » (« +33 612 345 678 »), ou collée par un seul séparateur de milliers à un groupe qui n'est pas une quantité (« 225 070 809 1011 », « 27 123 456 78 », « 0 708 091 011 »). Un fixe 21, 25 ou 27 écrit exactement en milliers (« 2 712 345 678 ») est pris pour une quantité ; une dimension A×B, A*B ou AxB à 2 ou 3 termes ; une référence, un numéro de série, une facture, une année, une date ou une heure qu'aucune règle (a) à (d) ne couvre ; une suite de 11 à 14 chiffres qui ne commence pas par un indicatif (EAN, IMEI partiel).
- **Noms d'attributs** : `[a-z_]` seulement à la publication (400 `invalid_attribute_key`, sans répéter le nom saisi) ; les clés d'un objet imbriqué (`value`, `unit`, `sourceUnit` de l'extraction) n'ont jamais de chiffre. Les **valeurs** sont contrôlées une à une.
- **Message de refus** : « Pas de numéro de téléphone dans l'annonce (champ : variante) : l'acheteur vous contactera par noma. » (champ : catégorie, marque, modèle, variante, état, unité, localisation, attributs ; 400 `phone_number_in_offer` avec `field`).
- **Limite documentée** : un numéro **coupé entre plusieurs champs, plusieurs attributs distincts ou plusieurs éléments d'une liste** n'est PAS détecté (les champs ne sont jamais concaténés : cela refuserait des annonces honnêtes). Ne sont pas détectés non plus : un numéro écrit en toutes lettres, séparé par plus de trois symboles ou par une lettre accolée à un symbole (« 07x-08 »), ou coupé par des lettres dans des groupes de plus de deux chiffres. Un numéro de huit chiffres séparé par des lettres (« 07x08x09x10 ») ou de quatre groupes de deux chiffres dont le premier ne commence pas par 0 n'est pas détecté. Quelques textes honnêtes restent refusés : quatre nombres de deux chiffres dont le premier commence par 0 (« remises 05 10 15 20 »). Le texte brut de l'annonce n'est pas contrôlé : il n'est jamais servi à un acheteur.
- Tests : `tests/server/phone-rule.test.ts` (liste de l'audit dans les deux sens, 60 textes réalistes, 30 listes de modèles compatibles, de tailles et de capacités, 47 déguisements, chaque règle, tous les alphabets, essais tirés au sort à graine fixe), `tests/server/phone-text.test.ts`.
