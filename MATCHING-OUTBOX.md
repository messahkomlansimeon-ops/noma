# Lot 2E2 — outbox transactionnelle

## Périmètre réalisé

Les migrations `0007_matching_outbox_events.sql` et `0008_matching_jobs.sql`
étaient déjà présentes lors de la reprise. Elles sont conservées sans modification
et vérifiées sur une base de test isolée. Les migrations 0001 à 0006 restent intactes.

`lib/server/matching/outbox.ts` est complété et branché aux mutations existantes.
La table de jobs est disponible, mais aucun job n'est créé automatiquement dans
ce lot. Projection, réservation, worker et balayeur restent aux lots 2E3/2E4.

## Transactions et réemploi

Les créations utilisent désormais `executeInTransactionScope`, comme les mises à
jour et archivages. Les transitions de statut et applications d'extraction
conservent leur transaction existante. Mutation, invalidation 2D et insertion
outbox utilisent toujours le même client : une erreur SQL annule les trois.
Une transaction appelante reste responsable de son commit/rollback.

`recordOutboxEvent` exige un client réservé dont l'état transactionnel réel du
pilote `pg` est `T`. Pool, exécuteur arbitraire et connexion hors transaction sont
refusés avant SQL. Le module ne démarre ni ne valide une transaction indépendante.
Il n'est exposé par aucune route HTTP.

Les moteurs 2A/2B, le calcul et la persistance 2D sont réutilisés sans réécriture.
La frontière `server-only` reste explicite.

## Événements

| Mutation effective | Événement |
| --- | --- |
| Création d'offre publiée, non indisponible | `offer.created` |
| Publication / pause / archivage | `offer.published` / `offer.paused` / `offer.archived` |
| Passage à indisponible | `offer.unavailable` |
| Retour depuis indisponible sur offre publiée | `offer.available` |
| Autre édition d'offre publiée, ou retrait vers brouillon | `offer.updated` |
| Création de demande active | `demand.created` |
| Activation / satisfaction / archivage | `demand.activated` / `demand.satisfied` / `demand.archived` |
| Autre édition de demande active, ou retrait vers brouillon | `demand.updated` |
| Suspension / réactivation / archivage de compte | `user.suspended` / `user.reactivated` / `user.archived` |
| Extraction effectivement appliquée sur ressource publiée/active | `offer.updated` / `demand.updated` |

Les changements de statut via `updateOffer`/`updateDemand` suivent la même
classification que les fonctions de transition. Une mutation combinant plusieurs
champs produit un seul événement, contenant l'état final. Les transitions de
statut priment sur celles de disponibilité. Le champ `eligible` décrit seulement
l'éligibilité de la ressource (statut et disponibilité), pas celle du propriétaire
ni la compatibilité d'une paire ; le futur consommateur doit refaire ces contrôles.

`reserved` et une disponibilité inconnue restent admissibles, conformément à 2A.
Le retour depuis `unavailable` vers `null` est donc également traité.
Les créations et simples éditions de brouillons n'émettent aucun événement de
recherche. La création d'un utilisateur ne produit pas d'événement de matching.

## Absence de changement

Les mises à jour catalogue comparent les valeurs normalisées en SQL sous verrou
avec `IS DISTINCT FROM` : JSONB, dates, montants et valeurs nulles utilisent leur
sémantique PostgreSQL. Si tous les champs sont identiques, la version et la date
de mise à jour restent inchangées, sans invalidation ni événement. Une version
obsolète reste refusée même pour une demande de modification identique.

Un statut utilisateur identique ne change plus sa version. L'archivage répété
avec la version courante est sans effet ; un compte archivé ne peut pas être
réactivé. Les transitions déjà réalisées et les applications d'extraction rejouées
ou sans changement n'émettent pas de doublon.

## Données scellées

Les identifiants, versions, statuts et disponibilités proviennent des lignes
effectivement enregistrées. La classification d'une transition utilise l'état
précédent relu sous verrou. Aucun texte brut ou résultat d'extraction n'est copié
dans le payload.

Chaque événement contient :

- `generation` : version de l'agrégat enregistré (`content_version` pour le
  catalogue, `users.version` pour les comptes). Chaque transition effective de
  suspension/réactivation incrémente ainsi la génération utilisateur. Aucune
  lecture du compte propriétaire n'est ajoutée après le verrou catalogue.
- `scoring_config` : configuration complète normalisée du scoring par défaut.
- `scoring_config_hash` : empreinte canonique calculée par le helper 2D existant.
- `engine_offline_version` et `engine_scoring_version`.

Cette génération est propre à l'agrégat, pas un compteur global. L'identité future
des jobs utilisera aussi l'identifiant immuable d'événement, comme prévu au plan.
La projection devra préserver ces données, sans relire des valeurs par défaut
ayant pu changer depuis l'émission.

Aucune administration des pondérations n'existe dans ce lot : seuls les défauts
actuels sont scellés. Le service refuse de recevoir les champs de configuration
réservés dans le payload. Les émetteurs `scoring_config.updated`,
`temporal.deadline_passed` et `catalog.bootstrap_sync` ne sont pas implémentés.

Validation avant insertion : type d'événement et agrégat cohérents, UUID,
versions dans la plage INTEGER positive, génération positive et, pour une offre,
une demande ou un compte, égale à `aggregateVersion` (version de compte obligatoire), payload JSON
simple sans cycle, fonction, nombre non fini ou conversion implicite.

## Validation

Commande dédiée : `npm run test:matching-outbox`, avec `TEST_DATABASE_URL`
désignant une base dédiée aux tests. Le helper d'isolation refuse une base non
dédiée et les paramètres de connexion pouvant détourner le schéma. Chaque suite
crée puis supprime son propre schéma. Sans URL, échec explicite, aucun test ignoré.

Les tests couvrent les migrations et leur relance, l'unicité durable des jobs,
les événements de cycle de vie, la configuration scellée, les changements via CRUD,
les no-op, la concurrence sur deux connexions, les erreurs d'outbox injectées par
trigger, le rollback de l'invalidation 2D et des reçus d'extraction, ainsi que
l'absence de commit prématuré dans une transaction appelante.

Les suites catalogue, transitions, auth, extraction, matching et HTTP existantes
sont exécutées en non-régression. Aucune migration sur `noma_dev`, aucun SMS,
appel IA, collecte, notification, paiement ou déploiement n'a lieu. Le build
Next.js n'est pas exécuté dans ce lot serveur.
