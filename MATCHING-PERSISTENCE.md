# Persistance Transactionnelle et Invalidation Synchrone du Matching (Lot 2D)

## 1. Vue d’Ensemble et Architecture

Le module de persistance du matching matérialise de manière transactionnelle et déterministe les résultats d'évaluation issus des moteurs :
- **2A** : comparaison déterministe de paires offre/demande (`evaluateOfflineMatching`) ;
- **2B** : scoring explicable et pondéré (`computeMatchingScore`) ;
- **2C1** : sélection de candidats avec pagination par curseur (`selectMatchingCandidates`) ;
- **2C2** : orchestration sous instantané cohérent `REPEATABLE READ READ ONLY` (`evaluateMatchingCandidates`) ;
- **2C3** : exposition HTTP privée avec DTO filtré (`/api/demands/[id]/matches`, `/api/offers/[id]/matches`).

Le lot 2D implémente fidèlement le protocole défini dans `MATCHING-PERSISTENCE-PLAN.md` (empreinte SHA-256 : `2e6a977087d3da0c91f7d736090b7dcf45725524bc4c5125ef59fc511053efa5`).

---

## 2. Invariants et Garanties ACID

1. **Composition transactionnelle stricte sans fallback silencieux** :
   - Toute mutation du catalogue (`updateOffer`, `transitionOfferStatus`, `updateDemand`, `transitionDemandStatus`, `updateUser`, `archiveUser`, `applyCatalogExtractionProposal`) est exécutée dans une transaction réelle via `executeInTransactionScope`.
   - Les objets `SqlExecutor` bruts (non transactionnels) sont immédiatement rejetés avec `CatalogValidationError`.
   - Si une connexion réservée est déjà dans un bloc de transaction (`__inNomaTransaction === true` ou statut PostgreSQL `_txStatus === 'T'`), l'opération s'exécute directement sans émettre de `BEGIN` imbriqué illégal, laissant le contrôle du commit ou du rollback à l'appelant.
   - En cas d'échec de la mutation ou de l'invalidation des évaluations, le `ROLLBACK` intégral est garanti sur tous les modes d'appel (`Pool`, `PoolClient`), préservant l'intégrité des états et versions.

2. **Validation stricte et cohérence déterministe avant connexion** :
   - Les identités, versions, propriétaires et horodatages entre `offer`, `demand`, `evaluation` et `scoring` sont rigoureusement recoupés en amont.
   - Toute substitution d'offre ou de demande lève `MatchingInputConsistencyError` (400) avec zéro connexion acquise sur le pool.
   - Les valeurs numériques non finies (`NaN`, `Infinity`, valeurs hors contrat `< 0` ou `> 100`) et structures mal formées sont rejetées avec `MatchingInputConsistencyError`.
   - Les configurations de scoring invalides (`defaultWeight <= 0`, `precision` hors de `[0, 6]`, poids non numériques) sont rejetées immédiatement avec `MatchingScoringValidationError`.
   - **Contrôle déterministe intégral** : `computeMatchingScore` est réexécuté avant connexion pour vérifier la stricte concordance du score, de la couverture, des synthèses, des contributions et des préférences. Toute divergence entraîne un rejet avec `MatchingInputConsistencyError`, y compris lors d'un rejeu.

3. **Canonicalisation stricte et isolation `__proto__`** :
   - Les configurations de scoring par défaut équivalentes (notamment poids absents et `weights: {}`) sont canonicalisées de manière identique et partagent la même empreinte SHA-256 (`scoringConfigHash`).
   - Conformément aux règles de sécurité du Lot 2B, les dictionnaires de poids utilisent `Object.create(null)` et `Object.defineProperty`.
   - Une clé propre nommée `__proto__` est préservée comme propriété propre sans polluer `Object.prototype` ni être omise silencieusement, et produit une empreinte SHA-256 distincte et stable.

4. **Protocole de verrouillage global déterministe** :
   - **Niveau 1** : Verrou transactionnel applicatif sur l'empreinte de la clé d'idempotence (`pg_advisory_xact_lock(hashtext('idempotency:' || idempotency_key))`).
   - **Niveau 2** : Verrous partagés (`FOR SHARE`) sur les comptes des deux propriétaires dans `users`, ordonnés par UUID croissant pour prévenir tout interblocage (deadlock).
   - **Niveau 3** : Verrous partagés (`FOR SHARE`) sur les ressources (`demands` puis `offers`), ordonnés par type (`'demand'` < `'offer'`) puis par UUID croissant, compatibles avec les lectures et sérialisés avec les mutations concurrentes.
   - **Niveau 4** : Verrou transactionnel applicatif sur la paire (`pg_advisory_xact_lock(hashtext('matching_pair:' || LEAST(offer_id, demand_id) || ':' || GREATEST(offer_id, demand_id)))`).
   - **Niveau 5** : Verrou sur l'évaluation courante active de la paire (`FOR UPDATE`).

5. **Prédicat de lecture active strict** :
   - La fonction `getActiveMatchingEvaluation` applique l'intégralité du prédicat :
     ```sql
     WHERE offer_id = $1 AND demand_id = $2
       AND is_latest = TRUE
       AND is_stale = FALSE
       AND scoring_config_hash = $5
       AND (expires_at IS NULL OR expires_at > clock_timestamp())
     ```
   - Si aucun hash de configuration n'est fourni, le hash canonique par défaut du Lot 2B est exigé (rejetant silencieusement toute évaluation calculée sous une configuration personnalisée).
   - L'horloge PostgreSQL `clock_timestamp()` est inviolable : aucun paramètre client ne peut prolonger ou ressusciter un résultat temporellement expiré.

6. **Péremption temporelle exacte** :
   - Frontière calculée selon l'algorithme $B = D + 1\text{ ms}$ (pour chaque deadline $D > T_{\text{eval}}$).
   - Si l'évaluation franchit son échéance pendant l'attente du verrou en base, l'écriture est rejetée avec `EvaluationExpiredDuringLockWaitError`.

7. **Idempotence et barrière d'historique** :
   - Même clé d'idempotence + entrées identiques $\to$ restitution du résultat existant (même si celui-ci a été invalidé entre-temps avec `is_stale = true`).
   - Même clé d'idempotence + entrées différentes $\to$ `MatchingIdempotencyConflictError` (409).
   - Tentative antérieure ($T_{\text{eval}} < T_{\text{latest}}$) se présentant après une évaluation plus récente $\to$ `StaleAttemptSupersededError` (409), même si l'évaluation plus récente a été ultérieurement invalidée.

---

## 3. Fichiers Modifiés et Implémentés

| Chemin de fichier | Rôle |
|---|---|
| `database/migrations/0006_matching_evaluations.sql` | Table `matching_evaluations`, contraintes CHECK, types `NUMERIC(9,6)`, colonne générée `is_confirmed_match` et index partiels uniques. |
| `lib/server/postgres/client.ts` | Marquage `__inNomaTransaction` sur `NomaTransactionalClient` pour composition sans imbrication. |
| `lib/server/catalog/shared.ts` | `executeInTransactionScope` avec gestion `PoolClient` (in-transaction vs begin/commit) et rejet `SqlExecutor`. |
| `lib/server/catalog/offers.ts` | Invalidation synchrone (`offer_updated`, `offer_archived`) lors des mutations et transitions d'offres. |
| `lib/server/catalog/demands.ts` | Invalidation synchrone (`demand_updated`, `demand_satisfied`, `demand_archived`) lors des mutations et transitions de demandes. |
| `lib/server/catalog/users.ts` | Invalidation synchrone (`user_suspended`, `user_archived`) lors de la suspension ou l'archivage de comptes. |
| `lib/server/catalog-extraction/application.ts` | Invalidation synchrone lors de l'application d'une proposition d'extraction de catalogue. |
| `lib/server/matching/persistence-types.ts` | Définition des DTOs, erreurs typées (`MatchingInputConsistencyError`, `MatchingIdempotencyConflictError`, etc.). |
| `lib/server/matching/persistence.ts` | Protocole `persistEvaluatedMatch`, vérification déterministe `computeMatchingScore`, `getActiveMatchingEvaluation`. |
| `lib/server/matching/index.ts` | Export des points d'entrée du lot de persistance. |
| `package.json` | Commande de test dédiée `npm run test:matching-persistence`. |
| `tests/postgres/matching-persistence.integration.test.ts` | 30 tests d'intégration réels sur PostgreSQL (nominal, rejeu, erreurs, concurrence, rollback, cohérence de scoring). |

---

## 4. Commandes de Validation

```bash
# Test dédié de persistance du matching (30 tests d'intégration réels sur PostgreSQL)
TEST_DATABASE_URL="postgres://noma_local:noma_local_only@127.0.0.1:55432/noma_test" npm run test:matching-persistence

# Reproducteurs d'audit
TEST_DATABASE_URL="postgres://noma_local:noma_local_only@127.0.0.1:55432/noma_test" NODE_ENV=test NODE_OPTIONS=--conditions=react-server node --import ./poc/node_modules/tsx/dist/loader.mjs /tmp/noma-audit-persistence-fix-scoring.cjs
TEST_DATABASE_URL="postgres://noma_local:noma_local_only@127.0.0.1:55432/noma_test" NODE_ENV=test NODE_OPTIONS=--conditions=react-server node --import ./poc/node_modules/tsx/dist/loader.mjs /tmp/noma-audit-persistence-implementation.cjs

# Validation TypeScript et ESLint strict
npx tsc --noEmit
npm run lint

# Ensemble des suites de tests du projet
npm test
npm run test:postgres
npm run test:matching
npm run test:matching-candidates
npm run test:matching-service
npm run test:matching-http
```
