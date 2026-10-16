# Partager un besoin et inviter un vendeur (lot FIN3-C4)

« Partager mon besoin » et « Inviter un vendeur » sont **un seul mécanisme** : un **lien public** vers un résumé du besoin, **sans identité**. Migration **0032** (`demand_share_links`). Contrat `shares/v1`. Voir aussi PROPOSITIONS.md (les vendeurs peuvent ensuite répondre) et MESURES.md (la fiche d'une annonce reste réservée aux correspondances).

## Pour l'acheteur

- Sur la page d'un besoin actif : « Partager ce besoin » ouvre `/besoins/[id]/partager`. Un bouton crée un lien à copier et l'envoyer (message, réseaux sociaux).
- **Un seul lien actif par besoin** : en créer un nouveau **désactive l'ancien** (même transaction). « Désactiver le lien » le révoque, rejoué sans effet. **10 créations par jour UTC** au plus (429 `share_daily_limit`), exactes sous concurrence.
- **Le jeton n'est montré qu'à la création** : 128 bits aléatoires (22 caractères base64url), **jamais stockés** ; seule l'empreinte SHA-256 est en base. Un jeton à 128 bits n'a pas besoin d'un secret serveur. L'écran dit « Un lien est actif depuis… » mais ne peut pas le redonner : il faut en créer un nouveau.
- Réservé au **propriétaire d'un besoin ACTIF** qui n'est pas le besoin porteur d'une mission d'achat en volume ; tout autre cas : **404 indiscernable**.
- Le lien **meurt tout seul** quand le besoin n'est plus actif (satisfait, archivé) ou que le compte n'est plus actif (suspendu) ; si le besoin redevient actif, le même lien revit (il n'a pas été révoqué).

## Pour quiconque ouvre le lien

`/besoin/[token]` : page **publique** (aucune session, aucune barre d'onglets, hors des espaces acheteur, vendeur et administration), **jamais indexée** (`robots: noindex, nofollow`) et **sans en-tête Referer** (`referrer: no-referrer` ; l'API répond aussi `X-Robots-Tag: noindex, nofollow` et `Referrer-Policy: no-referrer`) : le jeton est dans l'adresse, il ne doit fuir vers aucun site tiers.

- **Ce qui est montré** : le produit (marque, modèle, variante, sinon la catégorie), l'état souhaité, la zone, la quantité, le budget. **Jamais** le nom, le numéro, le texte brut du besoin, l'identifiant, ni une date. La page dit « Ce résumé ne contient ni nom ni numéro ».
- **Les numéros** : la règle « aucun numéro » ne s'applique pas au texte d'un besoin ; la vue publique la rejoue donc à l'affichage (`publicNeedView`, `lib/shares-rules.ts`) : un champ qui est à lui seul un numéro est **omis** ; si ce qui reste, mis bout à bout, forme encore un numéro, **tous** les textes libres sont omis (titre neutre « Un produit »). Prudent par construction : on ne cherche pas quels champs forment le numéro.
- **Pas d'oracle** : un jeton mal formé, inconnu, révoqué, d'un besoin plus actif, d'un compte suspendu ou d'un besoin de mission donne le **même 404** « Ce lien n'est plus valable ».
- **Le seul appel à l'action** : « Publier une annonce » (`/vendeur/annonces/nouvelle`, connexion exigée comme pour toute annonce). Le vendeur **ne peut pas écrire à l'acheteur** depuis le lien : il publie une annonce, et noma la met en correspondance avec le besoin (le circuit habituel : correspondances, puis demandes et propositions).

## Garanties en base

Un lien appartient au propriétaire du besoin (déclencheur) ; seule la **révocation d'un lien actif** change une ligne (une fois) ; aucune suppression ; l'empreinte a la bonne forme ; un seul lien actif par besoin (index unique partiel).

## Ce qui n'existe pas (volontairement)

Pas de compteur de vues (rien à pister) ; pas de limitation de débit par adresse sur la page publique (un jeton à 128 bits ne s'énumère pas) ; pas de lien pour un besoin de mission ; pas de réponse du vendeur depuis la page publique.

## Code

`database/migrations/0032_demand_share_links.sql` · `lib/shares-rules.ts` (jeton et vue publique, partagés) · `lib/server/shares/{shares,http}.ts` · `lib/client/shares-{api,view}.ts` · pages `app/(buyer)/besoins/[id]/partager`, `app/(public)/besoin/[token]` · tests `tests/postgres/shares.integration.test.ts` (`npm run test:shares`) et `tests/client/shares.test.ts`.
