# Catalogue HTTP propriétaire

Cette couche expose uniquement le catalogue du compte authentifié. Elle utilise
la session PostgreSQL portée par le cookie `noma_auth`; aucun identifiant de
propriétaire ni rôle fourni par le client n'est accepté.

## Configuration

- `DATABASE_URL` : connexion PostgreSQL serveur, ouverte à l'usage.
- `NOMA_AUTH_ORIGIN` : origine HTTP(S) exacte autorisée pour `POST` et `PATCH`.

Toutes les réponses portent `Cache-Control: no-store`. Une session absente,
expirée, révoquée ou liée à un compte non actif produit `401`. Une panne interne
produit une erreur publique générique `503`, sans détail SQL.

## Routes

| Méthode | Route | Corps ou paramètres | Succès |
| --- | --- | --- | --- |
| `GET` | `/api/offers` | `limit` (1–100, défaut 20), `offset` (défaut 0) | `200` |
| `POST` | `/api/offers` | création d'offre | `201` |
| `GET` | `/api/offers/[id]` | — | `200` |
| `PATCH` | `/api/offers/[id]` | champs modifiés + `expectedContentVersion` | `200` |
| `POST` | `/api/offers/[id]/publish` | `{ "expectedContentVersion": n }` | `200` |
| `POST` | `/api/offers/[id]/pause` | `{ "expectedContentVersion": n }` | `200` |
| `POST` | `/api/offers/[id]/archive` | `{ "expectedContentVersion": n }` | `200` |
| `GET` | `/api/demands` | `limit` (1–100, défaut 20), `offset` (défaut 0) | `200` |
| `POST` | `/api/demands` | création de demande | `201` |
| `GET` | `/api/demands/[id]` | — | `200` |
| `PATCH` | `/api/demands/[id]` | champs modifiés + `expectedContentVersion` | `200` |
| `POST` | `/api/demands/[id]/activate` | `{ "expectedContentVersion": n }` | `200` |
| `POST` | `/api/demands/[id]/satisfy` | `{ "expectedContentVersion": n }` | `200` |
| `POST` | `/api/demands/[id]/archive` | `{ "expectedContentVersion": n }` | `200` |

Les listes sont paginées en SQL et ordonnées par `created_at`, puis `id`.

## Corps métier

Champs communs acceptés : `rawText`, `category`, `brand`, `model`, `variant`,
`attributes`, `condition`, `quantity`, `unit`, `location`, `deadlineAt`.
`rawText` est requis à la création. Les dates utilisent exclusivement une forme
UTC stricte telle que `2032-01-10T12:00:00Z` ou avec trois millisecondes.

- Offre : `price: { amount, currency }`, `availabilityStatus`.
- Demande : `budget: { amount, currency }`, `requirements`, `preferences`.

Les montants sont des entiers JavaScript sûrs et la devise est un code explicite
de trois lettres majuscules. Un champ nullable peut valoir `null`; dans un
`PATCH`, un champ absent reste inchangé. Toute création est forcée en `draft`.
`attributes` accepte uniquement un objet JSON ou `null`. `quantity` accepte
uniquement un entier compris entre 1 et 2 147 483 647, ou `null`.

Tout champ non documenté est refusé, notamment `ownerId`, `role`, `id`, `status`,
les dates techniques, les métadonnées d'extraction et
`availabilityConfirmedAt`. La taille JSON est limitée à 32 Kio réellement lus,
même sans `Content-Length`.

Une ressource absente ou appartenant à un autre compte produit le même `404`.
Une version obsolète (`content_version_conflict`), une ressource archivée
(`resource_archived`) ou une transition interdite (`status_transition_conflict`)
produit `409`. L'archivage est logique et irréversible dans cette API.

## Transitions de statut et cycle de vie

Les routes `/publish`, `/pause`, `/activate`, `/satisfy` et `/archive` attendent
uniquement `{ "expectedContentVersion": n }` avec `n` entier positif strict.

- **Offres** :
  - `publish` : autorisée depuis `draft` ou `paused` vers `published`.
  - `pause` : autorisée depuis `published` vers `paused`.
- **Demandes** :
  - `activate` : autorisée depuis `draft` ou `satisfied` vers `active`.
  - `satisfy` : autorisée depuis `active` vers `satisfied`.

Règles de transition :
1. **Idempotence / no-op** : si la ressource est déjà dans l'état cible et que
   `expectedContentVersion` correspond à sa version courante, la route renvoie
   `200` sans écriture SQL (pas d'incrément de version ni de mise à jour de `updatedAt`).
2. **Conflit optimiste** : si `expectedContentVersion` diffère de la version courante,
   un `409` (`content_version_conflict`) est systématiquement levé, y compris si la
   ressource a déjà le statut cible.
3. **Transition interdite** : toute transition hors machine d'état (ex: `draft` vers
   `paused`, ou toute mutation sur ressource archivée) est rejetée en `409`
   (`status_transition_conflict` ou `resource_archived`).
4. **Transition effective** : le statut est mis à jour, `content_version` est
   incrémenté de 1 et `updatedAt` est actualisé.
5. **Isolation et concurrence** : les mutations sont sérialisées avec verrouillage
   de ligne SQL (`FOR UPDATE`) dans une transaction PostgreSQL. Une ressource
   appartenant à un tiers ou inexistante renvoie un `404` indiscernable.

### Contrat d'injection et atomicité transactionnelle

Contrairement aux opérations unitaires ou en lecture seule acceptant un
`SqlExecutor` générique, les quatre services de transition (`publishOffer`,
`pauseOffer`, `activateDemand`, `satisfyDemand`) exigent explicitement une
instance `Pool` (`requireTransactionPool`) :

- L'opération s'exécute **toujours** via `withPostgresTransaction` sur un client
  réservé (`PoolClient`), garantissant le maintien du verrou `FOR UPDATE`
  entre le `SELECT` et le `UPDATE` au sein du bloc `BEGIN ... COMMIT`.
- Tout repli sur un `SqlExecutor` non transactionnel (autocommit) est
  strictement banni.
- Toute dépendance non supportée (ex. `SqlExecutor` sans `connect`, `PoolClient`
  déjà réservé, `null` ou type invalide) est rejetée immédiatement avec
  `CatalogValidationError` avant toute exécution de requête SQL.

## Test d'intégration

Utiliser exclusivement une base PostgreSQL de test dédiée :

```shell
TEST_DATABASE_URL='postgresql://.../noma_test' npm run test:catalog-http
```

Le harnais crée et supprime uniquement un schéma temporaire vérifié. Il refuse
une URL absente, une base non dédiée ou le paramètre URL `options`.
