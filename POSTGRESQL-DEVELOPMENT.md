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

Les tests des scripts (`matching:worker --once`, `matching:bootstrap`) lancent le vrai script sur un schéma
temporaire de la base de test (`PGOPTIONS="-c search_path=<schéma>"`), jamais sur `noma_dev`.

`npm run test:cleanup-schemas` liste (simulation par défaut) puis, avec `-- --apply`, supprime les schémas
`noma_test_<pid>_<32 hex>` laissés par des tests interrompus dont le processus n'existe plus ; il refuse
toute base non dédiée et toute session concurrente sur la base de test.

Sans `TEST_DATABASE_URL`, la commande échoue explicitement. Elle ne se replie pas
sur `DATABASE_URL`, ne simule pas un succès et ne nettoie aucune base applicative.
Le nettoyage supprime uniquement le schéma temporaire dont le nom est généré et
validé par le harnais ; le schéma `public` est contrôlé mais jamais nettoyé. Les
données fictives de `lib/data.ts` ne sont jamais importées.
