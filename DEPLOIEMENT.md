# Déploiement — Recherche publique Noma (bêta)

Ce document couvre le serveur local, les variables, Chromium, SQLite, HTTPS,
le reverse proxy et le diagnostic. **La publication reste bloquée** tant que
serveur, domaine, clés Turnstile et configuration de production ne sont pas
fournis et vérifiés.

## Architecture

- **Serveur Node unique** : Next.js (runtime Node pour `/api/search`),
  moteur de recherche dans `poc/lib/engine.ts` importé **exclusivement côté
  serveur** (adaptateur `lib/server/search-stream.ts`, marqué `server-only`).
  Aucune clé ni dépendance serveur (Playwright…) dans le bundle navigateur.
- **Chromium** : Playwright 1.63 installé dans `poc/node_modules`
  (paquet externe côté serveur, jamais bundle). Binaire : `CHROME_PATH`
  (défaut `/usr/bin/google-chrome-stable`). Limite globale : **2 navigateurs
  simultanés** toutes recherches confondues, 3 téléchargements.
- **SQLite persistant** (`node:sqlite`) : `NOMA_DB_PATH`
  (défaut `./data/noma-guard.sqlite`, hors git). Contient : quotas
  session/IP, réservations de budget, dépenses (ledger), recherches actives.
  **Les réserves non résolues survivent au redémarrage** (facturation
  incertaine ou processus interrompu). Montants en **microdollars**.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `NOMA_DB_PATH` | `./data/noma-guard.sqlite` | SQLite persistant des protections |
| `NOMA_DAILY_BUDGET_USD` | `1` | Budget quotidien **prévisionnel** IA (pas un plafond fournisseur garanti) |
| `NOMA_SEARCH_RESERVE_USD` | `0.05` | Réservation **prévisionnelle** par recherche IA |
| `NOMA_SEARCH_DISABLED` | — | `1` = interrupteur « recherches désactivées » (503) |
| `NOMA_AI_DISABLED` | — | `1` = interrupteur « IA désactivée » (secours web seul, aucune dépense) |
| `NOMA_TURNSTILE_SECRET` | — | Secret siteverify — **requis en production** (démarrage refusé sinon) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | — | Clé publique du widget (côté navigateur) — configurée, le widget est rendu dans le formulaire et le jeton est exigé par le bouton |
| `NOMA_TURNSTILE_ACTION` | `search` | Action attendue du widget (validée côté serveur) |
| `NOMA_TURNSTILE_HOSTNAMES` | `localhost` | Domaines attendus (siteverify + origine des requêtes) |
| `NOMA_TURNSTILE_DISABLED` | — | `1` = contournement **hors production uniquement** (dev/tests) |
| `NOMA_PROXY_SECRET` | — | Secret partagé avec LE reverse proxy : transmis via l'en-tête `x-noma-proxy-secret`, il autorise la lecture de `X-Forwarded-For` |
| `NOMA_TRUSTED_PROXIES` | — | IP de connexion du proxy de confiance (alternative au secret) |
| `NOMA_IP_SECRET` | — | Secret HMAC de pseudonymisation IP — **requis en production** |
| `NOMA_BUDGET_TZ` | `Africa/Abidjan` | Fuseau du budget quotidien |
| `NOMA_FAKE_SOURCES` | — | `1` = sources simulées **sans IA ni dépense** (validation locale uniquement, refusé si production) |
| `NOMA_SMS_PROVIDER`, `NOMA_SMS_API_KEY`, `NOMA_SMS_BASE_URL`, `NOMA_PUBLIC_URL`, `NOMA_SMS_DAILY_CAP`, `NOMA_SMS_NOTIFICATION_SHARE_PERCENT`, `NOMA_SMS_EXISTING_RESERVE_PERCENT` | vides | SMS réels par Meno (lots SMS1 et SMS1-bis) : **désactivés par défaut**, 15 F CFA par SMS accepté ; actifs seulement avec `NODE_ENV=production` (ou vers un faux serveur local) ; avec `meno` en production le démarrage est **refusé** sans clé valide, sans base https, sans URL publique (assez courte pour tenir en un SMS) ou avec une part de budget invalide. La clé **n'est jamais présente au build** (`npm run build:production`). Voir `SMS.md` |
| `NOMA_PAYMENT_PROVIDER`, `WAVE_API_KEY`, `NOMA_SUBLYMUS_MANAGER_ID`, `NOMA_SUBLYMUS_WALLET_ID`, `SUBLYMUS_WEBHOOK_SECRET`, `NOMA_SUBLYMUS_BASE_URL` (et `NOMA_PUBLIC_URL`, https) | vides | Paiement des recharges par Wave via Sublymus (lot PAY1) : **argent réel**. Sans `NOMA_PAYMENT_PROVIDER=sublymus`, aucune recharge en production (le prestataire fictif y est refusé). Avec `sublymus`, le démarrage est **refusé** (le processus se termine, code 78) si une variable manque ou est mal formée. Les clés **ne sont jamais présentes au build** (`npm run build:production`). Voir `PAIEMENT-WAVE.md` |
| `OPENROUTER_API_KEY` | — | Clé IA (lue depuis `poc/.env.local` par le moteur) |
| `GOOGLE_API_KEY`, `GOOGLE_CX` | — | Google CSE (source « google » du moteur) |
| `CHROME_PATH` | `/usr/bin/google-chrome-stable` | Binaire Chromium pour Playwright |

Clés API et secrets : **jamais côté navigateur**, jamais journalisés.

### Démarrage refusé : le processus se TERMINE (SMS et paiement)

Au démarrage, `register()` (`instrumentation.ts`, voir `lib/server/startup-guard.ts`) contrôle dans cet ordre la configuration **SMS** (lot SMS1) puis celle du **paiement** (lot PAY1). En
`NODE_ENV=production`, si l'un des contrôles refuse :

1. le message FIXE du contrôle est journalisé sur la sortie d'erreur (`Démarrage refusé : configuration SMS invalide en production : …` ou `… paiement …`) : il nomme les variables à corriger, **jamais
   leurs valeurs** ;
2. le processus est **terminé avec le code 78** (`process.exit(78)`, EX_CONFIG de sysexits.h : code DÉDIÉ au refus de démarrer, constante `STARTUP_REFUSED_EXIT_CODE` de `lib/server/startup-guard.ts`).

Pourquoi : sous `next start`, une exception levée par `register()` laissait auparavant le processus **vivant**, qui répondait alors **500 à tout** (constat d'audit, commun SMS et paiement) : la
supervision voyait un processus « actif » qui ne servait rien. Il tombe désormais, et `systemd` le voit tomber. Lot SMS1-ter : `deploy/noma.service` porte **`RestartPreventExitStatus=78`** (le refus de démarrer sort avec le code dédié 78) : un fichier
d'environnement invalide **ne produit plus de boucle de redémarrage** ; le service reste à l'état `failed` (aucune requête n'est servie) et c'est `systemctl status noma` / `journalctl -u noma -n 20` qui dit
pourquoi. Corrigez `/opt/noma/shared/.env.production`, puis `systemctl restart noma`. Les **autres pannes** (signal, mémoire, exception non rattrapée de Node qui sort avec le code 1, tout code de sortie différent de 78) gardent `Restart=on-failure` et `RestartSec=5`,
bornés par `StartLimitIntervalSec=300` et `StartLimitBurst=5` (section `[Unit]`) : au plus 5 démarrages en 5 minutes, puis systemd renonce (`systemctl reset-failed noma` avant de relancer).
Une exception non rattrapée (code 1) reste donc relancée, dans la limite de `StartLimit*` ; `deploy/selftest.sh` contrôle ces lignes de l'unité. Hors production, l'exception est relancée telle quelle (affichée par `next dev`). Le worker du matching applique les mêmes règles
(`scripts/matching-worker.ts` : refus de démarrer SMS ou paiement, même code de sortie 78). Vérifié par un vrai `next build` suivi de `next start` : configuration invalide, processus terminé avec un code non nul ;
configuration valide, démarrage normal (`SMS.md`, `PAIEMENT-WAVE.md`).

## Préproduction privée (lot 3) — artifacts `deploy/`

| Fichier | Rôle | Statut |
|---|---|---|
| `deploy/env.production.example` | Modèle d'environnement production (aucune valeur réelle) | Versionné |
| `deploy/gen-secrets.sh` | Génère `NOMA_IP_SECRET`/`NOMA_PROXY_SECRET` SUR LE SERVEUR (chmod 600, jamais affichées). Sur le serveur : `sudo deploy/gen-secrets.sh /opt/noma/shared/.env.production noma` — le fichier est TRANSFÉRÉ à l'utilisateur de service (lisible au build et par systemd, jamais « tous ») ; **root sans propriétaire → refus par construction** ; LE MÊME fichier est lu par systemd (`EnvironmentFile`) et sourcé avant le build (clé publique Turnstile inline). **Remplacement atomique** : propriétaire validé AVANT toute modification, contenu préparé via `mktemp` (privé dès la création, `umask 077`) dans le même répertoire, original remplacé UNIQUEMENT après succès complet. Codes de lecture : seul `grep` 0/1 est accepté — **une erreur de lecture interrompt SANS remplacement** (l'original et ses autres clés sont préservés). | Testé (création, régénération avec préservation des autres clés, chemin personnalisé, propriétaire, échecs sans destruction de l'original, lecture impossible sans remplacement, temporaire privé sous umask 000, garde root) |
| `deploy/nginx-noma.conf` | TLS, liste allow/deny des testeurs (y compris `/api/search`), `proxy_buffering off`, `gzip off`, `proxy_read_timeout 200s` | Préfiguré (simulation locale) |
| `deploy/noma.service` | Service systemd instance unique, secrets via `EnvironmentFile`, **écoute forcée sur 127.0.0.1** (`npm run start -- --hostname 127.0.0.1`) — le port Node n'est jamais public, seul nginx expose l'app ; `Restart=on-failure` + `RestartPreventExitStatus=78` (pas de boucle sur un refus de démarrer, code dédié ; une exception non rattrapée, code 1, est relancée) + `StartLimitIntervalSec=300` / `StartLimitBurst=5` (lot SMS1-ter) | **Écoute vérifiée localement** (`ss` : `127.0.0.1:3000` seul) |
| `deploy/backup.sh` | Sauvegarde SQLite cohérente (`VACUUM INTO`) sans arrêt de l'app. **Garde-fous** : source inexistante → exit 1 (aucune base vide créée) ; base illisible/non SQLite → exit 1 ; sauvegarde sans les 4 tables de protection → fichier SUPPRIMÉ + exit 1 | **Exécuté** : nominal ✔ + 3 modes d'échec rejetés (source absente, non-SQLite, SQLite valide sans tables) |
| `deploy/restore-check.sh` | Restaure la sauvegarde sur une COPIE ; exige intégrité `ok` ET les 4 tables de protection — une sauvegarde incomplète est rejetée (exit 1, copie supprimée) | **Exécuté** : nominal ✔ + 2 modes d'échec rejetés |
| `deploy/verify-turnstile.ts` | Vérification siteverify ISOLÉE (ni moteur, ni Chromium, ni IA, ni `/api/search`) | Exécuté hors ligne (usage + refus jeton factice) ; appel avec secret réel en préproduction |
| `deploy/selftest.sh` | **Tests négatifs + nominaux** des scripts deploy/ (hors ligne, base temporaire, **SANS sudo** — le scénario « cible non inscriptible » est racine-compatible via `/proc`) : port 127.0.0.1 forcé, sauvegarde jamais déclarée valide si vide, restauration rejetée sans tables, secrets jamais committés/affichés, garde root sans propriétaire déclenché, **échec de régénération sans destruction de l'original** (contenu/permissions inchangés), **lecture impossible → exit 1 sans remplacement**, **préservation des autres clés**, **temporaire privé dès la création** (umask 077 + mktemp, vérifié sous umask 000). Échec = exit 1. À rejouer après chaque modification de deploy/ ET sur le serveur avant installation | **Exécuté : 39/39 verts** (2 exécutions consécutives, mode non root) |

**Séquence d'installation sur le serveur** (fichier unique appartenant à
l'utilisateur de service, lu par systemd et sourcé au build) :

```sh
# 0. tests négatifs SANS sudo — aucun privilège requis (écrit uniquement
#    dans /tmp ; le scénario « cible non inscriptible » est racine-compatible)
deploy/selftest.sh          # exit 1 = installation stoppée
# 1. secrets générés avec sudo, PROPRIÉTÉ transmise à l'utilisateur de
#    service (root sans propriétaire → refus par construction) :
sudo deploy/gen-secrets.sh /opt/noma/shared/.env.production noma
# 2. clé publique Turnstile (non secrète) ajoutée PAR L'UTILISATEUR DE
#    SERVICE — le fichier lui appartient (600) : pas besoin de root
sudo -u noma sh -c 'echo "NEXT_PUBLIC_TURNSTILE_SITE_KEY=<clé-publique>" >> /opt/noma/shared/.env.production'
# 3. build exécuté PAR L'UTILISATEUR DE SERVICE, fichier lisible (600,
#    propriétaire noma) — jamais 644, les secrets restent privés.
#    TOUJOURS par `npm run build:production` (lot SMS1-bis) et JAMAIS par
#    `npm run build` / `next build` directement : le fichier est sourcé pour que
#    la clé publique Turnstile (NEXT_PUBLIC_*) soit inlinée, mais le script
#    RETIRE du build tous les secrets (NOMA_SMS_API_KEY, NOMA_AUTH_SECRET, …
#    liste blanche `env -i`), travaille sous umask 077 puis rend .next privé, supprime .next/cache
#    et ÉCHOUE (en effaçant .next) si une valeur secrète se retrouve dans .next (lot SMS1-ter : y compris
#    les valeurs secrètes de poc/.env.local s'il existe). Il REFUSE aussi de construire si un fichier
#    .env* (hors .env.example) est présent à la racine du dépôt : Next le lirait lui-même.
#    Raison : Turbopack gardait la clé Meno et NOMA_AUTH_SECRET EN CLAIR dans
#    .next/cache/turbopack/*.sst (droits 0644) quand le build voyait ces variables.
sudo -u noma sh -c 'set -a; . /opt/noma/shared/.env.production; set +a; npm run build:production'
#    → noter le BUILD_ID produit (retour arrière) ; vérifier la clé inline :
#      grep -rl "<clé-publique>" .next/static | head -1
#    → vérifier qu'aucun secret n'est dans le build (doit ne rien afficher ;
#      la clé n'est lue qu'à l'EXÉCUTION, par le serveur) :
#      grep -rlF "$(sudo -u noma sh -c '. /opt/noma/shared/.env.production; printf %s "$NOMA_SMS_API_KEY"')" .next || true
# 3b. APPLIQUER LES MIGRATIONS DE LA BASE (`npm run db:migrate`) AVANT de démarrer — ou de redémarrer — la nouvelle version, jamais après.
#    La nouvelle version lit des tables, des colonnes et des index que les migrations ajoutent (par exemple `0027_missions` : table des missions, quantité des commandes,
#    notifications de couverture) : démarrée sur une base pas encore migrée, elle répond en erreur sur les écrans qui les lisent (accueil acheteur, « Mes besoins », commandes,
#    comptes de besoins du vendeur). Sauvegarde `pg_dump` de la base d'abord ; la commande n'applique que les migrations manquantes (une migration déjà appliquée n'est jamais
#    rejouée) et affiche « N appliquée(s), M déjà présente(s) » ; la base doit pointer sur le serveur PostgreSQL de production (variable `DATABASE_URL` du fichier d'environnement).
sudo -u noma sh -c 'set -a; . /opt/noma/shared/.env.production; set +a; npm run db:migrate'
#    → vérifier que la dernière migration affichée est celle de la version déployée (`0027_missions` pour les missions d'achat en volume) AVANT l'étape 4.
# 4. instance unique liée à 127.0.0.1 (deploy/noma.service)
#    vérification post-démarrage : ss -tlnp | grep 3000  → 127.0.0.1 uniquement
```

Séquence vérifiée localement en mode utilisateur (le mode du build) :
fichier généré puis **propriété transmise** (600, propriétaire = utilisateur
de build), clé publique ajoutée par le propriétaire sans root, build sourcé
réussi, clé publique **inline dans le bundle client** (`.next/static/chunks/…`)
— sim. `LGgJKqEprBwa0ok8rNSwB`. Les gardes du mode root sont vérifiés par
`deploy/selftest.sh` (refus « root sans propriétaire » déclenché, cible
`/proc` rejetée même en root) ; la séquence `sudo` réelle reste à rejouer
sur le serveur (§ BETA-CHECKLIST 4).

Simulation locale exécutée (2 oct. 2026, build `next start` + nginx TLS
auto-signé, IP de testeur simulée) : HTTPS 200 · IP non autorisée 403 ·
`/api/search` → `503 searches_disabled` (recherches gardées désactivées
jusqu'au lot 4) · aucun `Set-Cookie` avant admission · aucune compression
sur `/api/search` · Next lié à `127.0.0.1` uniquement (aucun port public) ·
réserve non résolue insérée puis **conservée après redémarrage de l'app** ·
requêtes de diagnostic exécutées telles quelles.

**Non vérifié localement (différé, jamais présenté comme réussi)** :
Turnstile réel sur le domaine (secret + widget réels) ; cookie `Secure`
observé via l'app (nécessite une admission réussie, donc des recherches
activées — commandes prêtes ci-dessous) ; honneur de `X-Forwarded-For`
derrière le vrai proxy ; flux NDJSON avec sources réelles (accord du lot 4).

```sh
# préproduction : vérifications une fois les recherches activées (accord requis)
curl -skD - -o /dev/null -X POST https://<domaine>/api/search \
  -H 'content-type: application/json' \
  -d '{"text":"<besoin>","mode":"achat"}' | grep -i set-cookie   # attendu : Secure, HttpOnly
# Turnstile isolé (jeton produit par le vrai widget sur le domaine) :
NOMA_TURNSTILE_SECRET=<secret> NOMA_TURNSTILE_HOSTNAMES=<domaine> \
  poc/node_modules/.bin/tsx deploy/verify-turnstile.ts "<jeton>" search
```

## HTTPS et reverse proxy

- **HTTPS obligatoire en production** : le cookie de session `noma_sid`
  (HttpOnly, SameSite=Lax, 1 an) est posé `Secure` quand
  `NODE_ENV=production`.
- Le proxy doit transmettre `x-noma-proxy-secret: $NOMA_PROXY_SECRET` et
  `X-Forwarded-For: $remote_addr`. Sans ce secret, les en-têtes IP sont
  ignorés (tous les clients partagent alors un bucket de quota unique —
  comportement conservateur).
- **Sans tamponnement du flux** : la réponse NDJSON est progressive ; la
  réponse porte déjà `X-Accel-Buffering: no`. Pour nginx, prévoir aussi
  `proxy_buffering off;` sur `/api/search` et désactiver toute compression
  qui bufferiserait (`gzip off` sur cette route).

```nginx
location /api/search {
  proxy_pass http://127.0.0.1:3000;
  proxy_buffering off;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header x-noma-proxy-secret "<NOMA_PROXY_SECRET>";
  proxy_read_timeout 200s;   # échéance globale : 180 s
}
```

## Budget prévisionnel (jamais un plafond garanti)

- Avant chaque recherche IA : réservation de `NOMA_SEARCH_RESERVE_USD`
  (0,05 $) dans une transaction SQLite atomique, plafond du run imposé au
  moteur (`maxCostUsd`).
- Fin de recherche (dans tous les cas — arrêt, déconnexion, échéance 180 s) :
  coût connu → réserve soldée, reliquat libéré ; coût inconnu → **réserve
  conservée** jusqu'à réconciliation manuelle.
- Solde insuffisant → recherche admise **sans IA** (le secours web reste
  possible ; le budget n'est jamais augmenté automatiquement).

## Quotas

- Session (cookie) et empreinte IP pseudonymisée (HMAC, l'IP en clair n'est
  jamais stockée ni journalisée) : **2 démarrages/minute, 10/jour,
  1 recherche active**. Les essais REFUSÉS comptent aussi (anti-marteau) :
  3 POST en une minute = 429, même si les deux premiers ont été refusés.
- Global : **2 recherches simultanées** ; au-delà → `429` + `Retry-After`,
  sans file d'attente.
- Anti-bot : Turnstile validé serveur (jeton, hostname, action) ; origine de
  la requête contrôlée ; **refus systématique en production** si la
  configuration ou la validation est indisponible.

## Diagnostic (sans secrets)

```sh
# réserves non résolues (à réconcilier)
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.NOMA_DB_PATH||'./data/noma-guard.sqlite');console.log(db.prepare('SELECT search_id, amount_micros, day, created_at FROM reservations WHERE resolved_at IS NULL').all())"

# dépenses connues par jour (microdollars)
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('./data/noma-guard.sqlite');console.log(db.prepare('SELECT day, SUM(amount_micros) total FROM ledger GROUP BY day').all())"

# recherches actives et quotas (aucune IP en clair, uniquement des empreintes)
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('./data/noma-guard.sqlite');console.log(db.prepare('SELECT * FROM active_searches').all(), db.prepare(\"SELECT scope, count FROM attempts ORDER BY count DESC LIMIT 10\").all())"
```

Réconcilier une réserve après vérification fournisseur :

```sql
UPDATE reservations SET resolved_at = datetime('now'), spent_micros = <coût_réel_en_micros>
WHERE search_id = '<id>';
INSERT INTO ledger (search_id, kind, amount_micros, day, ts)
VALUES ('<id>', 'spent', <coût_réel_en_micros>, '<jour>', datetime('now'));
```

## Lancement local (validation)

```sh
# parcours complet avec sources simulées (aucune dépense, aucune requête réseau)
NOMA_FAKE_SOURCES=1 NOMA_TURNSTILE_DISABLED=1 NOMA_AI_DISABLED=1 npm run dev -- -p 3210
# parcours UI automatisé (captures mobile/desktop)
cd poc && NOMA_BASE_URL=http://localhost:3210 node_modules/.bin/tsx ui-parcours.ts

# Turnstile côté formulaire (widget SIMULÉ, jeton exigé par le bouton) :
# serveur avec clé publique + secret proxy (IP distinctes par contexte Playwright)
NEXT_PUBLIC_TURNSTILE_SITE_KEY=<clé> NOMA_PROXY_SECRET=<secret> \
  NOMA_FAKE_SOURCES=1 NOMA_TURNSTILE_DISABLED=1 NOMA_AI_DISABLED=1 npm run dev -- -p 3210
cd poc && NOMA_BASE_URL=http://localhost:3210 node_modules/.bin/tsx ui-turnstile.ts
# 7 scénarios : jeton absent, expiration, erreur, transmission,
# renouvellement après usage, relance bloquée, nouveau jeton transmis.
# N'utilise PAS le siteverify réel — voir BETA-CHECKLIST.md.
# NOTE : 2 démarrages/minute par IP — le script attend une frontière de minute.

# recherche RÉELLE (sources réelles + IA OpenRouter) — coûte de l'argent
NOMA_TURNSTILE_DISABLED=1 npm run dev -- -p 3210
# (nécessite poc/.env.local avec OPENROUTER_API_KEY et/ou GOOGLE_API_KEY/CX,
#  Chromium installé ; budget prévisionnel 0,05 $/recherche, 1 $/jour)
```

Tests :

```sh
npm test          # contrats (13) + protections (33) + flux (7) + route HTTP (13) = 66 tests
cd poc && npm test   # moteur PoC (217 tests)
npm run build && npm run lint
```

Le build doit être exécuté dans un environnement ISOLÉ du serveur de
développement actif (Next 16 verrouille le répertoire pour `next dev`) :
copier le projet puis construire dans la copie, ou arrêter `next dev`
avant. **Comportement vérifié en production** (`next start`, 2 oct. 2026) :
sans `NOMA_TURNSTILE_SECRET`, le serveur démarre (accueil 200) mais TOUTE
recherche échoue (500, fail closed à l'appel) — le « démarrage refusé »
documenté ci-dessus est donc appliqué à la première recherche, pas au boot.