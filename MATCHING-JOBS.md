# MATCHING-JOBS.md — Baux et cycle de vie des jobs (lot 2E3B)

Ce lot fournit les écritures SQL clôturées d'un worker sur `matching_jobs` : réservation,
heartbeat, échec, `superseded` et maintenance. Aucun worker, planificateur, appel à 2C/2D
ni route HTTP n'existe encore : **le matching automatique ne tourne pas** (2E4).

Code : `lib/server/matching/jobs.ts`. Migration : `0010_matching_job_leases.sql`.
Commande : `npm run test:matching-jobs` (base `TEST_DATABASE_URL` dédiée).

## États

`pending` → `running` (réservation) → `completed` (2E4) | `superseded` | `failed`
(échec sous bail) | `dead_letter`. Un job `failed` redevient réservable à `scheduled_at`
tant que `attempts < max_attempts`. Un job `running` dont le bail a expiré redevient
réservable tant que `attempts < max_attempts`. `completed`, `superseded` et `dead_letter`
sont terminaux et seuls porteurs de `completed_at`. Hors `running`, aucun champ de bail
(`claim_token`, `locked_by`, `locked_at`, `lock_expires_at`) ne subsiste (contraintes 0010).

## Écritures

- `claimMatchingJobs` : CTE `FOR UPDATE SKIP LOCKED`, ordre `(scheduled_at, id)`, 1 à 50
  jobs. Chaque réservation, reprise comprise, génère un `claim_token` neuf, incrémente
  `attempts` et fixe `lock_expires_at = clock_timestamp() + leaseSeconds` (15 à 600, 90
  par défaut).
- `heartbeatMatchingJob` : prolonge le bail.
- `failMatchingJob` : `failed`, ou `dead_letter` avec `completed_at` si
  `attempts >= max_attempts`, sous bail valide.
- `supersedeMatchingJob` : clôture `superseded`. La détection de l'obsolescence appartient
  au worker de 2E4 ; seule l'écriture clôturée est fournie.
- `runMatchingJobMaintenance` : seul chemin vers `dead_letter` pour un job sans bail
  valide (running expiré ou failed, avec `attempts >= max_attempts`). Les running expirés
  réessayables ne sont pas touchés.

Heartbeat, échec et `superseded` partagent une seule constante de clôture : `id`, `claim_token`
courant, `status = 'running'`, `lock_expires_at >= clock_timestamp()`. Si aucune ligne n'est
modifiée, le résultat est `lease_lost` et rien n'a été écrit. Il n'existe aucune requête
d'échec sans jeton (variante §9.5 supprimée) ni de `superseded` sans bail valide (§9.6).
Toutes les horloges sont `clock_timestamp()` côté PostgreSQL.

## Délai avant nouvel essai

`LEAST(600, power(2, LEAST(attempts, 10)) * 2)` secondes : 4, 8, 16… plafonné à 600 s,
calculé avec `attempts` après la réservation.

## Validation

Avant tout SQL : `pool instanceof Pool`, `workerId` (`[A-Za-z0-9._:-]`, 1–128), `limit`
(1–50), `leaseSeconds` (15–600, seul `undefined` donne 90), UUID de `jobId` et `claimToken`,
`errorCode` (`[a-z0-9_.:-]`, 1–120). Jamais de message brut, de pile ni de payload dans
`last_error`. Échec : `MatchingJobValidationError`.

## Règle de purge

**AUCUNE purge d'événements outbox référencés par un job non terminal.** Le job ne stocke
que `scoring_config_hash` ; le worker 2E4 relira la configuration scellée dans l'événement
via `source_event_id` (clé étrangère `ON DELETE SET NULL`).

## Exclus et limites

Progression des lots de candidats, manifeste CAS, complétion (`completed`), boucle de
worker, planificateur, cron, route HTTP, UI et purge sont hors lot. `last_error` posé par la
maintenance est un texte fixe du plan, pas un code. La maintenance doit être appelée par un
processus périodique encore inexistant. Un worker dont le traitement dépasse son bail sans
heartbeat perd son bail ; les effets déjà écrits par ailleurs (2D) restent à rendre
idempotents par 2E4. La migration 0010 échouerait sur une base déjà peuplée de jobs
incohérents ; `noma_dev` n'a pas été migrée.
