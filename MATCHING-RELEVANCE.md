# MATCHING-RELEVANCE.md — Indicateurs séparés et pertinence organique (lot 2H1)

Brief SCOUTR §5 : la **compatibilité** (déjà calculée et enregistrée), le **prix** (position par rapport au marché
observé), la **disponibilité** (fraîcheur de la confirmation du stock) et la **confiance** (éléments de vérification
disponibles) restent quatre indicateurs distincts. « Un score de compatibilité n'est jamais une garantie de
fiabilité. » §15 : 1) déterminer les offres compatibles ; 2) calculer leur pertinence ; 3) appliquer plus tard un
boost à l'intérieur d'un ensemble déjà pertinent. **Ce lot fait 1) et 2), sans boost.**

Code : `lib/server/matching/relevance-config.ts` (TOUS les seuils et poids, constante figée), `indicators.ts`
(fonctions pures), `market.ts` (marché, SQL), `stored-matches.ts` (intégration). Tests : `npm run
test:matching-indicators` (pur), `npm run test:matching-relevance` (base `TEST_DATABASE_URL` dédiée).

**Calculés à la lecture, jamais enregistrés** : ni le moteur 2A/2B, ni `MATCHING_OFFLINE/SCORING_CONTRACT_VERSION`,
ni `persistence.ts`, ni les évaluations enregistrées ne changent. Un changement de version de moteur masquerait toute
ligne enregistrée et aucun mécanisme ne les réévalue encore. Changer une valeur de `relevance-config.ts` change donc
instantanément les indicateurs servis, sans réévaluation.

## Les quatre indicateurs

| Indicateur | Concerne | Valeurs |
| --- | --- | --- |
| Compatibilité | la paire | le score 2B enregistré (0 à 100), inchangé |
| Disponibilité | l'OFFRE de la paire | `level` + `score` 0..100 (ou null) + `confirmedAgeHours` + `factors` |
| Prix | l'OFFRE de la paire | `position` + `score` + `deltaPercent` + `sampleSize` |
| Confiance | le PROPRIÉTAIRE et l'annonce du candidat | `level` + `score` 0..100 + `accountAgeBand` + `factors` |

### Disponibilité (`availability`)
`available` confirmée depuis ≤ 72 h → `confirmed_recent` (100) ; ≤ 14 jours → `confirmed` (70) ; sans confirmation ou
confirmée il y a plus de 14 jours → `unconfirmed` (40) ; `reserved` → `reserved` (20) ; statut NULL → `unknown`
(null). Si la quantité de l'offre ET la quantité demandée sont connues et que la première est inférieure à la
seconde, le score est **plafonné à 30** (jamais relevé) et `insufficient_quantity` figure dans `factors`.
`confirmedAgeHours` est l'âge entier de la dernière confirmation (borne 72 h et 14 jours incluses). Le statut
`unavailable` (score 0) est inatteignable : une offre indisponible n'est pas éligible.

### Prix (`price`)
Position du prix de l'offre dans le marché observé, **hors l'offre elle-même** : **strictement sous p25** →
`below_market` (100) ; **p25 ≤ prix ≤ p75** → `in_market` (60) ; au-dessus de p75 → `above_market` (20). Dans un marché
dégénéré (p25 = médiane = p75, par exemple toutes les offres au même prix), un prix égal est donc `in_market`
(écart 0), jamais `below_market`. Prix absent, marché absent, médiane nulle ou échantillon < 5 →
`insufficient_data` (score null) avec un facteur qui distingue les deux causes : **`price_missing`** (le vendeur n'a
pas donné de prix, prioritaire) ou **`insufficient_market`** (prix présent, marché insuffisant : ce n'est pas un choix
du vendeur). `deltaPercent` = arrondi entier de (prix − médiane) / médiane × 100. Le marché brut (percentiles, prix
d'autres offres) n'est jamais exposé : seuls position, `deltaPercent`, `sampleSize` et `factors` le sont.

### Confiance (`confidence`)
Points : téléphone vérifié 40 ; ancienneté du compte ≥ 30 jours 20 (≥ 7 jours 10) ; complétude des champs structurés
applicables au prorata sur 30 (offre : category, brand, model, condition, price, location ; demande : category, brand,
model, condition, location) ; offre dont la disponibilité a déjà été confirmée 10. Pour une **demande** ce dernier
facteur ne s'applique pas : le total est renormalisé sur 90. `level` : `high` ≥ 70, `medium` ≥ 40, `low` sinon.
`factors` : codes stables (`phone_verified` / `phone_not_verified`, `account_age_lt_7d|7d_30d|gte_30d`,
`structured_fields_complete|partial|none`, `availability_confirmed`). **L'ancienneté n'est exposée que par tranche**
(`lt_7d`, `7d_30d`, `gte_30d`) : ni date de création exacte, ni téléphone, ni identifiant de propriétaire.

## Pertinence

Nombre 0..100 arrondi à 2 décimales, calculé **uniquement pour une correspondance confirmée** (compatible ET éligible
ET fraîche, voir `MATCHING-STORED-READ.md`). Poids : compatibilité 0,55, disponibilité 0,20, prix 0,15, confiance
0,10. **Seule une composante non applicable selon le sens est retirée** (poids restants renormalisés) ; une valeur
**inconnue** dans une composante applicable est **remplacée** par une valeur de substitution, jamais retirée (voir
« Information inconnue ou cachée »).

- **Sens demande** (`/api/demands/[id]/stored-matches` : l'acheteur voit des offres) : les quatre composantes.
- **Sens offre** (`/api/offers/[id]/stored-matches` : le vendeur voit des demandes) : compatibilité et confiance de
  l'acheteur seulement. La disponibilité et le prix de SA propre offre sont identiques pour tous les éléments : non
  applicables. Dans ce sens, `indicators.availability` et `indicators.price` valent **null** dans chaque item.

Propriétés testées : monotone (améliorer une composante définie ne fait jamais baisser la pertinence), « déclarer ne
fait jamais perdre », déterministe, aucune pertinence pour une ligne non confirmée.

## Information inconnue ou cachée

**Règle.** Quand une composante applicable est inconnue, la pertinence utilise une valeur de **substitution** définie
dans `relevance-config.ts` (`relevance.substitutes`) :

| Cas (sens demande) | Substitution | Position relative |
| --- | --- | --- |
| disponibilité inconnue (statut NULL) | 30 | sous `unconfirmed` (40), au-dessus de `reserved` (20) |
| prix absent de l'offre (le vendeur ne l'a pas donné) | 20 | pas mieux qu'un prix `above_market` (20) |
| prix présent, marché insuffisant (échantillon < 5, percentiles indisponibles) | 50 | neutre, sous `in_market` (60) |
| compatibilité null sur une correspondance confirmée | 50 | — |

La substitution ne sert **qu'au calcul de la pertinence** : les indicateurs exposés restent honnêtes
(`availability.score` et `price.score` valent `null` quand l'information est inconnue ; `price.factors` indique
`price_missing` ou `insufficient_market`).

**Pourquoi.** La première version retirait toute composante `null` puis renormalisait les poids. Une valeur inconnue
disparaissait donc du calcul alors qu'une valeur déclarée mais médiocre y figurait : pour quatre offres par ailleurs
identiques (compatibilité 100), une disponibilité non renseignée donnait 90, une disponibilité « available » non
confirmée 80 ; un prix caché donnait 75,88, un prix au-dessus du marché 68. Ne rien dire battait le vendeur honnête :
une incitation à cacher l'information, inacceptable puisque le boost (§15) reposera sur ce classement. Avec la
substitution, **déclarer ne fait jamais perdre** : une disponibilité `available` (même non confirmée) et tout prix
déclaré (même au-dessus du marché) donnent une pertinence au moins égale à l'information cachée (propriété testée par
une grille exhaustive). `reserved` (20) reste **strictement** sous l'inconnu (30) : c'est un état réellement moins bon,
pas une information cachée. La renormalisation, elle, ne subsiste que pour les composantes **non applicables** du sens
offre (disponibilité et prix de sa propre offre).

## Tri, fenêtre et pagination

`sort=score` (défaut) : STRICTEMENT le comportement et les curseurs d'avant le lot (score DESC NULLS LAST, date, id).
`sort=relevance` : lit au plus `RELEVANCE_WINDOW` = **200** correspondances confirmées et fraîches (dans l'ordre du
score), calcule les indicateurs, puis trie par pertinence DESC, score DESC NULLS LAST, `evaluated_at` DESC, id DESC.
Si plus de 200 correspondances existent, **`truncated: true`** : seules les 200 meilleures par score sont triées (les
suivantes ne sont jamais servies avec ce tri). La fenêtre est réglable par une option de test que HTTP n'expose pas.

Pagination par **décalage** avec le curseur strict `{ v: 1, sort: "relevance", sourceKind, sourceId, offset, at }` (`at` =
`readAt` de la première page, ISO à 6 décimales). Les pages suivantes recalculent les indicateurs avec **now = at**,
figé : le passage du temps entre deux pages ne déplace aucun seuil (72 h, 14 jours, ancienneté). **`at` est borné par
l'horloge de la base**, lue dans le même instantané avant tout calcul : un `at` postérieur à l'horloge + 5 s est
refusé (sinon un client déplacerait à volonté les échéances) et un `at` antérieur à l'horloge − 1 h est un curseur
**expiré** (le client recommence à la première page) ; les deux donnent une erreur de validation (400). Les bornes sont
dans `relevance-config.ts` (`relevance.cursorAt`). Un curseur de score
avec `sort=relevance` (ou l'inverse), ou d'une autre source ou d'un autre sens, est refusé (400). **Limite** : `at`
fige l'horloge, pas les données : une modification de `availability_confirmed_at`, de prix ou de statut entre deux
pages qui change un niveau à `at` change légitimement l'ordre (une modification qui reste dans la même tranche ne le
change pas), et la liste des correspondances elle-même (fraîcheur) est relue à chaque page.

## Marché observé (`market.ts`)

Offres retenues : publiées, non archivées, disponibilité ≠ `unavailable` (NULL accepté), propriétaire actif et non
archivé, prix renseigné, même devise. Clé : `(lower(btrim(category)), lower(btrim(brand)), lower(btrim(model)),
price_currency)`. **La variante est ignorée en v1.** Sample et percentiles (`percentile_cont` 0,25 / 0,5 / 0,75) par une
seule requête par page ; l'offre évaluée est exclue de SON marché (jointure d'exclusion : un percentile se recalcule
sans l'offre, il ne se soustrait pas). Seuil d'échantillon : 5 (`relevance-config.ts`).

## Garanties

- **§5** : quatre indicateurs séparés ; la pertinence n'est qu'une combinaison pour le tri et ne remplace jamais le
  score de compatibilité (toujours servi tel qu'enregistré).
- **§15** : seules les correspondances confirmées et fraîches sont lues (aucune incompatible, inéligible ou périmée
  n'apparaît, quel que soit l'indicateur) ; la pertinence se calcule à l'intérieur de cet ensemble ; **aucun boost**.

## Limites

- Marché **interne seulement** (offres de la base), aucune source externe ; variante ignorée ; pas d'index sur
  `lower(btrim(...))` (coût proportionnel à la taille du marché par offre de la page, acceptable en développement).
- **Aucune réputation** (avis, historique de transactions) : la confiance ne mesure que la vérification du téléphone,
  l'ancienneté, la complétude et la confirmation de disponibilité.
- Indicateurs **non enregistrés** : recalculés à chaque lecture (coût d'une requête de marché et d'une requête de
  propriétaires par page ; 200 éléments au plus pour le tri par pertinence).
- `deltaPercent` combiné au prix public du candidat permet de retrouver la médiane du marché ; décision assumée.
- `truncated` : au-delà de 200 correspondances, le tri par pertinence ne voit pas les moins bien notées en score.
