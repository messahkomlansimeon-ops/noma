# ECRANS-E1A.md — Premiers écrans branchés sur le vrai serveur (lot E1a)

> **Mise à jour (lot E1b)** : les correspondances, « Sponsorisé » et les devis de boost sont branchés (voir `ECRANS-E1B.md`) ; les
> scripts `e2e:core` et `e2e:ui` n'ajoutent plus eux-mêmes les en-têtes du proxy de confiance : ils passent par le relais de
> développement (port 3212, `scripts/dev-proxy.ts`). Les paragraphes ci-dessous décrivent l'état du lot E1a.

Écrans branchés : connexion et vérification OTP, annonces du vendeur (liste, création, publication, pause, archivage),
besoins de l'acheteur (création, activation, liste, satisfait, archivage), déconnexion. Les autres écrans restent sur les
données de démonstration (`lib/data.ts`, `lib/store.ts`) ; le store ne sert plus ici qu'aux messages (toasts). Pas encore :
correspondances, indicateurs, « Sponsorisé », devis de boost (lot E1b), messages, commandes, favoris, admin.

## Couche cliente

| Fichier | Rôle |
| --- | --- |
| `lib/client/api.ts` | Client unique : `api.auth` (requestOtp, verifyOtp, session, sessionOutcome, logout), `api.offers` (list, listAll, create, get, update, publish, pause, archive), `api.demands` (list, listAll, create, get, activate, archive, satisfy). `fetch` même origine, `credentials: "same-origin"`, JSON. Un identifiant placé dans une URL doit être un UUID : sinon `ApiError` de code fixe `invalid_id` (statut 0), SANS requête. |
| `listAll` (offres, besoins) | Renvoie `{ items, truncated }` : au plus 20 pages de 100 ; au-delà, une requête de contrôle (1 élément) dit s'il en reste et `truncated` vaut `true` (jamais de troncature silencieuse). Les écrans affichent alors le message fixe « Liste incomplète : trop d'éléments à afficher. » et n'affichent plus les compteurs de filtres (un compte partiel ne passe pas pour exact). |
| `ApiError { status, code }` | Construite UNIQUEMENT depuis le corps `{ error: { code, message } }` du serveur. Panne réseau, corps inattendu ou exception : code fixe (`network_error`, `invalid_response`, `aborted`, `invalid_id`), texte fixe ; jamais le texte d'une exception. |
| `describeApiError(error, contexte)` | Seule source des messages montrés à l'utilisateur : messages fixes en français selon (contexte, statut, code). |
| `lib/client/session.ts` | `safeNextPath` (chemin interne uniquement), `loginHref`, `decideGate`, `runSessionGate` (fonctions pures). |
| `components/session-gate.tsx` | `SessionGate` (lit `GET /api/auth/session`, redirige vers `/connexion?next=<chemin>`), `useUnauthorizedRedirect`, `useLogout`. Les enfants (donc leurs appels d'API) n'existent qu'une fois la session confirmée. La garde est une commodité d'interface : l'autorisation réelle est appliquée par chaque route de l'API. |
| `lib/client/catalog-view.ts` | Statuts, actions autorisées par statut (miroir des transitions du serveur), filtres, formats (XOF → « FCFA »), constructeurs de saisie `buildOfferInput` / `buildDemandInput`. |
| `lib/client/phone.ts`, `otp-flow.ts`, `otp-start.ts`, `use-otp-flow.ts` | Saisie du numéro → E.164 canonique (un « + » initial doit être suivi de 225, sinon refus : jamais de réécriture en +225 ; `00225` et `225` acceptés), masque d'affichage, parcours OTP entre `/connexion` et `/verification` (sessionStorage de l'onglet, jamais le code). `saveOtpFlow` renvoie `false` si l'écriture échoue ; `startOtpFlow` teste le stockage AVANT d'envoyer un code et vérifie l'écriture après : stockage bloqué = message fixe « Votre navigateur bloque le stockage nécessaire à la connexion. », pas de passage à `/verification`, aucun second envoi. `changeNumberHref` : « Modifier le numéro » revient à `/connexion?next=…` avec la destination d'origine (nettoyée par `safeNextPath`). |

## Contrats d'API utilisés

- `POST /api/auth/otp/request` `{ phone }` → 202 `{ challengeId, expiresAt, resendAvailableAt }` ; 400, 429, 503.
- `POST /api/auth/otp/verify` `{ challengeId, code }` → 200 `{ userId }` + cookie `noma_auth` (HttpOnly) ; 401, 503.
- `GET /api/auth/session` → 200 `{ userId }` ou 401 ; `POST /api/auth/logout` (sans corps) → 204.
- `GET|POST /api/offers`, `GET|PATCH /api/offers/{id}`, `POST /api/offers/{id}/publish|pause|archive` `{ expectedContentVersion }`.
- `GET|POST /api/demands`, `GET /api/demands/{id}`, `POST /api/demands/{id}/activate|satisfy|archive` `{ expectedContentVersion }`.
- Le serveur n'a pas de champ « titre » : l'écran enregistre « titre + description » dans `rawText` et affiche la première
  ligne. Le prix est `{ amount, currency: "XOF" }` (entier). La version de contenu renvoyée par chaque réponse est celle
  attendue à l'action suivante ; `409 content_version_conflict` ou `404` rechargent la liste.

## Écrans

| Écran | Branchement |
| --- | --- |
| `/connexion`, `/verification` | Parcours OTP réel, codes d'erreur 400/401/429/503 en messages fixes, retour vers `next` (chemin interne uniquement, sinon accueil). |
| `/vendeur/annonces`, `/vendeur/annonces/nouvelle`, `components/vendor/nouvelle-annonce-form.tsx` | Liste réelle (Actives / En ligne / En pause / Brouillon / Archivées ; « Actives » exclut les archivées, d'où le nom), actions réelles, formulaire de création (brouillon ou publication). Le formulaire est aussi utilisé par `/vendeur` (tableau de bord de démonstration) : sans session il redirige vers la connexion. |
| `/alerte/nouvelle` (« Nouveau besoin ») et `/alertes` (« Mes besoins ») | Filtres Actifs (hors archivés) / En cours (statut actif) / Brouillon / Satisfaits / Archivés. Écrans existants les plus proches d'un besoin persistant (`need-form.tsx` sert la recherche anonyme `POST /api/search`, autre fonction). Fréquence, WhatsApp et date de fin fictives retirés : le serveur ne les porte pas. |
| `/compte`, `/vendeur/profil` | Bouton « Se déconnecter » réel (le reste de ces pages reste en démonstration, sans garde). |

## Vérification de bout en bout (vrai serveur Next, base dédiée)

Base `noma_e2e` (`docker exec deploy-postgres-1 createdb -U noma_local noma_e2e`, puis `npm run db:migrate` avec
`DATABASE_URL` sur cette base). Serveur : `npm run dev:full` avec `PORT=3211`, `NODE_ENV=development`,
`NOMA_DEV_OTP_CONSOLE=1`, `NOMA_AUTH_ORIGIN=http://localhost:3211`, `NOMA_AUTH_SECRET`, `NOMA_AUTH_PROXY_SECRET` et
`NOMA_PROXY_SECRET` (même valeur), sortie du serveur enregistrée dans un fichier.

`next dev` écrit `.next/dev/lock` : un second `next dev` dans le même dépôt est refusé tant qu'un autre tourne (c'est le cas
du serveur de développement habituel). Lancer alors le serveur depuis une copie de l'arbre (rsync sans `.git`, `.next`,
`data`) avec son propre `.next`.

| Commande | Rôle |
| --- | --- |
| `npm run e2e:core` | HTTP comme un navigateur derrière un proxy de confiance : deux comptes par OTP (code lu dans le journal du serveur), offre iPhone 12 publiée, besoin iPhone 12 activé, attente bornée du worker, `stored-matches` dans les deux sens, isolation entre comptes (404), refus d'origine, pages en 200, erreurs d'authentification réelles, déconnexion et rejeu du cookie (401). |
| `npm run e2e:ui` | Même serveur, vrai navigateur (Chrome via Playwright de `poc/`) : redirections de la garde, connexion, annonces, besoins, déconnexion. |
| `npm run e2e:search-release` | Réserve T1 : place de recherche active libérée après coupure TCP (base SQLite de garde indiquée par `NOMA_DB_PATH`). |

Aucune de ces commandes n'est dans `npm test`. Variables : voir l'en-tête de chaque script. `e2e:ui` ajoute les en-têtes du
proxy de confiance (secret, adresse source) par interception de route, aux seules requêtes vers l'origine du serveur de
test (`scripts/e2e-proxy-headers.ts`) : jamais vers une autre origine.

## Tests

| Commande | Contenu |
| --- | --- |
| `npm run test:client` | Suite sans base : couche cliente, garde de session, vues du catalogue, téléphone et parcours OTP, démarrage de connexion, en-têtes de l'e2e. Incluse dans `npm test`. |
| `npm run test:auth-dev-otp` | Transport OTP de développement (unitaire + intégration PostgreSQL) : a besoin de `TEST_DATABASE_URL`, donc séparé de `npm test`. |

## Limites connues (hors périmètre du lot)

- Idempotence de la création : si la réponse d'un `POST /api/offers` ou `/api/demands` se perd (réseau), un nouvel essai
  crée un doublon. Pas de clé d'idempotence côté serveur pour l'instant.
- Rien ne vérifie au démarrage que `NOMA_DEV_OTP_CONSOLE` est absent en production (le transport refuse déjà de
  s'installer hors `NODE_ENV=development` et journalise un avertissement) : à ajouter plus tard dans `deploy/selftest.sh`.
- Un prix de 0 est refusé par le formulaire seulement ; le serveur n'est pas modifié.
- Les écrans (pages React) ne sont pas testés en unitaire : leur logique est extraite en fonctions pures testées, les pages
  elles-mêmes sont couvertes par `e2e:ui` (vrai navigateur).
