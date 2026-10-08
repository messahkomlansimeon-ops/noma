# Collecte d'annonces externes mutualisée (lots EXT1 et EXT1-bis)

Lot 6 du plan d'évolution (`AUDIT-EVOLUTION-SCOUTR.md` §7) : **une collecte sert plusieurs besoins ; le même contenu n'est analysé qu'une fois ; une panne externe ne cause aucune panne interne.**

Ce document décrit ce que le code fait, et rien d'autre : chaque promesse est vérifiée par un essai (voir « Où chaque promesse est vérifiée » en fin de document). Le lot EXT1-bis corrige les écarts relevés par l'audit d'EXT1.

## Règle absolue : aucune collecte réelle

Les sites autorisés **n'ont pas été validés** par le fondateur (droit, conditions d'utilisation). Ce lot n'implémente donc que **deux connecteurs FICTIFS** (« Annonces Démo A » et « Annonces Démo B »). Le port de connecteur est prêt pour de vrais connecteurs, mais **aucun n'est écrit ni activable** :

- `external_sources.type` n'admet que `'fake'` (contrainte `CHECK` de la migration 0025) ;
- `registerSource` et `setSourceEnabled` refusent tout autre type (`SourceNotAllowedError`) ;
- le type TypeScript `SourceConnector.kind` ne vaut que `"fake"` ;
- les connecteurs de l'environnement (`resolveConnectors`) sont **vides** en production et sans `NOMA_EXTERNAL_FAKE=1` ;
- un connecteur ne reçoit **aucun client réseau** (uniquement la clé produit, un signal d'annulation et l'heure : type `ConnectorContext`) ;
- les adresses des annonces fictives sont du domaine réservé `.example` (RFC 2606) : elles ne sont jamais appelées.

Le réseau sortant n'est jamais appelé, et les essais le vérifient de deux façons :

- **un garde à l'exécution**, installé dans les essais de collecte, de stockage et HTTP, enregistre puis refuse tout `fetch`, `http.request`, `https.request`, `dns.lookup`, `dns.resolve*`, `dns.promises.*` (`lookup` et `resolve*`), `dgram` (UDP) et toute connexion TCP hors de la boucle locale. Le garde est lui-même testé (`selfTestNetworkGuard`) ;
- **une analyse statique** de `lib/server/external/` qui signale `fetch`, tout `import … from` / `import "…"` / `require("…")` d'un module réseau (avec ou sans `node:`, y compris `dns/promises`), tout `require(`, `createRequire`, tout `import()` dynamique, tout `globalThis` et tout accès calculé à un global, `eval`, `Function(`, `process.binding`, les clients connus et les processus enfants. L'analyseur est lui-même testé sur des contournements connus (`networkFindings`).

## Vue d'ensemble

```
besoins actifs ──(synchronisation, à chaque cycle)──► market_watches  (UNE surveillance par clé produit)
                                                              │ due ? (FOR UPDATE SKIP LOCKED + bail à jeton)
                                                              ▼
external_sources ──► étape « collect » du runner ──► SourceConnector.search(clé) ─► nettoyage ─► analyse par contenu ─► external_listings
   (quota, disjoncteur)        (budget, délai, délai max)                                                   │            source_observations
                                                                                                            ▼            duplicate_groups
                                              GET /api/demands/{id}/external-listings ◄── mêmes filtres que le matching interne
                                                              │
                                                  section « Sur d'autres sites » (séparée)
```

Tout le code serveur est dans `lib/server/external/` ; le runner n'a reçu qu'un ajout isolé (`lib/server/matching/runner.ts` : champ `collect`, option `collect`, code `collect_error_<code>`).

## Surveillances de marché et mutualisation

- **Clé produit normalisée** : catégorie, marque, modèle (obligatoires), variante (facultative) et zone, tous passés par `accentNormalize` (minuscules, sans accents, espaces simples, 80 caractères au plus). Un besoin sans catégorie, marque ou modèle n'a pas de clé (comme le marché de `matching/market.ts`). La variante et la zone **font partie** de la clé : « iPhone 12 » et « iPhone 12 128 Go », « Abidjan » et « Cocody » sont des surveillances distinctes.
- **La variante est lue comme l'analyseur lit un titre** (`tokenize` : lettres et chiffres séparés, « gb » lu « go ») : « 128 Go », « 128Go », « 128 GB », « 128-Go » donnent **une seule clé**, donc une seule surveillance. Une variante vide après normalisation n'existe pas ; sa longueur reste bornée à 80 caractères (colonne `variant`).
- **Création automatique** : à chaque cycle, l'étape lit les clés des besoins **actifs** (besoin non archivé, propriétaire actif), crée les surveillances manquantes (`ON CONFLICT DO NOTHING`), réactive celles qui étaient en pause et **met en pause** celles qu'aucun besoin actif ne référence. Une surveillance garde sa fréquence, son budget et son échéance.
- **Mutualisation** : trois besoins « iPhone 12 à Abidjan » partagent UNE surveillance, donc UNE requête par source. Dans la démonstration, 14 besoins actifs donnent 3 surveillances.
- **Colonnes** (`market_watches`) : `frequency_seconds` (21 600 = une collecte toutes les 6 h), `daily_request_budget` (4 requêtes par jour **et par source**), `last_run_at`, `next_run_at`, `status` (`active` / `paused`), `claim_token` (jeton du bail, voir plus bas).
- La synchronisation et la réservation n'attendent aucun verrou tenu par un autre processus (`DO NOTHING`, `FOR UPDATE SKIP LOCKED`) ; aucune opération sur les surveillances n'ouvre de connexion dédiée.
- **Rien n'est exposé à l'acheteur sur la surveillance** : ni son existence, ni la date de sa dernière collecte (elles diraient à un acheteur ce que d'autres ont cherché). La réponse de lecture ne contient ni `watching` ni `lastCollectedAt`.

## Connecteurs et registre des sources

- **Port** (`types.ts`) : `SourceConnector { code, kind: "fake", search(clé, { signal, now }) }` renvoie des `ExternalListingDraft` : identifiant externe, titre, prix, devise, URL, lieu, date, disponibilité (`available` / `unavailable` / `unknown`). La réponse d'un connecteur n'est **jamais crue** : elle est tronquée, revalidée et nettoyée (voir Confidentialité).
- **Registre** (`external_sources`) : code, nom, type, activée, quota journalier (200), délai minimal entre deux requêtes (250 ms pour les sources fictives), compteur d'échecs et ouverture du disjoncteur, jeton de l'essai décisif (`breaker_trial_until`), dernières réussite et panne, dernier code d'erreur.
- **Connecteurs fictifs** (`fake-connectors.ts`) : déterministes (même clé, même source, même jour : mêmes annonces). Chaque catalogue contient des annonces du produit, une annonce **hors budget**, un **accessoire** (coque), un **autre modèle** (« … Pro Max »), une annonce **sans lieu** ; la source B ajoute le **doublon** de l'annonce n° 1 de la source A (titre reformulé, prix à 1 % près, devise « FCFA ») et une annonce dont le **titre porte un numéro de téléphone**. Ils se pilotent par `controls` : panne, lenteur (honore l'annulation), annonces disparues, réponse invalide, dérive de prix, annonces en plus, compteur d'appels.
- **Pourquoi ils ne réutilisent pas `lib/server/fake-sources.ts`** : ses coureurs alimentent le flux NDJSON de la recherche à la demande (le besoin entier en texte, pas une clé produit), leur lenteur est réglée par une variable d'environnement globale et ils ne simulent ni panne, ni doublons entre sources, ni annonces qui disparaissent. Les conventions sont les mêmes (annonces de démonstration, hors budget, accessoire à écarter).
- **Dans le worker** : sans `NOMA_EXTERNAL_FAKE=1` (ou en production), l'étape synchronise les surveillances mais ne collecte rien (`noConnectors`). `dev:try` transmet l'environnement au worker : `NOMA_EXTERNAL_FAKE=1 DATABASE_URL=… npm run dev:try` active la collecte fictive. `npm run demo:seed` collecte directement avec les connecteurs fictifs (sans variable).

## L'étape « collect » du runner

Isolée comme les autres étapes (exécutée **après** « notify » : une panne de la collecte laisse le matching et les notifications du cycle intacts) : elle ne lève jamais, rapporte des **codes stables** (`collect_error_<code>`) et :

1. **sans la migration 0025, elle est ignorée sans erreur** (`collect.skipped`) ;
2. synchronise les surveillances ; sans connecteur, s'arrête là (`collect.noConnectors`) ;
3. **réserve** les surveillances dues, **au plus 3 par cycle** : `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)` pose en une seule instruction un **bail de 10 minutes** sur `next_run_at` et un **jeton de bail** (`claim_token`) ; deux exécuteurs ne collectent jamais la même surveillance, une surveillance tenue par un autre processus est laissée sans attendre ; si le processus meurt, la surveillance redevient due à l'échéance du bail (jamais reprise en boucle) ;
4. **bail revérifié avant d'interroger les sources** : juste avant de commencer une surveillance, l'exécuteur prolonge son bail s'il détient encore le jeton. Un exécuteur figé plus de 10 minutes dont la surveillance a été reprise par un autre n'interroge **aucune** source (`leaseLost`). La clôture (`finishWatch`) et la restitution (`releaseWatches`) sont **conditionnées au jeton** : un retardataire n'écrase jamais l'échéance de l'exécuteur qui a repris la surveillance, et une seule collecte est comptée ;
5. **budget de temps de l'étape : 10 s** (`STEP_TIME_BUDGET_MS`). Il est vérifié **avant chaque surveillance** : passé ce délai, les surveillances réservées mais non commencées sont **rendues** tout de suite pour le cycle suivant, **sans consommer ni quota ni budget** (`released`). Une surveillance commencée est toujours terminée. Ce qui est garanti : l'étape ne commence aucune surveillance après 10 s ; elle dure donc au plus ces 10 s plus la durée de la dernière surveillance commencée (au plus 2 s d'attente du verrou d'une source, 5 s d'attente du délai minimal et 8 s de recherche, puis le stockage). Ce qui ne l'est pas : une source lente retarde les surveillances SUIVANTES du même cycle (elles se suivent) ; AU SEIN d'une surveillance, les sources sont interrogées **en parallèle**, donc une source lente ou en panne ne retarde pas les autres sources de cette surveillance ;
6. pour chaque source active, **réservation atomique d'UNE requête** sous le verrou de la ligne de la source (attendu **2 s au plus** : au-delà, la source est « occupée » (`busySkipped`), ce n'est pas une erreur d'infrastructure et le cycle n'est pas bloqué) :
   - source active et disjoncteur fermé, relus sous verrou ; disjoncteur semi-ouvert : **un seul essai décisif** à la fois (jeton de 60 s pris sous le même verrou, rendu en fin d'essai ; il expire seul si le processus meurt) ;
   - **quota du jour de la source** (200) et **budget du jour de la surveillance pour cette source** (4), compteurs incrémentés seulement sous la limite ;
   - **délai minimal de la source, jamais raccourci** : si l'attente nécessaire est d'au plus 5 s, elle est imposée avant la requête ; si elle dépasse 5 s, la requête est **refusée** (motif « intervalle », `intervalSkipped`) et tout est annulé, compteurs compris ;
   - **arrêt demandé pendant l'attente** : la requête ne part pas, la réservation est rendue (compteurs, dernière requête de la source, jeton d'essai) et la surveillance redevient due (`abortedRequests`) ;
   - **délai maximal par recherche** : 8 s, au-delà échec `timeout` (la réponse est abandonnée même si le connecteur ignore le signal) ;
7. **disjoncteur par source** : 3 échecs de suite → pause de 30 minutes (aucun appel, aucune requête décomptée), puis un essai décisif : réussite = fermé, échec = rouvert aussitôt. Sont des échecs de la source : une panne du connecteur (`connector_error`), un dépassement (`timeout`), une réponse qui n'est pas une liste ou faite uniquement de rebuts (`invalid_response`), une réponse que la base refuse à l'écriture (erreur de donnée : `invalid_response`) et un interblocage persistant à l'écriture après une reprise (`store_conflict`) ;
8. **une panne d'une source n'est pas une erreur du cycle** : elle est comptée (`sourceFailures`), journalisée par code (`external_collect_runs`), nourrit le disjoncteur ; les autres sources, les autres surveillances et le reste du runner continuent. Seule une erreur d'infrastructure (connexion, droits…) donne `collect_error_<code>` ;
9. **prochaine échéance** d'une surveillance : sa fréquence (6 h) si au moins une source a répondu et qu'aucune n'a été refusée pour son délai minimal ou occupée ; **10 minutes** si aucune source n'a pu être interrogée (disjoncteur, aucune source active) ou si une source a été refusée pour son délai minimal ou occupée (la surveillance est alors reprise en entier, dans le budget du jour) ; **le prochain minuit UTC** si SEUL le quota ou le budget du jour de toutes les sources actives empêche la collecte (les compteurs sont par jour UTC : inutile de réserver la surveillance toutes les 10 minutes) ;
10. purge des compteurs d'usage (14 jours) et du journal des collectes (30 jours).

## Stockage, déduplication, disponibilité

- **Identité** : `UNIQUE (source_code, external_id)` ET `UNIQUE (source_code, canonical_url)` (via `canonicalUrl` du moteur : https, sans « www », sans paramètres de suivi, sans ancre). Une annonce connue **de cette source** est mise à jour, jamais dupliquée ; une annonce qui change d'identifiant en gardant son URL reste la même ligne. **La même adresse chez deux sources donne deux lignes** (aucune source ne réécrit ni ne fait disparaître l'annonce d'une autre) ; ces deux lignes sont ensuite regroupées comme doublons. L'adresse d'une annonce suit sa source tant qu'aucune autre annonce de cette source ne la porte ; deux transactions qui visent la même adresse en même temps : la base en refuse une (23505), l'adresse précédente est conservée et l'annonce est quand même écrite.
- **Dates** : `first_seen_at` (première vue), `last_seen_at` (dernière **vue** : l'annonce était dans la réponse de sa source), `last_checked_at` (dernier examen par une collecte réussie, annonce vue OU absente : **jamais affichée ni utilisée pour décider de l'affichage**). Robustes à un écart d'horloge entre deux exécuteurs : `first_seen_at` ne fait que reculer, `last_seen_at` et `last_checked_at` que avancer (aucune violation de contrainte, aucune collecte perdue).
- **Écriture** : une transaction par réponse de source. Toutes les annonces que la transaction peut modifier (celles de la réponse et celles que la surveillance a déjà observées chez cette source) sont **verrouillées d'emblée, triées par identifiant** : deux surveillances qui partagent des annonces ne s'interbloquent pas. Chaque annonce est écrite dans un **point de sauvegarde** : une annonce que la base refuse (erreur de donnée) est rejetée **seule** (comptée dans `rejected`, jamais comptée comme absente), les annonces saines du même lot sont stockées ; si toutes sont refusées, rien n'est écrit et la réponse est un échec `invalid_response` de la source. Un interblocage est retenté une fois (compté dans `storeRetries`, qui reste à zéro tant que les verrous sont pris dans l'ordre), puis classé en échec `store_conflict`.
- **Le même contenu n'est analysé qu'une fois** : `content_hash` (sha256 du titre, du prix, de la devise et du lieu normalisés + version de l'analyseur) est la clé de `external_analyses`. Une annonce inchangée n'est pas renormalisée ; un contenu identique de deux annonces (même source ou non) partage une analyse ; seuls les contenus modifiés sont réanalysés. Un verrou consultatif par empreinte (espace 1_314_664_981) empêche deux exécuteurs d'analyser le même contenu neuf. L'étape compte les analyses (`analyzed`, `analysisReused`). L'analyse est déterministe et sans IA (mots du titre, drapeau « n'est pas le produit »).
- **Disponibilité** : `available`, `gone`, `unknown`, avec `availability_confirmed_at` **et son origine** (`source` : la source l'a déclarée ; `absence` : disparue). Une annonce déclarée indisponible par la source passe à `gone` aussitôt. Une annonce **absente de 3 collectes réussies de suite** passe à `gone` quand TOUTES les observations de surveillances actives l'ont manquée 3 fois (`source_observations.missed_collects`) ; **une panne de la source n'est jamais une absence** ; une annonce qui réapparaît redevient `available`. `unknown` (la source ne dit rien) n'est jamais présentée comme disponible : la présence dans une recherche ne confirme pas le stock. Une annonce `gone` qui réapparaît **sans préciser sa disponibilité** devient `unknown` et son origine et sa date de confirmation sont **remises à zéro** (elles décrivaient la disparition) ; une annonce confirmée disponible qui devient `unknown` garde sa dernière confirmation.
- **Regroupement entre sources** (`duplicate_groups`, après le stockage de toutes les sources d'une surveillance, verrou consultatif 1_314_664_982, toutes les annonces à modifier verrouillées d'un coup dans l'ordre des identifiants) : même clé produit (annonces trouvées par la même surveillance), sources différentes, et **ou bien la même adresse canonique, ou bien** : **prix à 2 % près** (écart d'au plus 2 % du plus bas des deux, même devise), **les mêmes nombres dans les deux titres** (« 64 Go » et « 128 Go », « 55 pouces » et « 65 pouces » sont des produits différents ; sans cette règle, « iPhone 12 64 Go » et « iPhone 12 128 Go » atteindraient exactement le seuil de 0,6) et **titre proche** (Jaccard ≥ 0,6 des mots significatifs). Les paires forment des composantes (union) ; **aucune annonce n'est supprimée ni fusionnée, les observations d'origine sont conservées**. Deux annonces d'une même source ne sont jamais regroupées par ressemblance. Un groupe posé n'est jamais défait ; la lecture revérifie chaque membre. Un regroupement abandonné pour un interblocage est repris à la collecte suivante (`groupingConflicts`).
- **Sans écriture interne** : la collecte n'écrit ni `offers`, ni événement d'outbox, ni évaluation, ni boost, ni notification (testé table par table).

## Confidentialité : aucun numéro de téléphone

La règle de `lib/phone-text.ts` (la même que pour les annonces internes) est appliquée **avant tout stockage** :

- un champ de texte (titre, lieu) qui ressemble à un numéro est **retiré** (null) : le numéro n'est ni écrit ni journalisé ;
- une **URL** qui porte un numéro (brut ou encodé) fait rejeter l'annonce (sans lien, rien n'est montré) ;
- un **identifiant externe** qui en porte un est remplacé par une **empreinte HMAC-SHA256 à clé serveur** (`h:…`, 24 caractères hexadécimaux). La clé est **dérivée de `NOMA_AUTH_SECRET`** (le secret d'authentification existant, jamais utilisé tel quel : HMAC à séparation de domaine : domaine `noma:external:listing-id-pseudonym:v1`, distinct de celui de l'empreinte des numéros du journal SMS `noma:sms:phone:v1` et des domaines de l'authentification ; un test le vérifie). Une empreinte simple (SHA-256 sans clé) se retrouverait en quelques minutes en essayant tous les numéros ivoiriens ; celle-ci non. **Sans clé disponible** (secret absent ou invalide), l'annonce est **rejetée** (`id_phone`) ; le worker de `dev:try` reçoit le secret du lancement ;
- **aucune description, aucun vendeur, aucune photo** n'est lu ni stocké ; **seul le lien vers la source est montré**.

Autres nettoyages : schémas autres que http(s), identifiants dans l'URL, caractères de contrôle et de direction rejetés ou retirés ; prix négatif ou sans devise écarté ; FCFA/CFA lus XOF.

**Bornes** : une **date de publication** hors du 1er janvier 2000 → demain est **écartée** (le champ, pas l'annonce : une date absurde ne fait plus échouer la collecte de toute la surveillance) ; une réponse est **tronquée à ses 200 premières entrées (4 × 50) avant tout nettoyage** (les suivantes ne sont pas lues, elles sont comptées dans `truncated`) ; un texte est coupé à 4 fois sa limite avant d'être nettoyé ; au plus 50 annonces sont gardées par recherche.

## Mise en relation et écrans

- **Mêmes filtres** que le matching interne : une annonce externe est vue comme une offre publiée d'un propriétaire fictif et passe par `evaluateOfflineMatching` (catégorie, marque, modèle, variante, budget, lieu, quantité, état, exigences) puis `computeMatchingScore`. Seules les annonces **compatibles** sont montrées. Le **titre confirme le produit** : modèle en mots consécutifs, non prolongé par une extension absente de la clé (Pro, Max, mini, Ultra, FE, +…), variante présente, pas d'accessoire ; sans confirmation, marque, modèle et catégorie restent inconnus et l'annonce est écartée.
- **Séparées** : elles ne passent ni dans le classement interne, ni dans le boost (elles n'existent pas dans `offers`, n'ont ni propriétaire ni évaluation enregistrée) ; la réponse HTTP est en liste blanche, sans `sponsored` ni indicateur.
- **Fraîcheur** : n'est montrée qu'une annonce **vue** (présente dans la réponse de sa source) il y a moins de 48 h (`last_seen_at >= maintenant − 48 h`), d'une source encore activée, non absente 3 fois pour cette surveillance. La date « **Vue le** » affichée est la date de la dernière vue (`seenAt` = `last_seen_at`), jamais celle d'une collecte où l'annonce était absente.
- Lecture à la demande (`GET /api/demands/{id}/external-listings?limit&cursor`) : session exigée, besoin d'autrui = 404 identique à un besoin inexistant, besoin inactif = 400, au plus 300 candidats évalués (les plus récemment vus d'abord), 6 annonces par page par défaut (1 à 30). Tri : score, puis prix croissant. Pagination par curseur opaque. Réponse : `contractVersion`, `items`, `hasMore`, `nextCursor` (rien sur la surveillance).
- Un groupe de doublons n'est présenté **qu'une fois** (l'annonce la moins chère, avec « Aussi trouvée sur … ») ; la lecture revérifie chaque membre.
- **Section « Sur d'autres sites »** de la page de résultats (`components/external/external-section.tsx`) : séparée, avec « Voir plus », la mention **« Annonce trouvée sur <source> : noma ne garantit ni le prix ni la disponibilité ; vous serez redirigé vers le site. »**, la date de vue et un lien sortant `target="_blank"` `rel="noopener noreferrer nofollow"`. Aucune action de noma (ni contact, ni favori, ni commande). Rien n'est affiché tant qu'il n'y a rien à montrer ; en cas de panne, une note discrète, sans effet sur la page.
- **Administration** : `/admin/collecte` (lien depuis `/admin`) montre les sources (état, disjoncteur, quota consommé, dernière erreur), les surveillances (nombre, dues, en pause), les annonces et les dernières erreurs (codes en mots simples, jamais un message de source). **Lecture seule : aucun bouton d'activation.** `GET /api/admin/collection` : le même 404 pour un visiteur, un compte ordinaire ou un administrateur suspendu.

## Décision produit à venir : aucune notification externe

**Aucune notification (dans l'application ou externe) n'est créée pour une annonce externe dans ce lot** (testé : les tables `notifications` et `notification_deliveries` sont inchangées par la collecte). Décider si, quand et avec quelle formulation prévenir un acheteur d'une annonce d'un autre site est une décision produit à prendre ensuite (consentement, plafonds partagés avec les notifications internes, mention de non-garantie dans le message).

## Ce qui manque pour une vraie source

Rien de tout cela n'existe ; aucune source réelle ne doit être ajoutée avant :

1. **validation juridique** de chaque site (droit de collecter, de stocker et de réafficher) ;
2. **conditions d'utilisation** du site respectées, par écrit ;
3. **robots.txt** lu et respecté ;
4. **quotas** et délais convenus par site (les quotas par source, les budgets par surveillance et le délai minimal existent, à régler) ;
5. **consentement** ou accord du site si nécessaire, et information de l'acheteur ;
6. une **liste blanche validée** dans le code (élargissement du type `kind`, de la contrainte `CHECK` de la migration et de `assertAllowedSourceType`), sous revue, puis un connecteur par site avec ses propres tests de contrat ;
7. un client réseau sûr (délais, taille maximale, redirections, SSRF) : aujourd'hui, aucun connecteur n'en reçoit.

## Limites assumées

- La synchronisation relit les clés des besoins actifs à chaque cycle (une lecture groupée, bornée par le nombre de besoins distincts) : à espacer au-delà de quelques dizaines de milliers de besoins.
- Une surveillance est replanifiée dans son ensemble : une source en panne n'est réessayée qu'à la prochaine échéance de la surveillance (ou à la fin de la pause du disjoncteur si la surveillance est due). Une source refusée pour son délai minimal (ou occupée) fait revenir la surveillance entière dans 10 minutes : les autres sources sont alors réinterrogées, dans leur budget du jour (4 par jour et par source) ; une source dont le délai minimal dépasse 5 s ne sert qu'une surveillance à la fois par cycle.
- Le budget de temps de l'étape ne coupe pas une surveillance commencée : l'étape peut dépasser 10 s de la durée de la dernière surveillance commencée.
- Une réponse vide légitime ou erronée compte pour une absence : trois réponses vides de suite font passer les annonces à `gone` (d'où les 3 collectes).
- Deux titres qui diffèrent par un nombre (même anodin : « 3 mois de garantie » dans un seul des deux) ne sont jamais regroupés comme doublons : le regroupement préfère manquer un doublon que fusionner deux produits.
- Les groupes de doublons ne sont jamais défaits ; la lecture revérifie la ressemblance de chaque membre.
- L'analyse du titre est une heuristique (mots-clés d'accessoires et d'extensions de modèle) : elle peut laisser passer ou écarter à tort une annonce ; elle n'est pas de la compréhension sémantique.
- Les annonces externes ne sont pas purgées (croissance à surveiller) ; seuls les compteurs d'usage et le journal le sont.
- Une annonce sans lieu, sans prix quand le besoin a un budget, ou dont la devise diffère du besoin n'est jamais présentée (information inconnue = non confirmée).
- Le score affiché est 100 pour toute annonce compatible (comme les correspondances internes confirmées) ; l'ordre repose ensuite sur le prix.
- Le modèle (« iPhone12 » et « iPhone 12 ») n'est pas normalisé dans la clé comme la variante : deux écritures différentes du modèle donnent deux surveillances.
- `NOMA_EXTERNAL_FAKE` n'est pas dans la liste `PRODUCTION_FORBIDDEN_ENV` (pour ne pas modifier la protection de recherche) : en production elle est simplement ignorée (aucun connecteur).

## Commandes et vérifications

```
npm run test:external           # modules purs (clé, nettoyage, dates, pseudonyme, analyse, doublons, connecteurs fictifs, registre, réglages, analyse statique sans réseau)
npm run test:external-collect   # surveillances, budgets, délai minimal, essai décisif, arrêt, bail, verrou de source, disjoncteur, isolement des pannes, runner, concurrence, SKIP LOCKED, migration
npm run test:external-store     # identité, adresses par source, doublons, « gone », erreurs de donnée, interblocage, horloges, analyses comptées, téléphones, isolement du catalogue interne
npm run test:external-http      # mêmes filtres, section séparée, fraîcheur, surveillance non exposée, accès, pagination, administration
npm run test:external-demo      # demo:seed (3 surveillances pour 14 besoins, rejouable)
npm run test:external-client    # client, présentation, section rendue (mention, lien sortant, date de vue)
```

Verrous consultatifs : 1_314_664_981 (analyse par empreinte) et 982 (regroupement), plage réservée à ce lot (les autres lots utilisent 945 à 960, 970 à 972 et 977) et recensée dans `scripts/demo-seed-plan.ts` (`tests/scripts/demo-seed.test.ts` vérifie qu'aucun espace n'est déclaré deux fois). Migration : `0025_external_collection` (les numéros 0021 à 0024 sont ceux des lots PRO1, PH1, H1 et SMS1 : offre Pro, photos, historique des prix, journal des envois de SMS) ; elle n'est appliquée nulle part hors essais.

## Où chaque promesse est vérifiée

| Promesse | Essai (fichier : début du titre) |
| --- | --- |
| Aucun connecteur réel, type `fake` partout | `external-pure` : « registre : aucune source réelle », « le seul type de connecteur… » ; `external-store` : « aucune source réelle ne peut être enregistrée… » |
| Aucun appel réseau (garde à l'exécution, garde testé) | `external-collect`, `external-store`, `external-http` : « aucun appel réseau sortant… » + `selfTestNetworkGuard` dans chaque `before` |
| Aucun appel réseau (analyse statique, contournements) | `external-pure` : « l'analyse statique reconnaît require()… », « aucun fetch, aucun module réseau… » |
| Date absurde : champ écarté, collecte réussie | `external-pure` : « date de publication : du 1er janvier 2000… » ; `external-store` : « date de publication absurde (audit EXT1)… » |
| Annonce refusée par la base : rejetée seule ; échec de la source `invalid_response` / `store_conflict` (une reprise) | `external-store` : « une annonce que la base refuse… », « erreur de donnée de la base à l'écriture… », « interblocage persistant à l'écriture… » |
| « 64 Go » ≠ « 128 Go », tailles d'écran ; même adresse = doublon | `external-pure` : « « 64 Go » et « 128 Go »… ne sont JAMAIS des doublons… », « la même adresse chez deux sources désigne la même annonce… » |
| Fraîcheur : vue < 48 h, « Vue le » = dernière vue | `external-http` : « fraîcheur (audit EXT1)… » ; `external-client` : « ligne d'une annonce : prix en FCFA, lieu… » |
| Adresse unique par source ; deux sources = deux lignes ; course 23505 ; migration | `external-store` : « la base garantit l'unicité… », « la même adresse chez deux sources = DEUX lignes… », « l'adresse d'une annonce suit sa source… » ; `external-collect` : « migration 0025 appliquée à neuf… » |
| Délai minimal jamais raccourci (refus au-delà de 5 s, compteurs annulés, reprogrammation) | `external-collect` : « délai minimal d'une source JAMAIS raccourci… », « délai minimal respecté dans la limite de 5 s… », « délai minimal par source : l'attente est imposée… » |
| Verrous consultatifs 981 et 982 recensés | `tests/scripts/demo-seed.test.ts` : « espace dédié… » ; `external-pure` : « tous les réglages… » |
| Source occupée (verrou 2 s), cycle non bloqué | `external-collect` : « verrou de la ligne d'une source tenu par un autre processus… » |
| Budget de temps 10 s, surveillances rendues sans quota ni budget | `external-pure` : « réglages EXT1-bis » ; `external-collect` : « budget de temps de l'étape… », « source lente : le budget de temps… » |
| Réponse énorme tronquée avant nettoyage | `external-pure` : « réponse énorme : tronquée à 4 × 50… », « texte énorme… » ; `external-store` : « une réponse énorme est tronquée AVANT nettoyage… » |
| Pas d'interblocage entre surveillances qui partagent des annonces | `external-store` : « deux surveillances qui partagent des annonces… » ; `external-collect` : « regroupement en conflit (40P01)… » |
| Bail à jeton : retardataire, une seule collecte, échéance conservée | `external-collect` : « exécuteur retardataire… » |
| Horloges décalées | `external-store` : « écart d'horloge entre deux exécuteurs… » |
| Essai décisif unique (jeton) | `external-collect` : « disjoncteur semi-ouvert : UN SEUL essai décisif… », « disjoncteur semi-ouvert : un échec après la pause… » |
| Arrêt pendant l'attente : la requête ne part pas, réservation rendue | `external-collect` : « arrêt demandé PENDANT l'attente… » |
| Pseudonyme HMAC à clé serveur ; sans clé, rejet | `external-pure` : « pseudonyme : HMAC-SHA256… », « la clé d'empreinte du serveur est DÉRIVÉE… » ; `external-store` : « identifiant externe qui ressemble à un numéro… » ; `dev-try` : « collecte d'annonces externes (lot EXT1)… » |
| Surveillance non exposée (`watching`, `lastCollectedAt`) | `external-http` : « la surveillance partagée n'est jamais exposée… », « section SÉPARÉE… » ; `external-client` : « liste blanche… » |
| Clés de surveillance : « 128 Go » = « 128Go » = « 128 GB » | `external-pure` : « variante normalisée comme l'analyseur » ; `external-http` : « la surveillance partagée n'est jamais exposée… » |
| Quota du jour épuisé → minuit UTC | `external-pure` : « prochaine échéance d'une surveillance » ; `external-collect` : « quota du jour épuisé… », « budget de la surveillance par source et par jour… » |
| « gone » puis revue sans disponibilité : confirmation remise à zéro | `external-store` : « « gone » puis revue SANS disponibilité… » |
| Au plus 3 surveillances par cycle ; 300 candidats ; 6 par page | `external-collect` : « par défaut, au plus 3 surveillances… » ; `external-http` : « lecture : au plus 300 candidats… » |
| Groupes jamais défaits ; lecture revérifiée | `external-store` : « un groupe de doublons posé n'est jamais défait… » ; `external-pure` : « lecture : un groupe n'est montré qu'une fois… » |
| Annonces externes non purgées ; compteurs et journaux purgés | `external-collect` : « compteurs d'usage et journaux anciens purgés… » |
| Source en panne : surveillance replanifiée en entier | `external-collect` : « une source en panne ne bloque ni l'autre source… » |
| Démonstration : 14 besoins → 3 surveillances, rejouable | `external-demo` : « premier passage… », « rejeu à l'identique… » |
| Section, mention, lien sortant, administration lecture seule | `external-client` (`external-section`, `external-view`) ; essais navigateur `e2e:demo` |
