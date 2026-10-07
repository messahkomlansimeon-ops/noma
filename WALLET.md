# WALLET.md — Grand livre de crédits et recharge par prestataire fictif (lot P1a)

Le socle de l'argent de noma : un **grand livre en partie double, immuable**, et la **recharge** d'un compte de crédits par un
prestataire de paiement **fictif** (aucun réseau, aucun argent réel). Monnaie : francs CFA (XOF), **1 crédit = 1 XOF**, montants
**entiers** (`BIGINT` en base, `bigint` en JavaScript, entiers JSON dans les réponses) : aucun flottant n'entre jamais dans un montant.

**Ce lot n'a PAS** : d'achat de boost, de remboursement, d'écran (lot P2), de vrai prestataire (décision du propriétaire),
de branchement au worker. Voir « Ce qui n'existe pas encore ». **L'achat de boost avec ces crédits et son remboursement d'administration
existent depuis le lot P1b : `BOOST-PURCHASE.md`** (migration 0015, types de transaction `boost_purchase` et `boost_refund`, contrôles
supplémentaires de `wallet:check`) ; ce document décrit l'état du lot P1a et les ajouts de P1b sont signalés par « (P1b) ».

Code : `lib/server/wallet/` (`ledger.ts`, `topups.ts`, `fake-provider.ts`, `http.ts`, `check.ts`, `config.ts`, `errors.ts`,
`strict-json.ts`, `index.ts`), migration `database/migrations/0014_wallet_ledger.sql`, routes `app/api/wallet/**`,
`app/api/payments/fake/webhook`, `app/api/dev/fake-payments/**`, scripts `scripts/wallet-check.ts` et
`scripts/wallet-expire-intents.ts`. Tests (base `TEST_DATABASE_URL` dédiée) : `npm run test:wallet` (pur + base) et
`npm run test:wallet-http`.

## Modèle

| Table | Rôle |
|---|---|
| `wallet_accounts` | Un compte par utilisateur (créé à la première écriture) et un compte par type système : `provider_clearing` (ce que le prestataire nous doit : devient négatif à chaque recharge) et `boost_revenue` (**P1b** : crédité par chaque achat de boost, débité par chaque remboursement). `balance` en `BIGINT`, **toujours nul à la création**. |
| `wallet_transactions` | Une opération : `kind` (`topup`, `adjustment`, et depuis P1b `boost_purchase`, `boost_refund`), `reference` **unique** (`<type>:<identifiant>`, clé d'idempotence), `metadata` JSONB, `created_xid` (identifiant de la transaction SQL de premier niveau qui l'a créée). |
| `wallet_entries` | Les écritures d'une opération : `account_id`, `amount` (positif = crédit du compte, négatif = débit), jamais nul. |
| `payment_intents` | Une intention de recharge : propriétaire, montant, `status` (`pending`, `succeeded`, `failed`, `expired`), `idempotency_key` (unique par propriétaire), `provider_reference` (unique par prestataire), échéance 30 min. |
| `payment_events` | Journal de **tout** événement du prestataire dont la signature était valide et la forme correcte, avec son issue (`applied`, `duplicate`, `rejected_amount`, `rejected_state`, `rejected_unknown_intent`) et l'empreinte SHA-256 du corps. |

Exemple : une recharge de 2 500 XOF écrit **une** transaction `topup:<intention>` avec deux écritures, `provider_clearing −2500` et
`compte de l'utilisateur +2500`. Après quoi `provider_clearing` vaut −2 500 et la somme de tous les soldes reste 0.

## Invariants (et où ils sont garantis)

1. **Somme des écritures d'une transaction = 0, et au moins deux écritures** : contrainte `DEFERRABLE INITIALLY DEFERRED`
   (déclencheurs `trg_wallet_entries_balanced` et `trg_wallet_transactions_balanced`), vérifiée au COMMIT. Le code la contrôle aussi
   avant tout SQL.
2. **Le solde d'un compte est la somme de ses écritures**, tenu par le déclencheur `trg_wallet_entries_balance` dans la **même
   transaction SQL** que l'écriture. Le solde ne change que par ce chemin : `trg_wallet_accounts_guard` refuse un compte créé
   avec un solde non nul, toute mise à jour directe du solde, tout changement de type ou de propriétaire, toute suppression.
3. **Aucun solde utilisateur négatif** : `CHECK chk_wallet_accounts_user_balance_non_negative`. Une écriture qui y contreviendrait
   fait échouer **toute** la transaction (`insufficient_balance`). Les comptes système peuvent être négatifs.
4. **Immuabilité** : `UPDATE` et `DELETE` interdits (`restrict_violation`) sur `wallet_transactions`, `wallet_entries` et
   `payment_events`. Les comptes ne se suppriment pas, les intentions non plus. **Une transaction est complète à son COMMIT** :
   `trg_wallet_entries_same_transaction` refuse toute écriture rattachée à une transaction créée par une AUTRE transaction SQL
   (`created_xid` ≠ `pg_current_xact_id()`, qui est l'identifiant de premier niveau : les `SAVEPOINT` n'y changent rien). Des
   écritures, même équilibrées, ne peuvent donc pas être ajoutées plus tard à une recharge ou à un ajustement validés.
5. **Idempotence** : `reference` unique ; `(owner_id, idempotency_key)` unique ; `(provider, provider_event_id)` unique.
6. **Montants sûrs** : toute colonne de montant est bornée à ±(2^53 − 1) (`CHECK`) ; le code refuse un `number` à la place d'un
   `bigint`. Les bornes métier d'une recharge (500 à 500 000 XOF, multiple de 100) sont des constantes de `config.ts`, pas des `CHECK`.
7. **Intentions** : créées `pending` (déclencheur) ; transitions permises seulement `pending → succeeded | failed | expired` et
   `expired → succeeded` (paiement tardif) ; `succeeded` et `failed` sont terminaux ; `completed_at` est nul ssi l'intention est
   `pending` ; montant, propriétaire, référence, échéance ne changent jamais.
8. **Recharge ↔ intention** : une intention `succeeded` a **exactement une** transaction `topup` de même montant (deux écritures :
   compte du propriétaire, `provider_clearing`) et réciproquement ; vérifié par `wallet:check` (et la référence d'une recharge dérive
   du `paymentIntentId` de ses métadonnées : `CHECK chk_wallet_transactions_topup`).
9. **Métadonnées sans donnée personnelle** : clés `paymentIntentId`, `provider`, `reasonCode` (et, depuis P1b, `boostPurchaseId` et
   `quoteId`, UUID) seulement, valeurs textuelles de forme contrôlée (`CHECK chk_wallet_transactions_metadata`, doublé dans le code).
   (P1b) La forme des transactions `boost_purchase` (`boostPurchaseId` + `quoteId`, référence `boost_purchase:<achat>`) et
   `boost_refund` (`boostPurchaseId` + `reasonCode`, référence `boost_refund:<achat>`) est exacte (`CHECK chk_wallet_transactions_boost`).

Ordre des verrous : intention de paiement (`FOR UPDATE`), puis comptes par identifiant croissant (les écritures sont insérées dans cet
ordre : pas d'interblocage entre transactions croisées). (P1b) Un achat ou un remboursement de boost prend ses verrous métier AVANT
ceux des comptes (ordre global dans `BOOST-PURCHASE.md`) ; `boost_revenue`, touché par chacun, est pris tard dans leur transaction. Le compte `provider_clearing` est touché par **chaque** recharge : c'est un
point chaud, les recharges se sérialisent sur cette ligne le temps de leur transaction (acceptable à cette échelle).

## Cycle d'une recharge

1. `POST /api/wallet/topups { amountXof, idempotencyKey }` : verrou consultatif **par utilisateur**, puis relecture de la clé
   d'idempotence, décompte des intentions en attente non échues (5 au plus), insertion. Statut `pending`, échéance 30 minutes.
2. L'utilisateur « paie » chez le prestataire (en P2, la page `/paiement-simule/<id>` ; aujourd'hui, les routes de développement).
3. Le prestataire envoie un événement signé. Un **chemin unique** (`processFakePaymentEvent`) vérifie la signature, lit le corps
   strictement, puis `applyProviderEvent` applique en **une transaction** : verrou de l'intention, décision, journal de l'événement
   (`ON CONFLICT DO NOTHING`), puis effets (intention + écriture du grand livre). Tout ou rien.
4. `expirePaymentIntents` marque `expired` les intentions `pending` échues (`FOR UPDATE SKIP LOCKED`). Un paiement qui arrive
   **après** l'expiration est quand même appliqué.

Décision d'un événement (ordre : intention inconnue, montant, état) :

| Intention | `payment.succeeded` | `payment.failed` |
|---|---|---|
| inconnue | `rejected_unknown_intent` | `rejected_unknown_intent` |
| montant différent | `rejected_amount` (aucun crédit) | `rejected_amount` |
| `pending` | `applied` (→ `succeeded` + crédit) | `applied` (→ `failed`) |
| `expired` | `applied` (paiement tardif : crédit) | `rejected_state` |
| `failed` | `rejected_state` | `duplicate` |
| `succeeded` | `duplicate` (aucun second crédit) | `rejected_state` |

Un événement dont l'identifiant a déjà été reçu est une **relecture** : rien n'est refait ni réécrit (le journal ne contient qu'une
ligne par événement) ; si son corps diffère du premier, un code `webhook_event_id_reused` est journalisé. `duplicate` désigne un
événement **distinct** pour une intention déjà traitée. Le statut présenté à l'utilisateur est **effectif** : une intention `pending`
dont l'échéance est passée s'affiche `expired` même si le balayage ne l'a pas encore enregistré.

## Prestataire fictif et garde-fous

**Activation** : `NODE_ENV` vaut **exactement** `development` ou `test` (liste d'**autorisation** : ni espace, ni changement de casse ;
`production`, ` production`, `Production`, `PRODUCTION`, `prod`, `staging`, vide ou absent désactivent le fictif) **et**
`NOMA_FAKE_PAYMENTS=1` (valeur exacte) **et** `NOMA_FAKE_PAYMENT_SECRET` d'au moins 32 octets. L'environnement est relu à chaque
requête. Sinon :

- `POST /api/wallet/topups` et `GET /api/wallet/topups/{id}` répondent **503 `payment_unavailable`** (message fixe) ;
- le webhook et les routes de développement répondent **404** (même corps que toute ressource inconnue), **avant** l'origine, la
  session et la lecture du corps (le flux de la requête n'est pas tiré : un test le vérifie), sans requête SQL ;
- `GET /api/wallet` (solde, historique) reste disponible : il ne dépend pas du prestataire.

**Signature** : en-tête `x-noma-fake-signature` = HMAC-SHA256 du **corps brut** (octets exacts) avec le secret (espaces de début et de fin supprimés, comme pour les autres secrets), en hexadécimal
minuscule (64 caractères), comparé à temps constant (`timingSafeEqual`). L'événement est vérifié **avant** toute lecture du corps.
Corps JSON de forme exacte, sans clé en plus ni en moins :

```json
{ "id": "evt_…", "type": "payment.succeeded", "timestamp": 1790000000, "providerReference": "fakepay_…", "amountXof": 5000 }
```

`id` et `providerReference` : 8 à 64 caractères `[A-Za-z0-9_-]` ; `type` : `payment.succeeded` ou `payment.failed` ;
`timestamp` : secondes Unix, refusé à plus de **5 minutes** de l'heure du serveur ; `amountXof` : entier de 1 à 2^53 − 1. Le lecteur
JSON est **strict** (`strict-json.ts`) : clé en double, `__proto__`, nombre non entier ou au-delà de 2^53 − 1, `-0`, contenu après
l'objet, profondeur excessive, UTF-8 invalide ou BOM → refus. Corps limité à **8 Kio** (8 192 octets acceptés).

**Journalisation** : un événement à signature **invalide** n'est jamais stocké ; il est seulement compté par un code de journal
(`webhook_invalid_signature`), sans contenu. Un événement signé mais de forme invalide (`webhook_invalid_event`) n'est pas stocké non
plus. Tout événement signé et bien formé est enregistré dans `payment_events`, y compris ceux qui n'ont aucun effet.

**Routes de développement** `POST /api/dev/fake-payments/{id}/confirm` et `/fail` : origine, session, **propriétaire seulement**.
Elles fabriquent un événement (identifiant aléatoire), le **signent** avec le même secret et le font passer par
`processFakePaymentEvent`, la fonction du webhook : aucun raccourci qui saute la vérification (`http.ts` n'importe pas
`applyProviderEvent`, vérifié par un test). Elles répondent le nouvel état et l'issue (`outcome`).

## Routes HTTP

Contrat `contractVersion: "wallet/v1"`. Toutes les réponses : `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, JSON.
DTO construits champ par champ (liste blanche) : jamais d'identifiant d'utilisateur, de compte, de référence du prestataire, de clé
d'idempotence ni de métadonnée.

| Méthode | Chemin | Contrôles, dans l'ordre | Réponse |
|---|---|---|---|
| `GET` | `/api/wallet?limit=&cursor=` | session | `{ contractVersion, balanceXof, transactions: [{ id, kind, amountXof (signé, côté utilisateur), createdAt }], nextCursor }` : 20 par défaut (1 à 50), du plus récent au plus ancien, curseur opaque |
| `POST` | `/api/wallet/topups` | **origine**, session, prestataire actif, corps | 201 `{ contractVersion, topup: { id, amountXof, status, expiresAt, checkoutPath } }` ; 200 même intention (même clé, même montant) |
| `GET` | `/api/wallet/topups/{id}` | session, prestataire actif, identifiant | 200 même DTO ; 404 si inexistante **ou d'autrui** (réponses identiques) |
| `POST` | `/api/payments/fake/webhook` | prestataire actif (404), signature, forme | 200 `{ "received": true }` pour tout événement signé et bien formé (appliqué, doublon ou refusé : l'issue n'est jamais révélée) |
| `POST` | `/api/dev/fake-payments/{id}/confirm` et `/fail` | prestataire actif (404), **origine**, session, identifiant, corps vide, propriétaire | 200 `{ contractVersion, outcome, topup }` |

`checkoutPath` vaut `/paiement-simule/<id>` : la page existe depuis le lot P2 (`ECRANS-P2.md`). Corps de `POST /topups` : exactement
`{ "amountXof": entier, "idempotencyKey": uuid }`, `Content-Type: application/json`, 2 Kio au plus, JSON strict (un montant flottant,
`1e3`, ou au-delà de 2^53 − 1 est un 400).

| Statut | `code` | Cas |
|---|---|---|
| 400 | `invalid_request` | identifiant ou corps ou paramètres invalides, montant hors bornes |
| 400 | `invalid_signature` | webhook : signature absente, mal formée ou fausse |
| 400 | `invalid_event` | webhook : corps trop gros, JSON invalide ou piégé, forme fausse, horodatage hors fenêtre |
| 401 | `authentication_required` | pas de session valide |
| 403 | `invalid_origin` | POST : `Origin` absent ou différent de `NOMA_AUTH_ORIGIN` |
| 404 | `resource_not_found` | intention inconnue ou d'autrui ; routes fictives quand le prestataire est inactif |
| 409 | `idempotency_conflict` | même clé d'idempotence, autre montant |
| 409 | `too_many_pending_topups` | 5 intentions en attente non échues |
| 503 | `payment_unavailable` | prestataire inactif ; `NOMA_AUTH_ORIGIN` absente ; base indisponible ; toute erreur inattendue (le webhook répond aussi 503 : le prestataire pourra rejouer, c'est idempotent) |
| 503 | `wallet_unavailable` | `GET /api/wallet` : base indisponible, session impossible à résoudre |

Journal serveur : **un seul code** par erreur 503 ou refus (`console.error("[wallet-http] <code>")` par défaut) : jamais de message
brut, de requête, de montant ni d'identifiant.

## Scripts

- `npm run wallet:check [-- --strict]` — **lecture seule** (instantané `REPEATABLE READ READ ONLY`). Écarts vérifiés :
  - somme de chaque transaction = 0 et au moins deux écritures (`transaction_unbalanced`) ;
  - solde de chaque compte = somme de ses écritures (`balance_mismatch`), aucun solde utilisateur négatif
    (`negative_user_balance`), somme de tous les soldes = 0 (`ledger_total_nonzero`) ;
  - exactement un compte de chaque type système, ni manquant ni en double (`system_account_invalid`) ;
  - **solde de `provider_clearing`** (`provider_clearing_mismatch`), formule exacte :
    `balance(provider_clearing) = − somme(amount_xof des intentions succeeded) + somme(amount des écritures de provider_clearing
    appartenant à des transactions de type ≠ topup)` ;
  - chaque intention `succeeded` ↔ exactement une recharge de même montant sur le bon compte, deux écritures
    (`succeeded_intent_without_topup`, `topup_without_succeeded_intent`, `topup_mismatch`) ;
  - **(P1b) achats de boost** : `boost_purchase_transaction_orphan`, `boost_purchase_mismatch`, `boost_purchase_quote_mismatch`,
    `boost_purchase_boost_mismatch`, `boost_purchase_window_mismatch`, `purchase_boost_without_purchase`, `boost_refund_transaction_orphan`, `boost_refund_mismatch`,
    `refunded_purchase_boost_active` et **`boost_revenue_mismatch`** (formule exacte : `balance(boost_revenue) = somme(amount_xof des
    achats) − somme(amount_xof des achats remboursés) + somme(amount des écritures de boost_revenue appartenant à des transactions de
    type 'adjustment')`) : détail dans `BOOST-PURCHASE.md` ;
  - **intentions ↔ événements** : toute intention `succeeded` a un `payment.succeeded` « applied » de même montant
    (`succeeded_intent_without_applied_event`), toute intention `failed` un `payment.failed` « applied » de même montant
    (`failed_intent_without_applied_event`), tout événement « applied » pointe une intention dans l'état qu'il produit et du même
    montant (`applied_event_state_mismatch`), et un seul événement « applied » de chaque type par intention
    (`duplicate_applied_event`).
  Code de sortie : **0** aucun écart, **1** au moins un écart (ou, avec `--strict`, au moins un avertissement), **2** erreur d'usage
  ou technique. Le rapport ne contient que des comptages, des identifiants techniques (transaction, compte, intention, événement) et
  des montants : aucune donnée personnelle.
  **Avertissements** (section distincte, `AVERTISSEMENT <code>`) : nombre de `payment.succeeded` **refusés** par le système
  (`succeeded_event_rejected_amount`, `succeeded_event_rejected_state`, `succeeded_event_rejected_unknown_intent`). De l'argent a
  peut-être été encaissé chez le prestataire **sans crédit** : à traiter à la main (rapprochement avec le prestataire, crédit par un
  ajustement). Ils ne changent pas le code de sortie sans `--strict`. Le journal étant immuable, ils restent comptés une fois
  traités : il n'existe pas encore de marque « traité ».
  **(P1b) Avertissement `adjustment_credits_user_account`** : nombre et exemples (transaction, compte, montant, motif) des écritures
  d'**ajustement** qui **créditent** un compte utilisateur (un crédit sans recharge ni remboursement d'achat : de la valeur créée par
  l'administration, à justifier). Il vient après les avertissements d'événements refusés, ne change pas le code de sortie sans
  `--strict`, et n'expose que des identifiants techniques.
- `npm run wallet:expire-intents [-- --limit N]` — appelle `expirePaymentIntents` (1 à 1000, 200 par défaut). Sûr en parallèle.
  Le worker pourra l'appeler plus tard : il n'est **pas** branché au runner dans ce lot.

## Exploitation

- `NOMA_AUTH_ORIGIN` est obligatoire pour les POST (comme les autres routes). La migration 0014 doit être appliquée.
- **Rôle PostgreSQL de l'application** : il doit être NON superutilisateur et NON propriétaire des tables du portefeuille. Un
  superutilisateur ou le propriétaire peut `ALTER TABLE … DISABLE TRIGGER`, `SET session_replication_role = replica`, `TRUNCATE` ou
  supprimer une contrainte, et contourne alors toutes les garanties de la base (les tests de réconciliation le font volontairement
  pour injecter des corruptions). Droits suffisants pour le rôle d'application : `SELECT` et `INSERT` sur les cinq tables du
  portefeuille (et sur `users`), `UPDATE` sur `wallet_accounts` (le déclencheur de solde s'exécute avec les droits de l'appelant)
  et sur `payment_intents` ; ni `DELETE` ni `TRUNCATE`. Les migrations s'exécutent avec un autre rôle. Vérifié sur la base de test
  avec un rôle sans droits particuliers : recharge complète acceptée ; `UPDATE` direct du solde refusé par le garde ; `DELETE`,
  `TRUNCATE`, `ALTER TABLE … DISABLE TRIGGER` et `SET session_replication_role` refusés par les privilèges.
- **`TRUNCATE` n'est pas bloqué** par la base (les suites de test existantes vident `users` en cascade), et **`TRUNCATE users
  CASCADE` vide aussi les comptes système**, les écritures, les transactions et les intentions. Le compte système manquant est
  recréé à la demande, mais l'historique est perdu (`wallet:check` le signale). Ne jamais donner ce droit au rôle d'application ;
  la sauvegarde (`pg_dump`) doit précéder toute migration.
- **Restauration** : `pg_dump`/`pg_restore` rechargent les données avant de créer les déclencheurs, donc `created_xid` est restauré
  tel quel ; après toute restauration, lancer `npm run wallet:check`.
- Activer le fictif en développement : `NODE_ENV=development` (ou `test`), `NOMA_FAKE_PAYMENTS=1` et
  `NOMA_FAKE_PAYMENT_SECRET=<32 octets au moins>`. Ne **jamais** les définir en production.
- **Défense de déploiement** : `NOMA_FAKE_PAYMENTS`, `NOMA_FAKE_PAYMENT_SECRET`, `NOMA_DEV_OTP_CONSOLE`, `NOMA_DEV_NOTIFY_CONSOLE` (lot N1, `NOTIFICATIONS.md`), `NOMA_DEV_PROXY`,
  `NOMA_FAKE_SOURCES` et `NOMA_TURNSTILE_DISABLED` sont listées « INTERDIT en production » dans `deploy/env.production.example`
  (un test vérifie que la liste est complète). `assertProductionConfig` (`lib/server/config.ts`) refuse, quand `NODE_ENV` vaut
  exactement `production`, de créer le singleton de protection si l'une d'elles est définie et non vide (message fixe
  `<NOM> interdit en production`, jamais la valeur). **Portée** : cette validation s'exécute au premier appel de `/api/search` du
  processus (`guard()`), pas au démarrage ni dans les routes du portefeuille ; elle protège donc surtout l'exploitation (un
  déploiement mal configuré échoue visiblement). La protection effective du fictif est la liste d'autorisation de
  `resolveFakePaymentConfig`.
- Pour ajouter un type de transaction : remplacer `chk_wallet_transactions_kind` (et, si de nouvelles clés de métadonnée sont utiles,
  `chk_wallet_transactions_metadata`) dans une nouvelle migration. La migration 0015 (P1b) l'a fait pour `boost_purchase` et
  `boost_refund` ; la **migration 0015 est requise** pour que `wallet:check` fonctionne (tables et colonnes de P1b).

## Ce qui n'existe pas encore

- ~~Achat de boost~~ : **fait au lot P1b** (`BOOST-PURCHASE.md`), ainsi que le remboursement **intégral** d'administration d'un achat.
- **Remboursement au prorata**, remboursement par une route HTTP, compensation automatique d'un boost interrompu : plus tard.
- ~~**Écrans** (recharge, page de paiement simulé, solde)~~ : **faits au lot P2** (`ECRANS-P2.md` : `/compte/porte-monnaie`, `/paiement-simule/<id>`,
  achat dans « Booster cette annonce » ; `dev:try` active le prestataire fictif).
- **Vrai prestataire** (Mobile Money) : décision du propriétaire. Il faudra un adaptateur (signature réelle, identifiants réels,
  rapprochement quotidien avec le relevé du prestataire) qui réutilise `applyProviderEvent`.
- **Traitement juridique et comptable des crédits** (nature des crédits, TVA, durée de validité, remboursabilité, crédits
  promotionnels séparés, obligations de conservation) : **à valider** avant tout paiement réel.
- **Branchement de `expirePaymentIntents` au worker**, limites de débit propres aux routes, alerte sur `wallet:check` rouge.

## Limites

- Aucune limite de débit propre aux routes : un utilisateur est borné par ses 5 intentions en attente, mais le webhook est
  publiquement joignable (seulement quand le prestataire fictif est actif, c'est-à-dire hors production) et chaque signature invalide
  coûte un calcul HMAC ; une limite de débit en amont reste à prévoir avant toute exposition publique.
- `provider_clearing` est un point chaud d'écriture (voir plus haut).
- Les montants de test, de bornes et d'expiration sont des **valeurs provisoires** à confirmer avec le prestataire réel.
- **Fenêtre de ±5 minutes** : adaptée au prestataire fictif, elle refuserait la **relivraison tardive légitime** d'un vrai
  prestataire (un webhook rejoué des heures plus tard serait refusé en `invalid_event`). À revoir avec le vrai prestataire (fenêtre
  plus large, ou horodatage non signé remplacé par la seule idempotence de l'identifiant d'événement).
- **Les avertissements de `wallet:check` sont à traiter** (voir « Scripts ») : un `payment.succeeded` refusé est de l'argent
  possiblement encaissé sans crédit ; rien ne le rattrape automatiquement.
- **Routes fictives repérables** : en production, `POST /api/payments/fake/webhook` et `/api/dev/fake-payments/*` répondent 404 JSON
  (`resource_not_found`), alors qu'une route inexistante reçoit la page 404 de Next : un visiteur peut déduire que ces chemins
  existent dans le code. Sans effet : elles ne font rien. Non changé.
- **BOM** : un corps de webhook commençant par un BOM UTF-8 est refusé (`invalid_event`) même signé. Non changé (aucun prestataire
  n'en émet).
- L'historique d'un utilisateur se lit par jointure `wallet_entries` ↔ `wallet_transactions` sur son compte : sans index sur
  `wallet_transactions.created_at`, il se dégradera pour un compte très actif (à mesurer).
