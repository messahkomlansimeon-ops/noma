# NOTIFICATIONS.md — Nouvelles correspondances et suivi des besoins (lots N1 et N1-bis)

`AUDIT-EVOLUTION-SCOUTR.md` §7, lot 5 (« recherche active et missions ») : **arrêt fiable, aucun doublon, reprise après panne, jamais de spam**. Ce premier morceau livre :

1. des **notifications dans l'application** : quand une **annonce nouvelle pour le besoin** (publiée ou modifiée après l'activation du besoin) devient, pour la première fois, une correspondance
   confirmée et fraîche de ce besoin, l'acheteur en est prévenu (page `/notifications`, pastille dans la navigation). Créer ou modifier un besoin ne notifie jamais les annonces déjà en ligne ;
2. des **envois hors de l'application SIMULÉS** (canal `sms_sim`) : un message regroupé par utilisateur, au rythme décrit plus bas (15 min de collecte, 4 h entre deux messages, 3 par jour), dans la console du
   serveur de développement seulement ;
3. le **suivi d'un besoin** (« recherche active » interne) : durée, prolongation, pause, reprise, arrêt automatique ;
4. la **rétention** (`npm run notifications:purge`).

**Par défaut, aucun vrai SMS, WhatsApp, courriel ni appel externe n'existe.** Le seul transport réel est le SMS par le fournisseur Meno (lot SMS1, **désactivé tant que `NOMA_SMS_PROVIDER=meno` et la clé ne sont pas définies**, voir `SMS.md`) ; sinon voir « Ce qui manque pour un vrai SMS ». Aucune donnée d'un acheteur n'est
jamais notifiée à un vendeur dans ce lot (le vendeur n'a aucune notification).

Code : `lib/server/notifications/` (`config.ts`, `content.ts`, `creation.ts`, `deliveries.ts`, `tracking.ts`, `preferences.ts`, `inbox.ts`, `transport.ts`, `purge.ts`, `http.ts`),
texte public partagé avec la fiche M1 `lib/server/metrics/public-text.ts`, branchements `lib/server/matching/{worker,persistence,persistence-types,outbox,runner}.ts`, routes `app/api/notifications/**` et `app/api/demands/[id]/tracking`, écrans
`app/(buyer)/notifications`, `components/{unread-badge,tracking-panel,notification-preferences-card}.tsx`, client `lib/client/{api,notifications-view}.ts`, migration `0019_notifications.sql`,
commande `scripts/notifications-purge.ts`.
Commandes de test : `npm run test:notifications` (règles pures + création et suivi), `test:notifications-delivery` (envois), `test:notifications-http`, `test:notifications-purge`
(base `TEST_DATABASE_URL` dédiée), et les modules purs du client dans `npm run test:client`.
Les essais d'envoi ne dépendent pas de l'heure réelle (heures calmes 22 h – 7 h UTC) : l'essai de la fenêtre de collecte de 15 minutes recale ses lignes sur des instants d'arrivée
FIXES (un jeu qui couvre le jour, chaque bord des heures calmes et minuit) ; `NOMA_TEST_CLOCK=HH:MM` (UTC, jour du 15/06/2032) ou un instant ISO le remplace par un seul instant,
par exemple `NOMA_TEST_CLOCK=23:59 npm run test:notifications-delivery`.

## Règles exactes — la naissance d'une notification

Une ligne `notifications` (kind `new_match`) naît **dans la même transaction PostgreSQL que l'écriture de l'évaluation** par le worker : `persistEvaluatedMatch` appelle, après l'INSERT de la
nouvelle évaluation et **avant le COMMIT**, le crochet `inTransaction` que le worker branche sur `recordNewMatchNotification`. Les deux sont validés ensemble ou annulés ensemble.

Une notification naît seulement si **toutes** ces conditions sont vraies (sinon, rien n'est écrit) :

| Condition | Motif de non-notification |
| --- | --- |
| L'évaluation est une correspondance **confirmée** (`is_confirmed_match`) | `not_confirmed` |
| Le vendeur n'est pas l'acheteur | `own_offer` |
| Les tables du lot existent (migration 0019 appliquée) | `schema_absent` : l'évaluation s'écrit **sans erreur** et sans notification |
| Le job ne vient pas du **bootstrap** du catalogue existant (`catalog.bootstrap_sync`) | `silent_source` |
| Le job n'est pas **côté besoin** : ni un job `evaluate_demand_candidates`, ni un événement `demand.created`, `demand.activated`, `demand.updated` | `demand_side` (notée dans `notification_silent_evaluations`) |
| L'évaluation est **fraîche** : exactement le prédicat de la lecture des correspondances (versions courantes des deux ressources, propriétaires actifs et distincts, offre publiée et non indisponible, besoin actif, moteur et configuration de scoring courants, non expirée) | `not_fresh` |
| Le besoin est **actif**, son suivi n'est **pas en pause** et n'est **pas expiré** | `demand_inactive`, `tracking_paused`, `tracking_expired` |
| L'annonce est **nouvelle pour le besoin** : sa publication ou sa dernière version publiée (dernier événement `offer.created`, `published`, `available` ou `updated` de l'annonce) est **strictement postérieure** à l'activation du besoin ou à sa dernière modification (dernier événement `demand.created`, `activated` ou `updated`). Une annonce sans événement de publication connu (d'avant le service) n'est pas nouvelle | `not_new_for_demand` (notée dans `notification_silent_evaluations`) |
| Aucune notification n'existe déjà pour (acheteur, besoin, annonce) | `already_notified` |
| Le couple n'a **jamais** été une correspondance confirmée avant (aucune évaluation confirmée dans l'historique de la paire, évaluations périmées comprises, **sauf** celles notées « sans notification possible » : l'acheteur n'a jamais été prévenu) | `already_matched` |

**Exception : le balayage de réactivation d'un vendeur** (`user.reactivated`, jobs côté annonce) garde la règle de N1 : ses annonces redeviennent visibles et sont nouvelles pour les acheteurs, la règle de nouveauté
n'est pas appliquée (les jobs côté besoin, eux, restent silencieux). Un appel direct de `recordNewMatchNotification` sans type de job (essais, outils) n'applique ni la règle « côté besoin » ni la règle de nouveauté.

**Pourquoi des évaluations « sans notification possible »** : le job du besoin qui passe avant celui d'une annonce nouvelle l'évalue déjà (silencieusement) ; sans cette note, son évaluation compterait comme « ce couple était
déjà une correspondance » et la privrait de sa notification. Une annonce **ancienne modifiée après l'activation** notifie une fois (première fois seulement : l'évaluation qui l'a notifiée fait ensuite partie de l'historique).

### Anti-doublon

- Unicité en base : `uq_notifications_new_match (user_id, kind, demand_id, offer_id)` ; l'écriture est `ON CONFLICT … DO NOTHING`.
- **Rejeu d'un job** (même tentative) : `persistEvaluatedMatch` renvoie l'évaluation déjà écrite (`isReplayed`) **avant** le crochet : aucune écriture.
- **Panne au milieu de la transaction** (après la notification, avant le COMMIT) : rollback des deux ; la relance les écrit une seule fois.
- **Mort du processus juste après le COMMIT** : la notification existe déjà (même transaction), le rejeu n'en crée pas d'autre.
- **Deux évaluations du même couple** (job de l'offre et job du besoin, ou deux workers concurrents) : le verrou de paire de la persistance les sérialise ; la seconde voit une évaluation
  confirmée dans l'historique (`already_matched`).
- **Réévaluation d'un couple déjà notifié** (annonce modifiée, nouvelle version du moteur) : jamais de seconde notification, lue ou non.

### Anti-rafale (recalcul en masse)

- Un couple qui **était déjà** une correspondance avant (changement de scoring, sweeps, modification d'une annonce ou d'un besoin) ne notifie jamais : la règle `already_matched` ne dépend
  d'aucun marqueur de « recalcul ». Seuls les couples **nouvellement correspondants** notifient.
- **Créer, activer ou modifier un besoin (budget relevé compris) ne notifie jamais** : l'acheteur a déjà les résultats sous les yeux. Seules les annonces **nouvelles** pour le besoin notifient (voir la règle
  de nouveauté ci-dessus).
- **Plafond de 20 notifications `new_match` par besoin ET de 50 par utilisateur (tous besoins confondus), par jour UTC.** Les comptes sont **exacts sous concurrence** : un verrou consultatif par
  (utilisateur, jour UTC) est pris **avant** de compter et tenu jusqu'à la fin de la transaction de l'évaluation.
- Au-delà : **une seule** notification de résumé (`new_matches_digest`, « N nouvelles annonces ») par besoin et par jour UTC (index unique `uq_notifications_digest`) ; `item_count` augmente de 1 à chaque
  annonce au-delà du plafond, **remet `read_at` à NULL** (un résumé déjà lu redevient non lu : une annonce de plus ne passe jamais inaperçue) et **avance sa date** à celle de la dernière annonce ajoutée (le résumé remonte
  en tête de liste et « Tout marquer comme lu » ne le marque que s'il l'a vu). Chaque annonce d'un résumé a **sa ligne d'envoi externe** (pour un utilisateur qui l'a demandé) : le compte du message externe les inclut.
- **Bootstrap** (annonces et besoins créés avant le service) : les jobs créés par `matching:bootstrap` n'écrivent **aucune** notification (les couples existaient avant le service ; un recalcul
  en masse n'est pas une nouveauté pour l'acheteur). Les évaluations sont écrites normalement.

### Contenu en liste blanche

Titre de l'annonce (marque, modèle, variante), prix, lien vers la fiche **dans le contexte du besoin** (`/besoins/{id}/offres/{offerId}`, la fiche M1). Chaque morceau du titre est un texte saisi par
le vendeur : il est nettoyé par les **MÊMES fonctions que les attributs publics de la fiche M1** (`lib/server/metrics/public-text.ts`) : texte **normalisé en NFKC** (chiffres pleine chasse « ０７０８… », exposants,
chiffres mathématiques ramenés à la forme usuelle), chiffres comptés avec `\p{Nd}` (arabes-indiens « ٠٧٠٨… », dévanagari, etc. : jamais `\d`, qui ne voit que l'ASCII), caractères de contrôle, de direction ou invisibles refusés ;
un morceau de plus de 50 caractères, ou qui ressemble à un téléphone (règle du lot D3 : `lib/phone-text.ts`, voir `MESURES.md`, section « Numéros de téléphone cachés ») est écarté. Le titre **assemblé** est contrôlé à son tour : **au plus 8 chiffres au total** (tous
systèmes d'écriture confondus, séparateurs quelconques) ; le morceau qui ferait dépasser est retiré, les précédents restent ; « Nouvelle annonce » s'il ne reste rien. La fiche M1 applique la même fonction à ses attributs (valeur,
unité et texte assemblé). **Jamais** : téléphone, identifiant du vendeur, texte libre (description, attributs).
Le DTO de l'API est en liste blanche avec `contractVersion` ; le client relit chaque champ et ne suit jamais un lien venu du serveur (il le reconstruit depuis les identifiants).

## Règles exactes — les envois hors de l'application (simulés)

### Désactivé par défaut, opt-in

`notification_preferences.external_enabled` (faux par défaut), réglé par `PUT /api/notifications/preferences`. Une ligne d'outbox `notification_deliveries` n'est écrite (dans la **même transaction** que la
notification) que pour un utilisateur qui l'a demandé. Texte fixe affiché avec les préférences tant qu'aucun vrai transport n'existe : **« Les envois par SMS ne sont pas encore disponibles : ils sont
simulés en développement. »** Sans transport, le choix est enregistré, rien n'est envoyé (c'est dit à l'écran).

### Le transport simulé, verrouillé

Port `NotificationTransport` (`transport.ts`) : `send({ userId, count, link, idempotencyKey })`. Seule implémentation : le transport de **développement**, qui écrit **une ligne** sur la sortie du processus.

- Actif **uniquement** si `NODE_ENV === "development"` **ET** `NOMA_DEV_NOTIFY_CONSOLE === "1"` (même verrou que `NOMA_DEV_OTP_CONSOLE`). Avec le drapeau et toute autre valeur de `NODE_ENV`
  (production comprise) : **refus explicite**, aucun transport, un avertissement fixe journalisé une seule fois par processus (`[notify:dev] NOMA_DEV_NOTIFY_CONSOLE=1 ignoré …`).
- La ligne : `[notify:dev] envoi simulé à 0f1e2d3c… : 3 annonces, lien /notifications` — l'identifiant **tronqué** (8 caractères hexadécimaux), le **nombre** d'annonces et le **lien**, rien d'autre
  (ni titre, ni prix, ni numéro, ni identifiant entier, ni clé d'idempotence).
- Le serveur Next et le worker lisent l'environnement à chaque usage ; `dev:try` transmet l'environnement du lancement (voir `ESSAYER.md`).
- **Défense de déploiement** : `NOMA_DEV_NOTIFY_CONSOLE` figure dans `PRODUCTION_FORBIDDEN_ENV` (`lib/server/config.ts`) et dans la section « INTERDIT en production » de `deploy/env.production.example` (un
  test vérifie que la liste est complète) : `assertProductionConfig` refuse de démarrer la protection de recherche, avec `NODE_ENV=production`, si elle est définie et non vide.

### L'étape « notify » du runner

`runMatchingCycle` exécute, **en dernier** (une notification née dans le cycle part dans le cycle), l'étape `notify`, isolée comme l'étape boost : son échec ne change rien aux autres étapes (`errors` : `notify_error_<code>`,
jamais un message). Migration 0019 absente : étape ignorée sans erreur (`notify.skipped`). Sans transport : `notify.noTransport`, aucun envoi. Résultat : `notify { skipped, noTransport, users, messages,
delivered, skippedDeliveries, deferred, failed, retried, expired, busy, errors }`. Le mode `matching:worker --once` affiche une ligne de résumé seulement si l'étape a travaillé.

**Une erreur de l'étape pour un utilisateur compte comme « au repos » pour la boucle du worker** (`idle`) : les tentatives de ses lignes arrivées à échéance sont **incrémentées** (`last_error` = `user_<code>`), avec
l'attente croissante des envois (5 min après la première, 30 min après la deuxième), puis `failed` après 3 ; l'utilisateur n'est relu qu'à l'échéance suivante. Une panne permanente ne fait donc **ni tourner la boucle sans pause
ni écrire une ligne de journal par cycle** : une ligne `notify_error_user_<code>` par erreur et par tentative. Si cette écriture échoue à son tour (base malade, déclencheur qui refuse la mise à jour), les lignes ne bougent pas,
mais la boucle se repose quand même (attente doublée jusqu'à 30 s) : une ligne de journal par cycle de repos, jamais une rafale. Les autres utilisateurs sont servis.

Par utilisateur, **deux temps courts**, chacun une transaction sous le **verrou consultatif de l'utilisateur** (`pg_try_advisory_xact_lock`, un seul traitement à la fois pour lui) avec prise des lignes en
**`FOR UPDATE SKIP LOCKED`** (une ligne tenue par une autre transaction est laissée, sans attente) : (1) revérification, heures calmes, plafond, intervalle, puis **figeage du lot** ; (2) nouvelle prise du verrou, revérification,
appel au transport, marquage. Un message emporte **TOUT ce qui est en attente** pour l'utilisateur (tous besoins confondus, résumés compris), dans la limite de 5 000 lignes par message (le reste part dans le suivant).

### Rythme des envois externes (par utilisateur)

| Règle | Valeur | Mécanisme |
| --- | --- | --- |
| Fenêtre de collecte | **15 min** | une ligne d'envoi naît avec `next_attempt_at = created_at + 15 min` ; l'utilisateur n'est traité qu'à l'échéance de sa première ligne, puis le message emporte tout ce qui est en attente (les rafales sont regroupées) |
| Intervalle entre deux messages | **4 h au moins** | le dernier `sent_at` de l'utilisateur + 4 h ; avant : **report** |
| Plafond | **3 messages par jour UTC** | comptage des `batch_key` distincts envoyés dans le jour ; au-delà : **report** à minuit, donc à 7 h |
| Heures calmes | **22 h – 7 h UTC** (Afrique/Abidjan) | **report** à 7 h |
| Expiration | **48 h** | une ligne en attente depuis plus de 48 h sort du canal externe (`skipped`, `expired`) ; la notification reste dans l'application |

**Ce qui ne peut pas partir est REPORTÉ, jamais écarté pour cause de plafond** : `next_attempt_at` avance (jamais en arrière, jamais pendant les heures calmes : un report qui tombe la nuit va à 7 h), sans compter de tentative.
Mesure de référence : 12 annonces en 1 s → 1 message 15 min après la première ; une annonce toutes les 7 s pendant 1 h → 2 messages en 6 h (à 15 min, puis 4 h plus tard), rien d'écarté, le compte de chaque message est exact.

### Lot figé et clé d'idempotence

Quand un message est décidé, **la composition du lot est figée AVANT l'envoi** : `batch_key` (SHA-256 des identifiants triés, 32 caractères) est posée sur chaque ligne membre et validée (COMMIT). Une **nouvelle tentative
envoie le MÊME lot avec la MÊME clé**, même si d'autres lignes sont arrivées entre-temps : elles partent dans le **message suivant** (au moins 4 h plus tard). Le lot figé attend sa propre échéance (attente croissante après un échec) ;
un lot dont toutes les lignes deviennent invalides disparaît (`skipped`), un lot partiellement invalide part avec les lignes valables et la même clé. Le plafond du jour compte les `batch_key` distincts **envoyés**.

### Tout est REVÉRIFIÉ au moment d'envoyer

Chaque ligne prise est contrôlée ; sinon elle passe à `skipped` avec un motif (colonne `reason`), dans cet ordre :

| Motif | Condition |
| --- | --- |
| `preference_disabled` | l'utilisateur a retiré son opt-in |
| `user_inactive` | compte suspendu ou archivé |
| `demand_inactive` | besoin plus actif (ou archivé) |
| `tracking_paused` / `tracking_expired` | suivi en pause / échu |
| `offer_unavailable` | annonce non publiée, archivée ou indisponible |
| `no_longer_matching` | plus de correspondance **confirmée et fraîche** pour le couple (évaluation périmée, version changée, devenue incompatible…) |
| `expired` | en attente depuis plus de 48 h |

- **Tentatives** : au plus **3** appels au transport par ligne, attente croissante (**5 min** après le premier échec, **30 min** après le deuxième), puis `failed` ; seul un code (`transport_error`,
  `transport_timeout` après 5 s) est conservé, jamais le message de l'erreur.
- **Reprise après panne** : une mort **avant** le COMMIT d'envoi laisse les lignes en attente et le lot figé (reprise au cycle suivant, même lot, même clé). Entre l'appel au transport et le COMMIT, le message peut être renvoyé : la
  livraison est **au moins une fois**, avec la **même** clé d'idempotence (`idempotencyKey`) pour qu'un vrai fournisseur puisse dédoublonner. Les notifications **dans l'application**, elles, n'ont jamais de doublon.
- Un besoin satisfait ou archivé annulé **entre** le figeage et l'envoi : les lignes passent à `cancelled`, aucun message ne part pour elles.

## Recherche active payante : deux genres de plus (lot RA1)

`new_external_match` (« annonce d'un AUTRE SITE » : titre nettoyé, prix, nom de la source ; le lien est la page du BESOIN, jamais l'adresse de l'annonce externe) et `active_search_expiring` (avis d'échéance de l'option, 3 jours avant la fin) s'ajoutent à `new_match`, `new_matches_digest`, `new_message` et `mission_coverage` (couverture d'une mission, lot MV1, migration 0027 : la 0028 reprend ce genre et la colonne `mission_id` dans les deux contraintes de `notifications`, voir `RECHERCHE-ACTIVE.md`). Ils ne naissent que pour un besoin dont l'option payante est en vigueur (étape `activeSearch` du worker, `RECHERCHE-ACTIVE.md`), comptent dans les **mêmes plafonds** (20 par besoin et 50 par utilisateur et par jour UTC, un résumé au-delà), ont les mêmes envois externes simulés (ligne d'envoi sur `external_listing_id`, revérifiée à l'envoi) et apparaissent dans `/notifications` (pastilles « Autre site » et « Recherche active ») et sur l'accueil. Le plafond du suivi ci-dessous passe de 90 à **180 jours pendant** l'option.

## Le suivi d'un besoin

Colonnes `demands.notify_until` (défaut **création + 30 jours** par déclencheur ; les besoins qui existaient reçoivent **maintenant + 30 jours** à la migration) et `demands.notify_paused`.
**Le MATCHING continue pendant une pause ou après l'expiration** (les résultats restent visibles et à jour) : seules les notifications s'arrêtent. Le suivi n'est pas du contenu : le modifier
n'incrémente jamais `content_version` et n'émet aucun événement de matching.

| Action (`POST /api/demands/{id}/tracking`, corps `{ "action" }`) | Effet |
| --- | --- |
| `extend` | `notify_until` + 30 jours à partir de l'échéance (de maintenant si elle est passée), **plafonné à maintenant + 90 jours** (**180 jours pendant la recherche active payante du besoin**, lot RA1 : `trackingMaxDaysFor` ; à la fin de l'option l'entretien ramène le suivi à 90 jours au plus), jamais réduit ; sans effet au plafond |
| `pause` | `notify_paused = true` (idempotent) |
| `resume` | `notify_paused = false` (idempotent) ; ne prolonge pas un suivi échu |

Réservé au **propriétaire** (un besoin d'autrui ou inconnu : le même 404). Seul un besoin **actif** a un suivi modifiable (sinon 409 `demand_not_active`). `GET /api/demands/{id}/tracking` renvoie le suivi
(`until`, `paused`, `active`, `maxUntil`, `demandStatus`).

**Un besoin satisfait, archivé ou remis en brouillon arrête tout** : `recordDemandMutation` annule les envois en attente de ce besoin (`cancelled`, motif `demand_satisfied`, `demand_archived` ou
`demand_inactive`) **dans la même transaction que le changement de statut** (annulés avec lui ou pas du tout, testé avec un échec injecté). Un besoin réactivé n'est pas automatiquement prolongé :
un besoin créé en brouillon et activé plus de 30 jours après sa création a un suivi déjà échu (« Suivi terminé le … », bouton Prolonger).

## API

Toutes les réponses sont `no-store`, avec des textes fixes (jamais une donnée de la base) ; les écritures vérifient l'**origine AVANT la session** (403 sans cookie) ; le propriétaire vient **toujours** de la
session ; les accès à la ressource d'autrui donnent le **même 404** que pour une ressource inconnue (octet pour octet) ; le journal serveur ne reçoit qu'un code.

| Route | Rôle |
| --- | --- |
| `GET /api/notifications?limit&cursor` | `{ contractVersion: "notifications/v1", unreadCount, items, nextCursor }` : pages de 1 à 50 (20 par défaut), plus récentes d'abord, curseur opaque, `unreadCount` = **toutes** les non-lues |
| `POST /api/notifications/read` | corps exactement `{ "ids": [uuid, …] }` (1 à 100) **ou** `{ "all": true, "upTo": "<createdAt de la plus récente notification affichée>" }` (instant UTC à la milliseconde `YYYY-MM-DDTHH:MM:SS.mmmZ`, obligatoire : `{ "all": true }` seul est refusé en 400) ; « tout » ne marque que les notifications **créées avant ou à `upTo`** (à la milliseconde) : celles arrivées après le chargement restent non lues. Une seule notification d'autrui ou inconnue → 404 et **aucune** n'est touchée ; idempotent |
| `GET` / `PUT /api/notifications/preferences` | `{ preferences: { externalEnabled }, external: { available, notice } }` ; PUT exactement `{ "externalEnabled": booléen }` |
| `GET` / `POST /api/demands/{id}/tracking` | suivi du besoin, actions `extend`, `pause`, `resume` |

Un élément de liste : `{ id, kind, title, price, count, demandId, offerId, link, createdAt, readAt }` (`count` pour un résumé seulement ; `title` nul pour un résumé).

## Écrans (mots simples)

- **`/notifications`** : liste (non-lues en **gras** avec un point), « Tout marquer comme lu » (envoie la date de la plus récente notification affichée : une notification arrivée après le chargement de la page reste non lue, le message dit alors
  « Les notifications affichées sont marquées comme lues. D'autres sont arrivées depuis. »), lien « Voir l'annonce » vers la fiche M1 ; ouvrir une annonce la marque comme lue ; « Voir plus » (curseur).
- **Pastille** du nombre de non-lues sur l'onglet **Alertes** de la navigation et sur le lien « Notifications » de la page « Mes besoins » (et de la page Compte). Elle est relue à l'arrivée sur une
  page et au retour au premier plan, **jamais plus d'une fois par minute** (`createUnreadRefresher`, testé : une panne n'autorise pas de nouvelle tentative avant une minute, les demandes
  simultanées partagent une requête). Elle n'est relue que depuis un écran dont la session est confirmée : un visiteur anonyme ne provoque aucune requête.
- **Page d'un besoin** : « Suivi actif jusqu'au … », **Prolonger de 30 jours**, **Mettre en pause** / **Reprendre**, et la phrase « Pendant une pause ou après la fin du suivi, les résultats restent à jour :
  seules les notifications s'arrêtent. »
- **Page Compte** : la carte « Notifications par SMS » (interrupteur « Me prévenir par SMS (simulé) », désactivé par défaut), le texte « Désactivé par défaut. Au plus 3 messages par jour, regroupés, jamais entre 22 h et 7 h. » et le texte fixe
  « pas encore disponibles ».

## Rétention — `npm run notifications:purge`

Simulation par défaut (compte, ne supprime rien) ; `-- --apply` supprime, par lots de 5 000 lignes : `notifications` **lues depuis plus de 90 jours OU créées depuis plus de 180 jours**, et
`notification_deliveries` **créés depuis plus de 180 jours** (« plus de » est strict : 90 ou 180 jours pile sont gardés). Même garde d'environnement que `metrics:purge` : `NODE_ENV` absent,
`development` ou `test` (casse exacte) ; toute autre valeur est refusée, simulation comprise ; `NODE_ENV=production` exige `NOMA_NOTIFICATIONS_PURGE_PRODUCTION=1` (la variable de `metrics:purge`
n'autorise pas cette commande). `DATABASE_URL` obligatoire, aucun message brut, code de sortie 0 ou 1. Supprimer une notification n'efface pas son envoi récent (clé étrangère `SET NULL`). À planifier une fois par jour.

## Migration 0019

`demands.notify_until` (NOT NULL, `CHECK notify_until >= created_at`, déclencheur `BEFORE INSERT` qui pose `created_at + 30 jours`) et `notify_paused` ; tables `notification_preferences`, `notifications`
(contraintes de forme, unicités partielles, lecture, non-lues, plafond, purge) et `notification_deliveries` (CHECK sur les statuts et les compteurs : `attempts` de 0 à 3, `failed` ⇒ 3, `pending` ⇒ moins de 3,
`sent` ⇔ `sent_at` ⇔ `batch_key`, `skipped`/`cancelled` ⇒ motif, codes stables seulement ; index de prise des envois, de l'utilisateur, du besoin, du plafond du jour, de purge) ;
index partiel `idx_matching_eval_pair_confirmed (offer_id, demand_id) WHERE is_confirmed_match` (« ce couple était-il déjà une correspondance ? ») ; table `notification_silent_evaluations` (évaluations écrites sans notification
possible : job côté besoin, annonce non nouvelle) ; `batch_key` posée à la formation du lot (avant l'envoi : `sent` ⇒ `batch_key`, pas l'inverse) et index `idx_notification_deliveries_user_frozen`. Additive. Appliquée à `noma_e2e` et aux schémas de test,
**jamais** à `noma_dev`. Une base non migrée reste utilisable : le worker écrit ses évaluations sans notification et ignore l'étape notify.

## Vie privée

Aucune donnée d'un acheteur n'est notifiée à un vendeur ; le vendeur n'a aucune notification. Les journaux serveur ne contiennent ni contenu de notification ni numéro (seulement des codes ; la console
du transport de développement : identifiant tronqué, nombre d'annonces, lien). Le téléphone d'un utilisateur n'est lu par aucune étape de ce lot.

## Ce qui manque pour un vrai SMS

Lot SMS1 : le **transport SMS réel** (Meno) existe (`lib/server/sms/notification-transport.ts`, clé d'idempotence `notif-<lot figé>`, numéro vérifié lu dans `phone_identities` à l'envoi, résultat incertain jamais renvoyé : lignes `sent` avec `last_error='sms_uncertain'` ; lot SMS1-bis : budget des notifications atteint = lot **reporté** au lendemain 7 h UTC, jamais `failed`, `last_error='sms_budget'`) ; mise en service, coût (15 F par SMS) et rapprochement : `SMS.md`. Le branchement reste **désactivé par défaut**. Reste :

- un **consentement** explicite plus complet (opt-in légal, désinscription, STOP) : aujourd'hui seule la case des préférences (désactivée par défaut) autorise l'envoi ;
- la **gestion des retours du fournisseur** (accusés de réception, numéros invalides, désinscriptions) : « accepté » n'est pas une preuve de livraison ; la déduplication par clé d'idempotence est faite côté fournisseur ;
- un **suivi des coûts** au-delà de `/admin/sms` (consommation du mois lue chez le fournisseur) et des budgets du jour (`NOMA_SMS_DAILY_CAP` découpé, affichés dans `/admin/sms`) ;
- les **heures calmes par fuseau** (aujourd'hui UTC = Afrique/Abidjan), un modèle de message validé et la langue ;
- la **supervision** (alerte sur les envois `failed`, tableau de bord), la planification de `notifications:purge`, et l'exécution du worker en service séparé (voir `MATCHING-RUNNER.md`).

## Limites

- Une annonce **ancienne** (d'avant l'activation du besoin) ne notifie qu'après une **modification** (nouvelle version publiée) : tant qu'elle n'est pas modifiée, l'acheteur la voit dans ses résultats, sans notification. Modifier un besoin (budget relevé…)
  repousse la référence : les annonces d'avant ne sont plus nouvelles.
- Un couple qui a déjà été une correspondance confirmée **et notifiable** ne notifie plus jamais, même si l'annonce a été retirée puis remise en ligne ; une évaluation écrite pendant une pause du suivi compte, elle, comme historique
  (« l'annonce de la pause n'est jamais notifiée après coup »).
- **Une notification peut être perdue après un `dead_letter`** : le rattrapage par `matching:bootstrap` est silencieux (voir `MATCHING-OPERATIONS.md`) ; la correspondance, elle, reste **visible** dans les résultats du besoin.
- Le plafond de 20 / 50 et le résumé sont comptés par **jour UTC** ; le résumé lui-même ne déclenche pas d'envoi : ce sont les lignes d'envoi de ses annonces qui comptent dans le message externe.
- Un envoi écarté (`skipped`, motifs de revérification ou expiration à 48 h) n'est jamais repris ; une pause ou une expiration du suivi **entre la naissance et l'envoi** l'écarte (`tracking_paused`, `tracking_expired`), même si le suivi reprend ensuite.
- La livraison externe est « au moins une fois » (voir plus haut) ; la console de développement peut donc afficher deux fois la même ligne si le processus meurt entre l'appel et le COMMIT.
- Une erreur de l'étape (hors transport) compte une tentative pour **toutes les lignes arrivées à échéance** de l'utilisateur, y compris celles qui n'étaient pas dans le lot figé.
- Si l'écriture de la tentative échoue aussi (déclencheur ou base malade), les lignes de l'utilisateur ne bougent pas : la boucle se repose à l'intervalle normal du worker mais retente à chaque cycle (une ligne de journal par cycle de repos).
- « Tout marquer comme lu » compare les dates à la **milliseconde** (l'API ne publie pas les microsecondes) : une notification créée dans la même milliseconde que la plus récente affichée est marquée avec elle.
- Le test d'un vrai transport, la durée de l'appel (5 s) et les valeurs du rythme (15 min, 4 h, 3 par jour, 48 h, 20 / 50) sont des valeurs de code (`config.ts`), non réglables.
- Les pages React ne sont pas testées en unitaire : leur logique est dans `lib/client/notifications-view.ts` (testé) ; les écrans sont couverts par `e2e:ui`.
- L'étape notify lit les lignes dues par lots de 20 utilisateurs et 5 000 lignes par message ; au-delà, le message suivant continue.
