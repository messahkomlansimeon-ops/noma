# Service Serveur d'Application Explicite des Propositions d'Extraction Catalogue

Ce document formalise le contrat, les règles de validation, la conversion de types
et la traçabilité durable lors de l'application explicite d'une proposition
d'extraction déterministe (`catalog_extraction_proposals`) sur son offre (`offers`)
ou sa demande (`demands`) dans PostgreSQL.

---

## 1. Principes Fondamentaux

1. **Origine exclusive des données** : Les valeurs appliquées aux champs du catalogue proviennent **uniquement** de la proposition stockée en base de données (`catalog_extraction_proposals`). Aucun champ ou valeur métier n'est accepté dans la charge utile appelante.
2. **Choix granulaire du propriétaire** : Le propriétaire spécifie explicitement quels champs de premier niveau ou quelles clés d'attributs il souhaite reporter. Aucun champ non sélectionné n'est modifié.
3. **Protection des valeurs humaines** :
   - `rawText` (texte initial saisi par l'humain) est strictement immuable via ce service.
   - Le propriétaire (`ownerId`), le statut du cycle de vie (`status`), et les métadonnées techniques (`id`, `createdAt`, `updatedAt`, `contentVersion`, `archivedAt`) sont strictement protégés contre toute modification.
   - Les valeurs humaines existantes non concernées par la sélection restent strictement inchangées.
4. **Verrou et fraîcheur sous transaction** : La ressource catalogue est verrouillée en écriture (`FOR UPDATE`). L'application est refusée si la ressource est archivée, si sa version ne correspond pas à la version attendue, ou si la proposition est devenue obsolète (`isStale`) par rapport au texte ou à la version sous verrou.
5. **Atomicité et traçabilité** : L'incrémentation de `contentVersion` et l'enregistrement du reçu d'application (`catalog_extraction_applications`) ont lieu dans la **même transaction PostgreSQL**. Si aucun champ ne change effectivement (comparaison structurelle insensible à l'ordre des clés d'objets), aucune incrémentation inutile n'a lieu et `updated_at` n'est pas modifié.
6. **Idempotence stricte et sérialisation concurrente** :
   - Chaque opération est sérialisée côté PostgreSQL par `(ownerId, idempotencyKey)` dès le début de la transaction (verrou exclusif transactionnel `pg_advisory_xact_lock`) avant toute décision sur l'existence d'un reçu.
   - Une même clé d'idempotence rejouée simultanément ou séquentiellement avec les mêmes paramètres retourne le reçu existant sans réécriture, sans violation 23505 ni faux conflit de version.
   - Une même clé rejouée avec des paramètres différents (y compris ciblant une ressource différente du même propriétaire) lève immédiatement un conflit d'idempotence typé (`CatalogExtractionApplicationConflictError`).
   - La clé d'idempotence (`idempotencyKey`) doit comporter entre 1 et 255 caractères et ne peut contenir le caractère NUL `U+0000` (rejet immédiat avec `CatalogExtractionApplicationValidationError` avant toute requête SQL). Les chaînes Unicode valides sont intégralement préservées.

---

## 2. Contrat d'Entrée et Types

```ts
export interface CatalogExtractionApplicationSelection {
  /** Champs de premier niveau à appliquer (ex: ["category", "brand", "model", "price"]) */
  fields?: string[];
  /** Clés spécifiques d'attributs à appliquer (ex: ["storage_capacity", "color"]) */
  attributeKeys?: string[];
}

export interface ApplyCatalogExtractionProposalInput {
  ownerId: string;
  resourceType: "offer" | "demand";
  resourceId: string;
  proposalId: string;
  expectedContentVersion: number;
  selection: CatalogExtractionApplicationSelection | string[];
  idempotencyKey: string;
}

export interface CatalogExtractionApplicationReceipt {
  id: string;
  idempotencyKey: string;
  ownerId: string;
  resourceType: "offer" | "demand";
  resourceId: string;
  proposalId: string;
  expectedContentVersion: number;
  versionBefore: number;
  versionAfter: number;
  selectedFields: CatalogExtractionApplicationSelection;
  changes: Record<string, unknown>;
  appliedAt: Date;
}
```

---

## 3. Règles de Conversion Proposition → Catalogue

### 3.1. Attributs (`attributes`)
- **Format source** dans `proposal.fields.attributes` : tableau de `ProposedAttribute` :
  ```json
  [
    {
      "key": "storage_capacity",
      "value": 128,
      "unit": "GB",
      "sourceUnit": "Go"
    }
  ]
  ```
- **Format cible** dans `offers.attributes` / `demands.attributes` : objet JSONB (`jsonb_typeof(attributes) = 'object'`).
- **Règles de conversion** :
  1. Chaque attribut sélectionné par sa clé `key` est converti en objet préservant toutes ses dimensions :
     `{ "value": attr.value, "unit": attr.unit, "sourceUnit": attr.sourceUnit }`.
  2. **Préservation des clés existantes** : Si le catalogue possède déjà `{ "couleur": "noir", "ram": 8 }` et que l'utilisateur applique la clé `storage_capacity`, l'objet résultant est :
     `{ "couleur": "noir", "ram": 8, "storage_capacity": { "value": 128, "unit": "GB", "sourceUnit": "Go" } }`.
  3. Les clés non sélectionnées ne sont jamais altérées ni supprimées.
  4. Si une clé d'attribut sélectionnée n'existe pas dans la proposition ou a une valeur indéterminée, l'opération est refusée.

### 3.2. Prix et Budget (`price` / `budget`)
- **Format source** dans `proposal.fields.price` (offres) ou `proposal.fields.budget` (demandes) :
  `ProposedMoney` : `{ amount: number, currency: string | null }`.
- **Format cible** : colonnes `price_amount` (BIGINT) et `price_currency` (TEXT 3 lettres) ou `budget_amount` et `budget_currency`.
- **Règle absolue** :
  - **Un montant sans devise ne doit jamais devenir implicitement XOF.**
  - Si `currency === null` dans la proposition, le champ monétaire est incomplet/inconnu : la sélection de ce champ est **refusée** avec une erreur explicite.
  - Seule une devise explicite de 3 lettres ISO majuscules (ex: `"XOF"`, `"EUR"`) est admise pour alimenter le catalogue.

### 3.3. Échéance (`deadlineAt`)
- **Format source** : `string | null` (horodatage ISO-8601).
- **Format cible** : colonne `deadline_at` (`TIMESTAMPTZ` / `Date`).
- **Règle** : Si sélectionné, la chaîne ISO doit être une date valide parsable. Si invalide ou `null`, refus.

### 3.4. Exigences et Préférences (`requirements` / `preferences`, demandes uniquement)
- **Format source** : tableau `ProposedCriterion[]` :
  `[ { "key": string, "operator": "includes" | "excludes" | "equals", "value": string } ]`.
- **Format cible** : colonnes JSONB `requirements` et `preferences` (`jsonb_typeof = 'array'`).
- **Règle** : Chaque critère est stocké comme objet `{ key, operator, value }`. Si la liste est nulle dans la proposition, elle ne peut être appliquée.

### 3.5. Champs Scalaires
- `category` : string (TEXT).
- `brand` : string (TEXT).
- `model` : string (TEXT).
- `variant` : string (TEXT).
- `condition` : string (`condition_text` TEXT).
- `quantity` : entier strictement positif (`quantity` INTEGER CHECK > 0).
- `location` : string (`location_text` TEXT).

---

## 4. Rejets et Contrôles de Validation

L'opération est refusée dans les cas suivants :

| Situation | Exception levée | Rationale |
|---|---|---|
| Ressource inexistante ou appartenant à un tiers | `CatalogNotFoundError` | Indistinguabilité pour éviter toute énumération. |
| Proposition non rattachée à la ressource | `CatalogExtractionProposalAttachmentError` | Incohérence entre ressource et proposition source. |
| Ressource archivée | `ArchivedCatalogResourceError` | Une ressource archivée est immuable. |
| `expectedContentVersion` différent de la version courante | `StaleContentVersionError` | Conflit optimiste de concurrence. |
| Proposition obsolète (`isStale` : texte ou version modifiés) | `StaleCatalogExtractionProposalError` | Interdiction d'appliquer des données d'un état antérieur. |
| Champ interdit sélectionné (`rawText`, `ownerId`, `status`, etc.) | `CatalogExtractionApplicationValidationError` | Protection de l'intégrité métier et humaine. |
| Champ inconnu ou inapplicable au type de ressource | `CatalogExtractionApplicationValidationError` | Rejet des champs inexistants (ex: `price` sur une demande). |
| Champ sélectionné avec valeur `null` dans la proposition | `CatalogExtractionApplicationValidationError` | On n'applique pas une absence d'information. |
| Champ sélectionné comportant une ambiguïté non résolue | `CatalogExtractionApplicationValidationError` | L'application ne doit pas trancher arbitrairement un doute. |
| Montant sélectionné avec `currency: null` | `CatalogExtractionApplicationValidationError` | Pas d'hypothèse de devise implicite (interdiction XOF par défaut). |
| Clé d'idempotence réutilisée avec des paramètres divergents | `CatalogExtractionApplicationConflictError` | Incohérence d'idempotence. |

---

## 5. Gestion des Versions et Incrémentation Optimiste

1. **Changement effectif** :
   - On compare les valeurs issues de la conversion avec les valeurs actuelles sous verrou dans la ressource catalogue par comparaison structurelle stricte (`isStructuralEqual`).
   - La comparaison d'objets (notamment `attributes`, `requirements`, `preferences`) est insensible à l'ordre des propriétés, y compris imbriquées. L'ordre des éléments dans les tableaux et la distinction stricte des types primitifs sont rigoureusement préservés.
   - Si au moins une valeur diffère réellement, les colonnes correspondantes sont mises à jour, `content_version` est incrémenté de 1, `updated_at = CURRENT_TIMESTAMP`.
   - `versionBefore = currentVersion`, `versionAfter = currentVersion + 1`.
2. **Aucun changement effectif (No-op utile)** :
   - Si tous les champs sélectionnés ont déjà exactement la même valeur dans le catalogue que celle proposée (par exemple des attributs ou critères déjà stockés en JSONB mais restitués dans un ordre de clés différent) :
   - `content_version` **n'est pas incrémenté** (pas d'incrémentation inutile).
   - `updated_at` **n'est pas modifié**.
   - `versionBefore = currentVersion`, `versionAfter = currentVersion`.
   - `changes = {}`.
   - Le reçu est persisté pour satisfaire l'idempotence.

---

## 6. Schéma de Migration (`0005_catalog_extraction_applications.sql`)

```sql
CREATE TABLE catalog_extraction_applications (
  id UUID PRIMARY KEY,
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('offer', 'demand')),
  offer_id UUID REFERENCES offers(id) ON DELETE RESTRICT,
  demand_id UUID REFERENCES demands(id) ON DELETE RESTRICT,
  proposal_id UUID NOT NULL REFERENCES catalog_extraction_proposals(id) ON DELETE RESTRICT,
  expected_content_version INTEGER NOT NULL CHECK (expected_content_version > 0),
  version_before INTEGER NOT NULL CHECK (version_before > 0),
  version_after INTEGER NOT NULL CHECK (version_after >= version_before),
  selected_fields JSONB NOT NULL CHECK (
    jsonb_typeof(selected_fields) = 'array' OR jsonb_typeof(selected_fields) = 'object'
  ),
  changes JSONB NOT NULL CHECK (jsonb_typeof(changes) = 'object'),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (num_nonnulls(offer_id, demand_id) = 1),
  CHECK (
    (resource_type = 'offer' AND offer_id IS NOT NULL) OR
    (resource_type = 'demand' AND demand_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX catalog_extraction_applications_owner_idempotency_idx
  ON catalog_extraction_applications (owner_id, idempotency_key);

CREATE INDEX catalog_extraction_applications_offer_idx
  ON catalog_extraction_applications (offer_id, applied_at DESC)
  WHERE offer_id IS NOT NULL;

CREATE INDEX catalog_extraction_applications_demand_idx
  ON catalog_extraction_applications (demand_id, applied_at DESC)
  WHERE demand_id IS NOT NULL;

CREATE INDEX catalog_extraction_applications_proposal_idx
  ON catalog_extraction_applications (proposal_id);
```
