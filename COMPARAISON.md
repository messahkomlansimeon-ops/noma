# Comparer deux offres d'un besoin (lot FIN3-C1)

Sur les résultats d'un besoin (`/besoins/[id]`), chaque offre a une case **Comparer**. Deux offres cochées ouvrent `/besoins/[id]/comparer?offres=<id>,<id>` : un tableau côte à côte.

## Règles

- **Dans le contexte d'un besoin seulement.** La page relit les correspondances du besoin (`GET /api/demands/{id}/stored-matches`, réservées à son propriétaire, 404 indiscernable sinon) et y retrouve les deux offres. Une offre n'est jamais lue par son seul identifiant : cela contournerait la règle « fiche réservée aux correspondances » (lot M1). L'ancienne page `offre/[id]` et l'ancienne page `/comparer` (maquettes) ont été supprimées pour cette raison.
- **La sélection est dans l'adresse**, pas dans le navigateur : un rechargement garde la sélection. L'ancien état `compare` du store a disparu. Une troisième case est refusée (« Comparez jusqu'à 2 offres »).
- **Ce qui est comparé** : prix, état et lieu, compatibilité avec le besoin, prix par rapport au marché, disponibilité, confiance, badge « Vendeur Pro ». Le prix le plus bas et la meilleure compatibilité sont signalés « Le plus avantageux ». Un champ absent s'écrit « Non renseigné ».
- **Ce qui n'est pas comparé** : livraison, garantie et total ne sont pas des champs d'une annonce ; ils ne sont pas inventés.
- **Jamais d'identité, de nom ni de numéro** (comme les résultats). La note rappelle que l'état et la disponibilité ne sont pas garantis.
- Si une des deux offres n'apparaît plus dans les résultats (annonce retirée, besoin actualisé), la page le dit sans rien deviner.

## Code

Vue pure : `lib/client/compare-view.ts` (testée dans `tests/client/compare-view.test.ts`). Page : `app/(buyer)/besoins/[id]/comparer/page.tsx`. Case : `components/matches/match-parts.tsx` (`CompareControl`). Aucune migration, aucune route nouvelle.
