# Présenter noma à des investisseurs (démonstration sur votre ordinateur)

Ce guide est écrit pour vous, fondateur, pas pour un développeur. Tout se passe **sur votre ordinateur**, sans mise en ligne.
**Aucun SMS n'est envoyé, aucun vrai site n'est contacté, aucun argent réel n'est utilisé** (voir « Ce qui est simulé » plus bas).

## Avant la démonstration (à faire la veille, 10 minutes)

1. **Démarrer la base de données** (si ce n'est pas déjà fait) :

   ```
   npm run postgres:up
   ```

2. **Créer la base de démonstration** (une seule fois, elle s'appelle `noma_essai`) puis la préparer :

   ```
   docker exec deploy-postgres-1 createdb -U noma_local noma_essai
   DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_essai' npm run db:migrate
   ```

   Si la base existe déjà, ne refaites que la deuxième commande : elle n'applique que ce qui manque.

3. **Remplir la base avec le marché de démonstration** :

   ```
   DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_essai' npm run demo:seed
   ```

   Ça prend une quinzaine de secondes. La commande affiche à la fin les trois comptes de démonstration. **Vous pouvez la relancer autant de fois que vous voulez** : elle ne crée rien en double (si le boost du vendeur a expiré après 7 jours, elle le renouvelle). Elle refuse de s'exécuter sur une autre base que `noma_essai`, `noma_e2e` ou `noma_essai_…` (jamais `noma_dev`).

4. **Arrêter votre serveur habituel (port 3210)** : `npm run dev:try` refuse de démarrer tant que le serveur `next dev` de ce dossier tourne. Pour l'arrêter :

   ```
   ss -ltnp | grep 3210
   ```

   Repérez le numéro après `pid=`, puis `kill <ce numéro>`. (Ou faites Ctrl+C dans le terminal où il tourne.) Vérifiez qu'il ne reste rien sur le port : `ss -ltnp | grep 3210` ne doit plus rien afficher.

5. **Lancer la démonstration** :

   ```
   DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_essai' npm run dev:try
   ```

   Attendez le grand encadré **« noma est prêt »**, puis ouvrez **http://localhost:3212** (le port 3212, pas 3211). Laissez ce terminal visible : **c'est là que s'affichent les codes de connexion**.

6. **Où lire le code de connexion** : quand vous saisissez un numéro et appuyez sur « Recevoir un code », une ligne apparaît dans ce terminal :

   ```
   [auth:dev] code OTP pour +***********01 : 123456 (expire à 12:34:56 UTC)
   ```

   Les 6 chiffres après les deux-points sont le code. Un seul code par minute et par numéro : si vous vous êtes trompé, attendez une minute.

7. **Les comptes de démonstration** (numéros fixes, à saisir dans la page de connexion) :

   | Rôle | Numéro | Ce qu'il y a dedans |
   | --- | --- | --- |
   | Acheteur démo | `07 00 00 01 01` | 3 besoins actifs (iPhone 12, MacBook Air M1, Galaxy S21) avec des annonces qui correspondent, 3 notifications non lues |
   | Vendeur démo | `07 00 00 02 02` | 4 annonces en ligne (dont l'iPhone 12, boosté), 25 000 FCFA de crédits, des acheteurs qui ont ouvert et contacté |
   | Admin démo | `07 00 00 03 03` | prévu pour la prochaine étape (l'espace admin affiche « Bientôt disponible ») |

   **Astuce** : ouvrez deux fenêtres, une normale pour l'acheteur et une **fenêtre de navigation privée** pour le vendeur : vous passez de l'une à l'autre sans vous reconnecter.

8. **Pour arrêter** à la fin : **Ctrl+C** dans le terminal de `dev:try`. Tout s'arrête (serveur, calcul des correspondances, relais). Vos données restent dans la base. Vous pourrez ensuite relancer votre serveur habituel (`next dev -p 3210`).

## Le parcours de 10 minutes

### Avant de commencer (30 secondes)

Page d'accueil sans compte. **Dites** : « noma, c'est l'inverse d'un site d'annonces. L'acheteur ne parcourt rien : il dit ce qu'il cherche, et seules les annonces qui correspondent lui sont montrées. Il n'y a aucune vitrine publique. » Montrez les 3 étapes. Le bouton « Recherche sur d'autres sites (démonstration) » est la recherche externe, avec de fausses sources : ne l'utilisez que si on vous la demande.

### Côté acheteur (4 minutes) : fenêtre normale

1. **Connexion** : « Se connecter », numéro `07 00 00 01 01`, code lu dans le terminal. **Dites** : « Pas de mot de passe : un code par SMS. Ici le SMS est simulé, le code s'affiche chez moi. »
2. **Accueil « Explorer »** : trois besoins, chacun avec le nombre d'annonces qui correspondent (« 9 annonces correspondent », etc.) et « 3 notifications non lues ». **Dites** : « Voilà ce que l'acheteur a demandé et ce que noma a trouvé. Il n'a rien eu à chercher. » Le gros bouton **« Décrire un besoin »** ouvre le formulaire (vous pouvez en créer un devant eux : produit, budget, quartier, « Activer le besoin »).
3. **Résultats** : touchez « Je cherche un iPhone 12… ». Neuf annonces, classées par pertinence. **Dites** : « Chaque annonce a des indicateurs en mots simples : compatibilité avec le besoin, prix par rapport au marché, disponibilité, confiance dans le vendeur. » Repérez celle marquée **« Sponsorisé »** (en haut) : **dites** : « Le vendeur a payé pour être mis en avant, mais seulement parmi des offres déjà pertinentes, et c'est écrit clairement. »
4. **Fiche d'une annonce** : « Voir l'annonce » sur l'annonce sponsorisée. Prix, état, quartier, caractéristiques, date. **Dites** : « Remarquez : aucun numéro de téléphone. Le vendeur ne peut pas en glisser un dans son annonce : noma le refuse à la publication et le cache à l'affichage. »
5. **Contact** : « Contacter le vendeur » : le numéro vérifié apparaît, avec « Appeler » et WhatsApp. **Dites** : « Le contact est le moment qu'on mesure. Le vendeur verra qu'un acheteur l'a contacté via noma, jamais son nom ni son numéro. »
6. **Notifications** : retour à l'accueil puis « Notifications » (ou l'onglet « Alertes »). Trois nouvelles annonces, publiées **après** les besoins. **Dites** : « L'acheteur est prévenu quand une annonce correspond. Il y a des plafonds (20 par besoin et par jour, 50 par jour) pour ne jamais le harceler, et l'envoi par SMS est prévu avec des heures calmes. »

### Côté vendeur (5 minutes) : fenêtre de navigation privée

1. **Connexion** avec `07 00 00 02 02`, puis « Vendeur » dans la barre du haut si besoin (ou l'adresse `/vendeur`).
2. **Tableau de bord** : annonces en ligne, besoins correspondants (« environ 15 besoins d'acheteurs correspondent à vos annonces en ligne »), solde du porte-monnaie (25 000 FCFA), boost actif. **Dites** : « Le vendeur voit combien d'acheteurs le cherchent, sans jamais savoir qui. Les chiffres sont arrondis à 5 près pour protéger les acheteurs : un investisseur peut lire une tendance, personne ne peut remonter à un individu. »
3. **Une annonce** : touchez l'iPhone 12. La page montre « Acheteurs intéressés » (sans identité : seulement la compatibilité et la confiance) puis **« Ce que produit votre annonce »** : « environ 10 » acheteurs ont ouvert l'annonce, « environ 5 » ont contacté, parts attribuées au boost et organiques, et « pas assez d'acheteurs pour un pourcentage » quand c'est trop petit. **Dites** : « Aucune vente n'est mesurée : on mesure l'ouverture et le contact, ce qu'on sait vraiment. »
4. **Recharge simulée** : « Porte-monnaie » (en haut du tableau de bord) puis « Recharger », 5 000 FCFA, « Continuer vers le paiement ». Une page orange **« SIMULATION — aucun argent réel »** s'ouvre : « Confirmer le paiement » crédite le porte-monnaie. **Dites** : « Ici ce sera Orange Money, MTN ou Wave. Le grand livre est en partie double : chaque franc est tracé. »
5. **Boost** : ouvrez le **Galaxy S21** du vendeur, section « Booster cette annonce » : le prix pour 24 heures, 3 jours ou 7 jours, et « Mise en avant visible auprès de … acheteurs ». Choisissez une durée, « Acheter », « Confirmer l'achat » : « Boost actif jusqu'au… », le solde diminue. **Dites** : « Le boost ne se vend que s'il a un effet visible : sinon noma refuse et dit pourquoi. » (L'iPhone 12 est déjà boosté : son bandeau « Boost actif jusqu'au … » est sur le tableau de bord.)
6. **Retour côté acheteur** (fenêtre normale) : « Actualiser » sur les résultats du besoin « Samsung Galaxy S21 » : l'annonce boostée remonte avec **« Sponsorisé »**. **Dites** : « Un boost n'est ni une garantie de position, ni de vente. »

## Les questions probables d'un investisseur, et où regarder

| Question | Réponse courte | Où regarder |
| --- | --- | --- |
| « Comment gagnez-vous de l'argent ? » | Le boost : le vendeur achète une mise en avant avec des crédits rechargés. | Porte-monnaie, « Booster cette annonce » ; `WALLET.md`, `BOOST-PRICING.md` |
| « Pourquoi pas une simple liste d'annonces ? » | Les annonces ne sont visibles que par les correspondances d'un besoin : pas de vitrine à scraper, des contacts qualifiés. | Accueil (aucune annonce publique), `MATCHING-STORED-READ.md` |
| « Les vendeurs peuvent-ils contourner la plateforme ? » | Pas de numéro dans une annonce (refusé, puis caché même s'il passe) ; le numéro ne se révèle qu'au contact, qui est compté. | `lib/phone-text.ts`, `MESURES.md` |
| « Comment prouvez-vous que ça marche pour le vendeur ? » | Ouvertures et contacts, attribuables ou non à un boost, arrondis. | « Ce que produit votre annonce », `MESURES.md` |
| « Et la vie privée des acheteurs ? » | Jamais d'identité côté vendeur ; chiffres arrondis à 5 ; petits nombres non détaillés ; un test adversaire le démontre. | `MESURES.md`, `tests/server/metrics-adversary.test.ts` |
| « Le paiement est-il réel ? » | Non, il est simulé ; le grand livre et la réconciliation sont réels. | `WALLET.md`, `npm run wallet:check` |
| « Et les SMS ? » | Simulés ; les règles d'envoi (15 min de collecte, 4 h entre deux messages, 3 par jour, pas de 22 h à 7 h) sont codées. | `NOTIFICATIONS.md`, page Compte |
| « C'est solide ? » | Plus de 1 600 tests automatiques, des parcours de bout en bout dans un vrai navigateur. | `npm test`, `ESSAYER.md` |
| « Qu'est-ce qui n'est pas fait ? » | Messagerie, commandes, favoris, comparaison, espace admin, profil vendeur : écrans « Bientôt disponible ». | `ROADMAP.md` |

## Ce qui est simulé, et ce qui ne l'est pas

**Simulé (jamais de vrai envoi ni de vrai débit) :**

- le **paiement** : la recharge passe par un prestataire fictif et une page « SIMULATION — aucun argent réel » ;
- les **SMS** : le code de connexion s'affiche dans le terminal ; les envois de notification n'existent qu'en ligne de terminal (`NOMA_DEV_NOTIFY_CONSOLE=1`) ;
- les **sources de la recherche externe** : annonces fictives, aucun site contacté ;
- les **vendeurs et acheteurs fictifs** du marché de démonstration (numéros `+225 07 88 88 88 01` à `07`, et `+225 07 66 66 66 01` à `11`, qui n'appartiennent à personne) ;
- les **ouvertures et contacts** des acheteurs fictifs.

**Réel (le vrai code, la vraie base) :**

- la création, la publication et la modification des annonces et des besoins ;
- le **calcul des correspondances** et des indicateurs (compatibilité, prix, disponibilité, confiance) ;
- le **boost** : attribution, places limitées, ordre de priorité, effet visible exigé ;
- le **grand livre du porte-monnaie** et les remboursements ;
- les **notifications** (création, plafonds, suivi d'un besoin) ;
- les **statistiques arrondies** et la protection des acheteurs ;
- la **connexion** par code, les sessions, les contrôles d'accès (un compte ne voit jamais les données d'un autre).

## Si quelque chose ne va pas

| Ce que vous voyez | Ce qu'il faut faire |
| --- | --- |
| « Un serveur next dev tourne déjà dans ce dossier » | Arrêtez le serveur du port 3210 (étape 4). |
| « DATABASE_URL est obligatoire » | Ajoutez `DATABASE_URL='…'` devant la commande, comme ci-dessus. |
| « Trop de demandes de code » | Attendez une minute avant de redemander un code pour le même numéro. |
| Un besoin affiche « Recherche en cours… » | Appuyez sur « Actualiser » : le calcul des correspondances tourne en arrière-plan. |
| Un boost « ne ferait monter votre annonce chez aucun acheteur » | Normal : il faut au moins 7 annonces dans la liste de l'acheteur (c'est le cas pour l'iPhone 12 et le Galaxy S21, pas pour le MacBook ni la machine à laver). |
| La petite pastille « N » en bas à gauche | C'est l'indicateur du mode développement de Next : sans effet, on peut la masquer dans ses réglages. |
| Vous voulez repartir de zéro | Supprimez la base (`docker exec deploy-postgres-1 dropdb -U noma_local noma_essai`), recréez-la et relancez les étapes 2 et 3. |

Le guide technique de l'essai local reste `ESSAYER.md`.
