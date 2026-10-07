# Commandes : ventes déclarées (lot D2)

Table `orders` (migration `0020`), routes dans `lib/server/social/http.ts`, écrans `app/(buyer)/commandes`, `app/(vendor)/vendeur/commandes`, `components/orders/*`.

## Principe

L'acheteur déclare « **Je l'ai acheté** » avec un **prix convenu** (XOF, entier de 1 à 100 000 000), depuis la fiche de l'annonce ou depuis la conversation. **Aucun paiement de l'objet ne passe par noma** : c'est écrit à l'écran, avant le bouton et sur la commande. La commande sert à garder une trace et à alimenter les statistiques du vendeur.

## États et transitions

`proposed` (proposée) → `confirmed` (le vendeur confirme), `declined` (le vendeur refuse) ou `cancelled` (l'acheteur annule tant que ce n'est pas confirmé). Les trois derniers états sont définitifs.

- Contrôlées **en base** : CHECK sur le statut et sur la date de décision, déclencheur qui n'admet que `proposed` → un état décidé et ne laisse rien changer d'autre (prix, parties, besoin, annonce, attribution) ; l'application lit la ligne sous **verrou** (`FOR UPDATE`) avant d'écrire.
- Un rôle qui n'a pas le droit de l'action reçoit `403 action_not_allowed` (l'acheteur ne confirme pas, le vendeur n'annule pas) ; une commande déjà décidée `409 order_state_conflict`.
- **Une seule commande active** (proposée ou confirmée) par (besoin, annonce) : index unique **partiel** + verrou par couple. Refusée ou annulée, une nouvelle déclaration est permise.

## Accès

Les deux parties seulement ; tout autre reçoit `404` indiscernable. La déclaration a les **mêmes conditions que le contact** (correspondance confirmée, annonce en ligne : `409 offer_not_available` si l'annonce est retirée). Origine vérifiée sur les `POST`. L'autre partie n'a jamais de nom ni de numéro (« Acheteur intéressé », « Vendeur de l'annonce »).

## Effets d'une confirmation

- Le **besoin** peut être marqué satisfait : la commande confirmée porte `canMarkDemandSatisfied` (acheteur, besoin encore actif) et l'écran **propose** le bouton ; rien n'est automatique (il appelle la route existante `POST /api/demands/{id}/satisfy`).
- La vente compte dans les **statistiques du vendeur** : « Ventes déclarées et confirmées » sur la page de l'annonce (`GET /api/offers/{id}/sales`), **arrondies comme MESURES.md** (« moins de 5 », « environ N », jamais un compte exact). Seules les ventes **confirmées** comptent. La répartition boost / organique n'est publiée que si l'annonce a eu un boost.
- **Attribution au boost** : même règle que les contacts (`readAttributedBoostId` : l'annonce a été servie sponsorisée à CE besoin dans les 7 jours précédents), figée **à la déclaration** (l'acheteur a agi à ce moment ; la confirmation du vendeur peut venir plus tard).

## Routes

`POST /api/demands/{id}/offers/{offerId}/orders {priceXof}` · `GET /api/orders?as=buyer|seller` · `GET /api/orders/{id}` · `POST /api/orders/{id}/{confirm|decline|cancel}` · `GET /api/offers/{id}/sales`.

## Limites assumées

Pas de notification au vendeur à la déclaration (il voit la commande dans « Commandes », avec « À confirmer ») ; pas de modification du prix après déclaration (annuler et redéclarer) ; l'attribution au boost de la vente suit la déclaration, pas la confirmation.
