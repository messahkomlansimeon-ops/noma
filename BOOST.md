# BOOST.md — Boost, places limitées, plafond par vendeur (lot 2I1)

Brief SCOUTR : **§8** au plus 10 à 20 % des annonces visibles bénéficient d'un avantage boost, ratio configurable ;
**§14** places (slots) par périmètre, rares par construction ; **§15** « le paiement ne doit jamais rendre une annonce non
pertinente pertinente » : on détermine d'abord les compatibles, puis la pertinence, puis on applique le boost **à
l'intérieur** de ce classement ; **§16** un vendeur ne doit pas monopoliser les places.

**Ce lot n'a AUCUN paiement, crédit, prix dynamique ni interface** : un boost est attribué par une commande
d'administration (`npm run boost:grant`). Le boost ne s'applique qu'au tri `sort=relevance` du **sens demande**
(l'acheteur voit des offres). Le tri par score, le tri par défaut et le sens offre ne changent pas.

Code : `lib/server/boost/boosts.ts` (réglages, places, attribution, annulation, lecture des boosts effectifs),
`lib/server/boost/boost-config.ts` (durées, source, espace du verrou), `lib/server/boost/placement.ts` (placement pur),
`lib/server/matching/stored-matches.ts` (application), `database/migrations/0011_offer_boosts.sql`,
`scripts/boost-grant.ts`. **Prix dynamique et cotations vendeur (lot 2I2) : `BOOST-PRICING.md`** (migration 0012, `pricing.ts`, `quotes.ts`,
`npm run boost:quote`). Tests : `npm run test:boost` (pur + base) et `npm run test:matching-relevance` (invariants sur une
fenêtre réelle).

## Modèle

### Périmètre
Clé produit **(lower(btrim(category)), lower(btrim(brand)), lower(btrim(model)))**, comme le marché de 2H1 (le texte est
normalisé par PostgreSQL, jamais en JavaScript, pour que l'attribution, le comptage des places et le classement comparent
exactement les mêmes valeurs). La **variante** et la **localisation** (texte libre) sont exclues de la v1. **Une offre sans
catégorie, marque ou modèle (ou dont l'un est blanc) n'est pas boostable** (`offer_not_boostable`).

### Tables (migration 0011, additive : 0001 à 0010 inchangées)
- `boost_settings` : réglages, une ligne `default` (insérée par la migration) et, en option, une ligne par catégorie en
  minuscules qui la **remplace entièrement** pour les demandes de cette catégorie.
- `offer_boosts` : un boost par offre et par période. `offer_id`, `seller_id` (propriétaire de l'offre à l'attribution), périmètre
  figé et déjà normalisé (`scope_category`, `scope_brand`, `scope_model`, contrôlé par CHECK), `status` (`active`, `cancelled`,
  `expired`), `duration_code` (`24h`, `3d`, `7d`), `starts_at`, `ends_at` (`ends_at > starts_at`), `source` (`admin_grant`),
  `created_at`, `cancelled_at` (non nul si et seulement si `cancelled`, CHECK). Un **index unique partiel** (`offer_id`
  `WHERE status = 'active'`) interdit deux boosts actifs sur une offre ; deux index partiels (périmètre, vendeur) servent le
  comptage.

### Boost EFFECTIF
`status = 'active' AND starts_at <= now < ends_at`, avec `now = clock_timestamp()` de la base. Pour le classement, `now` est `at`,
l'horloge figée du curseur de pertinence (voir « Pagination »). Un boost échu garde `status = 'active'` jusqu'à la prochaine
attribution sur la même offre (ou une annulation) : il n'est **jamais** effectif ni compté dans les places, quel que soit son
statut enregistré.

## Réglages (`boost_settings`)

| Colonne | Valeur par défaut | Contrainte | Rôle |
| --- | --- | --- | --- |
| `slot_ratio` | 0,150 | > 0 et ≤ 0,5 | part des offres du périmètre qui deviennent des places |
| `min_slots` | 1 | ≥ 0 | plancher de places |
| `max_slots` | 50 | ≥ `min_slots` | plafond de places |
| `max_active_per_seller` | 2 | ≥ 1 | plafond absolu de boosts effectifs d'un vendeur dans un périmètre |
| `max_seller_slot_share` | 0,340 | > 0 et ≤ 1 | part des places qu'un vendeur peut occuper |
| `max_promoted_share` | 0,150 | > 0 et ≤ 0,2 | part maximale d'éléments promus dans le classement (§8) |
| `min_relevance` | 60,00 | 0 à 100 | pertinence minimale pour être promu |

La clé est `default` ou une catégorie en minuscules (CHECK : non vide, déjà `lower(btrim(...))`). Les réglages d'une demande se
lisent par **la catégorie de la demande** ; sans ligne pour cette catégorie (ou sans catégorie), la ligne `default`. Les
réglages sont en base pour être modifiés depuis l'administration (aucun écran dans ce lot : mise à jour SQL). Tout calcul sur les
parts se fait en **entiers (millièmes)** : aucun arrondi flottant ne décale un seuil ou une position (testé : 0,07 × 100 = 7
exactement, alors que `Math.ceil(0.07 * 100)` vaut 8).

## Places et plafond par vendeur

- `n` = offres du périmètre **publiées, non archivées, `availability ≠ unavailable`, dont le propriétaire est actif**.
- `total = clamp(ceil(slot_ratio × n), min_slots, max_slots)` (`computeSlots`, fonction pure). Petit périmètre : au moins
  `min_slots` (1 par défaut).
- `used` = boosts **effectifs** du périmètre ; `available = max(0, total − used)` (`readBoostSlots`).
- Plafond d'un vendeur dans un périmètre = `min(max(1, floor(max_seller_slot_share × total)), max_active_per_seller)`
  (`computeSellerLimit`). Avec les valeurs par défaut : 1 boost par vendeur tant que le périmètre a moins de 6 places, 2 au plus
  ensuite.

## Attribution (`grantOfferBoost`)

Validation **avant tout SQL** : pool exigé, UUID, `durationCode`, `source` (`CatalogValidationError`). Puis UNE transaction :

1. l'offre existe (`offer_not_found`), appartient à `ownerId` (`offer_not_owned`), est éligible (publiée, non archivée, non
   indisponible, propriétaire actif : `offer_not_eligible`) et a une clé produit complète (`offer_not_boostable`). La ligne de
   l'offre est verrouillée en lecture partagée jusqu'à la fin (sa clé produit ne change pas pendant l'attribution) ;
2. **verrou consultatif** `pg_advisory_xact_lock(espace, hachage(clé du périmètre))` : les attributions d'un même périmètre sont
   sérialisées (les places et le plafond vendeur sont des invariants de périmètre) ; un délai d'attente (`lock_timeout`) borne
   l'attente ;
3. les boosts `active` de CETTE offre dont `ends_at <= now` passent à `expired` ;
4. un boost effectif ou futur existe encore sur l'offre → `offer_already_boosted` ;
5. `used >= total` → `no_slot_available` ;
6. boosts effectifs du vendeur dans le périmètre `>=` plafond vendeur → `seller_boost_limit_reached` ;
7. `INSERT` avec `starts_at = now` et `ends_at = now + durée` (un seul instantané de la base : `24h` = 86 400 s, `3d`, `7d`).

Renvoie le boost et l'instantané des places. Toute erreur de domaine est une `BoostError` dont le `code` est stable et le texte
fixe (jamais d'identifiant ni de texte métier). Aucun refus ne laisse de ligne.

**Concurrence (testée)** : 6 attributions simultanées (pools distincts, avec point de rencontre forcé avant l'INSERT) dans un
périmètre de 2 places donnent exactement 2 succès et 4 `no_slot_available` ; 6 attributions d'un même vendeur (plafond 2, places
en abondance) donnent exactement 2 succès et 4 `seller_boost_limit_reached` ; deux attributions simultanées sur la même offre
donnent un succès et un `offer_already_boosted`.

## Annulation (`cancelOfferBoost`)

Réservée au vendeur du boost (`boost_not_found`, `boost_not_owned`). Conditionnelle et **idempotente** : seul un boost `active`
non échu passe à `cancelled` (avec `cancelled_at`, jamais réécrit) ; annuler un boost déjà annulé ou expiré renvoie son état
sans rien modifier ; un boost `active` dont l'échéance est passée est marqué `expired`, pas `cancelled`. Une annulation libère
la place et l'offre immédiatement. Le résultat indique si CET appel a annulé (`cancelled`).

## Commande d'administration

```
npm run boost:grant -- --offer <uuid> --duration 24h|3d|7d
```

`DATABASE_URL` est obligatoire. Le propriétaire est celui de l'offre. Code de sortie 0 si le boost est attribué, **1** pour un
refus de domaine (code stable et texte fixe), un argument invalide, `DATABASE_URL` absent ou une erreur de base (seul le code
SQLSTATE est affiché). Jamais de message brut (ni requête, ni identifiant inattendu, ni texte de la base). Tous les messages portent
la mention « Boost (administration) ». Aucun paiement, aucun crédit.

## Application dans le classement (§15 et §8)

Dans `stored-matches`, `sort=relevance`, **sens demande uniquement**, après le classement organique de la fenêtre (règles de
2H1 et 2H1-bis inchangées, indicateurs et pertinence inchangés) :

1. **promouvables** = éléments dont l'offre a un boost **effectif à `at`** (vendeur toujours propriétaire et actif, offre
   toujours éligible, clé produit actuelle de l'offre égale au périmètre du boost) **et** dont la pertinence est `>=`
   `min_relevance` des réglages de la catégorie de la demande ;
2. `maxPromus = floor(max_promoted_share × N)`, `N` = nombre d'éléments de la fenêtre (au plus 200) ;
3. **placement avec plancher** : on parcourt les positions finales p = 0 … N−1 avec la file des éléments non encore placés
   (ordre organique). À une **position de promotion** (p multiple de `ceil(1 / max_promoted_share)` : 0, 7, 14, … avec 0,15)
   tant que `maxPromus` n'est pas atteint, soit `h` la tête de la file et `x` le premier élément promouvable de la file :
   - si `x` existe **et x ≠ h** : `x` est placé en p et **promu** (il monte strictement, le quota est consommé) ;
   - sinon `h` est placé, **non promu** : aucun avantage, aucun quota consommé ;
   à toute autre position, on place la tête, non promue ;
4. aucun élément n'est ajouté, retiré ni dupliqué ; les non-promus gardent leur ordre organique relatif.

**Le boost ne peut qu'améliorer la position d'une offre promue.** Un promu ne descend jamais ; « sponsorisé » signifie « a
gagné des places grâce au boost » (`sponsored` ⇔ position finale < position organique). Un élément boosté qui atteint sa
place avant une position de promotion, ou qui est déjà en tête, n'est pas sponsorisé : il n'a rien gagné. Un non-promu
descend d'au plus le nombre de promus placés devant lui.

**Exemple chiffré** (N = 30, part 0,15 → `maxPromus` = 4, pas = 7 ; classement organique 0, 1, 2, …, 29 ; promouvables 3, 5 et 8) :
- p0 : tête 0, premier promouvable 3 ≠ tête → **3 passe en 0** (promu). File : 0 1 2 4 5 6 7 8 9 …
- p1 à p6 : on place la tête → 0 1 2 4 5 6. L'élément 5 est placé en 5, sa place organique : **aucun avantage, non sponsorisé**.
- p7 : tête 7, premier promouvable restant 8 ≠ tête → **8 passe en 7** (promu). File : 7 9 10 …
- p14 et p21 : plus aucun promouvable → la tête. Résultat : 3, 0, 1, 2, 4, 5, 6, **8**, 7, 9, 10, … 29 ; sponsorisés : 3 et 8.
  (L'ancien placement strict aux positions k × 7 donnait 3 → 0, 5 → 7 et 8 → 14 : deux offres payantes descendaient, tout en
  étant marquées sponsorisées.)

**§15, garanti par construction** : le boost ne s'applique qu'à des éléments **déjà présents** dans la fenêtre, c'est-à-dire des
correspondances confirmées et fraîches (compatibles, éligibles, non périmées). Un boost sur une offre non confirmée,
incompatible, inéligible ou périmée ne peut donc jamais la faire apparaître, et une offre sous `min_relevance` ne reçoit aucun
avantage (non sponsorisée, place organique). Le boost ne modifie ni la pertinence ni le score d'un élément. **§8** : jamais plus de
`floor(max_promoted_share × N)` promus (au plus 20 % par contrainte de base). **§16** : places et plafond par vendeur.

Sont sans aucun effet : un boost expiré, annulé, futur (à `at`), d'un vendeur suspendu ou archivé, d'une offre devenue inéligible
ou dont la clé produit a changé depuis l'attribution.

## Transparence : `sponsored`

Chaque item `stored-matches` porte `sponsored: boolean` : **vrai uniquement pour un élément promu, c'est-à-dire qui a gagné des places**, faux partout ailleurs (tri
par score, tri par défaut, sens offre, éléments non promus, y compris une offre boostée qui n'a rien gagné). Le DTO n'expose **jamais**
l'identifiant du boost, ses dates, sa durée, sa source ni le vendeur (vérifié sur la réponse HTTP brute). `contractVersion` ne
change pas (ajout rétrocompatible d'un champ).

## Pagination

Le décalage du curseur de pertinence s'applique à l'**ordre final** (boost compris), calculé à `at` (horloge figée à la première
page, bornée à la base : voir `MATCHING-RELEVANCE.md`). Conséquences, testées :
- une attribution postérieure à `at` n'a aucun effet sur les pages suivantes du même parcours (son `starts_at` est postérieur à
  `at`) ; une nouvelle première page en tient compte ;
- une **annulation**, la suspension du vendeur, le passage de l'offre à un statut inéligible ou la modification de sa clé
  produit **entre deux pages** peut modifier l'ordre des pages suivantes : le statut est lu à l'instantané de chaque page, seule
  l'horloge est figée. De même, une attribution de boost peut modifier l'ordre entre deux parcours différents. L'ordre des pages
  suivantes est recalculé (la liste des correspondances elle-même est déjà relue à chaque page : limite héritée de 2H1).

## Panne du boost : jamais une panne du classement

Les résultats organiques passent avant le revenu (§15). L'étape boost de `stored-matches` s'exécute sous un **SAVEPOINT** dans
la transaction de lecture. En cas de réglages absents (`boost_settings_missing`, aucune ligne `default`) ou de **toute**
erreur de l'étape (par exemple `42P01` si la migration 0011 est absente, délai, erreur SQL), la lecture fait
`ROLLBACK TO SAVEPOINT` et renvoie la liste complète en **ordre organique, `sponsored` faux partout** ; la transaction reste
utilisable (`processing` et `readAt` sont présents, le `COMMIT` reste un `COMMIT`). Rien n'est renvoyé au client : la réponse
garde exactement la même forme, sans message d'erreur. Côté serveur, seul le **code** de l'erreur est journalisé
(`[matching] étape boost ignorée (<code>)`), jamais un message brut. Sans boost effectif parmi les éléments de la fenêtre, les
réglages ne sont pas lus (pas de panne possible, pas de journal).

**Avertissement `matching:status`** : `boost_settings_missing` signale l'absence de la ligne `default` de `boost_settings`
(le boost est alors inactif, le classement organique est servi). Il n'est émis que si la migration 0011 est enregistrée ; le
code de sortie vaut alors 2. Remède : réinsérer les réglages par défaut (valeurs de la migration 0011).

## Prérequis d'exploitation

`sort=relevance` côté demande lit `boost_settings` et `offer_boosts` ; sans la migration 0011, l'étape boost échoue en `42P01`
et le classement organique est servi (voir « Panne du boost »). Appliquer la migration reste nécessaire pour activer le boost.
`MATCHING_REQUIRED_MIGRATION` reste 0010 : le worker et le bootstrap n'utilisent pas le boost.

## Limites

- **Aucun paiement, crédit, solde, achat ni réservation de place**, **aucune métrique d'efficacité**, **aucune interface** (le prix dynamique et
  les cotations vendeur existent depuis le lot 2I2, voir `BOOST-PRICING.md` ; une cotation n'est ni un achat ni une réservation) :
  l'attribution n'est possible que par l'administration (`boost:grant`) ; les réglages se modifient en SQL.
- **Localisation et variante exclues** du périmètre : « iPhone 13 128 Go à Cocody » et « 256 Go à Plateau » partagent les mêmes
  places.
- **Boost uniquement dans `stored-matches`, tri `relevance`, sens demande** : aucun boost dans `/api/search` ni dans les routes
  `/matches` en direct, ni dans le sens offre.
- **Placement avec plancher** : un boost n'améliore la position d'une offre que s'il la fait monter ; une offre déjà bien
  classée (ou qui atteint sa place avant la position de promotion suivante) n'est ni déplacée ni sponsorisée, et le quota
  n'est pas consommé. Le nombre d'offres sponsorisées peut donc être inférieur à `floor(max_promoted_share × N)`.
- Un boost échu garde le statut `active` en base jusqu'à la prochaine attribution ou annulation sur la même offre (aucun
  balayeur) ; il n'a aucun effet ni ne compte.
- Pas d'index fonctionnel sur `lower(btrim(...))` : le comptage des offres d'un périmètre est proportionnel à la taille du
  catalogue (acceptable en développement, comme le marché 2H1).
- Le périmètre d'un boost est figé à l'attribution : si l'offre change de produit, son boost n'a plus d'effet (mais occupe encore
  une place de l'ancien périmètre jusqu'à son terme ou son annulation).
- Un seul vendeur reste possible par offre (le propriétaire) ; aucune attribution « au nom » d'un autre.
