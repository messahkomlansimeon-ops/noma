# Essayer noma sur votre ordinateur

Ce guide est écrit pour quelqu'un qui n'est pas développeur. Il explique comment ouvrir l'application dans votre
navigateur, vous connecter, publier une annonce, exprimer un besoin, voir les correspondances, **recharger un
porte-monnaie et acheter un boost**. **Aucun SMS n'est envoyé, aucun vrai site n'est contacté et aucun argent réel n'est
utilisé** (la recharge du porte-monnaie passe par une page de paiement SIMULÉ) : c'est un essai local, entièrement simulé.

## Ce qu'il faut avoir avant

1. Le dossier du projet (celui qui contient ce fichier) et Node.js, déjà installés.
2. La base de données PostgreSQL du projet, démarrée (`npm run postgres:up`).
3. **Une base réservée à l'essai**, pour ne pas mélanger l'essai avec vos autres données. Création, une seule fois :

   ```
   docker exec deploy-postgres-1 createdb -U noma_local noma_essai
   DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_essai' npm run db:migrate
   ```

   Rien n'est choisi à votre place : la base doit être indiquée **dans la commande de lancement** (`DATABASE_URL=…` devant
   `npm run dev:try`, voir ci-dessous). La commande ne lit aucun fichier `.env` pour la deviner, et elle refuse de démarrer
   si la base n'est pas sur **votre ordinateur** (`127.0.0.1`, `localhost` ou `::1`).

   **La base d'essai doit être migrée jusqu'au bout : 17 migrations** (de `0001` à `0017`, dont le porte-monnaie `0014`,
   l'achat de boost `0015`, la portée visible d'un devis de boost `0016` et son estimation bornée `0017`). Si votre base d'essai a
   été créée avant ces lots, relancez simplement la deuxième commande ci-dessus (elle n'applique que ce qui manque). Contrôle : la
   commande suivante doit afficher `17`.

   ```
   docker exec deploy-postgres-1 psql -U noma_local -d noma_essai -tAc "select count(*) from noma_schema_migrations"
   ```
4. Ne rien changer à la variable `NODE_ENV` : la commande d'essai ne démarre que si elle est absente, vide ou égale à
   `development` (jamais en production, jamais en test).

## Lancer l'essai (une seule commande)

Dans un terminal, depuis le dossier du projet :

```
DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_essai' npm run dev:try
```

Attendez le grand encadré qui dit **« noma est prêt »**. Il donne l'adresse à ouvrir : **http://localhost:3212**.
Utilisez bien cette adresse (le port 3212), et pas celle que Next affiche (le port 3211).

Si un message dit « Un serveur next dev tourne déjà dans ce dossier », c'est que le serveur de développement habituel est
allumé : arrêtez-le, ou lancez l'essai depuis une copie du dossier.

**Important : n'exposez jamais le port 3212 par un tunnel** (loca.lt, ngrok, redirection de port, réseau partagé…). Ce petit
relais de test dit au serveur « je suis un intermédiaire de confiance » : si quelqu'un d'autre peut l'atteindre, il devient
lui aussi un client de confiance. Il n'écoute que sur votre ordinateur ; laissez-le ainsi.

## Se connecter

1. Ouvrez http://localhost:3212, puis la page de connexion.
2. Saisissez un numéro ivoirien, par exemple `07 00 00 00 42`, puis « Recevoir un code ».
3. **Le code à 6 chiffres n'arrive pas par SMS : il s'affiche dans le terminal** où vous avez lancé la commande, sur une
   ligne qui ressemble à `[auth:dev] code OTP pour +***********42 : 123456`. Recopiez les 6 chiffres.
4. Votre compte est créé la première fois. La session reste valable tant que vous ne vous déconnectez pas et que vous ne
   relancez pas la commande (au redémarrage, il faudra vous reconnecter).

## Un scénario simple, avec deux comptes

Il faut **deux comptes** : un vendeur et un acheteur. Le plus simple est d'ouvrir une fenêtre de navigation privée pour le
second compte (deux numéros différents, par exemple `07 00 00 00 42` et `07 00 00 00 43`).

1. **Vendeur** : « Mes annonces » → « Nouvelle annonce » : un titre, la catégorie « Téléphones », la marque, le modèle
   (par exemple « iPhone 12 »), un prix, puis « Publier l'annonce ».
2. **Acheteur** : « Mes besoins » → « Nouveau besoin » : la même catégorie, la même marque et le même modèle, un budget, puis
   « Activer le besoin ».
3. Patientez quelques secondes (le worker compare les annonces et les besoins), puis, dans « Mes besoins », ouvrez le besoin :
   la page affiche les offres compatibles. Si elle affiche « Recherche en cours… », appuyez sur « Actualiser ».
4. **Ajouter des annonces concurrentes d'exemple** (à faire AVANT d'essayer le boost). Un boost ne fait monter votre annonce que
   dans une liste d'au moins **7 offres** : la place mise en avant est limitée à 15 % de la liste (arrondie vers le bas), donc il
   n'y en a aucune sous 7 offres. Avec votre seule annonce, le devis du boost vous dira honnêtement « Pour le moment, un boost ne ferait monter votre annonce chez aucun acheteur : leurs listes sont trop courtes, ou la place mise en avant y est déjà occupée par un boost acheté plus tôt. » et l'achat restera éteint. Dans un autre terminal, depuis
   le dossier du projet, pendant que l'essai tourne :

   ```
   DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_essai' npm run dev:seed -- --category phones --brand apple --model "iphone 12" --offers 8
   ```

   La commande publie 8 annonces d'exemple (« Apple iphone 12 · offre d'exemple n° 1 » à « n° 8 », prix étalés autour de
   150 000 FCFA) par 8 **vendeurs fictifs** : les numéros `+225 07 99 99 99 01` à `08`, qui n'appartiennent à personne (aucun SMS
   ne leur est envoyé). Utilisez la **même catégorie, la même marque et le même modèle** que votre annonce et votre besoin.
   Vous pouvez la relancer sans crainte : elle ne recrée pas ce qui existe déjà (`--offers 10` n'ajoute que 2 annonces). Patientez
   quelques secondes que le worker les compare au besoin. Par prudence, elle refuse de s'exécuter si `NODE_ENV` est défini autrement
   que `development`, si `DATABASE_URL` est absente ou n'est pas sur votre ordinateur, ou si la base n'est pas l'une des bases
   d'essai connues (**`noma_essai`, `noma_e2e` ou `noma_essai_…`** : tout autre nom, y compris `noma_dev`, `noma_test` et `noma_prod`,
   est refusé) : elle n'écrit alors rien. Deux commandes lancées en même temps s'attendent l'une l'autre (jamais d'annonce en double).
   Le nom du produit (`--category`, `--brand`, `--model`) ne peut contenir ni caractère de contrôle ni caractère de direction de texte.
5. **Vendeur** : dans « Mes annonces », ouvrez l'annonce : elle montre combien de **besoins** d'acheteurs correspondent (sans jamais
   montrer qui sont les acheteurs : un même acheteur peut avoir plusieurs besoins, donc on ne compte pas des acheteurs ici) et, dans
   « Booster cette annonce », un devis de prix pour 24 heures, 3 jours ou 7 jours (avec le temps pendant lequel ce prix reste
   valable). Un devis n'est proposé que si le boost ferait réellement monter votre annonce chez au moins un acheteur : il indique
   alors « Mise en avant visible auprès de X acheteur(s) » (sans jamais dire qui ; « d'au moins X » quand l'estimation a été limitée à
   quelques dizaines de besoins : c'est un minimum). Tant que votre porte-monnaie est vide, le bouton
   « Acheter » reste éteint et l'écran dit « Solde insuffisant (0 FCFA) », avec un bouton « Recharger ».
6. **Vendeur** : **recharger son porte-monnaie** (paiement simulé). Appuyez sur « Recharger » (ou, depuis l'onglet « Compte » :
   « Mon porte-monnaie » puis « Recharger »), choisissez un montant (1 000, 2 000, 5 000 ou 10 000 FCFA, ou un autre montant de
   500 à 500 000 FCFA, par multiples de 100), puis « Continuer vers le paiement ». La page « paiement simulé » s'ouvre, avec un grand
   bandeau orange **« SIMULATION — aucun argent réel »** : « Confirmer le paiement » crédite votre porte-monnaie (« Votre
   porte-monnaie a été crédité de … FCFA »), « Faire échouer le paiement » refuse la recharge sans rien créditer. Le lien de la page
   vous ramène à l'annonce. **Aucun argent réel n'est utilisé.**
7. **Vendeur** : **acheter un boost**. Sur l'annonce, choisissez une durée : le prix s'affiche. Si votre solde le couvre, « Acheter »
   est actif ; l'écran vous demande de confirmer (« Vous allez payer … FCFA pour un boost de … Solde après achat : … FCFA. »), puis
   « Confirmer l'achat ». Vous voyez « Boost actif jusqu'au … », votre solde diminue du prix, et « Mon porte-monnaie » garde
   l'historique (Recharge, Achat de boost). Un prix ne vaut que quelques minutes : s'il a expiré, l'écran le dit et vous en demandez un
   nouveau. Si la connexion se coupe pendant l'achat, l'écran dit « Pas encore enregistré : l'achat peut encore aboutir. », relit tout seul vos
   achats (après 2, 5 puis 10 secondes) et propose « Vérifier / réessayer » : il retrouve votre achat sans jamais vous faire payer deux
   fois. L'achat revérifie aussi, au dernier moment, qu'un acheteur verrait encore votre annonce monter : sinon rien n'est acheté
   (« Ce boost ne ferait plus monter votre annonce chez aucun acheteur (place déjà occupée par un boost acheté plus tôt, ou liste trop courte). Aucun débit. Demandez un nouveau prix plus tard. »).
8. **Acheteur** : sur la page de ses résultats, appuyez sur « Actualiser » : l'annonce boostée remonte avec le badge **« Sponsorisé »**
   (grâce aux annonces d'exemple de l'étape 4 : sans elles, la liste compte trop peu d'offres et aucune place n'est mise en avant).
   Un boost n'est ni une garantie de position, ni une garantie de vente.

## La recherche rapide de la page d'accueil

Dans cet essai, la recherche rapide montre **des résultats d'exemple** (annonces fictives) : elle ne contacte aucun vrai site,
n'appelle aucune intelligence artificielle et ne demande aucun contrôle anti-robot.

## Comment lire les résultats

- **Compatibilité** : à quel point l'offre correspond à ce que vous cherchez (en pourcentage).
- **Prix** : « en dessous du marché », « dans la moyenne », « au-dessus du marché » ou « marché insuffisant pour comparer ».
- **Disponibilité** : « confirmée récemment », « à reconfirmer », « non renseignée »…
- **Confiance** : élevée, moyenne ou faible, d'après l'ancienneté du compte et le soin apporté à l'annonce.
- **Sponsorisé** : le vendeur a payé pour mettre son offre en avant, **mais seulement parmi des offres déjà pertinentes** ; cela ne
  rend jamais une offre qui ne convient pas plus visible qu'une offre qui convient. (Dans cet essai, le « paiement » est simulé :
  aucun argent réel.)

## Arrêter

Dans le terminal : **Ctrl+C**. Tout s'arrête (le serveur, le worker et le relais). Vos données restent dans la base d'essai.

## Si quelque chose ne marche pas

| Ce que vous voyez | Ce qu'il faut faire |
| --- | --- |
| « DATABASE_URL est obligatoire » | Ajoutez `DATABASE_URL='…'` devant la commande, comme dans l'exemple ci-dessus. |
| « Le port 3211 (ou 3212) est déjà utilisé » | Un autre programme occupe ce port : arrêtez-le, puis relancez. |
| La page affiche « Le service est temporairement indisponible » | Le serveur démarre encore (attendez l'encadré « noma est prêt »), ou la base ne répond pas. |
| Le code de connexion n'apparaît pas | Regardez bien le terminal de la commande `dev:try` (pas celui d'un autre programme). |
| « Trop de demandes de code » | Patientez une minute avant de redemander un code pour le même numéro. |
| « La recharge n'est pas disponible pour le moment. » | La recharge simulée n'est active que dans l'essai lancé par `dev:try` (la commande pose `NOMA_FAKE_PAYMENTS=1`) : relancez avec la commande de ce guide, sans l'avoir remplacée. |
| « Pour le moment, un boost ne ferait monter votre annonce chez aucun acheteur : leurs listes sont trop courtes, ou la place mise en avant y est déjà occupée par un boost acheté plus tôt. » | Il y a trop peu d'annonces pour ce produit (7 offres au moins dans la liste de l'acheteur), ou la place mise en avant y est déjà prise par un boost acheté plus tôt : lancez `npm run dev:seed` (étape 4 du scénario), patientez quelques secondes, puis « Actualiser » le devis. |
| « dev:seed : refus — … » | La commande d'exemple n'écrit que dans une base d'essai de votre ordinateur, hors production : lisez la raison affichée (NODE_ENV, DATABASE_URL absente ou distante, base autre que `noma_essai`, `noma_e2e` ou `noma_essai_…`, ou un texte `--category`, `--brand` ou `--model` qui contient un caractère de contrôle, de direction de texte ou invisible comme U+200B : retapez-le sans copier-coller). |
| « Vérification impossible pour le moment, réessayez dans un instant. » | La base était trop lente pour vérifier à temps qu'un acheteur verrait votre annonce monter (rien n'a été écrit ni débité) : réessayez dans quelques secondes (pour un achat, « Confirmer l'achat » réutilise la même clé : vous ne serez débité qu'une fois). |
| « Trop de devis demandés en peu de temps » | Au plus 20 prix calculés par minute pour un même vendeur : patientez une minute. |
| « Solde insuffisant » sous « Acheter » | Rechargez votre porte-monnaie (« Recharger »), puis revenez à l'annonce. |
| « Ce devis a expiré » | Un prix ne vaut que quelques minutes : appuyez sur « Demander un nouveau devis ». |
| « NODE_ENV vaut … : dev:try ne démarre jamais hors développement » | Une variable `NODE_ENV` est définie dans votre terminal : retirez-la (`unset NODE_ENV`) ou mettez `NODE_ENV=development`. |
| « DATABASE_URL doit désigner une base de CE poste » | L'adresse de la base n'est pas sur votre ordinateur : l'essai refuse d'écrire ailleurs. |
| « Le serveur s'est arrêté de façon inattendue » | Next ou le worker a échoué au démarrage : lisez les messages juste au-dessus, corrigez, puis relancez ; tout a déjà été arrêté. |

## Pour les curieux (facultatif)

La commande démarre trois choses : le serveur Next (port 3211), le worker qui calcule les correspondances, et un petit
« relais » (port 3212). Le relais n'existe que pour l'essai : la connexion exige normalement un serveur intermédiaire de
confiance, et le relais en tient le rôle sur votre ordinateur. Il n'écoute que sur votre machine (127.0.0.1) et refuse de
démarrer en production. Les secrets de connexion sont créés au hasard à chaque lancement, sauf si vous les fournissez
vous-même (`NOMA_AUTH_SECRET`, `NOMA_AUTH_PROXY_SECRET`). Les sources de recherche sont simulées (`NOMA_FAKE_SOURCES=1`,
`NOMA_AI_DISABLED=1`, `NOMA_TURNSTILE_DISABLED=1` sont posées par la commande, quoi que dise votre environnement). Le paiement l'est
aussi : `NOMA_FAKE_PAYMENTS=1` est posée par la commande, avec un secret `NOMA_FAKE_PAYMENT_SECRET` créé au hasard à chaque lancement
(32 octets au moins, jamais affiché ; vous pouvez en fournir un vous-même, jamais plus court que 32 octets). Ce prestataire fictif
n'existe qu'en développement : **ne définissez jamais ces variables en production**.
