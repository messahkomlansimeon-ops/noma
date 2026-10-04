# Contrat de Matching Interne Déterministe Hors Ligne (Lot 2A)

Version du contrat : `matching-offline/v1`  
Module d'implémentation : `lib/server/matching/offline.ts`  
Types TypeScript : `lib/server/matching/types.ts`  
Suite de tests : `tests/server/matching-offline.test.ts` (`npm run test:matching`)

---

## 1. Vision et Principes Directeurs

Le module `evaluateOfflineMatching` est une **fonction pure**, déterministe et isolée en mémoire.
Elle compare une offre structurée (`OfferRecord`) à une demande structurée (`DemandRecord`) déjà persistées dans le catalogue métier de Scoutr / noma, sans accès réseau ni base de données.

### Principes stricts
1. **Champs structurés uniquement** : Seuls les attributs et champs catalogue validés sont examinés. Le texte brut `rawText` et les propositions d'extraction non appliquées sont ignorés.
2. **Pas d'implicite ni d'invention sémantique** :
   - Les devises différentes ne sont jamais converties (ex: EUR vs XOF reste `unknown`).
   - Les unités non strictement comparables restent inconnues (`unknown`).
   - Les localisations non reliées géographiquement avec certitude restent inconnues (`unknown`).
3. **Absence d'effets de bord** : Les objets d'entrée sont traités en lecture seule stricte (immutables).
4. **Séparation orthogonale des dimensions** :
   - Éligibilité (cycle de vie, propriété et disponibilité) ;
   - Compatibilité (critères obligatoires et obligations) ;
   - Préférences (souhaits informatifs distincts des obligations) ;
   - Disponibilité (faits constatés sur le stock/disponibilité) ;
   - Prix de marché et Confiance (inconnus faute de données à ce stade).
5. **Aucun score numérique ou ranking** : Les pourcentages, pondérations et boosts de visibilité sont exclus de ce lot.

---

## 2. Contrat de Sortie (`MatchingEvaluationResult`)

```typescript
export interface MatchingEvaluationResult {
  contractVersion: "matching-offline/v1";
  evaluatedAt: Date;
  offer: {
    id: string;
    contentVersion: number;
    status: OfferStatus;
    ownerId: string;
  };
  demand: {
    id: string;
    contentVersion: number;
    status: DemandStatus;
    ownerId: string;
  };
  eligibility: {
    status: "eligible" | "ineligible";
    reasons: EligibilityReasonCode[];
  };
  compatibility: {
    status: "compatible" | "incompatible" | "unknown";
    criteria: Record<string, CriterionEvaluation>;
    summary: CompatibilitySummary;
  };
  preferences: PreferenceEvaluation[];
  availability: AvailabilityFacts;
  marketPrice: {
    status: "unknown";
    reason: "insufficient_data";
  };
  confidence: {
    status: "unknown";
    reason: "insufficient_data";
  };
}
```

---

## 3. Détail des Dimensions

### A. Éligibilité (`eligibility`)
L'éligibilité vérifie les pré-requis d'échange entre deux acteurs du catalogue :
- **Offre publiée** : `offer.status === "published"`. Tout autre statut (`draft`, `paused`, `archived`) déclenche le motif `offer_not_published`.
- **Demande active** : `demand.status === "active"`. Tout autre statut (`draft`, `satisfied`, `archived`) déclenche le motif `demand_not_active`.
- **Propriétaires distincts** : `offer.ownerId !== demand.ownerId`. L'auto-matching est rejeté avec le motif `same_owner`.
- **Disponibilité non exclue** : Une offre avec `availabilityStatus === "unavailable"` est rejetée avec le motif `offer_unavailable`.

### B. Compatibilité (`compatibility`)
Chaque critère requis par la demande est évalué individuellement :
- **Statut par critère** (`CriterionStatus`) :
  - `matched` : correspondance confirmée.
  - `mismatched` : contradiction avérée entre l'offre et l'exigence de la demande.
  - `unknown` : information manquante, devise différente, unité non comparable ou ambiguïté.
  - `not_applicable` : la demande n'a posé aucune exigence sur ce critère.

#### Règles de Décision Globale (`compatibility.status`) :
1. **Demande vide** : Si la demande ne comporte aucun critère exploitable (`totalExploitableCriteria === 0`), le statut est `unknown` (code `NO_EXPLOITABLE_CRITERIA`).
2. **Contradiction obligatoire** : Si au moins un critère obligatoire a le statut `mismatched`, le statut global est irrévocablement `incompatible`.
3. **Obligation inconnue** : S'il n'y a aucun refus mais qu'au moins une obligation est `unknown`, le statut global est `unknown` (la compatibilité confirmée ne peut être attestée).
4. **Succès** : Si et seulement si tous les critères obligatoires applicables sont `matched` ($\ge 1$), le statut global est `compatible`.

#### Critères Examinés :
| Critère | Champ Offre | Champ Demande | Règle / Justification |
| :--- | :--- | :--- | :--- |
| `category` | `category` | `category` | Égalité insensible à la casse et aux accents (`CATEGORY_MATCH` / `CATEGORY_MISMATCH`). |
| `brand` | `brand` | `brand` | Égalité insensible à la casse et aux accents (`BRAND_MATCH` / `BRAND_MISMATCH`). |
| `model` | `model` | `model` | Normalisation des espaces, casse et accents (`MODEL_MATCH` / `MODEL_MISMATCH`). |
| `variant` | `variant` | `variant` | Comparaison stricte normalisée. Pas de "bag of words" permissif : l'association labels-nombres est préservée (ex: "RAM 8 Go stockage 128 Go" $\ne$ "RAM 128 Go stockage 8 Go" $\rightarrow$ `VARIANT_MISMATCH`). |
| `price_vs_budget`| `price` | `budget` | Même devise ISO requise. Si devises différentes $\rightarrow$ `CURRENCY_INCOMPARABLE`. Si même devise : `offer.price.amount <= demand.budget.amount`. |
| `quantity` | `quantity`, `unit`| `quantity`, `unit`| Unités identiques requises (ou absentes des deux côtés). Si unités différentes $\rightarrow$ `QUANTITY_UNIT_INCOMPARABLE`. Offre $\ge$ demande. |
| `condition` | `condition` | `condition` | Échelle ordinale standardisée (`new` > `like_new` > `very_good` > `good` > `fair` > `poor`). Offre $\ge$ exigence $\rightarrow$ `CONDITION_SATISFIED`. Si hors échelle $\rightarrow$ égalité exacte ou `unknown`. |
| `location` | `location` | `location` | Relations spatiales documentées et découpage en segments stricts (virgules, barres obliques). Rejet absolu des inclusions par simple sous-chaîne (ex: "Man" dans "Mankono" $\rightarrow$ `LOCATION_UNKNOWN`). Communes d'Abidjan reconnues exhaustivement. Villes distinctes d'Abidjan $\rightarrow$ `LOCATION_MISMATCH`. Métropole citée sans commune requise $\rightarrow$ `LOCATION_IMPRECISE`. |
| `deadline` | `deadlineAt` | `deadlineAt` | `deadlineAt` ne distingue pas date d'expiration de l'offre et engagement de livraison. Comparer deux dates futures par `<=` ou `==` ne suffit jamais à confirmer le délai demandé. Une offre sans date $\rightarrow$ `OFFER_DEADLINE_MISSING` (`unknown`). Deux dates futures $\rightarrow$ `DEADLINE_SEMANTICS_INSUFFICIENT` (`unknown`). Date passée $\rightarrow$ `OFFER_EXPIRED` ou `DEMAND_EXPIRED` (`mismatched`). Horloge fixe obligatoire dans les tests. |
| `attributes.<key>` / `requirements.<idx>`| `attributes[key]`| `attributes[key]` / `requirements[idx]`| Évaluation par la matrice explicite : opérateur × type demandé × type observé × unité. Toute combinaison non supportée produit `unknown`. |

#### Matrice Explicite des Comparaisons Supportées :
1. **Types et Incompatibilité de Types** :
   - Les types différents restent strictement incomparables (`TYPE_INCOMPARABLE` $\rightarrow$ `unknown`).
   - Aucune conversion générique `Number(expectedValue)` : un booléen n'est pas un nombre, une chaîne n'est pas un nombre.
   - Les valeurs demandées vides ou composées d'espaces ne sont pas exploitables (`CRITERION_INVALID_VALUE` $\rightarrow$ `unknown`).
   - Traitement des chaînes vides ou uniquement composées d'espaces comme inconnues (`unknown`) dans les attributs directs ET les critères explicites, côté offre comme côté demande, y compris sous forme enveloppée `{ value, unit }`. Elles ne prouvent ni correspondance ni contradiction.
2. **Propriétés Autorisées des Critères et Enveloppes** :
   - Propriétés autorisées d'un critère : strictement `key`, `operator`, `value`. Toute propriété supplémentaire non supportée (ex: `unit`, `minimumDurationMonths`, `tolerance`) rend le critère `unknown` (`CRITERION_UNIT_NOT_SUPPORTED` ou `CRITERION_UNSUPPORTED_PROPERTY`), pour les exigences comme pour les préférences.
   - Les unités d'attribut mal formées sur l'offre (ex: objet au lieu de chaîne) ne sont jamais effacées silencieusement et produisent `unknown` (`OFFER_ATTRIBUTE_UNIT_MALFORMED`).
   - Un attribut d'offre portant une unité dimensionnelle face à un critère sans unité produit `UNIT_INCOMPARABLE` (`unknown`).
3. **Cas Booléens et Correspondances Canoniques** :
   - Le support de la comparaison est déterminé **avant** d'examiner la valeur booléenne observée (`true` ou `false`).
   - Un couple clé/opérateur/type non supporté reste irrévocablement `unknown` pour `true` comme pour `false` (ex: booléen face à un nombre ou un texte arbitraire non canonique).
   - Les correspondances canoniques de l'extracteur (`chargeur`, `garantie`, `troc`) préservent la contradiction réelle (« chargeur demandé, chargeur absent » $\rightarrow$ `charger_included: false` contredit l'exigence).
   - Suppression absolue de la preuve sémantique par simple `String.includes` : « sans garantie » ne confirme pas « garantie ». Pour tout texte libre non interprétable avec `includes` ou `excludes`, le moteur retourne `unknown` (`TEXT_FREE_UNINTERPRETABLE`).
4. **Égalités Numériques et Booléennes** :
   - Numérique : `equals` et `includes` comparent à $10^{-9}$ près ; `excludes` vérifie la non-égalité.
   - Booléen : `equals` et `includes` vérifient la même valeur ; `excludes` vérifie la valeur opposée.

### C. Préférences (`preferences`)
Les préférences exprimées dans `demand.preferences` sont évaluées avec exactement la même matrice `evaluateExplicitCriterion` :
- Validation rigoureuse des propriétés autorisées (`key`, `operator`, `value`), rejet de toute contrainte additionnelle non supportée.
- Même rejet des conversions implicites, des valeurs vides et du texte libre non interprétable.
- Elles ne participent **jamais** au calcul du statut de compatibilité globale (`compatibility.status`).
- Une préférence insatisfaite n'invalide pas un couple compatible.
- Une préférence satisfaite ne compense **jamais** une contradiction obligatoire (ex: budget dépassé reste `incompatible`).

### D. Disponibilité (`availability`)
Faits observés et détachés de la compatibilité :
- `status`: statut déclaré de l'offre (`available`, `reserved`, `unavailable`, `unknown`).
- `confirmedAt`: date d'attestation de la disponibilité par le vendeur.
- `quantity`: quantité en stock offerte.
- `unit`: unité de comptage de l'offre.
- `isAvailable`: booléen synthétique (`offer.availabilityStatus === "available"`).

### E. Prix de Marché & Confiance
À ce stade, en l'absence de base d'historique de transactions complétées :
- `marketPrice`: `{ status: "unknown", reason: "insufficient_data" }`
- `confidence`: `{ status: "unknown", reason: "insufficient_data" }`

---

## 4. Limites Explicites du Lot 2A
1. **Pas de géométrie SIG/GPS** : Les coordonnées géographiques précises (lat/long) et distances kilométriques ne sont pas calculées.
2. **Pas de conversion de devises** : Tout rapprochement multi-devises (ex: XOF vs USD ou EUR) reste au statut `unknown`.
3. **Pas d'extraction textuelle** : Le comparateur suppose des données structurées et validées issues des lots 1A-1E. Aucun ré-examen de `rawText`.
4. **Pas de persistance de correspondances** : Aucune table de base de données de "matches" n'est introduite dans ce lot.

