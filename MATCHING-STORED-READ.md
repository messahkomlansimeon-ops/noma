# MATCHING-STORED-READ.md — Lecture des correspondances enregistrées (lot 2F1)

Les routes en direct (`/matches`, `MATCHING-HTTP.md`) **recalculent** chaque évaluation à la demande. Les routes
`stored-matches` **relisent** ce que le worker a déjà enregistré dans `matching_evaluations` : aucune évaluation,
aucun appel LLM, réseau ou SMS, aucune écriture. Les routes en direct sont inchangées.

Code : `lib/server/matching/stored-matches.ts` (`listStoredDemandMatchesForOffer`, `listStoredOfferMatchesForDemand`),
DTO `StoredMatchesResponseDto` (`http-dto.ts`), gestionnaires `offers.storedMatches` / `demands.storedMatches`
(`http.ts`). Tests : `npm run test:matching-stored` (base `TEST_DATABASE_URL` dédiée).

## Contrat

| Méthode | Route | Sens |
| --- | --- | --- |
| `GET` | `/api/offers/[id]/stored-matches` | demandes candidates d'une offre publiée |
| `GET` | `/api/demands/[id]/stored-matches` | offres candidates d'une demande active |

Authentification, paramètres (`limit` 1 à 100, défaut 20 ; `cursor` ; tout autre paramètre → 400), erreurs
(`mapMatchingError`), `Cache-Control: no-store` : identiques aux routes en direct. La source passe par les MÊMES
`loadSourceOffer` / `loadSourceDemand` (404 autre propriétaire ou inexistante, 400 source ou propriétaire
inéligible), dans UN instantané `REPEATABLE READ READ ONLY`.

Réponse (`contractVersion: "matching-stored-http/v1"`) : `source` (fiche produit épurée), `items`, `processing`,
`readAt`, `nextCursor`, `hasMore`, `limit`, `truncated` (lot 2H1). Chaque item a la forme de l'item en direct (`candidateId`,
`candidateContentVersion`, `candidate`, `compatibilityStatus`, `score`, `coverage`, `evaluation`, `scoring`) plus
`evaluatedAt`, `indicators` (`availability`, `price`, `confidence`) et `relevance` (lot 2H1 : champs ajoutés, même
`contractVersion`, voir `MATCHING-RELEVANCE.md`). Lot PH1 : chaque item de la liste d'un besoin porte en plus `coverPhotoId` (identifiant de la photo de couverture ; le fichier est servi par `GET /api/media/{id}`), ajouté par la route **seulement quand l'annonce a des photos** (voir `PHOTOS.md`). Les résumés sont relus depuis les colonnes `evaluation_summary` (`criteriaSummary`),
`scoring_summary` et `preferences_summary` ; `score` et `coverage` viennent de colonnes `NUMERIC(9,6)` : **arrondis
à 6 décimales**. Liste blanche stricte, champ par champ : jamais d'identifiant de propriétaire, de texte brut,
d'`evaluation_details`, de `scoring_config`, de clé d'idempotence ni de hash de tentative (ces colonnes ne sont
même pas lues).

## Fraîcheur

Une ligne n'est servie que si elle est `is_confirmed_match = TRUE` (compatible ET éligible) pour cette source et
passe le prédicat de fraîcheur **partagé** avec `getActiveMatchingEvaluation` (`persistence.ts` :
`buildMatchingFreshnessPredicate`) : dernière tentative non périmée, versions de contenu courantes des deux
ressources, propriétaires actifs et distincts, offre publiée et non `unavailable`, demande active, versions de
moteur et hash de configuration COURANTS (valeurs par défaut, comme `getActiveMatchingEvaluation`), et
`expires_at` nul ou postérieur à `clock_timestamp()`. Le candidat est relu par jointure : ses versions sont celles
de l'évaluation, grâce au prédicat.

## Tri et pagination

Paramètre `sort` (lot 2H1) : `score` (défaut) ou `relevance` ; toute autre valeur ou un `sort` dupliqué → 400. Le tri par
pertinence (fenêtre de 200, décalage, `at` figé, `truncated`) est décrit dans `MATCHING-RELEVANCE.md` ; le tri par
score ci-dessous est inchangé.

Tri par score : `score DESC NULLS LAST, evaluated_at DESC, id DESC`, pagination keyset, `LIMIT limit + 1`. Les index partiels
`idx_matching_eval_offer_confirmed` / `idx_matching_eval_demand_confirmed` (0006) couvrent `(source, score DESC
NULLS LAST, evaluated_at DESC)` ; `id` n'est qu'un départage des égalités : aucun index supplémentaire, aucune
migration.

Curseur opaque (base64url, 512 caractères au plus) : `{ v: 1, sourceKind, sourceId, score, evaluatedAt, id }` où
`score` est le texte NUMERIC exact (ou `null`), `evaluatedAt` un ISO UTC à 6 décimales terminé par `Z` et `id` l'id
de l'évaluation. Décodage strict AVANT tout SQL (clés exactes, version, formats, calendrier) puis liaison à la
source et au sens demandés : un curseur forgé, ou réutilisé sur une autre source ou dans l'autre sens, donne une
erreur de validation (400). Un curseur à score non nul reprend les scores inférieurs, PUIS tout le segment NULL ;
un curseur à score nul ne reprend que la suite du segment NULL.

## `processing`

Booléen, vrai si, pour la **version COURANTE** de la source : un événement outbox `pending` de son agrégat existe
à cette version, OU un job `evaluate_*` du bon type existe sur `(source, content_version)` en `pending`,
`running` ou `failed`. Il passe à faux quand le job est terminé (`completed`, `superseded`, `dead_letter`).
Un job d'une version ancienne ou d'un autre type n'est pas pris en compte. `readAt` est le `clock_timestamp()` de
la base lu au début de la lecture (c'est le `now` des indicateurs).

**Un NOUVEAU candidat est ajouté plus tard par SON PROPRE job** (celui de la ressource nouvellement créée ou
modifiée) : ce cas n'est pas reflété par `processing`, qui ne parle que de la source. Les événements d'autres
agrégats (compte suspendu ou réactivé, échéance temporelle) ne sont pas non plus pris en compte.

## Limites

- Un changement de configuration de scoring (hash) ou de version de moteur **masque** les lignes enregistrées
  jusqu'à leur réévaluation ; `scoring_config_sweep` n'existe pas encore, donc rien ne les réévalue
  automatiquement : la liste peut rester vide tant que les jobs correspondants ne sont pas créés.
- Une source modifiée n'a plus de lignes tant que son job de réévaluation n'est pas terminé (`processing` vrai).
- Lecture d'un instantané : `processing` et les items sont cohérents entre eux, mais le worker peut avancer
  juste après `readAt`.
- Pas de classement autre que le score (pas de boost, pas de notification, pas d'interface).
