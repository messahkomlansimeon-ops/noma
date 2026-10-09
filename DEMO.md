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

   Les 6 chiffres après les deux-points sont le code. **Limites des demandes de code** (d'après `lib/server/auth/otp.ts`), par numéro : **1 code par minute**, **3 codes par tranche de 15 minutes** (tranches fixes sur l'horloge : :00, :15, :30, :45) et **10 codes par jour** (jour UTC) ; par adresse de connexion : 60 défis non vérifiés par 15 minutes glissantes et 300 par 24 heures glissantes (lot SMS1-ter ; un code vérifié ne compte plus). Si vous vous êtes trompé, attendez une minute ; après 3 demandes dans la même tranche de 15 minutes, attendez la tranche suivante.

7. **Les comptes de démonstration** (numéros fixes, à saisir dans la page de connexion) :

   | Rôle | Numéro | Ce qu'il y a dedans |
   | --- | --- | --- |
   | Acheteur démo | `07 00 00 01 01` | 3 besoins actifs (iPhone 12, MacBook Air M1, Galaxy S21) avec des annonces qui correspondent, 3 notifications non lues, 1 favori, 1 conversation avec un vendeur fictif (3 messages) |
   | Vendeur démo | `07 00 00 02 02` | 4 annonces en ligne (dont l'iPhone 12, boosté), 25 000 FCFA de crédits, des acheteurs qui ont ouvert et contacté, 1 commande à confirmer (venant d'un acheteur fictif) |
   | Admin démo | `07 00 00 03 03` | rôle administrateur : tableau de bord, vendeurs, journal, réglages du boost |

   **Astuce** : ouvrez deux fenêtres, une normale pour l'acheteur et une **fenêtre de navigation privée** pour le vendeur : vous passez de l'une à l'autre sans vous reconnecter. Pour la messagerie en direct, placez les deux fenêtres **côte à côte** (voir « Messagerie en direct »).

   **Le rôle d'administrateur** ne s'attribue que par une commande (jamais depuis l'application) : `demo:seed` la lance pour le compte Admin démo. Pour un autre compte : `DATABASE_URL='…' npm run admin:grant -- "07 00 00 00 42"`. Elle refuse de s'exécuter en production sans `NOMA_ADMIN_GRANT_PRODUCTION=1`.

8. **Pour arrêter** à la fin : **Ctrl+C** dans le terminal de `dev:try`. Tout s'arrête (serveur, calcul des correspondances, relais). Vos données restent dans la base. Vous pourrez ensuite relancer votre serveur habituel avec `npx next dev -p 3210` (depuis ce dossier).

## Le parcours de 10 minutes

### Avant de commencer (30 secondes)

Page d'accueil sans compte. **Dites** : « noma, c'est l'inverse d'un site d'annonces. L'acheteur ne parcourt rien : il dit ce qu'il cherche, et seules les annonces qui correspondent lui sont montrées. Il n'y a aucune vitrine publique. » Montrez les 3 étapes. Le bouton « Recherche sur d'autres sites (démonstration) » est la recherche externe, avec de fausses sources : ne l'utilisez que si on vous la demande.

### Côté acheteur (4 minutes) : fenêtre normale

1. **Connexion** : « Se connecter », numéro `07 00 00 01 01`, code lu dans le terminal. **Dites** : « Pas de mot de passe : un code par SMS. Ici le SMS est simulé, le code s'affiche chez moi. »
2. **Accueil « Explorer »** : trois besoins, chacun avec le nombre d'annonces qui correspondent (« 9 annonces correspondent », etc.) et « 3 notifications non lues ». **Dites** : « Voilà ce que l'acheteur a demandé et ce que noma a trouvé. Il n'a rien eu à chercher. » Le gros bouton **« Décrire un besoin »** ouvre le formulaire (vous pouvez en créer un devant eux : produit, budget, quartier, « Activer le besoin »).
3. **Résultats** : touchez « Je cherche un iPhone 12… ». Neuf annonces, classées par pertinence. **Dites** : « Chaque annonce a des indicateurs en mots simples : compatibilité avec le besoin, prix par rapport au marché, disponibilité, confiance dans le vendeur. » Repérez celle marquée **« Sponsorisé »** (en haut) : **dites** : « Le vendeur a payé pour être mis en avant, mais seulement parmi des offres déjà pertinentes, et c'est écrit clairement. »
4. **Fiche d'une annonce** : « Voir l'annonce » sur l'annonce sponsorisée. Prix, état, quartier, caractéristiques, date. **Dites** : « Remarquez : aucun numéro de téléphone. noma refuse à la publication les numéros qu'il reconnaît dans l'annonce et les cache à l'affichage s'il en passe un. » (La règle et sa limite sont expliquées dans « Les numéros dans les annonces » plus bas : ne promettez pas que rien ne passe.)
5. **Contact** : « Contacter le vendeur » : le numéro vérifié apparaît, avec « Appeler » et WhatsApp. **Dites** : « Le contact est le moment qu'on mesure. Le vendeur verra qu'un acheteur l'a contacté via noma, jamais son nom ni son numéro. »
6. **Notifications** : retour à l'accueil puis « Notifications » (ou l'onglet « Alertes »). Trois nouvelles annonces, publiées **après** les besoins. **Dites** : « L'acheteur est prévenu quand une annonce correspond. Il y a des plafonds (20 par besoin et par jour, 50 par jour) pour ne jamais le harceler, et l'envoi par SMS est prévu avec des heures calmes. »
7. **Sur d'autres sites** : en bas des résultats de l'iPhone 12, la section **« Sur d'autres sites »** (annonces des sources FICTIVES « Annonces Démo A » et « Annonces Démo B », aucun site contacté), à part, sans « Sponsorisé », avec la mention « noma ne garantit ni le prix ni la disponibilité ; vous serez redirigé vers le site » et un lien en nouvel onglet. **Dites** : « Une collecte sert tous les acheteurs qui cherchent le même produit ; une annonce vue sur deux sites n'apparaît qu'une fois ; et une panne d'un site externe ne touche jamais les résultats noma. » (Administrateur : `/admin/collecte`, lecture seule ; voir `COLLECTE-EXTERNE.md`.)

8. **Recherche active (option payante, prix provisoire)** : sur la page du besoin « Je cherche un iPhone 12… », la carte **« Recherche active »**. **Dites** : « Option payante, par besoin : 2 000 FCFA pour 30 jours, prix provisoire en attente d'une décision. Elle se paie avec les crédits payés, jamais avec les crédits promotionnels. Aucun renouvellement automatique, un avis 3 jours avant la fin, si le besoin est marqué satisfait elle est suspendue (la période continue de courir, elle reprend à la réactivation) et s'il est archivé elle s'arrête sans remboursement : c'est écrit avant l'achat. Elle n'est vendue que si des annonces d'autres sites sont réellement collectées (ici les sources FICTIVES du montage d'essai) : en production, tant qu'aucune source réelle n'existe, la carte dit « pas encore disponible ». » Touchez **« Activer — 2 000 FCFA pour 30 jours »** puis **« Confirmer l'achat »** (l'acheteur démo a 10 000 FCFA de crédits payés). **Dites** : « Les annonces des autres sites déjà présentes ne vous sont jamais envoyées : seules les nouvelles. » Dans un terminal : `npm run active-search:simulate -- --demand <identifiant du besoin>` (base d'essai uniquement ; l'identifiant : `select id from demands where raw_text like '%buyer-iphone12%'`) fait apparaître une annonce fictive compatible : la notification **« Autre site : … »** apparaît dans « Notifications » et sur l'accueil, et son lien mène à la page du besoin, jamais au site. Côté administration, `/admin/recherche-active` : options en vigueur arrondies à 5 près et revenus du mois. **Dites** : « Le besoin interne d'une mission d'achat en volume (voir plus bas) n'a pas cette option : il n'est pas dans "Mes besoins", l'option ne s'y lit ni ne s'y achète, et il n'accélère jamais la collecte. »

### Côté vendeur (5 minutes) : fenêtre de navigation privée

1. **Connexion** avec `07 00 00 02 02`, puis « Vendeur » dans la barre du haut si besoin (ou l'adresse `/vendeur`).
2. **Tableau de bord** : annonces en ligne, besoins correspondants (« environ 15 besoins d'acheteurs correspondent à vos annonces en ligne »), solde du porte-monnaie (25 000 FCFA), boost actif. **Dites** : « Le vendeur voit combien de besoins d'acheteurs correspondent à ses annonces (un besoin qui correspond à plusieurs de ses annonces compte une seule fois), sans jamais savoir qui. Ce total, comme toutes les statistiques, est arrondi à 5 près pour protéger les acheteurs : un investisseur peut lire une tendance, personne ne peut remonter à un individu. »
3. **Une annonce** : touchez l'iPhone 12. La page montre « Acheteurs intéressés » : la **liste des besoins, un par un, sans identité** (budget, quartier, compatibilité, confiance), avec la phrase « Chaque ligne est le besoin d'un acheteur, sans son identité. ». **Aucun compte de besoins n'est affiché sur cette page** (ni au-dessus de la liste, ni dans les statistiques) : la liste fait foi, et le tableau de bord, qui n'a pas de liste, garde le compte arrondi des besoins distincts. La liste se lit par pages de 20 : **« Voir plus » n'apparaît qu'au-delà de 20 besoins**, il n'y en a donc pas pour l'iPhone 12 de la démonstration (une douzaine de lignes). Puis **« Ce que produit votre annonce »** : « environ 10 » acheteurs ont ouvert l'annonce, « environ 5 » ont contacté, parts attribuées au boost et organiques, et « pas assez d'acheteurs pour un pourcentage » quand c'est trop petit. **Dites** : « L'arrondi protège les statistiques (apparitions, ouvertures, contacts, ventes) ; les besoins, eux, sont montrés un par un, anonymes, parce que c'est le produit. On mesure l'ouverture et le contact ; une vente ne compte que si l'acheteur la déclare et que le vendeur la confirme (voir plus bas). »
4. **Recharge simulée** : « Porte-monnaie » (en haut du tableau de bord) puis « Recharger », 5 000 FCFA, « Continuer vers le paiement ». Une page orange **« SIMULATION — aucun argent réel »** s'ouvre : « Confirmer le paiement » crédite le porte-monnaie. **Dites** : « Ici ce sera Orange Money, MTN ou Wave. Le grand livre est en partie double : chaque franc est tracé. »
5. **Boost** : ouvrez le **Galaxy S21** du vendeur, section « Booster cette annonce » : le prix pour 24 heures, 3 jours ou 7 jours, et « Mise en avant visible auprès de … acheteurs ». Choisissez une durée, « Acheter », « Confirmer l'achat » : « Boost actif jusqu'au… », le solde diminue. **Dites** : « Le boost ne se vend que s'il a un effet visible : sinon noma refuse et dit pourquoi. » (L'iPhone 12 est déjà boosté : son bandeau « Boost actif jusqu'au … » est sur le tableau de bord.)
6. **Retour côté acheteur** (fenêtre normale) : « Actualiser » sur les résultats du besoin « Samsung Galaxy S21 » : l'annonce boostée remonte avec **« Sponsorisé »**. **Dites** : « Un boost n'est ni une garantie de position, ni de vente. »

### Favoris, messagerie en direct, commande, administration (5 minutes)

1. **Favoris** (acheteur) : sur la fiche de l'iPhone 12 « Sponsorisé », touchez le **cœur** : l'annonce est gardée de côté. Onglet **Favoris** : titre, prix, statut (« En ligne ») et le lien « Voir l'annonce » qui rouvre la fiche dans le contexte de votre besoin. Retirez-la avec le cœur. **Dites** : « Une annonce qui n'est plus en ligne reste dans la liste, avec la mention “n'est plus disponible” et sans prix. »
2. **Messagerie en direct** (deux fenêtres côte à côte : acheteur à gauche, vendeur à droite) : l'acheteur touche **« Écrire au vendeur »** sur la fiche de l'iPhone 12. Un petit rappel apparaît la première fois : « Pour votre sécurité, ne payez jamais avant d'avoir vu l'objet. » L'acheteur écrit un message. À droite, le vendeur ouvre **Messages** (onglet du bas, avec une pastille) : la conversation est là, en gras, avec « Acheteur intéressé » (jamais un nom ni un numéro). Il l'ouvre. **Maintenant écrivez dans l'une des fenêtres : le message apparaît dans l'autre en une fraction de seconde, sans recharger.** Le mot « En direct » sous le titre le confirme. **Dites** : « Le vendeur peut répondre, jamais écrire le premier. Un acheteur ne peut ouvrir qu'une conversation pour une annonce de ses correspondances. Les numéros ne sont pas bloqués ici : le contact direct est voulu. » (Essayez d'écrire `<b>test</b>` : le texte s'affiche tel quel, rien n'est interprété.)
3. **Commande (vente déclarée)** : dans la conversation, l'acheteur touche **« Je l'ai acheté »**, saisit le prix convenu (par exemple 158 000) et valide. **Dites** : « noma ne gère aucun paiement de l'objet, c'est écrit à l'écran. Cette déclaration garde une trace et alimente les statistiques du vendeur. » Côté vendeur : **Commandes** (lien du tableau de bord) : la commande est « À confirmer » (il y en a une deuxième, venue d'un acheteur fictif). Le vendeur **ouvre la commande** (touche sa ligne), puis touche **« Confirmer la vente »**. Retour sur l'annonce du vendeur : **« Ventes déclarées et confirmées : moins de 5 »** (arrondi comme les autres mesures). Côté acheteur, la commande confirmée propose de **marquer son besoin comme satisfait** (jamais automatique).
4. **Administration** (troisième fenêtre, compte `07 00 00 03 03` ; l'onglet **Admin** du sélecteur d'espace, en haut, n'est affiché qu'aux administrateurs : ni l'acheteur ni le vendeur ne le voient) : le **tableau de bord** montre des chiffres réels (comptes, annonces par statut, besoins actifs, correspondances, boosts, crédits en circulation, recharges du jour, conversations, commandes confirmées, état du calcul des correspondances). **Vendeurs** : liste paginée, numéros **masqués sauf les deux derniers chiffres** ; **Suspendre** (avec confirmation à l'écran) puis **Réactiver** : tout est inscrit au **journal d'administration** (qui, quoi, quand). **Réglages** : les réglages du boost par catégorie, en lecture seule. **Dites** : « Le rôle d'administrateur ne s'attribue que par une commande. Un compte ordinaire qui ouvre /admin obtient la page 404 (un grand « 404 » suivi, après un trait, de « This page could not be found. », en anglais), sans titre ni menu : exactement la même page, avec le même titre d'onglet, qu'une adresse qui n'existe pas. » (Essayez /admin dans la fenêtre de l'acheteur.) « Dossiers » reste « Bientôt disponible ».
5. **Photos des annonces** (lot PH1, 1 minute) : `demo:seed` a ajouté **une photo synthétique par annonce** (un aplat de couleur et un motif, fabriqués sur place, aucune image réelle). Côté acheteur, les cartes de résultats et la fiche (galerie) les montrent ; côté vendeur, le tableau de bord les montre en vignette, et la page d'une annonce permet **d'ajouter jusqu'à 6 photos** (aperçu, progression, « Mettre en couverture », suppression). **Dites** : « Les photos sont des fichiers envoyés par des utilisateurs : noma ne se fie ni au nom ni au type annoncés, relit les octets, **retire le lieu, la date, l'appareil et le profil de couleur cachés dans la photo**, refuse les formats dangereux (SVG, GIF…), et ne les montre qu'à celui qui a le droit de voir l'annonce : n'importe qui d'autre obtient la même page “introuvable”. » Essayez, dans la fenêtre d'un compte sans correspondance, d'ouvrir l'adresse d'une photo : 404. **Limite à dire franchement** : un numéro de téléphone écrit DANS une photo n'est pas détecté (ni OCR, ni IA) ; l'écran d'ajout rappelle au vendeur de ne pas le faire, et le signalement d'une photo viendra plus tard. Détails : `PHOTOS.md`.

### Missions d'achat en volume (3 minutes)

Une **mission** sert à acheter plusieurs exemplaires du même objet, chez plusieurs vendeurs, dans la limite d'un budget (`MISSIONS.md`). `demo:seed` crée une mission de démonstration pour l'acheteur démo : **10 Samsung Galaxy S21 d'occasion, 135 000 FCFA l'unité au plus**, partiellement couverte.

1. **Mes missions** (acheteur) : onglet **Compte** → **Mes missions**. La mission de démonstration montre « **0 sur 10 achetés** » et « **La proposition couvre 5 sur 10 (50 %)** ». **Dites** : « noma a trouvé cinq annonces qui correspondent, d'un vendeur chacune. Il en manque cinq. »
2. **La proposition** : touchez la mission. Cinq lignes, **Vendeur 1 à Vendeur 5** (jamais un nom ni un numéro), avec la quantité, le prix par unité et le sous-total, puis les **raisons** en mots simples (« pas encore assez d'annonces », « certaines annonces dépassent votre budget par unité »). **Dites** : « C'est une proposition, pas un ordre : noma remplit par pertinence, puis par prix, sans dépasser vos budgets ni 10 vendeurs. Ce n'est pas l'optimum mathématique, et c'est écrit dans la documentation. »
3. **Créer une mission** : **Nouvelle mission**. Essayez un numéro de téléphone dans le champ « Modèle » : il est refusé à l'écran (« Pas de numéro de téléphone dans la mission »). Puis iPhone 12, état « Occasion », quantité **8**, budget par unité **170 000**, budget total **1 400 000**, « Abidjan », « Lancer la mission ». La proposition apparaît quand le calcul des correspondances est terminé (relisez la page : quelques secondes). Elle couvre 7 sur 8.
4. **Écrire** : sur la ligne à **165 000 FCFA** (l'annonce du vendeur démo), touchez **Écrire**. La conversation s'ouvre avec un **message déjà rédigé** (« Bonjour, je souhaite acheter 1 unité de … à 165 000 FCFA l'unité… ») que vous pouvez modifier. **Rien n'est envoyé tant que vous n'appuyez pas sur « envoyer »** : le message ne dit ni le budget, ni la mission, ni les autres vendeurs.
5. **Déclarer l'achat** : retour sur la mission, **Déclarer l'achat** sur la même ligne : quantité **2**, prix **165 000** (un prix au-dessus du budget par unité, ou une quantité au-delà de ce qu'il reste, est refusé avant l'envoi). **Dites** : « noma ne gère aucun paiement de l'objet. » L'achat quitte les lignes de la proposition et passe dans « **Déjà acheté ou en attente** » (« Achat déclaré : 2, en attente du vendeur ») : la proposition ne répartit plus que le **reste** (« 2 déjà achetés ou en attente, 6 à acheter »). La mission reste à « **0 sur 8 achetés** » : seuls les achats confirmés comptent.
6. **Côté vendeur** (fenêtre privée, `07 00 00 02 02`) : **Commandes** → la commande « 2 × 165 000 FCFA » : « **Quantité demandée : 2 · Total 330 000 FCFA** ». **Dites** : « Le vendeur voit sa commande et rien d'autre : ni la mission, ni le budget de l'acheteur, ni les autres vendeurs. » Il **confirme**. Retour côté acheteur : « **2 sur 8 achetés** », la barre avance, l'achat engagé dit « Achat confirmé ». Quand la quantité totale est confirmée, la mission passe d'elle-même à « Terminée ».
7. **Suivi** : **Mettre en pause** puis **Reprendre**. Quand de nouvelles annonces correspondent, une notification « Mission : … : 7 sur 20 » prévient l'acheteur, **au plus une fois par jour et seulement si la couverture dépasse le plus haut niveau déjà vu** (le calcul tourne dans le worker). Une mission en pause ne compte plus dans les comptes de besoins du vendeur (« environ N besoins ») ; une mission finie garde son besoin 24 h avant de le retirer, pour que le vendeur ne devine pas la fin. La mission de démonstration est un Galaxy S21 et non un iPhone 12 : un besoin « iPhone 12 » de plus ferait passer « environ 10 » à « environ 15 » les besoins qui correspondent à l'annonce boostée du vendeur démo (étape « Côté vendeur » plus haut).

## Les numéros dans les annonces : ce que noma détecte, et sa limite

noma refuse à la publication une annonce dont un champ visible (catégorie, marque, modèle, variante, état, unité, localisation, attributs) porte un numéro de téléphone, avec le message « Pas de numéro de téléphone dans l'annonce (champ : variante) : l'acheteur vous contactera par noma. » ; s'il en passe un, il est caché à l'affichage (jamais servi à un acheteur). La règle (`lib/phone-text.ts`, détaillée dans `MESURES.md`) **détecte** :

- un numéro ivoirien de 10 chiffres (qui commence par 01, 05, 07, 21, 25 ou 27), quels que soient les groupes et les séparateurs (espaces, points, tirets, barres, deux-points, symboles, emoji), les chiffres de n'importe quel alphabet, une lettre O, o, l ou I à la place d'un 0 ou d'un 1 (« 07 O8 09 10 11 »), une lettre ou un mot entre les groupes (« 07x08x09x10x11 », « 07 puis 08 et 09… ») ;
- un indicatif « +225 », « 00225 » ou « 225 » suivi de 8 ou 10 chiffres, un « + » suivi de 8 à 15 chiffres (numéro international) ;
- quatre groupes de deux chiffres séparés seulement par des espaces ou des symboles (jamais par une lettre ni un mot), dont le premier commence par 0 (« 07 08 09 10 », « 06 12 34 56 78 »).

Elle **ne refuse pas** les prix à milliers et leurs fourchettes (« 12 500 000 FCFA », « 250 000 - 1 300 000 FCFA » : chaque quantité est mise de côté avant les règles, deux quantités ne forment jamais un numéro), les dimensions (« 2400×1080 »), les références, numéros de série, EAN, IMEI, **les années, les dates et les listes de modèles compatibles, de tailles ou de capacités** (« Coque compatible iPhone 11 12 13 14 », « TV 32 40 43 50 pouces », « Galaxy S21 S22 S23 S24 », « tailles 38 40 42 44 », « 24h 48h 72h 96h », « du 01/10 au 15/10 »). Les noms d'attributs ne s'écrivent qu'en lettres minuscules et tiret bas (« tel_0708 » est refusé).

**Limite à connaître** : un numéro **coupé entre plusieurs champs ou plusieurs attributs distincts** (« appel : 07 08 09 », « suite : 10 11 ») n'est **pas détecté** (les champs ne sont jamais mis bout à bout : cela refuserait des annonces honnêtes). Ne sont pas détectés non plus : un numéro écrit en toutes lettres, séparé par plus de trois symboles, ou de huit chiffres séparés par des lettres (« 07x08x09x10 » : avec des lettres, seuls les numéros de 10 chiffres à préfixe ivoirien ou à indicatif sont reconnus). À l'inverse, quatre groupes de deux chiffres dont le premier commence par 0 sont refusés même s'ils n'étaient pas un numéro (« remises 05 10 15 20 »). Dans la messagerie, les numéros ne sont volontairement pas bloqués.

## Les questions probables d'un investisseur, et où regarder

| Question | Réponse courte | Où regarder |
| --- | --- | --- |
| « Comment gagnez-vous de l'argent ? » | Le boost : le vendeur achète une mise en avant avec des crédits rechargés. | Porte-monnaie, « Booster cette annonce » ; `WALLET.md`, `BOOST-PRICING.md` |
| « Pourquoi pas une simple liste d'annonces ? » | Les annonces ne sont visibles que par les correspondances d'un besoin : pas de vitrine à scraper, des contacts qualifiés. | Accueil (aucune annonce publique), `MATCHING-STORED-READ.md` |
| « Les vendeurs peuvent-ils contourner la plateforme ? » | Les numéros que noma reconnaît (ivoiriens sous toute mise en forme, +225, internationaux) sont refusés à la publication, puis cachés à l'affichage s'il en passe un ; le numéro ne se révèle qu'au contact, qui est compté. Limite honnête : un numéro coupé entre plusieurs champs n'est pas détecté. | `lib/phone-text.ts`, `MESURES.md` (« Numéros de téléphone cachés ») |
| « Comment prouvez-vous que ça marche pour le vendeur ? » | Ouvertures et contacts, attribuables ou non à un boost, arrondis. | « Ce que produit votre annonce », `MESURES.md` |
| « Et la vie privée des acheteurs ? » | Jamais d'identité côté vendeur ; chiffres arrondis à 5 ; petits nombres non détaillés ; un test adversaire le démontre. | `MESURES.md`, `tests/server/metrics-adversary.test.ts` |
| « Le paiement est-il réel ? » | Non, il est simulé ; le grand livre et la réconciliation sont réels. | `WALLET.md`, `npm run wallet:check` |
| « Et les SMS ? » | Simulés ; les règles d'envoi (15 min de collecte, 4 h entre deux messages, 3 par jour, pas de 22 h à 7 h) sont codées. | `NOTIFICATIONS.md`, page Compte |
| « C'est solide ? » | **1 786 tests automatiques** (la somme des scripts `npm run test:*`, sur une base d'essai) et des parcours de bout en bout (`npm run e2e:core`, `e2e:ui`, `e2e:demo`, `e2e:sse`), dont des vrais navigateurs (deux navigateurs pour la messagerie en direct). | `npm run test:*`, `ESSAYER.md` |
| « Les acheteurs et les vendeurs peuvent-ils se parler ? » | Oui, en direct, dans noma : l'acheteur écrit à propos d'une annonce de ses correspondances, le vendeur répond ; ni nom ni numéro n'est affiché. | `MESSAGERIE.md` |
| « Comment suivez-vous les ventes ? » | L'acheteur déclare « Je l'ai acheté » avec un prix, le vendeur confirme ; aucun paiement de l'objet ne passe par noma. Les ventes confirmées entrent dans les statistiques du vendeur (arrondies). | `COMMANDES.md` |
| « Qui contrôle la plateforme ? » | Un espace d'administration (chiffres, vendeurs, suspension journalisée, réglages) réservé aux comptes à qui un opérateur a donné le rôle par une commande. | `ADMIN.md` |
| « Qu'est-ce qui n'est pas fait ? » | Comparaison, dossiers de modération, profil vendeur public, partage : écrans « Bientôt disponible ». | `ROADMAP.md` |

## Ce qui est simulé, et ce qui ne l'est pas

**Simulé (jamais de vrai envoi ni de vrai débit) :**

- le **paiement** : la recharge passe par un prestataire fictif et une page « SIMULATION — aucun argent réel » ;
- les **SMS** : le code de connexion s'affiche dans le terminal ; les envois de notification n'existent qu'en ligne de terminal (`NOMA_DEV_NOTIFY_CONSOLE=1`) ;
- les **sources de la recherche externe** : annonces fictives, aucun site contacté ;
- la **collecte d'annonces d'autres sites** (section « Sur d'autres sites ») : deux sources fictives, aucun site contacté, aucune source réelle activable avant validation juridique (`COLLECTE-EXTERNE.md`) ;
- la **recherche active payante** (`RECHERCHE-ACTIVE.md`) : le débit de 2 000 FCFA est simulé comme toute recharge ; les annonces « d'autres sites » viennent des deux sources fictives, et `npm run active-search:simulate` n'agit que sur une base d'essai ;
- les **vendeurs et acheteurs fictifs** du marché de démonstration (numéros `+225 07 88 88 88 01` à `07`, `+225 07 66 66 66 01` à `11`, et les six comptes fictifs de l'historique des prix `+225 07 55 55 55 01` à `06`, qui n'appartiennent à personne) ;
- les **ouvertures et contacts** des acheteurs fictifs ;
- le **vendeur de la conversation** de démonstration (un vendeur fictif), l'**acheteur fictif** de la commande à confirmer et leurs messages.

**Réel (le vrai code, la vraie base) :**

- la création, la publication et la modification des annonces et des besoins ;
- le **calcul des correspondances** et des indicateurs (compatibilité, prix, disponibilité, confiance) ;
- le **boost** : attribution, places limitées, ordre de priorité, effet visible exigé ;
- le **grand livre du porte-monnaie** et les remboursements ;
- les **notifications** (création, plafonds, suivi d'un besoin) ;
- les **statistiques arrondies** et la protection des acheteurs ;
- la **connexion** par code, les sessions, les contrôles d'accès (un compte ne voit jamais les données d'un autre) ;
- les **favoris** (limite de 200), la **messagerie en direct** (flux Server-Sent Events alimenté par PostgreSQL LISTEN/NOTIFY, limites de 30 messages par minute et 300 par jour, 20 nouvelles conversations par jour), les **notifications de nouveau message** (dans l'application seulement) ;
- les **commandes** (transitions contrôlées par la base, une seule commande active par annonce et besoin) et leur effet sur les statistiques du vendeur ;
- les **missions d'achat en volume** : proposition de répartition entre vendeurs anonymes (budgets par unité et total, stocks, 10 vendeurs au plus), achats rattachés avec leur quantité, quantité sécurisée par les seuls achats confirmés, échéance, notification de couverture (une par jour au plus) ;
- l'**administration** : chiffres, suspension et réactivation journalisées, rôle attribué seulement par commande.

## Si quelque chose ne va pas

| Ce que vous voyez | Ce qu'il faut faire |
| --- | --- |
| « Un serveur next dev tourne déjà dans ce dossier » | Arrêtez le serveur du port 3210 (étape 4). |
| « DATABASE_URL est obligatoire » | Ajoutez `DATABASE_URL='…'` devant la commande, comme ci-dessus. |
| « Trop de demandes de code » | Un code par minute et par numéro : attendez une minute. Au-delà de 3 codes dans la même tranche de 15 minutes (:00, :15, :30, :45) ou de 10 codes dans la journée UTC pour ce numéro, attendez la tranche suivante ou le lendemain (ou utilisez un autre numéro). |
| Un besoin affiche « Recherche en cours… » | Appuyez sur « Actualiser » : le calcul des correspondances tourne en arrière-plan. |
| Le message de l'autre fenêtre n'arrive pas en direct (le mot « En direct » devient « Reconnexion… ») | Le flux se rétablit tout seul avec une attente croissante (1 s, 2 s, 4 s…) et rattrape les messages manqués ; si la connexion à la base d'écoute a été coupée, relancez simplement la page. |
| Page « 404 » (« This page could not be found. ») sur /admin | Ce compte n'est pas administrateur : `npm run admin:grant -- "<numéro>"` (avec la même `DATABASE_URL`). |
| La commande de démonstration à confirmer a déjà été confirmée | Relancer `demo:seed` ne la recrée pas tant qu'une commande est active sur cette annonce pour cet acheteur ; pour rejouer la démonstration à neuf, supprimez la base et recréez-la (étapes 2 et 3). |
| Un boost « ne ferait monter votre annonce chez aucun acheteur » | Normal : il faut au moins 7 annonces dans la liste de l'acheteur (c'est le cas pour l'iPhone 12 et le Galaxy S21, pas pour le MacBook ni la machine à laver). |
| La petite pastille « N » en bas à gauche | C'est l'indicateur du mode développement de Next : sans effet, on peut la masquer dans ses réglages. |
| Vous voulez repartir de zéro | Supprimez la base (`docker exec deploy-postgres-1 dropdb -U noma_local noma_essai`), recréez-la et relancez les étapes 2 et 3. |

Le guide technique de l'essai local reste `ESSAYER.md`.
