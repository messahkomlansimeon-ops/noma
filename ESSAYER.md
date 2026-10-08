# Essayer noma sur votre ordinateur

Ce guide est écrit pour quelqu'un qui n'est pas développeur. Il explique comment ouvrir l'application dans votre
navigateur, vous connecter, publier une annonce, exprimer un besoin, voir les correspondances, **recharger un
porte-monnaie et acheter un boost**, puis **ouvrir la fiche d'une annonce, contacter le vendeur et voir ce que produit
votre annonce**, et enfin **être prévenu des nouvelles annonces qui correspondent à votre besoin** (notifications). **Aucun SMS n'est envoyé, aucun vrai site n'est contacté et aucun argent réel n'est
utilisé** (la recharge du porte-monnaie passe par une page de paiement SIMULÉ) : c'est un essai local, entièrement simulé.

> **Pour présenter noma à quelqu'un** (investisseur, partenaire) : `DEMO.md` donne un marché de démonstration prêt à l'emploi (`npm run demo:seed`, trois comptes aux numéros fixes), un parcours de 10 minutes et ce qu'il faut dire à chaque écran.

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

   **La base d'essai doit être migrée jusqu'au bout : 25 migrations** (de `0001` à `0020`, puis `0021`, `0022`, `0023`, `0024` et `0025` ; dont le porte-monnaie `0014`,
   l'achat de boost `0015`, la portée visible d'un devis de boost `0016`, son estimation bornée `0017`, les mesures d'efficacité
   `0018` : ouvertures de la fiche et contacts, les notifications et le suivi des besoins `0019`, les favoris, la messagerie en direct, les commandes et l'administration `0020`, l'offre Pro : plans, abonnements, crédits promotionnels, import de catalogue `0021`, les photos des annonces `0022`, l'historique des prix demandés `0023`, le journal des envois de SMS `0024`, et la collecte d'annonces externes mutualisée `0025`). Si votre base d'essai a
   été créée avant ces lots, relancez simplement la deuxième commande ci-dessus (elle n'applique que ce qui manque). Contrôle : la
   commande suivante doit afficher `25`.

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
   `dev:try` n'envoie jamais de vrai SMS : même si une clé de fournisseur SMS est présente dans votre terminal, elle n'est pas transmise au serveur (voir `SMS.md`).

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
   alors « Mise en avant visible auprès de X acheteur(s) » (sans jamais dire qui ; « d'environ X acheteurs, ou plus » quand l'estimation a été limitée à
   quelques dizaines de besoins : c'est un minimum ; l'écran n'affiche jamais le nombre exact : « moins de 5 acheteurs » de 0 à 4, « environ 10 acheteurs » à partir de 5). Tant que votre porte-monnaie est vide, le bouton
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
9. **Acheteur** : **ouvrir la fiche d'une annonce et contacter le vendeur**. Dans les résultats, chaque carte a un bouton « Voir l'annonce » :
   la fiche montre le titre, le prix, l'état, la localisation, la compatibilité, les indicateurs en mots simples, le badge « Sponsorisé »
   quand il y a lieu et la date de l'annonce, **sans jamais montrer le numéro du vendeur**. « Contacter le vendeur » révèle alors son
   numéro vérifié, avec un bouton « Appeler » et un lien WhatsApp, et dit : « Le vendeur verra que vous l'avez contacté via noma. »
   (le vendeur voit un compteur, jamais votre nom ni votre numéro). On ne peut ouvrir que les annonces de **ses propres
   correspondances** ; une annonce mise en pause, retirée ou vendue n'est plus joignable (« Cette annonce n'est plus disponible ») et
   un même acheteur peut joindre au plus **20 vendeurs différents par jour**.
10. **Vendeur** : sur l'annonce, la section **« Ce que produit votre annonce »** montre, sur 7 jours, 30 jours et depuis la publication,
    les besoins correspondants, les acheteurs qui ont **ouvert** l'annonce et ceux qui vous ont **contacté** ; **sans boost**, l'écran dit
    « Aucun boost sur cette annonce : tout est organique. » et ne montre aucune ligne « pendant un boost » ni « attribué au boost ». **Avec un boost**, il ajoute
    les apparitions dans les résultats (pendant le boost), la part attribuée au boost (l'acheteur avait vu l'annonce sponsorisée dans les 7 jours qui précèdent), la
    part organique, puis, par boost, ses chiffres et deux taux. **L'écran n'affiche jamais un compte exact** : **« moins de 5 »** de 0 à 4 acheteurs (zéro compris), **« environ 5 »** de 5 à 8,
    **« environ 10 »** de 9 à 12, puis le multiple de 5 le plus proche ; un pourcentage s'affiche « environ 70 % » (dizaine de pour cent, calculé sur les nombres affichés) et n'existe que si les deux
    nombres affichés valent au moins 10, sinon « pas assez d'acheteurs pour un pourcentage ». Une phrase sous les chiffres le rappelle : « Pour protéger les acheteurs, les chiffres sont arrondis à 5 près et les petits nombres ne sont pas
    détaillés. » Pour voir des « environ N », créez **cinq comptes acheteurs** (autres fenêtres de navigation privée) qui activent un besoin pour le même produit, ouvrent la fiche et contactent le vendeur, puis appuyez sur
    « Actualiser » sous « Ce que produit votre annonce » : avec un à quatre acheteurs, tout reste « moins de 5 » ; à partir de cinq, « environ 5 » apparaît (`MESURES.md`).
    « Ouverture » veut dire que la page de l'annonce a été servie, pas qu'elle a été lue ; aucune vente n'est mesurée (`MESURES.md`).
11. **Acheteur** : **voir une notification** (`NOTIFICATIONS.md`). Quand une **annonce nouvelle pour votre besoin** (publiée ou modifiée après son activation) correspond pour la première fois à ce besoin, le worker écrit une notification : une
    **pastille** avec le nombre de notifications non lues apparaît sur l'onglet « Alertes » de la navigation (appuyez sur « Alertes » ou rechargez la page ; la pastille est relue à
    l'arrivée sur une page et au retour au premier plan, jamais plus d'une fois par minute) et sur le lien « Notifications » de la page « Mes besoins ». Ouvrez-le : la page
    **Notifications** montre la liste (les non lues en gras), le prix de l'annonce et « Voir l'annonce » (la fiche de l'étape 9). « Tout marquer comme lu » éteint la pastille. Pour en
    voir plusieurs d'un coup, lancez `dev:seed` (étape 4) *après* avoir activé le besoin : au plus **20 notifications par besoin et par jour**, puis une seule notification de résumé
    (« N nouvelles annonces pour ce besoin »). Sur la page d'un besoin actif, « **Suivi actif jusqu'au …** » (30 jours par défaut) : « Prolonger de 30 jours » (90 jours au plus à partir
    d'aujourd'hui), « Mettre en pause » et « Reprendre ». **Pendant une pause ou après la fin du suivi, les résultats restent à jour : seules les notifications s'arrêtent** ; une
    nouvelle annonce publiée pendant une pause n'est jamais notifiée. **Créer ou modifier un besoin ne notifie jamais** les annonces déjà en ligne (relever un budget non plus) : vous les avez déjà sous
    les yeux dans vos résultats ; seules les annonces publiées (ou modifiées) ensuite notifient. « Tout marquer comme lu » ne marque que les notifications affichées : celles arrivées depuis le
    chargement de la page restent non lues. Au plus **50 notifications par jour** pour tous vos besoins ensemble ; au-delà, elles vont dans le résumé de leur besoin (qui redevient non lu à chaque ajout).
12. **Acheteur** : **activer l'envoi par SMS simulé** (facultatif). Sur la page « Compte », la carte « Notifications par SMS » a un interrupteur « Me prévenir par SMS (simulé) »,
    **désactivé par défaut**, et dit « Les envois par SMS ne sont pas encore disponibles : ils sont simulés en développement. » **Aucun vrai SMS n'existe** : le seul « envoi » écrit une ligne dans le
    terminal du worker, et **seulement** si vous lancez l'essai avec la variable `NOMA_DEV_NOTIFY_CONSOLE=1` (avec `dev:try`, qui transmet votre environnement au worker) :

    ```
    NOMA_DEV_NOTIFY_CONSOLE=1 DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_essai' npm run dev:try
    ```

    Activez l'interrupteur, puis faites publier une annonce correspondante par le vendeur : une ligne `[notify:dev] envoi simulé à 0f1e2d3c… : 1 annonce, lien /notifications` apparaît (identifiant
    tronqué, nombre d'annonces et lien, rien d'autre). Les notifications en attente d'un même compte partent en **un seul message** (la rafale de 12 annonces de `dev:seed` donne un message, pas douze) :
    le premier envoi attend **quinze minutes** (fenêtre de collecte), puis **4 heures au moins** séparent deux messages, **3 messages par jour au plus**, **jamais entre 22 h et 7 h** (heure UTC, celle d'Abidjan : le message
    attend alors 7 h). Ce qui ne peut pas partir est **reporté**, jamais perdu pour cause de plafond ; un envoi en attente depuis plus de 48 h sort du canal externe (la notification reste dans l'application).
    Enfin, tout est revérifié au moment d'envoyer (besoin encore actif et suivi, annonce encore en ligne et toujours correspondante, choix encore actif). Un besoin satisfait ou
    archivé annule les envois en attente. Sans `NOMA_DEV_NOTIFY_CONSOLE=1`, ou hors développement, **aucun envoi n'a lieu** (le choix est enregistré, rien n'est envoyé).
13. **Acheteur et vendeur** : **voir les prix demandés dans les annonces** (`HISTORIQUE-PRIX.md`). Sur la fiche d'une annonce, l'encart **« Prix demandés dans les annonces »** donne la **médiane** des prix demandés par les
    vendeurs pour ce produit (« Ce sont des prix demandés par les vendeurs, pas des prix payés »), « La moitié des prix demandés est entre X et Y » (à partir de 10 vendeurs ; en dessous, la médiane seule), des effectifs
    **arrondis** (« environ 15 annonces d'environ 10 vendeurs », jamais un compte exact), les annonces aux prix atypiques écartées, la période (« Sur les 90 derniers jours » ; boutons 30 jours / 90 jours / 1 an), contre quoi le prix est
    comparé (« Comparé à : iPhone 12 128 Go, tous états confondus » : ce qui n'est pas précisé est toujours dit) et, quand le marché est assez grand (20 vendeurs par semaine), une mini-courbe de la médiane par semaine.
    **Aucun prix de vente n'est publié**, ni sur la fiche ni dans le formulaire : les ventes sont déclarées par l'acheteur et confirmées par le vendeur sans vérification. **Une seule valeur compte par vendeur** (la médiane de ses annonces) : un vendeur qui publie dix annonces ne pèse pas plus qu'un
    autre. **Sous les seuils, l'écran dit « Pas assez de données » et ne montre aucun chiffre** : il faut au moins **5 vendeurs différents**. Pour remplir l'encart tout de suite, lancez
    `npm run demo:seed` (étape de démonstration, base `noma_essai`) : il écrit **90 jours de relevés SYNTHÉTIQUES** (annonces de 24 vendeurs fictifs et ventes fictives, rejouable sans doublon) ; ce sont des
    données de démonstration, pas des prix réels. Côté vendeur, sur « Nouvelle annonce », dès que la catégorie, la marque et le modèle sont saisis, une ligne verte sous le prix dit « Prix demandés dans les annonces pour ce
    produit : médiane 162 500 FCFA (environ 65 annonces d'environ 20 vendeurs, 90 jours). Comparé à : iPhone 12 128 Go, Occasion. » (rien sous les seuils ; décochez l'état : « … tous états confondus »). Chaque annonce publiée est relevée une
    fois par jour par le worker (et à chaque changement de prix) ; un jour où le worker n'a pas tourné reste un trou. L'administrateur voit le tableau **« Marché »** (`/admin/marche`) : les prix demandés par produit et un
    **nombre arrondi** de ventes confirmées (« environ 15 ventes confirmées »), jamais un prix de vente.

13. **Vendeur et acheteur** : **photos des annonces**. Sur la page d'une annonce du vendeur, section « Photos » : « Ajouter des photos » (JPEG, PNG ou WebP, 5 Mo au plus, 4 100 pixels au plus de chaque côté et 12,5 mégapixels au plus, 6 photos au plus), aperçu et barre de progression, « Mettre en couverture », reculer/avancer, suppression en deux temps ; le rappel « N'écrivez pas votre numéro sur les photos : l'acheteur vous contacte par noma. » est affiché. Dans le formulaire « Nouvelle annonce », le champ « Photos (facultatif) » fait de même : les photos partent après la création de l'annonce. Côté acheteur, la **vignette de couverture** apparaît dans les résultats et la **galerie** sur la fiche. Les informations cachées dans une photo (lieu GPS, date, appareil, profil de couleur) sont retirées avant le stockage ; un fichier qui n'est pas une vraie photo JPEG, PNG ou WebP est refusé avec une phrase simple. Les fichiers sont rangés dans le dossier `NOMA_MEDIA_DIR` (par défaut `data/media`, ignoré par git) ; `npm run media:gc` (simulation par défaut, `-- --apply` pour supprimer) nettoie les fichiers orphelins. Un autre compte (sans correspondance avec l'annonce) qui ouvre l'adresse d'une photo obtient « introuvable ». Limite : un numéro écrit DANS une photo n'est pas détecté. Voir `PHOTOS.md`.

14. **Acheteur** : voir la section **« Sur d'autres sites »** sous les résultats d'un besoin (collecte d'annonces externes, **sources FICTIVES « Annonces Démo A » et « Annonces Démo B », aucun site contacté**). Elle apparaît après `npm run demo:seed` (annonces fictives pour les trois besoins de l'acheteur démo), ou en lançant l'essai avec `NOMA_EXTERNAL_FAKE=1` (le worker collecte alors toutes les 6 h par produit, jamais une fois par besoin) ; chaque annonce porte la mention « Annonce trouvée sur … : noma ne garantit ni le prix ni la disponibilité ; vous serez redirigé vers le site. » et un lien qui s'ouvre dans un nouvel onglet. L'administrateur voit l'état de la collecte sur `/admin/collecte` (lecture seule). Voir `COLLECTE-EXTERNE.md`.

## La recherche rapide de la page d'accueil

Dans cet essai, la recherche rapide montre **des résultats d'exemple** (annonces fictives) : elle ne contacte aucun vrai site,
n'appelle aucune intelligence artificielle et ne demande aucun contrôle anti-robot.

## Comment lire les résultats

- **Compatibilité** : à quel point l'offre correspond à ce que vous cherchez (en pourcentage).
- **Prix** : « en dessous du marché », « dans la moyenne », « au-dessus du marché » ou « marché insuffisant pour comparer ».
- **Disponibilité** : « confirmée récemment », « à reconfirmer », « non renseignée »…
- **Confiance** : élevée, moyenne ou faible, d'après l'ancienneté du compte et le soin apporté à l'annonce.
- **Voir l'annonce / Contacter le vendeur** : la fiche d'une annonce de vos correspondances ; le numéro du vendeur n'apparaît qu'après « Contacter le vendeur ».
- **Sponsorisé** : le vendeur a payé pour mettre son offre en avant, **mais seulement parmi des offres déjà pertinentes** ; cela ne
  rend jamais une offre qui ne convient pas plus visible qu'une offre qui convient. (Dans cet essai, le « paiement » est simulé :
  aucun argent réel.)

## Arrêter

Dans le terminal : **Ctrl+C**. Tout s'arrête (le serveur, le worker et le relais). Vos données restent dans la base d'essai.
Les mesures (ouvertures, contacts, apparitions) sont conservées 400 jours ; `npm run metrics:purge` (simulation par défaut,
`-- --apply` pour supprimer) retire les lignes plus anciennes (`MESURES.md`). Les notifications sont conservées 90 jours après leur lecture et 180 jours au plus ;
`npm run notifications:purge` (simulation par défaut, `-- --apply` pour supprimer) retire les plus anciennes (`NOTIFICATIONS.md`).

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
| « Cette annonce n'est plus disponible pour votre besoin, ou elle n'existe pas. » | La fiche n'est servie que pour une annonce de vos correspondances actuelles : retournez aux résultats de votre besoin et « Actualiser ». |
| « Cette annonce n'est plus disponible : le vendeur l'a mise en pause, retirée ou vendue. Aucun contact n'a été enregistré. » | Rien n'a été révélé : revenez plus tard ou choisissez une autre annonce. |
| Aucune notification alors qu'une annonce correspond | Le besoin doit être **actif**, son suivi ni en pause ni terminé (« Suivi actif jusqu'au … » sur la page du besoin), et l'annonce doit correspondre **pour la première fois** et être **nouvelle pour le besoin** (publiée ou modifiée après son activation ou sa dernière modification : les annonces déjà en ligne quand vous créez ou modifiez un besoin sont dans vos résultats, sans notification). Patientez quelques secondes (le worker compare les annonces), puis rechargez la page. |
| La ligne `[notify:dev]` n'apparaît pas | L'essai doit être lancé avec `NOMA_DEV_NOTIFY_CONSOLE=1` (étape 12), l'interrupteur « Me prévenir par SMS (simulé) » doit être activé **avant** la naissance de la notification, et le message ne part qu'après la fenêtre de collecte de quinze minutes (puis 4 heures au moins entre deux messages), jamais entre 22 h et 7 h UTC (il attend alors 7 h). Chercher dans le terminal du worker (lignes `[matching]`). |
| « Vous avez déjà contacté 20 vendeurs aujourd'hui. Réessayez demain. » | Limite de 20 vendeurs différents par jour et par acheteur (jour UTC) ; un vendeur déjà contacté reste joignable. |
| « moins de 5 » à la place d'un nombre d'acheteurs, « pas assez d'acheteurs pour un pourcentage » | Normal : un compte exact n'est jamais publié (protection des acheteurs) : « moins de 5 » de 0 à 4, « environ N » ensuite (arrondi à 5 près). Il faut au moins 5 acheteurs distincts pour voir « environ 5 », et des nombres affichés d'au moins 10 pour voir un pourcentage. |
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
n'existe qu'en développement : **ne définissez jamais ces variables en production**. Le transport de notification simulé suit la même règle : `NOMA_DEV_NOTIFY_CONSOLE=1` n'est
honorée qu'avec `NODE_ENV=development` (comme `NOMA_DEV_OTP_CONSOLE`) ; avec toute autre valeur de `NODE_ENV`, elle est refusée (un avertissement, aucun envoi).
