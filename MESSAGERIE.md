# Favoris et messagerie en direct (lot D2)

Tout est branché sur le serveur (migration `0020`), sans donnée d'exemple. Les routes sont dans `lib/server/social/http.ts`, les écrans dans `app/(buyer)/{favoris,messages}`, `app/(vendor)/vendeur/messages` et `components/conversation-screen.tsx`.

## Favoris

- Table `favorites (user_id, offer_id, demand_id, created_at)`, unique par `(user_id, offer_id)`. Le besoin d'origine est gardé : le lien de `/favoris` rouvre la fiche **dans ce contexte**.
- On ne garde qu'une annonce qu'on a le droit de voir : **même prédicat que la fiche et le contact** (`readOfferAccess`, `lib/server/metrics/contacts.ts` : correspondance confirmée et fraîche du besoin de l'acheteur, annonce en ligne). Sinon `404` indiscernable, rien n'est écrit.
- 200 favoris au plus par utilisateur (verrou consultatif par utilisateur : la limite est exacte), `409 favorites_limit` au-delà.
- `/favoris` : titre, prix, statut (« En ligne », ou « Cette annonce n'est plus disponible. » avec `available: false`), lien vers la fiche seulement si la correspondance existe encore (`openable`), retrait.
- Routes : `GET /api/favorites`, `POST /api/demands/{id}/offers/{offerId}/favorite`, `DELETE /api/favorites/{offerId}` (origine vérifiée AVANT la session).

## Conversations

- Une conversation par couple **(besoin, annonce)** entre l'acheteur (propriétaire du besoin) et le vendeur : `conversations (demand_id, offer_id, buyer_id, seller_id, created_at, last_message_at, buyer_last_read_id, seller_last_read_id)`, unique `(demand_id, offer_id)`. Un déclencheur refuse des parties qui ne sont pas le propriétaire du besoin et celui de l'annonce.
- **Ouverte par l'acheteur seulement**, aux mêmes conditions que le contact M1 (`POST /api/demands/{id}/offers/{offerId}/conversation`). Le vendeur n'a **aucun chemin d'ouverture** : il reçoit `404`. Il ne voit une conversation qu'à partir du premier message de l'acheteur.
- **Accès** : les deux participants seulement ; tout autre (tiers, besoin inconnu, conversation inconnue) reçoit **la même réponse 404**. Origine vérifiée sur les `POST`, réponses `no-store`.
- L'autre partie est désignée **sans identité** : « Vendeur de l'annonce iPhone 12 » / « Acheteur intéressé ». Le vendeur ne reçoit jamais l'identifiant du besoin ; aucun DTO ne porte d'identifiant ni de téléphone de l'autre partie.

## Messages

- `messages (id BIGINT identité, conversation_id, sender_id, body, created_at)`. L'id croît dans l'ordre de validation (l'écriture verrouille la conversation) : le rattrapage « messages après l'id X » n'a jamais de trou. Un message ne se modifie pas (déclencheur).
- Corps (`lib/messages-text.ts`, module pur partagé avec l'écran) : NFKC, toute suite d'espaces et de sauts de ligne devient **un** espace, texte rogné ; de **1 à 1000 caractères** (points de code) après normalisation ; **caractères de contrôle, de direction de texte et invisibles refusés** (avant et après normalisation, et par un CHECK en base). Aucun HTML n'est interprété : le texte est stocké tel quel et **affiché comme du texte React** (`components/message-bubble.tsx`, jamais `dangerouslySetInnerHTML` : un essai le vérifie).
- Un **numéro de téléphone n'est pas bloqué** : le contact direct est voulu. L'écran montre, la première fois seulement (mémorisé dans le navigateur, un stockage refusé n'est pas une erreur) : « Pour votre sécurité, ne payez jamais avant d'avoir vu l'objet. »
- **Limites** (verrou consultatif par expéditeur : exactes) : 30 messages par minute et 300 par jour UTC et par utilisateur ; 20 nouvelles conversations par jour UTC et par acheteur. Au-delà : `429` avec `Retry-After`. Une conversation déjà ouverte se retrouve toujours.
- Lecture : `GET /api/conversations` (liste, non-lus), `/unread`, `/{id}`, `/{id}/messages?after=ID&limit=N` (rattrapage), `POST /{id}/messages`, `POST /{id}/read` (l'état de lecture, par participant, ne recule jamais).
- **Notification « nouveau message »** (dans l'application seulement, jamais d'envoi externe) : une par conversation et par destinataire **tant qu'elle n'est pas lue** (index unique partiel), écrite dans la transaction de l'envoi, lue avec la conversation. Elle ne contient que le titre de l'annonce (liste blanche) et le lien `/messages/{id}`, jamais le texte.
- **Pastille de non-lus** : nombre de conversations non lues, relu avec **la même règle que les notifications** (`createUnreadRefresher` : au plus une fois par minute, jamais pour un visiteur anonyme), sur l'onglet « Compte » de l'acheteur et « Messages » du vendeur.

## En direct

- `GET /api/conversations/{id}/stream` : **Server-Sent Events** (`text/event-stream`, `Cache-Control: no-store, no-transform`, `X-Accel-Buffering: no`).
- L'insertion d'un message émet `NOTIFY noma_messages` depuis un déclencheur : la charge est `{"c": <conversation>, "m": <id du message>}`, **jamais le texte**. Une seule connexion `LISTEN` par processus (`lib/server/social/message-bus.ts`), partagée par tous les flux ; ouverte au premier flux, **fermée au dernier**. Charge illisible ignorée.
- Chaque flux envoie `event: message` + `{"id": N}` (ou `event: resync` quand la connexion d'écoute a été rétablie), `event: ready` quand l'écoute est établie, un battement `: ping` toutes les **15 s** (lot D3 : abaissé de 25 s). Plafond de **5 flux ouverts par utilisateur** (par processus) : le sixième est **accepté et ferme le plus ancien** flux du même utilisateur (jamais de refus : un utilisateur n'est pas bloqué par ses propres onglets fermés). La place est rendue **dès la déconnexion** (signal d'abandon de la requête et `cancel()` du flux, libération idempotente) ; le battement de 15 s reste un filet de sécurité.
- **Une place n'est occupée que par un flux vivant (lot D3)** : avant toute éviction, le registre SONDE les flux de l'utilisateur en écrivant un commentaire SSE (`: probe`, ignoré par le navigateur) ; un flux dont l'écriture échoue, dont le contrôleur est fermé (`desiredSize` nul) ou dont le signal de la requête est abandonné est libéré d'abord ; le plus ancien n'est évincé que si les 5 flux sont réellement vivants (`tests/server/stream-registry.test.ts`). La connexion `LISTEN` se ferme dès le dernier abonné retiré (au plus 5 s : `tests/postgres/conversation-stream.integration.test.ts`). Le scénario de l'audit D2 (4 flux vivants, puis 20 ouvertures-fermetures brutales d'un 5e flux) est rejoué sous `dev:try`, avec un vrai Next et le relais, par `npm run e2e:sse` (`scripts/e2e-sse.ts`, à lancer sous le répartiteur d'essais) : les 4 flux restent ouverts et reçoivent le message suivant. Constat du lot D3 : l'écart observé par l'audit venait de l'outil d'essai (`RelaySession.fetch` de `scripts/e2e-common.ts` remplaçait le signal d'abandon de l'appelant par son délai de 120 s : les flux « fermés brutalement » ne l'étaient jamais, et les 5 flux comptés étaient bien tous ouverts) ; l'outil honore maintenant le signal, et la sonde reste une défense en profondeur (un client qui disparaît sans fermer la connexion n'est vu qu'au battement ou à la sonde).
- Fermeture propre dans tous les cas (déconnexion, annulation, éviction, erreur d'écriture) : battement arrêté, abonnement retiré, place rendue une seule fois. Côté navigateur, quitter la conversation démonte l'écran et ferme le flux ; un flux fermé par le serveur (éviction) est rouvert avec l'attente croissante. Le compte des écouteurs et des connexions le prouve (`tests/postgres/conversation-stream.integration.test.ts`).
- Côté navigateur (`lib/client/message-sync.ts`, module pur testé sans navigateur) : à chaque événement le client **relit « les messages après l'id X » par l'API** ; si le flux tombe, reconnexion avec attente croissante (1 s, 2 s, 4 s, 8 s, 15 s), chaque tentative **rattrape d'abord** puis rouvre le flux (les messages arrivent donc même si le flux reste inutilisable).
- Le relais de `dev:try` (`scripts/dev-proxy.ts`) relaie le corps en continu (aucune mise en tampon) : `tests/scripts/dev-proxy-stream.test.ts` le prouve avec la vraie réponse de flux ; `e2e:demo` le prouve avec deux vrais navigateurs à travers le relais (message reçu en moins de 3 s, sans recharger).

## Limites assumées

- Les plafonds de flux sont **par processus** (un seul processus en local). Un utilisateur qui garde plus de 5 onglets ouverts sur des conversations fait se fermer et se rouvrir leurs flux à tour de rôle (attente croissante) : cas limite assumé.
- Un client qui disparaît SANS fermer la connexion (réseau coupé) n'est pas distinguable d'un client lent tant que le système n'a pas signalé l'erreur : la sonde ne peut que constater une écriture refusée ou un flux fermé ; la place est rendue au plus tard au battement suivant (15 s) ou à l'éviction.
- Les NOTIFY émis pendant une coupure de la connexion d'écoute sont perdus ; le client le sait (événement `resync`) et relit.
- Un message n'a ni accusé de lecture affiché ni suppression ; pas de pièce jointe.
