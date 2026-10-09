# Photos des annonces (lot PH1)

Les photos sont des **fichiers envoyés par des utilisateurs** : c'est un sujet de sécurité et de vie privée. Ce document dit ce qui est accepté, ce qui est retiré, qui peut voir quoi, avec quels en-têtes, ce qui n'est PAS fait, et comment nettoyer. Le code est dans `lib/server/media/` (serveur), `components/photos/` et `lib/client/photos-*.ts` (écrans). Le même écran sert la fiche acheteur, les cartes de résultats, le tableau de bord du vendeur et les favoris.

## Les règles en bref

| Sujet | Règle |
| --- | --- |
| Formats | **JPEG, PNG, WebP**, reconnus par leurs **octets magiques** seulement. SVG, GIF, HEIC, AVIF, BMP, PDF, HTML, texte : refusés, **quel que soit le `Content-Type` ou le nom annoncé**. WebP animé : refusé. |
| Poids | 5 Mo au plus par fichier (le poids annoncé est refusé avant toute lecture, un flux qui dépasse est coupé). |
| Durée de l'envoi | La lecture du corps a un **délai total de 30 secondes** : au-delà, **408** « L'envoi de la photo a pris trop de temps : vérifiez votre connexion, puis réessayez. » Un corps goutte à goutte (un octet toutes les 2 s) ne retient donc jamais une connexion plus de 30 s. Cela suppose un débit d'au moins 1,4 Mbit/s pour une photo de 5 Mo (une photo de téléphone compressée pèse 1 à 3 Mo). La réponse 408 porte `Connection: close` (lot T3 ; le relais de développement `dev:try` le répète au client) : le reste du corps abandonné ne doit pas être lu comme le début de la requête suivante sur une connexion persistante. La place de la limite de débit (30 par heure) prise **avant** la lecture n'est **pas rendue** après un 408 : c'est elle qui borne le nombre de connexions lentes qu'un compte peut retenir (30 × 30 s par heure) ; la rendre rendrait le corps lent gratuit, alors qu'un utilisateur honnête perd au plus quelques places sur trente. |
| Dimensions | Lues dans l'**en-tête** (rien n'est décodé) : 200 px au moins et **4 100 px** au plus par côté, **12,5 mégapixels** au plus. Un téléphone d'entrée de gamme produit au plus 4 032 × 3 024 (12,2 Mpx) : il passe. Une image de 40 Mpx se décode en 160 Mo dans le navigateur de chaque acheteur, et un en-tête peut mentir sur les dimensions de ses données (un PNG de 39 Ko en 8 000 × 5 000, un JPEG de 800 × 600 qui annonce 8 000 × 5 000) : le plafond borne ce que le navigateur aura à décoder. Un en-tête qui annonce 50 000 × 50 000 est refusé tout de suite. |
| Nombre | **6 photos par annonce** au plus, imposé dans le code ET en base (position 0 à 5, unique par annonce). La photo de position 0 est la **couverture**. |
| Débit | **30 envois par heure et par vendeur** (heure glissante). Tout envoi compte (accepté, refusé pour son fichier, rejoué) ; supprimer une photo ne rend pas la place. |
| Nom du fichier | Le fichier est stocké sous un **UUID tiré par le serveur**, sans extension. Le nom envoyé par l'utilisateur n'est jamais lu. |
| Rejeu | Même annonce et même **empreinte SHA-256 du fichier nettoyé** : pas de doublon (réponse 200, `created: false`). |
| Métadonnées | **Retirées** (voir plus bas), avant le calcul de l'empreinte et avant le stockage. |
| Lecture | `GET /api/media/{id}` : propriétaire, administrateur actif, ou acheteur d'une **correspondance confirmée et fraîche** de l'annonce. Tous les autres : **404 indiscernable**. |

## Envoi : `POST /api/offers/{id}/photos`

Le corps de la requête est **le fichier lui-même** (octets bruts, une photo par requête ; pas de `multipart`). Cela évite un analyseur de formulaires qui mettrait tout le corps en mémoire sans plafond : le plafond de 5 Mo est appliqué pendant la lecture.

Ordre des contrôles : origine (`Origin` doit être celle de `NOMA_AUTH_ORIGIN`, **avant** la session, 403 sinon) -> session (401) -> l'annonce est celle de l'utilisateur (sinon **404** identique à une annonce inconnue, aucune place d'envoi prise) -> annonce non archivée (409) -> poids annoncé (413) -> place dans la limite de 30 par heure (429 avec `Retry-After`) -> lecture bornée du corps, délai de 30 s (408) -> **octets magiques** (415) -> structure, dimensions, nettoyage (422) -> sous un verrou par annonce : rejeu éventuel, place libre (409 si 6), écriture du fichier, ligne en base.

Réponses (texte fixe en mots simples, jamais le contenu du fichier) : `415` « Ce format n'est pas accepté : envoyez une photo JPEG, PNG ou WebP. » ; `413` « Cette photo est trop lourde : 5 Mo au plus. » ; `422` « Cette photo est abîmée ou incomplète… », « …trop petite : 200 pixels au moins de chaque côté. », « …trop grande : 4 100 pixels au plus de chaque côté. Choisissez une photo plus petite ou réduisez-la. » ou « …12,5 millions de pixels au plus (par exemple 4 000 × 3 000)… », et `408` pour un envoi trop lent ; `409` « Cette annonce a déjà 6 photos : supprimez-en une pour en ajouter. » ; `429` « Vous avez envoyé beaucoup de photos : réessayez un peu plus tard. » Le succès répond `201` (nouvelle photo) ou `200` (rejeu) avec la photo et la liste à jour ; la photo vue par son propriétaire contient `id`, `position`, `mime`, `width`, `height`, `bytes` (jamais l'empreinte).

Autres routes (propriétaire seulement, origine vérifiée sur les écritures) : `GET /api/offers/{id}/photos` (liste), `PUT /api/offers/{id}/photos` avec `{ "order": [identifiants] }` (nouvel ordre : la liste doit être **exactement** les photos de l'annonce ; la première devient la couverture), `DELETE /api/offers/{id}/photos/{photoId}`.

## Ce qui est retiré, et ce qui est gardé

Le fichier est **reconstruit**, pas copié : seuls les segments utiles à l'affichage sont recopiés (liste blanche), tout le reste disparaît, ainsi que tout octet **après la fin de l'image** (fichiers « polyglottes », vidéos de photos animées, données ajoutées). Un fichier déjà nettoyé est inchangé par un second nettoyage (idempotent). Les pixels ne sont jamais décodés ni modifiés.

| Format | Retiré | Gardé |
| --- | --- | --- |
| JPEG | APP1 (EXIF **et GPS**, XMP), APP13 (Photoshop), commentaires (COM), tous les autres APPn dont **APP2 : le profil de couleur « ICC_PROFILE »** et MPF, vignette incorporée du JFIF, segments inconnus, tout après le marqueur de fin | JFIF (réécrit sans vignette), transformation Adobe (APP14, 12 octets numériques), tables, cadre, balayages. **Orientation** (voir ci-dessous). |
| PNG | `tEXt`, `zTXt`, `iTXt` (dont XMP), `eXIf`, `tIME`, `sPLT`, **`iCCP` (le profil de couleur ET son nom, qui est du texte libre)**, morceaux de l'animation APNG (`acTL`, `fcTL`, `fdAT`), tout morceau privé ou inconnu, tout morceau utile placé après les données, tout après `IEND` | `IHDR`, `PLTE`, `IDAT`, `IEND`, `tRNS`, `gAMA`, `cHRM`, `sRGB`, `sBIT`, `bKGD`, `hIST`, `pHYs`, `cICP`. Les CRC sont vérifiés. |
| WebP | blocs `EXIF` et `XMP `, **`ICCP` (profil de couleur)**, blocs inconnus, tout après le conteneur RIFF ; les drapeaux de `VP8X` (EXIF, XMP, ICC) sont remis à zéro, ses 3 octets réservés aussi, et la taille RIFF est recalculée | `VP8X` (reconstruit : toile et drapeau d'alpha), `ALPH`, `VP8 ` ou `VP8L`. |

**Les profils de couleur ICC sont retirés dans les trois formats** (JPEG APP2, PNG `iCCP`, WebP `ICCP`). Un profil porte du texte libre (nom, fabricant, description, copyright : un vrai profil d'iPhone dit « Apple Inc. ») et un faux profil peut contenir n'importe quoi (un EXIF, des coordonnées, un numéro de téléphone, un nom de quartier) : un acheteur qui enregistre l'image pourrait le lire. **Conséquence assumée : une légère perte de fidélité des couleurs.** Sans profil, les navigateurs supposent sRGB ; les photos en Display P3 (iPhone récents) paraissent un peu moins saturées. Les photos des téléphones d'entrée de gamme, majoritaires sur le marché visé, sont déjà en sRGB : elles ne changent pas. Les tests construisent des fichiers « cuisine » (faux profils ICC remplis d'un EXIF, de « GPS », « Canon », « 0708091011 », « Cocody », « Apple Inc. », nom de bloc `iCCP` piégé, bloc `ICCP` WebP) et vérifient qu'aucune de ces chaînes ne subsiste, que la structure reste valide et que le fichier est décodé par un vrai décodeur.

**Une exception assumée pour le JPEG : l'orientation.** Un téléphone tenu en portrait enregistre souvent une image couchée et une étiquette d'orientation dans l'EXIF. Sans elle, la photo s'afficherait de côté. Quand l'orientation est 2 à 8, noma écrit un **EXIF minimal de 34 octets qui ne contient que cette étiquette** (aucun GPS, aucune date, aucun appareil). Quand elle est 1, absente ou illisible, aucun APP1 n'est écrit. Les tests vérifient octet par octet l'absence de coordonnées GPS, de marque d'appareil, de date, de XMP, de commentaire, de profil de couleur et de HTML dans les fichiers stockés et servis, pour les trois formats. **L'orientation n'est conservée que pour le JPEG** (les téléphones produisent du JPEG) : un PNG ou un WebP dont l'orientation n'est écrite que dans `eXIf` ou `EXIF` s'affichera sans rotation.

## Qui peut voir un fichier : `GET /api/media/{photoId}`

Droit de voir une photo = droit de voir l'annonce, avec le **même prédicat** que la fiche acheteur, la liste des résultats et le contact (`buildMatchingFreshnessPredicate`) :

- son **propriétaire** (quel que soit le statut de l'annonce) ;
- un **administrateur** actif (lecture seule) ;
- un **acheteur** dont un besoin **actif** a cette annonce parmi ses correspondances **confirmées et fraîches**, l'annonce étant publiée et disponible, les deux comptes actifs.

Pour tous les autres, la réponse est **la même 404** (même statut, même corps, mêmes en-têtes) : visiteur sans session, session invalide, autre acheteur, annonce hors correspondance, besoin clos, **annonce dépubliée** (en pause, archivée, brouillon, vendue), vendeur suspendu, identifiant inconnu ou mal formé, paramètre de requête. On ne peut donc pas deviner qu'une photo existe. Une ligne dont le fichier manque (ou a changé de taille) répond aussi 404 (jamais 500) et un code est journalisé.

En-têtes du fichier servi : `Content-Type` = **le type que les octets ont prouvé** (lu en base), `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` (sans nom de fichier), `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, max-age=300`, `Vary: Cookie` (la réponse dépend de la session : aucun cache ne la rejoue à un autre compte), et `Cross-Origin-Resource-Policy: same-origin`. Les réponses d'erreur sont en `Cache-Control: no-store`. **Une photo reste au plus 5 minutes dans le cache du navigateur après la perte d'accès** (annonce dépubliée, vendue, besoin clos, compte suspendu) : le navigateur d'un acheteur qui l'a déjà chargée peut la réafficher pendant 5 minutes, alors que le serveur, lui, ne la sert plus.

**Aucun redimensionnement côté serveur** (aucune dépendance) : le navigateur affiche en `object-fit: cover` avec `loading="lazy"`. Une photo de 5 Mo est donc téléchargée telle quelle dans les cartes ; un stockage objet avec miniatures pourra le corriger plus tard.

## Où vont les fichiers

Hors de `public/`, dans un dossier désigné par **`NOMA_MEDIA_DIR`** (par défaut `data/media` hors production, déjà ignoré par git par la règle `/data/` du `.gitignore` ; **obligatoire en production** : sans elle, l'envoi et la lecture répondent 503, rien n'est écrit). Le dossier est créé à la première photo (droits 0700, fichiers 0600). L'accès passe par le port `MediaStore` (`lib/server/media/store.ts`), dont l'implémentation d'aujourd'hui est le disque : un stockage objet pourra la remplacer sans toucher au reste.

Garde-fous du disque : seule une clé en **UUID v4 minuscule** atteint le système de fichiers (aucune traversée de chemin possible), le chemin final est revérifié, l'écriture est atomique (fichier temporaire puis lien : jamais d'écrasement), un lien symbolique n'est jamais suivi.

## Suppression, orphelins et `media:gc`

- **Suppression** : la ligne est supprimée dans une transaction (les positions sont recompactées), le **fichier seulement après la validation**. Si la transaction échoue, la ligne ET le fichier restent. Si le fichier ne peut pas être supprimé, il est inscrit au journal des orphelins (`media_orphans`).
- **Envoi** : le fichier est écrit avant la ligne ; si la transaction échoue, le fichier est retiré (sinon journalisé).
- **`npm run media:gc`** : simulation par défaut, `npm run media:gc -- --apply` pour supprimer. Supprime les **fichiers sans ligne en base** (envois interrompus, suppressions échouées) de plus de `NOMA_MEDIA_GC_MIN_AGE_SECONDS` secondes (défaut **600** : un envoi en cours a écrit son fichier avant de valider sa ligne) et les **lignes sans fichier** (positions recompactées), puis résout le journal des orphelins. Seuls les fichiers aux noms que le code crée (UUID, ou fichier temporaire) sont touchés : un fichier étranger dans le dossier n'est jamais supprimé. **Garde contre un dossier mal désigné** (`NOMA_MEDIA_DIR` vers un autre dossier, un disque non monté, un dossier vidé : toutes les lignes paraîtraient « sans fichier ») : si **plus de 5 % des lignes, ou plus de 20 lignes**, n'ont pas de fichier, `--apply` est **refusé en entier** (code 1) : ni ligne ni fichier n'est supprimé (le dossier peut aussi contenir les fichiers d'une autre installation, que l'on prendrait pour des orphelins). Le message explique le risque. Si ces fichiers sont réellement perdus : `npm run media:gc -- --apply --expect-missing=<N>` où **N est EXACTEMENT le nombre constaté** (la simulation et le refus l'affichent) ; un autre nombre est refusé, même sous les seuils. Cas d'école : 55 lignes sur 56 sans fichier -> refusé.
- **Garde d'environnement** (celle de `metrics:purge`) : la commande ne s'exécute que si `NODE_ENV` est absent, `development` ou `test` (casse exacte), simulation comprise ; en `production` il faut **`NOMA_MEDIA_GC_PRODUCTION=1`** (l'autorisation de `metrics:purge` ne vaut pas) et `NOMA_MEDIA_DIR`.

## Ce qui n'est PAS fait (limites assumées)

1. **Un numéro de téléphone écrit DANS une photo n'est pas détecté** : pas d'OCR, pas d'IA, les pixels ne sont jamais lus. C'est pourquoi chaque écran d'ajout rappelle au vendeur : « N'écrivez pas votre numéro sur les photos : l'acheteur vous contacte par noma. » Le **signalement d'une photo** par un acheteur est prévu plus tard.
2. Les pixels ne sont pas décodés : une image dont le flux compressé est invalide passe le contrôle d'en-tête (le navigateur ne l'affichera pas), et les dimensions enregistrées sont celles de l'EN-TÊTE, qui peut mentir sur celles des données. Le flux n'est pas inflaté côté serveur ; le plafond de 5 Mo et celui de 12,5 Mpx (4 100 px par côté) bornent ce que le navigateur aura à décoder. Pour la même raison, du texte glissé DANS les données compressées elles-mêmes (après la fin du flux zlib d'un morceau IDAT, ou au milieu du balayage JPEG) n'est ni détecté ni retiré : ce n'est pas une métadonnée mais le contenu de l'image, au même titre qu'un numéro écrit sur la photo.
3. Pas de redimensionnement ni de miniatures (voir plus haut), pas de détection d'images identiques entre annonces différentes, pas d'analyse du contenu (violence, droits d'auteur).
4. Le cache privé de 5 minutes survit à la dépublication dans le navigateur de l'acheteur.
5. Les fichiers ne sont pas chiffrés au repos ; les droits du dossier (0700) et la sauvegarde du dossier sont l'affaire du déploiement.
6. L'orientation EXIF n'est conservée que pour le JPEG (les téléphones produisent du JPEG) ; les profils de couleur sont retirés (légère perte de fidélité des couleurs, voir plus haut).
7. Le délai de 30 s de l'envoi suppose un débit d'au moins 1,4 Mbit/s pour une photo de 5 Mo ; sur une connexion plus lente, l'utilisateur reçoit le 408 et un message en mots simples (une compression avant l'envoi côté navigateur pourra le corriger plus tard).

## Écrans

- **Formulaire d'annonce** : « Photos (facultatif) » : aperçu, ordre (la première est la couverture), retrait ; les fichiers partent **un par un après la création de l'annonce**, avec leur progression. Si une photo échoue, l'annonce reste **en brouillon** (message en mots simples) : on rajoute la photo depuis la page de l'annonce, puis on publie.
- **Page de l'annonce (vendeur)** : « Photos » : ajout (plusieurs fichiers), reculer/avancer, « Mettre en couverture », suppression en deux temps, erreurs par photo, « n photos sur 6 ».
- **Fiche acheteur** : galerie (photo principale à la taille réservée par ses dimensions, vignettes dessous).
- **Cartes de résultats, tableau de bord du vendeur, favoris** : vignette de couverture ; sans photo, l'icône d'avant ; une photo qui ne se charge pas se replie sur l'icône.
- **Fiche de l'annonce (acheteur) et liste « Mes annonces » (vendeur)** (lot T3) : la vignette à côté du titre est la couverture quand une photo existe (jamais l'icône de remplacement alors qu'une photo existe) ; la fiche prend la première photo de sa galerie, la liste `GET /api/offers` joint `coverPhotoId` aux seules annonces qui ont une photo (lecture unique pour la page, du propriétaire seulement ; le champ est ignoré par le client s'il n'est pas un identifiant).

## Démonstration et essais

`npm run demo:seed` ajoute **une photo synthétique par annonce** (PNG fabriqué avec le `zlib` de Node : couleur choisie par produit, motif par annonce, 480 × 360), par le vrai service d'envoi ; rejouable sans doublon. Les photos vont dans `NOMA_MEDIA_DIR` (ou `data/media`).

Essais : `npm run test:media` (octets, stockage, envoi, lecture, débit, concurrence, `media:gc`), `npm run test:photos-client`, `npm run e2e:photos` (navigateur réel : un vendeur ajoute deux photos, un acheteur les voit en vignette et en galerie, un autre acheteur reçoit 404, en-têtes vérifiés).
