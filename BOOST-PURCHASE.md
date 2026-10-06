# BOOST-PURCHASE.md — Achat atomique d'un boost avec les crédits du portefeuille (lot P1b)

Un vendeur **achète** le boost d'une de SES cotations (`BOOST-PRICING.md`) avec son solde de crédits (`WALLET.md`) : UNE transaction
SQL vérifie la cotation, l'offre, les places et le plafond vendeur, **débite** le compte, **crée** le boost et l'achat. Rejouer la
requête ne débite pas deux fois. Brief : AUDIT-EVOLUTION-SCOUTR.md §6 (« Cotation et achat »). Monnaie : XOF entiers (`BIGINT`, `bigint`,
entiers JSON), 1 crédit = 1 XOF.

**Ce lot n'a PAS** : d'écran (**ajouté au lot P2** : `ECRANS-P2.md`), de prorata, de route HTTP de remboursement, de vrai prestataire, de métrique d'efficacité.
**Le paiement ne rend JAMAIS pertinente une annonce non pertinente** (brief §15) : un boost acheté a exactement les effets d'un boost
attribué (`BOOST.md`) — il ne s'applique qu'à des offres déjà présentes dans le classement, ne change ni leur pertinence ni leur score,
et reste soumis à `min_relevance` et à la part promue maximale.

Code : `lib/server/boost/purchase.ts` (`purchaseOfferBoost`, `refundBoostPurchase`, `listOfferBoostPurchases`),
`lib/server/boost/purchase-http.ts` (routes), `lib/server/boost/boosts.ts` (règles de places partagées : `placeOfferBoostInTransaction`,
`cancelOfferBoostInTransaction`), `lib/server/wallet/check.ts` (réconciliation), migration `database/migrations/0015_boost_purchases.sql`,
route `app/api/offers/[id]/boost-purchases/route.ts`, script `scripts/boost-refund-purchase.ts`. Tests : `npm run test:boost-purchase`
(pur + base) et `npm run test:boost-purchase-http`.

## Modèle (migration 0015, additive : 0001 à 0014 inchangées)

- `offer_boosts.source` : `admin_grant` ou `purchase` (CHECK nommé remplacé). `grantOfferBoost` n'accepte toujours QUE `admin_grant`
  (`BOOST_SOURCES`) ; seul `purchaseOfferBoost` crée un boost `purchase` (`BOOST_RECORD_SOURCES`).
- `wallet_transactions.kind` : `topup`, `adjustment`, **`boost_purchase`**, **`boost_refund`**. Métadonnées : deux clés de plus,
  `boostPurchaseId` et `quoteId` (UUID). Forme EXACTE imposée (`chk_wallet_transactions_boost`) : un achat porte `{ boostPurchaseId,
  quoteId }` et la référence `boost_purchase:<achat>` ; un remboursement porte `{ boostPurchaseId, reasonCode }` et la référence
  `boost_refund:<achat>` (la référence est **unique** : un seul remboursement par achat, même en parallèle) ; les autres types ne portent
  aucune de ces clés.
- `boost_purchases` : `id`, `seller_id`, `offer_id`, `quote_id` **UNIQUE** (un devis ne s'achète qu'une fois, même remboursé),
  `boost_id` UNIQUE, `transaction_id` UNIQUE, `amount_xof` (> 0, ≤ 2^53 − 1), `duration_code`, `idempotency_key`, `created_at`,
  `refunded_at` et `refund_transaction_id` (UNIQUE) ; **(`seller_id`, `idempotency_key`) UNIQUE** ; clés étrangères vers les utilisateurs,
  offres, cotations, boosts et transactions (aucune suppression en cascade). Remboursé ssi la date ET la transaction sont renseignées.
- **Garde** `trg_boost_purchases_guard` : à l'insertion, la ligne est créée non remboursée et la cotation (disponible, même offre, même
  vendeur, même durée, **même montant**), le boost (source `purchase`, même offre, même vendeur, même durée) et les écritures du
  grand livre (exactement deux : vendeur −montant, `boost_revenue` +montant, référence dérivée de CET achat) lui correspondent ; ensuite
  tout champ est figé, **sauf** le passage unique `refunded_at NULL → date` avec `refund_transaction_id`, dont la transaction doit être le
  remboursement du montant **intégral** (`boost_revenue` −montant, vendeur +montant) ; jamais de suppression.
- **Fenêtre du boost acheté** : à l'insertion de l'achat, la garde exige `ends_at − starts_at` = la durée EXACTE du code (86 400, 259 200 ou
  604 800 s) et `starts_at` au plus 60 s avant l'achat (même transaction : l'écart réel est de quelques millisecondes) ; ensuite
  `trg_offer_boosts_purchase_window` interdit toute modification de `starts_at`, `ends_at`, `duration_code`, `offer_id`, `seller_id` et
  `source` d'un boost `purchase` (ou qui le deviendrait) — seuls le statut et `cancelled_at` changent : expiration par le worker,
  annulation et remboursement passent toujours (testé).
- **Cohérence au COMMIT** (déclencheurs différés `trg_offer_boosts_purchase_linked`, `trg_wallet_transactions_boost_linked`) : un boost
  `purchase`, une transaction `boost_purchase` ou `boost_refund` n'existent jamais sans leur achat. `TRUNCATE` n'est pas bloqué (comme
  pour le grand livre) : ne jamais le donner au rôle d'application.

## Achat : `purchaseOfferBoost({ pool, sellerId, offerId, quoteId, idempotencyKey })`

Une transaction, dans cet ordre ; tout échec à n'importe quelle étape annule TOUT (ni débit, ni boost, ni achat, pas même un compte).

1. **Validation avant SQL** (UUID du vendeur, de l'offre, de la cotation ; clé d'idempotence en UUID) : aucune requête avant.
2. **Idempotence** : verrou consultatif (vendeur, clé) puis relecture. Un achat existe pour cette clé : même cotation et même offre → il
   est renvoyé (`reused: true`, aucun nouveau débit, **même si la cotation a expiré depuis**) ; sinon `idempotency_conflict`.
3. **Cotation** : elle appartient à CETTE offre ET à CE vendeur (sinon `quote_not_found`, **indiscernable** d'une cotation inexistante) ;
   `quote_unavailable` (aucun prix : y compris `no_visible_effect` depuis le lot P2-bis, un devis dont le boost ne ferait monter l'offre chez
   aucun acheteur n'a pas de prix et ne s'achète pas) ; `quote_expired` (`clock_timestamp()` de la base ≥ échéance) ; `quote_already_used`.
4. **Placement** — `placeOfferBoostInTransaction`, **LA** fonction de `grantOfferBoost` (une seule copie des règles de places) : offre
   existante, à ce vendeur, éligible, clé produit complète (`offer_not_found`, `offer_not_owned`, `offer_not_eligible`,
   `offer_not_boostable`) ; verrou du périmètre ; **la cotation est relue sous le verrou** (échéance à CET instant, achat concurrent,
   périmètre de l'offre inchangé — sinon `quote_expired`/`quote_already_used`) ; boosts échus de l'offre marqués `expired` ; puis
   `offer_already_boosted`, `no_slot_available`, `seller_boost_limit_reached` (mêmes règles, mêmes codes, mêmes priorités que l'attribution) ;
   **puis (lot P3) la PORTÉE est REVÉRIFIÉE sous le verrou du périmètre** (`computeBoostReach`, mode « premier » : arrêt au PREMIER acheteur
   atteignable ; budget de 1,5 s, `statement_timeout` de 2 s) : le devis date de jusqu'à 15 minutes, les listes des acheteurs et les autres boosts ont pu
   changer, et un boost plus ancien a pu prendre la place. L'offre achetée est comptée comme le boost le plus RÉCENT (priorité d'ancienneté, `BOOST.md`) :
   elle n'évince jamais un boost existant. Aucun acheteur atteignable, DÉMONTRÉ (tous les besoins examinés dans les bornes) → **`no_visible_effect`** (409). **Lot P3-bis (N3) :
   budget (1,5 s) ou `statement_timeout` épuisé SANS acheteur trouvé** (verrou tenu sur les évaluations, base chargée) → **`reach_check_unavailable`** (**503**,
   `Retry-After: 2`, « Vérification impossible pour le moment, réessayez dans un instant. »), retriable avec la **MÊME clé d'idempotence** : une lenteur
   n'est plus un refus définitif (constaté avant le lot : verrou de 3 s → 409 « ne ferait plus monter votre annonce » en 2 s, le même devis accepté 78 ms
   après). Dans les deux cas RIEN n'est écrit (ni débit, ni boost, ni achat) et le devis reste utilisable ; jamais un achat sur un effet non démontré.
5. **Prix et durée** : EXACTEMENT le montant et la durée de la cotation (jamais recalculés : un changement de tarif ou de marché entre
   la cotation et l'achat ne change pas le débit). Le boost commence à `clock_timestamp()`.
6. **Débit** : transaction `boost_purchase` (vendeur −montant, `boost_revenue` +montant) par `postWalletTransaction`, **après** tous les
   contrôles (un refus de place ne débite donc jamais) ; solde insuffisant → `WalletError` `insufficient_balance`, rien d'écrit.
7. Boost (source `purchase`), puis ligne `boost_purchases`. Renvoie l'achat, le boost et le solde après l'opération.

**Priorité des refus** : validation, idempotence, cotation (introuvable, indisponible, échue, déjà achetée), offre (inexistante,
éligibilité, clé produit), cotation relue sous le verrou, offre déjà boostée, place, plafond vendeur, **portée (`no_visible_effect`, lot P3)**, solde.
Un REJEU d'une clé déjà utilisée renvoie l'achat existant avant tout autre contrôle (aucune revérification de portée, aucun débit).

### Ordre global des verrous (documenté dans `purchase.ts`)

Toute transaction du système prend ses verrous dans cet ordre, jamais à l'envers (pas d'interblocage ; testé par une charge mixte de 24
opérations simultanées) : 1. idempotence (vendeur, clé) — achat ; 2. cotation par offre — cotations ; 2b. vendeur (limite de débit des devis, lot P3) — cotations, juste après 2 ; 3. ligne de l'offre `FOR SHARE` ;
4. périmètre (clé produit) — attribution et achat ; 5. ligne de l'achat `FOR UPDATE` — remboursement ; 6. lignes de boost de l'offre ;
7. comptes du grand livre par identifiant croissant ; 8. ligne d'achat. Espaces consultatifs : 1_314_664_948 (périmètre), 949 (cotation),
950 (recharge), **951 (idempotence d'un achat)**, **952 (vendeur, limite de débit des devis, lot P3 : pris APRÈS le verrou de cotation de l'offre, tenu le temps du
comptage et de l'écriture)**, **953 (`dev:seed`, verrou de session, jamais pris par le serveur)**. La revérification de la portée de l'achat s'exécute SOUS
les verrous 1 et 4 (périmètre) et jamais sous le verrou de cotation (2) : le calcul d'un devis, lui, ne tient aucun verrou pendant la portée. `boost_revenue` est touché par chaque achat : point chaud, pris tard dans la transaction.

## Remboursement (administration seulement, aucune route HTTP)

`refundBoostPurchase({ pool, purchaseId, reasonCode })`, commande `npm run boost:refund-purchase -- --purchase <uuid> --reason <code>`
(`<code>` : minuscules et tirets bas, 1 à 40 caractères ; `DATABASE_URL` obligatoire ; code de sortie 0 remboursé, 1 refus ou erreur ;
refus `purchase_not_found`, `already_refunded`). Une transaction : verrou de l'achat, **annulation du boost s'il est encore actif**
(`cancelOfferBoostInTransaction`, la logique de `cancelOfferBoost` : un boost échu est marqué `expired`, un boost déjà annulé ou
expiré n'est pas touché mais **le crédit est tout de même rendu**), transaction `boost_refund` du **MONTANT INTÉGRAL**, achat marqué
remboursé. Deux remboursements simultanés : un seul passe, les autres reçoivent `already_refunded`. Un remboursement interrompu
annule aussi l'annulation du boost (tout ou rien). **Pas de prorata** : le montant ne dépend ni de l'usage ni du temps restant ; la
cotation reste consommée.

## HTTP (`contractVersion: "boost-purchase/v1"`)

| Méthode | Chemin | Contrôles, dans l'ordre | Réponse |
|---|---|---|---|
| `POST` | `/api/offers/{id}/boost-purchases` | **origine**, session, identifiant, corps (JSON **strict**, `application/json`, 2 Kio au plus : exactement `{ "quoteId": uuid, "idempotencyKey": uuid }`), achat | 201 `{ contractVersion, purchase: { id, quoteId, durationCode, amountXof, startsAt, endsAt, reused: false }, balanceXof }` ; 200 même achat `reused: true` |
| `GET` | `/api/offers/{id}/boost-purchases?limit=` | session, identifiant, paramètres (seul `limit`, 1 à 50, 20 par défaut), lecture | 200 `{ contractVersion, purchases: [{ id, quoteId, durationCode, amountXof, startsAt, endsAt, createdAt, refundedAt }] }`, plus récents d'abord |

Le prix ne vient JAMAIS du client (une clé `amountXof` dans le corps est un 400). Toutes les réponses : `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, JSON. DTO en liste blanche : jamais d'identifiant de boost, de transaction, de vendeur ni d'offre, de
clé d'idempotence, de métadonnée. Le GET ne contrôle pas l'origine (lecture seule). Origine contrôlée AVANT la session (aucune
résolution de session ni requête SQL pour une origine refusée).

| Statut | `code` | Cas |
|---|---|---|
| 400 | `invalid_request` | identifiant, corps (JSON piégé, clé en plus ou en moins, UUID invalide, autre `Content-Type`, trop gros) ou paramètres invalides |
| 401 | `authentication_required` | pas de session valide |
| 403 | `invalid_origin` | POST : `Origin` absent ou différent de `NOMA_AUTH_ORIGIN` |
| 404 | `resource_not_found` | offre inexistante ou d'autrui, cotation inexistante, d'une autre offre ou d'un autre vendeur : **réponses identiques octet pour octet** |
| 409 | `quote_expired` | cotation échue, ou périmètre de l'offre changé depuis la cotation |
| 409 | `quote_unavailable` / `quote_already_used` | cotation sans prix / déjà achetée (même remboursée) |
| 409 | `offer_not_eligible` | offre en pause, archivée, indisponible, propriétaire inactif, **ou clé produit effacée** (`offer_not_boostable` du domaine) |
| 409 | `offer_already_boosted` / `no_slot_available` / `seller_boost_limit_reached` | mêmes règles que l'attribution |
| 409 | `no_visible_effect` | (lot P3) la portée revérifiée sous le verrou du périmètre ne trouve plus aucun acheteur chez qui le boost ferait monter l'offre (DÉMONTRÉ, tous les besoins examinés dans les bornes) : rien n'a été acheté, ni débité |
| 409 | `insufficient_balance` | solde inférieur au prix |
| 409 | `idempotency_conflict` | même clé, autre cotation ou autre offre |
| 503 | `reach_check_unavailable` | (lot P3-bis) la revérification de la portée n'a pas pu se terminer dans son budget (1,5 s ; `statement_timeout`) sans acheteur trouvé : rien n'est écrit, `Retry-After: 2`, **réessayer avec la même clé d'idempotence** ; journal : `reach_check_unavailable` |
| 503 | `boost_purchase_unavailable` | `NOMA_AUTH_ORIGIN` non configurée, migration 0015 absente, verrou (`55P03`, après 5 s), base indisponible, session impossible à résoudre, toute autre erreur |

Journal serveur : **un seul code** par 503 (`[boost-purchase-http] <code>` : code du domaine, SQLSTATE ou `unexpected_error`), jamais de
message brut. Messages d'erreur fixes, sans identifiant ni montant.

## `wallet:check` étendu

Nouveaux écarts (exit 1) : `boost_purchase_transaction_orphan` (transaction d'achat sans exactement une ligne d'achat),
`boost_purchase_mismatch` (écritures ≠ deux écritures vendeur −montant / `boost_revenue` +montant, ou type/référence faux),
`boost_purchase_quote_mismatch` (cotation absente, indisponible, d'une autre offre/vendeur/durée ou d'un autre montant),
`boost_purchase_boost_mismatch` (boost absent, d'une autre source/offre/vendeur/durée), `boost_purchase_window_mismatch` (fenêtre ≠ durée
exacte du code, ou `starts_at` à plus de 60 s de l'instant de l'achat `boost_purchases.created_at` : tolérance documentée),
`purchase_boost_without_purchase` (boost
`purchase` sans exactement un achat), `boost_refund_transaction_orphan`, `boost_refund_mismatch` (remboursement ≠ montant intégral
`boost_revenue` −montant / vendeur +montant), `refunded_purchase_boost_active` (boost d'un achat remboursé resté actif),
**`boost_revenue_mismatch`** : solde de `boost_revenue` = Σ `amount_xof` des achats − Σ `amount_xof` des achats remboursés + Σ des
écritures de `boost_revenue` appartenant à des transactions `adjustment` (toute autre écriture sur ce compte rompt l'égalité).
Nouvel **avertissement** (hors code de sortie sauf `--strict`) `adjustment_credits_user_account` : nombre et exemples
(transaction, compte, montant, motif) des écritures d'ajustement qui **créditent** un compte utilisateur : de la valeur créée sans
recharge, à justifier. Le rapport ne contient aucune donnée personnelle.

## Exploitation

- **Migration 0015 obligatoire** avant d'utiliser le code du lot (achat, historique, `wallet:check` : tables et colonnes nouvelles ; sans
  elle, `wallet:check` échoue en `42P01` et la route répond 503). Sauvegarde `pg_dump` avant toute migration. `noma_dev` n'est PAS migré
  par ce lot.
- Rôle d'application : mêmes règles que `WALLET.md` ; `SELECT` et `INSERT` sur `boost_purchases`, `UPDATE` (le remboursement passe par
  le script d'administration), ni `DELETE` ni `TRUNCATE`.
- Après toute restauration (`pg_restore`), lancer `npm run wallet:check`.

## Limites

- **Remboursement intégral seulement** (pas de prorata, pas de remboursement HTTP, pas d'automatisme sur boost interrompu).
- **Une cotation achetée est consommée pour toujours** (même remboursée : `quote_already_used`) et `quoteOfferBoost` ne la renvoie
  **jamais** (elle est exclue de la réutilisation) : après un achat, la même durée donne une cotation neuve, indisponible
  `offer_already_boosted` pendant 60 s (comme toute cotation indisponible) tant que le boost est actif ; après remboursement ou
  annulation et dès que cette indisponibilité de 60 s a expiré, une cotation normale. Contrepartie : la **migration 0015** est requise
  aussi pour demander une cotation.
- **La portée est revérifiée à l'achat (lot P3)**, sous le verrou du périmètre : un devis `available` a été calculé sur une ESTIMATION datée (20 besoins
  comptés, 50 examinés, 3 s) ; à l'achat, l'achat ne passe que si au moins un acheteur verrait encore l'offre monter (budget de 1,5 s ; `no_visible_effect` si démontré inatteignable, `reach_check_unavailable` — 503 à réessayer — si la vérification n'a pas pu aboutir). La
  revérification examine au plus 50 besoins : un acheteur au-delà de ce nombre n'est pas vu (documenté : prudence, jamais l'inverse). Un achat tient le verrou du
  périmètre au plus ≈ 1,5 s de plus qu'avant le lot (mesuré : ≈ 0,1 à 0,8 s). La migration **0017** est requise pour demander un devis.
- **Limite de débit** : la demande de DEVIS est limitée (20 par vendeur et par minute, `BOOST-PRICING.md`) ; la route d'achat n'a pas de limite propre (chaque
  POST ouvre une transaction et prend des verrous ; une limite de débit en amont reste à prévoir avant toute exposition publique).
- Un corps JSON précédé d'un BOM UTF-8 est lu comme les autres routes de corps utilisateur (le décodeur partagé retire le BOM) ; seuls
  les corps du webhook fictif sont refusés dans ce cas.
- `boost_revenue` est un point chaud d'écriture (chaque achat et remboursement le touche, brièvement, en fin de transaction).
- Une offre dont la clé produit a changé depuis la cotation reçoit `quote_expired` (le prix ne vaut plus pour ce périmètre).
- Les valeurs tarifaires restent **provisoires** (`BOOST-PRICING.md`) ; le traitement juridique et comptable des crédits reste à valider
  avant tout paiement réel (`WALLET.md`).
