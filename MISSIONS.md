# Missions d'achat en volume (lots MV1 et MV1-bis)

`AUDIT-EVOLUTION-SCOUTR.md` §7, lot 5 : « mission de volume, notamment achat fractionné entre plusieurs vendeurs et budget unitaire/total ». Une **mission** sert à acheter plusieurs exemplaires
du même objet, chez plusieurs vendeurs, dans la limite d'un budget par unité et d'un budget total (« 20 iPhone 12, 170 000 FCFA l'unité au plus, 3 200 000 FCFA au total »). noma **propose** une
répartition entre vendeurs anonymes ; l'acheteur écrit à chacun et déclare ses achats, ligne par ligne. **Rien n'est automatique** (aucun message, aucune commande n'est jamais créé par une
mission) et **aucun paiement de l'objet ne passe par noma** (c'est écrit à l'écran).

Le lot MV1 a été écrit sur une base antérieure aux lots offre Pro, photos, historique des prix, SMS, collecte externe et paiement ; **MV1-bis** le porte sur le main (migration **0027**, après les
migrations 0021 à 0026 de ces lots) et applique les corrections de son audit (reste à acheter, échéance, plus haut niveau notifié, fin de mission invisible du vendeur, texte libre, pagination).

Code : `lib/missions-rules.ts` (règles pures partagées avec l'écran), `lib/server/missions/` (`allocation.ts` la répartition, `missions.ts` le cycle de vie, `proposal.ts` la lecture,
`order-link.ts` le lien avec les commandes, `step.ts` l'étape du runner, `http.ts` et `http-errors.ts` les routes), `lib/phone-text.ts` (`looksLikePhoneNumberAcross`), branchements
`lib/server/social/{orders,http,http-common}.ts`, `lib/server/matching/{runner,persistence,stored-matches}.ts`, `lib/server/notifications/inbox.ts`, `lib/server/catalog/{demands,http}.ts`,
`lib/server/home/reads.ts`, `lib/server/metrics/stats.ts`, `lib/server/boost/{quotes,reach}.ts`, `lib/server/external/watches.ts`, routes `app/api/missions/**`, écrans
`app/(buyer)/missions/**` et `components/missions/*`, client `lib/client/{missions-api,missions-view}.ts`, migration `0027_missions.sql`, graine `demo:seed`.
Commandes de test : `npm run test:missions-allocation` (règles pures et répartition, essais de propriétés), `test:missions` (noyau, achats, confidentialité), `test:missions-step` (étape du
runner) ; les modules purs du client sont dans `npm run test:client`.

## Règles

| Champ | Règle |
| --- | --- |
| Produit | catégorie, marque, modèle, état : obligatoires ; variante : facultative. Texte de 1 à 50 caractères, **au moins une lettre ou un chiffre**. |
| Quantité totale | entier de **2 à 10 000** ; unité (20 caractères au plus, « pièce » par défaut dans le formulaire). |
| Budget par unité | entier de FCFA, de **1 à 100 000 000**. |
| Budget total | entier de FCFA, **au moins égal au budget par unité**, au plus 10¹² . |
| Lieu | facultatif, 80 caractères au plus, au moins une lettre ou un chiffre. |
| Durée | entier de **1 à 90 jours** (30 par défaut) ; l'échéance est posée au **lancement** (lancement + durée). |
| Plafonds | au plus **5 missions actives** par acheteur ; au plus **20 créations de mission par jour UTC**. Exacts sous concurrence (verrou consultatif par acheteur). |

Tous les nombres sont des **entiers** (jamais un texte, un décimal, `NaN`) ; un champ de plus est refusé, jamais ignoré.

### Texte libre : ce qui est garanti, exactement

Les sept champs libres sont la catégorie, la marque, le modèle, la variante, l'état, l'unité et le lieu.

**Dans l'application** (`cleanMissionText`, `checkMissionInput` : le serveur ET le formulaire, la même fonction), pour **chacun** des sept champs :

- NFKC, toute suite d'espaces (tabulation, saut de ligne, séparateur de ligne comprise) ramenée à **un** espace, texte rogné ;
- refusés, avant comme après normalisation : les caractères de contrôle (C0 et C1), de direction de texte et de format (`\p{Cf}`), **tout caractère ignorable par défaut d'Unicode**
  (`\p{Default_Ignorable_Code_Point}` : soft hyphen U+00AD, joint de graphème U+034F, marque de lettre arabe U+061C, **remplisseurs Hangul U+115F, U+1160, U+3164, U+FFA0**, voyelles khmères inhérentes,
  sélecteurs de variante U+FE00 à U+FE0F, formats de largeur nulle, U+FEFF, étiquettes U+E0000 à U+E0FFF…) — contrôlés sur le texte BRUT, avant la normalisation des espaces — et le **cadratin braille vide U+2800** ;
- refusée : une **marque combinante isolée** (au début du champ ou après un caractère qui n'est ni une lettre ni un chiffre) ; une lettre accentuée, composée ou décomposée, passe ;
- refusé : un champ **sans aucune lettre ni aucun chiffre** (« --- », « ... », « ( ) », un symbole seul) ;
- longueurs : 50 caractères (20 pour l'unité, 80 pour le lieu).

**Règle des numéros de téléphone** (`lib/phone-text.ts`, lots D1 et D3) : champ par champ (`400 phone_number_in_mission`, avec le nom du champ), puis sur le titre **assemblé** (marque, modèle,
variante : pas plus de 8 chiffres au total), puis sur **tous les champs libres ensemble** (`looksLikePhoneNumberAcross`) : (1) leur **concaténation**, séparés par une espace (un numéro coupé entre
deux champs voisins) ; (2) leur **squelette numérique** : seuls les *nombres autonomes* de chaque champ (une suite de chiffres qui ne touche aucune lettre : « 0708 » de « iPhone 0708 », « 128 » de
« 128 Go », pas le « 21 » de « S21 » ni le « 5 » de « 5G »), dans l'ordre des champs, lettres ôtées : « iPhone 0708 » puis « Cocody 091011 » donnent « 0708 091011 », refusé. Le refus est
`400 phone_number_in_mission` sans champ, avec un message fixe (jamais la valeur saisie).
*Limites assumées de cette règle* : un numéro écrit en toutes lettres, ou collé à un mot (« iPhone0708 ») n'est pas détecté ; deux champs ou plus qui portent chacun d'autres nombres autonomes entre
les morceaux d'un numéro peuvent le masquer (leurs nombres s'intercalent dans le squelette) ; un texte honnête dont les nombres autonomes, mis bout à bout, forment un numéro (quatre nombres de
deux chiffres dont le premier commence par 0, ou 10 chiffres d'un préfixe ivoirien) est refusé.

**Dans la base** (migration 0027, CHECK sur la table `missions`, pour une écriture qui contournerait l'application) :

- `chk_missions_text_length` : longueurs ;
- `chk_missions_text_safe` : aucun caractère de contrôle C0 ou C1, aucune des plages invisibles suivantes — U+00AD, U+034F, U+061C, U+115F–U+1160, U+17B4–U+17B5, U+180B–U+180F, U+200B–U+200F,
  U+2028–U+202E, U+2060–U+206F, U+2800, U+3164, U+FE00–U+FE0F, U+FEFF, U+FFA0, U+FFF0–U+FFF8, U+1BCA0–U+1BCA3, U+1D173–U+1D17A, U+E0000–U+E0FFF (= les ignorables par défaut d'Unicode, les formats et
  séparateurs de ligne, le braille vide) —, aucune marque combinante isolée **dans les blocs principaux** (U+0300–U+036F, U+0483–U+0489, U+0591–U+05BD, U+0610–U+061A, U+064B–U+065F, U+1AB0–U+1AFF,
  U+1DC0–U+1DFF, U+20D0–U+20FF, U+FE20–U+FE2F) ; l'application, elle, refuse toute marque (`\p{M}`) isolée ;
- `chk_missions_text_content` : chaque champ contient au moins un caractère `[[:alnum:]]` **au sens des paramètres régionaux de la base** (en locale « C », seules les lettres ASCII comptent ; la
  base d'essai et l'image `postgres:16-alpine` de `deploy/` sont en `en_US.utf8`) ;
- la base **n'applique pas** la règle des numéros (application seulement : elle dépend de `lib/phone-text.ts`).

## États

`draft` (brouillon) → `active` ou `cancelled` ; `active` ⇄ `paused` ; `active` ou `paused` → `completed` (quantité totale confirmée), `expired` (échéance passée), `cancelled`. Les trois
derniers états sont **définitifs** (déclencheur de base : plus rien ne change, sauf la libération du besoin porteur, voir plus bas). Après le brouillon, le contenu ne change plus (déclencheur :
`mission_content_locked`).

- **Brouillon** : modifiable (`PUT /api/missions/{id}`, champs recontrôlés ensemble) ; une mission lancée refuse la modification (`409 mission_not_draft`).
- **Lancer** (`activate`) : crée le **besoin porteur** et pose l'échéance. 5 missions actives déjà : `409 mission_active_limit` ; créer **et** lancer d'un coup (`activate: true`) annule aussi la
  création si le lancement est refusé.
- **Pause / reprise** : la mission garde le **même** besoin porteur ; la reprise redemande une place parmi les 5. **Après l'échéance, la pause et la reprise sont refusées** (`409
  mission_state_conflict`), avant même que l'étape du runner n'ait marqué la mission échue ; annuler reste possible.
- **Annuler** : les achats encore **proposés** sont annulés (c'est l'acheteur qui annule), les achats **confirmés** restent ; le besoin porteur est archivé 24 h plus tard.
- **Échéance** : l'étape du runner marque la mission **échue** ; si **toute la quantité est sécurisée** (achats confirmés) à l'échéance, elle passe à **terminée**, pas à échue.
- Une action impossible dans l'état courant : `409 mission_state_conflict`. Réservées au propriétaire.

## Le besoin porteur

Une mission active possède un **besoin ordinaire** du matching (`missions.demand_id`) : le moteur n'est pas dupliqué, les correspondances confirmées et fraîches de ce besoin sont **les**
correspondances de la mission. Ce besoin n'a **ni budget, ni quantité, ni échéance** : un vendeur dont l'annonce correspond le voit comme tout autre besoin (`GET /api/offers/{id}/stored-matches`),
**jamais le budget de la mission** (les budgets restent dans la table `missions`, que seul le propriétaire lit). Les budgets s'appliquent à la **proposition**, pas au matching. Son suivi est
en **pause** (pas de notification annonce par annonce : la mission signale la couverture, voir plus bas). Il n'est pas dans « Mes besoins » (liste du catalogue et accueil) et ne se modifie, ne
s'archive et ne se marque satisfait que par la mission (déclencheur `mission_carrier_locked`, `409 mission_carrier_locked` par la route du catalogue).

**Fin de mission invisible du vendeur.** À la fin de la mission (terminée, annulée, échue) le besoin porteur **n'est pas archivé à cet instant** : il l'est **24 heures plus tard** par l'étape
« missions » du runner (`missions.carrier_released_at`, la seule modification permise sur une mission close). Un vendeur dont la confirmation termine la mission ne voit donc pas le besoin
disparaître de ses correspondances au moment de sa confirmation (le constat de l'audit : il apprenait que sa confirmation était la dernière). Pendant ces 24 h le besoin compte comme n'importe
quel besoin actif ; les achats sont déjà refusés (`409 mission_not_active`).

**Mission EN PAUSE : un besoin qui ne compte pas.** Le besoin porteur d'une mission **en pause** (l'acheteur a suspendu sa recherche) ne compte **ni** dans les comptes de besoins du vendeur
(« environ N besoins » de l'accueil vendeur et des statistiques d'une annonce, liste des acheteurs intéressés d'une annonce), **ni** dans les devis et la portée du boost (acheteurs compatibles,
besoins atteignables), **ni** dans la collecte externe (`readActiveDemandKeys` : aucune surveillance de marché pour lui). L'acheteur, lui, relit sa proposition pendant la pause ; à la reprise
le besoin compte de nouveau. Une mission active, ou close depuis moins de 24 h, compte (rien ne dit au vendeur qu'elle est finie). Le matching continue pendant la pause (la reprise est immédiate).

## La proposition de répartition

`GET /api/missions/{id}/proposal` : **lecture seule**. Candidats : les correspondances confirmées et fraîches du besoin porteur, dans l'ordre de **pertinence organique** (le tri par
pertinence sans boost, `readDemandOrganicRanking`, fenêtre de 200 annonces).

**La proposition répartit seulement le RESTE.** Les achats **déjà engagés** (commandes proposées ou confirmées rattachées à la mission) sont affichés **à part** (« Déjà acheté ou en attente ») et
**soustraits** : le reste à acheter est la quantité totale moins les quantités engagées, le budget qui reste est le budget total moins les montants engagés (prix convenu × quantité). Une annonce
déjà commandée n'est **pas reproposée**. La **couverture** (`coveredQuantity`, `coveragePercent`) est l'engagé **plus** le proposé, plafonnée à la quantité totale : c'est la même valeur que lit l'étape
du runner (`missions.covered_quantity`) et que la notification annonce (jamais le double). Les vendeurs déjà engagés comptent dans les 10 vendeurs.
Une commande déclinée ou annulée n'est plus engagée : son annonce redevient proposée. Une mission dont l'échéance est passée n'a plus de proposition (état `inactive`), même si l'étape n'a pas encore
tourné.

Répartition **gloutonne** du reste (`allocateMission`, fonction pure) :

1. écarter les annonces sans prix valide, au-dessus du budget par unité, ou à la quantité illisible ;
2. trier : pertinence **décroissante**, puis prix unitaire **croissant**, puis identifiant d'annonce (le résultat ne dépend pas de l'ordre d'arrivée) ;
3. de chaque annonce, prendre le plus possible : `min(quantité annoncée, quantité restante, ⌊budget total restant ÷ prix⌋)`, **10 vendeurs au plus** (plusieurs annonces d'un même vendeur
   comptent pour un seul vendeur ; les vendeurs déjà engagés comptent et gardent les premiers rangs).

Contraintes **toujours** respectées (essais de propriétés sur 3 000 jeux aléatoires à graine fixe, dont un tiers avec des vendeurs déjà engagés) : prix unitaire ≤ budget par unité ; Σ prix × quantité ≤
budget total restant ; quantité prise ≤ quantité annoncée (**1 si elle n'est pas renseignée**) ; ≤ 10 vendeurs engagés compris ; une annonce au plus une fois. Résultat : lignes (annonce, vendeur
**étiqueté**, quantité, prix unitaire, sous-total), achats engagés, couverture, budget utilisé (engagé + proposé) et restant, et, si la quantité n'est pas couverte, des **raisons en mots simples** :
`not_enough_offers` (« pas encore assez d'annonces »), `unit_budget_too_low` (annonces au-dessus du budget par unité), `total_budget_too_low`, `seller_limit` (limite de 10 vendeurs).

**C'est une heuristique, pas un optimum.** Elle garantit la *maximalité* (si la quantité n'est pas couverte, aucune annonce retenue ne pouvait fournir une unité de plus sans dépasser son stock, le
budget total ou la limite de vendeurs) mais pas la couverture maximale ni le coût minimal : une annonce très pertinente mais chère passe avant une annonce un peu moins pertinente et bien moins
chère, et **un budget total plus grand peut même couvrir moins** (le budget se vide sur l'annonce la plus pertinente) ; deux essais le montrent. La pertinence d'abord est le choix du produit ;
l'acheteur décide ensuite ligne par ligne.

**Étiquettes « Vendeur N » (information assumée).** Les vendeurs sont étiquetés « Vendeur 1 », « Vendeur 2 »… (les vendeurs déjà engagés d'abord, puis dans l'ordre de remplissage), jamais un
identifiant, un numéro ni un pseudonyme stable : les mêmes vendeurs n'ont pas les mêmes étiquettes d'une mission à l'autre (essai). **Une étiquette par vendeur** : deux annonces d'un même vendeur
portent la même étiquette dans une mission. C'est voulu — l'acheteur sait qu'il n'écrit qu'une fois à ce vendeur — mais cela **révèle** à l'acheteur que deux annonces ont le même vendeur ; la
proposition ne dit jamais *qui* est ce vendeur.

Mission en pause : proposition encore lisible ; brouillon, terminée, annulée, échue, ou échéance passée : état `inactive`, aucune ligne.

## Exécution : écrire, déclarer

- **« Écrire »** (une ligne) : `POST /api/demands/{besoin porteur}/offers/{annonce}/conversation` (route existante : une conversation par couple besoin, annonce), puis la conversation s'ouvre avec
  un **message pré-rempli et modifiable** (« Bonjour, je souhaite acheter 3 unités de « … » à 158 000 FCFA l'unité. Est-elle toujours disponible ? »). Quantité et prix viennent de l'adresse
  (`?quantite=3&prix=158000`, deux entiers lus strictement, jamais un texte : l'adresse ne peut pas injecter un message). **Il ne part que si l'acheteur l'envoie** ; il ne dit jamais le budget,
  la mission ni les autres vendeurs. Le vendeur ne voit une conversation qu'à partir du premier message de l'acheteur (règle de la messagerie).
- **« Déclarer l'achat »** (une ligne) : `POST /api/demands/{besoin porteur}/offers/{annonce}/orders { priceXof, quantity }` (route existante). `quantity` est **facultative** (entier de 1 à
  10 000, **1 par défaut**) ; le prix convenu est le prix **par unité**. Sur le besoin porteur d'une mission de l'acheteur, la commande est **rattachée à la mission** et soumise à ses limites :
  mission **active et échéance non passée** (`409 mission_not_active` : après l'échéance plus aucun achat, même si l'étape du runner n'a pas encore marqué la mission échue), prix ≤ budget par unité
  (`409 mission_price_over_budget`), commandes proposées ou confirmées + celle-ci ≤ quantité totale (`409 mission_quantity_exceeded`) et ≤ budget total (`409 mission_budget_exceeded`). Quantité
  illisible, négative ou nulle : `400 invalid_quantity`. La ligne de la mission est verrouillée (`FOR UPDATE`) : deux déclarations simultanées s'attendent, la limite est exacte. Les règles de transition
  des commandes (COMMANDES.md) sont **inchangées** ; la base interdit en plus de modifier la quantité ou la mission d'une commande.
- **Quantité sécurisée** = somme des commandes **confirmées** rattachées à la mission (une commande proposée, refusée ou annulée ne compte pas). Quand elle atteint la quantité totale, la
  mission passe à **`completed`**, dans la transaction de la confirmation (la mission est verrouillée avant la commande : deux confirmations simultanées sont sérialisées, la mission n'est
  terminée qu'une fois). Un achat de mission ne propose pas « marquer mon besoin comme satisfait » : la mission se termine d'elle-même.
- Côté **vendeur**, la commande dit la **quantité demandée** et le total (« Quantité demandée : 2 · Total 330 000 FCFA ») ; l'objet `order` du vendeur ne porte même pas le champ `missionId`.
- **Ventes d'une annonce** (`GET /api/offers/{id}/sales`, lot D2, **inchangé**) : elles comptent des **commandes** confirmées, pas des exemplaires. Une commande de 20 exemplaires compte pour **une**
  vente (comptes arrondis comme les autres mesures) ; de même, l'historique des prix (lot H1) enregistre un relevé par commande, au prix par unité.

## Suivi : l'étape « missions » du runner

`runMatchingCycle` exécute l'étape `missions` (`lib/server/missions/step.ts`) **avant `notify`**, après les jobs ; les étapes du main qui suivent (`notify`, abonnements, rattrapage des paiements, relevé des prix,
collecte externe) gardent leur ordre. Chaque étape est isolée dans son propre `try` :

1. **Échéance** : les missions ouvertes (actives **ou en pause**) dont l'échéance est passée passent à `expired` — ou à `completed` si toute la quantité est déjà sécurisée. Idempotente (une mission
   déjà close n'est jamais touchée, `SKIP LOCKED` pour les processus simultanés). Les achats encore proposés d'une mission échue **restent tels quels** (le vendeur peut encore décider) ; une confirmation
   tardive ne rouvre pas la mission.
2. **Réévaluation** : une mission active (échéance non passée) dont le besoin porteur a une évaluation **confirmée et fraîche** plus récente que sa dernière lecture (marge de 5 s), ou une commande
   changée depuis (à défaut, relue toutes les 10 minutes) voit sa couverture relue avec la même répartition que la proposition (l'engagé plus le proposé : `covered_quantity`, affichée dans « Mes
   missions »). **Rien n'est lu** tant que le matching du besoin porteur n'est pas terminé : événement en attente, job en cours, ou **évaluation récemment périmée en attente de recalcul** (annonce
   modifiée, retirée ou indisponible, besoin modifié : une évaluation périmée depuis moins de 10 minutes et sans remplaçante) — la couverture ne chute pas pendant un recalcul ; passé 10 minutes
   sans remplaçante, la lecture reprend (une annonce définitivement partie ne bloque pas la mission).
3. **Notification** : la **première** lecture après l'activation pose une base de comparaison **sans bruit** (comme N1 : créer ne notifie pas ce que l'acheteur voit déjà). Cette base est le **plus
   haut niveau de couverture vu ou annoncé** : elle **ne baisse jamais**. Une notification `mission_coverage` (dans l'application ; titre « Apple iPhone 12 : 7 sur 20 », quantité couverte, lien
   `/missions/{id}`) ne part que si la couverture **dépasse** ce plus haut niveau, **au plus une par jour UTC et par mission** (index unique) ; une hausse retenue ce jour-là est signalée le lendemain.
   Une baisse passagère puis un retour au même niveau (6 → 0 → 6, annonces retirées une minute) ne notifie **rien** : le constat de l'audit est fermé. Pas d'envoi externe, pas de ligne d'outbox.
   Une mission en pause ne notifie pas.
4. **Libération des besoins porteurs** : le besoin porteur d'une mission close depuis plus de **24 h** est archivé (le matching s'arrête) ; la libération est notée sur la mission, une seule fois.

Résultat du cycle : `missions { skipped, expired, evaluated, changed, notified, released, errors }`. **Sans la migration 0027, l'étape est ignorée sans erreur** (`skipped: true`) ; une panne de l'étape
est un code stable dans `errors` (`missions_error_<code>`, `mission_expire_<code>`, `mission_release_<code>`…), les autres étapes tournent. Une étape qui a changé une couverture, échu une mission,
notifié ou libéré un besoin porteur compte comme du travail pour la boucle du worker.

**Coût de la sélection.** La requête qui choisit les missions à relire (`MISSIONS_WATCH_SQL`) ne lit que des index PARTIELS : `idx_matching_eval_demand_confirmed` (évaluations confirmées, dernières et
fraîches d'un besoin), `idx_matching_eval_demand_awaiting` (évaluations périmées en attente de recalcul, ajouté par la 0027), `uq_matching_evaluations_latest`, `idx_orders_mission`. Elle ne parcourt
jamais l'historique des évaluations remplacées (le constat de l'audit : 2 s par étape au repos avec 600 000 lignes) ; un essai vérifie le plan sur un historique de 120 000 lignes.

## API

| Route | Rôle |
| --- | --- |
| `GET /api/missions[?cursor=…]` | « Mes missions » : `{ contractVersion: "missions/v1", missions, nextCursor }`. **Toutes** les missions **ouvertes** (brouillons, actives, en pause) d'abord, **toujours**, dans la première réponse (jusqu'à 200 ; au-delà, par pages de 200 avec le curseur), puis les closes (terminées, annulées, échues) par pages de **50** avec un curseur opaque (`nextCursor`, null à la fin) ; les plus récentes d'abord dans chaque groupe. Seul `cursor` est admis ; un curseur mal formé : 400 |
| `POST /api/missions` | crée (brouillon, ou lancée avec `activate: true`) : corps = les champs de la mission seulement |
| `GET /api/missions/{id}` | la mission et ses achats (`orders`) |
| `PUT /api/missions/{id}` | modifie un **brouillon** |
| `POST /api/missions/{id}` | `{ "action": "activate" | "pause" | "resume" | "cancel" }` |
| `GET /api/missions/{id}/proposal` | la proposition de répartition : `lines` (le reste à acheter), `engaged` (achats déjà engagés), `committedQuantity`, `committedXof`, `remainingQuantity`, `coveredQuantity` |

Propriétaire seulement : pour toute autre personne (autre acheteur, vendeur, mission inconnue), la **même réponse 404** octet pour octet. Origine vérifiée **avant** la session sur toute écriture,
réponses `no-store`, textes d'erreur fixes, journal serveur limité à un code. Identifiant mal formé : 400 ; aucun paramètre de requête n'est admis (sauf `cursor` sur la liste).

## Confidentialité

- Le vendeur ne voit **ni le budget de l'acheteur, ni la mission, ni les autres vendeurs**. Il voit le message et la commande qui le concernent (quantité demandée, prix par unité). Un essai cherche
  les chiffres distinctifs des budgets, le mot « mission », l'identifiant de la mission, la quantité totale, les identifiants et numéros des autres vendeurs et de l'acheteur dans **toute** réponse
  lisible par un vendeur (commandes, conversations, messages, correspondances enregistrées et en direct, statistiques, ventes, notifications, accueil vendeur).
- La **fin** d'une mission ne se voit pas côté vendeur (besoin porteur gardé 24 h) ; une mission en pause ne se voit pas non plus dans ses comptes de besoins (voir plus haut).
- Les vendeurs d'une proposition sont étiquetés (« Vendeur N », voir plus haut) ; la proposition ne porte aucun identifiant de vendeur ni numéro.
- Une notification de couverture ne porte que le produit et deux quantités : jamais de budget ni de vendeur.

## Base : migration 0027

Additive (jamais appliquée à `noma_dev` sans instruction explicite). Table `missions` (CHECK sur chaque borne, sur le cycle de vie et sur les textes ; déclencheur de transitions et de contenu figé ;
`carrier_released_at`) ; `orders.quantity` (1 par défaut, de 1 à 10 000) et `orders.mission_id` ; déclencheur de cohérence (la commande rattachée est celle du propriétaire de la mission, sur son
besoin porteur) ; la fonction `orders_enforce_transition` est remplacée en gardant ses règles et en figeant aussi la quantité et la mission ; `notifications.mission_id`, le genre `mission_coverage` et
l'index unique `(mission_id, digest_day)` ; déclencheur `demands_guard_mission_carrier` ; index `idx_missions_owner_open`, `idx_missions_carrier_release`, `idx_matching_eval_demand_awaiting`.
Elle s'applique après la 0026 (paiement Wave via Sublymus) ; elle ne modifie aucun objet des migrations 0021 à 0026. Elle remplace la fonction `orders_enforce_transition` (0020) et les contraintes `chk_notifications_shape` et `notifications_kind_check` (0019), et ajoute un index partiel à `matching_evaluations` (0006).

Verrou consultatif par acheteur (créations et activations : plafonds exacts) : espace `1_314_664_985` (`lib/server/missions/config.ts` ; le test du dépôt qui interdit deux espaces identiques le couvre ;
il est listé dans `scripts/demo-seed-plan.ts` avec les espaces 945 à 960, 970 à 972, 977, 981 et 982).

**Dépendance — appliquer la migration AVANT de démarrer la nouvelle version.** Le code lit des colonnes et des tables que la 0027 ajoute : la liste des besoins du catalogue, l'accueil de l'acheteur, les
commandes (`quantity`, `mission_id`), les comptes de besoins du vendeur, les statistiques d'une annonce, les devis et la portée du boost, la liste des acheteurs intéressés d'une annonce. Démarré sur
une base pas encore migrée, il répond en erreur sur ces écrans. Seuls l'étape du runner, la collecte externe, la graine et le matching s'en passent sans erreur. `DEPLOIEMENT.md` en fait une étape
explicite de la séquence d'installation (`npm run db:migrate`, sauvegarde `pg_dump` d'abord, **avant** le démarrage de l'instance) ; un essai vérifie qu'elle y est, à sa place.

## demo:seed

Une mission de démonstration pour l'acheteur démo, rejouable (retrouvée par produit, quantité et budget) : **10 Samsung Galaxy S21 d'occasion, 135 000 FCFA l'unité au plus, 1 200 000 FCFA au total**,
**partiellement couverte (5 sur 10)** : cinq vendeurs fictifs, une annonce au-dessus du budget par unité (celle du vendeur démo, 140 000 FCFA), deux annonces reconditionnées dont l'état n'est pas
comparable. Elle est créée après tout le reste (offre Pro, photos, historique des prix, collecte externe fictive, paiement), le worker tourne ensuite jusqu'au repos : aucune notification de plus
(l'acheteur démo garde ses 3), aucun message, aucune commande. **Écart au prompt de MV1** : le produit n'est pas l'iPhone 12 (voir `scripts/demo-seed-plan.ts`) : un besoin porteur « iPhone 12 » ferait
passer « environ 10 » à « environ 15 » les besoins correspondant à l'annonce boostée du vendeur démo, ce que `e2e:demo` et les essais du lot D1 vérifient.

## Essais et mutations

- `test:missions-allocation` : exemples de la répartition (ordre, stock, budgets, 10 vendeurs, doublons, **vendeurs déjà engagés, répartition vide**), **3 000 jeux aléatoires à graine fixe** (aucune contrainte
  violée, aucune quantité au-delà du stock, rangs de vendeurs, raisons, maximalité, un tiers des jeux avec des vendeurs engagés), indépendance de l'ordre d'arrivée, contre-exemples de l'heuristique ; règles
  pures (`lib/missions-rules.ts`) : bornes, texte, caractères invisibles, marques isolées, champs sans lettre ni chiffre, numéros de téléphone **champ par champ et sur l'ensemble des champs** ; le
  déploiement (migration avant démarrage) et la constante de migration.
- `test:missions` : noyau (création, plafonds exacts sous concurrence, brouillon, cycle de vie, besoin porteur caché et verrouillé, accès d'autrui en 404 identique, garde-fous de la base, routes Next),
  **texte libre** (numéros coupés entre champs, invisibles, base alignée), **« Mes missions » paginée**, pause et reprise après l'échéance ; proposition (budgets, stocks, 10 vendeurs, anonymat, **lecture seule**,
  **reste à acheter**, achats engagés à part, cas A2 de l'audit, capture « 37-progression » de la démonstration), achats rattachés (quantité, limites, quantité sécurisée, achèvement, annulation, immuabilité en base), **concurrence** (deux confirmations
  simultanées, deux déclarations simultanées, confirmation contre annulation : 6 + 8 + 8 tours), confidentialité (budgets distinctifs et mot « mission » cherchés dans toute réponse lisible par un vendeur,
  **étiquettes comparées entre deux missions**, **fin de mission invisible**, **besoins porteurs en pause**).
- `test:missions-step` : échéance (idempotente, deux processus, **terminée si tout est sécurisé**, **achat et proposition refusés après l'échéance**), couverture et notification (base silencieuse, une par
  jour, hausse retenue, pause, **plus haut niveau notifié**, **évaluation périmée en attente de recalcul**), **libération des besoins porteurs à 24 h** (deux processus, besoin déjà archivé), étape ignorée sans
  la migration 0027, panne isolée dans le cycle, **plan de la sélection sur un historique de 120 000 évaluations**.
- Client (`npm run test:client`) : `missions-view` (liste, formulaire, message pré-rempli, adresse de la conversation, proposition, achats engagés) et `missions-api` (requêtes exactes, pages et curseurs, réponses
  relues, notification de couverture).
- `e2e:demo` : mission de démonstration (5 sur 10), création avec refus d'un numéro et d'une quantité hors bornes, proposition de 7 lignes, « Écrire » pré-rempli (rien n'est envoyé), déclaration (limites refusées à
  l'écran, l'achat passe dans « Déjà acheté ou en attente »), côté vendeur « Quantité demandée : 2 · Total 330 000 FCFA » sans mission ni budget, confirmation, **2 sur 8 achetés** (la proposition couvre alors 8 sur 8 : 2 engagés + les 6 autres annonces, budget restant 162 000 FCFA), pause et reprise.
- **Mutations** : 85 mutations appliquées une par une sur une copie du dépôt, **85 détectées sur 85** (journaux `/tmp/noma-mvr-mutations*.log` du lot). Les **42** de MV1 (budget par unité ou total ignoré, stock dépassé,
  plus de 10 vendeurs, commandes non confirmées comptées, achèvement ou échéance jamais posés, étape sans migration, accès d'autrui, budget ou mission visibles du vendeur, vendeurs identifiables, message ou commande
  créés automatiquement, plafonds retirés, notification plus d'une fois par jour ou sans base silencieuse, numéro accepté, origine non vérifiée, quantité négative, modification d'une mission lancée, double comptage,
  quantité ou budget dépassables, mission en pause, besoin porteur non libéré ou visible, verrou retiré…), rejouées avec leurs ancres adaptées au main ; et **43** sur les corrections : reste non soustrait
  (quantité, budget), annonce engagée reproposée, couverture sans l'engagé, vendeurs engagés non comptés, échéance non testée (achat, proposition, pause), terminée remplacée par échue, notification sans plus
  haut niveau, archivage immédiat ou délai nul, besoin porteur en pause compté (accueil vendeur, statistiques, liste, devis et portée du boost, collecte externe), concaténation des champs non filtrée, invisibles,
  marques isolées et champs sans lettre ni chiffre acceptés, CHECK de la base affaiblis, pagination (ouvertes ni en premier, curseur ignoré, limites), constante de migration fausse, évaluation périmée ignorée,
  prédicat de sélection non aligné sur l'index, commande changée sans relecture, libération non notée ou non comptée comme du travail, déclencheur de base trop permissif ou trop strict, étape des migrations retirée
  de `DEPLOIEMENT.md`, curseur et statut côté client. Une première campagne en a laissé survivre quatre (commande changée sans relecture, étiquette d'un vendeur engagé figée, étape des migrations retirée du
  guide de déploiement, mission dont l'échéance est passée sélectionnée) : les essais ont été renforcés et les quatre sont détectées.

## Limites assumées

- Heuristique gloutonne (ci-dessus), fenêtre de **200** annonces (au-delà, seules les mieux notées sont considérées).
- La **liste** « Mes missions » montre la couverture lue par l'étape du runner (quelques secondes de retard au plus avec un worker qui tourne) ; la page d'une mission relit la proposition en direct. Un
  achat déclaré, confirmé ou annulé fait relire la couverture au cycle suivant du worker.
- Les missions **en pause** gardent leur besoin porteur actif (le matching continue, la reprise est immédiate) mais ne comptent pas dans les 5 missions actives ni dans les comptes du vendeur, du boost et de la
  collecte externe ; les 20 créations par jour bornent leur nombre.
- Un achat proposé d'une mission **échue** reste actif (le vendeur peut décider) : la quantité sécurisée d'une mission échue peut encore augmenter, sans rouvrir la mission.
- Le besoin porteur est visible d'un vendeur comme un besoin ordinaire (catégorie, marque, modèle, variante, état, lieu) pendant la mission et **24 h après sa fin** ; deux missions du même acheteur sur le même
  produit sont deux besoins.
- Une **évaluation périmée** ne bloque la relecture de la couverture que 10 minutes ; au-delà, la baisse est lue (le plus haut niveau notifié, lui, ne baisse jamais).
- Le formulaire d'annonce du vendeur n'a pas de champ « quantité » : par l'écran, chaque annonce compte pour **un exemplaire** (la règle « 1 si elle n'est pas renseignée »). La quantité d'une annonce existe dans le catalogue (API) et la répartition l'utilise.
- La quantité demandée dans une commande n'est pas comparée à la quantité annoncée par le vendeur (c'est lui qui décide en confirmant) : un achat de 2 sur une annonce de 1 est possible, il sort alors du reste.
- Pas de modification d'une mission lancée (l'annuler et en créer une autre) ; pas de prolongation d'échéance.
- Le contrôle des numéros entre champs a les limites listées plus haut ; le contrôle de la base ne couvre pas la règle des numéros et suit les paramètres régionaux de la base pour « lettre ou chiffre ».
