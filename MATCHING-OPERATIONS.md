# MATCHING-OPERATIONS.md — Exploiter le matching en développement (lot 2G1)

Aide-mémoire pour faire tourner et surveiller le matching asynchrone sur une base de développement. Aucun appel LLM,
réseau ou SMS ; supervision système (systemd, pm2) et déploiement hors périmètre.

## Démarrer : `npm run dev:full`

```bash
npm run dev:full        # next dev + worker du matching (mode boucle)
npm run dev             # inchangé : Next seul
```

`dev:full` (`scripts/dev-full.ts`) charge l'environnement comme Next (`loadEnvConfig`, donc aussi `.env.local`),
lance `next dev`, puis le worker (`scripts/matching-worker.ts`) **seulement si** `DATABASE_URL` est défini **et** si le
schéma est prêt (migration `0010_matching_job_leases` enregistrée). Sinon Next démarre seul et une ligne
`[dev:full] Worker matching NON lancé : <raison>` l'explique ; aucune migration n'est jamais appliquée par ce script.
Les lignes du worker sont préfixées `[matching]`.

- **Arrêt** : Ctrl+C ou SIGTERM. Les deux enfants reçoivent un SIGTERM (le worker termine son job en cours), le script
  attend leur fin puis sort avec le code 0. Un enfant encore vivant après 15 s est tué (SIGKILL).
- **Arrêt inattendu** d'un enfant (Next ou worker) : l'autre est arrêté et le script sort avec un code non nul
  (le code de l'enfant s'il est non nul, sinon 1). Si le worker n'avait pas été lancé, le code de Next est recopié.
- Variable réservée aux tests : `NOMA_DEV_FULL_NEXT_SCRIPT=<script JS>` remplace `next dev` par `node <script>`.
- Limite : si `dev:full` lui-même est tué par SIGKILL, ses enfants ne sont pas arrêtés (aucun superviseur).

## Lire l'état : `npm run matching:status`

```bash
DATABASE_URL=... npm run matching:status           # lecture seule, sortie lisible
DATABASE_URL=... npm run matching:status -- --json # sortie machine
```

Strictement en lecture seule (session `default_transaction_read_only = on` et transaction `READ ONLY`). Code de
sortie : **0** sain, **2** au moins un avertissement, **1** erreur (jamais de message brut). Il rapporte les
événements pending (par type, le plus ancien et son âge), projected et ignored (par code), les jobs par type et
statut, les baux expirés, les `dead_letter` (nombre et codes), les évaluations actives (dont expirées) et la date du
dernier job `completed`.

| Avertissement | Signification | Action |
| --- | --- | --- |
| `schema_not_ready` | migration 0010 absente | `npm run db:migrate` (après sauvegarde), puis relancer |
| `dead_letter_present` | des jobs ont épuisé leurs tentatives | regarder les codes (`byErrorCode`) ; corriger la cause (donnée ou bug), puis recréer le job voulu (un `--apply` du bootstrap recrée les jobs `dead_letter` des ressources éligibles) |
| `integrity_quarantine_present` | un événement a été mis en quarantaine (`job_integrity_conflict`) | un job d'identité identique existait avec d'autres paramètres : audit de l'événement concerné ; ne se résorbe pas seul |
| `oldest_pending_too_old` | un événement attend la projection depuis plus de 300 s | le worker ne tourne pas : lancer `dev:full` ou `matching:worker` |
| `job_lease_expired` | un job `running` a un bail expiré | worker mort ou bloqué : le prochain cycle d'un worker vivant le reprend (ou le met en `dead_letter` si épuisé) ; lancer un worker |
| `active_evaluation_expired` | des évaluations actives ont dépassé `expires_at` | le balayeur temporel ne tourne pas : lancer un worker (il les périme au cycle suivant) |
| `boost_settings_missing` | la migration 0011 est enregistrée mais `boost_settings` n'a pas de ligne `default` | le boost est inactif (classement organique servi, `sponsored` faux) : réinsérer la ligne `default` (0.150 / 1 / 50 / 2 / 0.340 / 0.150 / 60.00, voir `BOOST.md`) |

Les événements `ignored` d'un autre code que `job_integrity_conflict` sont comptés mais n'avertissent pas. Si le
schéma n'est pas prêt, seules les informations de schéma sont rapportées (les tables de matching peuvent manquer).

## Activer le matching sur une nouvelle base

Procédure complète et commandes exactes : `POSTGRESQL-DEVELOPMENT.md` (« Activation du matching sur une base de
développement »). En résumé, application et autres clients arrêtés : 1. **sauvegarde** (`pg_dump`, taille non nulle,
sha256) ; 2. `npm run db:migrate` (relancer : 0 appliquée) ; 3. `npm run matching:bootstrap` (**simulation**) puis
`npm run matching:bootstrap -- --apply` ; 4. `npm run matching:worker -- --once` (code 0, aucune ligne d'erreur) ou
`npm run dev:full` ; 5. `npm run matching:status` (attendu : code 0).

## Restaurer

Commandes et vérification (faite le 2026-10-05 sur une base jetable) : `POSTGRESQL-DEVELOPMENT.md`
(« Restauration de la sauvegarde »). Arrêter l'application et le worker avant ; utiliser des noms de base en
minuscules ; vérifier ensuite avec `matching:status` et un comptage des tables.
