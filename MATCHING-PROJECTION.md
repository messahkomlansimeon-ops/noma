# MATCHING-PROJECTION.md — Projection outbox → jobs (lot 2E3A)

Le projecteur lit les événements `pending` de `matching_outbox_events` et crée les
lignes `matching_jobs` correspondantes, puis acquitte chaque événement, dans une seule
transaction. Il ne réserve ni n'exécute aucun job : **le matching automatique ne
tourne pas encore** (la réservation existe depuis 2E3B ; worker et émetteurs en 2E4).

Code : `lib/server/matching/projection.ts` (`planOutboxProjection`, `computeJobIdentity`,
`projectOutboxBatch`). Migration : `0009_matching_projection.sql`.
Commande : `npm run test:matching-projection` (base `TEST_DATABASE_URL` dédiée).

## Routage

| Événement | Décision |
|---|---|
| `offer.created`, `published`, `available`, `updated` avec `eligible=true` | job `evaluate_offer_candidates` |
| `demand.created`, `activated`, `updated` avec `eligible=true` | job `evaluate_demand_candidates` |
| `user.reactivated` | job `user_reactivation_sweep` (`resource_id` = compte, `resource_version` = version du compte) |
| mêmes types offre/demande avec `eligible=false` | `ignored`, raison `resource_not_eligible` |
| `offer.paused`, `unavailable`, `archived`, `demand.satisfied`, `archived`, `user.suspended`, `archived` | `ignored`, raison `non_search_event` |
| payload scellé invalide | `ignored` avec `error_message` = code stable |
| `temporal.deadline_passed` (agrégat `temporal`) | job `reevaluate_pair_temporal` (`resource_id` = offre, `resource_version` = `generation` = `aggregate_version`, `target_resource_id` = demande) |
| `scoring_config.updated`, `catalog.bootstrap_sync` | non sélectionnés, restent `pending` (lot suivant) |

**`temporal.deadline_passed` (2E4C2).** Émis par le balayeur temporel (`MATCHING-TEMPORAL.md`) avec
`aggregate_type = 'temporal'`, `aggregate_id` = offre, `aggregate_version` = version de l'offre,
`target_aggregate_id` = demande, payload `{ demandId, demandContentVersion, expiredEvaluationId }` plus la
configuration scellée et `generation` ajoutées par `recordOutboxEvent`. Contrairement aux autres routes, la cible
est **obligatoire** et il n'y a ni `status` ni `eligible` (la paire est relue par le worker). Invalide, avec code
stable et sans jamais bloquer la file : `aggregate_mismatch`, `missing_target`, `invalid_target`,
`invalid_aggregate_version`, `generation_mismatch`, `invalid_scoring_config*`, `scoring_config_hash_mismatch`,
`invalid_engine_version`, `invalid_expired_evaluation_id` (UUID), `target_payload_mismatch`
(`payload.demandId` ≠ cible). L'identité du job inclut la cible : deux expirations sur la même offre v1 avec deux
demandes donnent deux jobs distincts (plan §9.1).

Seul le payload scellé fait foi : aucune configuration courante n'est relue. Le
payload est validé pour les types chercheurs (agrégat cohérent, cible nulle, version
> 0, `generation` = version, `eligible` booléen cohérent avec `status`, hash égal à
`computeScoringConfigHash(scoring_config)`, versions de moteur non vides). Les événements
non chercheurs ne consomment aucun champ du payload et ne sont pas validés. Les versions
de moteur ne sont pas comparées au moteur courant (contrôle du worker, 2E4). Les codes
d'invalidité ne recopient jamais le contenu du payload.

## Identité des jobs

`job_identity` = SHA-256 de `canonicalJsonStringify({generation, job_type, resource_id,
resource_version, scoring_config_hash, source_event_id, target_resource_id})` (clés en
snake_case, `target_resource_id` nul explicite). Rejouer un événement redonne la même
identité : `ON CONFLICT (job_identity) DO NOTHING` reste idempotent même si le job est
déjà `completed`. Un job déjà présent est relu et comparé champ à champ ; toute
divergence lève `MatchingProjectionIntegrityError` (voir « Quarantaine »).

## Acquittement

Une seule transaction `READ COMMITTED` (`lock_timeout` 3 s, `statement_timeout` 5 s),
sélection `ORDER BY occurred_at, id LIMIT n FOR UPDATE SKIP LOCKED` (`n` entre 1 et 100,
50 par défaut). Chaque événement est acquitté par `UPDATE … WHERE dispatch_status =
'pending'` : `projected` (job), `ignored` (non chercheur, inéligible) ou `ignored` avec
code (invalide ou mis en quarantaine). Un acquittement qui ne touche pas exactement une
ligne, ou toute erreur SQL, annule tout le lot (aucun job, aucun acquittement). Un événement
invalide ou en quarantaine ne bloque jamais la file. Deux projecteurs concurrents traitent des événements disjoints.

La migration 0009 impose : `pending` ⇔ `dispatched_at` nul, `error_message` réservé à
`ignored`, version obligatoire pour un événement de compte, un seul événement par version
d'agrégat versionné, `job_identity` en 64 caractères hexadécimaux minuscules.

## Quarantaine

Un job existant qui porte la même `job_identity` avec des champs différents est un conflit
**déterministe** : il se reproduirait à chaque essai, et annuler le lot le ferait échouer
indéfiniment (un seul événement bloquerait la projection de tous les utilisateurs). Chaque
événement est donc traité sous `SAVEPOINT projection_event`. Si `insertJob` lève
`MatchingProjectionIntegrityError`, on fait `ROLLBACK TO SAVEPOINT`, l'événement est acquitté
`ignored` avec `error_message = 'job_integrity_conflict'` (code stable ; 0009 réserve
`error_message` au statut `ignored`), et le lot continue. L'acquittement reste conditionnel
(`dispatch_status = 'pending'`, exactement une ligne). Le job divergent n'est **jamais
modifié**. Le résultat porte `quarantined` (nombre d'événements concernés ; propriété présente
seulement si > 0, pour ne pas changer la forme des résultats existants).

Toute **autre** erreur (SQL, transitoire, hook, acquittement qui ne touche pas une ligne,
y compris la `MatchingProjectionIntegrityError` d'un acquittement) conserve le comportement
précédent : `ROLLBACK` du lot entier, aucun job créé, aucun événement acquitté. Un événement en
quarantaine n'est pas rejoué ; il reste visible (`ignored` + `job_integrity_conflict`) pour
un diagnostic humain, et rien ne le corrige automatiquement.

## Exclusions et limites

Pas de boucle, planificateur, route HTTP, worker, réservation de jobs, bail, heartbeat,
`claim_token`, purge, ni émetteurs temporal, scoring ou bootstrap. Les jobs créés sont
réservables depuis le lot 2E3B (`jobs.ts`), mais aucun worker ne les évalue encore : ils
restent donc `pending` ou `running` sans progression. Aucun appel réseau, IA ou SMS.
Les événements `pending` non projetables s'accumulent jusqu'à 2E4. Les événements déjà
présents dans une base migrée avant 0009 doivent respecter les nouvelles contraintes (la
migration échoue sinon) ; `noma_dev` n'a pas été migrée dans ce lot.

AUCUNE purge d'événements outbox référencés par un job non terminal : le job ne stocke que
`scoring_config_hash`, et le worker 2E4 relira la configuration scellée dans l'événement via
`source_event_id`.
