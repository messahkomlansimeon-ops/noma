# Validation réelle de la compréhension acheteur

Date : 3 octobre 2026.

## Périmètre

Validation OpenRouter de l'étape de compréhension uniquement : aucun scraping,
aucun navigateur, aucun vendeur contacté. Huit demandes représentatives du
marché ivoirien ont été testées avec vérification automatique du produit, du
budget, de la zone, des exclusions, des ambiguïtés et des preuves textuelles.

## Résultat final

**8/8 cas validés** avec le premier modèle, sans repli :

1. « télé 55 pouces à Yop, budget 180k » ;
2. « frigo 300 litres sans congélateur à Cocody » ;
3. « chargeur type C 20 watts, pas solaire » ;
4. « console à Abidjan 150 000 » → question obligatoire : console de jeux ou meuble console ;
5. reprise signée après le choix « Console de jeux », budget conservé ;
6. « baskets Nike pointure 42, pas de contrefaçon, max 35k » ;
7. service de réparation de climatiseur à Marcory ;
8. « table 6 places à Angré, moins de 100 mille francs ».

Run final : 8 appels, 4 651 tokens d'entrée, 705 tokens de sortie, coût connu
**0,00112065 $**. Toute la session de diagnostic et de correction a consommé
**0,012142094 $** sur 52 appels connus.

## Défauts trouvés et corrigés

- Le contrat JSON n'indiquait pas les noms de clés exacts : les trois modèles
  répondaient, mais leurs réponses étaient rejetées puis remplacées par le
  repli déterministe. Le contrat est maintenant explicite ; le premier modèle
  suffit.
- « 100 mille francs », « 120 mille » et « 1,5 million FCFA » sont compris et
  normalisés sans tronquer le montant.
- Les formulations conversationnelles comme « je voudrais » et « vers Angré »
  ne polluent plus le produit recherché.
- Une contrainte accompagnée de « sans », « pas » ou « pas de » est déplacée
  automatiquement vers les exclusions, même si le modèle la classe mal.
- Budget, zone et caractéristiques chiffrées ne sont plus comptés deux fois
  comme exigences sémantiques.
- Une taxonomie d'ambiguïtés impose une question pour « console » seul ; elle
  pourra être enrichie à partir des demandes réelles.

## Limite de la preuve

Ce résultat prouve les huit scénarios testés, pas un taux de compréhension de
99,9 %. Un tel taux devra être mesuré sur un corpus annoté de demandes réelles
ivoiriennes, avec suivi des corrections et des échecs par catégorie.

Script reproductible : `poc/validate-understanding-live.ts`.
