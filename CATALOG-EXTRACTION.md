# Extraction et normalisation du catalogue — contrat v1

Le module serveur `lib/server/catalog-extraction` retourne uniquement une
proposition. Il ne connaît ni PostgreSQL, ni les routes HTTP, ni un fournisseur
IA et ne modifie jamais une offre ou une demande.

## Réemploi et écarts

- Réutilisé : `parseNeed` pour modèle, variante, capacité, localisation,
  critères et budget ; `parsePrice` pour interpréter les montants d'offre ;
  `semanticEvidenceState` et `valueSupportedByEvidence` pour contrôler les
  preuves et négations.
- Adapté : les valeurs du PoC sont projetées vers un contrat catalogue commun,
  avec unités canoniques et unité source conservée.
- Ajouté car absent : catégorie, marque, quantité explicitement libellée,
  délai daté, ambiguïtés, provenance, validation de sortie IA et distinction
  stricte entre caractéristiques d'offre et critères d'achat.
- Non réutilisé : les schémas de `normalize.ts` concernent des annonces de
  sources externes et leurs scores, pas une proposition métier interne.

## Contrat

Entrée : `{ type: "offer" | "demand", rawText: string }`. Le texte non vide est
conservé à l'identique et borné à 10 000 caractères et 32 Kio UTF-8.

La sortie `catalog-extraction/v1` contient :

- `fields`, dont chaque valeur inconnue reste `null` ;
- `evidence`, avec un chemin de champ et une citation exacte du texte ;
- `ambiguities`, avec champ, code, explication et citations ;
- `provenance: deterministic | ai` et une `extractorVersion` explicite.

Une caractéristique suit `{ key, value, unit, sourceUnit }`. `key`, `value` et
`unit` sont canoniques pour le futur matching (`storage_capacity` est exprimé
en `GB`, donc `1 To` devient `1024 GB`) ; `sourceUnit` conserve exactement
l'unité écrite (`Go`, `gigaoctets`, `téraoctet`, `pouces`, etc.).

Un critère suit `{ key, operator, value }`, où `operator` vaut `includes`,
`excludes` ou `equals`. Seules les demandes portent `requirements` et
`preferences`. Une caractéristique d'offre comme « sans chargeur » reste une
caractéristique booléenne et ne devient jamais une contrainte acheteur.

Une devise absente reste `null`. Plusieurs modèles, capacités, quantités,
délais ou montants incompatibles produisent une ambiguïté et aucune valeur
choisie. Une absence ne produit pas cette ambiguïté. Modèle, capacité,
quantité, mesure et montant sont analysés séparément ; kilométrage, volume et
autres mesures explicites ne deviennent jamais des prix.

Limites déterministes v1 : les taxonomies de catégories/marques, les unités et
le vocabulaire de critères sont volontairement courts. Les négations simples
(`sans`, `pas`, `non`, `ni`, y compris `pas d'…` et `pas d’…`) sont contrôlées
dans leur contexte proche, prix et budgets compris ; les formulations complexes
peuvent rester inconnues. Un délai n'est normalisé que s'il contient une date
calendrier complète avec année ; les formulations relatives restent inconnues
plutôt que d'inventer une date.

Un nombre est lu avec ses frontières, son éventuel signe et son séparateur
décimal complet avant toute conversion. Les capacités acceptent les décimaux
avec virgule ou point (`1,5 To` et `1.5 To` donnent `1536 GB`). Un signe négatif,
un nombre mal formé ou un groupement de capacité non pris en charge laisse la
valeur inconnue et produit une ambiguïté explicite ; aucun suffixe numérique
(`5` dans `1,5`, par exemple) n'est réinterprété seul. Les prix et budgets
restent des entiers : un montant décimal, négatif ou mal formé est également
inconnu et signalé comme ambigu.

Les quantités préfixées (`quantité 2`, `lot de 2`) et suffixées (`2 unités`)
emploient le même nombre complet et ses positions dans le texte original.
Seuls les entiers de `1` à `2147483647` sont acceptés. Fraction, signe négatif,
format mal formé ou dépassement laisse `quantity` à `null` avec une ambiguïté
explicite. Le lexème entier associé au marqueur ou à l'unité est capturé avant
validation : une sous-partie valide de `2..5` ou `-- 5` n'est jamais retenue.
La ponctuation ordinaire placée après une quantité valide reste admise. Une
citation IA qui masque un signe, un séparateur ou une partie décimale est
refusée même si elle constitue isolément une quantité valide.

## IA injectable

Le mode par défaut est `deterministic`, même si une implémentation IA est
passée. Le mode `ai` doit recevoir explicitement un `CatalogAiExtractor`; aucun
fournisseur par défaut ni appel réseau n'existe.

La sortie injectée est limitée à 32 Kio, utilise une liste fermée de champs et
des tailles bornées. Chaque valeur non nulle exige une preuve présente dans le
texte. Pour une mesure, caractéristique, nombre complet, unité source,
conversion canonique et contexte doivent correspondre à la même occurrence :
`28` n'est pas prouvé par `128`. Le contexte original, et pas seulement une
citation éventuellement tronquée, contrôle les négations. L'IA ne peut pas
trancher un champ déjà marqué ambigu par le déterministe. Ce contrôle contextuel
s'applique aussi aux preuves de prix et de budget. Les valeurs niées,
non prouvées, contradictoires, ainsi que les champs techniques (`ownerId`,
`status`, métadonnées, etc.) font échouer la proposition avec
`CatalogExtractionValidationError`.

## Vérification hors ligne

```shell
npm run test:catalog-extraction
```
