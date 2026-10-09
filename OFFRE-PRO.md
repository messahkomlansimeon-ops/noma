# OFFRE-PRO.md — Abonnements, droits, crédits promotionnels et import de catalogue (lot PRO1)

L'**offre Pro** de noma (AUDIT-EVOLUTION-SCOUTR.md §5 M4/M6 et §7, lot 7 : « Crédits Pro sans dépassement des slots ») : des **plans versionnés**, un **abonnement payé avec les
crédits du porte-monnaie** (`WALLET.md`), des **droits appliqués côté serveur** (limite d'annonces en ligne, badge « Vendeur Pro », import de catalogue) et des
**crédits promotionnels séparés** des crédits payés, dépensés **en premier** sur les boosts par le **même** chemin d'achat (`BOOST-PURCHASE.md`) : jamais un contournement
des places ni du plafond vendeur. Tout l'argent est **simulé** (aucun prestataire réel).

> **PRIX PROVISOIRES.** Les prix, les crédits promotionnels et les limites des deux plans de départ (Gratuit : 0 FCFA, 10 annonces ; Pro : 10 000 FCFA par mois, 5 000 FCFA
> de crédits promotionnels par mois, 100 annonces, badge et import) sont des **valeurs de départ en attente d'une décision du fondateur**. Ils ne sont pas calculés, pas
> mesurés, pas validés économiquement. L'écran « Offre Pro » et l'administration le disent (« Prix provisoires »). Le traitement juridique et comptable des crédits
> (nature, TVA, durée de validité, remboursabilité) reste **à valider** avant tout paiement réel (`WALLET.md`).

Code : `lib/server/subscriptions/` (`config.ts`, `errors.ts`, `time.ts`, `plans.ts`, `entitlements.ts`, `promo.ts`, `notices.ts`, `lifecycle.ts`, `state.ts`, `admin.ts`,
`catalog-import.ts`, `http.ts`), `lib/server/admin/plans-http.ts`, migration `database/migrations/0021_pro_subscriptions.sql`, routes `app/api/subscription/**`,
`app/api/offers/import`, `app/api/admin/plans/**`, étape « subscriptions » de `lib/server/matching/runner.ts`, script `scripts/subscription-refund-period.ts`, client
`lib/client/pro-api.ts` et `lib/client/pro-view.ts`, écrans `/vendeur/offre-pro`, `/vendeur/annonces/import`, `/admin/offres`, badge `components/pro-badge.tsx`. Tests :
`npm run test:subscriptions`, `npm run test:subscriptions-http` et, côté navigateur, `e2e:demo`.

## Plans et versions (migration 0021)

| Table | Rôle |
|---|---|
| `plans` | Un plan par code (`free`, `pro`). Jamais modifié ni supprimé. |
| `plan_versions` | Une **version** : numéro (1, 2, 3… sans trou), nom, prix mensuel (XOF entier), crédits promotionnels par période, nombre maximal d'annonces en ligne, droits (liste blanche : `badge_pro`, `catalog_import`, `priority_support_label`), administrateur créateur. |

- **Une version publiée est IMMUABLE** : `UPDATE` et `DELETE` sont refusés par la base (`plan_immutable`) ; aucune route ne modifie une version. Une **nouvelle version**
  (`POST /api/admin/plans/{code}/versions`, administrateur) ne s'applique qu'aux **NOUVELLES souscriptions**. **Les abonnés actuels gardent leur prix** : un abonnement est renouvelé
  **au prix, avec les crédits promotionnels et les droits de SA version**, à chaque renouvellement, tant qu'il dure (décision du lot PRO1-bis : un abonné à 10 000 FCFA n'est jamais débité
  du prix d'une version créée depuis, sans avis). Migrer les abonnés existants vers une nouvelle version fera l'objet d'un **lot futur**, avec **avis préalable et acceptation** de l'abonné.
  L'écran « Offre Pro » de l'abonné affiche le **prix exact de son prochain renouvellement** (celui de sa version) ; l'administration dit « Les abonnés actuels gardent leur prix ».
- Valeurs de départ : `free` v1 « Gratuit » (0 FCFA, 0 crédit, 10 annonces, aucun droit) ; `pro` v1 « Pro » (10 000 FCFA, 5 000 FCFA promotionnels, 100 annonces, `badge_pro`
  et `catalog_import`). Un plan payant a un prix strictement positif ; le plan Gratuit n'a ni prix, ni crédits, ni droit (contrôlé avant tout SQL).
- La **version courante** d'un plan est la plus récente. Les droits d'un utilisateur sans abonnement en vigueur sont ceux de la version courante du plan Gratuit.

## Droits en vigueur (une seule règle serveur)

La fonction SQL `subscription_effective_version(utilisateur)` est la **règle unique** (limite d'annonces, badge, import, écran) : un abonnement est **en vigueur** si

- il est `active` et que sa période n'est pas terminée ; **ou** qu'elle est terminée mais que le renouvellement automatique est activé (le worker décide : renouvellement, ou
  délai de grâce) ; une **annulation** (renouvellement désactivé) perd donc ses droits **à la seconde où la période se termine**, même si le worker n'a pas encore tourné ;
- ou il est `past_due` (**délai de grâce**) et la grâce n'est pas écoulée ;
- jamais s'il est `ended`.

Aucun droit ne vient du client. `GET /api/subscription` expose `current` (plan, limite, droits) et `subscription.entitled`.

## Abonnement : souscription, période, renouvellement, grâce, fin, annulation

**Souscription** (`subscribeToPlan`, `POST /api/subscription { planCode, idempotencyKey, expectedPriceXof }`) : **une transaction SQL**, sous le verrou de l'utilisateur. **Prix affiché** (lot RA1-bis) : `expectedPriceXof` est le prix mensuel que l'écran AFFICHE pour ce plan ; il est obligatoire (entier positif) pour la route HTTP et comparé au prix de la **dernière version** du plan : s'il diffère (un nouveau tarif a été publié entre l'affichage et le clic), 409 `price_changed` (« Le prix de l'abonnement a changé : rechargez la page, puis réessayez. »), **rien n'est écrit ni débité**, l'écran referme la confirmation et relit le prix. Le rejeu d'une clé avec un autre prix affiché que celui payé est refusé de la même façon. Le service accepte l'omission du prix pour les outils internes (`demo:seed`, essais) ; la route ne l'accepte jamais :

1. rejeu de la clé d'idempotence (même plan : l'abonnement existant est renvoyé, `reused: true`, **aucun nouveau débit** ; autre plan : `idempotency_conflict` 409) ;
2. plan connu (`plan_not_found` 404) et payant (`plan_not_subscribable` 409) ; aucun abonnement en vigueur (`already_subscribed` 409) ;
3. abonnement, **débit des crédits payés** (transaction `subscription_charge`, voir « Grand livre »), période d'**un mois civil UTC**, émission des crédits promotionnels.

**Solde insuffisant : 409 `insufficient_balance`, rien n'est écrit** (ni débit, ni abonnement, ni période, ni émission, pas même un compte). **Les crédits promotionnels ne paient jamais un
abonnement.** 12 clics simultanés avec la même clé : un seul débit ; 6 clés différentes pour un même utilisateur : une seule souscription.

**Période** : `ends_at = starts_at + 1 mois` (calendrier UTC), garanti par la base. Les périodes d'un abonnement sont **contiguës** (le renouvellement commence à la fin de la
précédente) ; si le worker est resté arrêté plus d'un mois et que la période suivante serait déjà entièrement passée, elle commence au moment du traitement (jamais de
facturation d'une période entièrement passée).

**Renouvellement, grâce, fin** (`runSubscriptionStep`, **étape « subscriptions » du worker**, `runMatchingCycle`) : à l'échéance,

| Situation | Effet |
|---|---|
| `active`, renouvellement désactivé | fin (`canceled`), aucun débit |
| `active`, renouvellement activé, solde suffisant | période suivante **à la version de l'abonnement** (son prix, ses crédits : jamais ceux d'une version plus récente), nouveaux crédits promotionnels |
| `active`, renouvellement activé, solde insuffisant | **délai de grâce de 72 h à partir de la FIN de la période** : `past_due`, **droits conservés sans paiement** (choix accepté, pratique courante : « 3 jours de grâce pendant lesquels votre offre reste active »), avis « renouvellement impossible » ; si ces 72 h sont déjà écoulées (worker arrêté) : fin (`payment_failed`) directement |
| `past_due`, solde suffisant (après une recharge) | période suivante contiguë, `active` |
| `past_due`, solde toujours insuffisant | nouvelle tentative au plus **une par quart d'heure** (aucun avis de plus) |
| `past_due`, grâce écoulée, ou renouvellement désactivé | fin (`payment_failed` ou `canceled`) |

L'étape est **idempotente par période** (numéro unique par abonnement, verrou de l'utilisateur et de la ligne : deux traitements simultanés de la même échéance donnent une seule
période et un seul débit ; un second passage ne refait rien).

**Fin d'un abonnement** : retour au plan Gratuit. Les annonces **en ligne** au-delà de sa limite passent en **pause**, **les plus anciennes d'abord** (même chemin que la pause
d'une annonce : version de contenu, correspondances invalidées, événement de l'outbox) avec la raison **`paused_reason = 'plan_limit'`** (colonne `offers.paused_reason`, migration 0021) ;
le vendeur est **averti dans l'application** (avis « Offre Pro terminée » et « N annonces mises en pause », écrits dans la même transaction, un seul par événement). Aucun remboursement
automatique. Une annonce que le vendeur a mise en pause **lui-même** n'a aucune raison. La base impose que la raison n'existe que pendant la pause : elle est **effacée dès que le statut
change** (publication, archivage, pause du vendeur), quel que soit le chemin.

**Remise en ligne à la (re)souscription** : lors d'une souscription à un plan payant (la même transaction, après le débit), les annonces **`paused_reason = 'plan_limit'`** (et elles
seules, non archivées) sont **remises en ligne automatiquement, dans la limite du nouveau plan** (limite moins les annonces déjà en ligne), **en commençant par les plus RÉCENTES**, par le
même chemin que la publication (version de contenu, correspondances réévaluées, événement de l'outbox, contrôle des numéros : une annonce qui ne passe plus la règle reste en pause).
**Une annonce mise en pause par le vendeur n'est jamais remise en ligne.** Un avis « N annonces remises en ligne » le dit (texte fixe). Le double clic ne le fait qu'une fois (idempotence de
la souscription). Le texte de l'avis « annonces mises en pause » dit désormais : « Si vous repassez à l'offre Pro, elles seront remises en ligne automatiquement, dans la limite de votre offre. »

**Annulation** (`POST /api/subscription/auto-renew { autoRenew: false }`) : désactive le renouvellement ; l'abonnement et ses droits restent **jusqu'à la fin de la période déjà
payée**, **aucun remboursement** (partiel ou autre). Réactiver est possible pendant la période (ou pendant la grâce) ; après, il faut souscrire de nouveau (`period_ended` 409).

**Remboursement par l'administration** (`npm run subscription:refund-period -- --period <uuid> --reason <code>`, `refundSubscriptionPeriod`) : le **même mécanisme** que le
remboursement d'un boost (`boost:refund-purchase`) : **intégral**, une seule fois (`already_refunded`), aucune route HTTP. Une transaction `subscription_refund` rend le prix en crédits
payés, retire le **reste promotionnel inutilisé** de la période (écrit : `promo_expired`) et, si c'est la période **courante** d'un abonnement en vigueur, **termine l'abonnement**
(motif `refunded`, annonces au-delà de la limite Gratuit en pause, avis). Les crédits promotionnels déjà dépensés ne sont **pas** repris. Le remboursement d'une période ancienne
ne touche pas l'abonnement renouvelé.

## Grand livre (partie double, immuable : `WALLET.md`)

Comptes ajoutés (migration 0021) : `user_promo` (**sous-compte promotionnel** de chaque utilisateur, distinct de son compte de crédits payés `user`), et quatre comptes système
(créés par la migration, recréés à la demande) : `subscription_revenue`, `promo_issuance`, `promo_consumed`, `promo_expired`. Un solde `user_promo` n'est **jamais négatif** (`CHECK`).

| Transaction (`kind`, référence) | Écritures (exactes) |
|---|---|
| `subscription_charge` (`subscription_charge:<période>`) | `user` −prix, `subscription_revenue` +prix ; s'il y a des crédits promotionnels : `user_promo` +crédits, `promo_issuance` −crédits (**2 ou 4 écritures, UNE transaction**) |
| `subscription_refund` (`subscription_refund:<période>`, motif) | l'inverse du prix ; s'il reste des crédits promotionnels inutilisés : `user_promo` −reste, `promo_expired` +reste |
| `promo_expiry` (`promo_expiry:<émission>`) | `user_promo` −reste, `promo_expired` +reste (**l'expiration est ÉCRITE, jamais un effacement**) |
| `boost_purchase` (avec promotionnel) | `user` −payé / `boost_revenue` +payé (s'il y a une part payée) ; `user_promo` −promo / `promo_consumed` +promo (s'il y a une part promotionnelle) |
| `boost_refund` (avec promotionnel) | l'inverse intégral ; la part promotionnelle retourne à `user_promo` (émission encore valable) ou est **perdue** (`promo_consumed` −promo, `promo_expired` +promo) |

La base impose **qui peut toucher quel compte, et dans quel sens** (déclencheur `wallet_guard_account_usage`, doublé dans le code) : un crédit promotionnel ne se recharge pas, ne
s'ajuste pas, ne se retire pas, ne se rembourse pas en espèces (une recharge ou un ajustement qui touche `user_promo` est refusé). Une période, une émission et un mouvement
promotionnel ne s'enregistrent que si les écritures du grand livre leur correspondent (gardes `subscription_periods_guard`, `promo_grants_guard`, `promo_movements_guard`,
`boost_purchases_guard`) et un débit de période, un remboursement ou une expiration n'existent jamais sans leur objet (déclencheurs différés au COMMIT).

**Formules exactes** (vérifiées par `wallet:check`) : `balance(promo_issuance) = −Σ émissions` ; `balance(promo_consumed) = Σ dépenses − Σ restitutions − Σ pertes` ;
`balance(promo_expired) = Σ expirations (et annulations par remboursement de période) + Σ pertes` ; `balance(subscription_revenue) = Σ périodes payées − Σ périodes remboursées` ;
`balance(boost_revenue)` ne compte plus que la part **payée** des achats ; `balance(user_promo)` = somme des restes des émissions de son propriétaire.

## Crédits promotionnels

- **Émission** : une par période payée (`promo_grants`), montant de la version du plan, échéance = fin de la période. **Reste** = montant + restitutions − dépenses − expiré
  (`promo_grant_remaining`). Les mouvements (`promo_movements` : `spend`, `restore`, `lapse`) sont immuables.
- **Dépensés EN PREMIER** : un achat de boost verrouille les émissions dépensables du vendeur (non expirées **à l'heure de la base**), les consomme dans l'ordre d'échéance, et les
  crédits payés ne complètent que le reste (`splitBoostPrice`, fonction pure). Les crédits échus que le worker n'a pas encore expirés **ne se dépensent jamais**.
- **Même chemin d'achat, jamais un contournement** : places, plafond vendeur, portée, cotation, idempotence, ordre des verrous sont ceux de `BOOST-PURCHASE.md` ; la répartition
  intervient **après** tous les contrôles et **avant** le débit. Deux vendeurs qui se disputent la dernière place : un seul achat, le perdant n'est débité ni en crédits payés ni en
  crédits promotionnels. Deux achats simultanés du même vendeur ne dépensent jamais deux fois les mêmes crédits promotionnels.
- **Expiration** (`expirePromoGrant`, étape « subscriptions ») : à l'échéance, une transaction `promo_expiry` retire le reste exact ; l'émission est close (`expired_xof`, transaction
  liée). Jamais avant l'échéance (la base refuse). `wallet:check` signale (avertissement `promo_expiry_overdue`) une émission échue depuis plus de 15 minutes non expirée.
- **Non remboursables, non retirables** : aucune route ni commande ne les convertit en crédits payés. Au remboursement d'un boost payé avec eux, ils retournent à leur émission si elle est
  encore valable ; sinon la part est **perdue** (écrite), jamais rendue en crédits payés.
- Ils ne comptent **pas** dans le solde de crédits ; le porte-monnaie (`/compte/porte-monnaie`) montre deux montants : « Crédits » et « Crédits promotionnels » (avec leur échéance et
  leurs règles), et chaque ligne de l'historique sépare la part payée de la part promotionnelle (`promoAmountXof`).

## Limite d'annonces en ligne

Une annonce est « en ligne » quand elle est **publiée** et non archivée. La limite vient de la version du plan **en vigueur**, lue côté serveur. Elle est appliquée dans les **trois**
chemins qui mettent une annonce en ligne : `publishOffer` (publication d'un brouillon, remise en ligne après une pause : route `POST /api/offers/{id}/publish`), `createOffer` avec le
statut `published` et `updateOffer` vers `published`. Au-delà : **409 `offer_limit_reached`** (« Vous avez atteint le nombre maximal d'annonces en ligne de votre offre… »), rien n'est
écrit. Le verrou consultatif de l'utilisateur est pris **avant** la ligne de l'annonce et tenu jusqu'à la fin de la transaction : 5 publications simultanées avec 8 annonces en ligne
(limite 10) donnent exactement 2 succès. Un brouillon, une annonce en pause ou archivée ne compte pas. Une annonce déjà en ligne avant le lot n'est jamais retirée (seule la fin d'un
abonnement met en pause), mais on ne peut plus en publier de nouvelle au-delà de la limite.

## Badge « Vendeur Pro »

`proBadge` (vrai ssi la version en vigueur porte `badge_pro`) accompagne chaque correspondance côté acheteur (résultats d'un besoin et fiche d'une annonce) ; il est lu par
`subscription_effective_version` à chaque lecture. Affichage : « Vendeur Pro » avec, au survol et **écrit sous le badge sur la fiche** : « Abonné à l'offre Pro de noma. Ce n'est pas
une garantie de qualité. » Le badge **ne change ni la pertinence, ni le classement, ni le score**, et n'expose ni le plan, ni les dates, ni l'identité du vendeur. Sans abonnement en
vigueur (jamais abonné, terminé, annulé après la fin de la période) : aucun badge.

## Import de catalogue (droit `catalog_import`)

`POST /api/offers/import { csv, dryRun }` (écran `/vendeur/annonces/import`). Réservé aux abonnés dont la version du plan en vigueur porte `catalog_import` (sinon **403
`entitlement_required`**, aussi pour l'aperçu).

- **Fichier** : texte CSV, **200 lignes de données au plus** (en-tête exclu) et 256 Kio au plus ; **201 lignes : refusé en entier** (`too_many_rows` 400, rien n'est créé). Séparateur
  `,`, `;` ou tabulation (celui de l'en-tête), guillemets doubles. Colonnes (accents et casse indifférents) : `titre` (obligatoire), `description`, `categorie`, `marque`, `modele`,
  `variante`, `etat`, `localisation`, `prix`, `disponible`. Colonne inconnue ou en double, guillemet non fermé, caractère de contrôle : `invalid_file` 400. **Aucun fichier n'est stocké.**
- **Aperçu à blanc** (`dryRun: true`) : **le même code** que l'application, exécuté dans la transaction qu'il **annule** à la fin : il rapporte exactement ce que l'application ferait
  (lignes refusées pour la limite d'annonces comprises) sans écrire quoi que ce soit (ni annonce, ni événement, ni empreinte).
- **Chaque ligne passe par la MÊME validation et la MÊME création que le formulaire « Nouvelle annonce »** : `buildOfferInput` (la fonction du formulaire : titre, description, prix en
  FCFA, catégorie et état de la liste du formulaire, « Occasion » par défaut), puis `createOffer` (mêmes contrôles de contenu : **numéro de téléphone refusé** dans la marque, le modèle, la
  variante, la localisation, sous toutes ses formes, y compris chiffres d'un autre alphabet ; limite d'annonces en ligne). Les annonces sont créées **en ligne**.
- **Rapport ligne par ligne** : numéro de ligne du fichier, issue (`created`, `would_create`, `rejected`), code (`invalid_field` + champ, `too_many_columns`, `phone_number_in_offer`,
  `offer_limit_reached`, `invalid_row`), identifiant de l'annonce créée. **Jamais une donnée du fichier** (ni titre, ni prix, ni numéro). Une ligne refusée n'empêche pas les autres.
- **Idempotent par empreinte du fichier** (SHA-256 du texte normalisé : sans marque d'ordre des octets, fins de ligne `\n`) et par vendeur : rejouer un fichier déjà appliqué renvoie son
  rapport (`alreadyApplied: true`) sans rien recréer ; l'aperçu d'un fichier déjà appliqué le dit aussi. L'empreinte n'est inscrite qu'avec l'application complète (une panne n'enregistre rien :
  le fichier peut être réappliqué).

## Routes HTTP

Toutes : `Cache-Control: no-store`, `nosniff`, JSON ; **origine vérifiée AVANT la session** sur ce qui écrit ; l'utilisateur vient **toujours** de la session ; corps JSON **strict**
(`application/json`, clés exactes) ; DTO en liste blanche (jamais d'identifiant d'utilisateur, de compte, de période, de transaction ni de version) ; textes d'erreur fixes.

| Méthode | Chemin | Corps | Réponse |
|---|---|---|---|
| `GET` | `/api/subscription` | — | 200 `{ contractVersion: "subscription/v1", pricesProvisional, plans, current, onlineOffers, subscription, promo, notices, unreadNotices, readAt }` |
| `POST` | `/api/subscription` | `{ planCode, idempotencyKey, expectedPriceXof }` | 201 (ou 200 rejeu : `reused: true`) l'état ci-dessus ; 409 `price_changed` si le prix affiché n'est plus le prix courant |
| `POST` | `/api/subscription/auto-renew` | `{ autoRenew }` | 200 l'état ; 409 `no_subscription`, `period_ended` |
| `POST` | `/api/subscription/notices/read` | `{ all: true }` ou `{ ids }` | 200 `{ unreadNotices }` ; 404 avis inconnu ou d'autrui (identique) |
| `POST` | `/api/offers/import` | `{ csv, dryRun }` | 200 aperçu ou rejeu, 201 application ; 403 `entitlement_required` ; 400 `too_many_rows`, `invalid_file` |
| `GET` | `/api/admin/plans` | — | 200 versions, abonnés arrondis à 5 près, revenus du mois (administrateur) |
| `POST` | `/api/admin/plans/{code}/versions` | `{ name, monthlyPriceXof, promoCreditsXof, maxOnlineOffers, entitlements }` | 201 la nouvelle version (administrateur) |

Autres codes : 400 `invalid_request`, 401 `authentication_required`, 403 `invalid_origin`, 404 `resource_not_found` (plan inconnu, et **le même 404 pour tout ce qui n'est pas un administrateur
actif** sur `/api/admin/plans*`), 409 `insufficient_balance`, `already_subscribed`, `plan_not_subscribable`, `price_changed`, `idempotency_conflict`, 503 `subscription_unavailable`. La publication au-delà de la
limite répond **409 `offer_limit_reached`** (`POST /api/offers/{id}/publish`). `GET /api/wallet` renvoie en plus `promoBalanceXof` et `promoExpiresAt`, et `promoAmountXof` par ligne ;
`POST /api/offers/{id}/boost-purchases` renvoie `promoAmountXof` (part payée en crédits promotionnels).

## Administration (`/admin/offres`)

Page séparée (un lien depuis l'aperçu d'administration) : versions de chaque plan en **lecture seule** (la plus récente est « courante »), création d'une **nouvelle** version,
**abonnés arrondis à 5 près** (jamais un compte exact : `roundToBase` ; l'écran écrit « moins de 5 » pour un arrondi nul, jamais « environ 0 », sinon « environ N »), **revenus d'abonnement du mois** (nets, lus dans le grand livre, mois civil UTC) et mouvement des crédits
promotionnels du mois. Les prix y sont dits **provisoires** et l'écran dit que **les abonnés actuels gardent leur prix** (une nouvelle version ne s'applique qu'aux nouvelles souscriptions).
La page est sous le gabarit de l'espace d'administration (lot D3, `app/(admin)/layout.tsx` : `requireAdminSpace()`) : un compte connecté qui n'est pas administrateur obtient la **page 404 standard
de Next** (statut 404, sans titre ni sélecteur d'espace, donc aucun onglet Admin), exactement comme pour une adresse inconnue ; les routes `/api/admin/plans*` répondent le même 404.

## Exploitation

- **Migration 0021 obligatoire** avant d'utiliser le code du lot (sans elle : lecture des correspondances, publication, porte-monnaie et `wallet:check` échouent ; l'étape « subscriptions »
  du worker est ignorée sans erreur, `skipped: true`). **Sauvegarde `pg_dump` avant toute migration. `noma_dev` n'est PAS migré par ce lot.** Après toute restauration : `npm run wallet:check`.
- `wallet:check` (`WALLET.md`) est étendu : équilibre, aucun solde négatif, **promotionnel jamais négatif**, expirations cohérentes, formules des comptes système, périodes, émissions,
  mouvements ; avertissements `promo_expiry_overdue` et `subscription_overdue` (le worker retarde).
- Rôle PostgreSQL de l'application : mêmes règles que `WALLET.md` ; `SELECT` et `INSERT` sur les tables nouvelles, `UPDATE` sur `subscriptions`, `subscription_periods`, `promo_grants`
  (expiration), ni `DELETE` ni `TRUNCATE`.
- Recherche active payante (lot RA1) : elle ne se paie **jamais** en crédits promotionnels (garde de la base et du service, `RECHERCHE-ACTIVE.md`) ; son verrou par utilisateur (`1_314_664_990`) est distinct de celui des abonnements (`1_314_664_972`), les deux finissent par les comptes du grand livre dans le même ordre.
- Ordre des verrous (jamais à l'envers) : verrou de l'utilisateur (espace consultatif `1_314_664_972`) → ligne de l'abonnement → lignes d'annonces → émissions promotionnelles → comptes du grand
  livre (identifiant croissant). L'achat de boost prend ses verrous métier, puis les émissions (6b), puis les comptes (7) : `BOOST-PURCHASE.md`.
- `demo:seed` : le **vendeur démo devient Pro**, avec des crédits promotionnels, de façon idempotente (`scripts/demo-seed.ts`, `scripts/demo-seed-plan.ts`).

## Limites et décisions ouvertes

- **Prix, crédits et limites provisoires** (voir le cadre en tête).
- Le renouvellement est géré par le worker : si celui-ci s'arrête, un abonné qui se renouvelle automatiquement garde ses droits jusqu'à la reprise (une annulation, elle, les perd à la fin de
  la période) ; `wallet:check` avertit d'un abonnement échu non traité depuis plus d'une heure.
- Les périodes manquées après un arrêt de plus d'un mois ne sont pas facturées (la période suivante commence au traitement).
- Aucune limite de débit propre aux routes de l'offre Pro (un utilisateur est borné par l'unicité de son abonnement en vigueur et par l'idempotence) ; l'import tient le verrou de
  l'utilisateur le temps de traiter jusqu'à 200 lignes.
- Pas de remboursement au prorata, pas de remboursement HTTP, pas de changement de plan en cours de période, pas de plan Business, pas de réduction Pro sur le prix d'un boost (les crédits
  promotionnels sont le seul avantage monétaire).
- Le badge repose sur l'abonnement, pas sur une vérification de qualité : l'écran le dit.
- Les avis d'abonnement sont propres à l'espace vendeur (bandeau et page « Offre Pro ») ; ils n'apparaissent pas dans la liste des notifications de besoins.
- La limite d'annonces compte les annonces publiées : une annonce « indisponible » (stock épuisé) mais publiée compte.
