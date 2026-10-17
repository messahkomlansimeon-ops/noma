# API privée des propositions d'extraction catalogue

Cette couche expose l'accès HTTP privé aux propositions d'extraction
déterministes associées aux offres et aux demandes du catalogue propriétaire.
Elle réutilise la persistance isolée (Lot 1E2 / Lot 1E3) sans jamais altérer
les champs saisis par les utilisateurs ni déclencher d'appel IA par match.

## Configuration requise

- `DATABASE_URL` : connexion PostgreSQL serveur.
- `NOMA_AUTH_ORIGIN` : origine HTTP(S) stricte autorisée pour les requêtes `POST`.

Toutes les réponses portent les en-têtes de protection :
- `Cache-Control: no-store`
- `X-Content-Type-Options: nosniff`

## Authentification et Propriété

- L'authentification repose exclusivement sur le cookie de session `noma_auth`.
- Une session absente, expirée, révoquée ou associée à un compte non actif produit un statut `401 Unauthorized` (`code: "authentication_required"`).
- Une ressource absente ou appartenant à un autre compte produit strictement le même statut `404 Not Found` (`code: "resource_not_found"`), interdisant toute énumération ou fuite d'information.

## Routes exposées

| Méthode | Route | Rôle | Succès |
| --- | --- | --- | --- |
| `GET` | `/api/offers/[id]/extraction-proposals` | Historique des propositions de l'offre | `200` |
| `POST` | `/api/offers/[id]/extraction-proposals` | Créer ou réutiliser la proposition de l'offre | `200` |
| `POST` | `/api/offers/[id]/extraction-proposals/[proposalId]/apply` | Appliquer une sélection de proposition sur l'offre | `200` |
| `GET` | `/api/demands/[id]/extraction-proposals` | Historique des propositions de la demande | `200` |
| `POST` | `/api/demands/[id]/extraction-proposals` | Créer ou réutiliser la proposition de la demande | `200` |
| `POST` | `/api/demands/[id]/extraction-proposals/[proposalId]/apply` | Appliquer une sélection de proposition sur la demande | `200` |

---

## Méthode POST : Création / Réutilisation Idempotente

### Règles et protections
1. **Contrôle d'origine CSRF** :
   - L'en-tête `Origin` est obligatoire et doit correspondre exactement à `NOMA_AUTH_ORIGIN`.
   - Une origine différente ou absente produit un statut `403 Forbidden` (`code: "invalid_origin"`).
   - Une origine serveur non configurée produit un statut `503 Service Unavailable`.
2. **Contrôle du corps** :
   - Le texte source est lu **exclusivement** depuis la ressource catalogue dans PostgreSQL.
   - Aucun champ métier n'est accepté dans le corps : l'envoi d'un corps avec des propriétés produit un statut `400 Bad Request` (`code: "invalid_request"`).
   - Un corps vide (0 octet, y compris flux `ReadableStream` vide avec ou sans en-tête `Content-Type`) ou un objet JSON vide `{}` avec `Content-Type: application/json` est accepté.
   - Pour tout corps non vide, le format JSON (`{}`) est obligatoire.
   - La taille du corps est bornée à 32 Kio : tout dépassement produit un statut `413 Payload Too Large` (`code: "payload_too_large"`). Un en-tête `Content-Length: 0` ne permet jamais de contourner la lecture bornée effective du flux.
3. **Idempotence et intégrité** :
   - Si une proposition existe déjà pour la version courante (`sourceContentVersion`) de la ressource, elle est immédiatement retournée sans recalcul ni duplication.
   - Si la ressource a été modifiée pendant l'extraction hors transaction, un conflit atomique produit un statut `409 Conflict` (`code: "extraction_conflict"`).
   - Si la ressource est archivée, l'opération est refusée avec un statut `409 Conflict` (`code: "resource_archived"`).
   - Si le texte de la ressource en base dépasse les limites maximales de l'extracteur déterministe (10 000 caractères ou 32 Kio), une erreur métier explicite est retournée avec un statut `400 Bad Request` (`code: "extraction_validation_error"`), et jamais un faux `503`.
4. **Non-mutation du catalogue** :
   - Aucun champ de l'offre ou de la demande n'est modifié.
   - `content_version` de l'offre ou de la demande reste inchangé.

### Réponse POST réussie (`200 OK`)
```json
{
  "extractionProposal": {
    "id": "uuid",
    "resourceType": "offer",
    "resourceId": "uuid",
    "sourceContentVersion": 1,
    "sourceRawText": "iPhone 12 128 Go",
    "sourceTextSha256": "...",
    "contractVersion": "catalog-extraction/v1",
    "extractorVersion": "noma-deterministic/v1",
    "provenance": "deterministic",
    "proposal": {
      "type": "offer",
      "rawText": "iPhone 12 128 Go",
      "contractVersion": "catalog-extraction/v1",
      "extractorVersion": "noma-deterministic/v1",
      "provenance": "deterministic",
      "fields": { ... },
      "evidence": [ ... ],
      "ambiguities": [ ... ]
    },
    "evidence": [ ... ],
    "ambiguities": [ ... ],
    "createdAt": "2026-10-04T00:00:00.000Z",
    "isStale": false
  }
}
```

---

## Méthode GET : Historique Paginé

### Règles et protections
1. **Lecture seule** :
   - Aucun appel à l'extracteur n'est déclenché par une lecture.
   - Si aucune proposition n'a encore été extraite pour la ressource, la liste est vide `[]` avec un statut `200 OK`.
2. **Indicateur d'obsolescence (`isStale`)** :
   - Vaut `false` si la proposition correspond à la version et au texte courants de la ressource active.
   - Vaut `true` si le texte ou la version de la ressource a changé depuis l'extraction, ou si la ressource est archivée.
3. **Pagination SQL stable** :
   - Paramètres de requête supportés :
     - `limit` : entier entre 1 et 100 (défaut 20).
     - `offset` : entier positif ou nul (défaut 0).
   - Tout paramètre inconnu, dupliqué ou hors bornes produit un statut `400 Bad Request` (`code: "invalid_request"`).
   - Ordonnancement SQL déterministe : `source_content_version DESC, created_at DESC, id DESC`.

### Réponse GET réussie (`200 OK`)
```json
{
  "extractionProposals": [
    {
      "id": "uuid",
      "resourceType": "offer",
      "resourceId": "uuid",
      "sourceContentVersion": 2,
      "isStale": false,
      ...
    },
    {
      "id": "uuid",
      "resourceType": "offer",
      "resourceId": "uuid",
      "sourceContentVersion": 1,
      "isStale": true,
      ...
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0
  }
}
```

---

## Méthode POST : Application Explicite d'une Proposition (`/apply`)

### Règles et protections
1. **Contrôle d'origine CSRF et Authentification** :
   - Requiert un cookie de session valide `noma_auth`.
   - L'en-tête `Origin` est obligatoire et doit correspondre exactement à `NOMA_AUTH_ORIGIN`.
   - Une origine absente ou divergente produit un statut `403 Forbidden` (`code: "invalid_origin"`).
2. **Contrôle strict du corps JSON** :
   - Le corps doit être un objet JSON valide n'excédant pas 32 Kio (`payload_too_large` 413 si dépassé).
   - Propriétés acceptées au premier niveau exclusivement :
     - `expectedContentVersion` (INTEGER > 0)
     - `selection` (OBJECT contenant `fields` et/ou `attributeKeys`)
     - `idempotencyKey` (STRING non vide de 1 à 255 caractères, ne contenant pas le caractère NUL U+0000)
   - Toute propriété inconnue (au premier niveau ou dans `selection`) est immédiatement rejetée avec un statut `400 Bad Request` (`code: "invalid_request"`).
   - Aucune valeur métier, identité de propriétaire ou objet de proposition complet ne peut être fourni dans le corps.
3. **Indistinguabilité 404** :
   - Ressource absente, étrangère, proposition inexistante ou non rattachée au chemin retournent strictement la même réponse `404 Not Found` (`code: "resource_not_found"`), sans révéler l'existence d'une ressource ou proposition tierce.
4. **Idempotence stricte et répétition** :
   - La transaction est sérialisée dans PostgreSQL par `(ownerId, idempotencyKey)`.
   - Une répétition avec la même clé et les mêmes paramètres retourne le reçu initial avec un statut `200 OK`, même si l'application initiale a incrémenté la version de la ressource (rendant la proposition obsolète).
   - Rejouer la même clé avec des paramètres divergents (ou sur une ressource distincte du même propriétaire) produit un statut `409 Conflict` (`code: "conflict"`).
5. **Gestion des conflits optimistes** :
   - Version concurrente modifiée : `409 Conflict` (`code: "stale_version"`).
   - Proposition devenue obsolète avant application : `409 Conflict` (`code: "stale_proposal"`).
   - Ressource archivée : `409 Conflict` (`code: "resource_archived"`).

### Corps de la requête
```json
{
  "expectedContentVersion": 1,
  "selection": {
    "fields": ["model"],
    "attributeKeys": ["storage_capacity"]
  },
  "idempotencyKey": "idem_12345"
}
```

### Réponse POST apply réussie (`200 OK`)
```json
{
  "applicationReceipt": {
    "id": "uuid",
    "idempotencyKey": "idem_12345",
    "ownerId": "uuid",
    "resourceType": "offer",
    "resourceId": "uuid",
    "proposalId": "uuid",
    "expectedContentVersion": 1,
    "versionBefore": 1,
    "versionAfter": 2,
    "selectedFields": {
      "fields": ["model"],
      "attributeKeys": ["storage_capacity"]
    },
    "changes": {
      "model": "iphone 12"
    },
    "appliedAt": "2026-10-04T12:00:00.000Z"
  }
}
```

---

## Tableau récapitulatif des statuts HTTP

| Statut | Code d'erreur | Description |
| --- | --- | --- |
| `200` | — | Succès de l'opération (lecture d'historique, extraction ou application de proposition). |
| `400` | `invalid_request` | Paramètres invalides, corps POST absent/interdit/inconnu, sélection invalide ou UUID non conforme. |
| `400` | `extraction_validation_error` | Texte de la ressource catalogue dépassant les limites maximales de l'extracteur (> 10 000 caractères). |
| `401` | `authentication_required` | Session `noma_auth` absente, invalide, expirée ou liée à un compte inactif. |
| `403` | `invalid_origin` | Origine de la requête POST absente ou non autorisée (protection CSRF). |
| `404` | `resource_not_found` | Ressource ou proposition absente, étrangère ou non rattachée (comportement indistinguable). |
| `409` | `resource_archived` | Tentative d'extraction ou d'application sur une ressource catalogue archivée. |
| `409` | `stale_version` | Conflit optimiste : la version de la ressource a changé. |
| `409` | `stale_proposal` | La proposition d'extraction est devenue obsolète. |
| `409` | `conflict` | Conflit d'idempotence (même clé réutilisée avec des paramètres divergents). |
| `409` | `extraction_conflict` | Conflit concurrent : la ressource a été modifiée pendant l'extraction. |
| `413` | `payload_too_large` | Corps de la requête POST dépassant la limite autorisée de 32 Kio. |
| `503` | `catalog_extraction_unavailable` | Indisponibilité temporaire (origine non configurée ou base de données inaccessible). |

---

## Écrans (carte « Remplir la fiche depuis mon texte »)

Ces routes sont branchées sur deux écrans, par la même carte (`components/extraction/extraction-card.tsx`) :

- la page d'une annonce du vendeur (`/vendeur/annonces/[id]`, route `offers`) ;
- la page d'un besoin de l'acheteur (`/besoins/[id]`, route `demands`), sauf un besoin porteur d'une mission (il se gère depuis la mission).

La carte n'apparaît pas pour une fiche archivée. Le parcours est : **Analyser mon texte** (`POST …/extraction-proposals`, ou relecture de l'historique `GET` au chargement : rien n'est recalculé), lignes proposées avec l'extrait exact du texte, cases à cocher, **Appliquer la sélection** (`POST …/apply`).

Règles de l'écran (`lib/client/extraction-view.ts`, testé) :

- l'écran n'envoie que les **noms** des champs cochés, jamais leurs valeurs : elles viennent de la proposition enregistrée par le serveur ;
- `expectedContentVersion` est la version de la proposition ; la clé d'idempotence est liée à la proposition ET à la sélection (un double appui ou un nouvel essai réseau ne s'applique jamais deux fois), et elle est oubliée après tout refus du serveur ;
- une valeur **déjà saisie** dans la fiche n'est jamais cochée d'avance (la valeur actuelle est montrée) ; une valeur identique à la fiche n'est pas proposée ;
- la **catégorie** et l'**état** sont montrés mais NON applicables : l'extracteur écrit des codes (`phones`, `very_good`) alors que le formulaire, la mise en correspondance (égalité stricte sur la catégorie : « telephones » ≠ « phones ») et les affichages de noma parlent en français (« Téléphones », « Occasion ») ; les appliquer ferait passer l'annonce à côté des besoins créés avec le formulaire et afficherait un code à l'écran. **À faire côté serveur** pour les ouvrir : traduire ces deux codes dans le vocabulaire de noma au moment de l'application (la marque, le modèle et le lieu sont comparés sans tenir compte de la casse ni des accents : sans risque) ;
- une ligne ambiguë ou un montant **sans devise** est montré mais désactivé (« Non applicable ») : aucune devise n'est supposée ;
- un refus de fraîcheur (`stale_proposal`, `stale_version`, `extraction_conflict`, `conflict`) retire les lignes et demande une nouvelle analyse ; les messages sont fixes, jamais le texte du serveur.

Vérifié par `tests/client/extraction.test.ts` (client, lignes, messages, câblage) et par `npm run e2e:extraction` (vrai navigateur, vrai serveur, vraie base : analyse, application partielle, seconde analyse, devise inconnue, texte modifié entre-temps, valeur déjà saisie, besoin d'acheteur, annonce archivée, fiche d'autrui en 404, panne de l'analyse, session expirée, analyse périmée après modification du texte, et non-régression du matching : une annonce remplie par l'extraction reste trouvée par un besoin saisi au formulaire, avec sa catégorie « Téléphones » intacte).
