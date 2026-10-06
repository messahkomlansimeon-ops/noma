# PostgreSQL — développement et tests

La base métier PostgreSQL est distincte du fichier SQLite des quotas et budgets.
Elle n'est contactée qu'au premier appel d'une fonction de persistance. Aucun écran,
endpoint ou démarrage de l'application ne lance les migrations automatiquement.

## Base locale optionnelle

Les identifiants ci-dessous sont factices et limités au conteneur local :

```shell
npm run postgres:up
export DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_dev'
npm run db:migrate
```

`db:migrate` est l'unique commande applicative qui applique explicitement les
migrations de `database/migrations/`. Elle peut être relancée : les versions déjà
appliquées sont contrôlées par checksum et ignorées. Un verrou PostgreSQL empêche
deux lanceurs de jouer la même migration simultanément.

Ne jamais préfixer `DATABASE_URL` par `NEXT_PUBLIC_` et ne jamais committer une URL
réelle. Sans `DATABASE_URL`, le build et la recherche actuelle continuent de
fonctionner ; seule une fonction PostgreSQL appelée explicitement échoue avec un
message de configuration.

## Activation du matching sur une base de développement

Procédure exécutée sur `noma_dev` le 2026-10-05 (base alors à 0001 et 0002, sans données). Aucun test ne tourne
sur cette base ; l'application et tout autre client doivent être arrêtés.

```shell
CONTAINER=deploy-postgres-1                      # `docker ps` : image postgres:16-alpine, port 127.0.0.1:55432
# 1. Sauvegarde AVANT toute écriture ; vérifier que le fichier est non vide et contient noma_schema_migrations
docker exec "$CONTAINER" pg_dump -U noma_local -d noma_dev --no-owner > /tmp/noma-dev-backup-AAAA-MM-JJ.sql
grep -c noma_schema_migrations /tmp/noma-dev-backup-AAAA-MM-JJ.sql && sha256sum /tmp/noma-dev-backup-AAAA-MM-JJ.sql
export DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_dev'
# 2. Migrations (0003 à 0010 sur une base à 0002) ; relancer : 0 appliquée
npm run db:migrate
# 3. Bootstrap du catalogue existant : simulation (par défaut), puis création des jobs
npm run matching:bootstrap
npm run matching:bootstrap -- --apply
# 4. Un cycle du worker, sans le laisser tourner (code de sortie 0 et aucune ligne d'erreur attendus)
npm run matching:worker -- --once
```

Restauration de la sauvegarde (efface la base courante : à n'utiliser que si l'activation doit être annulée, avec
tous les clients arrêtés ; le dump n'inclut pas de `DROP`, la base doit donc être recréée) :

```shell
docker exec "$CONTAINER" psql -U noma_local -d postgres -c 'DROP DATABASE noma_dev' -c 'CREATE DATABASE noma_dev'
docker exec -i "$CONTAINER" psql -U noma_local -d noma_dev -v ON_ERROR_STOP=1 < /tmp/noma-dev-backup-AAAA-MM-JJ.sql
```

**Vérifiée le 2026-10-05**, sur une base jetable `noma_restore_test_<horodatage>` (jamais sur `noma_dev` ni `noma_test`) :
`createdb`, les deux commandes ci-dessus avec ce nom de base, puis lecture : `noma_schema_migrations` contenait 0001 et
0002, les 8 tables attendues étaient présentes (`auth_sessions`, `demands`, `noma_schema_migrations`, `offers`,
`otp_challenges`, `otp_rate_limit_counters`, `phone_identities`, `users`), `users`, `offers` et `demands` valaient 0
ligne ; `psql` a terminé avec le code 0 et aucune sortie d'erreur ; `dropdb` a supprimé la base. **Piège constaté** :
`DROP DATABASE` / `CREATE DATABASE` ne sont pas guillemetés, donc PostgreSQL replie le nom en minuscules, alors que
`createdb` conserve la casse : utilisez des noms de base **en minuscules**, comme `noma_dev`. Pour vérifier une
sauvegarde sans risque, refaites cette procédure sur une base jetable aux noms en minuscules, puis supprimez-la avec
`docker exec "$CONTAINER" dropdb -U noma_local <base>`.

## Lancer l'application et le worker ensemble

`npm run dev` (inchangé) ne lance que Next. `npm run dev:full` lance `next dev` ET le worker du matching ; voir
`MATCHING-OPERATIONS.md`. `npm run matching:status` affiche l'état de santé du matching en lecture seule.

## Tests d'intégration

Les tests exigent une base dédiée dont le nom contient `test`. Ils créent puis
suppriment uniquement un schéma aléatoire dans cette base ; ils refusent toute URL
pointant vers une base dont le nom ne ressemble pas à une base de test.

`TEST_DATABASE_URL` ne doit contenir aucun paramètre URL `options`. Ce paramètre
est refusé avant même la création d'un pool, car `pg` pourrait l'utiliser pour
écraser le `search_path` imposé par le harnais. Chaque pool de test (principal,
concurrent ou rouvert) vérifie aussi `current_database()`, `current_schema()` et
la liste effective des schémas avant les migrations ou écritures métier.

```shell
export TEST_DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_test'
npm run test:postgres
```

Les tests des scripts (`matching:worker --once`, `matching:bootstrap`, `matching:status`, `dev:full` avec un faux `next`) lancent
le vrai script sur un schéma temporaire de la base de test (`PGOPTIONS="-c search_path=<schéma>"`), jamais sur `noma_dev`.

`npm run test:cleanup-schemas` liste (simulation par défaut) puis, avec `-- --apply`, supprime les schémas
`noma_test_<pid>_<32 hex>` laissés par des tests interrompus dont le processus n'existe plus ; il refuse
toute base non dédiée et toute session concurrente sur la base de test.

Sans `TEST_DATABASE_URL`, la commande échoue explicitement. Elle ne se replie pas
sur `DATABASE_URL`, ne simule pas un succès et ne nettoie aucune base applicative.
Le nettoyage supprime uniquement le schéma temporaire dont le nom est généré et
validé par le harnais ; le schéma `public` est contrôlé mais jamais nettoyé. Les
données fictives de `lib/data.ts` ne sont jamais importées.

## Pool applicatif et mesures de coût (lot P3)

Le pool de l'application (`getPostgresPool`, `lib/server/postgres/client.ts`) a une taille maximale **explicite** (20 connexions par processus) et un
**délai d'attente d'une connexion de 5 s** (`connectionTimeoutMillis`) : quand toutes les connexions sont prises, l'appel échoue en
`timeout exceeded when trying to connect` et les routes répondent un 503 propre (avant : attente sans fin, constaté 63,9 s pour un `GET /api/wallet`
pendant douze devis de boost simultanés). Le worker a son propre pool. Les tests ouvrent leurs propres pools (`max: 1` en général).

Mesurer le coût du boost (base JETABLE, jamais `noma_dev` ni `noma_test` : le nom doit commencer par `noma_perf_`, sinon refus avant toute connexion) :

```shell
docker exec deploy-postgres-1 createdb -U noma_local noma_perf_p3
export DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_perf_p3'
npm run perf:boost -- setup     # 200 offres d'un périmètre, 1 000 besoins compatibles, 200 000 évaluations, 3 boosts (≈ 30 s)
npm run perf:boost -- measure results quote-reachable quote-unreachable purchase concurrent
docker exec deploy-postgres-1 dropdb -U noma_local noma_perf_p3
```
