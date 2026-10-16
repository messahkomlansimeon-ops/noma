# Propositions de vendeur et devis (lot FIN3-C3)

Un vendeur répond à un besoin d'acheteur qui correspond à l'une de ses annonces en ligne, par une **proposition** (un prix) ou un **devis** (des lignes : le prix est leur somme). L'acheteur l'accepte, ce qui **crée une commande**, ou la refuse. Migration **0031** (`seller_proposals`, `seller_proposal_lines`). Contrat `proposals/v1`. Un seul modèle : le devis est une proposition avec des lignes.

## Ce que voit chaque côté

- **Le vendeur** : `/vendeur/demandes` regroupe, par besoin, les demandes qui correspondent à ses 20 annonces en ligne les plus récentes (l'écran le dit quand il en a davantage). Chaque besoin est le **DTO exact** de « Acheteurs intéressés » de chaque annonce (`/api/offers/[id]/stored-matches`, même fonction `mapStoredMatchesPageToDto`) : rien de plus que ce qu'il voit déjà, **sans identité** ; c'est la même information, regroupée. Le besoin porteur d'une mission d'achat en volume n'apparaît jamais.
- **L'acheteur** : `/propositions` (menu du compte) liste les propositions reçues, avec le prix, les lignes d'un devis, le créneau, la garantie, un message et la validité. Il ne voit **ni nom ni numéro** du vendeur ; le vendeur ne voit ni identité ni numéro de l'acheteur. Les échanges passent ensuite par la messagerie de noma, une fois la commande créée.
- **Pas de notification** (ajouter un genre toucherait la contrainte fusionnée des notifications) : l'acheteur est prévenu par une bannière « n propositions en attente » sur la page de son besoin et le menu « Propositions reçues » du compte.

## Envoyer

`POST /api/requests/{demandId}/proposals` : `{ offerId, priceXof | lines, slot?, warranty?, note?, validDays? }`.

- **Accès du vendeur** (`readSellerDemandAccess`, sinon **404 indiscernable**) : l'annonce est à lui, **en ligne** et pas indisponible ; le besoin est **actif**, d'un autre compte, et n'est pas le besoin porteur d'une mission ; la correspondance est **confirmée et fraîche** (même prédicat que la fiche et le contact, qui exige aussi des comptes actifs).
- **Prix** : celui d'**une unité** (la commande est de quantité 1), de 1 à 100 000 000 FCFA : mêmes bornes que les commandes (un test vérifie l'égalité), donc l'acceptation ne peut jamais échouer sur le prix. **Devis** : de 1 à 20 lignes (libellé de 1 à 80 caractères, montant ≥ 0), prix = somme ; un `priceXof` fourni doit l'égaler.
- **Textes** : créneau et garantie (120), message (300), libellés. **Aucun numéro de téléphone**, même coupé entre deux champs (`looksLikePhoneNumberAcross`) : 400 `phone_number_in_proposal`. Même règle côté écran et serveur (`lib/proposals-rules.ts`).
- **Validité** : 1 à 14 jours (7 par défaut). L'expiration **n'est pas balayée** : une proposition envoyée dont la validité est échue se **lit** « expirée » ; elle est écrite « expirée » quand le vendeur en envoie une nouvelle pour le même couple (sous verrou), ce qui libère l'index unique.
- **Limites** (exactes sous concurrence, verrous consultatifs pris dans l'ordre vendeur, besoin, couple) : **une proposition envoyée par couple (annonce, besoin)** (409 `proposal_active_exists`) ; **20 en attente par besoin** (409 `proposals_need_limit`) ; **30 par vendeur et par jour UTC** (429 `proposals_daily_limit`).
- **Anti-harcèlement** : après un **refus** de l'acheteur, la même annonce ne propose plus à ce besoin (409 `proposal_declined`) ; une **autre** annonce du vendeur peut encore proposer. Un retrait ou une expiration libère le couple.

## Répondre

`POST /api/proposals/{id}/accept|decline|withdraw`.

- **Accepter** (acheteur) : une transaction qui **verrouille la proposition**, refuse une proposition échue (409 `proposal_expired`) ou décidée (409 `proposal_not_open`), puis **crée la commande par le circuit existant** (`declareOrderInTransaction`, extrait de `declareOrder` : verrou du couple, accès à l'annonce, attribution au boost, rattachement éventuel à une mission, insertion) et passe la proposition à « acceptée » avec `order_id`. La commande naît **« proposée »** : le vendeur la confirme par le circuit habituel (PROPOSITIONS ne contourne pas la confirmation).
  - **Double clic / rejeu** : l'acceptation d'une proposition déjà acceptée rend **200 avec la même commande** (`replayed: true`) ; six acceptations simultanées créent **une seule** commande.
  - **Commande déjà active pour le couple** (FIN1) : le code de la commande passe tel quel (409 `order_active_exists` ou `order_already_confirmed`), la proposition **reste « envoyée »** et rien n'est écrit.
  - **Retrait contre acceptation** : les deux prennent la ligne en `FOR UPDATE` ; un seul gagne, jamais de commande pour une proposition retirée.
- **Refuser** (acheteur) : définitif pour cette annonce et ce besoin. Rejoué : sans effet.
- **Retirer** (vendeur) : tant qu'elle est en attente. Rejoué : sans effet. L'autre partie reçoit un 404 indiscernable.

## Garanties en base

Déclencheur `seller_proposals_guard` : les éléments d'une proposition (prix, textes, validité, parties, dates) ne changent jamais ; seul l'état change, **une fois**, depuis « envoyée » ; une proposition décidée ne bouge plus ; aucune suppression ; **« acceptée » exige une proposition non échue** et **« expirée » une proposition échue**. Les lignes d'un devis ne changent plus. Les deux parties sont le propriétaire du besoin et celui de l'annonce (`social_check_parties`, comme les conversations et les commandes).

## Ce qui n'existe pas (volontairement)

Pas de notification ; pas de contre-proposition (le vendeur retire puis renvoie, tant que l'acheteur n'a pas refusé) ; pas de quantité (une unité) ; pas de paiement (comme les commandes, aucun argent d'achat ne passe par noma) ; pas de proposition à un besoin porteur de mission.

## Code

`database/migrations/0031_seller_proposals.sql` · `lib/proposals-rules.ts` (règles partagées) · `lib/server/proposals/{proposals,http}.ts` · `lib/server/social/orders.ts` (`declareOrderInTransaction`) · `lib/client/proposals-{api,view}.ts` · `components/proposals/` · pages `app/(vendor)/vendeur/{demandes,devis/nouveau}`, `app/(buyer)/propositions` · tests `tests/postgres/proposals.integration.test.ts` (`npm run test:proposals`) et `tests/client/proposals.test.ts`.
