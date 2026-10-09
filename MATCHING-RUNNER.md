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

3b. **Étape missions** (lot MV1, exécutée **après les jobs et AVANT notify** : une évaluation née dans le cycle est lue dans le cycle) : `runMissionsStep` passe les missions échues à « échue », relit la couverture quand de nouvelles annonces correspondent, écrit la notification de hausse (dans l'application, au plus une par jour et par mission) et libère les besoins porteurs des missions closes depuis 24 h. Isolée dans son propre `try` ; sans la migration `0027_missions`, `missions: { skipped: true }`, **sans erreur**. Voir `MISSIONS.md`. **Ordre complet des étapes** (une panne de l'une n'arrête jamais les suivantes) : temporal, boost, projection, maintenance, jobs, **missions**, **notify**, **subscriptions**, **paymentCatchup**, **market**, **collect**, **activeSearch**.

4. **Étape notify** (lot N1, exécutée **en dernier** : une notification née dans le cycle part dans le cycle) : `runNotificationStep` envoie les messages externes SIMULÉS des utilisateurs qui l'ont demandé
   (un message regroupé par utilisateur : fenêtre de collecte de 15 min, 4 h au moins entre deux messages, 3 messages par jour, heures calmes 22 h – 7 h, ce qui ne peut pas partir est reporté ; tout revérifié à l'envoi, lot figé avant l'envoi, 3 tentatives). Isolée comme l'étape boost : exécutée seulement si les tables de la migration 0019
   existent (sinon `notify: { skipped: true }`, **sans erreur**) et seulement s'il existe un transport (`NODE_ENV=development` **et** `NOMA_DEV_NOTIFY_CONSOLE=1`, sinon `notify: { noTransport: true }`, aucun envoi).
   Résultat `notify { skipped, noTransport, users, messages, delivered, skippedDeliveries, deferred, failed, retried, expired, busy, errors }`. Voir `NOTIFICATIONS.md`.

4b. **Étape paymentCatchup** (lot PAY1, exécutée **après** notify et abonnements, **AVANT** le relevé des prix (lot H1) et la collecte externe (lot EXT1) : l'argent d'abord, une source externe lente ne la retarde jamais) : `runSublymusCatchupStep` rattrape les recharges Sublymus restées en attente (webhook perdu) en interrogeant Sublymus ; **isolée dans son propre `try`** (une erreur de l'étape n'arrête aucune autre étape), **budget propre de 20 s par passage** (`CATCHUP_PASS_BUDGET_MS`, arrêt à la première erreur de délai, de réseau ou 5xx). Sans prestataire Sublymus actif (`NOMA_PAYMENT_PROVIDER` absent ou `fake`), avec une configuration refusée ou sans la migration `0026_sublymus_payments`, elle est ignorée **sans erreur** (`paymentCatchup: { skipped: true }`). Résultat `paymentCatchup { skipped, examined, completed, failed, waiting, notFound, anomalies, windowClosed, deferred, errors }`. Voir `PAIEMENT-WAVE.md`.

5. **Étape collect** (lot EXT1, exécutée **en dernier**, après notify et après les étapes d'abonnements (lot PRO1) et de relevé des prix (lot H1), pour que son budget de 10 s ne retarde jamais les autres) : `runCollectStep` synchronise les surveillances de marché (une par clé produit, mutualisée entre les besoins actifs), puis, s'il existe des connecteurs (FICTIFS seulement : `NOMA_EXTERNAL_FAKE=1`, jamais en production), collecte les surveillances dues (`FOR UPDATE SKIP LOCKED`, au plus 3 par cycle, 10 s de budget de temps : les surveillances non commencées au-delà sont rendues sans consommer de quota) dans le budget de chaque source, avec un disjoncteur par source. Isolée comme les autres étapes :
   migration `0025_external_collection` absente → ignorée **sans erreur** (`collect: { skipped: true }`) ; aucun connecteur → `collect: { noConnectors: true }`. **Une panne d'une source n'est pas une erreur du cycle** (comptée dans `collect.sourceFailures`) ; seule une erreur d'infrastructure
   donne `collect_error_<code>`. Voir `COLLECTE-EXTERNE.md`.

6. **Étape activeSearch** (lot RA1, exécutée **en tout dernier, APRÈS collect**, dans son **propre `try`**) : `runActiveSearchStep` entretient la recherche active payante (fins de période, arrêts d'un besoin archivé sans remboursement — un besoin satisfait suspend l'option sans l'arrêter —, retour du suivi à 90 jours, avis d'échéance 3 jours avant la fin) puis balaie les besoins qui ont une option en vigueur pour notifier les annonces d'autres sites **nouvelles** (collectées par l'étape précédente, donc dans le même cycle). **Budget** : 3 s de balayage et 25 besoins au plus par passage (`deferred` pour le reste), instructions d'entretien sans attente de verrou, un verrou de balayage tenté (jamais attendu) : l'étape n'allonge le cycle que de quelques secondes. Sans la migration `0028_active_search` : ignorée **sans erreur** (`activeSearch: { skipped: true }`). Résultat `activeSearch { skipped, ended, stopped, trackingClamped, notices, examined, notified, digested, baselines, deliveries, trackingHeld, deferred, busy, errors }`, erreurs `active_search_error_<code>` (`maintenance_<code>` ou `scan_<code>` pour une panne interne). Voir `RECHERCHE-ACTIVE.md`.

`idle` = rien périmé (`temporal.expired` = 0), aucun boost expiré (`boost.expired` = 0), rien lu par la projection, rien en maintenance, aucun job exécuté, aucune recharge Sublymus examinée (`paymentCatchup.examined` = 0), aucune surveillance collectée (`collect.watchesProcessed` = 0), aucune fin, aucun arrêt, aucun avis ni aucune notification de la recherche active (`activeSearch` : un simple examen n'est pas du travail), aucun envoi externe traité
(`notify.users` = utilisateurs laissés à un autre processus ou **en erreur** : une erreur de l'étape notify compte comme « au repos », les tentatives des lignes de l'utilisateur sont incrémentées avec une attente croissante, puis `failed` après 3 ; `notify.expired` = 0). `scoring_config_sweep` n'est jamais réservé : il reste `pending`. L'option `signal` (non prévue
par le plan, nécessaire à l'arrêt propre) empêche toute nouvelle réservation une fois déclenchée.

Toutes les entrées sont validées avant la moindre requête (`MatchingJobValidationError`).

## Cloisonnement des étapes

Balayage temporel, étape boost, projection, maintenance et exécution des jobs sont isolés : l'échec de l'une n'empêche pas les
suivantes (un événement empoisonné ne doit pas empêcher d'exécuter les jobs sains). Le résultat
porte `errors: string[]` : codes stables `temporal_error_<code>`, `boost_error_<code>`, `projection_error_<code>`, `maintenance_error_<code>`,
`job_error_<code>`, `notify_error_user_<code>`, `catchup_error_<code>`, `collect_error_<code>`, `active_search_error_<code>` (`<code>` : SQLSTATE ou code d'erreur en minuscules, `validation` ou `unknown` ;
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
