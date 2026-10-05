# BOOST-PRICING.md — Prix dynamique du boost et cotations vendeur (lot 2I2)

Brief SCOUTR §18 et AUDIT-EVOLUTION-SCOUTR.md §6 « Cotation et achat » : un vendeur obtient une **cotation** (un prix daté,
conservé pendant sa courte validité) pour le boost de son offre. **Ce lot n'a AUCUN paiement, crédit, solde, achat,
acceptation de cotation ni réservation de place, et aucune route HTTP ni interface** (lot 2I3). Le comportement des lots 2I1 et
2I1-bis (attribution, annulation, places, placement, classement) n'est pas modifié. **Depuis le lot 2I3, le vendeur obtient ces
cotations par HTTP (`POST` et `GET /api/offers/{id}/boost-quotes`) : voir `BOOST-HTTP.md`.**

Code : `lib/server/boost/pricing.ts` (fonctions pures), `lib/server/boost/quotes.ts` (comptages, cotation, historiques),
`database/migrations/0012_boost_pricing.sql`, `scripts/boost-quote.ts`. Tests : `npm run test:boost-pricing` (pur),
`npm run test:boost-quotes` (base `TEST_DATABASE_URL` dédiée).

## Formule

**montant = base × concurrence × demande × rareté × durée**, avec des facteurs déterministes et bornés, exprimés en
**millièmes entiers**, calculés sur des données datées (un seul instantané de comptage).

| Facteur | Définition | Réglage |
| --- | --- | --- |
| concurrence | `min(competition_max, 1000 + competition_step × S)` ; **S** = vendeurs AUTRES distincts ayant au moins une offre éligible dans le périmètre (les doublons d'un même vendeur ne gonflent rien, les offres du vendeur coté ne comptent pas) | 20 / 1 500 |
| demande | `min(demand_max, 1000 + demand_step × (D − 1))` ; **D ≥ 1** = acheteurs compatibles distincts | 100 / 3 000 |
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

### Exemple de contrôle (réglages par défaut)
S = 3, D = 4, 1 place utilisée sur 3, durée 3d : concurrence `1000 + 20 × 3 = 1 060`, demande `1000 + 100 × 3 = 1 300`, rareté
`1000 + floor(1000 × 1 / 3) = 1 333`, durée 2 500. Brut `500 × 1,060 × 1,300 × 1,333 × 2,500 = 2 296,0925`, arrondi à la grille de
100 : **2 300 XOF**. Pour la même situation : 24h → brut 918,437 → 900 ; 7d → brut 4 592,185 → 4 600. Quelques repères
supplémentaires (testés) : un brut de 2 250 s'arrondit à 2 300 (demi-haut), 2 248,5 à 2 200 ; un brut de 450 avec min 1 000 donne
1 000 ; un brut de 374 850 avec max 50 000 donne 50 000.

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
durée). Puis une transaction READ COMMITTED dont les premières instructions sont `SET LOCAL lock_timeout` et un **verrou
consultatif par offre** (espace distinct de celui des périmètres). Pas de REPEATABLE READ : un instantané pris avant le verrou
masquerait une cotation concurrente et créerait un doublon.

1. contrôles de l'offre (ligne verrouillée en lecture partagée) : `offer_not_found`, `offer_not_owned`, `offer_not_eligible`,
   `offer_not_boostable` (mêmes règles que l'attribution) ;
2. **réutilisation** : une cotation de cette offre, de même durée, même vendeur et même périmètre, avec `expires_at > maintenant`,
   est renvoyée telle quelle (`reused: true`, aucune écriture), **même si les comptages ou la version tarifaire ont changé** ;
3. sinon : réglages tarifaires (`boost_pricing_missing` sans aucune ligne), puis les comptages en **une seule requête**, puis le
   prix ou l'indisponibilité, puis `INSERT` (`computed_at = clock_timestamp()`).

Aucune erreur de domaine n'enregistre de ligne. **Aucune place n'est réservée** : une cotation n'est pas une promesse ; la
disponibilité sera revérifiée à l'achat, au lot paiement (propriété, admissibilité, cotation, place, plafond vendeur).

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
jamais un prix infini) → `seller_boost_limit_reached` → `no_compatible_buyer` (D = 0 : pas de vente sans exposition possible).

### Validité
Cotation disponible : `quote_validity_seconds` (900 s par défaut). Cotation indisponible : **60 s**
(`BOOST_UNAVAILABLE_QUOTE_SECONDS`), pour que l'indisponibilité ne soit pas figée. Résultat `BoostQuote` : `id`, `offerId`,
`durationCode`, `currency`, `status`, `amount`, `rawAmount` (chaîne), `unavailableReason`, `factors` (millièmes) ou null, `inputs`
(`competingSellers`, `compatibleBuyers`, `slotsTotal`, `slotsUsed`), `pricing` (`key`, `version`), `computedAt`, `expiresAt`, `reused`.

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
- La migration 0012 doit être appliquée avant d'utiliser `quoteOfferBoost` ; `MATCHING_REQUIRED_MIGRATION` reste 0010 (le worker
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
  classement (voir `BOOST.md`). Une cotation ne promet aucune impression.
- Les durées longues ont un facteur configurable mais la **capacité sur toute la période** n'est pas vérifiée ici (aucune
  réservation) ; elle le sera à l'achat.
- Pas d'index fonctionnel sur `lower(btrim(...))` : le comptage des offres d'un périmètre est proportionnel à la taille du
  catalogue (acceptable en développement, comme 2I1 et le marché 2H1).
- Une cotation conserve la clé produit de l'offre à son calcul : si l'offre change de produit, une nouvelle cotation est calculée
  (l'ancienne n'est jamais réutilisée) et reste dans l'historique de son ancien périmètre.
