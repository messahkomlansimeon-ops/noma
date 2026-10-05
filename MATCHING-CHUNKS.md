# MATCHING-CHUNKS.md — Manifeste de chunk et CAS strict (lot 2E4A)

Ce lot fournit le protocole durable du manifeste de chunk de `matching_jobs.chunk_manifest`
(plan §5.B.6, §6.A à §6.F, §9.7). Il ne comprend **aucune évaluation** : pas d'appel à 2C1, 2A,
2B ni 2D, pas de worker, pas de migration. **Le matching automatique ne tourne pas** (2E4B/2E4C).

Code : `lib/server/matching/chunk-manifest.ts` (pur, sans SQL) et `chunks.ts` (SQL).
Commandes : `npm run test:chunk-manifest` (sans base) et `npm run test:matching-chunks`
(base `TEST_DATABASE_URL` dédiée).

## Format du manifeste

Clés exactes, toute clé inconnue ou manquante est refusée : `chunk_id`, `chunk_index`,
`manifest_version`, `state` (`initialized` | `processing` | `validated`), `predecessor_chunk_id`,
`predecessor_manifest_version`, `cursor_in`, `cursor_out`, `is_eof`, `evaluated_at`,
`scoring_config_hash`, `engine_offline_version`, `engine_scoring_version`, `candidates`.
Chaque candidat porte `candidate_id`, `candidate_version`, `pair_resource_id`,
`pair_resource_version`, `status`, `current_attempt_id` et `attempts` (historique complet).
Chaque tentative : `attempt_id`, `evaluated_at`, hash et versions de moteur, `idempotency_key`,
`attempt_hash`, `status`, `error_class`.

Règles de forme : UUID en minuscules, entiers bornés (`chunk_index` ≥ 0, versions ≥ 1, ≤ 2147483647),
curseurs acceptés par `decodeCandidateCursor` ou `null`, `is_eof ⇔ cursor_out = null`, dates ISO UTC
à la milliseconde, hash en 64 hexadécimaux minuscules, chunk 0 ⇔ aucun prédécesseur, identifiants
uniques, au moins une tentative par candidat, `current_attempt_id` = dernière tentative, statut du
candidat = statut de sa tentative courante, `validated` ⇒ aucun candidat `pending`, hash et moteur
des tentatives = ceux du manifeste.

Transitions pures (copies profondes, entrées jamais modifiées) : `buildInitialChunkManifest`
(révision 1), `appendCandidateAttempt` (état `processing`), `acknowledgeCandidateAttempt`,
`validateChunkManifest`, `assertAppendOnly`.

## Opérations SQL et résultats

Toutes exigent `LEASE_FENCE` (id, `claim_token` courant, `running`, bail valide) et prolongent le bail.
Résultat commun : `applied`, `already_applied`, `lease_lost`, `conflict` (avec le manifeste frais),
`stale_chunk`, `rejected` (avec une raison).

| Opération | Condition CAS |
|---|---|
| `initializeChunk` | chunk 0 sur `{}`, ou chunk suivant après un prédécesseur exact (identité et révision), `validated`, non EOF, index + 1 |
| `recordCandidateAttempt` | `chunk_id` et `manifest_version` en base = attendus, suivante = attendue + 1, état modifiable, cible `processing`, +1 tentative exactement |
| `acknowledgeCandidate` | idem, même nombre de tentatives |
| `validateChunk` | idem, cible `validated`, aucun candidat `pending` |
| `completeChunkedJob` | bail valide, `state = validated` ET `is_eof = true` → `completed` / `lease_lost` / `not_ready` |
| `readChunkState` | lecture seule ; bail calculé en SQL |

Les trois mutations de chunk vérifient aussi, en SQL, la non-régression structurelle : champs
structurants identiques, candidats dans le même ordre et sans altération, tentatives existantes
identiques à leur statut près (`pending` → résolu seulement). Un `previousManifest` facultatif ajoute
un contrôle `assertAppendOnly` avant tout SQL.

## Diagnostic après rowCount = 0

Relecture, puis, dans cet ordre :

| Constat en base | Résultat |
|---|---|
| job absent, autre jeton, statut ≠ running ou bail expiré | `lease_lost` |
| manifeste `{}` | `rejected: no_chunk` (init : `predecessor_missing`) |
| manifeste non conforme | `rejected: invalid_stored_manifest` |
| init : type de job non supporté, configuration, pivot ou curseur non liés au job | `rejected` : `unsupported_job_type`, `config_mismatch`, `pair_resource_mismatch`, `cursor_discontinuity` (voir « Liaison au job ») |
| autre `chunk_id` | `stale_chunk` (init : `eof_reached`, `predecessor_not_validated` ou `predecessor_mismatch`) |
| effet précis présent (tentative avec son `attempt_id`, statut d'acquittement, chunk `validated`) | `already_applied` |
| chunk `validated` sans l'effet | `rejected: chunk_validated` |
| révision différente | `conflict` + manifeste frais, à fusionner puis rejouer |
| même chunk, même révision | `rejected: invalid_next_manifest` |

Une révision supérieure seule ne prouve jamais le succès. Initialisation : `already_applied` si le
`chunk_id` et les champs structurants (candidats, premières tentatives) sont identiques.

## Liaison au job

Un manifeste décrit un job précis ; `initializeChunk` le vérifie en SQL (et non seulement en JavaScript) :

- `scoring_config_hash` du manifeste = `matching_jobs.scoring_config_hash` ; un job dont le hash est
  NULL est refusé (`NULL = x` n'est jamais vrai) → `config_mismatch` ;
- `job_type` ∈ `evaluate_offer_candidates`, `evaluate_demand_candidates`, `reevaluate_pair_temporal` (2E4C2) ; les
  autres types (`user_reactivation_sweep`, `scoring_config_sweep`) → `unsupported_job_type` ;
- chaque candidat porte `pair_resource_id = resource_id` et `pair_resource_version = resource_version`
  du job → `pair_resource_mismatch` ;
- **`reevaluate_pair_temporal` (2E4C2), règles supplémentaires**, en SQL et en TypeScript : un seul chunk EOF
  (`chunk_index` 0, `cursor_in` nul, `is_eof` vrai), au plus UN candidat et, s'il existe,
  `candidate_id` = `target_resource_id` du job (un job sans cible n'accepte aucun candidat). Violation de la cible
  ou plusieurs candidats → `target_mismatch` (nouvelle raison) ; chunk d'index > 0, curseur d'entrée ou chunk non
  EOF → `invalid_next_manifest`. Les règles et raisons des autres types sont inchangées ;
- chunk 0 : `cursor_in` nul ET `cursor_position` nul ; chunk N > 0 : `cursor_in` = `cursor_out` du
  prédécesseur validé ET = `cursor_position`, sans COALESCE → `cursor_discontinuity`.

Progression : le module pur exige `cursor_out` strictement après `cursor_in` dans l'ordre 2C1
`(created_at, id)` décroissant, en comparant les charges utiles décodées (jamais le base64). Le format
de `createdAtIso` est garanti par `decodeCandidateCursor` (UTC, 6 décimales, `Z`), donc la comparaison
lexicographique est exacte ; l'id est comparé en minuscules. Un curseur qui n'avance pas (égal ou à
reculons) est refusé avant tout SQL : `initializeChunk` est le seul chemin qui écrit les curseurs, et les
autres opérations ne les modifient pas (append-only).

Ordre du diagnostic d'initialisation après rowCount = 0 : bail perdu → manifeste en base invalide →
déjà appliqué (même `chunk_id` et mêmes champs structurants) → type de job → configuration → pivot →
règles du job de paire (`target_mismatch`, `invalid_next_manifest`) → curseur → raisons d'état existantes (`predecessor_missing`, `eof_reached`, `predecessor_not_validated`,
`predecessor_mismatch`). Le rejeu identique d'une initialisation réussie reste `already_applied`.

## Append-only et curseur

Une tentative existante n'est jamais modifiée, supprimée ni réordonnée ; seul son `status` passe de
`pending` à résolu. `cursor_position` ne reçoit que `cursor_out` (curseur 2C1) quand il est non nul ;
sur la dernière page il reste inchangé, jamais de sentinelle `EOF`. Compteurs dérivés du manifeste en
SQL à la validation : `processed` = candidats, `created` = candidats `persisted`. Un ancien message ne
rembobine ni ne recompte rien.

## Exclus et limites

Exclus : 2C1/2A/2B/2D, clés d'idempotence, détection d'obsolescence, boucle de worker, HTTP, UI, migration
(le balayeur temporel est décrit dans `MATCHING-TEMPORAL.md`). Limites : l'ancienne tentative d'un candidat relancé reste `pending`
(seule la courante s'acquitte, par conception append-only) ; l'ajout d'une tentative est refusé sur un
candidat déjà résolu ; une opération de type « record » peut, au niveau SQL, résoudre aussi une autre
tentative `pending` (reste additif) ; un manifeste corrompu en base est classé, jamais réparé.

## Reste pour 2E4B

Appels 2C1, 2A, 2B et 2D, dérivation des `idempotency_key` et `attempt_hash`, classification des
retours 2D (§6.D), détection d'obsolescence puis `supersedeMatchingJob`, vérification de la
configuration scellée de l'événement source, boucle de worker avec heartbeat et reprise.
