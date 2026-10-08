# HISTORIQUE-PRIX.md — Prix demandés dans les annonces (lots H1, H1-bis et H1-ter)

AUDIT-EVOLUTION-SCOUTR.md §5 (M6) et §7 (lot 7, « statistiques de marché accompagnées d'effectif, période et comparabilité ») : un acheteur doit savoir **où se situe le prix demandé d'une
annonce**, un vendeur **à quel prix les autres vendeurs publient**. Ce lot garde le prix **affiché** des annonces publiées (une observation par jour) et en publie des statistiques
**protégées** : **une seule valeur par vendeur**, prix atypiques écartés, seuils portant sur des **vendeurs** distincts (5, 10 et 20), médiane arrondie à 500 FCFA, fourchette arrondie en relatif,
effectifs arrondis à 5 près, comparabilité toujours dite, aucun minimum ni maximum. Aucun paiement, aucun appel externe, aucune dépendance.

> **Les prix de vente ne sont pas publiés** tant qu'un mécanisme robuste (volume élevé, publication différée, comptes anciens) n'est pas en place. Les ventes sont déclarées par l'acheteur et
> confirmées par le vendeur, sans vérification.
>
> Le lot H1 les publiait (médiane et quartiles des ventes confirmées). L'audit a prouvé que le prix exact d'une vente se retrouvait de trois façons : **(1) sybille** — trois comptes et quatre
> ventes fictives (1 000, 1 500, 99 000 000, 100 000 000) suffisent pour franchir les seuils, et la médiane publiée vaut alors EXACTEMENT la vente visée (le passage de « pas assez de données » à
> « publié » en révèle aussi le moment) ; **(2) un seul instantané** — avec cinq ventes, Q1, la médiane et Q3 sont exactement les 2e, 3e et 4e prix réels ; **(3) une lecture avant et une après
> une confirmation** — la différence des médianes ou de Q3 donne la cible. L'arrondi à 500 FCFA ne protège rien quand les prix ronds sont la norme. Les observations de ventes restent
> **enregistrées** (déclencheur, table, purge) ; seul l'administrateur voit, par produit, un **nombre** de ventes confirmées arrondi, **sans aucun prix** (`/admin/marche`).

Code : `database/migrations/0023_price_observations.sql`, `lib/server/market/` (`config.ts`, `stats.ts` — la partie PURE —, `reads.ts`, `observe.ts`, `rate-limit.ts`, `http.ts`),
l'étape « market » de `lib/server/matching/runner.ts`, la purge `lib/server/metrics/purge.ts` (+ `scripts/metrics-purge.ts`), `lib/server/admin/http.ts` (`GET /api/admin/market`),
`app/api/market/route.ts`, `app/api/admin/market/route.ts`, côté écrans `lib/client/market-api.ts`, `lib/client/market-view.ts`, `components/market/`, la fiche acheteur
(`app/(buyer)/besoins/[id]/offres/[offerId]/page.tsx`), le formulaire d'annonce (`components/vendor/nouvelle-annonce-form.tsx`), le tableau `app/(admin)/admin/marche/page.tsx`, et
`scripts/demo-market-plan.ts` + `scripts/demo-seed.ts` pour l'historique de démonstration. Essais : `npm run test:market`, `test:market-adversary`, `test:market-http`, `test:market-purge`,
`test:client`, `test:demo-seed`, `e2e:demo` (étapes H1) ; mesure : `npm run perf:market`.

## Définitions exactes

| Terme | Définition exacte |
| --- | --- |
| **Jour** | Jour **UTC** (AAAA-MM-JJ). |
| **Observation** (ligne de `price_observations`) | Un prix observé : une **source**, une **référence** (l'annonce ou la commande), un **jour**, une **clé produit**, un prix entier de 1 à 100 000 000 FCFA, un libellé d'affichage et deux identifiants INTERNES (vendeur, acheteur). Unique par (source, référence, jour). |
| **Source `listing`** | Le prix **demandé** (affiché) d'une annonce **publiée** : une observation par jour et par annonce. **Seule source publiée.** |
| **Source `sale`** | Le prix convenu d'une commande qui **passe à « confirmée »** (jour UTC de sa décision). Enregistrée, **jamais publiée** : seul un nombre arrondi de ventes est lu, par l'administration. |
| **Annonce observable** | Publiée, non archivée, disponibilité différente de « indisponible » (absente acceptée), prix de 1 à 100 000 000 **en XOF**, catégorie, marque et modèle renseignés, propriétaire actif (`price_obs_offer_ok`, définition unique partagée par le déclencheur et le relevé quotidien). |
| **Clé produit** | (catégorie, marque, modèle, variante, état), chaque partie **normalisée** par `price_key_part` : minuscules, accents du français retirés, espaces (insécables compris) réduits à un seul — les règles de `accentNormalize` du matching (un essai compare la fonction de la base à `accentNormalize` sur des textes réels). Une variante ou un état absent vaut le texte vide. |
| **Période** | 30, 90 ou 365 jours : de « aujourd'hui − (N − 1) » à aujourd'hui, **aujourd'hui compris**, bornes comprises. |
| **Dernier prix d'une annonce** | Le DERNIER prix observé de l'annonce dans la période (jamais une pondération par le nombre de jours en ligne ; la clé de comparaison est celle de ce dernier relevé), arrondi à 500 FCFA. Le lot H1 pondérait par les jours : quatre annonces à 100 000 pendant un jour et une annonce à 200 000 pendant 26 jours donnaient médiane, Q1 et Q3 à 200 000. |
| **Valeur d'un vendeur** | **UNE seule valeur par vendeur et par période : la médiane (arrondie à 500) des derniers prix de ses annonces du groupe.** Un vendeur qui publie 1 annonce ou 500 pèse une valeur. Le lot H1-bis comptait une valeur par ANNONCE : un seul vendeur pouvait fixer la médiane (voir « Manipulation »). Un compte supprimé (vendeur `NULL`) n'est attribuable à personne : ses annonces ne comptent pas. |
| **Prix atypique** | Une valeur par vendeur hors de [Q1 − 1,5 × IQR ; Q3 + 1,5 × IQR], Q1, Q3 et IQR étant calculés sur les valeurs par vendeur du groupe. Elle est écartée AVANT toute publication, avec toutes les annonces de ce vendeur. |
| **Groupe de comparaison** | Les annonces dont la clé répond au **niveau** retenu (ci-dessous). |
| **Vendeurs retenus** | Les vendeurs du groupe après retrait des prix atypiques ; c'est sur eux que portent les seuils, la médiane et la fourchette. Les **annonces retenues** sont leurs annonces (effectif « environ N annonces »). |
| **Médiane** | Médiane (interpolation linéaire, la formule de `percentile_cont`) des valeurs par vendeur retenues, arrondie à 500 FCFA (le multiple le plus proche, la moitié vers le haut). |
| **Fourchette (Q1, Q3)** | Publiée seulement à partir de **10 vendeurs retenus**, sinon la médiane seule. Q1 et Q3 sont arrondis **en relatif** : au multiple de **5 % de la médiane** (médiane / 20) le plus proche, de part et d'autre de la médiane (jamais un quartile exact). **Une borne publiée n'est jamais ≤ 0** : si l'arrondi ramène Q1 à 0 (médiane énorme et quartile minuscule), la fourchette entière est omise (la médiane reste publiée). |
| **Tendance** | La période est découpée en blocs de **7 jours consécutifs finissant aujourd'hui** (30 jours : 4 blocs, 90 : 12, 365 : 52 ; les `période mod 7` jours les plus anciens n'y figurent pas) ; un point = la médiane des valeurs par vendeur du bloc (le dernier prix de chaque annonce dans le bloc, une valeur par vendeur ; mêmes prix atypiques écartés), publié seulement si le bloc compte **au moins 20 vendeurs retenus**, sinon `null`. |

**Ce que sont ces chiffres.** Des prix **demandés** par les vendeurs, pas des prix payés : l'écran ne dit jamais « prix du marché » seul et le dit en toutes lettres (« Ce sont des prix demandés par les vendeurs,
pas des prix payés. »). Les prix demandés sont de toute façon **visibles par les acheteurs** dont un besoin correspond à l'annonce : le risque d'une fuite d'un prix individuel est moindre que pour un prix de
vente (voir « Ce que l'adversaire prouve »).

## Observation du prix affiché

- **Déclencheurs** (migration 0023), dans la transaction de l'écriture : une annonce observable qui est **créée publiée**, **publiée**, ou dont le **prix, la disponibilité, l'état de publication ou la
  clé produit change** écrit (ou remplace) la ligne du **jour** : le dernier prix du jour l'emporte (une ligne par jour et par annonce). Un brouillon, une annonce en pause, indisponible, hors XOF,
  sans catégorie, marque ou modèle, d'un compte suspendu : rien. Une modification qui ne touche rien de cela (description, localisation) : rien.
- **Vente** : le déclencheur de `orders` écrit la vente quand la commande **passe à « confirmed »** (ou est insérée déjà confirmée) : prix convenu, jour UTC de la décision, vendeur, acheteur, clé de
  l'annonce au moment de la confirmation ; dans la **même transaction**, une seule fois. Cette observation n'est lue nulle part sous forme de prix.
- **Étape « market » du worker** (`runMarketStep`, après « notify », cloisonnée comme les autres : un échec est rapporté `market_error_<code>` et n'arrête rien ; elle ne compte jamais dans « au repos ») :
  pour les annonces publiées, écrit la ligne du **jour courant** si elle manque. **Aucun rattrapage** : un jour où le worker n'a pas tourné **reste un trou** dans l'historique (documenté). Le lot H1
  rattrapait jusqu'à 7 jours ; l'audit a montré que ce rattrapage fabriquait des « jours fantômes » (une annonce suspendue puis remise en ligne recevait des relevés pour des jours où elle n'était pas
  en ligne). **Idempotent** : `ON CONFLICT DO NOTHING` ; deux relevés simultanés ne s'écrasent pas (essai) ; un jour terminé est consigné dans `price_observation_runs` et n'est pas recommencé à chaque
  cycle (une lecture). Traitement par lots de 500 annonces. **Sans la migration 0023** : étape **ignorée** (`market.skipped: true`), jamais une erreur.
- **Limites** : une annonce modifiée par SQL direct sans passer par un `UPDATE` de `offers` n'est pas vue ; une annonce publiée avant la migration 0023 n'a pas d'historique avant son premier relevé.

## Statistiques des prix demandés

### Seuils de confidentialité

Appliqués aux **vendeurs retenus** (après retrait des prix atypiques) du groupe, à la période ET à chaque semaine de la tendance. Un seul seuil manquant : « pas assez de données », **aucun chiffre**
(`{ "status": "insufficient" }`).

| Statistique | Seuil |
| --- | --- |
| Médiane de la période | au moins **5 vendeurs distincts** retenus (le lot H1-bis exigeait 5 annonces de 3 vendeurs) |
| Fourchette (Q1, Q3) | au moins **10 vendeurs** retenus ; en dessous, la médiane seule |
| Un point de la tendance | au moins **20 vendeurs** retenus dans la semaine (15 au lot H1-ter ; le lot H1-bis exigeait 30 annonces) |

Les vendeurs sont comptés **distincts** (un compte supprimé n'est plus compté : `ON DELETE SET NULL`). Des centaines d'annonces de quatre vendeurs ne passent jamais le seuil. Le seuil de la tendance vient
de la **mesure** (voir « Ce que l'adversaire prouve », point 2) : une médiane hebdomadaire de quelques vendeurs est la valeur d'un vendeur, et la série de médianes multiplie les occasions de tomber sur
le rang médian (une par semaine en ligne). Mesuré avec des prix ronds : sans tendance 5 à 7 %, avec des points à partir de 15 vendeurs 17 à 24 %, de 20 vendeurs 14 à 15 %, de 30 vendeurs 7 à 14 % (marchés de 25 à
39 vendeurs, puis de 60 à 89 vendeurs). **Le seuil est de 20 depuis l'intégration du lot** (il était de 15 au lot H1-ter, conservé alors pour une tendance visible dans la démonstration) : la fuite des marchés dont la
tendance est publiée passe de **24 % (72 sur 300) à 14,3 % (43 sur 300)**, sous le niveau d'un petit marché de 6 à 13 vendeurs (24 %) ; la démonstration garde sa courbe en donnant **24 vendeurs fictifs distincts**
aux deux produits phares (voir « Historique de démonstration »). Le relever à 30 est un changement d'une constante (`MARKET_TREND_MIN_SELLERS`) et divise encore la fuite par deux environ.

### Arrondis

- **Médiane et points de tendance** : multiples de **500 FCFA**. Chaque valeur est d'abord arrondie à 500 FCFA, puis la médiane est calculée et arrondie à nouveau : toute la publication ne dépend d'un
  prix individuel qu'à 500 FCFA près (indiscernabilité, ci-dessous). L'erreur sur la médiane est d'au plus 500 FCFA (borne testée contre un oracle indépendant).
- **Fourchette** : multiples de 5 % de la médiane de part et d'autre d'elle (médiane 160 000 : 152 000 et 176 000). Les montants peuvent être « curieux » (153 900 pour une médiane de 162 000) : ils
  sont exacts par construction, jamais des quartiers exacts.
- **Effectifs** (annonces retenues, vendeurs retenus, annonces des vendeurs aux prix atypiques écartés) : la règle de MESURES.md (`roundCount`) : « moins de 5 », « environ 5 » de 5 à 8, « environ 10 » de 9 à 12,
  puis le multiple de 5 le plus proche. L'écran dit « **environ N annonces d'environ M vendeurs** » ; **« N annonces aux prix atypiques écartées »** s'affiche avec N arrondi (« moins de 5 annonces aux prix atypiques
  écartées ») ; rien n'est affiché quand aucune n'a été écartée.
- **Jamais** de minimum ni de maximum exacts, jamais d'identifiant, jamais de prix individuel.

### Comparabilité

La **clé exacte d'abord**. Si ses seuils ne sont pas atteints (vendeurs retenus), la comparaison s'**élargit d'un cran** — sans la variante (si elle était demandée), puis sans l'état (s'il était demandé)
— et la réponse **le dit** (`comparedTo.scope` et une phrase). La phrase dit TOUJOURS ce qui est confondu, même quand rien n'a été élargi : un état non choisi dans le formulaire est dit « tous états confondus ».

| Demande | `scope` | Phrase (exemple) |
| --- | --- | --- |
| variante et état précisés | `exact` | « Comparé à : iPhone 12 128 Go, Occasion » |
| variante précisée, état non choisi | `exact` | « Comparé à : iPhone 12 128 Go, tous états confondus » |
| variante précisée, élargie | `any_variant` | « Comparé à : iPhone 12, Occasion, toutes variantes confondues » |
| état précisé, variante non précisée, élargie à l'état | `any_condition` | « Comparé à : iPhone 12, toutes variantes et tous états confondus » |
| tout élargi | `any_variant_and_condition` | « Comparé à : iPhone 12, toutes variantes et tous états confondus » |

Une catégorie, une marque ou un modèle absent : pas de marché (comme l'indicateur de prix du matching).

## Route et écrans

- **`GET /api/market?category&brand&model[&variant][&condition][&period=30|90|365]`** (contrat `market/v3` ; la v1 publiait des ventes, la v2 comptait par annonce) : utilisateurs **connectés** (401 sinon, texte fixe) ; paramètres en
  **liste blanche** (un autre paramètre, une clé en majuscules, un paramètre répété, une valeur vide, de plus de 80 caractères, avec un caractère de contrôle ou de direction de texte, ou qui ressemble à
  un numéro de téléphone : 400 `invalid_request`, **rien n'est lu**) ; période 90 par défaut ; **60 lectures par minute et par utilisateur** (429 `rate_limited` avec `retry-after`, mémoire du processus ;
  les lectures invalides comptent, les refus 401 non) ; réponse `no-store`, textes fixes, copie champ par champ. Elle ne porte **aucune clé de ventes**, aucun identifiant, aucun prix individuel. Le client
  relit la réponse en **liste blanche stricte** : un champ en trop (un prix de vente, un minimum…) la fait refuser.
- **Lecture** : la base **réduit** les relevés (`DISTINCT ON`) : pour chaque annonce, son dernier relevé de la période et de chaque bloc de la tendance, soit au plus 1 + 52 lignes par annonce quel que soit
  le nombre de jours observés. Le nombre de lignes lues est borné par le nombre d'annonces : **plus aucun refus (503) au-delà d'un nombre de relevés**, et rien n'est tronqué.
- **`GET /api/admin/market`** (`market-admin/v3`) : administrateurs seulement (le MÊME 404 pour tout autre, administrateur suspendu compris) ; les 20 clés produit les plus relevées sur 90 jours : prix demandés
  avec les mêmes seuils et arrondis, sur la **clé exacte** (une clé sous les seuils reste listée, « Pas assez de données »), et par produit **un nombre arrondi de ventes confirmées** (« environ 15 ventes
  confirmées »), sans aucun prix.
- **Fiche d'une annonce** (acheteur) : l'encart **« Prix demandés dans les annonces »** — médiane, « La moitié des prix demandés est entre X et Y » (à partir de 10 vendeurs, sinon « Fourchette non affichée : il
  faut au moins 10 vendeurs. »), « environ N annonces d'environ M vendeurs », annonces aux prix atypiques écartées, période (« Sur les 90 derniers jours », boutons 30 jours / 90 jours / 1 an), comparabilité, mini-courbe SVG
  faite main (quand 20 vendeurs par semaine le permettent), « Ce sont des prix demandés par les vendeurs, pas des prix payés. » et la phrase exacte « Calculé sur au moins 5 vendeurs différents, une seule valeur
  par vendeur (la médiane de ses annonces), prix atypiques écartés, chiffres arrondis (prix à 500 FCFA, effectifs à 5 près). » **Aucune ligne de ventes.** Une erreur du serveur ne casse jamais la fiche.
- **Formulaire d'annonce** (vendeur) : « Prix demandés dans les annonces pour ce produit : médiane X (environ N annonces d'environ M vendeurs, 90 jours). Comparé à : iPhone 12 128 Go, tous états confondus. » sous le prix, dès que la
  catégorie, la marque et le modèle sont saisis (600 ms après la frappe) ; rien sous les seuils.
- **Page d'administration « Marché »** (`/admin/marche`) : un tableau produit / prix demandés (médiane, effectif) / ventes confirmées (nombre arrondi).

## Manipulation et comptes multiples (lot H1-ter)

**Ce que l'audit du lot H1-bis a prouvé.** Avec une valeur par ANNONCE, un seul vendeur fixait la médiane affichée : cinq annonces honnêtes de trois vendeurs entre 160 000 et 170 000 (médiane 165 000) ; le même
vendeur ajoute six annonces à 120 000 et la médiane devient 120 000 ; à 10 000, 10 000 ; à 99 000 000, 99 000 000 (et Q1 devenait 0). **Correction : une seule valeur par vendeur** (la médiane de ses annonces),
des seuils sur les **vendeurs**, et des prix atypiques écartés sur les valeurs par vendeur.

**Ce qu'un compte obtient maintenant** (`tests/server/market.test.ts`, `tests/server/market-adversary.test.ts`, section « un seul compte ») :

| Attaque | Résultat (mesuré, testé) |
| --- | --- |
| UN vendeur, 1 à 500 annonces, à 1, 500, 10 000, 120 000, 164 000, 200 000, 99 000 000 FCFA, face à 5 vendeurs honnêtes (160 000 à 170 000) | la médiane reste entre [(2e + 3e) / 2 ; (3e + 4e) / 2] des prix honnêtes, soit **164 000 à 166 500** : jamais 120 000, ni 10 000, ni 99 000 000. Le cas de l'audit (6 annonces à 120 000) laisse la médiane à **165 000** : le vendeur est écarté comme prix atypique (« environ 5 annonces aux prix atypiques écartées »). |
| UN vendeur, sur 400 marchés tirés au hasard (5 à 15 vendeurs honnêtes), un ou deux prix et nombres d'annonces tirés | la médiane reste **toujours dans l'étendue** des honnêtes ; elle se déplace d'**au plus une position** (entre les voisins immédiats de la médiane honnête) dans 677 attaques sur 688 ; dans 11, le compte resserre l'écart interquartile et fait écarter un honnête à la frontière des prix atypiques (toujours dans l'étendue). |
| **DEUX vendeurs complices** (chacun 1 à 100 annonces) face à 5 honnêtes ou plus | la médiane reste dans l'étendue des honnêtes, et avec 5 honnêtes elle ne bouge que d'**une position** (de 165 000 à 162 500 ou 167 500). Plus généralement, **k complices moins nombreux que les n vendeurs honnêtes (k < n) ne sortent jamais la médiane de leur étendue**. |
| deux complices dans un marché de 3 vendeurs honnêtes seulement (5 vendeurs au total, le minimum) | ils font **publier** une médiane qu'ils placent où ils veulent **entre le plus bas et le plus haut prix honnête** (jamais en dehors), ou, en resserrant l'écart interquartile, font écarter un honnête atypique et ramener le marché sous 5 vendeurs : « pas assez de données » (déni de publication, aucune fuite). |
| complices **aussi nombreux** que les honnêtes (5 pour 5) | ils peuvent sortir la médiane de l'étendue (140 000 pour des honnêtes à 160 000 et plus) : limite assumée. |

**Sybille de vendeurs.** Un faux vendeur n'est pas gratuit : **chaque compte exige un numéro de téléphone vérifié** (code à usage unique, un numéro = un compte). Pour contrôler la médiane il faut autant de numéros
vérifiés que de vendeurs honnêtes du groupe ; pour isoler le prix demandé d'**un** vendeur dans un groupe de n il en faut n − 1 (quatre pour un groupe de cinq, au lieu de deux au lot H1-bis : un essai le
démontre, et montre que trois comptes, même avec 100 annonces chacun, ne publient rien). Ce prix est de toute façon un prix DEMANDÉ, visible par les acheteurs dont un besoin correspond. **Ce que nous ne faisons pas** :
détecter des comptes liés (adresse, appareil, comportement) ni exiger un compte ancien ; les seuils de vendeurs et le coût d'un numéro vérifié sont la seule barrière.

## Ce que l'adversaire prouve (`tests/server/market-adversary.test.ts`, `npm run test:market-adversary`)

Le test **n'importe rien** des arrondis ni des seuils : seulement la fonction de publication (`computeMarketStats`) et la réponse JSON (`marketStatsDto`).

**Adversaire.** Il lit les réponses pour **deux périodes emboîtées** (30 et 90 jours) et **deux niveaux de comparabilité**, connaît **tout le reste du monde** (toutes les autres annonces, leurs jours, leurs vendeurs)
et vise le prix d'**une** annonce. Il « retrouve exactement » un prix quand aucun autre prix n'aurait donné les mêmes quatre réponses. Il peut aussi ouvrir des comptes vendeurs et y publier ce qu'il veut (section précédente).

1. **Prix quelconques** (800 mondes : aléatoires, « de bord » — prix sur les bords des arrondis —, « imbriqués » — la cible est la seule annonce absente de la période de 30 jours —, « un vendeur par annonce ») :
   **aucune annonce n'est retrouvée** : le prix cible ± 1 donne les mêmes quatre réponses, et les prix compatibles couvrent au moins 249 valeurs (la tranche de 500 FCFA). Cela vient de l'arrondi de chaque prix
   avant tout calcul (la valeur d'un vendeur, médiane de prix arrondis, reste arrondie).
2. **Prix RONDS (multiples de 5 000, la norme en FCFA)** — la limite, **mesurée et dite sans détour**. Un adversaire qui **sait** que les prix sont ronds retrouve une annonce dont la valeur est celle de la
   médiane (la médiane de valeurs rondes est la valeur d'un vendeur, donc le prix d'une de ses annonces). Mesure (`console.log` du test, mêmes graines) : **petits marchés (6 à 13 vendeurs) : 24 % des annonces
   retrouvées** (363 sur 1 500) ; **grands marchés (20 à 39 vendeurs, 60 à 119 annonces) : 7 %** (28 sur 400 au seuil de 20 ; 9 %, 37 sur 400, au seuil de 15, quand davantage de marchés publiaient une tendance), la fuite décroît avec le NOMBRE DE VENDEURS (l'unité statistique), non avec le nombre d'annonces
   (environ 2 % au lot H1-bis, où chaque annonce comptait pour une valeur) ; **marchés dont la tendance est publiée** (25 à 39 vendeurs, annonces en ligne plusieurs semaines ; 54 mondes sur 60 ont au moins un point de tendance au seuil de 20) : **14,3 %** (43 sur 300 ; 24 %, 72 sur 300, au seuil de 15), contre 7 %
   sans tendance : chaque semaine en ligne est une occasion de plus d'être au rang médian. Seuil de tendance : voir « Seuils de confidentialité » (seuil de 20 vendeurs depuis l'intégration ; 15 mesuré à 24 %, 20 à 14,3 %, 30 à 7 %). Ce risque
   est **moindre** que pour les ventes : ce sont des prix **demandés**, visibles par les acheteurs dont un besoin correspond ; la fuite ne dit rien sur ce qu'un acheteur a payé.
3. **Témoins** (qui font échouer l'adversaire, donc prouvent qu'il a la puissance de le faire) : une publication **sans arrondi** ; une publication qui n'arrondit que le **résultat** (un monde de six vendeurs construit à
   la main : p − 1 change Q1 arrondi, p + 1 change la médiane arrondie, le prix exact est retrouvé ; la production laisse les mêmes réponses pour p ± 1 et p ± 249) ; surtout la **publication des prix de vente** — avec
   cinq ventes, Q1, la médiane et Q3 sont les 2e, 3e et 4e prix réels (retrouvés exactement dans 100 % des mondes de cinq ventes), et trois comptes avec quatre ventes fictives font publier exactement le prix de la
   vente visée. C'est la raison de la décision « les ventes ne sont pas publiées » ; un test vérifie que la réponse de production ne contient aucune clé de ventes.
4. **Utilité** : la médiane publiée est à 500 FCFA de la médiane des valeurs par vendeur retenues (oracle indépendant, avec un ou plusieurs vendeurs de plusieurs annonces).
5. **Un seul compte, des complices** : voir « Manipulation et comptes multiples ».

**Limite documentée (test)** : la **sybille sur les annonces** — quatre faux vendeurs (1 000, 1 500, 99 000 000, 100 000 000) font publier une médiane égale au prix demandé d'une annonce visée dans un groupe de
cinq ; trois ne publient rien. Ne sont pas traités : les lectures répétées dans le temps, les mondes que le générateur ne produit pas.

## Mesure : la vue « 1 an » sur 1 000 annonces (`npm run perf:market`)

1 000 annonces d'un même produit, observées chaque jour pendant un an (365 000 relevés), schéma jetable de la base de test : la lecture renvoie **53 000 lignes** (au plus 1 + 52 par annonce, au lieu de 365 000 relevés)
en **environ 0,8 s** pour 365 jours (médiane de 5 lectures : 809 ms, mesuré au lot H1-ter), environ 340 ms pour 90 jours (13 000 lignes) et 110 ms pour 30 jours (5 000 lignes). La médiane publiée est la même quelle que soit la période
(jeu régulier). Un essai (`market.integration.test.ts`) lit 300 annonces × 365 jours (109 500 relevés, au-delà de l'ancienne limite de 100 000) sans refus.

## Historique de démonstration (`npm run demo:seed`)

`demo:seed` écrit **90 jours de relevés SYNTHÉTIQUES** (les 89 jours avant aujourd'hui ; aujourd'hui est relevé par les vraies annonces) pour les 14 produits de démonstration : des annonces fictives qui se
renouvellent (30 jours en ligne sur 36, une baisse de 5 % après 18 jours). Depuis le lot H1-ter l'unité est le vendeur : les annonces sont réparties entre **24 vendeurs fictifs** (les 7 comptes vendeurs fictifs,
les 11 comptes acheteurs fictifs, qui vendent aussi dans l'historique, et 6 comptes fictifs de l'historique des prix `+225 07 55 55 55 01` à `06`, sans annonce ni besoin ; jamais les trois comptes de démonstration) — **24 annonces en parallèle, une par vendeur** (22 laissaient 5 combinaisons sur 120 — produit phare, jour de lancement — sans un point de tendance : les prix atypiques écartés d'une semaine ôtent des vendeurs ; 24 n'en laissent aucune sur les 60 jours testés), pour les deux produits les plus présents (iPhone 12
128 Go et Galaxy S21 128 Go d'occasion : 24 vendeurs chaque semaine, donc la tendance de 12 semaines, 20 vendeurs au moins), **12** pour les autres (12 vendeurs : une médiane, et le plus souvent la fourchette,
jamais de tendance). Une annonce par vendeur et par semaine, et non plusieurs : la valeur d'un vendeur est la médiane de ses annonces, et plusieurs annonces par vendeur resserraient les valeurs au point que l'écart
interquartile écartait comme « atypiques » jusqu'à un tiers des vendeurs d'une semaine (points de tendance manquants, mesuré avec 40 places). Les ventes fictives, 5 à 10 % sous le prix demandé, se font entre les **vendeurs
fictifs 1 à 7** et les **acheteurs fictifs 1 à 11** (elles ne servent qu'au nombre de ventes confirmées de l'administration). Le prix demandé baisse de 0,08 % par jour. Tout est une fonction du **jour absolu** et du
produit : relancer (ce jour-là ou un autre) réécrit les mêmes lignes ; `ON CONFLICT DO NOTHING` : rejouable à l'identique (0 relevé de plus). Un essai vérifie, pour 60 jours de lancement consécutifs, que chaque
produit publie sa médiane sur la clé exacte et que les deux produits phares ont leurs 12 points de tendance et leur fourchette. Les identifiants fictifs ne correspondent à aucune annonce ni commande.
**Ce sont des données de démonstration : ne les montrez jamais comme des prix réels.**

## Purge

`npm run metrics:purge` (simulation par défaut, `-- --apply` pour supprimer) supprime aussi les relevés de **plus de 3 ans** (1 095 jours, jour UTC du relevé : 1 095 jours pile conservé, 1 096 supprimé), par lots
de 5 000, avec le journal du relevé quotidien ; sans la migration 0023, rien à supprimer (jamais une erreur). La ligne « Historique des prix : … » s'ajoute à celle des mesures (400 jours, inchangées).

## Limites assumées

- Le prix **demandé** n'est pas le prix **payé** ; les prix de vente ne sont pas publiés (voir plus haut) et ne le seront qu'avec un mécanisme robuste (volume élevé, publication différée, comptes anciens).
- Un adversaire qui sait que les prix sont ronds retrouve les annonces du vendeur au rang médian (24 % dans un petit marché de 6 à 13 vendeurs, 7 % dans un marché de 20 à 39 vendeurs, 14 % quand la tendance est publiée à 20 vendeurs) ;
  la sybille de vendeurs (un numéro vérifié par compte) fixe la médiane sur un prix demandé visé : n − 1 comptes pour isoler un vendeur d'un groupe de n, autant de comptes que de vendeurs honnêtes pour en fixer la médiane.
- Un vendeur honnête isolé (un seul vendeur de plusieurs annonces) ne publie rien : la médiane exige 5 vendeurs ; les niches à 2 ou 3 vendeurs n'ont pas de prix publié.
- Un relevé est un prix **en XOF** de 1 à 100 000 000 ; les annonces dans une autre devise ou sans catégorie, marque ou modèle n'ont pas de marché.
- Un trou dans l'historique (worker arrêté un jour) reste un trou : aucun rattrapage.
- La limite de débit est **par processus** (un redémarrage ou un second processus remet un compteur à zéro).
- Les données de démonstration sont synthétiques. Aucune migration n'est appliquée à `noma_dev` par ce lot.
