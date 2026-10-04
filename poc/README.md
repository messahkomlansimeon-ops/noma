# PoC NOMA — accès aux sources, v3.7 « moteur multi-recherches »

> **14e revue (plafond IA — garantie non démontrée) corrigée** : 208 tests verts.
> Le mécanisme est présenté comme un **budget prévisionnel avec arrêt
> conservateur** (les messages disent « budget IA épuisé — arrêt
> conservateur ») — aucune promesse de plafond fournisseur strict : les
> tokens d'entrée restent une estimation (certains caractères Unicode
> coûtent plusieurs tokens) et les tarifs ne sont pas contractuels :
> - **[P1] Estimation d'entrée PRÉVISIONNELLE et large** : 1 token par
 *   caractère — très au-dessus des tokenizations usuelles, mais pas un
 *   maximum garanti (certains caractères Unicode coûtent plusieurs tokens) ;
>   y compris le suffixe du message système et l'enveloppe de la requête
> - **[P1] Frais de recherche web inclus** : le plugin `:online` facture
>   hors tokens → plafond fixe ajouté à la borne de l'appel concerné —
>   activé dans le chemin réel (gsearch google-online, revue 15)
> - **[P1] Interruption = facturation incertaine** : réserve CONSERVÉE +
>   coût inconnu enregistré → les appels suivants sont bloqués jusqu'à
>   réconciliation (testé : envoi puis coupure → 0 nouvel appel, réserve
>   non remise à zéro) ; seuls un refus 4xx/5xx du fournisseur ou un usage
>   renvoyé relâchent la réserve

> **13e revue (plafond IA toujours non strict, reproduit) corrigée** : 206 tests verts.
> - **[P1] La réserve est maintenant une BORNE du coût de l'appel** :
>   (tokens d'entrée estimés + maxTokens) × plafond de prix PAR MODÈLE
>   (`PRICE_CEILING_PER_1K`, généreux au-dessus des tarifs publics) — plus
>   de réserve fixe ni de `Math.min()` ; **borne > solde → appel REFUSÉ
>   avant tout appel fournisseur** (plafond 0,005 $ et 0,01 $ : 0 appel,
>   reproduction utilisateur verrouillée par test)
> - Sémantique honnête : plafond strict pour les modèles à prix plafonné
>   connus ; si les tarifs réels dépassaient les bornes, la protection se
>   comporterait comme un **seuil d'arrêt** — documenté dans le code

> **12e revue (4 garanties incomplètes, reproduites par l'utilisateur) corrigée** : 204 tests verts.
> - **[P1] Plafond IA strict** : vérifié avant CHAQUE modèle (secours
>   compris), comparaison `≥`, et **réservation conservatrice** (0,01 $/appel)
>   pour les appels simultanés du même run — `maxCostUsd: 0` = 0 appel ;
>   coût inconnu = plafond considéré atteint (conservateur)
> - **[P1] Annulation jusqu'au fournisseur** : `makeRealAi(signal)` transmet
>   le signal du run à llmJson ; `collectBatchScores` s'arrête entre les lots
>   si annulé (testé : abort avant scoring → 0 appel IA)
> - **[P1] `ai: null` = TOUS les chemins IA** : llmJson est la porte unique
>   (scoring, extraction Google, secours SERP) — `ctx.aiEnabled === false`
>   refuse tout appel
> - **[P2] Preuves navigateur** : `evidenceDir(source)` — écritures SEULEMENT
>   dans `artifactsDir/evidence-<source>` quand le run le demande, jamais
>   dans un chemin partagé (FB/Locanto concurrents ne s'écrasent plus)
> - Limite documentée : le mutex du cache protège UN processus — plusieurs
>   workers exigeront un cache partagé (étapes 2-3)

> **Étape 1 du passage multi-utilisateur — moteur extrait** : 198 tests verts.
> - **`lib/engine.ts runSearch(opts)`** : tout le pipeline (connecteurs →
>   dédup → classification → scoring IA → classement) en fonction réutilisable ;
>   le CLI (`search.ts`) n'est plus qu'une enveloppe (arguments, affichage,
>   latest.json) — un futur backend/worker appelle la même fonction
> - **État isolé par recherche** (`RunCtx`, AsyncLocalStorage) : journal,
>   compteur IA (coût/tokens) et compteurs cache PAR RUN — plusieurs
>   recherches simultanées ne se mélangent plus ; écritures du cache JSON
>   sérialisées (mutex) contre les collisions concurrentes
> - **Injections** : connecteurs (`runners`), IA (`ai` — `null` pour hors
>   ligne), journal (`log` muet par défaut pour un backend), signal d'annulation
>   globale câblé jusqu'à chaque connecteur et à l'IA
> - **Plafond de dépense IA par run** (`maxCostUsd`) : au-delà, aucun appel —
>   dégradation propre en « non évalué par IA » (préparation étape 3 worker)
> - **Artefacts optionnels** (`artifactsDir`) : aucun fichier écrit sans demande
> - Validation live CLI refactoré : table 6 places Cocody → 109 → 51 candidates
>   (0,0124 $), artefacts et compteurs identiques

> **11e revue (P1 anonymisation reproduit) corrigée** : 192 tests verts.
> - **modèle ≠ téléphone adjacent** : la règle paires exige une première
>   paire avec 0 initial — « iphone 12 07 58 96 75 41 » → « iphone 12
>   [téléphone] » (plus de « iphone 41 » dans la requête) ; le run démarre
>   au vrai numéro et le consomme entièrement

> **10e revue (2 défauts d'anonymisation reproduits) corrigée** : 191 tests verts.
> - **[P1] Espaces insécables** : U+00A0/U+202F normalisés AVANT détection —
>   « 07 58 96 75 41 » en paires insécables est maintenant masqué (et donc
>   absent de la requête envoyée aux sites) ; les masques « [téléphone] » /
>   « [e-mail] » sont retirés du produit (requête propre)
> - **[P2] Montants préservés** : les prix ne commencent jamais par 0 —
>   « budget 15000000 FCFA » (et « 12500000 » sans devise) restent intacts ;
>   coordonnées = 0 initial, préfixe +225/225, paires. Limite assumée : un
>   numéro sans 0 initial ni préfixe (« 758967541 ») n'est pas masquable
>   sans risque d'effacer un montant — la garantie « aucun téléphone ne peut
>   passer » est ajustée aux formats ivoiriens usuels

> **9e revue (3 défauts reproduits par l'utilisateur) corrigée** : 188 tests verts.
> - **[P1] Confidentialité** : `anonymiserBesoin` appliqué EN AMONT (console,
>   parseur, artefacts) — téléphones (paires, collés, +225) et e-mails masqués ;
>   les prix restent lisibles (groupes de 3 jamais masqués)
> - **[P2] Mesures cache honnêtes** : méta de lecture (`fromCache`/`ageMs`/
>   `netMs`) + `avecCache` — la durée affichée d'un résultat servi par le
>   cache est la durée de lecture ACTUELLE, la durée réseau initiale est
>   préservée et affichée dans le bilan ; compteurs cache **par source**
>   (`cacheStatsBySource`, §8)
> - **[P2] 403 ≠ transitoire** : classification HTTP — 401/403/429 → `blocked`
>   (refus d'accès, JAMAIS relancé, compté « bloquée » dans la synthèse) ;
>   autres 4xx → `http` (définitif) ; 5xx/408 → `network` (relançable)

> **Mesures & charge (décision « faut-il un proxy ? » avec des chiffres)** : 182 tests verts.
> - **Bilan synthétique par source** en fin de run (`bilanSources`, imprimé +
>   dans search-results.json) : statut en clair (succès / vide / bloquée /
>   coupure / erreur), annonces, durée, MOTIF d'échec
> - **Cache instrumenté** : lectures réussies/échouées, écritures, résultats
>   non mémorisés (`cacheStats`) ; **TTL par source** (`SOURCE_TTL_MS` :
>   FB 10 min, CoinAfrique 15 min, Locanto 30 min, Google 60 min, pages 6 h) ;
>   âge des données affiché au hit ; entrées expirées purgées ; un blocage
>   n'est toujours jamais mis en cache
> - **Réessais bornés** (`withRetry`, lib/retry.ts) : au plus N appels,
>   espacement croissant plafonné, annulation honorée, relance UNIQUEMENT sur
>   erreur réseau transitoire (SSRF/blocage = définitif) — câblé CoinAfrique
>   + Google CSE ; concurrence inchangée (2 navigateurs / 3 téléchargements)
> - 1er résultat / durée totale / durée par source : déjà mesurés (§8) —
>   aucune duplication
> - Confidentialité : aucune clé ni donnée personnelle journalisée ; le
>   journal cache n'imprime plus que la source (pas l'URL)

> **8e revue du 02/10 (2 défauts reproduits) corrigée** : 174 tests verts.
> - **quartier demandé + commune annoncée** : « Cocody »/« Abidjan » annoncés
>   pour un besoin « Angré » → incertains (« quartier non précisé »), JAMAIS
>   rejetés ; autre commune (Yopougon) ou autre quartier (Riviera ≠ Angré)
>   → rejet avéré
> - **« 5k FCFA » = 5 000** : la garde anti-résolution (≥ 50) ne s'applique
>   qu'à la voie SANS devise ; montant collé au « k » accepté côté besoin
>   et côté annonce

> **7e revue du 02/10 (5 défauts reproduits par l'utilisateur) corrigée** : 172 tests verts.
> - **budgets jamais tronqués** (P1) : « 150k » = 150 000, « 4,700,000 FCFA »
>   = 4 700 000 — conversion via `amountOf` côté besoin ET côté annonce
> - **abréviations monétaires** : « 150 000 F », « frs », « F.CFA » reconnus
>   (besoin + annonce) ; famille CFA sans frontière finale (titres FB collés
>   « 85 000 CFAiPhone »)
> - **« jusqu'à 150 000 »** conserve son plafond — apostrophe droite ou
>   typographique (le texte est accent-strippé : « à » → « a »)
> - **localités** : « San Pedro », « Port Bouët », « Yop » (= Yopougon) ;
>   Facebook ne replie plus sur Abidjan pour San Pedro (slug + cityRegex)
> - **géographie précise** : Yopougon ≠ Cocody (rejet avéré) ; offre
>   « Abidjan » sans commune pour un besoin Cocody = « commune non précisée »
>   (plus jamais « zone ok » mensonger) ; Bingerville demandé = compatible ;
>   Riviera/Angré/Abatta = quartiers de Cocody

> **6e revue du 02/10 (2 défauts restants, reproduits par l'utilisateur) corrigée** : 167 tests verts.
> - **valeurs multiples** : « pointure 42/43 » (et « 40-41-42 ») extraites
>   en 42 ET 43 — une demande 43 n'est plus rejetée ; restreint aux unités
>   réalistes (pointure/taille/places/pouces), séparateurs `/` et `-`,
>   garde anti-prix (« TV 43 pouces - 65 000 F » n'ajoute pas {pouces:65})
> - **virgule-milliers** : « 12,000 BTU » = 12000 BTU (plus « 12 BTU ») ;
>   règle : séparateur + exactement 3 chiffres en fin = milliers, 1-2 chiffres = décimales

> **5e revue du 02/10 (4 défauts reproduits par l'utilisateur) corrigée et testée** : 164 tests verts.
> - **valeur liée à SON unité** : « TV 65 pouces, consommation 55 W » ne
>   confirme plus « 55 pouces » — extraction unité-ancrée partagée
>   (`need.ts extractAttributeValues`, `filter.ts attributeCheck`),
>   alias « taille » ≡ « pointure » (annonces réelles)
> - **décimales et milliers** : « 1,5 CV » = 1.5 CV (plus « 5 CV »),
>   « 12 000 BTU » = 12000 BTU (plus de contrainte perdue → 9000 accepté)
> - **chaque vérification ↔ son attribut** (index aligné dans
>   `scoring.ts`) : « 200 litres » seul ne valide plus les « 100 W »
>   (score ≠ 1,00, ratio honnête)
> - **« Correspondance exacte » exige les attributs confirmés** :
>   une TV sans taille indiquée n'est plus « exacte » pour « 55 pouces »

> **Élargissement de pertinence (validation multi-catégories)** : 160 tests verts.
> - **Caractéristiques chiffrées génériques** extraites du besoin et appliquées
>   bout en bout (requête → filtrage → scoring → raison) : pointure, taille,
>   pouces, BTU, CV, watts, litres, mètres, cm, kg, places
>   (`lib/need.ts parseAttributes`, `lib/filter.ts attributeCheck`)
>   — valeur différente avec la même unité = rejet avéré ;
>   valeur absente = « information manquante », jamais rejetée
> - **`summarizeSources`** : « aucune offre trouvée (sources opérationnelles) »
>   ≠ « sources indisponibles » — compteur par statut + verdict dans les stats
>
> **Validation live (runs réels du 02/10)** :
> | Demande | Résultat |
> |---|---|
> | chaussures de sport pointure 42 | 25 candidates ; top 1 « pointure 42/43 » ✓ ; tailles non précisées gardées ; 10 rejets avérés |
> | téléviseur 55 pouces | 9 candidates ; top 4 « 55 pouces/55" » confirmés ✓ ; 78 rejets d'autres tailles |
> | climatiseur 12000 BTU | 33 candidates ; BTU confirmé sur AS-12 ; « 1,5 CV » laissé en information manquante ; 2 rejets |
> | (unit tests) table 6 places / pointure 45 / 65 pouces / 9000 BTU | rejets avérés ✓ |

> **4e revue du 02/10 (2 constats scoring) appliquée et testée** : 145 tests verts.
> - P2-1 fraîcheur normalisée en MINUTES depuis les formats des connecteurs
>   (`parseFreshness` : min/minutes, h/heure/heures, j/jour/jours, semaines,
>   mois, « récente », « Hier » ; format inconnu = non confirmé, jamais
>   « ancien ») + grading monotone min > h > j > semaine > mois > absent
>   (« il y a 1 heure » et « 2 h » ne sont plus pénalisés)
> - P2-2 `confirmedRatio` : le dénominateur dépend UNIQUEMENT des critères
>   DEMANDÉS — un prix absent ou en devise inconnue compte comme non confirmé
>   (4/5) au lieu de disparaître du calcul (4/4)

> **3e revue du 02/10 (3 constats) appliquée et testée** : 138 tests verts.
> - P1 un besoin accessoire reste recherchable : la règle « accessoire avant
>   la marque » ne s'applique plus quand le besoin LUI-MÊME est l'accessoire
>   (« chargeur USB-C », « coque iPhone 12 », « AirPods », « table en verre »
>   → candidates ; « Coque iPhone 12 » reste rejetée pour un besoin iPhone 12,
>   et « Chargeur iPhone 12 » pour « iPhone 12 avec chargeur »)
> - P2 annulation pendant la résolution DNS : le signal est vérifié APRÈS le
>   DNS et AVANT l'ouverture de la connexion (0 requête envoyée, chargement
>   jamais appelé — testé sur serveur local réel)
> - P2 score déterministe honnête : capacité, zone, critères exprimés et
>   fraîcheur GRADUELLE intégrés (« inconnu » = 0,45 ; date ancienne = 0,25 ;
>   1,00 = tout ce qui est DEMANDÉ est confirmé et récent) + nouveau champ
>   `confirmedRatio` (informations confirmées X/Y) affiché dans la raison

> **2e revue du 02/10 (5 constats) appliquée et testée** : 126 tests verts.
> - P1-1 le signal d'annulation est transmis aux 4 connecteurs réels
>   (CoinAfrique, Facebook, Locanto, Google, chaque appel IA) — vérifié :
>   signal pré-aborté → rendu immédiat, navigateur jamais lancé, l'annulation
>   passe AVANT le cache ; les navigateurs se ferment à l'annulation
> - P1-2 négations prises en compte (« pas en bon état » ne valide pas
>   « bon état ») et valeurs IA comparées par TOKENS complets (« 5 % » ≠ « 85 % »)
> - P1-3 accessoire avant la marque = produit vendu différent (« Coque
>   iPhone 12 » rejetée ; « iPhone 12 avec coque » accepté)
> - P2-4 plafond deflate : RangeError mappé too-large (plus absorbé) —
>   deflate 3 Mo décompressés rejeté, deflate valide OK (serveur local)
> - P2-5 le délai total couvre la résolution DNS (race + temps restant
>   transmis au transport) — DNS 150 ms + limite 20 ms → coupure < 100 ms

> **Revue du 02/10 (9 constats) appliquée et testée** : 109 tests verts.
> - P1-1 adresse DNS validée IMPOSÉE à la connexion (connexion directe par IP littérale + SNI/Host — node 26 invalide le lookup personnalisé ; les IP v4 validées sont préférées, v6 sinon) ; le secours SERP passe aussi par safeFetch borné
> - P1-2 gzip décompressé UNE seule fois (transport node:http/https, corps brut, plafond décompressé maxOutputLength, Z_DATA_ERROR toléré) — testé sur serveur local réel
> - P1-3 budget marqueur (mMarker[1]) — « budget/max/moins de/jusqu'à » testés
> - P1-4 requêtes : modèle + VARIANTE reconstruits (« iPhone 12 Pro 128 Go » → « iphone 12 pro », jamais « pro ») ; requêtes de secours dynamiques (SERP_QUERIES supprimé) ; variante au filtrage (Pro ≠ Pro Max)
> - P1-5 critères IA affichés seulement si extrait présent MOT POUR MOT dans l'annonce et valeur contenue dans l'extrait ; « Correspondance exacte » exige zone connue + critères du besoin (« bon état ») vérifiés dans le texte
> - P1-6 clé de cache page = URL canonique (paramètres identifiants conservés : annonce?id=1 ≠ id=2)
> - P2-7 indices IA validés PAR LOT avant décalage global (lib/scoring.ts collectBatchScores, injectable hors ligne)
> - P2-8 alternatives JAMAIS fusionnées (lib/pipeline.ts rankAndSplit testable ; +alternatives en CLI)
> - P2-9 émission progressive (onResult + fichiers partiels par source), délai par connecteur avec coupure réelle (signal + arrivées tardives ignorées), délai PAR MODÈLE IA (timeoutMs), deadline propre au transport
> - + 1 bug découvert pendant la revue et corrigé : la consommation du besoin est maintenant séquentielle (modèle → capacité → budget) — « Pro Max 256 Go » ne lit plus « max 256 » comme un budget

**Date** : 2 octobre 2026 · Stack : TypeScript · Zod · Cheerio · Playwright · tests `node:test` via tsx
**Sortie** : `npm test` (82 tests locaux verts) · `npm run poc -- "<besoin>"` · `npm run test:network` (volontaire)

## Pipeline v3

```
besoin texte libre
   └► parseNeed (lib/need.ts) : type produit/service, modèle, capacité (unité
      explicite Go/GB/To/TB — le numéro de modèle n'est JAMAIS une capacité),
      budget (devise explicite XOF/USD/EUR, marqueur, ou montant final groupé ;
      sinon null — plus aucun plafond implicite), zone, critères, mots-clés
   └► constructeurs de requêtes (lib/query.ts) : URL encodée (URLSearchParams)
      par connecteur + capacités déclarées + critères non pris en charge
      signalés + clé de cache = source:version:requête-effective
   └► connecteurs en parallèle (2 navigateurs / 3 téléchargements max,
      lib/orchestrate.ts) : SourceResult {annonces, statut, durée, erreurs}
      — pannes isolées, résultats au fil des terminaisons
        1. CoinAfrique  (safeFetch SSRF-safe + parsing déterministe par carte)
        2. Facebook     (URL ville sans login, Playwright, preuves evidence/)
        3. Locanto      (Playwright, call view conservés « prix sur demande »)
        4. Google       (CSE API → plugin :online → SERP publics en secours ;
                        extraction IA des pages cibles via safeFetch)
   └► dédup par IDENTITÉ (lib/dedup.ts) : URL canonique (tracking retiré) ou
      id stable — jamais titre+prix ; groupes de doublons POSSIBLES inter-sources
   └► classification déterministe (lib/filter.ts) : compatible / incompatible /
      inconnu par critère ; rejet uniquement sur incompatibilité avérée ;
      hors budget → alternatives séparées (option --alternatives)
   └► scoring (lib/scoring.ts) : contraintes vérifiées dans le code + IA par
      critère (valeur observée + extrait justificatif) ; ids IA validés
      (hors lot / dupliqués rejetés) ; « correspondance exacte » interdite si
      critère inconnu ; échec IA → « non évalué par IA », offres conservées
   └► résultats par exécution : results/run-<timestamp>/ (aucun écrasement)
```

## Avant / après (besoin de référence iPhone 12 · 128 Go ≤ 150 000 FCFA)

| Mesure | v2 (avant) | v3 (après) |
|---|---|---|
| Tests | 0 | **82 verts** (besoin, requêtes, filtre, dédup, scoring, SSRF, orchestration) |
| Budget implicite | plafond caché 150 000 FCFA | **supprimé** — budget null si absent |
| Tolérance +10 % | oui | **supprimée** — hors budget → alternatives séparées |
| Dédup | fusion titre+prix (risque de fusionner 2 vendeurs) | **identité : URL canonique/id** — 2 vendeurs restent distincts |
| Devise | FCFA supposé | **XOF/USD/EUR/unknown** — prix inconnu = non comparable, jamais comparé |
| « correspondance exacte » | possible avec info manquante | **interdit** si modèle/capacité/budget inconnu |
| Requêtes | « iPhone 12 » codé en dur | **constructeurs dynamiques** — « iPhone 12 », « canapé à Cocody », « plombier à Bouaké » produisent des requêtes distinctes (validé en live) |
| Pannes | une exception casse tout | **SourceResult isolé** — blocage/crash/lenteur simulés en tests ; les autres sources restent exploitables |
| Téléchargements | fetch brut | **safeFetch** : SSRF refusé (localhost, privé, IPv6 local, métadonnées, IPv4-mappé), redirections re-validées (anti DNS-rebind), 15 s / 3 redirects / 2 Mo décompressés, annulation réelle — **transport injectable testé hors ligne** |
| Cache | tout mis en cache | **seuls succès/vides** — une panne n'est jamais mémorisée comme réussie |
| Sorties | fichiers écrasés | **results/run-<timestamp>/** par exécution |
| Coût inconnu | compté 0 $ | **« coût inconnu »** explicite (usage.cost absent) |
| Appels IA | 105 offres scorées | pré-filtre + lots : 63 candidates = **7 lots** au lieu de 11 (appels IA ≠ réduction d'annonces : les deux sont mesurés séparément) |

## Validations live (runs réels du 02/10)

| Besoin | Résultats | Candidates | Rejets | Coût connu | Durée |
|---|---|---|---|---|---|
| iPhone 12 · 128 Go ≤ 150 000 F (froid) | 113 → 63 | 63 | 40 | 0,0145 $ | 129 s |
| canapé à Cocody (froid) | 107 → 107 | 107 | 0 (budget non défini) | 0,0196 $ | 243 s |
| plombier à Bouaké (chaud partiel) | 60 → 20 | 20 | 40 hors sujet | 0,0092 $ | 46 s |

### Relevé de pertinence par catégorie (attributs, v3.5)

| Besoin | Brut → cand | Pertinence du top | Détail honnête |
|---|---|---|---|
| chaussures pointure 42 Abidjan | 35 → 25 | ✓ | top 1 « pointure 42/43 » confirmé ; suite = pointure absente (candidates, raison affichée) ; 10 rejets |
| téléviseur 55 pouces Abidjan | 87 → 9 | ✓✓ | top 4 tous 55″ confirmés ; 78 rejets (43″/65″/…) — l'attribut élimine fortement |
| climatiseur 12000 BTU Abidjan | 36 → 33 | ✓ | top 3 « 12000 BTU » confirmés ; rank 4 « 1.5 CV » sans BTU → inconnu/candidat |
| table 6 places Cocody | 111 → 96 | ✓ | top 8 tous « 6 places » confirmés ; annonces FB sans « places » → inconnu (candidates) |
| vélo électrique Bouaké | 23 → 17 | ✓ | top 2 zone Bouaké exacte (0,99/0,95) ; hors-zone déclassées (0,62→0,52, « autre zone » affiché) ; 1 « moto électrique » se glisse |
| déménagement 3 pièces Abidjan | 24 → 20 | ~ | **limite** : « 3 pièces » attire des locations d'appartements (top 1, 3-5) ; 1 vrai service (annonces.abidjan.net 0,92) — la requête est ambiguë pour les sources |

- 1er résultat : **0,9–1,4 s** (concurrence, au fil des terminaisons)
- cache chaud (iPhone, re-run) : **43 s / 0,0022 $** — mesuré en v2, régresse pas
- `results/run-*/` contient les exécutions annotées ; `data/golden/reference.json`
  fixe les comportements attendus (téléphone, canapé, service, autre ville,
  budget absent, prix inconnu, devises différentes, doublons-identité)

## Limites restantes (honnêtes)

1. **Détection « annonce vendue » / arnaques** : hors périmètre (phase distincte, cf. brief)
2. **Locanto call view** : prix non affichés — conservés « prix sur demande »
3. **SERP publics** : dépréciés (captcha/dégradation mesurés) ; la voie fiable est CSE API (clés à fournir) ou `:online` (actif)
4. **Facebook sans login** : URL ville uniquement ; stabilité/ToS à monitorer sur 2-3 semaines avant promesse de couverture
5. **Zone CoinAfrique** : non filtrée côté site (capacité déclarée « location: false ») — filtrage local seulement
6. **Coût** : mesuré sur 4 exemples ; **aucune extrapolation production** tant qu'un volume réel n'est pas observé
7. **Vision (screenshots)** : non activée — réservée si le DOM FB se ferme
8. **Services + caractéristique (« déménagement 3 pièces »)** : la caractéristique
   reste dans les mots-clés produit et les sources classées renvoient surtout des
   locations « 3 pièces » — 1 seul vrai service dans le top (relevé v3.5) ;
   piste : requête service distincte (sans « N pièces ») ou durcissement quand
   `kind = "service"`

## Commandes

```bash
npm test                       # 82 tests locaux (aucun réseau, aucun crédit)
npm run test:network           # tests réseau volontaires (POC_NETWORK=1)
npm run poc -- "besoin"        # recherche réelle
npm run poc -- "besoin" --alternatives   # intègre les hors budget
npm run test-coin -- "besoin"  # sonde CoinAfrique seule
```

## Fichiers clés

`lib/need.ts` (parsing v2) · `lib/query.ts` (requêtes + capacités) · `lib/fetch.ts`
(safeFetch SSRF) · `lib/filter.ts` (critères distincts) · `lib/dedup.ts` (identité) ·
`lib/scoring.ts` (code + IA par critère) · `lib/orchestrate.ts` (concurrence/isolation) ·
`sources/` (types + connecteurs) · `tests/` (8 suites) · `data/golden/reference.json`