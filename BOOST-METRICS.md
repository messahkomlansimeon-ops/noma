# BOOST-METRICS.md — Expiration des boosts et journal d'exposition (lot 2I4)

> **Mise à jour (lot M1)** : les ouvertures de la fiche d'une annonce, les contacts, les statistiques du vendeur (route `GET /api/offers/{id}/stats`, écran « Ce que produit votre annonce »),
> l'**arrondi des comptes publiés** (« moins de 5 », « environ N », lot M1-quater) et la **rétention de 400 jours** (`npm run metrics:purge`) existent : voir `MESURES.md` (définitions exactes, dénominateurs, attribution au boost, limites).
> Ce qui suit décrit l'état du lot 2I4 ; ses « Limites » sur l'absence de clic, de contact, de route HTTP et de purge sont levées par le lot M1, sauf la vente (toujours non mesurée).
> `readOfferBoostExposureStats` et `npm run boost:stats` restent des lectures d'**administration** (comptes bruts, sans arrondi) ; la lecture du **vendeur** arrondit tous ses comptes.

Brief SCOUTR §19 et §35, AUDIT-EVOLUTION-SCOUTR.md §6 « Mesure et économie » : le vendeur qui boost une offre doit pouvoir savoir
ce que son boost a produit. **Ce lot est entièrement côté serveur** : aucune route HTTP, aucune interface, aucun paiement ni
crédit, aucun clic, favori, contact, conversation, vente ni impression « réellement visible » (ils exigent les écrans), aucune
purge ni rétention. Le classement, la pertinence, le placement, `sponsored`, les cotations et les prix sont inchangés.

Code : `lib/server/boost/exposures.ts` (`recordBoostExposures`, `readOfferBoostExposureStats`), `lib/server/boost/boosts.ts`
(`expireOfferBoosts`, `readEffectiveBoostsByOffer`), `lib/server/matching/stored-matches.ts` (production et écriture isolée du
journal), `lib/server/matching/runner.ts` (étape boost du worker), `lib/server/matching/status.ts`,
`database/migrations/0013_boost_exposures.sql`, `scripts/boost-stats.ts`. Tests : `npm run test:boost-expiry`,
`npm run test:boost-exposures` (base `TEST_DATABASE_URL` dédiée).

## Ce qui est mesuré : des apparitions SERVIES, pas des impressions visibles

Une ligne de `boost_exposures` compte les fois où une **réponse de `stored-matches`** a servi l'offre boostée à un acheteur. Cela ne
veut pas dire que l'acheteur l'a vue : aucun écran n'existe, et rien ne prouve qu'une page servie a été affichée ou lue. Le mot
« impression » est volontairement absent du schéma et des noms de colonnes.

**Quand** : à chaque réponse en `sort=relevance`, **sens demande** (l'acheteur lit les offres), quand l'étape boost a réussi.
**Jamais** : `sort=score`, tri par défaut, sens offre (le vendeur lit des demandes), repli organique après une panne de l'étape boost.

**Quoi** : chaque élément de la **page servie** (la tranche `offset … offset + limit`, pas la fenêtre de 200) dont l'offre a un boost
**effectif à `at`**, sponsorisé ou non. Une offre boostée déjà en tête, ou sous `min_relevance`, compte comme une apparition **non
sponsorisée** : elle a été servie sans rien gagner. Une offre sans boost effectif n'est jamais enregistrée.

**Valeurs**
- `position` = position dans l'ordre FINAL complet (décalage de la page compris), à partir de 0.
- `gain` = `max(0, position organique − position finale)` : les places gagnées grâce au boost. Une offre qui n'a rien gagné a un
  gain de 0, y compris si elle a été repoussée par un promu placé devant elle.
- `sponsored` = « a gagné des places » (même définition que le champ `sponsored` de l'API, voir `BOOST.md`).

## Déduplication : par boost, par demande, par jour UTC

Clé primaire `(boost_id, demand_id, served_day)`. Servir la même page plusieurs fois le même jour à la même demande **augmente
`servings`** au lieu d'ajouter une ligne ; une autre demande, ou un autre jour, est une autre ligne.

- `served_day` = date **UTC de `at`**, l'horloge figée du curseur de pertinence : une même traversée paginée reste sur le même jour,
  même si elle franchit minuit UTC.
- `servings` = nombre d'apparitions servies ; `sponsored_servings` = celles qui étaient sponsorisées (≤ `servings`).
- `best_position` = la plus haute position atteinte (`LEAST`) ; `best_gain` = le plus grand gain (`GREATEST`).
- `first_served_at`, `last_served_at` : horloge de la base.

## Définitions des statistiques du vendeur (`readOfferBoostExposureStats`)

Pour chaque boost de l'offre, du plus récent au plus ancien (`starts_at`, `id`), 1 à 20 boosts (20 par défaut) :

| Champ | Définition exacte |
| --- | --- |
| `status` | effectif à la lecture : `cancelled` ; sinon `expired` (statut `expired` **ou** `ends_at` passé) ; sinon `scheduled` (`starts_at` futur) ; sinon `effective` |
| `uniqueBuyersExposed` | `viewer_id` distincts (propriétaires de demandes) à qui l'offre a été servie. **Deux demandes du même acheteur comptent une fois.** |
| `uniqueBuyersSponsored` | `viewer_id` distincts avec au moins une ligne où `sponsored_servings > 0` |
| `servings`, `sponsoredServings` | sommes des colonnes du journal |
| `bestPosition`, `bestGain` | minimum de `best_position`, maximum de `best_gain` (`null` sans aucune apparition) |
| `activeDays` | `served_day` distincts |

Le **gain de places** d'un boost est donc lu dans `bestGain` (le plus grand nombre de places gagnées en une apparition) et dans
`sponsoredServings` (le nombre d'apparitions où le boost a effectivement servi). Lecture seule, un instantané. Erreurs de domaine
comme les cotations (2I2) : `offer_not_found`, `offer_not_owned`. Commande d'administration :

```
npm run boost:stats -- --offer <uuid>
```

`DATABASE_URL` obligatoire ; le propriétaire est celui de l'offre ; code 0 si les statistiques sont affichées (zéro boost compris),
1 pour un refus de domaine (texte fixe), un argument invalide, `DATABASE_URL` absent ou une erreur de base (SQLSTATE seul). Toutes
les lignes portent « Boost (administration) » ; jamais de message brut.

## Exclusion du vendeur

Les évaluations de matching relient une offre et une demande de **propriétaires distincts** : le vendeur d'une offre boostée n'est
jamais servi sa propre offre, donc aucune ligne n'a `viewer_id` = vendeur du boost (testé sur un vendeur qui a aussi une demande :
ses apparitions d'**autres** boosts sont journalisées, jamais celles du sien).

## Un journal en panne ne change jamais la réponse

Le journal est écrit **après** la transaction de lecture (qui reste `REPEATABLE READ READ ONLY` et se termine par `COMMIT`), dans une
transaction **courte et séparée**, avec `SET LOCAL statement_timeout = '2s'`, en un seul `INSERT … SELECT FROM unnest(…) ON CONFLICT
(boost_id, demand_id, served_day) DO UPDATE`. Les lignes sont triées par boost : deux écritures concurrentes de la même page
prennent leurs verrous dans le même ordre (testé : 8 lectures simultanées donnent exactement `servings = 8`, sans blocage).

Toute erreur (table absente `42P01`, délai `57014`, clé étrangère, base indisponible…) est attrapée ; seul le **code** est
journalisé côté serveur (`[matching] journal d'exposition ignoré (<code>)`, même règle que l'étape boost). La réponse est
strictement identique avec ou sans journal : même ordre, mêmes champs, même curseur (testé par `deepEqual` contre une réponse témoin).
Le prix de cette garantie : l'enregistrement est **attendu** avant de répondre (au plus 2 s en cas de blocage de verrou).

L'ordre servi et le journal viennent d'**une seule lecture** des boosts effectifs (`readEffectiveBoostsByOffer`, qui renvoie
offre → boost) : ils ne peuvent pas diverger. Ses offres égalent celles de `readEffectiveBoostedOfferIds` dans toutes les
situations de 2I1 et à plusieurs instants (test différentiel).

## Confidentialité

`viewer_id` et `demand_id` sont stockés pour dédoublonner et compter des acheteurs distincts ; **aucune lecture destinée au vendeur
ne les renvoie** : la lecture n'expose que des comptages. La sortie sérialisée de `readOfferBoostExposureStats` et celle de
`boost:stats` ne contiennent ni identité d'acheteur, ni identifiant de demande, ni texte métier (vérifié). Un comptage de 1
acheteur unique identifie néanmoins le seul acheteur concerné pour qui le connaît : aucun arrondi n'est appliqué dans cette lecture d'administration (la lecture du vendeur, elle, arrondit).

## Expiration automatique des boosts

`expireOfferBoosts({ pool, limit })` marque `expired` les boosts `active` dont `ends_at <= maintenant` (UNE requête, `limit` de 1 à
1000, 200 par défaut, les plus anciennes échéances d'abord, `FOR UPDATE SKIP LOCKED`). Ne touche ni un boost annulé, ni déjà expiré,
ni futur, ni `cancelled_at` ; idempotent ; deux balayages simultanés ne comptent jamais deux fois le même boost. L'étape boost du
worker (`runMatchingCycle`, juste après l'étape temporelle) l'exécute à chaque cycle quand la migration 0011 est enregistrée ;
`boostLimit` règle sa limite. Un boost échu n'a **jamais** été effectif ni compté : le balayage ne change que son statut enregistré.
Avertissement `boost_expiry_overdue` de `matching:status` si un boost reste `active` plus de 10 minutes après son échéance (le worker
ne tourne pas). Voir `BOOST.md`, `MATCHING-RUNNER.md` et `MATCHING-OPERATIONS.md`.

**Conséquence sur la pagination.** Le statut d'un boost est lu à l'instantané de chaque page (règle de 2I1). Un parcours commencé
avant l'échéance d'un boost (curseur `at` antérieur à `ends_at`) garde le boost tant qu'il est `active`, mais **le perd dès que le
worker l'a marqué `expired`** : les pages suivantes sont alors servies sans lui (testé). C'est la même classe de variation que
l'annulation entre deux pages.

## Limites

- **Aucun clic, favori, contact, conversation ni vente** : sans écran, « servi » est la seule mesure honnête. Aucune conversion ne
  peut être déduite de ce journal.
- **Pas une audience** : une page servie n'a pas forcément été vue ; plusieurs onglets, rafraîchissements ou une pagination
  automatique multiplient `servings` (c'est pourquoi les acheteurs uniques sont comptés à part).
- **Aucune détection d'activité suspecte** : deux comptes d'une même personne comptent pour deux acheteurs.
- **Aucune rétention ni purge** : une ligne par boost, demande et jour, qui s'accumule (cascade à la suppression du boost, de la
  demande, de l'acheteur ou de l'offre).
- **Jour UTC** : `served_day` n'est pas le jour local (Abidjan = UTC, mais ce n'est pas une règle de la base).
- **Ordre servi ≠ affiché** : la position est celle de l'ordre final complet, pas un rang d'écran.
- **Fenêtre de pertinence** : seule la fenêtre de pertinence (200 éléments au plus) est évaluée ; une offre boostée au-delà n'est
  pas servie, donc pas journalisée.
- **Un échec d'écriture n'est pas rejoué** : l'apparition correspondante est perdue (le journal est un compteur, pas une garantie).
- Les statistiques ne sont pas exposées par HTTP (lot suivant) : `readOfferBoostExposureStats` et `boost:stats` seulement.
