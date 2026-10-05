# MATCHING-TEMPORAL.md — Échéances temporelles du matching asynchrone (lot 2E4C2)

Quand l'`expires_at` d'une évaluation active est dépassé, l'évaluation n'est plus fiable (un délai obligatoire est
échu) : le balayeur la périme, émet un événement, et un job de paire réévalue la paire. Aucun appel LLM, réseau
ou SMS, aucune migration. **Le matching automatique n'est pas complet** : le bootstrap du catalogue existant
(2E4C3) manque encore.

Code : `lib/server/matching/temporal.ts` (`runTemporalExpirySweep`), job de paire dans `worker.ts`, route dans
`projection.ts`, liaison dans `chunks.ts`, étape dans `runner.ts`. Commande : `npm run test:matching-temporal`
(base `TEST_DATABASE_URL` dédiée).

## Balayeur — `runTemporalExpirySweep({ pool, limit = 100 (1..500), hooks? })` → `{ expired }`

Une transaction (`READ COMMITTED`, `lock_timeout` 3 s, `statement_timeout` 5 s) :

1. sélectionne les lignes `is_latest AND NOT is_stale AND expires_at IS NOT NULL AND expires_at <=
   clock_timestamp()` (`ORDER BY expires_at, id LIMIT n FOR UPDATE SKIP LOCKED`) ;
2. périme **ces lignes seulement** (`WHERE id = …`) : `is_stale = TRUE`, `is_latest = FALSE`, `stale_reason =
   'temporal_expiry'`, `staled_at = clock_timestamp()`. Une évaluation fraîche de la même paire (autre `id`) n'est
   jamais touchée ;
3. pour chaque ligne, `recordOutboxEvent` dans la même transaction.

Toute erreur annule le lot entier : jamais de ligne périmée sans son événement, ni d'événement sans ligne
périmée. `SKIP LOCKED` : deux balayeurs concurrents traitent des ensembles disjoints. Validation avant SQL (pool,
`limit`) : `MatchingTemporalError`. Hooks de test : `afterSelect`, `beforeRecord`.

## Événement

`recordOutboxEvent` avec `eventType 'temporal.deadline_passed'`, `aggregateType 'temporal'`, `aggregateId` = offre,
`aggregateVersion` = `content_version` de l'offre de la ligne périmée, `targetAggregateId` = demande, payload
`{ demandId, demandContentVersion, expiredEvaluationId }` ; `recordOutboxEvent` scelle la configuration de scoring
et pose `generation` = version. Projeté en un job `reevaluate_pair_temporal` (`MATCHING-PROJECTION.md`).

## Job de paire

Voir `MATCHING-WORKER.md` : pivot = offre ; lecture restreinte à la demande ciblée par l'option interne
`candidateId` (2C1/2C2), y compris à la reprise ; un seul chunk EOF avec 0 ou 1 candidat ; demande devenue
inéligible → `completed` sans évaluation ; offre modifiée → `superseded`.

## Liaison du manifeste

`MATCHING-CHUNKS.md` : pour ce type, chunk 0, `cursor_in` nul, EOF, au plus un candidat égal à la cible
(`target_mismatch` sinon). Vérifié en SQL et en TypeScript.

## Option interne `candidateId`

`findDemandCandidatesForOffer` et `findEvaluatedDemandMatchesForOffer` acceptent `candidateId` (UUID) : une seule
condition `AND d.id = $n` ajoutée à la même requête, donc exactement la même éligibilité et les mêmes filtres que la
recherche normale (la recherche 2C1 n'a **aucun** filtre de catégorie : une demande d'une autre catégorie reste
candidate, l'évaluation la dit `incompatible`). Validation avant SQL ; incompatible avec un `cursor` non nul.
Aucune route ni DTO ne l'expose (`parseQueryParams` refuse tout paramètre hors `limit`/`cursor`).

## Runner

Étape `temporal` cloisonnée, exécutée avant la projection (`temporalLimit`, 100 par défaut) ; résultat
`temporal: { expired }` ; échec → `temporal_error_<code>` dans `errors` ; `idle` exige `temporal.expired = 0`.

## Limites

- Le balayeur ne tourne que lorsqu'un cycle du runner est lancé ; aucun service ne le lance encore.
- L'événement porte `demandContentVersion` pour la traçabilité ; le job réévalue la **version courante** de la
  demande (une demande modifiée entre-temps a son propre événement, donc son propre job).
- Entre la péremption et l'exécution du job de paire, la paire n'a pas d'évaluation active (fenêtre courte,
  bornée par la cadence du runner) ; elle n'apparaît dans aucune lecture « active ».
- Un échec du balayeur est rapporté mais ne bloque rien : la ligne expirée reste active jusqu'au cycle suivant
  (la lecture filtre déjà `expires_at > now`, plan §6).
- Exclus : bootstrap (2E4C3), `scoring_config_sweep`, lecture HTTP des correspondances enregistrées,
  notifications, UI.
