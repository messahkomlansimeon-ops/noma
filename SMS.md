# SMS réels : fournisseur Meno (lots SMS1 et SMS1-bis)

noma envoie deux sortes de SMS par le fournisseur **Meno** : le **code de connexion** (OTP) et les **notifications** de nouvelles annonces (message regroupé de N1-bis).
**Chaque SMS accepté coûte 15 F CFA : c'est de l'argent réel.** Tout ce qui suit est écrit pour qu'aucun SMS ne parte par accident, ne parte deux fois, ni ne soit invisible.

> **Le branchement est DÉSACTIVÉ par défaut.** Il ne s'active que si `NOMA_SMS_PROVIDER=meno` **et** `NOMA_SMS_API_KEY` (au format valide) sont définies, **et** (SMS1-bis) seulement si `NODE_ENV` vaut exactement `production` **ou** si `NOMA_SMS_BASE_URL` désigne ce poste (`127.0.0.1`, `localhost`, `[::1]` exacts : un faux serveur). Sans cela, rien ne part, quel que soit le reste : un environnement de développement, de recette (`staging`…) ou de test qui hérite de la vraie clé n'envoie jamais de vrai SMS.
> Aucun test, aucun essai du dépôt n'appelle Meno : tout passe par un **faux serveur local** (`tests/server/fake-meno.ts`).

## 1. Règles du fournisseur (documentation de Meno)

- Base : `https://meno.sublymus.com/api/external/sms` (surchargeable par `NOMA_SMS_BASE_URL` : les essais la pointent vers le faux serveur).
- `POST /send` : `Authorization: Bearer <clé>`, `Idempotency-Key: <8 à 64 caractères A-Za-z0-9._->`, `Content-Type: application/json`, corps `{"to":"+225XXXXXXXXXX","content":"…"}`.
- `to` : E.164 avec `+`, sans espace. **Seul +225 est ouvert au lancement** (noma refuse tout autre pays AVANT l'appel : `+225` suivi de 10 chiffres).
- `content` : **un seul segment**. Si tous les caractères sont dans l'alphabet GSM-7 : au plus **160 septets** (les caractères `^ { } \ [ ] ~ | €` et le saut de page comptent 2). Sinon le message part en UCS-2 : au plus
  **70 unités UTF-16** (un emoji vaut 2). noma refait ce calcul AVANT l'appel (`lib/server/sms/gsm7.ts`, table ETSI TS 123 038).
  Piège : **« ç » minuscule n'est pas dans la table GSM-7** (la position 0x09 est « Ç » majuscule) ; « é è à ù ì ò ä ö ñ ü » y sont, « â ê î ô û œ » non. Un texte avec « ç » ou « â » est donc limité à 70 unités.
  Les textes de noma n'ont aucun accent hors table.
- Réponses : `202 {"id","status":"accepted"}` = **accepté par l'opérateur (LeTexto), PAS une preuve de livraison** ; même clé d'idempotence = `{"id","status",replay:true}` **sans nouvel envoi** ; même clé avec un autre destinataire ou un autre texte = `409` ;
  `401` clé invalide ; `422` destinataire, pays ou contenu invalide ; `429` cadence (30 requêtes par minute) ; `502` refus explicite du fournisseur ; `503` résultat incertain ou indisponibilité.
  Si le statut vaut `unknown` ou `reserved`, **le message est peut-être parti : ne JAMAIS relancer avec une nouvelle clé** ; on garde l'identifiant pour le rapprochement.
- `GET /usage` : consommation du mois UTC (`accepted`, `uncertain`, `rejected`, `accepted_amount_xof`, `unit_price_xof`, `currency`).

## 2. Ce que fait noma

Code : `lib/server/sms/` (`gsm7.ts`, `validation.ts`, `config.ts`, `meno.ts`, `journal.ts`, `sender.ts`, `messages.ts`, `otp-transport.ts`, `notification-transport.ts`, `transports.ts`, `admin.ts`, `admin-http.ts`, `smoke.ts`),
migration `0024_sms_sends.sql`, démarrage `instrumentation.ts`, écran `/admin/sms`.

### Le chemin d'un envoi (`sender.ts`)

1. **Contrôles locaux** : pays, un seul segment, format de la clé d'idempotence. Un refus ne coûte rien et ne laisse aucune ligne.
2. **Réservation du journal AVANT l'appel** (`sms_sends`, clé d'idempotence UNIQUE) et **contrôle des budgets du jour** (section 3 bis), dans UNE transaction sérialisée par un verrou consultatif (`pg_advisory_xact_lock`) : le comptage et l'insertion ne peuvent pas s'entrecroiser, **le plafond est exact même sous forte concurrence** (essai : 80 envois simultanés sur deux pools, plafond de 5 = exactement 5 lignes et 5 SMS). Sans journal ou sans budget, **aucun appel**.
3. Selon la ligne déjà trouvée pour la même clé : `accepted`, `uncertain` ou `rejected` → le résultat connu est rendu **sans appel** ; `pending` récent → « en cours » sans appel ; `pending` de plus de 2 minutes (processus mort pendant l'appel) → `uncertain` ;
   `failed` → nouvelle tentative avec la **même** clé, mais **APRÈS un nouveau contrôle de budget** (SMS1-bis, C2) : la reprise ne contourne jamais le plafond ; refusée, la ligne reste `failed` ; acceptée, la ligne repart de la date de la reprise (le coût et le budget sont ceux du jour de l'envoi).
4. **Appel** (client `meno.ts`), puis écriture du résultat. Un statut final n'est jamais écrasé.

### Reprises (`meno.ts`)

| Situation | Décision |
|---|---|
| Erreur réseau AVANT toute réponse complète (coupure, délai de **10 s** dépassé) | reprise avec la **même clé**, **3 fois au plus**, attente croissante (0,5 s, 1 s, 2 s) ; ensuite `failed` si aucune tentative n'a pu atteindre le fournisseur (connexion refusée, nom inconnu), sinon `uncertain` |
| `429` | reprise avec la **même clé** après l'attente indiquée (`Retry-After`, 2 s par défaut), 3 fois au plus, jamais au-delà de 10 s d'attente ni du délai global ; sinon `failed` (`rate_limited`) |
| `503`, autre `5xx`, statut `unknown` ou `reserved`, 2xx au statut inattendu ou au corps illisible | **aucune reprise automatique** : `uncertain`, l'identifiant du fournisseur est gardé |
| `401`, `409`, `422`, `502`, autre refus | échec définitif (`rejected`), jamais rappelé avec la même clé |
| **Toute issue finale qui n'est pas une réponse 2xx explicite, APRÈS une tentative qui a pu atteindre le fournisseur sans réponse complète** (coupure, délai dépassé) : `429` épuisé, `401`, `409`, `422`, `502`, autre refus, délai global | **`uncertain`** (SMS1-bis, C1) : le message est peut-être parti, il n'est donc jamais enregistré `failed` ni `rejected` ; le code d'erreur et le statut HTTP de l'issue sont gardés pour le rapprochement |

Une **nouvelle clé n'est JAMAIS utilisée pour une action déjà tentée** : la clé est `otp-<identifiant du défi>` pour un code, `notif-<clé du lot figé>` pour une notification, `smoke-<horodatage>-<hasard>` pour l'essai du fondateur.

### Le code de connexion (OTP)

- Le texte : « noma : votre code est 123456. Il expire dans 5 min. Ne le partagez pas. » (la durée suit `OTP_TTL_MS`). Un seul segment GSM-7.
- **Toutes les limites existantes restent** (60 s entre deux demandes, 3 par 15 min et 10 par jour et par numéro, 20 par 15 min et 100 par jour et par adresse IP) : une demande refusée n'envoie aucun SMS.
- **Échec définitif** : réponse `503 otp_delivery_failed`, message générique « Envoi du code impossible pour le moment. » ; le défi passe à `send_failed`. Aucun détail du fournisseur.
- **Budget atteint** (SMS1-bis, B1-e) : réponse `503 otp_capacity_reached` (« Le service d'envoi de codes est très sollicité. Réessayez plus tard. »), **distincte** du « envoi impossible » ; **aucun SMS**, aucune ligne de journal, le défi passe à `send_failed`. L'écran affiche « Le service d'envoi de codes est très sollicité en ce moment. Réessayez un peu plus tard. ».
- **Résultat incertain** : le défi **reste valable** (le code est peut-être arrivé), la réponse est la réponse habituelle `202`, **aucun code n'est renvoyé automatiquement** ; l'utilisateur peut redemander un code après 60 s, dans les limites ci-dessus. Cela vaut pour **toute** issue `uncertain` (C1), y compris une coupure suivie d'un refus.
- **Délai de garde de 20 s** (SMS1-bis, S-b) : si l'expéditeur dépasse ce délai (base lente, pool saturé…), le SMS est peut-être parti ou partira : le défi **n'est pas** marqué `send_failed`, il reste vérifiable comme pour un résultat incertain (le transport réel déclare `timeoutIsUncertain`). Les transports de développement gardent l'ancien comportement (dépassement = échec).
- **Compteurs par adresse** (SMS1-bis, B1-d) : en plus de 20 demandes par 15 min et 100 par jour **par adresse**, les demandes sont agrégées **par préfixe** : `/24` en IPv4 (100 par 15 min, 500 par jour : plusieurs abonnés peuvent partager un /24, par exemple derrière la passerelle d'un opérateur), `/64` en IPv6 (20 par 15 min, 100 par jour : un /64 est un abonné), IPv6 encapsulant une IPv4 traité comme l'IPv4. Un attaquant qui change d'adresse dans son bloc ne contourne plus les compteurs. Les empreintes (HMAC signé par `NOMA_AUTH_SECRET`) vivent dans la même table que celles des adresses ; ni l'adresse ni le préfixe ne sont stockés en clair.
- Le transport console de développement est inchangé et verrouillé comme avant (`NODE_ENV=development` + `NOMA_DEV_OTP_CONSOLE=1`). `meno` et ce drapeau ensemble = **aucun transport** (configuration ambiguë, avertissement unique).

### Les notifications

- Le texte : « noma : 3 nouvelles annonces pour vos besoins. https://… /notifications » (« 1 nouvelle annonce » au singulier). Rien d'autre : ni titre, ni prix, ni numéro.
- **Toutes les règles de N1-bis restent** (fenêtre de 15 min, 4 h entre deux messages, 3 par jour, heures calmes 22 h – 7 h, lot figé, revérification) : le fournisseur n'est appelé qu'APRÈS elles. Le numéro est lu dans `phone_identities` à l'envoi.
- La clé d'idempotence est celle du **lot figé** : un échec suivi d'une nouvelle tentative (5 min, 30 min) renvoie le MÊME lot avec la MÊME clé.
- **Résultat incertain** (y compris, C1, une coupure suivie d'un refus) : jamais renvoyé ; les lignes sont comptées comme envoyées (`status='sent'`, `last_error='sms_uncertain'`) pour que le rythme de 4 h et de 3 par jour soit respecté ; l'envoi reste à rapprocher dans `/admin/sms`.
- **Budget des notifications atteint** (SMS1-bis, B1-e) : aucun SMS, aucune ligne de journal, **aucune tentative consommée** ; le lot figé est **REPORTÉ** (jamais `failed`) au lendemain 7 h UTC (`next_attempt_at`, `last_error='sms_budget'`) et repart le lendemain avec la **même clé** d'idempotence, dans la limite de l'attente maximale de 48 h de N1-bis (au-delà : `skipped`/`expired`, la notification reste dans l'application).
- **Délai de garde de 20 s dépassé** (S-b) : la tentative est comptée échouée et reprise 5 min plus tard avec la même clé ; si l'expéditeur a entre-temps terminé, son résultat est lu dans le journal (aucun second SMS) ; s'il est encore en cours, le lot est compté `uncertain`.
- Le texte « simulé en développement » des préférences est remplacé par « Un SMS regroupé vous prévient… » **uniquement quand le transport de notification est réellement disponible et réel** (SMS1-bis, M5) : clé valide, `NODE_ENV=production` ou base locale, `NOMA_PUBLIC_URL` présente, pas de configuration ambiguë. Sinon (par exemple clé valide mais pas d'URL publique), le texte reste « pas encore disponible / simulé » et aucune promesse de SMS réel n'est affichée.

## 3. Configuration

| Variable | Rôle |
|---|---|
| `NOMA_SMS_PROVIDER` | `none` (défaut ou vide), `meno`. `console` ne désigne aucun fournisseur (les consoles de développement restent commandées par `NOMA_DEV_OTP_CONSOLE` et `NOMA_DEV_NOTIFY_CONSOLE`) et est **refusé en production** |
| `NOMA_SMS_API_KEY` | clé du fournisseur — **SECRET**, lue par le serveur seulement. Format contrôlé : 16 à 256 caractères parmi `A-Za-z0-9_.~+/=:-` (le fournisseur ne documente pas de format précis : le contrôle attrape guillemets, espaces, valeur d'exemple, clé tronquée) |
| `NOMA_SMS_BASE_URL` | base de l'API (défaut : l'adresse officielle) ; **https exigé en production** |
| `NOMA_PUBLIC_URL` | origine https de l'application, sans chemin (lien des notifications) ; obligatoire avec `meno` en production ; sans elle, aucun transport de notification ; **démarrage refusé** si la notification au pire cas (99 999 annonces, lien complet) ne tient pas dans un seul segment (SMS1-bis, M2 : environ 96 caractères d'origine au plus en GSM-7) |
| `NOMA_SMS_DAILY_CAP` | plafond **total** d'envois par jour UTC, tous usages (défaut **1000 = 15 000 F CFA au plus**), exact sous concurrence ; découpé en budgets (voir 3 bis) |
| `NOMA_SMS_NOTIFICATION_SHARE_PERCENT` | part du plafond réservée aux notifications (défaut **40**, entier de 1 à 90) ; le reste est le budget des codes de connexion |
| `NOMA_SMS_EXISTING_RESERVE_PERCENT` | part du budget des codes réservée aux numéros qui ont **déjà un compte** (défaut **50**, entier de 0 à 90) |
| `NOMA_AUTH_SECRET` | déjà requis pour la connexion ; signe aussi l'empreinte des numéros du journal |

**Production : refus de démarrer** (`instrumentation.ts` pour le serveur, `scripts/matching-worker.ts` pour le worker, et la garde de la recherche) si `NOMA_SMS_PROVIDER=meno` sans clé, avec une clé de format invalide, avec une base d'API non https,
sans `NOMA_PUBLIC_URL` https (ou trop longue pour un SMS), avec une part de budget invalide ou sans `NOMA_AUTH_SECRET` valide ; si `NOMA_SMS_PROVIDER=console` ou une valeur inconnue. Les messages nomment la variable, jamais sa valeur.

**Garde-fous contre une dépense accidentelle** :
- **hors `NODE_ENV=production` exact** (`development`, absent, `staging`, `test`, `Test`, `production ` avec une espace…), le transport `meno` n'est actif que si `NOMA_SMS_BASE_URL` désigne **ce poste** (`127.0.0.1`, `localhost`, `[::1]` exacts ; `127.0.0.1.evil.example`, `127.0.0.2`, `0.0.0.0` sont refusés) : un environnement de développement, de recette ou de test lancé avec une vraie clé n'envoie rien, et l'avertissement émis ne contient jamais la clé (SMS1-bis, C4) ;
- `npm run dev:try` **retire** le fournisseur et la clé de l'environnement du serveur, sauf `NOMA_SMS_PROVIDER=meno` vers un faux serveur de ce poste (`127.0.0.1`, `localhost`, `::1`) ;
- ne **jamais** activer `meno` sur une base remplie par `demo:seed` ou `dev:seed` : leurs comptes ont des numéros fixes, de vrais SMS partiraient vers ces numéros si l'envoi externe y est activé.

La clé n'est lue que par le serveur : aucun fichier du navigateur ne la nomme ni n'importe `lib/server/sms/` (vérifié par `tests/server/sms-config.test.ts`) ; aucune variable `NEXT_PUBLIC_*` n'existe pour le SMS.

### Le build de production ne voit AUCUN secret (SMS1-bis, C3)

**Constat de l'audit** : après un `next build` lancé avec la clé dans l'environnement, la clé Meno **et** `NOMA_AUTH_SECRET` se retrouvaient **en clair** dans `.next/cache/turbopack/*.sst` (droits `0644`, lisibles par tout compte du serveur). Turbopack garde dans son cache les variables d'environnement lues pendant le build.
**Règle** : la clé est lue **à l'exécution seulement** (`process.env`, accès non littéral : jamais inlinée par le bundler, vérifié par `tests/server/sms-build.test.ts`) ; elle ne doit donc **jamais** être présente pendant le build.
**Outil** : `npm run build:production` (`scripts/build-production.sh`), à utiliser À LA PLACE de `npm run build` sur le serveur (voir `DEPLOIEMENT.md`) :
1. `umask 077`, puis `chmod go-rwx` de `.next` à la fin (l'outil de build crée certains fichiers en `0664` malgré l'umask : constaté, 1 496 fichiers) : tout ce que le build produit est privé ;
2. le build tourne dans un environnement **vidé** (`env -i`) où ne passent que le strict nécessaire (PATH, HOME, langue, dossier temporaire, proxys, certificats) et les variables `NEXT_PUBLIC_*` (publiques par nature, comme la clé publique Turnstile, à inliner) : `NOMA_SMS_API_KEY`, `NOMA_AUTH_SECRET`, `NOMA_IP_SECRET`, `NOMA_PROXY_SECRET`, `NOMA_TURNSTILE_SECRET`, `DATABASE_URL` et tout futur secret **ne sont jamais transmis**, même exportés par l'appelant ;
3. `.next/cache` est supprimé après le build ;
4. contrôle final : si l'appelant avait exporté des valeurs secrètes (noms connus, ou tout nom contenant `SECRET`, `KEY`, `TOKEN`, `PASSWORD`, `PASSWD`, `CREDENTIAL`), aucune ne doit figurer dans `.next` ; sinon le build est **effacé** et le script échoue.
Si un build a déjà été fait avec la clé dans l'environnement (par exemple avant ce lot) : supprimez `.next`, rebuild avec `npm run build:production`, et considérez la clé comme exposée aux comptes de la machine (rotation à envisager).

## 3 bis. Budgets, coût maximal et abus (SMS1-bis)

**Constat de l'audit** (B1) : un plafond quotidien unique était un levier de déni de service — 13 adresses épuisaient les 1000 SMS du jour (15 000 F) en 57 minutes, puis plus aucune connexion ni notification n'était possible jusqu'à minuit UTC.
**Correction** : `NOMA_SMS_DAILY_CAP` reste le plafond **total**, découpé en budgets **séparés** (jour UTC), décidés dans la même transaction que l'insertion du journal (`lib/server/sms/budget.ts` et `journal.ts`) :

| Budget (défauts, plafond 1000) | Valeur | Qui peut le consommer |
|---|---|---|
| Notifications (40 %) | 400 par jour | notifications seulement |
| Codes de connexion (60 %) | 600 par jour | codes seulement |
| dont réserve des numéros qui ont déjà un compte (50 % des codes) | 300 | numéros **existants** seulement |
| dont part des numéros inconnus | 300 par jour | numéros **inconnus** (et numéros dont l'existence n'a pas pu être établie) |
| Lissage horaire des numéros inconnus : (300 / 24) × 3 | **38 par heure glissante** | numéros inconnus |
| Essai du fondateur (`sms:smoke`) | compté dans le total seulement | fondateur |

- Un épuisement des codes ne touche jamais les notifications, et inversement. Les numéros existants peuvent utiliser **tout** le budget des codes (réserve comprise), jamais limités par la part des inconnus ni par l'heure.
- « Numéro existant » = un compte actif porte ce numéro vérifié (`phone_identities`), lu **avant** l'envoi ; une erreur de lecture classe le numéro « inconnu » (la réserve n'est jamais ouverte par erreur).
- Seuls les envois `pending`, `accepted` et `uncertain` consomment un budget (`failed` et `rejected` n'ont rien coûté).
- Un refus pour budget **n'écrit aucune ligne** (une rafale d'attaque ne remplit pas le journal) : sa trace est la ligne du journal du serveur `[sms] otp failed vers +***********12, … code budget_new_numbers`, et la consommation du jour affichée dans `/admin/sms` (« Budgets du jour »). Codes stables : `budget_total`, `budget_codes`, `budget_new_numbers`, `budget_new_numbers_hour`, `budget_notifications`.
- Réponse au visiteur : `503 otp_capacity_reached` (voir section 2), jamais le chiffre du budget. **Limite assumée** : pendant une saturation de la part des inconnus, un numéro neuf est refusé alors qu'un numéro existant reçoit son code ; la différence de réponse révèle donc, **pendant la saturation seulement**, si un numéro a un compte (énumération de comptes). Elle n'existe pas hors saturation.

**Coût maximal pour un attaquant après correction** (plafond 1000, parts par défaut, 15 F par SMS accepté ; l'attaquant utilise des numéros neufs et autant d'adresses qu'il veut, y compris dans des /24 différents) :

| Cible | Par heure glissante | Par jour UTC | Ce qui reste disponible pendant l'attaque |
|---|---|---|---|
| Codes vers des numéros inconnus | **38 SMS = 570 F** | **300 SMS = 4 500 F** | connexion des utilisateurs existants (réserve de 300), notifications (400) |
| Codes vers des numéros existants (l'attaquant doit contrôler des comptes vérifiés : au plus 10 codes par numéro et par jour, 3 par 15 min) | borné par le budget des codes (600) | 600 SMS = 9 000 F au pire, avec 60 comptes complices | notifications (400) |
| Notifications | pas de levier direct : un SMS par lot figé, 4 h entre deux messages et 3 par jour par utilisateur, uniquement pour des annonces correspondant à un besoin actif | 400 SMS = 6 000 F | codes (600) |
| **Tout confondu** | | **1000 SMS = 15 000 F** (plafond total) | |

**Mesuré** (probes A1–A3 de l'audit rejoués contre le code corrigé, plafond 1000, voir `/tmp/noma-sms1bis-probe-*.out`) : même numéro, même adresse, 24 h : **10 SMS** (150 F) ; une adresse, numéros neufs, 24 h : **38 SMS la première heure, 58 en 24 h** (870 F, les quotas par adresse sont épuisés) ; 13 adresses de 13 /24 différents au rythme maximal : **76 SMS** (1 140 F, 38 par heure, puis les quotas par adresse sont épuisés) ; 13 adresses cadencées à 40 demandes par heure : **300 SMS** (4 500 F) en 8 heures, jamais plus de 38 par heure ; ensuite les 3 utilisateurs existants reçoivent leur code (202), un numéro neuf est refusé (503 `otp_capacity_reached`) et une notification part.

Avant la correction : 1000 SMS (15 000 F) en **57 minutes** avec 13 adresses, puis plus aucune connexion ni notification jusqu'à minuit. Après : au plus 38 SMS en une heure pour des numéros inconnus, **sans aucun effet** sur la connexion des utilisateurs existants ni sur les notifications. Vérifié par `tests/postgres/sms-budget.integration.test.ts` (rafale de numéros neufs depuis des adresses toutes différentes, puis connexion d'utilisateurs existants et notification).

**Ce que le plafond ne fait pas** : il ne dispense **pas** d'une protection contre les robots. Le plafond limite la perte, il n'empêche pas l'attaque : pendant la saturation de la part des inconnus, les inscriptions de vrais nouveaux utilisateurs sont refusées (jusqu'à 300 inscriptions par jour restent possibles, 38 par heure). **Mesure suivante avant l'ouverture publique : Cloudflare Turnstile sur `/api/auth/otp`** (le code de vérification existe déjà pour la recherche : `deploy/verify-turnstile.ts`). Elle n'est **pas** branchée dans ce lot, volontairement.

## 4. Ce qui est journalisé

**Table `sms_sends`** (une ligne par action métier) : finalité (`otp`, `notification`, `smoke`), référence métier (identifiant du défi, clé du lot), clé d'idempotence (UNIQUE), identifiant du fournisseur, statut (`pending`, `accepted`, `uncertain`, `rejected`, `failed`),
code HTTP, code d'erreur stable, nombre de requêtes, **empreinte du numéro** (HMAC-SHA-256 signé par `NOMA_AUTH_SECRET`), **deux derniers chiffres**, classe du numéro pour un code (`audience` : `existing` ou `new`), dates.
**Jamais** le texte (il contient le code), **jamais** le numéro en clair, **jamais** la clé du fournisseur.

**Limite connue (M4)** : `sms_sends.reference` d'un code de connexion est l'identifiant du défi (`otp_challenges.id`), et `otp_challenges.phone_e164` porte le numéro en clair (table d'authentification existante, purgée avec les défis). Quiconque peut lire **les deux tables** peut donc relier une ligne du journal SMS à un numéro entier. Le journal SMS seul ne permet pas de retrouver le numéro (empreinte signée + deux chiffres) ; les droits de lecture sur la base de production doivent traiter les deux tables comme un seul ensemble sensible. Aucun changement de schéma n'est fait dans ce lot.

**Journal du serveur** (une ligne par envoi, refus pour budget compris) : `[sms] otp accepted vers +***********12, http 202, 1 requête(s), code -`. Jamais la clé, le texte, le numéro entier, ni la clé d'idempotence.

## 5. Les envois incertains : rapprochement

Un envoi est **incertain** quand le fournisseur n'a pas pu dire si le SMS est parti (503, `unknown`, `reserved`, coupure après l'envoi) ou quand le processus est mort pendant l'appel. Il n'est **jamais** renvoyé automatiquement.

1. Ouvrez **Administration → SMS** (`/admin/sms`) : la consommation du mois lue chez Meno (`GET /usage`, appelée côté serveur, **cache de 60 s**), le décompte local du journal, les **budgets du jour** (consommation par rapport au plan : total, codes, numéros inconnus et leur heure glissante, notifications), la liste des envois incertains
   (date, finalité, deux derniers chiffres du numéro, code HTTP, code d'erreur, **identifiant du fournisseur**) et celle des envois **échoués** des dernières 24 h (rien n'est parti ; SMS1-bis, C1). Aucun bouton de renvoi.
2. Pour chaque ligne, cherchez l'identifiant dans le tableau de bord de Meno (ou demandez-le au support) : accepté / refusé / inconnu.
3. Sans identifiant (envoi interrompu), comparez l'heure et les deux derniers chiffres du numéro avec l'historique de Meno.
4. Si le SMS n'est pas parti et que l'utilisateur attend un code, il peut simplement redemander un code (nouvelle clé, nouveau défi) ; un code non reçu ne se « renvoie » pas.
5. Un écart durable entre `accepted` de Meno et le journal local doit être investigué (consommation inattendue = signal d'abus : réduire `NOMA_SMS_DAILY_CAP`, ou la part des inconnus par `NOMA_SMS_EXISTING_RESERVE_PERCENT`).

## 6. Mise en service pas à pas (fondateur)

Rien de ce qui suit n'est fait par le dépôt. Le premier envoi réel est l'**essai de la section 6.5**, avec votre accord.

0. **Build sans secret** : construisez avec `npm run build:production` (voir la section 3 et `DEPLOIEMENT.md`), jamais avec `npm run build` après avoir chargé le fichier d'environnement.
1. **Sauvegarde puis migration** : sauvegardez la base PostgreSQL (`pg_dump`), puis appliquez la migration 0024 avec les autres (`npm run db:migrate`, sur la base de production). Elle ne modifie aucune table existante ; elle crée `sms_sends` (colonne `audience` comprise).
2. **Mettre la clé dans le fichier d'environnement DU SERVEUR**, celui que lit systemd (`EnvironmentFile=/opt/noma/shared/.env.production` dans `deploy/noma.service`), propriétaire = l'utilisateur de service, droits 600.
   **Jamais dans Git, jamais dans un message, une capture d'écran ou un ticket.** Ajoutez ces lignes (la clé vient de votre compte Meno) :
   ```
   NOMA_SMS_PROVIDER=meno
   NOMA_SMS_API_KEY=<la clé fournie par Meno>
   NOMA_PUBLIC_URL=https://<votre-domaine>
   ```
   (`NOMA_SMS_BASE_URL` reste vide : l'adresse officielle est utilisée ; `NOMA_SMS_DAILY_CAP` aussi : 1000 par jour, découpé 40 % notifications / 60 % codes dont la moitié réservée aux numéros existants. **`NODE_ENV=production` doit figurer dans le même fichier** — il y est déjà dans le modèle `deploy/env.production.example` — sinon le transport reste inactif.) Le worker du matching (`npm run matching:worker`) doit lire le **même** fichier : c'est lui qui envoie les notifications.
3. **Redémarrer** le serveur et le worker. S'ils refusent de démarrer, le processus se termine (code 1) après avoir journalisé quelle variable est en cause (jamais sa valeur) : corrigez le fichier, relancez.
4. **Vérifier sans envoyer** : ouvrez `/admin/sms` (compte administrateur) : « Fournisseur Meno : actif » et la consommation du mois s'affichent.
5. **L'essai réel, vers VOTRE numéro** (coûte **15 F**). En tant que l'utilisateur de service, depuis le dossier de l'application, après avoir chargé le même fichier d'environnement :
   ```
   set -a; . /opt/noma/shared/.env.production; set +a
   npm run sms:smoke -- --to +225XXXXXXXXXX --confirm-real-send
   ```
   La commande refuse de s'exécuter sans **les deux** options, sans clé, sans `DATABASE_URL`, hors `NODE_ENV=production` (le fichier d'environnement le fixe) ou avec `NODE_ENV=test`. Elle affiche le résultat (`accepted` attendu, code 0) sans jamais afficher la clé ni le numéro entier.
   « accepté » ne prouve pas la livraison : **vérifiez la réception sur le téléphone**. Si le résultat est `uncertain`, **ne relancez pas** : voir la section 5.
6. **Essai de connexion** : connectez-vous avec votre numéro sur le site (un SMS de plus, 15 F), vérifiez le texte et que le code fonctionne ; puis `/admin/sms` : la consommation a augmenté de 2.
7. **Retour arrière immédiat** : videz `NOMA_SMS_PROVIDER` dans le fichier d'environnement et redémarrez. Plus aucun SMS ne part (la connexion par code devient indisponible, comme avant ce lot).

## 7. Tests

Aucun ne touche Meno : le **faux serveur** (`tests/server/fake-meno.ts`) applique les règles documentées (202, rejeu avec `replay`, 409, 401, 422, 429 avec `Retry-After`, 502, 503, `unknown`, `reserved`, coupure avant réponse, silence).

```
npm run test:sms            # segments GSM-7/UCS-2, pays, clé, configuration, garde NODE_ENV, budgets, préfixes d'adresses, script de build sans secret, démarrage refusé, smoke, résolveurs, la clé reste côté serveur
npm run test:sms-postgres   # journal, envois, budgets séparés et réserve, lissage horaire, plafond exact sous concurrence, reprise, incertains, OTP et notifications de bout en bout, administration (non-admin : même 404)
npm run test:sms-client     # écran d'administration
npm run test:dev-try-sms    # dev:try ne transmet jamais de vrai fournisseur
```

Essai navigateur (`e2e:core`, `e2e:ui`, `e2e:demo`) avec le faux serveur : `scripts/e2e-fake-meno.ts` est lancé avant `dev:try`, avec `NOMA_SMS_PROVIDER=meno`, une clé d'essai (`fake_meno_key_for_tests_only_…`) et `NOMA_SMS_BASE_URL` vers lui ;
`NOMA_E2E_MENO_CAPTURE` désigne le fichier où il écrit les SMS acceptés, lu à la place de la console pour les codes de connexion.

## 8. Limites et points à confirmer avec Meno

- **Accepté ≠ livré** : aucun accusé de réception n'est lu ; seule la consommation (`/usage`) et le journal permettent un rapprochement.
- La documentation donnée ne précise ni le **format de la clé** (contrôle volontairement lâche), ni la forme exacte de `GET /usage` (champs lus à la racine ou sous `usage`/`data`, en liste blanche), ni l'en-tête d'attente du `429` (`Retry-After` en secondes ou en date, ou `retry_after` dans le corps) :
  à confirmer au premier essai (`/admin/sms` affiche « Consommation indisponible » avec un code stable si la forme diffère).
- Ajouts non demandés par le fournisseur : les **budgets du jour** (`NOMA_SMS_DAILY_CAP` et ses parts) et l'écran `/admin/sms` lisent le journal local ; les budgets sont **exacts** sous concurrence (verrou consultatif), mais ils comptent ce que NOUS avons envoyé : un écart avec la consommation lue chez Meno (`/usage`) reste à investiguer.
- `sms_sends` n'a pas encore de purge (une ligne par SMS) ; à planifier avec `notifications:purge` si le volume devient important.
- Les adresses IP et numéros sont limités par les compteurs d'OTP (par adresse, par préfixe et par numéro) ; un attaquant disposant de nombreuses adresses et de nombreux numéros +225 est borné par les budgets (tableau de la section 3 bis), pas arrêté : **Turnstile sur `/api/auth/otp` est la mesure suivante avant l'ouverture publique**.
- Un refus de code pour budget consomme les quotas de demande du numéro (3 par 15 min) : un utilisateur légitime refusé pendant une saturation peut devoir attendre.
- Un « refus de démarrer » en production (clé absente avec `meno`, etc.) **termine le processus avec le code 1** (correctif transversal du lot de reprise PAY1 : `register()` journalise le message fixe — la variable en cause, jamais sa valeur — puis appelle `process.exit(1)`, voir `instrumentation.ts`, `lib/server/startup-guard.ts` et la section « Démarrage refusé » de `DEPLOIEMENT.md`). Auparavant (SMS1 et SMS1-bis) l'exception faisait échouer le hook de démarrage de Next mais le processus `next start` **restait vivant** et répondait **500 à tout** (constaté sur un build de production). Avec `deploy/noma.service` (`Restart=on-failure`, `RestartSec=5`), un fichier d'environnement invalide donne maintenant une boucle de redémarrage visible (`journalctl -u noma`) au lieu d'un processus « actif » muet. Preuve exécutée : vrai `next build` (`npm run build:production`) puis `next start`, configuration invalide : processus terminé, code non nul ; configuration valide : démarrage.
- Un numéro ivoirien à 8 chiffres (ancien format) est refusé : seul `+225` suivi de 10 chiffres part.
- Un envoi OTP attend au plus 12 s (délai global) et jusqu'à 20 s avant que la demande ne soit abandonnée ; une panne du fournisseur ralentit donc la connexion de ce délai avant le message générique.
- Pendant l'appel d'une notification, la transaction de l'utilisateur et son verrou restent ouverts (jusqu'à 12 s) : une panne longue du fournisseur ralentit le cycle du worker (20 utilisateurs par cycle).
