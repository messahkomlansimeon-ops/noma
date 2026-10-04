# BÊTA-CHECKLIST — Préparation de la bêta privée Noma

Statut au 2 octobre 2026. **Aucune publication, aucune dépense IA, aucune
recherche externe** — ce lot est purement préparatoire. Les étapes 3
(préproduction) et 4 (essai réel) sont **en attente d'autorisation
explicite** ; rien n'a été déployé ni facturé.

---

## 1. Inventaire des prérequis (présence uniquement, jamais de valeur)

| Prérequis | État | Preuve / note |
|---|---|---|
| Runtime Node | ✅ disponible | Node v26.8.1 ( requis par `node:sqlite`, `AbortSignal.any`) |
| Serveur d'exécution | ⚠️ à vérifier | Machine de dev actuelle uniquement ; serveur de production non fourni |
| Domaine | ❌ manquant | Aucun domaine fourni ; requis pour Turnstile réel + HTTPS |
| HTTPS (certificat) | ❌ manquant | Non provisionné ; cookie `Secure` exigé en production |
| Chromium | ✅ disponible | `/usr/bin/google-chrome-stable` v152 ; Playwright 1.63 (`poc/node_modules`) |
| SQLite persistant | ✅ disponible | `data/noma-guard.sqlite` (+ WAL) ; `NOMA_DB_PATH` configurable |
| `NOMA_TURNSTILE_SECRET` | ❌ manquant | Non défini dans l'environnement actuel ; **requis en production** (fail closed) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | ❌ manquant | Non défini ; à fournir avec le domaine final (inliné au build) |
| Fournisseur IA (OpenRouter) | ✅ disponible | `poc/.env.local` : `OPENROUTER_API_KEY` présent (valeur non lue) |
| Google CSE | ✅ disponible | `poc/.env.local` : `GOOGLE_API_KEY` + `GOOGLE_CX` présents (valeurs non lues) |
| Secrets production (`NOMA_IP_SECRET`, `NOMA_PROXY_SECRET`) | ❌ manquant | À générer sur le serveur ; jamais dans le dépôt |
| Reverse proxy (nginx) + config flux | ⚠️ à vérifier | Config documentée ci-dessous ; proxy_buffering off exigé sur `/api/search` |
| Dépendances installées | ✅ disponible | `node_modules` (app) + `poc/node_modules` (tsx, playwright) |

Aucune source simulée ni désactivation Turnstile n'est autorisée en
production : `NOMA_FAKE_SOURCES` et `NOMA_TURNSTILE_DISABLED` sont ignorés
quand `NODE_ENV=production` (vérifié par tests `guard.test.ts` : « production
: configuration absente → refus config ; dérivation tests interdite »).

## 2. Vérifications automatisées (exécutées le 2 octobre 2026)

| Suite | Commande | Résultat mesuré |
|---|---|---|
| Contrats partagés | `npm run test:contracts` | **13/13 verts** |
| Protections (budget, quotas, Turnstile, IP) | `npm run test:server` | **33/33 verts** |
| Flux NDJSON (annulation, réconciliation) | `npm run test:stream` | **7/7 verts** |
| Route HTTP `/api/search` (NOUVEAU) | `npm run test:route` | **13/13 verts** — stabilité : 10 exécutions consécutives sans échec |
| Moteur PoC | `cd poc && npm test` | **217/217 verts** |
| TypeScript | `npx tsc --noEmit` | 0 erreur |
| Lint | `npm run lint` | 0 erreur (9 warnings préexistants, tous dans `poc/`, non modifiés) |
| Build | `next build` (copie isolée) | ✅ compilé, 28 routes — copie obligatoire : Next 16 verrouille le répertoire d'un `next dev` actif |

### Couverture ajoutée dans ce lot (66 tests app, avant : 49)

- **Corps > 8 Ko sans `Content-Length`**, Unicode multi-octets inclus :
  `413` + lecture interrompue (flux annulé après ≤ 4 morceaux sur 10,
  30 000 octets de « é » refusés alors qu'un comptage en caractères
  laisserait passer) ; `413` avec `Content-Length` déclaré sans lecture ;
  `8192` octets exacts acceptés, `8193` refusés.
- **Champs structurés** : budget/location/mode `service` transmis jusqu'au
  moteur (`structured` capturé dans les options du moteur) ; sans IA :
  `ai: null` et aucun plafond ; validation côté route (budget négatif,
  mode inconnu, texte > 1 000, localisation > 120, budget non numérique → 400).
- **Vraie coupure client (socket TCP)** : serveur HTTP local isolé (port
  éphémère) câblé comme le runtime Next — coupure du socket → abort du
  signal de la requête. Mesures obtenues : place occupée vérifiée en base
  avant la coupure ; coupure du client dès le premier événement ; la place
  est libérée en **~90-100 ms** (fin normale de la source lente : 1,5 s —
  l'annulation a donc atteint la source, qui n'a jamais terminé
  naturellement) ; lecture client achevée par `AbortError` (jamais par une
  fin de flux normale) ; aucun événement `completed` reçu après coupure ;
  comptabilité propre (0 réservation, 0 dépense avec IA désactivée).
  Corrige la preuve initiale du lot 2, qui n'avortait en réalité rien
  (AbortController jamais relié) et appelait `body.cancel()` sur un flux
  verrouillé (erreur masquée) — désormais `reader.cancel()` sans masquage.
- **Concurrence HTTP** : 1 recherche active par session (2e POST →
  `429 search_in_progress`, occupation de la place vérifiée en SQLite avant
  le 2e POST) ; anti-marteau mesuré (les essais refusés comptent :
  3 POST/minute → `429 rate_limited` + `Retry-After`) ; comptabilité propre
  après parcours complet (0 réservation, 0 dépense avec IA désactivée).
- **Réserve incertaine, changement de jour + redémarrage** : réserve
  `reserve-kept` décomptée du solde du lendemain après redémarrage ;
  réconciliation ultérieure comptée au jour d'origine ; place libérée +
  réserve conservée à coût inconnu.

### Validation UI (Playwright, widget Turnstile SIMULÉ — jamais le siteverify réel)

- `poc/ui-parcours.ts` : parcours complet desktop + mobile validé —
  formulaire → résultats progressifs → détail → comparaison →
  rechargement sans relance → annulation. Captures :
  `/tmp/opencode/noma-ui/desktop-{form,resultats,detail,comparaison,rechargement}.png`
  et `/tmp/opencode/noma-ui/mobile-{resultats,annulation,detail-inconnu}.png`.
- `poc/ui-turnstile.ts` (NOUVEAU, 7 scénarios) : jeton absent (aucun POST,
  message explicite), expiration (recherche bloquée), erreur widget
  (« indisponible »), transmission (`turnstileToken` dans le POST,
  statut 200 mesuré), renouvellement (widget réinitialisé après usage),
  relance sans nouveau jeton bloquée, nouveau jeton transmis (jamais
  l'ancien). Captures : `/tmp/opencode/noma-ui-turnstile/`.
  **Limite assumée : le vrai Turnstile (siteverify Cloudflare) n'a PAS été
  testé — impossible sans domaine réel. La validation serveur du jeton
  (hostname/action/fail-closed) est couverte par les tests unitaires.**

## 3. Checklist de configuration production (à cocher avant préproduction)

- [ ] Serveur Node accessible + déploiement d'UNE SEULE instance
- [ ] Domaine configuré + HTTPS actif ( certificat en place, `http` → `https` redirigé)
- [ ] `NODE_ENV=production` (cookie `noma_sid` posé `Secure`)
- [ ] `NOMA_TURNSTILE_SECRET` défini (sinon toutes les recherches échouent — comportement vérifié)
- [ ] `NEXT_PUBLIC_TURNSTILE_SITE_KEY` défini **au moment du build**
- [ ] `NOMA_IP_SECRET` défini (requis : démarrage/`guard()` refusé sinon)
- [ ] `NOMA_PROXY_SECRET` défini et transmis par le proxy via `x-noma-proxy-secret`
- [ ] Proxy : `proxy_buffering off` + `gzip off` sur `/api/search`, `proxy_read_timeout 200s`
- [ ] `X-Forwarded-For: $remote_addr` transmis (sans le secret : bucket IP unique — conservateur mais dégradé)
- [ ] `NOMA_FAKE_SOURCES`, `NOMA_TURNSTILE_DISABLED` **ABSENTS** de l'environnement de production
- [ ] `NOMA_DB_PATH` sur un volume persistant + sauvegarde SQLite programmée
- [ ] Clé IA présente côté serveur uniquement (`poc/.env.local`), jamais dans le bundle
- [ ] Quotas inchangés : 2/min · 10/jour · 1 active/session · 2 globales · budget 1 $/jour · réserve 0,05 $
- [ ] `NOMA_SEARCH_DISABLED=1` tant que le lot 4 n'est pas autorisé (503 vérifié)
- [ ] Diagnostic post-déploiement : requêtes SQL de DEPLOIEMENT.md (réserves, ledger, recherches actives)

### 3bis. Préparatifs lot 3 — exécutés le 2 octobre 2026 (LOCAL uniquement)

**Intervention distante : aucune** — serveur, domaine, HTTPS et clés
Turnstile réels n'ont pas été fournis (voir § 1). Rien n'a été déployé.

**Artifacts créés dans `deploy/`** (détail dans DEPLOIEMENT.md) :
`env.production.example`, `gen-secrets.sh` (secrets générés sur le serveur,
chmod 600, ignorés par Git, jamais affichés), `nginx-noma.conf` (TLS +
allow/deny testeurs y compris `/api/search` + flux sans tamponnement),
`noma.service` (instance unique), `backup.sh`, `restore-check.sh`,
`verify-turnstile.ts` (siteverify isolé : ni moteur, ni Chromium, ni IA).

**Vérifications RÉELLEMENT exécutées (localement)** :
- **Tests négatifs automatisés** (`deploy/selftest.sh`, hors ligne, base
  temporaire, **sans sudo** — **33/33 verts, 2 exécutions consécutives,
  exit 0**) :
  - noma.service : ExecStart force `--hostname 127.0.0.1`, aucun ExecStart
    sans hostname, EnvironmentFile cohérent avec gen-secrets.sh ;
  - backup.sh : source inexistante → exit 1 sans fichier créé ; source
    non-SQLite → exit 1 ; SQLite valide sans les tables de protection →
    sortie supprimée + exit 1 ; nominal → exit 0 ;
  - restore-check.sh : fichier inexistant / non-SQLite / sans tables →
    exit 1 ; nominal (intégrité + 4 tables) → exit 0 ;
  - gen-secrets.sh : sortie non ignorée par Git → exit 1 ; avec
    .gitignore → exit 0 ; **cible `/proc` (non inscriptible même en root)
    → exit 1** ; répertoire chmod 500 (mode non root) → exit 1 ;
    **garde « root sans propriétaire » présent ET déclenché (id uid 0
    simulé) → exit 1 + message** ;
    **régénération avec propriétaire inexistant → exit 1 avec contenu et
    permissions de l'original INCHANGÉS (md5 comparé), aucun fichier
    temporaire résiduel** ; **chown impossible vers un autre utilisateur →
    exit 1, original inchangé** ; **régénération nominale → les autres
    clés configurées sont PRÉSERVÉES** (marqueur vérifié), exactement
    2 secrets (pas de doublon) ;
    **lecture impossible (fichier 000) → exit 1, original inchangé
    (contenu et permissions)** — codes `grep` autres que 0/1 interrompent
    sans remplacement ;
    **temporaire privé dès la création** (`umask 077` + `mktemp` même
    répertoire ; vérifié dynamiquement sous `umask 000` : fichier final
    600, aucun résidu) ;
    chemin paramétrable (celui lu par systemd) → création + régénération,
    permissions 600, **aucune valeur de secret dans la sortie du script**
    (capture vérifiée).
- **Séquence de build vérifiée en mode utilisateur** (le mode de
  l'utilisateur de service) : fichier généré avec propriétaire transmis
  (600, propriétaire = utilisateur de build), `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
  ajoutée par le propriétaire **sans root**, fichier sourcé au build →
  build réussi, clé publique **inline dans le bundle client**
  (`.next/static/chunks/…`, sim. `LGgJKqEprBwa0ok8rNSwB`).
- Sauvegarde cohérente : `VACUUM INTO` sur `data/noma-guard.sqlite` →
  intégrité `ok`, tables `active_searches, attempts, ledger, reservations`
  (22 essais comptabilisés dans la copie).
- Test de restauration sur une copie : intégrité `ok`, comptages de lignes
  affichés, base réelle intacte.
- `noma.service` corrigé (P1) : `ExecStart=/usr/bin/npm run start --
  --hostname 127.0.0.1` — **ligne de commande vérifiée localement** :
  `ss` montre `127.0.0.1:3000` UNIQUEMENT (aucune écoute publique, nginx
  seul expose l'app).
- `verify-turnstile.ts` : chemin d'usage (exit 2) + appel siteverify réel
  avec secret/jeton factices → refus `invalid` (le circuit Cloudflare
  répond, aucune dépense, aucun moteur lancé).
- Simulation locale complète (build `next start` + nginx TLS auto-signé) :
  HTTPS 200 (IP testeur simulée) · **IP non autorisée → 403** ·
  `/api/search` → **503 `searches_disabled`** (recherches gardées
  désactivées) · aucun `Set-Cookie` avant admission · **aucune compression**
  sur `/api/search` (`Accept-Encoding: gzip` ignoré) · Next lié à
  **127.0.0.1 uniquement** (aucun port public) · réserve non résolue insérée
  pendant l'exécution puis **conservée après redémarrage de l'app** ·
  requêtes de diagnostic de DEPLOIEMENT.md exécutées telles quelles ·
  arrêt propre de la simulation.
- Retour arrière préparé : `BUILD_ID` du build de simulation conservé
  (`HujFyJmLdbcXK258JZ1bh`) ; procédure ci-dessous.

**Différé (jamais présenté comme réussi)** — nécessite le domaine et les
clés réels :
- Turnstile RÉEL sur le domaine : succès, refus, expiration, nouvelle
  tentative (`deploy/verify-turnstile.ts` prêt ; le widget réel exige le
  domaine configuré).
- Cookie `Secure` observé via l'app : une admission réussie est nécessaire,
  donc des recherches activées — commandes prêtes dans DEPLOIEMENT.md.
- Honneur de `X-Forwarded-For` derrière le proxy réel.
- Flux NDJSON + déconnexion avec Next + proxy : préparé (tests
  automatisés locaux + procédure), exécution avec sources réelles attendue
  à l'accord du lot 4.

**Procédure de retour arrière (version déployable conservée)** :
1. Chaque déploiement garde son dossier de release (`/opt/noma/releases/<BUILD_ID>`) ; `current` = symlink vers la release active.
2. Le `BUILD_ID` de la version en production est noté dans le journal de déploiement.
3. Retour : `ln -sfn /opt/noma/releases/<BUILD_ID-précédent> /opt/noma/current && systemctl restart noma` (la base SQLite est compatible entre versions ; les réserves non résolues survivent — testé).
4. Sauvegarde AVANT tout retour : `deploy/backup.sh /var/backups/noma`, puis `deploy/restore-check.sh <sauvegarde>`.

## 4. Préproduction privée — EN ATTENTE DES PRÉREQUIS

Non exécuté — **blocage : rien n'a été fourni** (voir § 1). Dès réception :

1. **Rejouer `deploy/selftest.sh` sur le serveur, SANS sudo** (27
   vérifications négatives/nominales ; exit 1 = installation stoppée).
2. Générer les secrets avec sudo en transmettant la propriété à
   l'utilisateur de service (root sans propriétaire → refus par
   construction) : `sudo deploy/gen-secrets.sh /opt/noma/shared/.env.production noma`.
3. Ajouter `NEXT_PUBLIC_TURNSTILE_SITE_KEY` **par l'utilisateur de
   service** (le fichier lui appartient, 600) : `sudo -u noma sh -c 'echo … >> /opt/noma/shared/.env.production'`.
4. Construire **en tant qu'utilisateur de service** avec le fichier sourcé
   (clé publique inline au build) : `sudo -u noma sh -c 'set -a; . /opt/noma/shared/.env.production; set +a; npm run build'`
   — noter le `BUILD_ID` (retour arrière) et vérifier la clé inline dans `.next/static`.
5. Installer `deploy/noma.service` (écoute forcée 127.0.0.1 — vérifiée) et
   `deploy/nginx-noma.conf` (liste des IP testeurs), certificat TLS.
   Contrôle post-démarrage : `ss -tlnp | grep 3000` → `127.0.0.1` uniquement.
6. Vérifier : HTTPS, accès privé (403 hors testeurs), `503 searches_disabled`, persistance après redémarrage, sauvegarde + restauration (garde-fous actifs).
7. Turnstile réel via `deploy/verify-turnstile.ts` (ni moteur ni IA) puis, si autorisé, widget sur le domaine.
8. `NOMA_SEARCH_DISABLED=1` maintenu tant que le lot 4 n'est pas autorisé.

**Aucune ouverture publique à cette étape.**

## 5. Essai réel — EN ATTENTE D'ACCORD SÉPARÉ

Recherches proposées (budgets prévisionnels actuels conservés : 0,05 $/recherche,
1 $/jour ; exécution séquentielle, aucune relance automatique, arrêt si
facturation incertaine) :

1. iPhone 12 Pro 128 Go, maximum 150 000 FCFA, Cocody.
2. Téléviseur 55 pouces, Abidjan.
3. Chargeur USB-C 20 W, Abidjan.

Mesures prévues par recherche : sources disponibles/bloquées, premiers
résultats, durée totale, pertinence, cache, coût connu ; distinction
explicite panne de source / absence d'offres.

## 6. Anomalies et limites relevées (non bloquantes)

| # | Constat | Impact | Décision |
|---|---|---|---|
| A1 | En production sans `NOMA_TURNSTILE_SECRET`, le serveur démarre (accueil 200) mais chaque recherche échoue en 500 : le contrôle se fait à la première recherche, pas au boot (document DEPLOIEMENT : « démarrage refusé ») | Aucun risque de sécurité (fail closed) ; comportement légèrement différent de la doc | Corriger/tester en préproduction ; doc mise à jour |
| A2 | Sans secret proxy configuré, tous les clients directs partagent un bucket de quota IP unique (comportement conservateur documenté) | Quotas IP inefficaces derrière aucun proxy | **Proxy de confiance obligatoire** en préproduction |
| A3 | 9 warnings ESLint préexistants (variables inutilisées dans `poc/`) | Aucun | Hors périmètre de ce lot |
| A4 | Turnstile réel non testé (pas de domaine) | Valide en préproduction seulement | Étape 3 |
| A5 | Dépôt git sans commit initial (`master`, 0 commit) | Pas d'historique/repli de code | Hors périmètre ; à initier par le porteur |

## 7. Hors périmètre (confirmé)

Supabase, comptes, vendeurs internes, commandes, veille, proxies payants.
Aucun changement du contrat public de recherche (`lib/contracts.ts` inchangé,
couvert par 13 tests de contrat inchangés).
