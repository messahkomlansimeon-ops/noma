# MATCHING-BOOTSTRAP.md — Bootstrap du catalogue existant (lot 2E4C3)

Les offres et demandes créées **avant** l'outbox n'ont ni événement ni job : sans bootstrap, elles ne seraient
jamais évaluées. Le bootstrap crée un job d'évaluation par ressource éligible non encore couverte ; le runner
(`MATCHING-RUNNER.md`) les exécute ensuite. Aucun appel LLM, réseau ou SMS, aucune migration.

Code : `lib/server/matching/bootstrap.ts` (`runCatalogBootstrap`), sélection partagée avec le sweep de réactivation
dans `resource-scan.ts`, script `scripts/matching-bootstrap.ts`. Commande de test : `npm run test:matching-bootstrap`
(base `TEST_DATABASE_URL` dédiée).

## Quand et comment le lancer

**L'opérateur l'exécute À LA MAIN, sur sa base, après avoir lui-même appliqué les migrations 0001 à 0010**
(`npm run db:migrate`). Le bootstrap n'applique jamais de migration et refuse (« Schéma non prêt ») si la
migration `0010_matching_job_leases` n'est pas enregistrée dans `noma_schema_migrations`. Il n'est jamais lancé par
Next.js ni par le runner. Ordre conseillé :

```bash
DATABASE_URL=... npm run matching:bootstrap             # 1. simulation (par défaut) : affiche les compteurs, n'écrit RIEN
DATABASE_URL=... npm run matching:bootstrap -- --apply  # 2. création des jobs
DATABASE_URL=... npm run matching:worker                # 3. le runner exécute les jobs
```

La sortie ne contient aucun message brut ; le code de sortie vaut 1 en cas d'erreur.

## Garanties

- **Exclusion mutuelle** : verrou consultatif de session (`pg_try_advisory_lock`, clé fixe) sur une connexion dédiée
  tenue pendant toute l'exécution (elle sert aussi aux lots) et libérée dans un `finally` (connexion fermée si la
  libération échoue). Un second bootstrap est refusé (« Bootstrap déjà en cours ») sans aucune écriture.
- **Événement** : le plus ancien `catalog.bootstrap_sync` encore `pending` est réutilisé (reprise après crash) ;
  sinon `recordOutboxEvent` en crée un (`aggregateType 'system'`, `aggregateId` aléatoire, payload
  `{ generation: 1 }` — obligatoire pour un agrégat non versionné — et configuration de scoring scellée). Sa
  configuration est contrôlée par `readSealedConfig`. En simulation, rien n'est créé (`eventId` nul).
- **Parcours** : offres puis demandes, keyset croissant `(created_at, id)`, un lot (`batchSize` 1 à 500, 100 par
  défaut) par transaction. Éligibilité exactement celle de `loadSourceOffer` / `loadSourceDemand` (offre publiée,
  non archivée, disponibilité ≠ `unavailable` ; demande active, non archivée) **et** propriétaire actif et non
  archivé (filtré en SQL).
- **Jobs enfants** : `evaluate_offer_candidates` / `evaluate_demand_candidates`, `resource_version` = `generation` =
  `content_version`, `source_event_id` = événement de bootstrap, `scoring_config_hash` scellé dans l'événement,
  cible nulle, `insertJob` (`ON CONFLICT DO NOTHING` plus contrôle d'intégrité).
- **Fin** : l'événement passe à `projected` (`dispatched_at = clock_timestamp()`), conditionnellement
  (`dispatch_status = 'pending'`, une ligne, sinon erreur).

## Transactions et ROLLBACK

Chaque transaction (création de l'événement, un lot) se termine par COMMIT ou par un **ROLLBACK explicite** avant que
l'erreur ne soit relancée : la connexion ne retourne jamais au pool avec une transaction avortée. Si le ROLLBACK
lui-même échoue, la connexion est condamnée et libérée par `release(error)` (donc détruite, ce qui libère aussi le
verrou consultatif de session). Le contrôle de la configuration scellée a lieu APRÈS le COMMIT de l'événement :
il n'a rien à annuler. Un échec d'écriture au milieu d'un lot annule tout le lot ; l'événement reste `pending` et
un nouveau bootstrap sur le même pool le reprend aussitôt (test : trigger qui rejette l'INSERT d'un job du 2e lot).

## Règle « déjà couvert »

Une ressource éligible est ignorée (`alreadyCovered`) si, à sa `content_version` **courante** : (a) un job
`evaluate_*` du bon type existe avec un statut autre que `dead_letter`, ou (b) un événement outbox `pending` de son
agrégat existe. Un job `dead_letter`, ou un job à une ancienne version seulement, ne couvre pas : un nouveau job est
créé (relance voulue). Un événement déjà projeté ne couvre pas non plus (seul le job le ferait).

## Reprise et idempotence

Aucune progression n'est persistée. Après un crash, l'événement reste `pending` ; la relance le réutilise, refait
tout le parcours, et la règle « déjà couvert » plus les identités déterministes empêchent tout doublon. Relancer
`--apply` sur un catalogue déjà traité crée 0 job (un événement de bootstrap supplémentaire, aussitôt `projected`,
est enregistré).

## Limites

- En simulation, `jobsInserted` est le nombre de jobs qui **seraient** créés ; les ressources modifiées entre la
  simulation et `--apply` peuvent changer ce nombre.
- Le bootstrap ne dit rien du résultat des évaluations (ni classement ni confirmation) ; il ne crée que des jobs.
- Un job créé pour une ressource devenue inéligible ou modifiée avant son exécution est `superseded` par le worker.
- Le verrou est par base de données, pas par schéma : deux bootstraps sur deux schémas d'une même base s'excluent.
- Les compteurs `offersScanned` / `demandsScanned` comptent les ressources éligibles lues, y compris déjà couvertes.
- Exclus : `scoring_config_sweep`, notifications, UI. (La lecture HTTP des correspondances enregistrées est livrée au lot 2F1 : `MATCHING-STORED-READ.md`.)
