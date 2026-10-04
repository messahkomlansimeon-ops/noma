# ESSAI-LOCAL-REEL — Lot 4A : essai réel local contrôlé

**VALIDATION PARTIELLE** (requalifiée après lecture du rapport et du code) :
les trois recherches ont abouti et le moteur fonctionne en réel, MAIS trois
défauts produit ont été confirmés et corrigés HORS LIGNE (sans nouvelle
recherche payante) — voir « Corrections hors ligne » ci-dessous. Deux
défauts supplémentaires reproduits hors ligne (exclusion par id seul,
réseau en mode simulé) ont aussi été corrigés avec leurs régressions. La
re-vérification réelle des zones corrigées attend l'accord du porteur.

Date : 3 octobre 2026. **Accord explicite obtenu avant tout appel externe** :
trois recherches avec IA (OpenRouter), budget prévisionnel 0,05 $/recherche
(1 $/jour), sans garantie de plafond fournisseur strict ; Google CSE non
fourni → source « google » sans API CSE (accord explicite). Une seule
tentative par recherche, exécution séquentielle, quotas respectés
(frontière de minute avant chaque démarrage), aucune relance, aucun
contournement de blocage, aucun proxy payant.

## Corrections hors ligne (après requalification — testées, non re-exécutées en réel)

| Correctif | Preuve obtenue (hors ligne) |
|---|---|
| **Comparaison + rechargement** (CONFIRMÉ produit, E5) : `lib/store.ts` réintroduisait 2 ids fictifs au rechargement, rejetant la sélection réelle (« Comparez jusqu'à 2 offres ») | `lib/real-search.ts` : hydrate d'une recherche réelle restaurée → comparaison remise à zéro. **5/5 tests store** (tests/real-search.test.ts) + parcours simulé de bout en bout : reload → sélection 2 offres réelles → page /comparer atteinte (capture `1-iphone-12-pro-comparaison.png`) |
| **Géographie** (CONFIRMÉ produit, E2) : `poc/lib/filter.ts` traitait les villes connues différentes comme « inconnues » (maintenues candidates) | Villes connues ≠ zone demandée = **incompatible avéré** (Abengourou, Bouaké ≠ Cocody/Abidjan) ; liste des villes étendue. **+4 régressions** dans poc/tests/filter.test.ts — **225/225 PoC verts** |
| **Annonces inaccessibles** (E4) : les 404 restaient classées | Moteur : vérification d'accessibilité du top 10 (3 téléchargements max, annulation honorée) — **404 confirmé → exclue du classement principal** ; 403/429/timeout/5xx = indéterminé, conservé, **jamais assimilé à « vendu »**. **+4 tests** (HTTP simulé, transport injecté, aucun réseau) dans poc/tests/annonces.test.ts |
| **Exclusion par identité complète** (P1 reproduit hors ligne) : deux sources, même id, URLs distinctes (200 et 404) → le défaut initial retirait l'annonce ACCESSIBLE (par id seul) et laissait la 404 | Exclusion par référence d'objet (identité complète). **Régression ajoutée** : l'annonce accessible reste, la 404 est exclue |
| **Mode simulé sans réseau réel** (P2 reproduit hors ligne : tentative DNS vers `exemple.local`) : la vérification d'accessibilité utilisait le transport réel si aucune injection n'était fournie | En mode SIMULÉ (runners injectés), la vérification ne s'exécute qu'avec un transport injecté explicite — **zéro DNS/HTTP réel**. **Régression ajoutée** : `dns.lookup` saboté pour faire échouer toute tentative réelle → 0 tentative, 0 exclusion, annonces conservées |
| **Instrumentation** (E6) : restauration sessionStorage polluait « premier résultat » | Contexte navigateur NEUF par recherche + sessionStorage vidé avant saisie — la mesure ne porte que sur la recherche courante |

Le contrôle d'origine reste STRICT (aucun changement) : vérification des
domaines autorisés — E1 est traité par la DÉCLARATION des hostnames
d'accès (`NOMA_TURNSTILE_HOSTNAMES`), pas par un assouplissement.

**Cadre** : instance de développement isolée (`127.0.0.1:3220`, liée au
loopback uniquement), répertoire de build et base SQLite dédiés
(`/tmp/opencode/noma-essai-db/`), sources RÉELLES activées, IA activée,
Turnstile désactivé UNIQUEMENT dans cet environnement local. Le serveur du
porteur (3210) n'a pas été touché. Aucun déploiement, aucun vendeur
contacté, rien acheté.

---

## Écart préalable déclaré (transparence)

Deux POST de diagnostic curl (avec la configuration réelle) ont déclenché
deux recherches **hors accord** (« test diagnostic », « x ») — erreur
opérationnelle de l'opérateur. Les deux se sont soldées proprement :
coûts **connus** et réconciliés (0,000736 $ + 0,004447 $), 0 recherche
active, aucune réserve incertaine. Signalées ici et incluses dans la
comptabilité totale.

## Anomalie découverte (réelle, à traiter en préproduction)

- **`403 invalid_origin` via `127.0.0.1`** : la validation d'origine
  compare l'origine à `request.url` — que Next normalise (ici
  `localhost`) ; une requête même-hôte via `127.0.0.1` est donc rejetée.
  Contournement utilisé pour l'essai : `NOMA_TURNSTILE_HOSTNAMES=127.0.0.1,localhost`
  (déclaration des hostnames d'accès — comportement prévu). **Impact
  préproduction** : derrière nginx avec le vrai domaine, l'origine = domaine
  = host ; mais tout accès par IP serait rejeté — à vérifier à la
  configuration du domaine.

## Résultats mesurés par recherche

### 1. iPhone 12 Pro 128 Go, maximum 150 000 FCFA, Cocody — VERDICT : GO

| Mesure | Valeur |
|---|---|
| Premier résultat visible | **2 603 ms** |
| Durée totale (clic → flux clos) | **79 246 ms** |
| Offres affichées | **10** |
| Sources | facebook=**ok**, coinafrique=**ok**, locanto=**ok**, google=**empty** (pas de CSE) |
| Coût connu (réserve 0,05 $ soldée) | **0,004148 $** |
| IA | `aiEnabled=true` (recherche réelle avec IA) |

Pertinence des 5 premières (capture `1-iphone-12-pro-resultats.png`) :
1. « Iphone 12 pro 128gb » — 150 000 FCFA — Cocody, Abidjan —
   **Correspondance exacte** : modèle confirmé (iphone 12) · **capacité
   128 Go confirmée** · dans le budget (150000 XOF ≤ 150000) · zone ok.
2. « Iphone 12 pro 128giga » — 142 000 FCFA — Cocody, Abidjan — exacte,
   capacité 128 Go confirmée, dans le budget.
3. — 105 000 FCFA — Cocody, Abidjan — **partielle** : capacité inconnue
   (non confirmée), dans le budget.
4. « Iphone 12 pro » — 105 000 FCFA — Cocody, Abidjan — partielle :
   capacité **non confirmée** (information absente = non confirmée ✔).
5. « iPhone 12 pro » — 125 000 FCFA — **Abengourou** — partielle :
   capacité non confirmée · **zone HORS demande (Abengourou ≠ Cocody)**
   affichée quand même — **point d'attention** (justificatif tronqué dans
   la carte ; à examiner : pourquoi une offre hors zone est classée
   « partielle » et non « hors-zone déclassée »).

Détail (capture `1-iphone-12-pro-detail.png`) : « Iphone 12 pro 128gb »,
150 000 FCFA (Prix annoncé · devise FCFA — aucune conversion), Cocody,
Abidjan, CoinAfrique, « Informations confirmées : **Modèle : iPhone 12
Pro** », badge « Pertinence vérifiée par IA », justification avec
vérifications mot pour mot, photos de l'annonce source, « Voir l'annonce
d'origine », mentions honnêtes (ni état, ni garantie, ni disponibilité
inventés).

Non exécuté pour cette recherche : comparaison et vérification des liens
(défaillance de l'instrument de mesure après la recherche — l'essai lui-même
a abouti ; aucune nouvelle tentative conformément à « une seule tentative »).

### 2. Téléviseur 55 pouces, Abidjan, sans budget imposé — VERDICT : GO (réserve pertinence)

| Mesure | Valeur |
|---|---|
| Premier résultat visible | **2 814 ms** |
| Durée totale | **40 982 ms** |
| Offres affichées | **18** |
| Sources | facebook=**ok**, coinafrique=**ok**, locanto=**empty**, google=**empty** |
| Coût connu | **0,001108 $** |

Pertinence des 5 premières (capture `2-tv-55-pouces-resultats.png`) :
1. « Téléviseur LG 55" » — 950 000 FCFA — Koumassi, Abidjan —
   **Correspondance exacte** (mots-clés présents) · **capacité (55")
   inconnue — non confirmée** · zone ok.
2. « Téléviseur LG Oled 55 pouces » — 950 000 FCFA — Cocody, Abidjan —
   exacte, capacité non confirmée.
3. — Cocody, Abidjan — CoinAfrique.
4. « Téléviseur 55 pouces » — 190 000 FCFA — **Bouaké** — « correspondance
   possible », **zone hors demande (Bouaké ≠ Abidjan) AFFICHÉE
   explicitement** (« zone : Bouaké — autre zone ») — jamais masquée ✔.
5. « Téléviseur LED Samsung » — 435 000 FCFA — Le plateau, Abidjan —
   « correspondance possible », **55" absent du titre → capacité non
   confirmée** (information absente = non confirmée ✔).

Liens vérifiés : **1/5 accessible (HTTP 200), 4/5 → 404** (annonces
CoinAfrique retirées/expirées) — **distinction faite entre page accessible
et produit encore disponible** : la disponibilité n'est jamais déduite du
statut HTTP (mention dans le rapport ; l'annonce 404 reste affichée avec
son lien — à examiner en préproduction : visibilité des annonces mortes).
Cache : froid (3 requêtes différentes ; cache disque alimenté,
`results/cache.json`).

### 3. Chargeur USB-C 20 W, Abidjan, sans budget imposé — VERDICT : GO

| Mesure | Valeur |
|---|---|
| Premier résultat visible | **non mesurable proprement** (pollution : la restauration sessionStorage des offres TV a précédé le remplacement par le flux — 568 ms est un artefact, pas un temps de recherche) |
| Durée totale (clic → flux clos) | **40 041 ms** |
| Offres affichées | **18** |
| Sources | facebook=**ok**, coinafrique=**ok**, locanto=**ok**, google=**empty** |
| Coût connu | **0,001185 $** |

Détail (capture `3-chargeur-usbc-20w-detail.png`) : « chargeur oraimo
original 20w type C vers type C » — 6 000 FCFA — Abidjan — Facebook
Marketplace — **« Informations confirmées : Puissance : 20W »** (confirmé
par IA) — badge « Pertinence vérifiée par IA ».

Liens vérifiés : **5/5 accessibles (HTTP 200)** — Facebook Marketplace.
**Ne pas confondre page accessible et produit disponible** : le statut 200
ne prouve PAS que les chargeurs sont encore disponibles (mention en
l'état). Comparaison non exécutée (instrument).

## Comptabilité finale (SQLite, vérifiée)

| Recherche | Réserve | Dépense connue | État |
|---|---|---|---|
| diagnostic « test diagnostic » | 50 000 µ$ | 736 µ$ | réconciliée |
| diagnostic « x » | 50 000 µ$ | 4 447 µ$ | réconciliée |
| 1. iPhone 12 Pro | 50 000 µ$ | **4 148 µ$** | réconciliée |
| 2. TV 55 pouces | 50 000 µ$ | **1 108 µ$** | réconciliée |
| 3. Chargeur USB-C | 50 000 µ$ | **1 185 µ$** | réconciliée |
| **Total** | — | **11 624 µ$ (0,0116 $)** | — |

- **Aucune recherche active** en fin d'essai (`active_searches` vide).
- **Toutes les réserves réconciliées à coût connu** — **aucune réserve
  incertaine** ; aucun essai arrêté pour facturation incertaine.
- Budget prévisionnel respecté : 0,05 $/recherche → dépenses réelles
  0,0011-0,0041 $/recherche (10-25× SOUS la réserve prévisionnelle).
- Le total inclut les 2 recherches hors accord déclarées ci-dessus ; les 3
  recherches autorisées : **6 441 µ$ (0,0064 $)**.

## Anomalies et limites

| # | Constat | Gravité | Note |
|---|---|---|---|
| E1 | `403 invalid_origin` via 127.0.0.1 (request.url normalisé par Next) | À traiter en préproduction | Contrôle STRICT conservé — déclaration des hostnames d'accès (`NOMA_TURNSTILE_HOSTNAMES`) |
| E2 | Offre hors zone (Abengourou) classée « partielle » et affichée en 5e position d'une recherche Cocody | **CONFIRMÉ produit — CORRIGÉ hors ligne** | Villes connues ≠ zone = rejet avéré ; +4 régressions PoC ; re-vérification réelle attendue |
| E3 | TV : la « correspondance » ne confirme pas 55" sur la plupart des offres (capacité non confirmée) | Attendu | « information absente = non confirmée » respecté — mais la pertinence 55" reste faible sur les offres sans le spec |
| E4 | 4/5 liens TV → 404 (annonces CoinAfrique retirées) | **CORRIGÉ hors ligne** | 404 confirmé → exclusion du classement principal ; 403/timeout = indéterminé, conservé ; re-vérification réelle attendue |
| E5 | Comparaison impossible après rechargement | **CONFIRMÉ produit — CORRIGÉ hors ligne** | Hydrate efface la seed de démo ; 5/5 tests store + parcours simulé complet (capture) ; re-vérification réelle attendue |
| E6 | Premier résultat recherche 3 non mesurable (restauration sessionStorage avant remplacement par le flux) | Instrument — **CORRIGÉ** | Contexte neuf + sessionStorage vidé avant chaque recherche |
| E7 | google=empty sur les 3 (pas de CSE) | Attendu (accord) | Source Google sans API CSE : aucune panne — absence de configuration |
| E8 | 2 recherches hors accord (diagnostics curl) | Écart déclaré | Coûts connus, réconciliés (0,0052 $) — opérationnellement interdit à l'avenir |
| E9 | Délai PAR SOURCE non exposé dans le flux public (statut seul) | Limite documentée | Mesurable en préprod via diagnostics si nécessaire |

## Captures

`/tmp/opencode/noma-essai-captures/` :
`1-iphone-12-pro-{formulaire,resultats,detail}.png`,
`2-tv-55-pouces-{formulaire,resultats,detail}.png`,
`3-chargeur-usbc-20w-{formulaire,resultats,detail}.png`.
Données brutes : `/tmp/opencode/essai-reel-resultats.json`,
`/tmp/opencode/essai-reel-run.log`, `/tmp/opencode/essai-reel-run-23.log`.

## Verdict global — VALIDATION PARTIELLE

**Ce qui est validé en réel** : le moteur fonctionne (3 parcours complets
formulaire → résultats progressifs → détail avec sources réelles et IA) ;
les confirmations sont honnêtes (modèle, capacité/puissance, prix/devise,
zone ; « information absente = non confirmée » respecté) ; les coûts réels
sont 10-25× sous la réserve prévisionnelle ; la comptabilité est entièrement
réconciliée (0 active, aucune réserve incertaine).

**Ce qui n'est PAS encore validé** (corrigé hors ligne, re-vérification
réelle attendue — accord du porteur) : le classement géographique corrigé
sur des recherches réelles ; l'exclusion des annonces 404 en conditions
réelles ; le parcours comparaison sur des résultats réels.

**Prérequis de reprise** (lot 4B, accord séparé) : serveur préproduction
(lot 3), puis re-vérification ciblée des trois correctifs sur des
recherches réelles autorisées.
