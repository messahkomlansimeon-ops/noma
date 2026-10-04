# Persistance des propositions d'extraction — contrat v1

Le module serveur `lib/server/catalog-extraction/persistence.ts` conserve
l'historique des propositions sans modifier les offres, demandes ou versions de
contenu. Il est exposé de manière privée via les routes HTTP du lot 1E3
(voir `CATALOG-EXTRACTION-HTTP.md`), sans aucune tâche automatique ni IA active.

## Écriture

`createCatalogExtractionProposal({ ownerId, resourceType, resourceId }, options)`
ne reçoit aucun texte. Il lit `raw_text` et `content_version` dans PostgreSQL,
réutilise uniquement l'extracteur déterministe existant, puis calcule côté
serveur l'empreinte SHA-256 du texte UTF-8 exact.

L'extraction a lieu hors transaction. Avant insertion, une transaction verrouille
la ressource et vérifie à nouveau propriétaire, texte, version et absence
d'archivage. Une modification ou un archivage concurrent produit
`CatalogExtractionPersistenceConflictError` et aucune proposition n'est écrite.
Le point de synchronisation optionnel `afterExtraction` n'altère pas l'extracteur
et sert aux tests déterministes de concurrence.

L'unicité porte sur la ressource, sa `contentVersion`, la version du contrat et
la version d'extracteur. Une répétition ou des appels concurrents retournent la
même ligne persistée. Aucun champ catalogue ni `contentVersion` n'est modifié.

## Lecture

- `getCatalogExtractionProposalById({ ownerId, proposalId })` retourne la
  proposition ou `null` ; une proposition étrangère est indistinguable d'une
  proposition absente.
- `listCatalogExtractionProposals({ ownerId, resourceType, resourceId })`
  retourne l'historique décroissant ou `[]` pour une ressource étrangère ou
  absente.

Chaque résultat contient le texte source exact, son SHA-256, les versions,
la proposition complète, les preuves, les ambiguïtés et `isStale`. Ce dernier
vaut `true` si la version ou le texte courant diffère, ou si la ressource est
archivée. Les valeurs humaines du catalogue restent séparées de la proposition.

## Test PostgreSQL isolé

```shell
export TEST_DATABASE_URL='postgresql://noma_local:noma_local_only@127.0.0.1:55432/noma_test'
npm run test:catalog-extraction-postgres
```

La commande utilise le même harnais de schéma temporaire vérifié que les autres
suites PostgreSQL. Sans base dédiée, elle échoue explicitement sans simulation.
