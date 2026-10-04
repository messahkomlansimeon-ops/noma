# ESSAI-LOCAL-REEL-4B — Re-vérification réelle des correctifs (lot 4A)

**VALIDATION PARTIELLE** — corrections hors ligne ajoutées après lecture des
données brutes (voir « Réconciliations et corrections ») : les conclusions
initiales sur « flux coupé », le compteur d'offres et la source du 403 ont
été corrigées ; les écarts de compteurs sont expliqués précisément.

Date : 3 octobre 2026. **Autorisation explicite du porteur** (lot 4B local) :
trois recherches réelles, une tentative chacune, OpenRouter uniquement,
budgets prévisionnels inchangés (0,05 $/recherche, 1 $/jour, non garantis
par le fournisseur). **Aucun POST de diagnostic déclenchant une recherche**
(la sonde de pré-démarrage a utilisé `NOMA_SEARCH_DISABLED=1` → 503 sans
recherche), aucune relance, aucun déploiement, aucun achat, aucun contact
vendeur.

**Cadre** : instance isolée sur loopback (`127.0.0.1:3240`, port libre),
base SQLite et build dédiés (`/tmp/opencode/noma-4b-db/`), serveur du
porteur (3210) intact. Code avec les correctifs du lot 4A (géographie,
comparaison/rechargement, exclusion 404, instrumentation). Turnstile
désactivé UNIQUEMENT dans cet environnement local ; contrôle d'origine
STRICT (hostnames d'accès déclarés via `NOMA_TURNSTILE_HOSTNAMES` — jamais
d'assouplissement du code).

---

## Mesures par recherche

| | Premier résultat | Durée totale | Éléments « liens offre » (capture) | Liste FINALE (completed) | Sources | Coût connu | Verdict |
|---|---|---|---|---|---|---|---|
| 1. iPhone 12 Pro 128 Go ≤150 000 FCFA Cocody | **3 636 ms** | **79 815 ms** | 8 éléments (≈4 cartes, instantané à 3,6 s) | **16 offres** | facebook=ok · coinafrique=ok · locanto=ok · google=empty | **0,003251 $** | **GO** |
| 2. Téléviseur 55 pouces Abidjan | **2 307 ms** | **34 914 ms** | 14 éléments (≈7 cartes, instantané) | **0 offre** (7 vérifiées, 7×404 exclues) | facebook=ok · coinafrique=ok · locanto=empty · google=empty | **0,000623 $** | **GO avec réserve** (final vide — arbitrage porteur : liste vide conservée ✓) |
| 3. Chargeur USB-C 20 W Abidjan | **2 293 ms** | **44 306 ms** | 6 éléments (≈3 cartes, instantané) | 5+ offres (top 5 vérifié : 4×200 + 1×403 indéterminée conservée) | facebook=ok · coinafrique=ok · locanto=ok · google=empty | **0,001164 $** | **GO** |

**Compteurs : instantané progressif ≠ liste finale.** « Offres affichées »
dans le journal initial comptait des ÉLÉMENTS DOM (`<a>` — chaque carte en
porte 2) à l'instant de la capture, pas la liste finale. La liste FINALE
est celle de l'événement `completed` (`offersCount`) — 16 pour l'iPhone,
0 pour la TV.

## Vérifications des correctifs (en réel)

### Géographie (E2 corrigé) — ✅ VÉRIFIÉ

- iPhone : **plus aucune offre Abengourou** dans le top 5 final (4A : 5e
  position hors zone) — offres Cocody/Abidjan uniquement.
- TV : **plus aucune annonce Bouaké / San-Pedro** dans le snapshot (4A en
  affichait) — zones Abidjan (Koumassi, Cocody, Le plateau, Yopougon) ou
  « Localisation non renseignée » explicitement étiquetée.

### Annonces inaccessibles (E4 corrigé) — ✅ VÉRIFIÉ

- iPhone : **5/5 liens du classement principal accessibles (HTTP 200)** —
  les 404 confirmées ont été exclues du classement.
- Chargeur : 4/5 liens accessibles (200) ; **1 Locanto → 403 : INDÉTERMINÉE,
  conservée** — jamais assimilée à « vendue » ✔ (le 403 est le lien
  **Locanto** du chargeur Nintendo, pas Facebook — corrigé).
- TV : les 7 candidates (CoinAfrique Abidjan) vérifiées → **toutes 404
  confirmées → exclues → liste finale VIDE** (0 offre) — comportement
  conforme au correctif ET à l'arbitrage du porteur (liste vide conservée,
  404 jamais réintroduites) ; **à arbitrer pour l'affichage** (voir anomalies).

### Comparaison et rechargement (E5 corrigé) — ✅ VÉRIFIÉ (recherches 1 et 3)

- Après rechargement de `/recherche` : sélection de **2 offres réelles**
  acceptée (la seed de démonstration est effacée), ouverture de la
  **comparaison** puis du **détail**, **sans relancer la recherche**.
- Captures : `1-iphone-12-pro-{comparaison,detail}.png`,
  `3-chargeur-usbc-20w-{comparaison,detail}.png`.
- Recherche 2 : **non vérifié** (liste finale vide → aucune offre à
  sélectionner).

## Pertinence des cinq premières offres

### 1. iPhone 12 Pro (finale, capture + flux)

1. « iPhone 12 Pro 128 giga seconde main propre » — 120 000 FCFA —
   Abidjan — Facebook — seconde main annoncé, capacité 128 Go.
2. « Iphone 12 pro 128gb » — 150 000 FCFA — Cocody, Abidjan — CoinAfrique —
   **Correspondance exacte** : modèle confirmé · capacité 128 Go · dans le
   budget (150000 XOF ≤ 150000) · zone ok.
3. « iPhone 12 Pro 128Go Sans Id » — 80 000 FCFA — Abidjan — iCloud-less
   annoncé, prix cohérent avec l'absence de verrou.
4. « iPhone 12 Pro 128Go sans 🆔 » — 100 000 FCFA — Abidjan — Facebook.
5. « Iphone 12 pro 128giga » — 142 000 FCFA — Cocody, Abidjan — CoinAfrique.

Produit, capacité (128 Go), budget (80 000-150 000 ≤ 150 000) et zone
(Cocody/Abidjan) cohérents ; prix/devise affichés sans conversion.

### 2. TV 55 pouces — top 5 final NON VÉRIFIÉ (liste finale vide)

Le snapshot progressif (7-14 offres, capture `2-tv-55-pouces-resultats.png`)
montrait des offres conformes : « Téléviseur LG 55" » 950 000 FCFA
Koumassi (correspondance exacte, **capacité non confirmée**),
« Téléviseur LG Oled 55 pouces » 950 000, « Téléviseur LED Samsung »
435 000 Le plateau (possible), « Téléviseur smart Samsung » 685 000,
« Téléviseur smart » 230 000 Yopougon — **« information absente = non
confirmée » respecté** (capacité/55" jamais inventée). Ces offres ont été
remplacées par la liste finale vide (exclusions) — voir anomalies.

### 3. Chargeur USB-C 20 W (finale, capture + flux)

1. « chargeur oraimo original 20w type C vers type C » — 6 000 FCFA —
   Abidjan — Facebook — **Puissance : 20W confirmée par IA**.
2. « Chargeur USB-C 20W pour iPhone » — 3 500 FCFA — Abidjan — Facebook.
3. « Chargeur Rapide iPhone USB C 20W avec 2M Câble [Certifié Apple MFi] »
   — Abidjan.
4. « Chargeur secteur USB-C 20W – Apple maison mère Adjamé » — **20 FCFA**
   — **prix suspect** (voir anomalies) — Localisation non renseignée.
5. « Chargeur Officiel Nintendo Switch – Adaptateur Secteur USB-C » —
   17 000 FCFA — Abidjan — produit voisin (adaptateur 20 W), non un
   chargeur iPhone.

## Comptabilité finale (SQLite, vérifiée)

| Recherche | Réserve | Dépense connue | État |
|---|---|---|---|
| 1. iPhone 12 Pro | 50 000 µ$ | **3 251 µ$** | réconciliée |
| 2. TV 55 pouces | 50 000 µ$ | **623 µ$** | réconciliée |
| 3. Chargeur USB-C | 50 000 µ$ | **1 164 µ$** | réconciliée |
| **Total 4B** | — | **5 038 µ$ (0,0050 $)** | — |

- **Aucune recherche active** en fin d'essai (`active_searches` vide).
- **3/3 réserves réconciliées à coût connu** — **aucune réserve
  incertaine** ; aucun essai arrêté pour facturation incertaine.
- Aucune recherche hors accord dans ce lot (conforme : aucune sonde
  déclenchante).
- Quotas respectés : frontière de minute avant chaque démarrage, 3
  démarrages sur 4 minutes, 10/jour non atteints.

## Cache

- **9 entrées fraîches** au fil des recherches (CoinAfrique 160 annonces,
  Facebook 52, Locanto 5 — **217 brutes mises en cache**) : 84+67+9
  CoinAfrique, 20+20+12 Facebook, 3+0+2 Locanto par recherche.
- Cache froid au démarrage (les entrées du dépôt étaient expirées) ; aucune
  recherche identique rejouée dans ce lot → aucun hit mesuré.
- Le compteur de cache n'est pas exposé dans le flux public (limite
  connue) — état mesuré via le fichier cache (sans secret).

## Réconciliations précises (données brutes, hors ligne)

### iPhone : 8 « affichées » vs completed = 16 — expliqué

- « Offres affichées : 8 » comptait des **éléments DOM** (`a[href^="/offre/"]`)
  à l'instant de la capture (3,6 s) : chaque carte porte 2 liens
  (vignette + titre) → ≈ **4 cartes** = l'instantané progressif.
- L'événement `completed` = **16 offres** = la **liste FINALE** après IA et
  exclusions (les sources Facebook sont arrivées après la capture).
- Le top 5 et les liens vérifiés proviennent de la liste finale — cohérents.

### TV : 14 → 0 — funnel précis (reproduction hors ligne sur le cache 4B)

| Étape | Nombre |
|---|---|
| Brutes (67 CoinAfrique + 20 Facebook + 0 Locanto) | 87 |
| Après déduplication (URL canonique/identité) | 87 |
| Rejetées à la classification | 80 — dont **78 « produit sans rapport »** (62 titres « TV … » : le synonyme « TV » n'est pas dans les mots-clés `["televiseur"]` — **nouveau défaut de pertinence, préexistant**) et **2 « zone incompatible »** (San-Pedro, Bouaké — correctif géographique ✓) |
| Candidates (toutes CoinAfrique, zones Abidjan) | **7** |
| Vérification d'accessibilité (top 10 → les 7) | **7 × 404 confirmées → exclues** |
| **Liste finale** | **0** (offersCount=0 ✓) |

Cohérence : l'annonce 200 de 4A (« Téléviseur 55 pouces » à Bouaké) était
géographiquement rejetée en 4B (correction géographique) → seule source
accessible hors classement. Le « 14 » initial = 7 cartes × 2 liens DOM.

### Chargeur : « flux coupé » = capture instrument — fin de flux NON PROUVÉE à l'époque (corrigée depuis)

Le journal serveur (`POST /api/search 200 en 44s`) et la réconciliation à
coût connu prouvent que le MOTEUR a terminé et réconcilié — mais
**HTTP 200 + réconciliation ne prouvent pas une fin normale du FLUX**
(fin publiée au client vs annulation après coupure : indiscernable à
l'époque). Conclusion honnête : **fin normale probable, NON PROUVÉE côté
flux** pour la recherche 3 de ce lot. La capture `res.text()` avait été
rejetée (lecteurs concurrents navigateur/instrument sur le même flux ;
éviction du tampon CDP). **Correction** : tap serveur des événements avec
marqueur terminal (`NOMA_DEBUG_EVENT_LOG`) distinguant fin **publiée**
(completed/error), erreur publique et annulation sans publication — le
journal n'annonce plus jamais une fin qui n'a pas été émise ; la preuve
sera disponible dès le prochain essai.

## Corrections hors ligne (lot 4B — après les données brutes)

| Correctif | Preuve |
|---|---|
| **État vide explicite** : le retrait des annonces inaccessibles (liste finale vide) affiche désormais un message dédié **avec la preuve serveur** (nombre d'exclusions + indéterminées) ; sans preuve serveur → **message neutre** (une liste devenue vide ne suffit pas à identifier la cause) | Contrat : `completed.retired {count, indeterminate}` émis SEULEMENT si des exclusions ont eu lieu (parse NDJSON strict — 2 tests contrat) ; `lib/real-search.ts` : `offersRetired = completed.retired.count` (traitement NDJSON RÉEL testé via fetch stub — 4 tests) ; écran /recherche. Tests store : 9/9 |
| **Mots-clés distinctifs partiels** : « Chargeur d'énergie solaire 20w » (chargeur ✓, USB-C ✗) était classé « correspondance exacte » | `poc/lib/filter.ts` : hit partiel sur mots-clés multiples → **inconnu « mots-clés partiels — à vérifier »**, JAMAIS rejeté (« solaire » seul ne justifie pas un rejet — « secteur » non plus, non demandé). Le **20 W** était déjà contrôlé (attribut W=20 extrait du besoin, confirmé sur « solaire 20w »). **+3 régressions** |
| **Synonyme « TV »** (décision porteur) : 62 annonces « TV Samsung … » étaient rejetées « produit sans rapport » | `KEYWORD_SYNONYMS` (televiseur → tv) — les contraintes 55 pouces, géographie et accessibilité restent STRICTES ; **faux positifs testés** : « Support TV mural » → rejeté (accessoire), « Télécommande TV » → rejeté (ACCESSORY_HEAD += telecommande), « Smart TV Philips 32" » → rejeté (pouces), « Smart TV » à Bouaké → rejeté (géographie). **+5 régressions** |
| **Journal diagnostic honnête (P1)** : l'événement était journalisé AVANT le contrôle d'annulation (fin jamais émise annoncée) | `lib/server/search-stream.ts` : journalisation APRÈS émission réussie + **marqueur terminal** (`tap:end`) distinguant `completed` / `error` / `annulé-sans-publication`. **3 tests tap** (nominal, annulé, erreur) dans tests/server/stream.test.ts |
| **Tap serveur d'événements** (`NOMA_DEBUG_EVENT_LOG`, inactif par défaut) : capture fiable côté serveur pour l'instrument | `lib/server/search-stream.ts` ; l'instrument `essai-reel.ts` l'utilise en source primaire et lit le marqueur de fin |

## Vérification du « 20 FCFA » (A2) — prix FIDÈLE à la source

La donnée brute (cache 4B) : annonce **Facebook Marketplace** — titre
« Chargeur secteur USB-C 20W – Apple maison mère Adjamé », description
commençant par **« 20 CFA »** → le prix 20 CFA vient de la page source
elle-même (prix d'appel / faux prix probable), **pas d'un bug de
parsing**. Affichage honnête (prix annoncé · devise FCFA). Signal de
risque potentiel pour les signalements (à traiter dans la modération, hors
moteur).

## Anomalies et points de décision (résiduels)

| # | Constat | Gravité | Note |
|---|---|---|---|
| A1 | TV : liste finale VIDE après exclusions (7/7 candidates = 404 confirmées ; 62 annonces « TV … » rejetées « produit sans rapport ») | **RÉSOLU (décision porteur)** | « TV » ajouté comme synonyme de « téléviseur » — contraintes 55 pouces, géographie et accessibilité STRICTES ; faux positifs testés (support/télécommande/taille/zone) — re-vérification réelle attendue |
| A2 | Recherche 3 : fin du flux NON PROUVÉE (HTTP 200 + réconciliation insuffisants) | **CORRIGÉ** | Tap serveur avec marqueur terminal ; fin publiée vs annulation désormais distinguées et prouvables |
| A5 | google=empty sur les 3 (pas de CSE) | Attendu | Absence de configuration, aucune panne |
| A6 | Statuts par source : locanto=empty sur TV (0 annonce) — correct | — | — |

## Scénarios non vérifiés (littéralement « non vérifié »)

- TV : top 5 FINAL, détail et comparaison — **non vérifié** (liste finale
  vide ; aucune nouvelle tentative conformément à « une tentative chacune »).
- Le rechargement→comparaison n'a pas été vérifié sur une recherche à
  liste finale vide (rien à sélectionner).

## Captures

`/tmp/opencode/noma-essai-captures/` (4B : 02:35-02:38) — `1-iphone-12-pro-{formulaire,resultats,detail,comparaison}.png`,
`2-tv-55-pouces-{formulaire,resultats}.png` (détail/comparaison : non exécutés en 4B),
`3-chargeur-usbc-20w-{formulaire,resultats,detail,comparaison}.png`.
Données brutes : `/tmp/opencode/essai-reel-resultats.json`,
`/tmp/opencode/essai-4b-run.log`.

## Verdict global

**Les correctifs du lot 4A sont vérifiés en réel** : géographie (plus de
hors-zone dans le classement), exclusion des 404 confirmées (5/5 liens
accessibles sur iPhone ; TV : 7/7 vérifiées = 404 → liste finale vide,
conforme à l'arbitrage), maintien prudent des indéterminés (403 Locanto
conservée), comparaison après rechargement sans relance (recherches 1 et
3), comptabilité entièrement réconciliée (0,0050 $, 0 active, aucune
réserve incertaine).

**Compteurs réconciliés** : instantané progressif ≠ liste finale
(iPhone 4 cartes affichées à 3,6 s → 16 offres finales ; TV 7 cartes → 0
après 7×404) ; « flux coupé » recherche 3 : fin du flux non prouvée à
l'époque — désormais prouvable (tap serveur avec marqueur terminal).
**A1 « TV » synonyme : ajouté** (décision porteur) avec ses garde-fous
testés ; la re-vérification réelle attend le prochain accord.

Le déploiement (lot 3) reste bloqué sur les prérequis (serveur, domaine,
HTTPS, clés Turnstile, IP testeurs).
