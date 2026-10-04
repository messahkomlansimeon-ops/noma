# ROADMAP — Prototype UI NOMA

Légende : ☐ à faire · 🚧 en cours · ✅ fait

## Étape 0 — Scaffolding
- [x] Vérifier node/npm, créer l'app Next.js 16.3 + TS + Tailwind v4 (App Router, Turbopack)
- [x] Nettoyer le starter, configurer next/font (Bricolage Grotesque + Manrope)
- [x] npm run dev fonctionnel

## Étape 1 — Fondations
- [x] Tokens Tailwind (@theme) : crème #FAF8F1, encre #1A2142, vert #0E5F3B,
      orange #F97316, badge bleu externe, fills doux (sage/carrot/wash), rayons 20-24px
- [x] lib/data.ts : types (Offer, Thread, Order, CaseItem, QuoteLine…) + seed
      identique aux maquettes (iPhone 145k/150k/140k, Canapé 185k, devis 25k…)
- [x] Store Zustand (lib/store.ts) : role, need, favoris, comparaison, alertes,
      messages, acceptOffer→commande, signalements, décisions admin, devis, toast
- [x] Composants : ui.tsx (Badge/Chip/Btn/OptionCard/Segmented/Switch/MenuRow…),
      Logo, TopBar, TabBar (acheteur/vendeur/admin), Thumb, OfferCard,
      Timeline + StepBar, Toast
- [x] Switcher de rôle flottant (démo, en haut à droite)

## Étape 2 — Écrans acheteur (18)
- [x] 01 Accueil · besoin (« Votre besoin. Les bonnes pistes. »)
- [x] 02 Résultats (pistes + Pertinence/Filtres/Comparer + sélection + barre comparer)
- [x] 03 Détail de l'offre (« Pourquoi cette offre ? » + inviter le vendeur)
- [x] 04 Comparaison côte à côte (tableau État/Livraison/Garantie/Dispo/Total)
- [x] 05 Créer une alerte (fréquence, date fin, toggle WhatsApp)
- [x] 06 Recherches suivies (actives/terminées, pause, WhatsApp)
- [x] 07 Connexion (téléphone +225, continuer sans compte)
- [x] 08 Vérification (code 5 chiffres + clavier + compte à rebours)
- [x] 09 Favoris (Tous/Produits/Services, cœur, annonce supprimée grisée)
- [x] 10 Messages (liste + recherche + non lus)
- [x] 11 Échange vendeur (chat + carte offre + Accepter l'offre → commande)
- [x] 12 Suivi de commande (timeline + livraison prévue + paiement direct)
- [x] 13 Mon compte (menu + Devenir vendeur)
- [x] 14 Mes commandes (en cours/terminées, badges devis/demande)
- [x] 15 Signaler un problème (motifs + preuve + lien commande)
- [x] 31 Partager sa demande (qui recevra, infos partagées, coordonnées privées)
- [x] 32 Propositions reçues (comparer les propositions)
- [x] 33 Inviter un vendeur (copier lien, 3 étapes, inscription requise)
- [x] Câblage : besoin→résultats→détail→comparer→alerte ; accepter offre→commande

## Étape 3 — Écrans vendeur (9)
- [x] 17 Tableau de bord (stats, À traiter, publier une annonce)
- [x] 16 Profil vendeur (logo, catégories, zones, tel confirmé, règles)
- [x] 18 Mes annonces (Toutes/En ligne/Brouillon, Modifier/Marquer vendu)
- [x] 19 Créer une annonce (Produit/Service/Location, photos, état, dispo)
- [x] 20 Demandes reçues (Toutes/Nouvelle/Répondues, faire une proposition)
- [x] 21 Faire une proposition (dispo, prix, livraison, créneau, accord requis)
- [x] 22 Devis de prestation (lignes dynamiques + total calculé, validité)
- [x] 23 Commandes vendeur (à confirmer/en cours, messages, paiements)
- [x] 24 Gérer une commande (avancement 3 étapes, créneau, paiement déclaré)
- [x] Câblage : demande→proposition ; devis→commande ; passer en mode acheteur

## Étape 4 — Écrans admin (4)
- [x] 25 Pilotage (compteurs, dossiers ouverts, santé des sources)
- [x] 26 Signalements (ouverts/clôturés + tri assisté IA)
- [x] 27 Examen dossier (éléments, synthèse IA, décision + motif → clôture)
- [x] + Vendeurs (liste, badges de vérification) / Réglages (placeholder)
- [x] Câblage : signalement acheteur → dossier admin → décision → clôturé

## Étape 5 — Finitions
- [x] États vides (commandes terminées, dossiers clôturés, favoris)
- [x] Toasts (activation alerte, signalement, décision, lien copié, devis)
- [x] Desktop : colonne centrée max 480px sur fond crème + bordures latérales

## Étape 6 — Vérification
- [x] npm run build vert (32 routes, 0 erreur TS)
- [x] npm run lint vert (0 warning)
- [x] Parcours rejoués : acheteur / vendeur / admin

## Journal
| Date | Étape | Note |
|------|-------|------|
| 02/10 | 0 | Next 16.3.8 + Tailwind v4 scaffoldé via create-next-app (tmp → repo) |
| 02/10 | 1 | Docs Next 16 consultées (params Promise, LayoutProps, Turbopack) |
| 02/10 | 2-4 | 33 écrans maquettés implémentés, store + flux câblés |
| 02/10 | 5-6 | build + lint verts ; no-unescaped-entities off (texte FR) |
| 02/10 | 7 | Accès téléphone : allowedDevOrigins + tunnel localtunnel (ufw actif) |
| 02/10 | 8 | Accueil vitrine (catégories + produits phares) + Sheet popup :
              « Que recherchez-vous ? » (accueil) et « Nouvelle annonce »
              (dashboard vendeur + mes annonces) ; pages dédiées conservées |
| 02/10 | 8b | Fix Sheet : slide translateY(100%)→0 sans conflit translate-x ;
             fix boutons Produit/Service/Location empilés (flex manquant) |
| 02/10 | 8c | Fix Sheet : verrou du scroll de fond (body overflow hidden) à l'ouverture |
| 02/10 | 9 | PoC sources exécuté : FB URL ville Abidjan viable sans login (19/19
              annonces FCFA), CoinAfrique 84 annonces déterministes, Locanto 6
              (call view), SERP publics instables → Google CSE recommandé.
              105 offres scorées (gpt-4o-mini), coût 0,0039 $/run → verdict GO
              (poc/README.md) |
| 02/10 | 10 | Quick wins PoC v2 : pré-filtre déterministe (68% appels IA évités),
             dédup intelligente Jaccard+prix (−28 doublons cross-source),
             photos FB 20/20, cache 15 min (43 s chaud / 0,0022 $),
             Locanto call view conservé, Google résolu : CSE API + plugin
             :online d'OpenRouter (testé : Jumia/Jiji trouvés) |
| 02/10 | 30 | 15e revue (2 écarts) : frais web :online ACTIVÉS dans le
             chemin réel (gsearch google-online transmet webSearch:true —
             les 0,05 $ sont désormais réservés) ; « 1 token/caractère
             maximum garanti » corrigé en ESTIMATION PRÉVISIONNELLE large
             (certains caractères Unicode coûtent plusieurs tokens) —
             qualification alignée dans le code, les tests et le README.
             208 tests verts, tsc vert |
| 02/10 | 29 | 14e revue (plafond IA) : présenté comme BUDGET PRÉVISIONNEL
             avec arrêt conservateur (messages « budget IA épuisé ») ; borne
             d'entrée prévisionnelle large (1 token/caractère, suffixe
             système et enveloppe inclus) ; frais web :online ajoutés à la
             borne (hors tokens) ; interruption après envoi = facturation
             incertaine →
             réserve conservée + coût inconnu → appels suivants bloqués
             jusqu'à réconciliation. 208 tests verts (+2), tsc vert |
| 02/10 | 28 | 13e revue (plafond IA non strict) : réserve = BORNE du coût
             de l'appel (entrée estimée + maxTokens × plafond de prix par
             modèle, table PRICE_CEILING_PER_1K) ; borne > solde → refus
             avant tout appel (0,005 $/0,01 $ = 0 appel) ; plus de Math.min()
             ni de réserve fixe ; sémantique documentée (plafond strict si
             bornes fiables, seuil d'arrêt sinon). 206 tests verts (+2), tsc vert |
| 02/10 | 27 | 12e revue (4 garanties du moteur) : plafond IA strict (garde
             avant chaque modèle, ≥, réservation 0,01 $/appel pour les
             simultanés, coût inconnu = plafond atteint — 0 $ = 0 appel) ;
             annulation jusqu'au fournisseur (makeRealAi(signal), lots sautés
             si annulé) ; ai:null = tous les chemins IA via llmJson (porte
             unique) ; preuves navigateur par run/source (evidenceDir,
             optionnelles) ; limite cache mono-processus documentée.
             204 tests verts (+6), tsc vert |
| 02/10 | 25 | Étape 1 multi-utilisateur : moteur extrait en `runSearch()`
             (lib/engine.ts) — CLI = enveloppe mince ; état isolé par run
             (RunCtx/AsyncLocalStorage : journal, compteur IA, compteurs
             cache) ; écritures cache sérialisées ; injections (connecteurs,
             IA null=muet, journal, signal d'annulation globale) ; plafond
             IA par run (maxCostUsd → dégradation propre) ; artefacts
             optionnels. 198 tests verts (+6), tsc vert, validation live
             CLI OK. Suivant : étape 2 Supabase (comptes/RLS), 3 worker,
             4 veille |
| 02/10 | 24 | 11e revue (P1 anonymisation) : la règle paires exige une
             première paire avec 0 initial — « iphone 12 07 58 96 75 41 »
             masque le numéro entier sans absorber le modèle (requête
             « iphone 12 », plus « iphone 41 »). Test adjacent ajouté.
             192 tests verts, tsc vert |
| 02/10 | 23 | 10e revue (2 défauts d'anonymisation) : espaces insécables
             (U+00A0/U+202F) normalisés avant détection — paires masquées,
             masques retirés de la requête site ; montants préservés (règle
             0-initial : « 15000000 FCFA » intact, coordonnées = 0 initial /
             +225 / paires) ; limite documentée (numéro sans 0 ni préfixe).
             191 tests verts, tsc vert |
| 02/10 | 22 | 9e revue (3 défauts) : anonymiserBesoin en amont (téléphones/
             e-mails masqués console+JSON+parseur, prix lisibles) ; mesures
             cache honnêtes (fromCache/ageMs/netMs, avecCache — durée
             affichée = lecture actuelle, réseau initial préservé ; compteurs
             par source) ; classification HTTP (401/403/429 → blocked jamais
             relancé, 4xx → http définitif, 5xx/408 → network relançable).
             188 tests verts, tsc vert |
| 02/10 | 21 | Mesures & charge (décision proxy chiffrée) : bilan synthétique
             par source (statut/motif/durée, imprimé + JSON) ; cache
             instrumenté (lectures OK/échecs, écritures, skipped, âge des
             données, TTL par source, purge des expirées) ; withRetry borné
             et espacé (réseau transitoire seul, annulation honorée) câblé
             CoinAfrique + Google ; journal sans clés/données perso/URL
             complète. 182 tests verts (10 nouveaux), tsc vert |
| 02/10 | 20 | 8e revue (2 défauts) : quartier demandé + commune annoncée
             (« Cocody »/« Abidjan » pour un besoin « Angré » = incertain,
             jamais rejeté ; autre commune/quartier = rejet avéré) ; « 5k
             FCFA » = 5 000 côté besoin et annonce (garde ≥ 50 réservée à la
             voie sans devise). 174 tests verts, tsc vert |
| 02/10 | 19 | 7e revue (5 défauts : budgets + géographie) : montants jamais
             tronqués (« 150k » = 150 000, « 4,700,000 FCFA » = 4,7 M — côté
             besoin ET annonce) ; abréviations F/frs/F.CFA (famille CFA sans
             frontière finale : titres FB collés) ; « jusqu'à 150 000 »
             apostrophe droite/typo (texte accent-strippé) ; localités San
             Pedro/Port Bouët/Yop (FB ne replie plus sur Abidjan) ; zone
             précise : Yopougon ≠ Cocody rejeté, « Abidjan » sans commune =
             « commune non précisée » (plus de « zone ok » mensonger),
             Bingerville demandé compatible, Riviera/Angré/Abatta quartiers
             de Cocody. 172 tests verts, tsc vert |
| 02/10 | 18 | 6e revue (2 défauts restants) : valeurs multiples extraites
             (« pointure 42/43 » = 42 ET 43 — demande 43 candidate ; unités
             réalistes pointure/taille/places/pouces, séparateurs / et -,
             garde anti-prix groupé) ; virgule-milliers (« 12,000 BTU » =
             12000, plus « 12 BTU »). 2 cas + gardes en tests de
             non-régression. 167 tests verts, tsc vert |
| 02/10 | 17 | 5e revue (4 défauts reproduits par l'utilisateur) : valeur liée à SON
             unité (« TV 65 pouces, 55 W » ne confirme plus « 55 pouces » —
             extraction unité-ancrée, alias taille≡pointure) ; décimales et
             milliers (« 1,5 CV » ≠ 5 CV, « 12 000 BTU » garde sa contrainte) ;
             chaque check ↔ son attribut (index aligné — « 200 litres » ne
             valide plus « 100 W ») ; « Correspondance exacte » exige les
             attributs confirmés. 4 reproductions = tests de non-régression.
             164 tests verts, tsc vert. Promesse ajustée : caractéristiques
             vérifiées sur les catégories testées, pas encore systématiques |
| 02/10 | 16 | Pertinence multi-catégories : caractéristiques chiffrées
             génériques (pointure/pouces/BTU/CV/W/L/m/cm/kg/places) extraites,
             appliquées requête→filtrage→scoring→raison (valeur ≠ même unité =
             rejet avéré ; absente = information manquante) ; summarizeSources
             distingue « aucune offre (sources opérationnelles) » de « sources
             indisponibles ». 160 tests verts. Validation live : pointure 42 ✓,
             TV 55 pouces (top 4 confirmés, 78 rejets) ✓, clim 12000 BTU ✓,
             table 6 places Cocody ✓ (top 8 confirmés), vélo électrique
             Bouaké ✓ (top 2 zone exacte, hors-zone déclassées), déménagement
             3 pièces ~ (limite : « 3 pièces » attire des locations d'applats,
             1 vrai service) — relevé honnête dans poc/README.md |
             (parseFreshness, unités des connecteurs, grading monotone
             min>h>j>semaine>mois>absent — « 1 heure »/« 2 h »/« 2 j » corrigés)
             et confirmedRatio au dénominateur du besoin (prix absent ou devise
             inconnue = non confirmé, jamais retiré du calcul). 145 tests verts |
| 02/10 | 14 | 3e revue (3 constats) : besoins accessoires légitimes
             (chargeur/coque/AirPods/table en verre → candidates ; coque
             rejetée seulement pour un besoin téléphone), check du signal
             après DNS avant connexion (0 requête envoyée), score
             déterministe gradué (capacité/critères/fraîcheur intégrés,
             1,00 = tout confirmé et récent) + confirmedRatio affiché.
             138 tests verts · run live : chargeur USB-C → 41 candidates ✓,
             iPhone Pro top 8 gradué 1,00→0,92 sans 1,00 automatique |
             aux 4 connecteurs réels + IA (passé avant cache, navigateurs
             fermés à la coupure), négations (« pas en bon état »), valeurs IA
             par tokens complets (« 5 % » ≠ « 85 % »), accessoire avant marque
             = incompatible (Coque/Chargeur/Verre/Étui), plafond deflate
             (RangeError → too-large), DNS bornée par le délai total.
             126 tests verts · run live : 110→33 candidates, 23/33 IA,
             10 replis déterministes honnêtes |
             d'abord : 109 tests verts. Pinning DNS réel (connexion par IP
             littérale, SNI/Host — bug node lookup ; IPv4 préféré), gzip
             décompressé une fois (serveur local de test), budget marqueur
             (mMarker[1]), modèle+variante dans les requêtes (Pro ≠ Pro Max),
             affirmation IA vérifiée mot pour mot + exactitude conditionnée à
             zone/critères, cache page par URL canonique, validation IA par
             lot avant décalage, alternatives jamais fusionnées (pipeline
             testable), émission progressive + délais bornés (sources et IA)
             avec annulation réelle ; + bug séquentiel besoin (Pro Max 256 Go).
             Run live : 109→33 candidates, tout Pro, 0,0120 $ |
             verts ; besoin structuré (capacité à unité explicite, budget
             null si absent — plafond implicite et +10% supprimés) ;
             constructeurs de requêtes par connecteur + capacités déclarées ;
             dédup par URL canonique/id (tracking retiré, 2 vendeurs distincts,
             groupes de doublons possibles) ; devises XOF/USD/EUR/unknown
             (non comparable jamais comparé) ; scoring code+IA par critère
             avec extraits, ids validés, échec → « non évalué par IA » ;
             safeFetch SSRF (15s/3red/2Mo, DNS-rebind, transport injectable) ;
             orchestration isolée (2 navigateurs/3 téléchargements, run dirs
             séparés, erreurs jamais cachées) ; validé live sur iPhone 12 /
             canapé Cocody / plombier Bouaké — requêtes distinctes, limites
             documentées (poc/README.md v3, data/golden/reference.json) |

## Reste pour la suite (hors prototype UI)
- ☐ Backend réel (auth SMS OTP, Postgres, stockage photos)
- ☐ PoC recherche IA (OpenRouter + proxies) : accès sources, coût/recherche
- ☐ Bot WhatsApp (Cloud API) pour les alertes
- ☐ Modération réelle (règles, badges vendeurs, historique persistant)