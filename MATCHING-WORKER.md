# MATCHING-WORKER.md — Worker d'évaluation paginé (lot 2E4B)

Le worker relie les jobs (2E3B) et le manifeste de chunk (2E4A) aux moteurs 2C1 (candidats), 2A
(comparaison), 2B (score) et 2D (persistance). Aucun appel LLM, réseau ou SMS. **Le matching
automatique n'est pas pour autant opérationnel** : la boucle d'exécution (2E4C1, `MATCHING-RUNNER.md`) existe
mais aucun service ne la lance, et les types temporels et de configuration restent à faire (2E4C2).

Code : `lib/server/matching/worker.ts` (`runMatchingJob`, `runMatchingWorkerOnce`).
Commande : `npm run test:matching-worker` (base `TEST_DATABASE_URL` dédiée).

## Algorithme

1. **Type et configuration scellée.** Seuls `evaluate_offer_candidates` (pivot = offre, service 2C2
   `findEvaluatedDemandMatchesForOffer`) et `evaluate_demand_candidates` (pivot = demande,
   `findEvaluatedOfferMatchesForDemand`) sont traités. La configuration est lue dans le payload de
   l'événement source (`source_event_id`) ; `computeScoringConfigHash(normalizeScoringConfig(config))`
   doit égaler `job.scoring_config_hash` et les versions de moteur du payload doivent égaler les
   constantes de contrat actuelles. Sinon : échec `sealed_config_unavailable` (payload absent, supprimé,
   incohérent ou invalide) ou `engine_version_mismatch`. Jamais de repli sur les défauts courants.
2. **État** (`readChunkState`). Manifeste `validated` avec `is_eof` → `completeChunkedJob` sans aucune page
   (§6.E.4). Manifeste `initialized` ou `processing` → reprise du chunk. Sinon → ouverture du chunk 0 ou N+1
   (`cursor_in = cursor_position`, prédécesseur exact).
3. **Ouverture.** Heartbeat, contrôle du pivot, puis `T_eval = clock_timestamp()` PostgreSQL (ms). Le même
   `T_eval` sert à toute la page : `now` de 2C2, `evaluated_at` du manifeste et `attempt_hash`. Les
   candidats gardent l'ordre de la page ; `cursor_out = page.nextCursor`. `attempt_id` et `idempotency_key`
   sont des UUID v4 dérivés de `sha256(job, chunk, candidat, ordinal)` ; `chunk_id` est aléatoire (durable dès
   l'initialisation). `attempt_hash = computeAttemptHash` avec les entrées exactes que 2D recalculera.
4. **Candidats** (dans l'ordre du manifeste, tentative courante `pending`). Page fraîche : évaluation 2C2.
   Reprise : les enregistrements de la plage `[cursor_in, cursor_out]` sont relus par pages de 100 ; un candidat
   absent ou de `candidate_version` différente est acquitté `skipped_stale`, un candidat hors manifeste est
   ignoré. L'évaluation est recalculée avec `now` = `evaluated_at` de la tentative courante. L'empreinte
   attendue est comparée à celle du manifeste avant toute écriture 2D (`attempt_hash_mismatch`).
5. **Validation.** Plus aucun candidat `pending` → `validateChunk` ; EOF → `completeChunkedJob`, sinon chunk suivant.

## Classification des retours 2D (plan §6.D)

| Retour | Suite |
|---|---|
| succès / `isReplayed` | acquittement `persisted` / `replayed` |
| `StalePreconditionsError` | relecture du pivot : changé → `superseded` ; sinon `skipped_stale` |
| `StaleAttemptSupersededError` | `already_superseded` |
| `EvaluationExpiredDuringLockWaitError` | nouvelle tentative (T_eval frais, ordinal + 1, append puis record), recalcul et persistance ; au plus 3 tentatives par candidat et par exécution, sinon `attempt_limit` |
| `MatchingIdempotencyConflictError` / `MatchingInputConsistencyError` | échec `idempotency_conflict` / `input_consistency`, sans acquitter |
| PostgreSQL 55P03, 40P01, 40001, 57014 | échec `transient_<code en minuscules>`, sans acquitter (délai de 2E3B) |
| autre exception | échec `worker_exception` (code stable, jamais de message brut) |

## Pivot, bail, reprise

Le pivot est relu avec le statut de son propriétaire avant chaque page, après toute erreur de chargement 2C2
et après `StalePreconditionsError`, selon exactement les règles de `loadSourceOffer`/`loadSourceDemand` :
version supérieure, pivot absent ou inéligible → `supersedeMatchingJob` ; version inférieure →
`pivot_version_regression`. Un heartbeat précède chaque page et chaque persistance. Tout `lease_lost`,
`stale_chunk` ou « abandon » (hook de test) arrête immédiatement le traitement, sans écriture. La seule
écriture possible après une perte de bail est celle de 2D déjà en vol (plan §6.F), rejouée sans doublon
(`replayed`) par le repreneur. Le manifeste fait autorité : le curseur n'avance que par `validateChunk`, aucune
sentinelle EOF, aucun recomptage. Les évaluations sont persistées, jamais classées ni « confirmées ».

## `runMatchingWorkerOnce`

Réserve `limit` jobs (1 à 10) avec `jobTypes` = `MATCHING_EVALUATION_JOB_TYPES` (les deux types d'évaluation et
`reevaluate_pair_temporal` ; un `user_reactivation_sweep` n'est jamais réservé), les exécute séquentiellement, retourne les résumés. Aucune boucle ni planificateur.

## Notification de première correspondance (lot N1)

`persistEvaluatedMatch` accepte le crochet `inTransaction` (réservé à l'usage interne), exécuté **dans** la transaction de l'évaluation, après l'INSERT et avant le COMMIT ; une erreur levée annule
l'évaluation. Le worker le branche sur `recordNewMatchNotification` (`lib/server/notifications/creation.ts`) : la notification d'un couple qui devient pour la première fois une correspondance confirmée et
fraîche d'un besoin actif, suivi et non en pause, est écrite avec l'évaluation, ou annulée avec elle ; le worker lui passe le **type du job** : un job côté besoin (`evaluate_demand_candidates`, ou issu de
`demand.created` / `activated` / `updated`) ne notifie jamais, et un job côté annonce ne notifie que si l'annonce est postérieure à l'activation du besoin (lot N1-bis). Un rejeu (`isReplayed`) n'appelle pas le crochet. Le crochet de test `insideTransaction`
(`"before_notification"`, `"after_notification"`) permet de lever ou d'abandonner à l'intérieur de la transaction. Les règles exactes sont dans `NOTIFICATIONS.md` ; sans la migration 0019 le crochet ne fait rien.

## Job de paire `reevaluate_pair_temporal` (lot 2E4C2)

Le pivot est l'offre (`kind` « offer »). Le job réévalue UNE paire dont l'évaluation vient d'être périmée par le
balayeur temporel (`MATCHING-TEMPORAL.md`). Le chargement de page utilise l'option interne `candidateId =
target_resource_id`, `cursor` nul et `limit` 1 : un seul chunk EOF avec 0 ou 1 candidat. **Toute** lecture, y
compris la reprise après un crash (`loadResumeRecords`), passe par `candidateId` : la liste des demandes de l'offre
n'est jamais relue. Cible absente → échec `missing_target` (défensif, avant toute lecture). Si la demande n'est plus
candidate (archivée, satisfaite, propriétaire suspendu, etc.), le chunk n'a aucun candidat et le job est
`completed` sans évaluation : la recherche normale ne la sélectionnerait pas non plus. Le reste du protocole est
celui de 2E4B (pivot obsolète → `superseded`, `StalePreconditions` → `skipped_stale`, nouvelle tentative durable
sur expiration pendant l'attente de verrou, erreur transitoire → `failed`, reprise sur manifeste sans doublon).
La nouvelle évaluation est calculée à `T_eval` PostgreSQL : si l'échéance de la demande est dépassée, elle est
`incompatible` (`DEMAND_EXPIRED`) et n'a plus d'`expires_at`.

## Sweep de réactivation (lot 2E4C1)

Code : `lib/server/matching/sweeps.ts` (`runUserReactivationSweep`). Un job `user_reactivation_sweep`
(projeté depuis `user.reactivated` : `resource_id` = compte, `resource_version` = version du compte) n'évalue
rien : il crée un job d'évaluation par ressource éligible du compte, que le worker ci-dessus exécutera.

- **Configuration scellée** : `readSealedConfig` (exportée de `worker.ts`, contrôle unique partagé avec
  `runMatchingJob`) relit l'événement source : hash recalculé égal à `job.scoring_config_hash`, puis versions
  de moteur. En plus, `payload.generation` doit être égal à `job.resource_version` (`generation_mismatch`).
- **Compte** (relu avant chaque lot) : absent, version supérieure, suspendu ou archivé → `superseded`
  (une suspension ou une réactivation ultérieure a son propre événement) ; version inférieure →
  `pivot_version_regression`.
- **Ressources** : exactement l'éligibilité de `loadSourceOffer` / `loadSourceDemand` — offres `published`,
  non archivées, disponibilité ≠ `unavailable` (NULL accepté) ; demandes `active`, non archivées. Parcours en
  keyset `(created_at, id)` croissant par lots de `batchSize` (1 à 500, 100 par défaut), offres puis demandes
  (`created_at` est comparé en texte PostgreSQL pour garder la microseconde).
- **Enfants** : `evaluate_offer_candidates` / `evaluate_demand_candidates`, `resource_version` = `content_version`
  courante de la ressource, `scoring_config_hash` et `source_event_id` du sweep (le worker relira la
  configuration dans l'événement de réactivation), cible NULL, `job_identity = computeJobIdentity({ generation:
  celle du sweep, … })`. Insertion par `insertJob` (exportée de `projection.ts`) : `ON CONFLICT DO NOTHING`
  plus contrôle d'intégrité (`child_job_integrity_conflict` si un job existant diverge).
- **Un lot = une transaction** : `SELECT … FOR UPDATE` du sweep sous `LEASE_FENCE` (0 ligne → `lease_lost`),
  lecture du lot, insertion des enfants, extension du bail sous le même fence, COMMIT. Un bail perdu à
  n'importe quel point annule le lot entier. **Aucune progression n'est persistée** (`cursor_position` reste
  réservé aux curseurs 2C1) : une reprise refait tout le parcours, et les identités déterministes rendent ce
  rejeu sans effet (`childJobsAlreadyPresent`).
- **Clôture** : `UPDATE … status = 'completed' WHERE LEASE_FENCE AND job_type = 'user_reactivation_sweep'` ;
  0 ligne → `lease_lost`.
- **Erreurs** : exception inattendue → `worker_exception` ; erreur PostgreSQL transitoire → `transient_<code>`.
  Un type de job autre → `unsupported_job_type`. Hooks de test : `beforeBatch`, `afterBatch`, `beforeComplete`
  (« abandon » = plus aucune écriture).

Limites : une ressource modifiée entre la création de son enfant et son exécution rend l'enfant `superseded`
(détecté par le worker) ; l'événement de modification a son propre job. Un compte suspendu après la création de
certains enfants rend ces enfants `superseded` (propriétaire inactif). Le sweep ne dit rien du résultat des
évaluations : ce n'est ni un classement ni une confirmation.

## Exclus et limites

Exclus : `scoring_config_sweep`, émetteurs scoring/bootstrap, cron, HTTP, UI, notifications, boosts.
Limites : `created_evaluations_count` compte les candidats `persisted` du manifeste ; une évaluation écrite
avant un crash puis rejouée est comptée `replayed` (sous-comptage possible). Une évaluation 2D en vol peut
survivre à la perte du bail. Si deux jobs évaluent la même paire (sens offre et sens demande), le plus récent
archive l'autre (`superseded_by_reevaluation`) ou, s'il arrive avec un `T_eval` plus ancien, est
`already_superseded`. L'ancienne tentative d'un candidat relancé reste `pending` (append-only). Les réservations
multiples (`limit` > 1) démarrent tous leurs baux à la réservation : un job dont le bail expire avant son tour
est abandonné (`lease_lost`) puis repris plus tard ; la boucle d'exécution (2E4C1) réserve donc un seul job à la
fois.

## Reste à faire

Type `scoring_config_sweep`, émetteurs scoring / bootstrap (lot 2E4C3), planification et supervision. La boucle
d'exécution est décrite dans `MATCHING-RUNNER.md`, le balayeur temporel dans `MATCHING-TEMPORAL.md`.
