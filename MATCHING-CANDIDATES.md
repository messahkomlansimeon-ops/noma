# MATCHING-CANDIDATES.md — Lot 2C1 : Sélection Serveur des Candidats Internes

Ce document spécifie le service de sélection serveur des candidats internes du **Lot 2C1** pour l'application **noma / Scoutr**.
Il permet de présélectionner efficacement, de manière paginée et bornée, les candidats éligibles pour évaluation ultérieure par le comparateur déterministe hors ligne du **Lot 2A** ([`evaluateOfflineMatching`](file:///home/aegonjs/Documents/workspeace/Fresh/noma/lib/server/matching/offline.ts)) et le moteur de scoring du **Lot 2B** ([`computeMatchingScore`](file:///home/aegonjs/Documents/workspeace/Fresh/noma/lib/server/matching/scoring.ts)).

---

## 1. Principes et Frontières de Responsabilité

1. **Lignes candidates, non matchs confirmés** :
   Le service 2C1 filtre uniquement l'éligibilité légale et structurelle (statuts, cycle de vie, disponibilité, isolation des propriétaires).
   Il **ne préjuge en aucun cas de la compatibilité métier** et ne promet aucun classement global par score à ce stade.
2. **Non-élimination prématurée vis-à-vis de 2A** :
   Aucun filtre SQL sur la catégorie, la marque, les attributs ou la localisation n'est appliqué en 2C1.
   Le comparateur 2A gère les subtilités d'accents, de casse, d'espaces, d'unités hétérogènes et de valeurs inconnues (`unknown`). Un filtre SQL tel que `LOWER(category) = LOWER($1)` exclurait indûment des candidats admissibles.
3. **Absence de fuite d'informations (Sécurité & Confidentialité)** :
   Une ressource source absente ou appartenant à un autre utilisateur retourne uniformément `CatalogNotFoundError` (pour empêcher l'énumération ou la détection de ressources privées tierces).
   Aucun accès public nouveau aux données d'autrui n'est ouvert : seules les ressources publiques/publiées d'utilisateurs actifs sont sélectionnées.

---

## 2. Contrat de Service

Le service est implémenté dans [`lib/server/matching/candidates.ts`](file:///home/aegonjs/Documents/workspeace/Fresh/noma/lib/server/matching/candidates.ts) :

```typescript
export async function findOfferCandidatesForDemand(
  ownerIdValue: string,
  demandIdValue: string,
  options?: CandidateQueryOptions,
  db?: SqlExecutor,
): Promise<CandidatePage<OfferRecord>>;

export async function findDemandCandidatesForOffer(
  ownerIdValue: string,
  offerIdValue: string,
  options?: CandidateQueryOptions,
  db?: SqlExecutor,
): Promise<CandidatePage<DemandRecord>>;
```

### Options de requête (`CandidateQueryOptions`)
- `limit?: number` : Nombre d'éléments demandés par page (entier entre 1 et 100, défaut: 20). Validé par `validateCandidateLimit`.
- `cursor?: string | null` : Curseur opaque (encodé en base64url) contenant le timestamp exact `createdAtIso` et l'identifiant unique `id` de départage.

---

## 3. Critères d'Éligibilité et Filtrage SQL

### Direction Demande active $\rightarrow$ Offres publiées (`findOfferCandidatesForDemand`)
- **Contrôle de la source (évaluation atomique dans le même instantané)** :
  - La demande doit exister et appartenir au propriétaire appelant (`owner_id = $ownerId`), sinon `CatalogNotFoundError`.
  - Le propriétaire de la demande doit être actif (`status = 'active'` et `archived_at IS NULL`), sinon `CatalogValidationError`.
  - La demande source doit être active (`status = 'active'` et `archived_at IS NULL`), sinon `CatalogValidationError`.
- **Filtres sur les offres candidates** :
  - `o.owner_id <> $ownerId` (exclusion stricte de l'auto-matching).
  - `o.status = 'published'` et `o.archived_at IS NULL`.
  - `o.availability_status IS DISTINCT FROM 'unavailable'` (conserve `available`, `reserved` et `null` conformément au moteur 2A).
  - `u.status = 'active'` et `u.archived_at IS NULL` (via `JOIN users u ON u.id = o.owner_id`).

### Direction Offre publiée $\rightarrow$ Demandes actives (`findDemandCandidatesForOffer`)
- **Contrôle de la source (évaluation atomique dans le même instantané)** :
  - L'offre doit exister et appartenir au propriétaire appelant (`owner_id = $ownerId`), sinon `CatalogNotFoundError`.
  - Le propriétaire de l'offre doit être actif (`status = 'active'` et `archived_at IS NULL`), sinon `CatalogValidationError`.
  - L'offre source doit être publiée (`status = 'published'` et `archived_at IS NULL`), sinon `CatalogValidationError`.
  - L'offre source ne doit pas être indisponible (`availability_status <> 'unavailable'`), sinon `CatalogValidationError`.
- **Filtres sur les demandes candidates** :
  - `d.owner_id <> $ownerId` (exclusion stricte de l'auto-matching).
  - `d.status = 'active'` et `d.archived_at IS NULL`.
  - `u.status = 'active'` et `u.archived_at IS NULL` (via `JOIN users u ON u.id = d.owner_id`).

### Architecture de Requête SQL Atomique (Instantané Cohérent)
Afin d'éviter tout instantané mixte (race condition entre la lecture source et la sélection des candidats) sans imposer de transaction externe non supportée par l'interface `SqlExecutor`, le contrôle de la source et la sélection des candidats sont regroupés au sein d'**une unique requête SQL à CTEs** :

```sql
WITH source_info AS (
  SELECT d.id, d.owner_id, d.status, d.archived_at,
         u.status AS user_status, u.archived_at AS user_archived_at
    FROM demands d
    LEFT JOIN users u ON u.id = d.owner_id
   WHERE d.id = $1::uuid
),
source_check AS (
  SELECT
    CASE
      WHEN s.owner_id <> $2::uuid THEN 'NOT_FOUND'
      WHEN s.user_status IS DISTINCT FROM 'active' OR s.user_archived_at IS NOT NULL THEN 'USER_INACTIVE'
      WHEN s.status <> 'active' OR s.archived_at IS NOT NULL THEN 'DEMAND_INACTIVE'
      ELSE 'OK'
    END AS check_status,
    s.status AS source_status
  FROM source_info s
),
candidates AS (
  SELECT ...
    FROM offers o
    JOIN users u ON u.id = o.owner_id
   WHERE (SELECT check_status FROM source_check) = 'OK'
     AND o.owner_id <> $2::uuid
     AND o.status = 'published'
     AND o.archived_at IS NULL
     AND o.availability_status IS DISTINCT FROM 'unavailable'
     AND u.status = 'active'
     AND u.archived_at IS NULL
     ${cursorCondition}
   ORDER BY o.created_at DESC, o.id DESC
   LIMIT $3
)
SELECT
  sc.check_status AS source_check_status,
  sc.source_status AS source_raw_status,
  c.*
FROM (
  SELECT
    COALESCE((SELECT check_status FROM source_check), 'NOT_FOUND') AS check_status,
    (SELECT source_status FROM source_check) AS source_status
) sc
LEFT JOIN candidates c ON sc.check_status = 'OK'
ORDER BY c.created_at DESC NULLS LAST, c.id DESC NULLS LAST;
```

**Propriétés garanties :**
1. **Instantané atomique unique** : Le contrôle de validité de la ressource source et la sélection des candidats s'exécutent sous le même snapshot de transaction PostgreSQL.
2. **Conservation des erreurs source avec 0 candidats** : Si la source est invalide, inactive ou absente, la ligne de contrôle est retournée même si aucun candidat n'existe (`LEFT JOIN`), déclenchant immédiatement l'erreur typée appropriée (`CatalogNotFoundError` ou `CatalogValidationError`).
3. **Insensibilité à la casse des UUIDs** : Normalisation en amont et transtypage `$param::uuid` dans PostgreSQL garantissant une comparaison insensible à la casse sans fuite de métadonnées.

---

## 4. Pagination par Curseur Stable, UTC et Validation Stricte

### Problématique des Timestamps et Fuseaux Horaires
PostgreSQL stocke les `timestamptz` avec une précision à la microseconde (6 décimales). De plus, formater via `to_char(ts, ...)` sans conversion explicite en UTC applique le `TimeZone` actif de la session (ex: `Pacific/Auckland` à +13h, `America/New_York` à -5h), provoquant des décalages d'heures brutes lors de la réinjection du curseur.

### Solution Retenue
1. La requête SQL force explicitement la projection en UTC tout en conservant les 6 décimales :
   ```sql
   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso
   ```
2. Le curseur sérialise `{ createdAtIso, id }` en base64url.
3. À la réinjection, `$cursorDate::timestamptz` analyse une chaîne ISO terminée par `Z`, interprétée de façon universelle et exacte en UTC quel que soit le fuseau horaire de session :
   ```sql
   WHERE ... AND (created_at, id) < ($cursorDate::timestamptz, $cursorId::uuid)
   ORDER BY created_at DESC, id DESC
   LIMIT $limit + 1
   ```
4. **Départage unique** : L'identifiant `id` (UUID unique) garantit un ordre total et sans ambiguïté.

### Validation Stricte du Curseur Pré-SQL (`decodeCandidateCursor`)
Avant toute interaction avec la base de données :
- Le curseur doit être de type `string` (sinon `CatalogValidationError`, jamais de `TypeError`).
- Le contenu doit respecter strictement le jeu de caractères base64url (`^[A-Za-z0-9_-]+$`) sans padding `=` ni caractères parasites.
- Le JSON décodé doit comporter exactement et uniquement les deux clés `createdAtIso` et `id`.
- `id` doit être un UUID valide.
- `createdAtIso` doit respecter l'expression rationnelle `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/`.
- La date fait l'objet d'une validation calendaire sans bascule automatique (rejet strict du 30 février ou d'heures/minutes invalides).

---

## 5. Justification des Index

Le schéma actuel (migration `0001_users_offers_demands.sql`) dispose déjà des index suivants :
- `offers_owner_status_idx (owner_id, status)`
- `demands_owner_status_idx (owner_id, status)`

Pour ce Lot 2C1, **aucun nouvel index n'est requis ni créé**, et aucune migration n'a été ajoutée ou modifiée.
Les requêtes reposent sur les index existants et les clés primaires sur `users (id)`.
