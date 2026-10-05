# MATCHING-RUNNER.md — Boucle d'exécution du matching asynchrone (lot 2E4C1)

La boucle enchaîne le balayage temporel, l'expiration des boosts échus, la projection de l'outbox, la maintenance des jobs et l'exécution des jobs (worker
d'évaluation, sweep de réactivation). Aucun appel LLM, réseau ou SMS. **Le matching automatique n'est pas pour
autant opérationnel** : aucun service ne lance cette boucle et les types de job temporels restent à faire (2E4C2).

Code : `lib/server/matching/runner.ts` (`runMatchingCycle`, `runMatchingWorkerLoop`), `lib/server/matching/sweeps.ts`,
`scripts/matching-worker.ts`. Commandes : `npm run test:matching-sweeps`, `npm run test:matching-runner`
(base `TEST_DATABASE_URL` dédiée).

## Un cycle (`runMatchingCycle`)

0. `runTemporalExpirySweep` (`temporalLimit`, 100 par défaut, 1 à 500) : évaluations dont l'échéance est dépassée
   → périmées + événements `temporal.deadline_passed` (exécuté AVANT la projection pour que l'événement soit
   projeté et son job exécuté dans le même cycle). Résultat `temporal: { expired }`.
0b. **Étape boost** (lot 2I4) : `expireOfferBoosts` (`boostLimit`, 200 par défaut, 1 à 1000) marque `expired` les boosts échus. Exécutée
   seulement si la migration `0011_offer_boosts` est enregistrée ; sinon ignorée **sans erreur** (`boost: { expired: 0, skipped: true }`).
   Résultat `boost: { expired, skipped }`. Voir `BOOST-METRICS.md`.
1. `projectOutboxBatch` (`projectionLimit`, 50 par défaut, 1 à 100) : événements → jobs.
2. `runMatchingJobMaintenance` : jobs épuisés → `dead_letter`.
3. Jusqu'à `maxJobs` fois (5 par défaut, 1 à 50) : `claimMatchingJobs({ limit: 1, jobTypes })` avec
   `evaluate_offer_candidates`, `evaluate_demand_candidates`, `reevaluate_pair_temporal` et
   `user_reactivation_sweep`, puis l'exécuteur du type (`runMatchingJob` ou `runUserReactivationSweep`). Arrêt dès qu'aucun job n'est réservé. **Un seul job à
   la fois** : une réservation en lot laisserait expirer les baux des jobs en attente.

`idle` = rien périmé (`temporal.expired` = 0), aucun boost expiré (`boost.expired` = 0), rien lu par la projection, rien en maintenance, aucun job exécuté
(erreurs ou non). `scoring_config_sweep` n'est jamais réservé : il reste `pending`. L'option `signal` (non prévue
par le plan, nécessaire à l'arrêt propre) empêche toute nouvelle réservation une fois déclenchée.

Toutes les entrées sont validées avant la moindre requête (`MatchingJobValidationError`).

## Cloisonnement des étapes

Balayage temporel, étape boost, projection, maintenance et exécution des jobs sont isolés : l'échec de l'une n'empêche pas les
suivantes (un événement empoisonné ne doit pas empêcher d'exécuter les jobs sains). Le résultat
porte `errors: string[]` : codes stables `temporal_error_<code>`, `boost_error_<code>`, `projection_error_<code>`, `maintenance_error_<code>`,
`job_error_<code>` (`<code>` : SQLSTATE ou code d'erreur en minuscules, `validation` ou `unknown` ;
jamais de message, de requête ni d'identifiant). Si l'exécution d'un job lève une exception
(base indisponible pendant l'enregistrement d'un échec…), `job_error_…` est enregistré, **aucun
autre job** n'est exécuté dans ce cycle (la base est probablement malade) et son bail expirera
normalement. `idle` reste « aucun progrès » (rien lu par la projection, rien en maintenance, aucun
job exécuté), erreurs ou non : une projection qui échoue à chaque cycle n'entraîne donc pas de
boucle sans attente. La validation des paramètres lève toujours avant tout SQL. La boucle
journalise chaque code de `errors` (`matching_worker projection_error_p0001`, …) ; une exception
qui s'échapperait quand même du cycle reste journalisée `cycle_error_<code>`.

Les conflits d'intégrité de job sont traités à la source (quarantaine par événement, voir
`MATCHING-PROJECTION.md`) : ils ne produisent plus d'erreur de projection.

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
DATABASE_URL=... npm run matching:worker -- --once   # un seul cycle puis sortie (code 1 si une étape a échoué)
DATABASE_URL=... npm run matching:worker             # boucle ; SIGTERM / SIGINT = arrêt propre
```

Mode `--once` : le résumé affiche les évaluations périmées (`temporal.expired`), les événements lus, les jobs
mis en `dead_letter` et les jobs exécutés ; une ligne supplémentaire n'apparaît que si des boosts ont expiré
(`Matching worker : N boost(s) échu(s) marqué(s) expiré(s).`). Chaque code de `errors` est affiché sur sa propre ligne
(`Matching worker : projection_error_p0001`, jamais de message brut) et le **code de sortie vaut 1** si `errors`
n'est pas vide (0 sinon). Le mode boucle n'est pas modifié.

`DATABASE_URL` est obligatoire. L'identité du worker est `MATCHING_WORKER_ID` ou, par défaut, `<hôte>-<pid>`
(validée : 1 à 128 caractères `A-Z a-z 0-9 . _ : -`). Le script utilise le même chargeur tsx et la même condition
`react-server` que `db:migrate`, **n'applique aucune migration** (la base doit déjà être migrée) et n'est jamais
lancé par Next.js. Ne le lancez pas sur `noma_dev` sans l'avoir décidé.

## Lancement conjoint avec l'application et état de santé (lot 2G1)

`npm run dev:full` lance `next dev` et ce worker ensemble (le worker seulement si `DATABASE_URL` est défini et le
schéma prêt) ; `npm run matching:status` lit l'état de santé en lecture seule (code 0 sain, 2 avertissements,
1 erreur). `npm run dev` reste inchangé. Détail et signification des avertissements : `MATCHING-OPERATIONS.md`.

## Au déploiement (non fourni dans ce lot)

Aucun fichier systemd n'est livré (ni pm2). Il faudra : une instance **séparée** du serveur Next.js, le **même
`EnvironmentFile`** (`DATABASE_URL`), `Restart=on-failure`, et un arrêt par SIGTERM (le job en cours se termine
avant la sortie ; prévoir un `TimeoutStopSec` supérieur à la durée d'un job). Plusieurs instances peuvent
tourner : réservations `SKIP LOCKED` et baux garantissent qu'un job n'est exécuté que par un worker à la fois.

## Exclus

`scoring_config_sweep`, émetteurs scoring / bootstrap (2E4C3), planification, supervision, service systemd,
HTTP, UI.

## Limites

Un `lease_lost` ou un échec d'un job est résumé dans `jobs` sans interrompre le cycle ; une erreur SQL lors de
l'enregistrement d'un échec interrompt le cycle (journalisée, puis reprise après attente) et le job reprend à
l'expiration de son bail. Une défaillance durable de la base se traduit par un journal et une attente
croissante, sans autre supervision. Le délai de reprise d'un job `failed` est celui de 2E3B (`scheduled_at`).
