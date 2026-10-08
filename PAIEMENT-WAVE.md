# Paiement Wave via Sublymus (lot PAY1)

Ce document est écrit pour le **fondateur**. Il explique comment noma encaisse une recharge avec le VRAI prestataire de paiement (Wave, par l'intermédiaire de Sublymus),
comment le configurer, comment le mettre en service sans risque et ce qui peut mal tourner. C'est de l'argent réel : lisez « Mise en service » avant de poser la moindre clé.

## En bref

- Le branchement est **désactivé par défaut**. Tant que `NOMA_PAYMENT_PROVIDER` n'est pas `sublymus`, noma garde le prestataire **fictif** (page « paiement simulé », aucun argent).
  Le prestataire fictif reste **interdit en production**, comme avant.
- Avec `NOMA_PAYMENT_PROVIDER=sublymus`, une recharge ouvre une **vraie session Wave** chez Sublymus, redirige le navigateur vers Wave, puis **attend la confirmation de
  Sublymus** (webhook signé, ou rattrapage) avant de créditer. Le retour du navigateur **ne crédite jamais**.
- Le crédit passe par la **même écriture au grand livre** que la recharge fictive (partie double, `provider_clearing` → compte de l'utilisateur, une seule fois par recharge) :
  le contrôle `npm run wallet:check` vaut pour les deux.
- **Wave seulement** : Sublymus ne propose ni Orange Money ni MTN à cette adresse ; l'écran le dit (« Paiement par Wave »).
- **Aucun essai de ce lot n'a contacté Sublymus ni Wave.** Il n'existe pas de bac à sable : créer une session de paiement ouvre une vraie session Wave. Tous les essais passent
  par une **fausse API locale** (`scripts/sublymus-fake-api.ts`) et par des webhooks synthétiques signés avec un secret de test inventé. Aucune clé n'a été demandée ni lue.

## Le contrat Sublymus que noma respecte

Base : `https://wallet.sublymus.com` (réglable par `NOMA_SUBLYMUS_BASE_URL` ; les essais la pointent sur la fausse API). Toutes les routes `/v1/*` portent
`Authorization: Bearer <WAVE_API_KEY>` et `X-Manager-Id: <NOMA_SUBLYMUS_MANAGER_ID>`. Aucun identifiant n'est écrit dans le code : tout vient de l'environnement du serveur.

| Étape | Appel | Détail |
|---|---|---|
| Création | `POST /v1/checkout/complex` | `amount` (entier XOF), `currency: "XOF"`, `external_reference` **unique et stable** `noma-topup-<identifiant de la recharge>`, `source_system: "NOMA"`, `description`, `success_url` et `error_url` (https, sur `NOMA_PUBLIC_URL`), `splits: [{ wallet_id, amount, category: "PAYMENT", label, release_delay_hours: 0 }]` dont la **somme vaut exactement `amount`**. Réponse 201 : `data.payment_intent_id`, `data.status = "WAVE_CREATED"`, `data.wave_checkout_url`, `data.amount`, `data.currency`, `data.external_reference`. |
| Rattrapage | `GET /v1/intents?external_reference=<référence>` | recherche **partielle** : noma filtre la référence **exacte**, puis vérifie payeur, montant, devise, système source, identifiant et statut (`COMPLETED` payé, `WAVE_CREATED` en attente, `FAILED` échec). |
| Webhook | Sublymus → `POST /api/webhooks/sublymus` | en-têtes `X-Wave-Signature` (HMAC-SHA256 hexadécimal du **corps brut**), `X-Wave-Event` (`payment.completed` ou `payment.failed`), `X-Manager-Id`, `X-Webhook-Id` ; corps `{ event, data, timestamp }`. |
| Vérification de la clé | `GET /v1/wallets/main` (puis le solde) | commande `wallet:provider-check`, lecture seule. |

Une session n'est enregistrée que si la réponse reprend **exactement** le montant, la devise et la référence demandés et un lien `https` **sur un domaine Wave** : sinon elle est refusée.
Le lien doit être sur un **sous-domaine de `wave.com`** (par exemple `pay.wave.com`) ; la liste est dans le code (`SUBLYMUS_LINK_DOMAINS`, `lib/server/wallet/sublymus/config.ts`) et ne
s'applique pas à la fausse API locale des essais. Un lien vers un autre domaine, ou vers un nom qui ressemble à Wave (`pay.wave.com.evil.example`), n'est ni enregistré ni servi : la
recharge reste en attente et le journal garde le code `sublymus_invalid_response`. Les montants lus chez Sublymus sont des entiers de XOF : `1200`, `"1200"`, `"1200.0"` et `"1200.00"`
sont lus comme 1200 ; toute autre fraction (`"1200.5"`) est un montant illisible (anomalie, rien n'est crédité). Une référence n'est
**jamais réutilisée avec un autre montant** (le montant d'une recharge est immuable en base, et la référence dérive de son identifiant).

## Le flux d'une recharge

1. L'utilisateur choisit un montant (500 à 500 000 FCFA, par 100) sur son porte-monnaie ; l'écran dit « Paiement par Wave, Wave seulement ».
2. `POST /api/wallet/topups` crée l'**intention** (état `pending`, référence `noma-topup-<id>`, ligne de session et date du premier rattrapage dans la **même transaction**).
   La limite habituelle des recharges s'applique **avant** tout appel à Sublymus : 5 recharges en attente au plus par utilisateur.
3. noma ouvre la session chez Sublymus (hors transaction SQL), enregistre le lien et le renvoie au navigateur, qui est redirigé vers **Wave**.
   Si Sublymus ne répond pas (délai de 10 s, erreur 5xx…), l'intention reste en attente **sans lien** et la même clé d'idempotence **réessaiera** avec la même référence et le même
   montant (jamais une seconde recharge). Un 409 de Sublymus (référence déjà connue) n'est adopté que si montant, devise et statut correspondent.
   Si un webhook a terminé la recharge **pendant** l'ouverture de la session, l'état servi est relu : la réponse dit « payée » sans lien, et le statut de la session ne
   redevient jamais « WAVE_CREATED ».
4. L'utilisateur paie sur Wave puis revient sur `/paiement-retour/<id>?resultat=succes` (ou `echec`).
5. **Retour du navigateur : affichage seulement.** La page relit la recharge sur le serveur et dit « **Paiement en cours de confirmation** » tant que ni le webhook ni le rattrapage
   n'ont confirmé (relecture toutes les 3 s pendant 2 minutes). Le paramètre `resultat` de l'adresse ne change qu'une phrase : seul le serveur dit « Paiement confirmé ».
6. Sublymus envoie le webhook `payment.completed` : noma vérifie, crédite **une fois**, la page de retour passe à « Paiement confirmé ».
7. Si le webhook est perdu, le **rattrapage** (étape du worker) interroge Sublymus et crédite de la même façon.

## Le webhook (`POST /api/webhooks/sublymus`)

Ordre de traitement (contrat du fournisseur) :

1. le corps **brut** est lu (64 Kio au plus ; au-delà : 413) ;
2. la **signature** est vérifiée **à temps constant**, **avant tout parsing** : un en-tête absent, non hexadécimal, de mauvaise longueur ou calculé sur un autre texte donne **401 sans détail** ;
3. `X-Manager-Id` doit être **notre** gestionnaire (même 401) ;
4. seulement ensuite le corps est lu (JSON strict : clés en double refusées) : `event`, `data.id`, `data.externalReference` sont obligatoires. Un événement **authentifié mais
   illisible ou inconnu** (`payment.refunded`, nombre absurde, BOM, `data.id` invalide…) ne donne **jamais 400** : réponse **200**, une anomalie (`unreadable_event` ou
   `unknown_event`, rattachée à la recharge si la référence exacte en désigne une) et un code au journal (`webhook_unreadable`, `webhook_unknown_event`) ; rien n'est crédité. Seule une
   signature (ou un gestionnaire) invalide donne **401**.

Puis, dans **une transaction** : l'intention est retrouvée par sa référence **exacte** (jamais un préfixe, une casse ou un suffixe voisin) et verrouillée, la livraison déjà vue est
ignorée, et on vérifie : l'événement (égal à l'en-tête), l'identifiant Sublymus (égal à celui de la session enregistrée), le **montant**, la **devise** (`XOF`), le **statut**
(`COMPLETED` pour `payment.completed`, `FAILED` pour `payment.failed`), le **payeur** s'il est présent et le **système source** (`NOMA`) s'il est présent.

- **Tout est conforme** : le crédit passe par le chemin unique d'écriture (`applyProviderEventInTransaction`) ; réponse `200 { "received": true }` (elle ne révèle pas l'issue).
- **Un écart** (montant, devise, statut, référence inconnue, payeur…) : **rien n'est crédité**, une ligne est écrite dans la **table de rapprochement** (`sublymus_anomalies`), et on
  répond **2xx**. C'est voulu : Sublymus rejouerait la livraison en boucle sans que rien ne change (un montant ne se corrige pas en réessayant), ce qui noierait le serveur et
  masquerait le vrai problème. La table, visible sur `/admin/paiements` et par `wallet:check`, est la liste à traiter à la main.
- **Un paiement réussi après un échec** (`payment.completed` reçu alors que la recharge est déjà `failed`) : l'argent a été pris, la recharge est **créditée** comme un paiement tardif
  (une seule fois) et une anomalie `state_conflict` est journalisée pour vérification. `wallet:check` accepte l'échec ainsi supplanté. Le prestataire fictif, lui, garde « échoué = terminal ».
- **Une erreur chez nous** (base indisponible) : 503 ; Sublymus rejouera, le traitement est idempotent.
- Une signature fausse n'écrit **rien** et n'ouvre **aucune connexion** à la base.

## Idempotence : un seul crédit

Plusieurs verrous indépendants garantissent « une recharge payée = un crédit » :

| Cas | Garantie |
|---|---|
| Même livraison reçue plusieurs fois (`X-Webhook-Id` + corps identiques) | la ligne de livraison est unique **par couple (`X-Webhook-Id`, empreinte du corps)** : rien n'est refait ; la livraison s'écrit dans la **même transaction** que le crédit (si le traitement échoue, elle n'est pas marquée reçue). |
| 10 livraisons simultanées | l'intention est verrouillée (`FOR UPDATE`) : une seule applique, les autres voient « déjà traité ». |
| Deux livraisons différentes pour la même recharge | le statut de l'intention change une seule fois ; le second événement est un « doublon » journalisé. |
| Webhook et rattrapage en même temps | même verrou, même chemin : un seul crédit. |
| Dernier filet | la transaction `topup:<intention>` a une référence **unique** en base : un second crédit est refusé par PostgreSQL. |

`X-Webhook-Id` n'est pas signé : un en-tête réutilisé avec un **autre corps** n'empêche jamais le crédit d'un autre paiement, et la livraison qui crédite a **toujours sa ligne** dans
`sublymus_webhook_deliveries` (choix : **clé composite** (`webhook_id`, `payload_sha256`) plutôt qu'une ligne de conflit). Sans `X-Webhook-Id`, l'empreinte du corps sert d'identifiant.

Un paiement tardif (recharge expirée côté noma après 30 minutes, puis payée) est **crédité** : l'argent a été pris.

## Identifiants Sublymus (lot PAY1-ter, N7)

Tout identifiant venu de Sublymus (identifiant d'intention de la réponse à la création, de la liste de recherche, `data.id` d'un webhook) suit **une seule expression**, définie une fois dans le code
(`SUBLYMUS_IDENTIFIER`, `lib/server/wallet/sublymus/config.ts`) : lettres, chiffres, `.`, `_`, `:` et `-`, de 1 à 100 caractères. La contrainte `chk_sublymus_checkouts_sublymus_intent` de la
migration 0026 porte **exactement** la même expression (un test compare les deux) : un identifiant que la lecture accepte (`pi.abc123`, `pi:abc123`) ne fait plus échouer l'écriture en base (avant,
la base refusait `.` et `:` : le webhook ou le rattrapage échouait après avoir accepté l'identifiant). Aucune base réelle n'ayant reçu la migration 0026, elle a été modifiée en place ; pour une base
où elle aurait déjà été appliquée : `ALTER TABLE sublymus_checkouts DROP CONSTRAINT chk_sublymus_checkouts_sublymus_intent, ADD CONSTRAINT chk_sublymus_checkouts_sublymus_intent CHECK (sublymus_intent_id IS NULL OR sublymus_intent_id ~ '^[A-Za-z0-9._:-]{1,100}$');`

## Le rattrapage

Étape **isolée** du worker (`runMatchingCycle`, comme les abonnements et les notifications) : toute recharge **en attente depuis plus de 2 minutes** est interrogée chez Sublymus, avec une
attente **doublée** à chaque tentative (2, 4, 8, 16, 32 minutes, puis 1 heure au plus), jusqu'à **24 heures** après sa création. `COMPLETED` crédite, `FAILED` marque l'intention échouée,
`WAVE_CREATED` attend. **Lot PAY1-ter (N4) : une intention échouée reste sondée.** Une recharge `failed` (par un webhook `payment.failed` ou par une lecture `FAILED`) ou `expired` lue `FAILED`
n'est PLUS retirée du rattrapage : elle est interrogée aux mêmes intervalles (attente doublée, plafond 1 heure) jusqu'à **24 heures** après sa création, parce qu'un paiement peut réussir après un
échec (webhook `completed` perdu). Si Sublymus répond alors `COMPLETED`, la recharge est créditée **une seule fois** (même chemin et même verrou que le webhook, option `allowSuccessAfterFailure`)
et l'anomalie `state_conflict` est journalisée (origine « rattrapage »). Seule une recharge `succeeded` ferme tout de suite sa session ; au-delà de 24 h elle n'est plus interrogée (l'issue « failed »
reste lisible). `wallet:check` (`sublymus_catchup_overdue`) surveille aussi ces sessions. Les écarts (montant, devise, payeur, système source, identifiant, statut inconnu, **plusieurs** intentions exactes) sont journalisés comme anomalies
« rattrapage » sans rien créditer, sauf un **doublon exact** (deux intentions chez Sublymus pour la même référence) quand l'identifiant Sublymus de **notre** session est déjà
enregistré : l'entrée qui porte cet identifiant est jugée (et créditée si elle est payée), le doublon est journalisé (`duplicate_provider_intents`) sans bloquer le crédit ; sans
identifiant enregistré, on ne sait pas laquelle est la nôtre : anomalie, rien n'est décidé.

**Budget de temps.** Un passage dure au plus **environ 20 secondes** et s'arrête à la **première** erreur de délai (10 s), de réseau, de limite de débit (429) ou 5xx de Sublymus : la
recharge fautive reprend son attente croissante, les **autres restent dues** (leur réservation est rendue) et sont examinées au passage suivant. Une clé refusée (401) arrête aussi le
passage (réservations de 5 minutes gardées : aucun martèlement). Si un webhook crédite pendant un sondage, le sondage ne provoque aucune erreur et n'écrase pas la session terminée.

En **production**, le rattrapage joint le vrai service (`https://wallet.sublymus.com`) comme la création de session ; hors production, seule une adresse locale (la fausse API) est admise.
**Le worker doit tourner** (`npm run matching:worker`, ou `dev:full`) : sans lui, seul le webhook crédite.

## Anomalies à traiter (page `/admin/paiements`)

La page (réservée aux administrateurs : page 404 standard sinon) montre les recharges récentes, les **anomalies à traiter**, l'état du rattrapage et des webhooks. Elle expose
**l'identifiant de la recharge** (un identifiant aléatoire, nécessaire pour la retrouver) mais **aucune donnée personnelle** : ni propriétaire, ni numéro, ni référence chez Sublymus, ni
identifiant de payeur (la table n'en garde qu'une empreinte masquée de deux caractères). Après vérification chez Sublymus (et
remboursement ou crédit manuel si nécessaire), « Marquer comme traitée » enregistre l'administrateur et la date ; une anomalie n'est jamais modifiée autrement ni supprimée.

| Genre | Signification | Que faire |
|---|---|---|
| `amount_mismatch` / `currency_mismatch` | Sublymus dit « payé » pour un autre montant ou une autre devise | vérifier chez Sublymus, rembourser ou créditer à la main |
| `status_mismatch` | statut inattendu pour l'événement | souvent bénin ; vérifier |
| `unknown_reference` | référence qui n'est celle d'aucune recharge | **attendu** après `wallet:provider-checkout-test` ; sinon vérifier |
| `payer_mismatch` / `source_mismatch` | payeur ou système source différents | vérifier (voir « Hypothèses ») |
| `intent_id_mismatch` / `duplicate_provider_intents` | identifiants Sublymus incohérents | vérifier chez Sublymus (deux sessions pour une référence) |
| `state_conflict` | paiement réussi reçu sur une recharge déjà **échouée** chez nous | **crédité** (l'argent a été pris) ; vérifier chez Sublymus pourquoi l'échec avait été annoncé |
| `event_mismatch` / `invalid_amount` | événement ≠ en-tête, montant illisible (ou fraction non nulle) | vérifier |
| `unreadable_event` / `unknown_event` | événement authentifié mais illisible, ou d'un genre inconnu (`payment.refunded`…) | rien n'est crédité ; vérifier chez Sublymus |

## `wallet:check` étendu

Les contrôles de recharge existants valent pour Sublymus. Ajoutés : toute recharge Sublymus a sa ligne de session (`sublymus_checkout_missing`) qui porte sa référence
(`sublymus_checkout_mismatch`) ; toute recharge Sublymus réussie a été créditée par un **webhook authentifié ou un rattrapage**, jamais autrement
(`sublymus_credit_origin_unknown` : c'est ce qui signalerait un crédit au retour du navigateur) ; aucun événement Sublymus n'est rattaché à une recharge d'un autre prestataire
(`sublymus_event_provider_mismatch`) ; un événement d'échec « appliqué » n'est admis sur une recharge réussie que si un paiement réussi appliqué l'a suivi. Avertissements : `sublymus_anomaly_open` (anomalies à traiter) et `sublymus_catchup_overdue` (rattrapage échu depuis plus de 15 minutes :
le worker retarde).

## Configuration

Variables d'**environnement du serveur** (et du worker). Elles se posent dans le **fichier d'environnement du serveur** (par exemple le fichier lu par votre service systemd ou
votre hébergeur), **JAMAIS dans git**, jamais dans une page ni dans un fichier du dépôt.

| Variable | Rôle |
|---|---|
| `NOMA_PAYMENT_PROVIDER` | `fake` (défaut, interdit en production) ou `sublymus` |
| `WAVE_API_KEY` | clé de l'API Sublymus (en-tête `Authorization`) |
| `NOMA_SUBLYMUS_MANAGER_ID` | identifiant du gestionnaire (en-tête `X-Manager-Id`, vérifié sur chaque webhook) |
| `NOMA_SUBLYMUS_WALLET_ID` | portefeuille qui reçoit les paiements (le `wallet_id` des `splits`) |
| `SUBLYMUS_WEBHOOK_SECRET` | secret de signature des webhooks, **32 caractères au moins** |
| `NOMA_PUBLIC_URL` | adresse publique de noma, **https** (sert aux adresses de retour du navigateur) |
| `NOMA_SUBLYMUS_BASE_URL` | adresse de l'API (défaut en production : `https://wallet.sublymus.com`) |

**Refus de démarrer.** Avec `NOMA_PAYMENT_PROVIDER=sublymus`, le serveur (point d'entrée `instrumentation.ts`, via `lib/server/startup-guard.ts`) et le worker **refusent de démarrer** si une variable manque ou est mal
formée, avec un message qui **nomme les variables à corriger sans jamais afficher leurs valeurs**. En production, `NOMA_PAYMENT_PROVIDER=fake` est refusé aussi. Hors production
(développement, essais), l'adresse de l'API **doit** être sur ce poste : un développement ne contacte jamais le vrai service. La garde est aussi dans le code du client : sans autorisation
explicite (serveur de production, ou commande du fondateur hors `NODE_ENV=test`), **seule une adresse de boucle locale** est admise ; le nom de l'hôte est normalisé (casse, point final),
donc `WALLET.SUBLYMUS.COM.` ou `wallet.sublymus.com.evil.example` sont refusés comme le vrai nom.

**Le processus se termine (correctif transversal du lot de reprise PAY1).** En production, lorsque ce contrôle (ou le contrôle SMS qui le précède) refuse la configuration, `register()` journalise le message
fixe (les variables à corriger, jamais leurs valeurs) puis termine le processus avec le **code 78** (`process.exit(78)`, code dédié EX_CONFIG). Auparavant, sous `next start`, l'exception laissait le processus vivant, qui
répondait 500 à tout. Lot PAY1-ter : `deploy/noma.service` porte `RestartPreventExitStatus=78` (le refus de démarrer sort avec le code dédié 78) en gardant `Restart=on-failure` pour les autres pannes, y compris une exception non rattrapée (code 1), bornées par
`StartLimitIntervalSec=300` et `StartLimitBurst=5` : un fichier d'environnement invalide ne produit **plus de boucle de redémarrage**, le service reste `failed` et `journalctl -u noma` dit pourquoi ;
corrigez `/opt/noma/shared/.env.production` puis redémarrez (`systemctl reset-failed noma`, `systemctl restart noma`). Hors production (`next dev`), l'exception est relancée telle quelle. Les variables du paiement sont
listées (vides) dans `deploy/env.production.example` ; **aucune** ne passe au build : `npm run build:production` ne transmet que sa liste blanche, et son contrôle final efface le build si
`WAVE_API_KEY` ou `SUBLYMUS_WEBHOOK_SECRET` s'y retrouvait. Voir la section « Démarrage refusé » de `DEPLOIEMENT.md`.

**Construction de production.** Le build de production **doit** être fait avec `npm run build:production` (script livré par la branche principale) et **jamais** avec un build lancé
dans l'environnement du serveur : sinon des valeurs du serveur (clé, secret) pourraient être figées dans le build. Les variables ci-dessus ne sont lues qu'à l'exécution.

Exemple (valeurs **factices**, à remplacer sur le serveur seulement) :

```
NOMA_PAYMENT_PROVIDER=sublymus
WAVE_API_KEY=<clé fournie par Sublymus>
NOMA_SUBLYMUS_MANAGER_ID=<identifiant du gestionnaire>
NOMA_SUBLYMUS_WALLET_ID=<identifiant du portefeuille>
SUBLYMUS_WEBHOOK_SECRET=<au moins 32 caractères aléatoires>
NOMA_PUBLIC_URL=https://exemple.ci
```

## Mise en service (procédure)

1. **Faire renouveler les clés exposées.** Toute clé qui a circulé (message, capture, dépôt, discussion) est à considérer comme compromise : demandez-en de nouvelles à Sublymus
   avant de continuer.
2. Générer un secret de webhook aléatoire (`openssl rand -hex 32`) et poser les variables ci-dessus dans le fichier d'environnement du serveur **et du worker**.
3. Appliquer la migration `0026` (**sauvegarde `pg_dump` d'abord** ; `noma_dev` n'est pas migrée par ce lot) puis redémarrer le serveur : il refuse de démarrer si la
   configuration est incomplète.
4. **Enregistrer l'adresse du webhook chez Sublymus** avec `POST /v1/webhook` (voir la documentation du fournisseur), **une fois le domaine connu et en https** :
   `https://<votre domaine>/api/webhooks/sublymus`, avec le secret choisi à l'étape 2.
5. `npm run wallet:provider-check` : doit afficher « clé valide, portefeuille …, solde … » (lecture seule). **Attention : cette commande appelle le VRAI service Sublymus dès que
   `WAVE_API_KEY` est dans l'environnement de la commande** (l'adresse par défaut est le vrai service) ; c'est une simple lecture, mais c'est un appel réel avec votre vraie clé.
6. `npm run wallet:provider-checkout-test -- --amount 100 --confirm-real-checkout` : ouvre **une** vraie session de 100 XOF et affiche le lien (**notez la référence** `noma-test-…`
   affichée). Payez-la avec Wave.
7. `npm run wallet:provider-intent-check -- --reference noma-test-<horodatage>` : **après** le paiement, relit la session chez Sublymus (lecture seule) et affiche son statut
   (`COMPLETED` attendu), son montant, et le `payerId` (masqué en partie : deux premiers et deux derniers caractères) en disant s'il est **identique** ou **différent** de
   `NOMA_SUBLYMUS_MANAGER_ID`. C'est ce qui confirme (ou non) l'hypothèse sur `payerId`. Le webhook de cette session doit aussi apparaître sur `/admin/paiements` comme anomalie
   « **référence inconnue** » (attendu : la référence `noma-test-…` n'est celle d'aucune recharge ; marquez-la traitée).
   **L'ordre à suivre : `provider-check`, puis `checkout-test` à 100 F, payer, puis `intent-check`.**
8. Une **vraie recharge de 500 FCFA** depuis l'application avec un compte de test : redirection vers Wave, paiement, « Paiement confirmé », solde crédité, puis `npm run wallet:check`
   (« aucun écart »).
9. Vérifier que le **worker tourne** (rattrapage) et surveiller `/admin/paiements` les premiers jours.

## Commandes du fondateur

Elles ne sont lancées que par vous, avec une vraie clé dans **l'environnement de la commande** ; elles ne touchent pas la base de noma et n'affichent jamais la clé.

- `npm run wallet:provider-check` : **lecture seule** (`GET /v1/wallets/main`, puis le solde). Affiche « clé valide, portefeuille X, solde Y ». Code 0 succès, 1 échec, 2 usage.
  **Elle appelle le vrai service dès que la clé est présente dans son environnement** (adresse par défaut : `https://wallet.sublymus.com`).
- `npm run wallet:provider-intent-check -- --reference <référence>` : **lecture seule** (un seul `GET /v1/intents?external_reference=`). Relit la session de cette référence **exacte**
  (la recherche de Sublymus est partielle) et affiche statut, montant, devise, système source et `payerId` masqué en partie, avec le verdict sur le gestionnaire. Code 0 trouvée,
  1 échec ou introuvable, 2 usage. À lancer **après** avoir payé la session de test.
- `npm run wallet:provider-checkout-test -- --amount 100 --confirm-real-checkout` : crée **une** session réelle (plafond **500 XOF**, référence `noma-test-<horodatage>`), affiche le
  lien, ne crédite rien. **Refuse de s'exécuter sans `--confirm-real-checkout`** (avant tout appel réseau).

Sous `NODE_ENV=test` (les essais), ces trois commandes n'admettent **que la boucle locale** : le vrai service, ses variantes de casse ou de point final et tout nom voisin sont refusés
avant tout appel.

## Essais (sans Sublymus)

- `npm run test:sublymus` et `npm run test:sublymus-postgres` : configuration, signature, ordre des vérifications, client, création, reprise, erreurs, limite de débit, retour du
  navigateur sans crédit, webhook (signature fausse, corps modifié, JSON re-sérialisé, gestionnaire différent, montant ou devise modifiés, référence inconnue ou voisine, statut,
  `payment.failed`, rejeu, 10 livraisons simultanées, événements illisibles ou inconnus, paiement réussi après un échec, montants décimaux), rattrapage (filtre exact, concurrence avec
  le webhook, budget de temps, arrêt sur erreur, doublons), chemins de **production** (configuration de production complète, fetch bouchon qui intercepte
  `https://wallet.sublymus.com` : création de session, webhook, rattrapage, cycle du worker, lien hors domaines Wave), `wallet:check`, administration, commandes du fondateur ;
  lot PAY1-ter : intentions échouées ou expirées toujours sondées (attente doublée, 24 h, un seul crédit, `state_conflict`), identifiants `pi.abc123` et `pi:abc123` (webhook, rattrapage, expression
  partagée avec la contrainte de la base), unité systemd (`RestartPreventExitStatus=78`, `StartLimit*`).
- `npm run e2e:pay` (par `dev:try` branché sur la fausse API) : une recharge de bout en bout dans un navigateur : redirection vers un faux lien Wave, retour « Paiement en cours de
  confirmation », webhook synthétique signé, solde crédité une seule fois.

## Hypothèses à confirmer au premier essai réel

- **`payerId`** : noma le compare à `NOMA_SUBLYMUS_MANAGER_ID` quand il est présent (webhook et rattrapage). Si, chez Sublymus, `payerId` désigne autre chose, **rien ne sera crédité**
  et chaque paiement apparaîtra en anomalie `payer_mismatch` (aucune perte : l'argent reste à rapprocher à la main). La commande `wallet:provider-checkout-test` affiche la valeur
  reçue (masquée) et dit si elle est identique, et `wallet:provider-intent-check` la relit **après paiement** : c'est le test à faire avant d'ouvrir au public.
- **Formes de réponse** non détaillées par le contrat : la liste de `GET /v1/intents` (tableau dans `data`, ou `data.items`), le solde de `GET /v1/wallets/main`
  (`balance`, `available_balance`…), le format de `timestamp` : noma les lit avec tolérance (camelCase ou snake_case) mais exige les champs utiles (identifiant, référence, statut).
- La **date limite du lien Wave** n'est pas connue : au-delà de 30 minutes la recharge passe « expirée » chez noma, mais un paiement tardif reste crédité.

## Limites

- **Wave seulement** ; **aucun remboursement automatique** d'une recharge créditée (un remboursement passe par Sublymus, puis un ajustement d'administration journalisé).
- Une recharge payée d'un montant faux n'est **jamais** créditée : elle attend une décision humaine (anomalie).
- Pas de limitation de débit HTTP sur le webhook lui-même : il est protégé par la signature (sans secret, rien n'est lu ni écrit).
- Le rattrapage s'arrête 24 h après la création (recharges en attente, expirées ou échouées, lot PAY1-ter) ; au-delà, seul un webhook tardif peut encore créditer.
- Un passage du rattrapage s'arrête à la première erreur de Sublymus : si Sublymus reste en panne, les recharges attendent (une requête par passage), puis sont reprises au retour.
- La création d'une session dépend de la disponibilité de Sublymus (délai de 10 s) ; en cas d'échec l'utilisateur peut réessayer, la recharge n'est jamais dupliquée.
