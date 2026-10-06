# Essayer noma sur votre ordinateur

Ce guide est écrit pour quelqu'un qui n'est pas développeur. Il explique comment ouvrir l'application dans votre
navigateur, vous connecter, publier une annonce, exprimer un besoin et voir les correspondances. **Aucun SMS n'est
envoyé, aucun paiement n'est possible, aucun vrai site n'est contacté** : c'est un essai local, entièrement simulé.

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
4. **Vendeur** : dans « Mes annonces », ouvrez l'annonce : elle montre combien de **besoins** d'acheteurs correspondent (sans jamais
   montrer qui sont les acheteurs : un même acheteur peut avoir plusieurs besoins, donc on ne compte pas des acheteurs) et, dans
   « Booster cette annonce », un devis de prix pour 24 heures, 3 jours ou 7 jours (avec le temps pendant lequel ce prix reste
   valable). Le bouton « Acheter » est volontairement éteint : **le paiement n'existe pas encore**.

## La recherche rapide de la page d'accueil

Dans cet essai, la recherche rapide montre **des résultats d'exemple** (annonces fictives) : elle ne contacte aucun vrai site,
n'appelle aucune intelligence artificielle et ne demande aucun contrôle anti-robot.

## Comment lire les résultats

- **Compatibilité** : à quel point l'offre correspond à ce que vous cherchez (en pourcentage).
- **Prix** : « en dessous du marché », « dans la moyenne », « au-dessus du marché » ou « marché insuffisant pour comparer ».
- **Disponibilité** : « confirmée récemment », « à reconfirmer », « non renseignée »…
- **Confiance** : élevée, moyenne ou faible, d'après l'ancienneté du compte et le soin apporté à l'annonce.
- **Sponsorisé** : le vendeur a payé pour mettre son offre en avant, **mais seulement parmi des offres déjà pertinentes** ; cela ne
  rend jamais une offre qui ne convient pas plus visible qu'une offre qui convient.

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
| « NODE_ENV vaut … : dev:try ne démarre jamais hors développement » | Une variable `NODE_ENV` est définie dans votre terminal : retirez-la (`unset NODE_ENV`) ou mettez `NODE_ENV=development`. |
| « DATABASE_URL doit désigner une base de CE poste » | L'adresse de la base n'est pas sur votre ordinateur : l'essai refuse d'écrire ailleurs. |
| « Le serveur s'est arrêté de façon inattendue » | Next ou le worker a échoué au démarrage : lisez les messages juste au-dessus, corrigez, puis relancez ; tout a déjà été arrêté. |

## Pour les curieux (facultatif)

La commande démarre trois choses : le serveur Next (port 3211), le worker qui calcule les correspondances, et un petit
« relais » (port 3212). Le relais n'existe que pour l'essai : la connexion exige normalement un serveur intermédiaire de
confiance, et le relais en tient le rôle sur votre ordinateur. Il n'écoute que sur votre machine (127.0.0.1) et refuse de
démarrer en production. Les secrets de connexion sont créés au hasard à chaque lancement, sauf si vous les fournissez
vous-même (`NOMA_AUTH_SECRET`, `NOMA_AUTH_PROXY_SECRET`). Les sources de recherche sont simulées (`NOMA_FAKE_SOURCES=1`,
`NOMA_AI_DISABLED=1`, `NOMA_TURNSTILE_DISABLED=1` sont posées par la commande, quoi que dise votre environnement).
