# Authentification serveur par téléphone

Ce socle reste exclusivement serveur. La couche HTTP expose seulement les quatre
routes d'authentification décrites ci-dessous ; elle ne branche aucun écran et
n'utilise pas `noma_sid` ou le rôle Zustand comme preuve d'identité. Aucun
fournisseur SMS n'est configuré par défaut.

## Configuration

`DATABASE_URL` reste la connexion PostgreSQL métier. `NOMA_AUTH_SECRET` doit être
un secret aléatoire d'au moins 32 octets, encodé en base64. Il est validé
uniquement lorsqu'un service OTP est appelé et ne doit jamais être préfixé par
`NEXT_PUBLIC_`.

Exemple de génération locale, sans valeur à committer :

```shell
openssl rand -base64 32
```

L'absence de secret ou de transport fait échouer `requestOtp` avant tout accès à
la base. Par défaut le runtime ne fournit aucun transport de production. Lot SMS1 :
le transport SMS réel « meno » (`lib/server/sms/otp-transport.ts`) n'est installé que si
`NOMA_SMS_PROVIDER=meno` ET une clé valide sont définies (voir `SMS.md` : coût de 15 F par
SMS, résultat incertain = défi conservé sans renvoi automatique, échec définitif = `503
otp_delivery_failed` « Envoi du code impossible pour le moment. », budget d'envoi atteint =
`503 otp_capacity_reached` distinct, toutes les limites d'envoi conservées ; lot SMS1-bis :
s'y ajoutent des compteurs agrégés par préfixe d'adresse, /24 en IPv4 et /64 en IPv6, dans
`lib/server/auth/ip-prefix.ts`, et le transport réel n'est actif qu'avec `NODE_ENV=production`
ou vers un faux serveur local). noma génère et vérifie le code ; le transport implémente `SendOtp`
(il peut déclarer son propre `timeoutMs`). Sinon seul le transport de développement
ci-dessous existe.

### Transport OTP de développement (console du serveur)

`lib/server/auth/dev-otp-transport.ts` écrit le code sur la sortie du serveur,
uniquement dans la combinaison exacte `NODE_ENV=development` **et**
`NOMA_DEV_OTP_CONSOLE=1`. Une ligne fixe, rien d'autre (ni numéro complet, ni
identifiant de challenge, ni IP) :

```
[auth:dev] code OTP pour +***********12 : 123456 (expire à 10:05:09 UTC)
```

Le numéro est masqué sauf ses deux derniers chiffres. Avec `NOMA_DEV_OTP_CONSOLE=1`
et toute autre valeur de `NODE_ENV` (production comprise), le transport n'est
jamais installé : la demande d'OTP échoue comme sans transport (`503`) et un
avertissement fixe est journalisé une seule fois par processus. Il est branché
uniquement dans les dépendances par défaut des gestionnaires HTTP
(`defaultAuthHttpDependencies.resolveSendOtp`, résolu à chaque demande) ; un
`sendOtp` injecté prime toujours, donc les tests existants sont inchangés.

La demande d'OTP exige toujours les en-têtes du proxy de confiance
(`X-Noma-Proxy-Secret`, `X-Forwarded-For`) : un navigateur qui parle directement à
`next dev` reçoit `503`. En développement il faut donc un proxy qui les ajoute
(le relais de développement `scripts/dev-proxy.ts` joue ce rôle en local, voir `ECRANS-E1B.md` et `ESSAYER.md` ; il est lancé par
`npm run dev:try`, et les scripts `e2e:core` et `e2e:ui` passent par lui).

```shell
export TEST_DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_test'
npm run test:auth-dev-otp
```

La couche HTTP requiert également :

- `NOMA_AUTH_ORIGIN` : origine exacte autorisée, par exemple
  `https://noma.example` ; tous les POST sans cette origine sont refusés ;
- `NOMA_AUTH_PROXY_SECRET` : secret partagé d'au moins 32 octets avec le reverse
  proxy fiable qui fournit l'IP servant aux quotas.

## Couche HTTP

- `POST /api/auth/otp/request` accepte uniquement `{ "phone": "+..." }` ;
- `POST /api/auth/otp/verify` accepte uniquement `challengeId` et `code` ;
- `GET /api/auth/session` retourne uniquement `userId`, sinon `401` ;
- `POST /api/auth/logout` révoque la session et supprime le cookie, de façon
  idempotente.

Le cookie n'est supprimé qu'après une révocation PostgreSQL réussie (y compris
si elle était déjà effectuée). Une erreur temporaire retourne `503` sans
`Set-Cookie`, afin que le client puisse retenter avec le même jeton.

Tous les corps sont lus progressivement avec une limite réelle de 2 048 octets,
y compris sans `Content-Length`. Toutes les réponses portent
`Cache-Control: no-store`. Les POST exigent l'en-tête `Origin` correspondant
exactement à `NOMA_AUTH_ORIGIN` ; aucune réponse CORS permissive n'est émise.

Après vérification, le jeton brut est placé uniquement dans `noma_auth`, avec
`HttpOnly`, `SameSite=Lax`, `Path=/`, sans `Domain`, une expiration identique à
la session PostgreSQL et `Secure` en production. Il n'est jamais renvoyé en JSON.
Le cookie anonyme `noma_sid` reste sans valeur d'authentification.

### Contrat du reverse proxy

L'application ne doit être joignable qu'à travers le proxy de confiance. Celui-ci
doit supprimer tout `X-Forwarded-For` et `X-Noma-Proxy-Secret` reçu du client,
puis écrire un `X-Forwarded-For` contenant une seule IP canonique issue de la
connexion cliente et un `X-Noma-Proxy-Secret` égal à la configuration serveur.
Sans secret valide ou IP unique valide, la demande OTP échoue en `503` avant le
service métier et avant toute écriture. Aucun champ IP du JSON n'est accepté.

## Interfaces internes

```ts
requestOtp(phone, { requestIp, sendOtp, pool?, now?, authSecret?, transportTimeoutMs? })
verifyOtp(challengeId, code, { pool?, now?, authSecret? })
resolveSession(token, { pool?, now? })
revokeSession(token, { pool?, now? })
```

Le téléphone doit déjà être canonique : `+` puis un indicatif non nul et des
chiffres, avec au plus 15 chiffres. Aucun numéro national n'est converti. La
syntaxe valide ne confirme pas la possession ; seule une vérification OTP réussie
crée l'identité et, si nécessaire, l'utilisateur.

`requestOtp` retourne uniquement l'identifiant du challenge et ses échéances.
`verifyOtp` retourne l'identifiant utilisateur, le jeton brut de la nouvelle
session et son expiration. Le jeton brut n'est jamais relu depuis PostgreSQL.
`resolveSession` retourne un DTO minimal sans rôle implicite. `revokeSession` est
idempotent.

Le contexte `authSecret` et l'horloge injectable servent aux tests internes. En
exploitation, omettre `authSecret` lit `NOMA_AUTH_SECRET` à l'usage. Ne jamais
journaliser le téléphone complet, le code, le secret ou le jeton.

## Garanties

- OTP de six chiffres, valable cinq minutes, cinq erreurs maximum et usage unique ;
- HMAC-SHA-256 lié au challenge et au téléphone, sans code en clair en base ;
- ancien challenge invalidé après le délai de renvoi de 60 secondes ;
- quotas persistants et atomiques : téléphone 3/15 min et 10/jour, empreinte IP
  20/15 min et 100/jour, fenêtres fixes UTC ;
- réservation des quotas/challenge en transaction, transport hors transaction,
  puis confirmation conditionnelle de l'envoi ; aucune relance automatique ;
- horloge applicative relue après les attentes de pool et de verrous : aucun OTP
  expiré n'est transporté ou consommé, et aucune session expirée n'est résolue ;
- création/récupération utilisateur, consommation OTP et session atomiques ;
- sessions opaques de 32 octets, seul SHA-256 stocké, expiration absolue sept
  jours, révocation et statut utilisateur vérifiés à chaque résolution ;
- un compte suspendu ou archivé n'est jamais remplacé par un nouveau compte.

Les décisions d'expiration n'utilisent pas `CURRENT_TIMESTAMP`/`now()` dans une
transaction PostgreSQL : leur valeur reste celle du début de transaction. Elles
emploient l'horloge serveur injectable, relue après chaque attente pertinente.

## Tests PostgreSQL

La commande utilise le même harnais isolé que le catalogue et refuse une base non
dédiée ou un paramètre URL `options` :

```shell
export TEST_DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_test'
npm run test:auth
npm run test:auth-http
```

Les codes sont visibles uniquement dans le faux transport défini dans la suite de
tests. Sans `TEST_DATABASE_URL`, la commande échoue explicitement sans simulation.
