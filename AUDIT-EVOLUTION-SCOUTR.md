# noma / Scoutr — audit et plan d’évolution

Audit du 3 octobre 2026, fondé sur le code local. Livrable : architecture → correspondance avec les 41 sections du brief → écarts → migrations → plan. Aucune implémentation fonctionnelle ni migration exécutée.

**Avis : la vision est techniquement cohérente et peut prolonger l’existant. Le chantier principal est de transformer la recherche externe à la demande en catalogue persistant avec matching interne. La rentabilité et les tarifs proposés restent des hypothèses à mesurer.** Le dépôt utilise « noma » ; « Scoutr » désigne ici la vision produit, sans renommage automatique.

## 1. Architecture réellement présente

| Couche | Constat vérifié | Décision |
|---|---|---|
| Application | Next.js 16.3.8, React 19, TypeScript, Tailwind 4, Zustand ; parcours acheteur, vendeur et admin | Conserver l’application et ses composants |
| Recherche publique | `POST /api/search`, flux NDJSON, résultats progressifs, clarification, annulation et reprise locale | Préserver ce contrat pendant la migration |
| Moteur | L’API importe directement le moteur de `poc/`, avec parsing, compréhension IA, connecteurs, déduplication, filtres et scoring | Réutiliser les fonctions ; `poc/` participe déjà au fonctionnement réel |
| Persistance serveur | SQLite contient uniquement `reservations`, `ledger`, `attempts`, `active_searches` pour protéger les recherches | Ajouter une base métier PostgreSQL ; ce ledger n’est pas un portefeuille client |
| Persistance navigateur | Recherche conservée 30 minutes dans `sessionStorage` ; autres parcours alimentés par données fictives et Zustand en mémoire | Remplacer progressivement les données simulées par des services persistants |
| Exploitation | Quotas, Turnstile, plafond IA, suivi des coûts, fetch sécurisé, timeouts, sauvegarde et scripts de déploiement | Garder ces protections et les adapter aux futurs workers |

Preuves : [dépendances](/home/aegonjs/Documents/workspeace/Fresh/noma/package.json), [API](/home/aegonjs/Documents/workspeace/Fresh/noma/app/api/search/route.ts:122), [adaptateur du moteur](/home/aegonjs/Documents/workspeace/Fresh/noma/lib/server/search-stream.ts:68), [SQLite](/home/aegonjs/Documents/workspeace/Fresh/noma/lib/server/db.ts:17), [recherche navigateur](/home/aegonjs/Documents/workspeace/Fresh/noma/lib/real-search.ts:1), [store de démonstration](/home/aegonjs/Documents/workspeace/Fresh/noma/lib/store.ts:54).

### Modèles et services réutilisables

- `ParsedNeed` : produit/service, modèle, variante, capacité, budget/devise, zone, attributs et critères. L’enrichissement sémantique distingue exigences, préférences et exclusions. Il manque notamment propriétaire, cycle de vie, quantité et délai structurés.
- `RawListing` : identifiant source, titre, prix/devise, zone, vendeur, URL, photo, date et description. Ce n’est pas encore une offre métier persistante normalisée.
- `EvaluatedListing` / `ScoredListing` : contrôles compatible/incompatible/inconnu, justification et taux d’informations confirmées. Bonne base pour le matching explicable.
- `PublicOffer` / `SearchEvent` : contrats publics à conserver et enrichir. `PublicOffer` n’expose actuellement aucun score numérique de compatibilité.
- `Offer`, `Demand`, `Listing`, `AlertItem`, `Thread`, `Order`, etc. dans `lib/data.ts` : modèles de démonstration, utiles pour les écrans mais pas preuve d’un backend opérationnel.
- `parseNeed`, `makeNeedUnderstander`, `classify`, `scoreListings`, `dedupListings`, `runSources`, `cached`, `llmJson`, protections et adaptateurs : réutiliser ; déplacer seulement lorsque nécessaire, avec réexports temporaires pour les imports existants.

Preuves : [besoin](/home/aegonjs/Documents/workspeace/Fresh/noma/poc/lib/need.ts:30), [annonce brute](/home/aegonjs/Documents/workspeace/Fresh/noma/poc/lib/normalize.ts:3), [filtres](/home/aegonjs/Documents/workspeace/Fresh/noma/poc/lib/filter.ts:500), [contrat public](/home/aegonjs/Documents/workspeace/Fresh/noma/lib/contracts.ts:109), [modèles UI](/home/aegonjs/Documents/workspeace/Fresh/noma/lib/data.ts:1).

## 2. Mapping avec la spécification

« Partiel » signifie qu’une brique existe, sans satisfaire tout le besoin. « À créer » concerne le service métier réel, même si un écran existe.

| Sections du brief | État | Réemploi et écart |
|---|---|---|
| 1–2, 40–41 : évolution et trois matchings | Partiel | Recherche acheteur → offres externes existante ; catalogue interne, matching interne et vendeur → demandes externes à créer |
| 3–4 : structure, extraction une fois | Partiel | Parseur, schémas et compréhension réutilisables ; extraction à persister par version, côté offre et demande |
| 5 : quatre dimensions | À refondre | Score existant mélange budget, correspondance et fraîcheur ; pas de prix de marché ni de confiance séparés |
| 6, 23 : gratuit / Pro / Business | À créer | Ni abonnements ni droits serveur ; conserver la recherche standard gratuite |
| 7–12, 17, 36–37 : pricing dynamique | À créer | Aucune configuration tarifaire métier, formule, durée ou cotation de boost |
| 13–16 : acheteurs compatibles, slots, pertinence, limites vendeur | À créer | Réutiliser les filtres ; ajouter comptages fiables, inventaire de boosts et règles d’exposition |
| 18–20, 35 : historique et efficacité | À créer | Historiser cotations, achats et événements ; ne pas déduire des ventes à partir des clics |
| 21–22 : recherche active et missions | À créer | Écrans d’alertes et besoins réutilisables ; aucun ordonnanceur métier, suivi payé ou budget par mission |
| 24 : crédits | À créer | Aucun paiement Mobile Money ni portefeuille ; les paiements déclarés dans les commandes sont simulés |
| 25–26 : coûts et boost sans IA | Partiel | Plafonds IA et coûts par recherche existants ; budget par produit et chemin boost sans IA à créer |
| 27–28 : collecte mutualisée | Partiel | Connecteurs et cache réutilisables ; pas de surveillance persistante d’un marché ni de collecte indépendante des recherches |
| 29 : doublons | Partiel | Fusion par identité/URL et groupes possibles par titre/zone ; manque persistance, signaux vendeur/contact/photo et hash perceptuel |
| 30–31 : disponibilité et provenance | Partiel | Source, URL, date et contrôle d’accessibilité existent ; pas de cycle de disponibilité ni d’historique complet |
| 32 : historique de marché | À créer | Les JSON de résultats de recherche ne constituent pas une série de prix comparable et qualifiée |
| 33 : notifications | À créer | Paramètres UI partiels ; aucun service d’envoi, consentement, déduplication et arrêt du suivi |
| 34, 38–39 : économie et achat complet | À créer | Journal IA réutilisable ; manque attribution des revenus/coûts et transaction atomique crédit + slot + boost |

## 3. Écarts qui déterminent l’ordre des travaux

1. **Les comptes et publications ne sont pas réels.** La vérification téléphone change simplement le rôle client ; publier une annonce affiche un toast « prototype ». Les layouts vendeur/admin ne contrôlent pas une identité serveur. Authentification et autorisations précèdent toute écriture métier ou monétisation. Voir [vérification](/home/aegonjs/Documents/workspeace/Fresh/noma/app/(auth)/verification/page.tsx:25), [publication](/home/aegonjs/Documents/workspeace/Fresh/noma/components/vendor/nouvelle-annonce-form.tsx:40), [layout admin](/home/aegonjs/Documents/workspeace/Fresh/noma/app/(admin)/layout.tsx:1).

2. **L’IA travaille encore par recherche.** `runSearch` enrichit le besoin puis note les candidats par lots de dix. Ce n’est pas un appel par couple, mais la même annonce peut être réévaluée à chaque recherche. Déplacer l’analyse vers la création/modification et conserver le résultat ; ne pas simplement augmenter les lots. Voir [compréhension](/home/aegonjs/Documents/workspeace/Fresh/noma/poc/lib/engine.ts:360), [scoring](/home/aegonjs/Documents/workspeace/Fresh/noma/poc/lib/engine.ts:564).

3. **Le score actuel ne peut pas devenir directement « 94 % compatible ».** La fraîcheur pèse 15 % et le score final peut être moyenné avec un score LLM. Séparer compatibilité, positionnement du prix, disponibilité et vérifications ; conserver les explications et inconnues. Un pourcentage sera un indice documenté, pas une probabilité de satisfaction. Voir [pondération](/home/aegonjs/Documents/workspeace/Fresh/noma/poc/lib/scoring.ts:118), [moyenne IA](/home/aegonjs/Documents/workspeace/Fresh/noma/poc/lib/scoring.ts:422).

4. **Le cache ne constitue pas une mutualisation durable.** Il réutilise des requêtes exactes avec TTL et reste limité à un processus. Les collecteurs par défaut sont tous externes ; ils renvoient des annonces d’offre, pas des intentions d’achat structurées. Voir [cache](/home/aegonjs/Documents/workspeace/Fresh/noma/poc/lib/cache.ts:1), [sources](/home/aegonjs/Documents/workspeace/Fresh/noma/poc/lib/engine.ts:415).

5. **Accessibilité et disponibilité sont différentes.** Une URL accessible ne confirme pas le stock ; un blocage réseau ne prouve pas une vente. Stocker l’origine de chaque confirmation et son horodatage.

6. **Les coûts connus couvrent surtout l’IA.** Il faut ajouter recherche externe, envois, paiement et infrastructure attribuable. Une dépense inconnue reste inconnue. Voir [journal de coûts](/home/aegonjs/Documents/workspeace/Fresh/noma/poc/lib/log.ts:1).

## 4. Architecture cible minimale

Conserver un monolithe Next.js, PostgreSQL pour les données métier et un worker pour les tâches différées. Commencer par filtres SQL et scoring déterministe ; ajouter les embeddings seulement si des mesures de rappel le justifient. Un embedding ne remplace jamais un critère obligatoire.

**Écriture :** texte/formulaire → parsing existant + extraction IA bornée → normalisation validée/corrigible → stockage versionné → événement de changement.

**Matching :** événement offre/demande → sélection SQL indexée des candidats → filtres obligatoires → score déterministe → stockage des matchs → exposition/notifications. Même moteur dans les deux sens ; pas de produit cartésien global.

**Recherche :** catalogue interne en premier → offres externes déjà stockées → éventuelle collecte autorisée et mutualisée. Une panne de source externe ne doit pas bloquer les offres internes.

**Boost :** cotation → transaction d’achat → priorité bornée parmi les offres compatibles → événements de mesure → expiration. Aucune dépendance vers l’extraction, le LLM ou la collecte web.

Conserver les adaptateurs UI ; introduire un domaine métier partagé sans copier les parseurs. Une file PostgreSQL et une outbox transactionnelle suffisent au départ. Le cache JSON et les limites mémoire actuelles devront être remplacés par des mécanismes partagés avant plusieurs processus de recherche.

## 5. Migrations proposées, par étapes

Ces noms décrivent le schéma à concevoir ; ce ne sont pas des migrations SQL exécutables.

| Étape | Tables / évolutions | Contraintes essentielles |
|---|---|---|
| M1 — identité et catalogue | `users`, `seller_profiles`, `categories`, `locations`, `sources`, `offers`, `demands`, `media`, `extraction_versions` | Propriétaire réel ; champs typés ; texte initial ; hash de contenu et version d’extracteur ; états et dates explicites |
| M2 — matching | `matches`, `outbox_events`, `jobs`, `availability_events` | Unicité offre/demande/version du moteur ; versions des données ; raisons et inconnues ; jobs idempotents et reprise après panne |
| M3 — visibilité | `boost_markets`, `pricing_rules`, `boost_quotes`, `boost_reservations`, `boosts`, `boost_events` | Version de règle ; cotation expirante ; prix proposé/payé ; facteurs observés ; durée ; quotas vendeur et réservations atomiques |
| M4 — crédits | `wallet_accounts`, `wallet_transactions`, `wallet_entries`, `payment_events`, `service_purchases` | Montants entiers en XOF ; écritures immuables et équilibrées ; solde non négatif ; identifiants fournisseur/idempotence uniques |
| M5 — suivi et collecte | `active_searches` métier, `missions`, `notification_preferences`, `notification_deliveries`, `market_watches`, `source_observations`, `duplicate_groups` | Distinguer ces recherches actives métier des verrous SQLite existants ; pause/expiration ; collecte unique par marché/source ; provenance conservée |
| M6 — économie et marché | `plans`, `subscriptions`, `entitlements`, `price_observations`, `cost_events` | Droits versionnés ; crédits promotionnels séparés ; type de prix ; coût natif, conversion datée et attribution |

Dans `offers` et `demands`, partager les concepts de catégorie, marque, modèle, variante, attributs, état, quantité/unité, localisation, délai, propriétaire et provenance ; conserver les différences prix/budget et stock/besoin. Exigences et préférences doivent être explicites. Utiliser des colonnes indexées pour les filtres fréquents et du JSON validé pour les attributs propres aux catégories.

Prévoir `source_type` interne/partenaire/externe, `source_name`, `source_url`, `external_id`, `first_seen_at`, `last_seen_at`, `last_checked_at`, `availability_status`, `availability_confirmed_at`. Unicité `(source_id, external_id)` quand disponible, URL canonique en secours ; garder les observations originales lors des regroupements.

Index initiaux : catégorie/modèle/variante/localisation/statut, prix et budget, dates d’expiration ; index des attributs utilisés et recherche textuelle selon les requêtes mesurées. Les notifications ne doivent pas exposer les coordonnées des demandeurs.

**Compatibilité de migration :** ajouts avant suppressions, fonctionnalités activables séparément, conservation de `/api/search` et NDJSON, nouveaux champs publics facultatifs, réexports des modules déplacés. Conserver les anciens identifiants publics via une table de correspondance si nécessaire. Garder SQLite pour les protections durant la première étape ; migration séparée avant changement d’architecture de déploiement.

Ne pas importer les seeds UI comme comptes, annonces ou transactions réels. Les caches et artefacts externes nécessitent provenance, droit de réutilisation et contrôle de fraîcheur avant import. Refaire les sauvegardes/restaurations et pouvoir désactiver une nouvelle fonctionnalité sans supprimer ses données.

## 6. Règles de boost à préciser dès la première version

### Deux plafonds distincts

- **Capacité vendable d’un marché** : boosts simultanément actifs/réservés, sur un segment stable défini par la taxonomie et la zone. Contrôler tous les intervalles de durée qui se chevauchent.
- **Exposition sponsorisée** : plafond sur chaque page effectivement servie, après filtrage. Avec 20 résultats et 15 %, au maximum 3 placements bénéficient du boost. Quinze boosts actifs sur 100 annonces ne garantissent pas, à eux seuls, ce ratio.

Conserver aussi une limite cumulée sur la pagination, éviter les répétitions et répartir les placements entre vendeurs éligibles. Les autres boosts actifs attendent leur tour ; aucune impression n’est garantie. Sur une liste trop courte, arrondir le quota vers le bas plutôt que dépasser la limite. Ne pas vendre de boost si aucune exposition admissible n’est possible.

Si le catalogue rétrécit pendant un boost, garder le plafond d’affichage et suspendre les nouvelles ventes de places ; définir avant lancement les compensations pour interruption effective du service. La rareté de capacité ne doit pas être gonflée par des annonces dupliquées ou des sources externes incontrôlées.

### Pertinence et demande réelle

Évaluer d’abord les contraintes obligatoires. Un champ obligatoire inconnu reste « à confirmer » et ne compte pas comme acheteur strictement compatible ; aucun boost sur cette base. Les alternatives hors budget restent séparées. Le boost ne modifie jamais le score de compatibilité affiché.

Compter les acheteurs uniques, actifs et non satisfaits, avec besoins encore valides ; exclure vendeur lui-même, doublons et activité suspecte. Exposer un nombre daté, pas des identités. Séparer concurrence, demande et saturation : beaucoup d’offres sans acheteurs ne suffit pas à justifier un prix élevé.

### Cotation et achat

Formule initiale : base × concurrence × demande × rareté × durée. Les facteurs sont déterministes, bornés et calculés sur des données datées. Résoudre une configuration versionnée selon catégorie/sous-catégorie/marché/zone, avec priorité explicite et valeur de repli.

Arrondir sur une grille autorisée **en restant entre minimum et maximum** ; le simple arrondi après un clamp peut dépasser les bornes. À zéro place, afficher l’indisponibilité, pas un prix infini. Une cotation conserve son prix pendant sa courte validité ; disponibilité revérifiée lors de l’achat. Les durées longues ont un facteur configurable et une capacité vérifiée sur toute la période.

Une transaction serveur vérifie propriété, admissibilité, cotation, slot, limite vendeur et solde, puis débite les crédits et crée le boost. Rejouer la requête ne débite pas deux fois. Les paiements externes alimentent le solde seulement après confirmation fournisseur vérifiée ; événements répétés, remboursement et rapprochement doivent être prévus.

Un crédit ou une réduction Pro réduit le montant payé, jamais les règles d’admissibilité ni les limites d’exposition. Business conserve également un plafond vendeur.

### Mesure et économie

Journaliser impressions réellement visibles, apparitions dans résultats, clics, favoris, contacts, matchs, conversations et ventes déclarées avec déduplication, attribution et exclusion des vues du vendeur. Une vente déclarée reste distincte d’une transaction confirmée.

Définir explicitement les dénominateurs : par exemple contacts uniques / impressions qualifiées, ventes déclarées attribuées / contacts uniques. Séparer nombre de matchs, acheteurs uniques et exposition obtenue. Stocker les données permettant tous les indicateurs du §35.

Attribuer les coûts partagés de collecte selon une règle documentée sans les compter plusieurs fois. Une recharge puis la consommation des crédits ne constituent pas deux revenus pour le calcul économique du service. Distinguer montant payé, réduction, crédits promotionnels et coût variable connu/estimé. La cible de 20 % doit être vérifiée sur des usages réels ; le traitement juridique/comptable des crédits reste à valider comme prévu au brief.

## 7. Plan d’implémentation et critères de sortie

| Lot | Travail | Validation avant le lot suivant |
|---|---|---|
| 0 — audit et référence | Ce document ; stabiliser la commande de tests ; figer les contrats actuels | Base vérifiable, limites des tests identifiées |
| 1 — fondations (priorité 2) | Auth serveur, PostgreSQL, annonces/demandes persistantes, photos, droits ; extraction versionnée à l’écriture | Un vendeur publie, un acheteur crée un besoin ; données conservées après reconnexion ; accès aux données d’autrui refusé |
| 2 — matching et scores (priorités 3–4) | Réutiliser filtres/normalisation, indexer candidats, calcul dans les deux sens, quatre dimensions distinctes | Nouvelle offre trouve les besoins existants et inversement ; quantité/délai/obligatoires contrôlés ; aucun appel LLM pendant le matching |
| 3 — boost en simulation (priorités 5–7) | Marchés, slots, règles admin, cotations, historique, ranking et métriques | Contention sur dernière place, quota vendeur, pagination et expiration validés ; aucune remontée hors pertinence ; aucun appel IA |
| 4 — paiement (priorité 8) | Crédits, achats atomiques, événements fournisseur, rapprochement et compensations | Doubles clics/webhooks sans double débit ; pas de solde négatif ni de slot survendu ; mesures d’efficacité disponibles |
| 5 — recherche active et missions (priorité 9) | Jobs durables, fréquence, expiration, pause/satisfaction, notifications et budgets | Arrêt fiable, absence de doublons, reprise après panne, aucune collecte dupliquée par utilisateur |
| 6 — externe mutualisé (priorité 10) | Réemployer connecteurs autorisés via surveillances de marchés ; stockage, déduplication et disponibilité ; demandes externes via adaptateurs adaptés | Une collecte sert plusieurs besoins ; même contenu analysé une fois ; panne externe sans panne interne |
| 7 — Pro et historique (priorités 11–12) | Abonnements/droits, import catalogue, prix affichés/observés/négociés/confirmés | Crédits Pro sans dépassement des slots ; statistiques de marché accompagnées d’effectif, période et comparabilité |
| 8 — optimisation (priorité 13) | Ajuster coefficients à partir des coûts et résultats observés | Gain mesuré sans dégradation de pertinence, accès des petits vendeurs ou part organique |

Les métriques commencent avant les paiements. Les confirmations de disponibilité commencent avec le catalogue. Les observations de prix peuvent être enregistrées dès la collecte, même si leurs analyses sont livrées au lot 7. Le worker du lot 5 reprend les jobs/outbox des fondations.

Pour préserver la promesse centrale, proposition à arbitrer avant les écrans payants : matching interne automatique inclus dans le gratuit ; recherche active payante pour un suivi plus fréquent, prolongé ou externe. Définir séparément une mission de volume, notamment achat fractionné entre plusieurs vendeurs et budget unitaire/total. Le nom définitif noma/Scoutr, les canaux de notification, les limites gratuites et les droits Business restent des décisions produit ; ils ne bloquent pas le catalogue et le matching.

## 8. Vérifications effectuées et limites

- Lecture du code, des scripts et du guide Route Handlers de la version Next.js installée. Aucune dépendance ajoutée ; aucune recherche externe ni paiement réel déclenché.
- `tsc --noEmit --incremental false` : réussi.
- `npm run lint` : réussi avec **9 avertissements**, aucune erreur.
- `npm test` racine : lanceur `tsx` bloqué par `EPERM` sur son socket IPC. Relance via `node --import` : fichiers contrats, protections, recherche client et flux réussis ; fichier route en échec dans cet environnement.
- `npm test` dans `poc/` : **15 fichiers réussis sur 20**. Échecs : `review2`, `review3`, `transport`, `scrapling-bridge`, `trial-coinafrique`. Le diagnostic confirme des refus `EPERM` pour le serveur local de transport et le sous-processus Python du pilote ; le pont présente aussi des erreurs « invalid JSON » à diagnostiquer. Toute la suite ne peut donc pas être déclarée verte.
- Pas de build, de validation navigateur, d’essai fournisseur ou de charge réalisé pour cet audit. Aucun chiffre de capacité, coût marginal ou rentabilité n’est présenté comme mesuré.

**Premier incrément recommandé : un besoin persistant rencontre une annonce interne persistante, avec critères expliqués et zéro appel LLM lors du matching.** C’est la base nécessaire pour vendre ensuite une visibilité réellement pertinente.
