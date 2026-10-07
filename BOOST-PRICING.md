# BOOST-PRICING.md — Prix dynamique du boost et cotations vendeur (lot 2I2)

Brief SCOUTR §18 et AUDIT-EVOLUTION-SCOUTR.md §6 « Cotation et achat » : un vendeur obtient une **cotation** (un prix daté,
conservé pendant sa courte validité) pour le boost de son offre. **Ce lot n'a AUCUN paiement, crédit, solde, achat,
acceptation de cotation ni réservation de place, et aucune route HTTP ni interface** (lot 2I3). Le comportement des lots 2I1 et
2I1-bis (attribution, annulation, places, placement, classement) n'est pas modifié. **Depuis le lot 2I3, le vendeur obtient ces
cotations par HTTP (`POST` et `GET /api/offers/{id}/boost-quotes`) : voir `BOOST-HTTP.md`.**

**Depuis le lot P1b, une cotation disponible peut être ACHETÉE avec les crédits du portefeuille : `BOOST-PURCHASE.md`** (le prix payé est
exactement celui de la cotation, jamais recalculé ; une cotation ne s'achète qu'une fois ; la disponibilité est revérifiée à l'achat).

Code : `lib/server/boost/pricing.ts` (fonctions pures), `lib/server/boost/quotes.ts` (comptages, cotation, historiques),
`lib/server/boost/reach.ts` (portée visible), `lib/server/boost/gate.ts` (créneaux de calcul),
`database/migrations/0012_boost_pricing.sql` (puis 0016 et 0017), `scripts/boost-quote.ts`, `tests/perf/boost-perf.ts` (`npm run perf:boost`).
Tests : `npm run test:boost-pricing` (pur), `npm run test:boost-quotes` (base `TEST_DATABASE_URL` dédiée).

## Formule

**montant = base × concurrence × demande × rareté × durée**, avec des facteurs déterministes et bornés, exprimés en
**millièmes entiers**, calculés sur des données datées (un seul instantané de comptage).

| Facteur | Définition | Réglage |
| --- | --- | --- |
| concurrence | `min(competition_max, 1000 + competition_step × S)` ; **S** = vendeurs AUTRES distincts ayant au moins une offre éligible dans le périmètre (les doublons d'un même vendeur ne gonflent rien, les offres du vendeur coté ne comptent pas) | 20 / 1 500 |
| demande | `min(demand_max, 1000 + demand_step × (D' − 1))` ; **D ≥ 1** = acheteurs compatibles distincts, **D'** = D lissé (voir « D' » ci-dessous) | 100 / 3 000 |
| rareté | `1000 + floor((scarcity_max − 1000) × used / total)`, défini seulement si `0 ≤ used < total` | 2 000 |
| durée | `duration_24h_milli`, `duration_3d_milli` ou `duration_7d_milli` (croissants) | 1 000 / 2 500 / 5 000 |

Séparation voulue (audit §6) : concurrence (offre), demande (acheteurs), saturation (places) sont trois facteurs distincts.
« Beaucoup d'offres sans acheteurs » ne justifie pas un prix élevé : D = 0 rend la cotation indisponible.

### Calcul exact
Aucun flottant : le produit des quatre facteurs dépasse 2^53, il est calculé en **BigInt**.
`brut = base × fc × fd × fr × ft / 10^12` (rationnel exact `numérateur / 10^12`, restitué avec 12 décimales :
`raw_amount NUMERIC(30,12)`). **Arrondi demi-haut à la grille, PUIS bornes** :
`montant = clamp(grille × floor((2·num + den·grille) / (2·den·grille)), min, max)`. Comme `min_amount` et `max_amount` sont des
multiples de la grille (CHECK en base, `validatePricingSettings` en code), le montant est **toujours sur la grille et dans
[min, max]** : le piège « arrondir après un clamp dépasse les bornes » est évité par construction (le clamp sur un brut non
arrondi, puis l'arrondi, donnerait le même résultat tant que les bornes sont des multiples de la grille ; interdire les bornes
hors grille est donc la protection).

### D' : le facteur demande ne redonne jamais un petit nombre d'acheteurs (lots M1-bis et M1-quater)

Le nombre d'acheteurs compatibles est publié arrondi dans les devis (« moins de 5 » de 0 à 4, sinon « environ N » : `MESURES.md`), mais le facteur demande et le prix qui
s'affichent (« +10 % sur le prix ») permettaient de retrouver D (`demandMilli = 1100` ⇒ D = 2). Le facteur est donc calculé avec **D'** :

| D | D' |
| --- | --- |
| 0 | 0 (aucun prix : la cotation est indisponible, `no_compatible_buyer`) |
| 1, 2, 3, 4 ou 5 | **5** (le facteur est celui de 5 acheteurs : `1000 + 100 × 4 = 1 400` avec les réglages par défaut) |
| 6 et plus | D (inchangé) |

Le prix pour 1 à 5 acheteurs est **identique** (lot M1-quater ; M1-bis : 1 à 3 acheteurs, D' = 3). L'écran et le DTO (`factors.demandMilli`) portent le facteur calculé sur D' ; la cotation enregistrée (`boost_quotes`)
garde **D exact** (`compatible_buyers`, pour l'administration) et le facteur de D' (`demand_milli`). Un devis écrit avant le lot M1-quater garde son facteur d'alors (un devis
« 1 à 3 acheteurs » écrit sous M1-bis a un facteur de 1 200). **Limite assumée** : à partir de 6 acheteurs, le prix reste fonction du nombre exact (`demandMilli = 1500` ⇒ D = 6) :
le prix laisse retrouver D dès 6, même si le compte publié est « environ 5 » (6 à 8) ; ce que le prix ne donne jamais, c'est un nombre de 1 à 4 acheteurs, ni la différence entre 1 et 5.

Exemple (S = 3, 1 place utilisée sur 3, durée 3d, réglages par défaut) : D de 1 à 5 → demande **1 400** ; brut `500 × 1,060 × 1,400 × 1,333 × 2,500 = 2 472,715`, arrondi à la grille de 100 :
**2 500 XOF** pour les cinq (avant M1-quater : D de 1 à 3 → 1 200, brut 2 119,47, 2 100 ; avant M1-bis : D = 1 → 1 000, 1 800 ; D = 2 → 1 100, 1 900 ; D = 3 → 1 200, 2 100). D = 6 → demande 1 500, brut 2 649,3375 :
**2 600 XOF** ; D = 7 → demande 1 600 : 2 800 XOF (exemple ci-dessous).

### Exemple de contrôle (réglages par défaut)
S = 3, D = 7, 1 place utilisée sur 3, durée 3d : concurrence `1000 + 20 × 3 = 1 060`, demande `1000 + 100 × 6 = 1 600`, rareté
`1000 + floor(1000 × 1 / 3) = 1 333`, durée 2 500. Brut `500 × 1,060 × 1,600 × 1,333 × 2,500 = 2 825,96`, arrondi à la grille de
100 : **2 800 XOF**. Pour la même situation : 24h → brut 1 130,384 → 1 100 ; 7d → brut 5 651,92 → 5 700. Quelques repères
supplémentaires (testés) : un brut de 2 250 s'arrondit à 2 300 (demi-haut), 2 248,5 à 2 200 ; un brut de 450 avec min 1 000 donne
1 000 (avec un seul acheteur compatible, D' = 5 porterait ce brut à 630, le minimum de 1 000 l'emportant toujours) ; un brut de 374 850 avec max 50 000 donne 50 000.

## Configuration versionnée (`boost_pricing_settings`)

Clé primaire `(key, version)`. `key` : `default`, ou une catégorie en minuscules. **Une modification de configuration est une
NOUVELLE version** (jamais d'UPDATE dans le code) ; la version la plus élevée d'une clé est la version courante. Résolution
(`readBoostPricingSettings`) : la ligne de la **catégorie de l'offre** (`lower(btrim)`) si elle existe, sinon `default` ; toujours
sa version la plus haute ; `boost_pricing_missing` si aucune des deux n'existe. Une ligne de catégorie remplace entièrement la
ligne `default` (aucune fusion champ par champ).

Valeurs de la migration 0012, `default` version 1 : devise XOF, base 500, grille 100, minimum 500, maximum 50 000, concurrence
20 / 1 500, demande 100 / 3 000, rareté 2 000, durées 1 000 / 2 500 / 5 000, validité 900 s. **Ces valeurs sont PROVISOIRES** : elles
n'ont été calibrées sur aucun usage réel et doivent l'être avant tout lancement commercial (en particulier la base de 500 XOF et
les plafonds). Contraintes de base : base 1 à 10 000 000 ; grille > 0 ; min > 0 ; max ≥ min ; min et max multiples de la grille ;
pas 0 à 1 000 ; plafonds de concurrence, de demande et de rareté 1 000 à 5 000 ; durées 1 000 à 20 000 et `24h ≤ 3d ≤ 7d` ; validité
60 à 3 600 s.

## Cotations (`boost_quotes`, immuables)

`quoteOfferBoost({ pool, ownerId, offerId, durationCode })`. Validation **avant tout SQL** (zéro requête : pool exigé, UUID,
durée). **Depuis le lot P3, la cotation se fait en TROIS temps : le calcul de la portée ne tient plus aucun verrou** (constat prouvé avant le
lot : 200 offres et 1 000 besoins compatibles, un devis prenait 11,9 s (200 besoins examinés) à 59,7 s (1 000, aucun atteignable) DANS la transaction qui
tient le verrou consultatif de l'offre et la ligne de l'offre `FOR SHARE` : un devis concurrent échouait en 503 après 5 s, une mise en pause de
l'offre attendait toute la durée du calcul, douze devis simultanés faisaient attendre 28 à 58 s un `GET /api/wallet` d'un AUTRE utilisateur) :

1. **lecture sans verrou** (instantané `REPEATABLE READ READ ONLY`) : contrôles de l'offre (`offer_not_found`, `offer_not_owned`,
   `offer_not_eligible`, `offer_not_boostable`, mêmes règles que l'attribution), **réutilisation** (une cotation de cette offre, de même durée,
   même vendeur et même périmètre, avec `expires_at > maintenant`, est renvoyée telle quelle : `reused: true`, aucune écriture, **même si les
   comptages ou la version tarifaire ont changé** — **sauf une cotation déjà ACHETÉE** (présente dans `boost_purchases`, lot P1b) : elle n'est
   jamais renvoyée ; **lot P3-bis (N1) : un devis `available` n'est renvoyé qu'après REVÉRIFICATION de sa portée** — mode « premier atteignable », hors
   verrous, sous un créneau de calcul, budget `BOOST_REUSE_REACH_BUDGET_MS` = 1 s : atteignable → renvoyé tel quel ; DÉMONTRÉ inatteignable → il n'est
   plus réutilisé, un devis neuf (indisponible `no_visible_effect`, 60 s) est calculé et écrit ; vérification non terminée dans le budget → `reach_check_unavailable`,
   rien d'écrit ni modifié. Sans cela, « acheter → refus `no_visible_effect` → redemander un devis » rendait le MÊME devis « disponible » jusqu'à son échéance),
   **limite de débit** (voir plus bas), puis réglages tarifaires (`boost_pricing_missing` sans aucune ligne), comptages en **une
   seule requête** et motif d'indisponibilité antérieur à la portée ;
2. **portée** (seulement si aucun motif antérieur ne s'applique : inutile de la payer quand la cotation est déjà refusée), dans un AUTRE
   instantané en lecture seule, sous un **créneau de calcul** (au plus `BOOST_REACH_MAX_CONCURRENCY` = 4 simultanés par processus ; au-delà, attente
   d'au plus `BOOST_REACH_QUEUE_WAIT_MS` = 5 s puis `quote_busy`, 503), un **budget de temps** de `BOOST_QUOTE_REACH_BUDGET_MS` = 3 s et un
   `statement_timeout` local de `BOOST_REACH_STATEMENT_TIMEOUT_MS` = 2 s. Le créneau se prend AVANT d'ouvrir l'instantané : l'attente ne retient ni
   connexion ni verrou. Une demande identique qui aboutit pendant l'attente fait renvoyer sa cotation (rien n'est recalculé). La portée est une
   **ESTIMATION DATÉE** : l'achat la revérifie (`BOOST-PURCHASE.md`) ;
3. **écriture, transaction courte** READ COMMITTED : `lock_timeout`, **verrou consultatif par offre**, puis **verrou consultatif du vendeur**
   (espace 1_314_664_952 : comptage et écriture de la limite de débit, exacts même en parallèle), relecture COMPLÈTE de l'étape 1 sous les verrous (l'offre
   a pu changer : pause, autre produit ; ligne de l'offre verrouillée en lecture partagée), prix ou indisponibilité, `INSERT`
   (`computed_at = clock_timestamp()`). Pas de REPEATABLE READ pour cette étape : un instantané pris avant le verrou masquerait une cotation
   concurrente et créerait un doublon. **Lot P3-bis (N3) : `no_visible_effect` n'est écrit que s'il est DÉMONTRÉ** (tous les besoins examinés dans les bornes, aucun atteignable). Si l'étape 2 n'a rien
   démontré pour CE périmètre (l'offre a changé de produit, ou un motif antérieur a disparu entre les deux lectures), ou si son budget (3 s) ou son `statement_timeout`
   s'est épuisé **sans acheteur trouvé** (verrou tenu, base chargée), la demande échoue en **`reach_check_unavailable`** (503, `Retry-After: 2`, « Vérification impossible pour
   le moment, réessayez dans un instant. ») et **AUCUN devis n'est écrit** : un devis « indisponible » écrit sur une lenteur serait réutilisé 60 s et ferait d'une lenteur un
   refus (constaté : verrou de 3 s sur `matching_evaluations` → « ne ferait plus monter votre annonce », même devis accepté 78 ms plus tard).

Aucune erreur de domaine n'enregistre de ligne. **Aucune place n'est réservée** : une cotation n'est pas une promesse ; la
disponibilité est revérifiée à l'achat (propriété, admissibilité, cotation, place, plafond vendeur, **portée**).

### Comptages (une seule requête, un seul instantané)
- **places** : total et utilisées EXACTEMENT comme `readBoostSlots` (mêmes fragments SQL `BOOST_ELIGIBLE_OFFER_SQL` et
  `boostEffectiveSql`, exportés de `boosts.ts`, plus `computeSlots`) ; plafond vendeur EXACTEMENT comme `grantOfferBoost`
  (`computeSellerLimit`) ;
- **S** : voir la formule (vendeurs distincts, éligibilité de 2I1) ;
- **D** : `demand_owner_id` distincts parmi les évaluations de CETTE offre que `stored-matches` servirait côté demande : dernière
  évaluation, non périmée, **`is_confirmed_match`** (une compatibilité « unknown », c'est-à-dire à confirmer, ne compte PAS, ni
  une incompatible ni une inéligible), prédicat de fraîcheur partagé `buildMatchingFreshnessPredicate` (versions de moteur,
  `expires_at`, versions de contenu, demande active, propriétaires actifs). Un nombre daté, jamais des identités.

### Indisponibilité
Une cotation indisponible est enregistrée (`status = 'unavailable'`, montant et facteurs NULL, comptages renseignés, motif).
Ordre de priorité : `offer_already_boosted` (boost effectif ou futur sur l'offre) → `no_slot_available` (total = 0 ou used ≥ total ;
jamais un prix infini) → `seller_boost_limit_reached` → `no_compatible_buyer` (D = 0 : pas de vente sans exposition possible) →
**`no_visible_effect`** (lot P2-bis : des acheteurs compatibles existent, mais le boost ne ferait monter l'offre dans AUCUNE de leurs listes).
Le calcul de la portée n'a lieu que si aucun motif antérieur ne s'applique (inutile de le payer quand la cotation est déjà refusée). Budget de
temps épuisé, ou requête interrompue par le délai, **sans acheteur démontré** : plus un motif d'indisponibilité depuis le lot P3-bis (rien n'est démontré) mais
l'erreur `reach_check_unavailable` (503, aucun devis écrit).

### Portée visible (lot P2-bis, `lib/server/boost/reach.ts`)
Un devis n'est **disponible** que si au moins un acheteur verrait réellement l'offre monter. Constat qui a motivé la règle : avec une
annonce et un besoin, le devis était « disponible », l'achat réussissait et aucun « Sponsorisé » n'apparaissait, parce que le quota de
places mises en avant, `floor(part promue × N)`, vaut 0 sous 7 offres (part de 0,15). Du crédit dépensé sans aucun effet.

`computeBoostReach` examine les besoins actifs compatibles de l'offre (mêmes évaluations que D), du plus récent au plus ancien, et pour
chacun :
1. **N** = taille de la liste que l'acheteur voit, lue pour TOUS les besoins candidats en **UNE seule requête** (`countDemandOrganicLists`,
   **plafonnée au seuil de quota** `ceil(1 / part promue)` = 7 avec 0,15 : le coût ne dépend plus de la taille des listes ; mesuré avant plafond : 600 ms
   pour 50 listes de 200 offres) ; si `computeMaxPromoted(N, part promue)` vaut 0, le besoin est écarté sans relire son classement ;
2. sinon le classement organique de ce besoin est relu avec LA fonction de la lecture des résultats (`readDemandOrganicRanking` :
   pertinence incluse, `compareByRelevance`) ; les propriétaires et le marché de chaque offre, qui ne dépendent pas de la demande, ne sont lus
   **qu'une fois** pour toute la portée (`OrganicReadCache`, jamais partagé entre deux requêtes) ;
3. le placement est simulé par `placeBoostedItems` via `isPromotedByBoost` (aucune copie de la logique) : sont promouvables les offres
   déjà boostées PLUS celle-ci dont la pertinence atteint le seuil `min_relevance` des réglages de la catégorie du besoin. **Priorité
   d'ancienneté (lot P3)** : les boosts existants gardent leur rang (`starts_at`, puis identifiant du boost) et l'offre cotée est ajoutée comme le
   boost le **plus RÉCENT** (rang le plus bas) ; elle est « atteignable » seulement si elle y est marquée promue (quota non épuisé par les
   boosts existants, pertinence suffisante, **gain de place strict**) : **elle n'évince donc jamais un boost existant** (théorème du placement,
   `BOOST.md`). Constat prouvé avant le lot : le placement donnait la place à l'offre la mieux classée, une offre qui achetait après une autre
   pouvait lui prendre sa seule place.
Un acheteur n'est compté qu'une fois (un seul besoin atteignable suffit). Chaque besoin est évalué sous un `SAVEPOINT` : une évaluation
enregistrée illisible ou une erreur SQL sur UN besoin le fait tenir pour non atteignable (journal : le code seul), sans casser la cotation.

**Bornes (lot P3)** : au plus **20** besoins examinés pour le COMPTAGE (`BOOST_REACH_COUNT_LIMIT`, les plus récents d'abord) ; au-delà, on ne
continue que tant qu'aucun acheteur atteignable n'est trouvé et on s'arrête au premier, sans dépasser **50** besoins examinés au total
(`BOOST_REACH_SEARCH_LIMIT`). Mode « premier » (revérification d'un achat) : arrêt au premier acheteur atteignable. **Budget** de temps total
(3 s pour un devis, 1,5 s pour la revérification d'un achat) et `statement_timeout` de 2 s, ramené pour chaque besoin au budget restant :
aucune requête ne dépasse le budget. Budget épuisé ou requête interrompue sans acheteur atteignable : le résultat est 0 ET `budgetExhausted` (INDÉTERMINÉ : `isReachUndetermined`, lot P3-bis ;
`reach_check_unavailable` au devis comme à l'achat, jamais `no_visible_effect`) ; zéro acheteur SANS épuisement : DÉMONTRÉ (`no_visible_effect`) ; `statement_timeout`
borné par le budget (plancher 250 ms) dès les premières lectures ;
avec au moins un acheteur démontré : ce minimum. Le résultat est borné par `compatibleBuyers`. **`truncated`** : des besoins compatibles n'ont pas été
examinés (bornes, budget, interruption) : `reachableBuyers` est alors un MINIMUM, et l'écran dit « au moins X ». Le prix ne change pas :
`reachableBuyers` n'entre dans aucun facteur ; il décide seulement de la disponibilité et s'affiche (« Mise en avant visible auprès de X
acheteur(s) » ou « d'au moins X acheteur(s) »). Aucune identité d'acheteur ne sort : seul le nombre.

Migration **0016** : colonne `boost_quotes.reachable_buyers` (entier, NULL si non évalué : ancien devis ou motif antérieur) et CHECK
`chk_boost_quotes_reason` étendu à `no_visible_effect` ; contraintes : 0 ≤ `reachable_buyers` ≤ `compatible_buyers`, un devis `available`
n'a jamais `reachable_buyers` = 0, et `no_visible_effect` impose `reachable_buyers` = 0. Migration **0017** (lot P3, additive) : colonne
`boost_quotes.reach_truncated` (booléen, NULL si la portée n'a pas été évaluée ; renseignée seulement avec `reachable_buyers`, CHECK
`chk_boost_quotes_reach_truncated`) et index `idx_boost_quotes_seller_computed (seller_id, computed_at DESC)` (limite de débit).

### Limite de débit et créneaux de calcul (lot P3)

Au plus **20 devis calculés par vendeur et par minute** (`BOOST_QUOTE_RATE_LIMIT`, fenêtre glissante de 60 s sur `computed_at`) : le 21e est refusé
(`BoostError` `rate_limited`, **429** côté HTTP avec `Retry-After: 60`, rien d'écrit). Seuls les devis CALCULÉS comptent : une cotation réutilisée
n'est pas limitée. Le compte est exact même en parallèle (30 demandes simultanées donnent exactement 20 devis). Au plus 4 calculs de portée
simultanés par processus ; une demande qui n'a pas de créneau après 5 s reçoit `quote_busy` (503 `boost_unavailable`, rien d'écrit). Pool applicatif : 20 connexions
au plus et 5 s d'attente d'une connexion (`lib/server/postgres/client.ts`), échec propre en 503 au-delà.

### Mesures (jeu de 200 offres d'un même périmètre, 1 000 besoins compatibles, `npm run perf:boost`)

Chiffres bruts du lot (machine partagée, PostgreSQL 16.13, base jetable) — avant → après : devis atteignable 11,9 – 12,0 s → 0,41 – 0,43 s ; devis où aucun acheteur n'est
atteignable (50 besoins examinés au plus) 58,0 – 59,7 s → 0,89 – 0,90 s ; verrous de l'offre tenus par le devis 11,9 – 59,7 s → 17 – 24 ms ; achat 35 ms (sans aucune
revérification : un boost sans effet s'achetait) → 73 ms, pire cas (offre inatteignable, 50 besoins examinés) 0,87 s avec verrou de périmètre tenu 0,86 s et refus
`no_visible_effect` ; `GET /api/wallet` d'un autre utilisateur pendant douze devis simultanés 28 – 58 s → 15 ms ; mise en pause de l'offre pendant un devis 27,9 s → 11 ms ; page
de résultats d'un acheteur (200 offres) 57 → 28 ms (médiane). Commande : `npm run perf:boost` (voir `POSTGRESQL-DEVELOPMENT.md`).

### Validité
Cotation disponible : `quote_validity_seconds` (900 s par défaut). Cotation indisponible : **60 s**
(`BOOST_UNAVAILABLE_QUOTE_SECONDS`), pour que l'indisponibilité ne soit pas figée. Résultat `BoostQuote` : `id`, `offerId`,
`durationCode`, `currency`, `status`, `amount`, `rawAmount` (chaîne), `unavailableReason`, `factors` (millièmes) ou null, `inputs`
(`competingSellers`, `compatibleBuyers`, `slotsTotal`, `slotsUsed`, `reachableBuyers`, `reachTruncated`), `pricing` (`key`, `version`), `computedAt`, `expiresAt`, `reused`.

## Historiques

- `listOfferBoostQuotes({ pool, ownerId, offerId, limit 1..50 })` : l'historique du vendeur pour SON offre (`offer_not_owned`
  sinon, `offer_not_found` si l'offre n'existe pas), plus récentes d'abord (`computed_at DESC, id DESC`), avec `expired` calculé à la
  lecture. Les cotations indisponibles y figurent avec leur motif.
- `readScopeBoostPriceHistory({ pool, category, brand, model, limit 1..200 })` : l'historique des prix d'un périmètre (clé produit
  normalisée `lower(btrim)` en SQL), cotations **disponibles** seulement, plus récentes d'abord. Renvoie `computedAt`,
  `durationCode`, `currency`, `amount`, `factors` et la version tarifaire, **sans aucun identifiant d'offre ni de vendeur**.

## Exploitation

- Commande d'administration : `npm run boost:quote -- --offer <uuid> --duration 24h|3d|7d` (`DATABASE_URL` obligatoire ; le
  propriétaire est celui de l'offre). Code 0 si une cotation est renvoyée (disponible ou indisponible), 1 sinon (refus de domaine à
  texte fixe, argument invalide, `DATABASE_URL` absent, ou seul le SQLSTATE d'une erreur de base). Affiche le montant, les facteurs,
  les comptages et la validité. Aucun message brut.
- `matching:status` : avertissement `boost_pricing_missing` (code de sortie 2) si la migration 0012 est enregistrée et qu'aucune
  ligne `default` n'existe dans `boost_pricing_settings`. Rien sans la 0012. Remède : insérer une version de la configuration par
  défaut (valeurs ci-dessus).
- Changer un tarif : insérer une nouvelle ligne `(key, version + 1)`. Les cotations en cours gardent leur prix jusqu'à leur
  expiration ; l'historique garde la version qui les a produites.
- La migration 0012 doit être appliquée avant d'utiliser `quoteOfferBoost` (et, depuis le lot P1b, la **migration 0015** : la réutilisation
  exclut les cotations achetées ; depuis le lot P2-bis, la **migration 0016** : colonne `reachable_buyers` et motif `no_visible_effect` ; depuis le lot P3, la **migration 0017** : colonne `reach_truncated` et index de la limite de débit) ; `MATCHING_REQUIRED_MIGRATION` reste 0010 (le worker
  n'utilise pas les cotations).

## Limites

- **Aucun paiement, crédit, solde, achat, acceptation de cotation ni réservation de place**, aucune interface (les routes HTTP
  du vendeur existent depuis le lot 2I3, voir `BOOST-HTTP.md` ; il n'y a toujours aucune route d'administration). Deux vendeurs peuvent détenir en même temps une cotation pour la dernière place : la disponibilité sera
  revérifiée à l'achat.
- **Valeurs tarifaires provisoires**, à calibrer sur des usages réels.
- **Aucun signal d'activité suspecte** : les acheteurs « uniques » sont des propriétaires de demandes distincts ; la déduplication
  d'acheteurs multiples comptes d'une même personne, les demandes factices et la manipulation de S ou de D ne sont pas détectées
  (le brief demande d'exclure l'activité suspecte).
- **Localisation et variante exclues** du périmètre (comme 2I1) : le marché de la cotation est la clé produit.
- Un acheteur compatible ne garantit pas d'exposition : `min_relevance` et la part promue maximale s'appliquent encore au
  classement (voir `BOOST.md`). La cotation ne se déclare « disponible » que si le boost fait monter l'offre chez au moins un acheteur **au
  moment de l'estimation** ; l'état des listes peut changer ensuite (autres offres, autres boosts, autres besoins) : une cotation ne promet toujours
  aucune impression, aucune position et aucune vente. **Depuis le lot P3, la portée est revérifiée à l'achat** sous le verrou du périmètre
  (`BOOST-PURCHASE.md`) : `no_visible_effect` si plus aucun acheteur n'est atteignable, rien n'est écrit. La portée est une ESTIMATION bornée (20
  besoins comptés, 50 examinés, 3 s) : un compte tronqué est un minimum.
- Les durées longues ont un facteur configurable mais la **capacité sur toute la période** n'est pas vérifiée ici (aucune
  réservation) ; elle le sera à l'achat.
- Pas d'index fonctionnel sur `lower(btrim(...))` : le comptage des offres d'un périmètre est proportionnel à la taille du
  catalogue (acceptable en développement, comme 2I1 et le marché 2H1).
- Une cotation conserve la clé produit de l'offre à son calcul : si l'offre change de produit, une nouvelle cotation est calculée
  (l'ancienne n'est jamais réutilisée) et reste dans l'historique de son ancien périmètre.
