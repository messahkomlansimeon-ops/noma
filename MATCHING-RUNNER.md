# MATCHING-RUNNER.md — Boucle d'exécution du matching asynchrone (lot 2E4C1)

La boucle enchaîne la projection de l'outbox, la maintenance des jobs et l'exécution des jobs (worker
d'évaluation, sweep de réactivation). Aucun appel LLM, réseau ou SMS. **Le matching automatique n'est pas pour
autant opérationnel** : aucun service ne lance cette boucle et les types de job temporels restent à faire (2E4C2).

Code : `lib/server/matching/runner.ts` (`runMatchingCycle`, `runMatchingWorkerLoop`), `lib/server/matching/sweeps.ts`,
`scripts/matching-worker.ts`. Commandes : `npm run test:matching-sweeps`, `npm run test:matching-runner`
(base `TEST_DATABASE_URL` dédiée).

## Un cycle (`runMatchingCycle`)

1. `projectOutboxBatch` (`projectionLimit`, 50 par défaut, 1 à 100) : événements → jobs.
2. `runMatchingJobMaintenance` : jobs épuisés → `dead_letter`.
3. Jusqu'à `maxJobs` fois (5 par défaut, 1 à 50) : `claimMatchingJobs({ limit: 1, jobTypes })` avec
   `evaluate_offer_candidates`, `evaluate_demand_candidates` et `user_reactivation_sweep`, puis l'exécuteur du
   type (`runMatchingJob` ou `runUserReactivationSweep`). Arrêt dès qu'aucun job n'est réservé. **Un seul job à
   la fois** : une réservation en lot laisserait expirer les baux des jobs en attente.

`idle` = rien lu par la projection, rien en maintenance, aucun job exécuté. `reevaluate_pair_temporal` et
`scoring_config_sweep` ne sont jamais réservés : ils restent `pending` (2E4C2). L'option `signal` (non prévue
par le plan, nécessaire à l'arrêt propre) empêche toute nouvelle réservation une fois déclenchée.

Toutes les entrées sont validées avant la moindre requête (`MatchingJobValidationError`).

## La boucle (`runMatchingWorkerLoop`)

Enchaîne des cycles jusqu'au déclenchement de `signal`. Inactif, le délai double (`idleDelayMs` 1000 ms →
`maxIdleDelayMs` 30000 ms) et revient au minimum dès qu'un cycle a travaillé. Une erreur de cycle (base
indisponible…) est journalisée sous un code stable (`matching_worker cycle_error_<code pg ou unknown>`, jamais le
message, une requête, un texte ni un identifiant), suivie de la même attente ; la boucle ne meurt pas. Rend
`{ cycles, jobsRun }` (un cycle en erreur n'est pas compté). `sleep`, `log` et `onCycle` sont injectables
pour les tests.

**Arrêt propre** : quand le signal est déclenché, la boucle ne réserve plus rien et **termine le job en cours**
(elle ne l'abandonne pas) ; l'attente en cours est interrompue.

## Lancement local

```bash
DATABASE_URL=... npm run matching:worker -- --once   # un seul cycle puis sortie
DATABASE_URL=... npm run matching:worker             # boucle ; SIGTERM / SIGINT = arrêt propre
```

`DATABASE_URL` est obligatoire. L'identité du worker est `MATCHING_WORKER_ID` ou, par défaut, `<hôte>-<pid>`
(validée : 1 à 128 caractères `A-Z a-z 0-9 . _ : -`). Le script utilise le même chargeur tsx et la même condition
`react-server` que `db:migrate`, **n'applique aucune migration** (la base doit déjà être migrée) et n'est jamais
lancé par Next.js. Ne le lancez pas sur `noma_dev` sans l'avoir décidé.

## Au déploiement (non fourni dans ce lot)

Aucun fichier systemd n'est livré. Il faudra : une instance **séparée** du serveur Next.js, le **même
`EnvironmentFile`** (`DATABASE_URL`), `Restart=on-failure`, et un arrêt par SIGTERM (le job en cours se termine
avant la sortie ; prévoir un `TimeoutStopSec` supérieur à la durée d'un job). Plusieurs instances peuvent
tourner : réservations `SKIP LOCKED` et baux garantissent qu'un job n'est exécuté que par un worker à la fois.

## Exclus (2E4C2)

`reevaluate_pair_temporal`, `scoring_config_sweep`, émetteurs temporal / scoring / bootstrap, balayeur
temporel, planification, supervision, service systemd, HTTP, UI.

## Limites

Un `lease_lost` ou un échec d'un job est résumé dans `jobs` sans interrompre le cycle ; une erreur SQL lors de
l'enregistrement d'un échec interrompt le cycle (journalisée, puis reprise après attente) et le job reprend à
l'expiration de son bail. Une défaillance durable de la base se traduit par un journal et une attente
croissante, sans autre supervision. Le délai de reprise d'un job `failed` est celui de 2E3B (`scheduled_at`).
