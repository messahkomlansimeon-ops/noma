# MATCHING-HTTP.md — Exposition HTTP des Matchs Évalués

Ce document spécifie l'exposition HTTP des résultats d'évaluation de matching conjointe pour l'application **noma / Scoutr**.

---

## 1. Routes Exposées

Deux routes GET authentifiées sont exposées :

| Méthode | Route | Description |
| --- | --- | --- |
| `GET` | `/api/demands/[id]/matches` | Recherche et évaluation des offres candidates pour une demande source active |
| `GET` | `/api/offers/[id]/matches` | Recherche et évaluation des demandes candidates pour une offre source publiée |

---

## 2. Authentification et Contrôle d'Accès

1. **Session obligatoire** :
   - L'utilisateur doit présenter un cookie de session valide `noma_auth`.
   - Résolution via `resolveSession(token)`.
   - En l'absence de cookie, si la session est expirée, révoquée ou si le compte utilisateur n'est pas actif : retour immédiat `401 Unauthorized` (`authentication_required`).
2. **Propriétaire exclusivement issu de la session** :
   - L'identifiant du propriétaire de la ressource source est obligatoirement et exclusivement extrait de la session validée (`session.userId`).
   - Aucun identifiant de propriétaire (`ownerId`) ou rôle fourni par le client n'est accepté.
3. **Indiscernabilité des 404 (anti-énumération)** :
   - Si la ressource demandée (`[id]`) n'existe pas, ou si elle appartient à un autre utilisateur, la route renvoie rigoureusement la même réponse `404 Not Found` (`resource_not_found`, `"Ressource introuvable."`). Aucune information sur l'existence d'une ressource tierce n'est divulguée.
4. **Source inéligible (400)** :
   - Une ressource qui existe et appartient à l'utilisateur mais n'est pas évaluable (offre brouillon, en pause, archivée ou `unavailable` ; demande brouillon, satisfaite ou archivée ; propriétaire non actif) est rejetée en `400 Bad Request` (`invalid_request`), l'erreur de validation du catalogue étant projetée par `mapMatchingError`. Les routes `stored-matches` (section 6) renvoient les mêmes statuts et les mêmes codes.

---

## 3. Paramètres de Requête

Les paramètres sont strictement filtrés :
- **Paramètres autorisés** : uniquement `limit` et `cursor`.
- **Paramètres inconnus ou non autorisés** : tout paramètre superflu (ex: `now`, `scoringOptions`, `ownerId`, `foo`) entraîne un rejet immédiat avec `400 Bad Request` (`invalid_request`).
- **Paramètres répétés** : tout paramètre dupliqué (ex: `?limit=10&limit=20`) entraîne un rejet avec `400 Bad Request` (`invalid_request`).
- **Paramètre `limit`** :
  - Optionnel. Entier strict compris entre 1 et 100 (`MAX_CANDIDATE_LIMIT`).
  - Toute valeur non numérique, négative, nulle ou supérieure à 100 est rejetée en `400 Bad Request`.
- **Paramètre `cursor`** :
  - Optionnel. Curseur opaque généré par le Lot 2C1 (horodatage UTC en microsecondes et UUID encodés en base64url).
  - Tout curseur corrompu ou invalide est rejeté en `400 Bad Request`.
- **Identifiant de ressource `[id]`** :
  - Doit être un UUID canonique valide. Un format invalide est rejeté en `400 Bad Request`.

---

## 4. Confidentialité et DTO (Liste Blanche Stricte)

Afin de préserver la confidentialité des parties et d'empêcher toute fuite de données privées, les objets internes du Lot 2C2 ne sont jamais sérialisés directement. Un DTO par liste blanche stricte est retourné :

### Sont strictement EXCLUS de la réponse :
- Les identifiants de propriétaires tiers (`ownerId` des candidats).
- Les textes bruts (`rawText`, `raw_text`).
- Les métadonnées d'extraction (`extractorVersion`, `extractionMetadata`, `extractedAt`).
- Les preuves internes de comparaison (`offerValue`, `demandValue`, `targetValue`, `observedValue`).
- Les exigences et préférences brutes (`requirements`, `preferences`).
- Les dictionnaires de contributions internes non sanitizés.

### Sont exposés via le DTO :
- `contractVersion` : `"matching-http/v1"`.
- `evaluatedAt` : horodatage ISO 8601 UTC de l'évaluation conjointe de la page.
- `source` : fiche produit épurée de la ressource source (sans texte brut ni métadonnées).
- `items` : liste des candidats ordonnés :
  - `candidateId` : identifiant UUID du candidat.
  - `candidateContentVersion` : version de contenu du candidat.
  - `candidate` : fiche produit épurée (catégorie, marque, modèle, variante, état, quantité, unité, localisation, échéance, prix/budget, statut de disponibilité).
  - `compatibilityStatus` : statut de compatibilité 2A (`compatible`, `incompatible`, `unknown`).
  - `score` : score de compatibilité 2B (0 à 100, ou null).
  - `coverage` : couverture des critères 2B (0 à 100, ou null).
  - `evaluation` : synthèse chiffrée 2A (`status`, `summary: { matchedCount, mismatchedCount, unknownCount, totalExploitableCriteria }`).
  - `scoring` : synthèse chiffrée 2B (`score`, `coverage`, `summary`, `preferences`).
- `nextCursor` : curseur opaque pour la pagination suivante (ou `null`).
- `hasMore` : booléen indiquant la présence de candidats supplémentaires.
- `limit` : limite appliquée.

---

## 5. En-têtes HTTP et Absence d'Écriture Métier

1. **Politique de cache** :
   - Toutes les réponses portent systématiquement les en-têtes :
     ```http
     Cache-Control: no-store
     X-Content-Type-Options: nosniff
     ```
2. **Lecture pure** :
   - Le service s'exécute au sein d'une transaction stable `REPEATABLE READ READ ONLY`.
   - Aucune écriture n'est opérée en base de données : pas d'incrément de `content_version`, pas d'altération de `updated_at`, aucune table de match n'est créée.
3. **Erreurs publiques masquées** :
   - En cas d'erreur de base de données ou panne d'infrastructure, un statut `503 Service Unavailable` (`matching_unavailable`) est renvoyé sans fuite de message SQL ou de stack trace.

---

## 6. Correspondances enregistrées (`stored-matches`, lot 2F1)

Deux routes GET supplémentaires relisent les évaluations déjà enregistrées par le worker au lieu de les recalculer :

| Méthode | Route | Description |
| --- | --- | --- |
| `GET` | `/api/offers/[id]/stored-matches` | Demandes candidates enregistrées pour une offre source |
| `GET` | `/api/demands/[id]/stored-matches` | Offres candidates enregistrées pour une demande source |

Elles partagent avec les routes `/matches` l'authentification par cookie, la liste blanche `limit` / `cursor`, la
validation de l'identifiant, `mapMatchingError` (mêmes 401, 400, 404, 503) et les en-têtes `no-store`. Elles
diffèrent par : le DTO (`contractVersion: "matching-stored-http/v1"`, `evaluatedAt` par item, `processing`,
`readAt`), le curseur (opaque, lié à la source et au sens, distinct de celui des routes en direct : un curseur
d'une route n'est pas valide sur l'autre), le tri (score décroissant) et la limite par défaut (20, comme la
recherche). Les routes `/matches` en direct restent strictement inchangées. Contrat complet : `MATCHING-STORED-READ.md`.
