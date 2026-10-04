# MATCHING-SERVICE.md — Lot 2C2 : Service Serveur d'Évaluation de Matchs (2A + 2B)

Ce document spécifie le service serveur d'évaluation conjointe de candidats du **Lot 2C2** pour l'application **noma / Scoutr**.
Il orchestre le chargement sécurisé d'une ressource source, la sélection paginée de ses candidats internes via le **Lot 2C1**, puis l'évaluation déterministe hors ligne de chaque paire par le moteur de comparaison du **Lot 2A** ([`evaluateOfflineMatching`](file:///home/aegonjs/Documents/workspeace/Fresh/noma/lib/server/matching/offline.ts)) et le moteur de scoring explicable du **Lot 2B** ([`computeMatchingScore`](file:///home/aegonjs/Documents/workspeace/Fresh/noma/lib/server/matching/scoring.ts)).

---

## 1. Principes et Frontières de Responsabilité

1. **Aucune persistance des matchs** :
   Le service est en lecture pure. Il calcule et retourne les évaluations à la volée en mémoire, sans écrire ni modifier de tables de matchs, de scores ou d'historique.
2. **Instantané PostgreSQL stable (`REPEATABLE READ READ ONLY`) et réservation de client** :
   Le chargement complet de la source et la sélection des candidats s'exécutent sur un **client dédié réservé** issu d'un pool validé (`requireTransactionPool`) au sein d'une transaction de lecture :
   ```sql
   BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
   ```
   - Les simples objets `SqlExecutor` (dépourvus de méthode `.connect`) et les clients pré-réservés (possédant une méthode `.release`) sont explicitement rejetés avec `CatalogValidationError`.
   - Aucune requête n'est dérivée vers le pool, garantissant l'absence de lecture mixte même en cas de modification concurrente de la source ou du catalogue.
   - Les instructions `COMMIT` ou `ROLLBACK` ainsi que la libération `client.release()` sont garanties sur le même client réservé dans un bloc `finally`.
3. **Réemploi sans réimplémentation** :
   - Les règles métier d'éligibilité, de compatibilité et de préférences sont celles du Lot 2A.
   - Les calculs de score et de couverture sont ceux du Lot 2B.
   - La sélection, le filtrage d'auto-matching, les statuts de cycle de vie et la pagination par curseur stable sont ceux du Lot 2C1.
4. **Préservation absolue des statuts 2A** :
   Chaque élément évalué conserve son statut de compatibilité 2A (`compatible`, `incompatible` ou `unknown`).
   > **Règle absolue** : Un score élevé ne transforme **jamais** un statut `unknown` ou `incompatible` en `compatible`.
5. **Conservation de l'ordre chronologique et du curseur** :
   L'ordre des candidats (`created_at DESC, id DESC`) et le curseur de pagination opaque (`nextCursor`) issus du Lot 2C1 sont conservés à l'identique.
   Le service ne réordonne pas les résultats par score et ne constitue aucun classement global du catalogue.
6. **Horloge unique injectée** :
   Une même instance temporelle (`now`) est partagée pour l'évaluation temporelle de toute la page (Lot 2A) et l'horodatage des scores (Lot 2B).
7. **Plafond strict et absence de boucle** :
   Le nombre de candidats par page est borné à 100 maximum (`MAX_CANDIDATE_LIMIT`). Aucune boucle automatique ne parcourt l'ensemble du catalogue.

---

## 2. Contrat de Service

Le service est implémenté dans [`lib/server/matching/service.ts`](file:///home/aegonjs/Documents/workspeace/Fresh/noma/lib/server/matching/service.ts) et typé dans [`lib/server/matching/service-types.ts`](file:///home/aegonjs/Documents/workspeace/Fresh/noma/lib/server/matching/service-types.ts).

```typescript
export const MATCHING_SERVICE_CONTRACT_VERSION = "matching-service/v1" as const;

export async function findEvaluatedOfferMatchesForDemand(
  ownerIdValue: string,
  demandIdValue: string,
  options?: EvaluatedMatchesQueryOptions,
  pool?: Pool,
): Promise<EvaluatedMatchPage<DemandRecord, OfferRecord>>;

export async function findEvaluatedDemandMatchesForOffer(
  ownerIdValue: string,
  offerIdValue: string,
  options?: EvaluatedMatchesQueryOptions,
  pool?: Pool,
): Promise<EvaluatedMatchPage<OfferRecord, DemandRecord>>;
```

### Options (`EvaluatedMatchesQueryOptions`)
- `limit?: number` : Limite de pagination (1 à 100, défaut: 20).
- `cursor?: string | null` : Curseur opaque de pagination (microsecondes UTC et UUID).
- `now?: Date` : Horloge injectée pour déterminisme temporel.
- `scoringOptions?: MatchingScoringOptions` : Poids ou précision personnalisés pour le scoring 2B.

### Structure de Réponse (`EvaluatedMatchPage`)
- `contractVersion` : `"matching-service/v1"`.
- `evaluatedAt` : Date unique de l'évaluation de la page.
- `source` :
  - `id` : UUID de la ressource source.
  - `contentVersion` : Version de contenu de la source.
  - `ownerId` : UUID du propriétaire de la source.
  - `record` : Enregistrement complet (`DemandRecord` ou `OfferRecord`).
- `items` : Liste ordonnée des candidats évalués (`EvaluatedMatchItem`) :
  - `candidateId` : UUID du candidat.
  - `candidateContentVersion` : Version de contenu du candidat.
  - `candidate` : Enregistrement complet du candidat.
  - `compatibilityStatus` : Statut 2A (`compatible`, `incompatible` ou `unknown`).
  - `evaluation` : Sortie complète du comparateur 2A (`MatchingEvaluationResult`).
  - `scoring` : Sortie complète du scoreur 2B (`MatchingScoringResult`).
- `nextCursor` : Curseur opaque pour la page suivante (ou `null`).
- `hasMore` : Booléen indiquant l'existence de candidats supplémentaires.
- `limit` : Limite appliquée.

---

## 3. Gestion des Erreurs et Sécurité

1. **Isolation propriétaire & ressources absentes** :
   Si la ressource source n'existe pas ou appartient à un tiers, le service lève immédiatement `CatalogNotFoundError("demande")` ou `CatalogNotFoundError("offre")`. Aucune existence de ressource privée tierce n'est divulguée.
2. **Ressource source non éligible** :
   - Propriétaire inactif ou archivé : `CatalogValidationError("Le propriétaire de la ... n'est pas actif.")`.
   - Ressource non active ou non publiée : `CatalogValidationError`.
   - Offre marquée `unavailable` : `CatalogValidationError`.
3. **Rejet strict des curseurs et limites invalides avant toute connexion** :
   Les paramètres de pagination (`limit`, `cursor`) ainsi que les identifiants UUID sont validés avant toute réservation de client depuis le pool ou émission de requête SQL (`validateCandidateLimit`, `decodeCandidateCursor`, `requireUuid`). Une valeur non valide lève `CatalogValidationError` avec exactement zéro acquisition de connexion et zéro requête SQL.
