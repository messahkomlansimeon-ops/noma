# MATCHING-SCORING.md — Lot 2B : Score Explicable Hors Ligne

Ce document spécifie le moteur de scoring déterministe et explicable du **Lot 2B** pour l'application **noma / Scoutr**.
Il consomme exclusivement la sortie structurée du comparateur déterministe hors ligne du **Lot 2A** ([`MatchingEvaluationResult`](file:///home/aegonjs/Documents/workspeace/Fresh/noma/lib/server/matching/types.ts)).

---

## 1. Contrat Versionné

Le contrat de scoring est formellement identifié par la constante :
```typescript
export const MATCHING_SCORING_CONTRACT_VERSION = "matching-scoring/v1" as const;
```

---

## 2. Formules Mathématiques Fondamentales

Le scoring évalue uniquement les critères obligatoires **applicables** issus de `evaluation.compatibility.criteria`.

### A. Définitions des ensembles
- Critères applicables : critères dont le statut n'est **pas** `not_applicable` et qui ne sont pas des doublons exacts.
- `Poids total applicable` ($W_{\text{total}}$) :
  $$W_{\text{total}} = \sum_{c \in \text{Applicables}} \text{weight}(c)$$
- `Poids validé (matched)` ($W_{\text{matched}}$) :
  $$W_{\text{matched}} = \sum_{c \in \text{Applicables}, \text{status}(c) = \text{matched}} \text{weight}(c)$$
- `Poids couvert (matched + mismatched)` ($W_{\text{covered}}$) :
  $$W_{\text{covered}} = \sum_{c \in \text{Applicables}, \text{status}(c) \in \{\text{matched}, \text{mismatched}\}} \text{weight}(c)$$

### B. Score de Compatibilité Confirmée (`score`)
Le score mesure la part pondérée des obligations formellement confirmées :
$$\text{Score} = \left(\frac{W_{\text{matched}}}{W_{\text{total}}}\right) \times 100$$

- Les statuts `unknown` et `mismatched` contribuent au dénominateur ($W_{\text{total}}$) avec un numérateur nul.
- Les critères `not_applicable` sont exclus du numérateur et du dénominateur.
- **Absence de critères applicables** : Si $W_{\text{total}} = 0$, `score` vaut `null`.

### C. Taux de Couverture (`coverage`)
La couverture mesure la part de l'information demandée qui a pu être formellement tranchée (positivement ou négativement), indépendamment du succès. Pour préserver la stabilité numérique et empêcher tout débordement vers `Infinity` en cas de sous-totaux proches de `Number.MAX_VALUE` :
$$\text{Couverture} = \min\left(100, \left(\frac{W_{\text{matched}}}{W_{\text{total}}}\right) \times 100 + \left(\frac{W_{\text{mismatched}}}{W_{\text{total}}}\right) \times 100\right)$$

- Un critère `unknown` (information manquante, devise différente, délai non prouvé, texte non interprétable) réduit la couverture.
- Un critère `mismatched` (contradiction explicite) augmente la couverture (le fait est tranché) mais n'apporte aucun point au score.
- **Absence de critères applicables** : Si $W_{\text{total}} = 0$, `coverage` vaut `null`.

---

## 3. Précision, Arrondi et Invariant Strict « Pas de 100 avec Inconnue ou Contradiction »

### A. Précision
Par défaut, le score et la couverture sont arrondis à **2 décimales** (`precision: 2`, configurable entre 0 et 6) :
$$\text{facteur} = 10^{\text{precision}}$$
$$\text{arrondi}(x) = \frac{\lfloor x \times \text{facteur} + 0.5 \rfloor}{\text{facteur}}$$

### B. Invariant Strict du 100
> **Règle absolue** : La note 100 ne doit **jamais** être affichée dès lors qu'au moins une obligation applicable est `unknown` ou `mismatched`.

Même si le calcul brut ou l'arrondi produit $100$ (par exemple avec un poids infinitésimal sur une inconnue, ou un arrondi à l'entier avec $99.9\%$) :
- Si `unknownCount > 0` ou `mismatchedCount > 0` :
  $$\text{Score} \le 100 - 10^{-\text{precision}}$$
  *(Exemple : maximum $99.99$ pour 2 décimales, $99$ pour 0 décimale).*
- De même, la couverture ne peut valoir $100$ s'il subsiste une inconnue (`unknownCount > 0`).
- Le score vaut $100$ **si et seulement si** tous les critères applicables ($W_{\text{total}} > 0$) sont confirmés (`matched`).

---

## 4. Poids Centralisés, Configurables et Rejet des Configurations Invalides

### A. Configuration Centralisée
Par défaut, chaque critère possède un poids nominal égal à **1** (`DEFAULT_CRITERION_WEIGHT = 1`).
La table `DEFAULT_CRITERIA_WEIGHTS` répertorie les poids nominaux des critères standards :
- `category`: 1
- `brand`: 1
- `model`: 1
- `variant`: 1
- `price_vs_budget`: 1
- `quantity`: 1
- `condition`: 1
- `location`: 1
- `deadline`: 1

### B. Résolution Propre des Poids (Own-Property)
Pour un critère donné, la recherche s'effectue strictement sur les propriétés propres de `weights` (sans héritage prototype comme `constructor`, `toString` ou `__proto__`) :
1. Clé propre `options.weights[name]` (nom exact, ex: `"price_vs_budget"`, `"attributes.storage_capacity"`).
2. Si attribut direct : clé propre `options.weights[attrKey]` (clé courte, ex: `"storage_capacity"`).
3. Si exigence explicite : clé propre `options.weights[reqKey]` (clé demandée, ex: `"chargeur"`).
4. `DEFAULT_CRITERIA_WEIGHTS[name]` si critère standard.
5. `options.defaultWeight` (défaut : 1).

### C. Validation Stricte et Robustesse Arithmétique
Toute configuration non conforme lève une exception typée `MatchingScoringValidationError` (`code: "INVALID_SCORING_CONFIG"`) :
- Poids $\le 0$, `NaN`, infini (`Infinity` / `-Infinity`), ou non numérique.
- `defaultWeight` $\le 0$ ou non fini.
- `precision` non entière ou hors intervalle $[0, 6]$.
- `weights` qui n'est pas un objet clé-valeur non nul.
- Dépassement arithmétique : si la somme des poids applicables déborde (`> Number.MAX_VALUE`), l'opération est explicitement rejetée avec `MatchingScoringValidationError`.
- Les ratios de scores partiels et totaux sont calculés sous la forme `(poids / total) * 100` pour garantir l'absence d'`Infinity` même avec un poids individuel proche de `1e308`.

---

## 5. Non-Récompense de la Duplication Exacte d'Exigences

> **Règle** : Dédupliquer uniquement les obligations réellement identiques au sens de 2A.

- Les attributs directs (`attributes.<key>`) et les exigences explicites (`requirements.<idx>`) relèvent de mécanismes distincts dans le comparateur 2A et ne sont **jamais** dédupliqués l'un par rapport à l'autre.
- Les clés d'attributs sont sensibles à la casse (`Color` vs `color`) et conservent leurs obligations propres.
- Les attributs avec unité et exigences sans unité constituent des obligations distinctes.
- Toute exigence comportant une propriété additionnelle (ex: `minimumDurationMonths`) reste distincte d'une exigence plus générale.
- Seule la répétition stricte à l'identique d'une même exigence dans `demand.requirements` est neutralisée (`isDuplicate: true`, `effectiveWeight: 0`).
- Le doublon n'augmente ni le numérateur ni le dénominateur ; le score reste strictement identique avec ou sans répétition d'une exigence.

---

## 6. Monotonie du Score

Remplacer un critère `matched` par un critère `unknown` (ou `mismatched`) **ne peut jamais augmenter le score** :
$$\Delta W_{\text{matched}} \le 0 \implies \Delta \text{Score} \le 0$$
La propriété est vérifiée unitairement dans les tests.

---

## 7. Séparation Stricte des Préférences

- Les préférences issues de `demand.preferences` sont évaluées et résumées dans un bloc dédié `preferences` (`preferenceScore`, `preferenceCoverage`, `contributions`).
- Elles **ne contribuent en aucun cas** au score de compatibilité obligatoire (`score`).
- Une préférence satisfaite n'apporte aucun bonus compensatoire.
- Une préférence insatisfaite ne pénalise pas le score obligatoire.

---

## 8. Invariants et Absence d'Effets de Bord

1. **Préservation des Statuts du Comparateur** :
   - `eligibilityStatus` et `compatibilityStatus` sont reproduits fidèlement.
   - `isEligible` vaut `true` si et seulement si `eligibility.status === "eligible"`.
   - `isCompatible` vaut `true` si et seulement si `compatibility.status === "compatible"`.
   - Un score élevé sur les autres critères ne rend **jamais** admissible un couple `incompatible` (rejet obligatoire) ou `ineligible` (offre brouillon, indisponible, etc.).
2. **Indépendance des Faits Externes** :
   - Prix de marché (`marketPrice`), disponibilité (`availability`) et indice de confiance (`confidence`) ne contribuent pas au score.
3. **Fonction Pure & Immuabilité** :
   - Aucune mutation des objets `MatchingEvaluationResult` ou `MatchingScoringOptions` (vérifié sous `deepFreeze`).
   - Aucun accès réseau, base de données, IA ou ré-extraction de texte.
