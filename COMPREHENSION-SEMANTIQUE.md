# Compréhension sémantique de la demande

## Objectif

Comprendre les formulations courantes ivoiriennes sans ajouter manuellement un synonyme après chaque incident, tout en conservant les garanties existantes sur le budget, la zone, le modèle et les caractéristiques.

## Parcours client

1. Le client écrit naturellement sa demande.
2. Noma affiche immédiatement ce qu'il a compris.
3. Si un choix change réellement le type de produit, Noma pose une seule question avec 2 à 4 boutons.
4. Le client touche une réponse ; la recherche démarre sans second Turnstile.
5. En cas de panne ou de budget IA insuffisant, le parseur déterministe continue la recherche.

## Architecture livrée

- `poc/lib/understanding.ts` : interprétation structurée, termes de recherche locaux, exigences, préférences, exclusions et clarification rare.
- `poc/lib/engine.ts` : compréhension exécutée avant les connecteurs ; ambiguïté structurante = aucun scraping inutile.
- `poc/lib/query.ts` : le premier terme marketplace proposé par l'IA devient la requête source.
- `poc/lib/filter.ts` : tous les termes équivalents participent au rappel, avec limites de mots pour éviter les sous-chaînes trompeuses.
- `lib/contracts.ts` et `lib/server/search-stream.ts` : événements NDJSON `understanding` et `clarification`.
- `lib/server/continuation.ts` : réponse signée, valable 5 minutes, liée à la session, l'IP pseudonymisée, la demande et les options.
- `lib/real-search.ts` et `/recherche` : affichage de l'intention et réponse en un clic.

## Règles de confiance

- L'IA propose le sens et les synonymes ; elle ne décide jamais seule du budget, de la zone, du modèle ou des unités.
- Une exigence IA n'est gardée que si sa preuve apparaît mot pour mot dans la demande.
- Une information absente reste inconnue.
- Une clarification n'est autorisée que sous 0,8 de confiance et avec au moins deux choix concrets.
- Une continuation signée saute uniquement le second Turnstile ; quotas, concurrence et budget restent appliqués.
- `ai: null`, panne IA ou plafond atteint : repli déterministe, sans blocage du client.

## Validation hors ligne

- Contraintes inventées rejetées.
- « frigo » retrouve « réfrigérateur », mais 200 L reste incompatible avec 300 L et Bouaké reste incompatible avec Abidjan.
- Une demande ambiguë arrête le moteur avant tout connecteur.
- Jeton modifié, mauvais choix, autre texte ou expiration : refus.
- Flux client réel : clarification, clic, continuation signée, résultats.

## Limite honnête

Le système réduit fortement les erreurs de vocabulaire, mais aucun moteur ne peut garantir 99,9 % sans jeu de données réel annoté. La prochaine amélioration mesurable est un jeu de tests ivoiriens anonymisés (`demande → intention attendue → offres pertinentes`) et le suivi du taux de reformulation, du taux de clarification et du `Recall@10` par catégorie.
