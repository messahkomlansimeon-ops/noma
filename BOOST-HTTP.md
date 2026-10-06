# BOOST-HTTP.md — Cotations de boost par HTTP (lot 2I3)

Les routes qui exposent au **vendeur** les cotations de boost du lot 2I2 (`BOOST-PRICING.md`) : demander une cotation pour SON
offre, relire son historique. **Ce lot n'a AUCUN achat, paiement, crédit, solde, acceptation de cotation ni réservation de place,
aucune interface, et aucune route d'administration** (attribution, historique de périmètre). Aucune migration, aucun changement
de comportement de `quotes.ts`, `pricing.ts`, `boosts.ts`, `placement.ts` ni `stored-matches.ts`.

**Depuis le lot P1b, l'achat d'une cotation a ses propres routes (`POST` et `GET /api/offers/{id}/boost-purchases`) : `BOOST-PURCHASE.md`.**
Les routes de ce document restent inchangées.

Code : `lib/server/boost/http.ts` (`createBoostHttpHandlers`, `defaultBoostHttpHandlers`),
`app/api/offers/[id]/boost-quotes/route.ts` (exports `GET` et `POST` seulement, `runtime = "nodejs"`, `dynamic = "force-dynamic"`).
Tests : `npm run test:boost-http` (base `TEST_DATABASE_URL` dédiée).

## Routes

| Méthode | Chemin | Rôle |
|---|---|---|
| `POST` | `/api/offers/{id}/boost-quotes` | demander une cotation (créée, ou réutilisée si elle est encore valable) |
| `GET` | `/api/offers/{id}/boost-quotes?limit=N` | historique du vendeur pour son offre, plus récentes d'abord |

Toute autre méthode : 405 (Next.js). Toutes les réponses, succès comme erreurs, portent `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff` et un corps JSON.

## Ordre des contrôles

**POST** : 1. **origine** (`NOMA_AUTH_ORIGIN` absente ou invalide → 503 ; en-tête `Origin` absent ou différent → 403
`invalid_origin`) → 2. **session** (cookie `noma_auth` ; absente, invalide, révoquée, expirée ou compte non actif → 401
`authentication_required` ; résolution impossible → 503) → 3. **identifiant d'offre** (UUID, sinon 400) → 4. **corps** (400) → 5.
**cotation** (404, 409, 503, ou 200/201).

L'origine est contrôlée **avant** la session : une requête d'origine douteuse n'atteint ni la résolution de session ni la base.
C'est volontairement l'inverse des routes de mutation du catalogue, qui authentifient d'abord.

**GET** : 1. session (401) → 2. identifiant (400) → 3. paramètres (400) → 4. lecture (404, 503, ou 200). Le GET ne contrôle pas
l'origine (lecture seule).

## POST : corps

Exactement `{ "durationCode": "24h" | "3d" | "7d" }`, avec `Content-Type: application/json`, 32 Kio au plus (le plafond du
catalogue, `CATALOG_HTTP_BODY_MAX_BYTES`). Un objet JSON simple, la clé obligatoire, **aucune autre clé** ; un corps non JSON, un
tableau, `null`, une chaîne, une clé absente ou en plus, une durée inconnue ou d'un autre type, un autre `Content-Type` ou un
corps trop gros → **400 `invalid_request`** (un corps trop gros n'est pas un 413, contrairement au catalogue).

```json
{ "durationCode": "3d" }
```

Succès : **201** si la cotation vient d'être créée (y compris quand la cotation encore valable était déjà ACHETÉE : elle n'est jamais
renvoyée, voir `BOOST-PURCHASE.md`), **200** si une cotation encore valable a été réutilisée (même offre, durée,
vendeur et périmètre : aucune écriture). Une cotation **indisponible** est un succès (201 ou 200, `status: "unavailable"` et son
motif), jamais une erreur HTTP.

## GET : paramètres

Seul `limit` est autorisé : entier de 1 à 50 (défaut 20), ni dupliqué ni mal formé. Tout autre paramètre (y compris `cursor`,
`offset`, `Limit`), `limit=0`, `51`, `-1`, `1.5`, `abc`, vide, ou non entier de base 10 → 400. Réponse : les cotations de l'offre,
**les plus récentes d'abord** (`computed_at`, puis `id`), avec `expired` calculé à la lecture. Une offre sans cotation (même en
pause ou sans marque) répond 200 avec `"quotes": []`.

## Réponses

Contrat `contractVersion: "boost-quote/v1"`. Les valeurs ci-dessous viennent des gestionnaires réels sur une base de test (monde
de l'exemple de contrôle de 2I2 : 3 vendeurs concurrents, 4 acheteurs compatibles, 1 place utilisée sur 3 ; les identifiants et
les dates changent à chaque exécution).

**201 — cotation disponible** (`POST` `{ "durationCode": "3d" }`) :

```json
{
  "contractVersion": "boost-quote/v1",
  "quote": {
    "id": "b6fada3d-0ecd-45f6-965e-7aebeb1d2bd4",
    "durationCode": "3d",
    "currency": "XOF",
    "status": "available",
    "amount": 2300,
    "unavailableReason": null,
    "factors": { "competitionMilli": 1060, "demandMilli": 1300, "scarcityMilli": 1333, "durationMilli": 2500 },
    "inputs": { "competingSellers": 3, "compatibleBuyers": 4, "slotsTotal": 3, "slotsUsed": 1 },
    "computedAt": "2026-10-05T17:01:29.061Z",
    "expiresAt": "2026-10-05T17:16:29.061Z",
    "reused": false
  }
}
```

**200 — même demande, cotation réutilisée** : le même corps, avec `"reused": true`.

**201 — cotation indisponible** (offre sans acheteur compatible) : `status: "unavailable"`, `amount: null`, `factors: null`,
`unavailableReason: "no_compatible_buyer"`, expiration 60 s après le calcul.

**GET** : `{ "contractVersion": "boost-quote/v1", "quotes": [ … ] }`, chaque élément ayant les mêmes champs que ci-dessus, avec
`expired` (booléen) à la place de `reused`.

### Champs (liste blanche exacte)

`id`, `durationCode`, `currency` (`XOF`), `status` (`available` | `unavailable`), `amount` (entier XOF ou `null`),
`unavailableReason` (`offer_already_boosted`, `no_slot_available`, `seller_boost_limit_reached`, `no_compatible_buyer`, ou
`null`), `factors` (`competitionMilli`, `demandMilli`, `scarcityMilli`, `durationMilli`, ou `null`), `inputs` (`competingSellers`,
`compatibleBuyers`, `slotsTotal`, `slotsUsed`), `computedAt` et `expiresAt` (ISO 8601 UTC), `reused` (POST seulement) ou `expired`
(GET seulement).

Le DTO est construit champ par champ : un champ ajouté plus tard à `BoostQuote` ne sort **jamais** tant qu'on ne l'ajoute pas ici.
**Jamais exposés** : le prix brut (`rawAmount`), la configuration tarifaire (`pricing` : clé, version), l'identifiant de l'offre ou
du vendeur, le périmètre produit, l'identité ou le nombre détaillé d'un acheteur ou d'un vendeur concurrent (seuls les comptages
datés de `inputs` sortent).

## Erreurs

Corps `{ "error": { "code", "message" } }`, messages fixes (jamais un identifiant, une requête ni un message de la base).

| Statut | `code` | Cas |
|---|---|---|
| 400 | `invalid_request` | identifiant non UUID, corps ou paramètres invalides (voir ci-dessus), valeur refusée par la couche métier |
| 401 | `authentication_required` | pas de cookie, cookie en double ou invalide, session révoquée ou expirée, compte non actif |
| 403 | `invalid_origin` | POST : `Origin` absent ou différent de `NOMA_AUTH_ORIGIN` |
| 404 | `resource_not_found` | offre inexistante **ou offre d'un autre vendeur** : réponse strictement identique (statut, en-têtes, corps) |
| 409 | `offer_not_eligible` | offre à soi, mais non publiée, archivée, indisponible, ou propriétaire inactif |
| 409 | `offer_not_boostable` | offre à soi et éligible, mais sans catégorie, marque ou modèle |
| 503 | `boost_unavailable` | `NOMA_AUTH_ORIGIN` non configurée, réglages tarifaires ou de boost absents, verrou (`55P03`), base indisponible, migration 0012 non appliquée, session impossible à résoudre, toute autre erreur |

Le propriétaire est vérifié **avant** l'éligibilité : on ne révèle jamais l'existence ni l'état de l'offre d'autrui (une offre
d'autrui en pause répond 404, jamais 409).

## Journal serveur

Pour chaque 503, **un seul code** est journalisé (`console.error("[boost-http] <code>")` par défaut, ou le journal injecté) : le
code du domaine (`boost_pricing_missing`, `boost_settings_missing`), le SQLSTATE ou code réseau de l'erreur (`55P03`, `42P01`,
`ECONNREFUSED`…) s'il a la forme `[A-Za-z0-9_]{1,40}`, `origin_unconfigured`, ou `unexpected_error`. Jamais le message brut, la
requête ni un identifiant. Un journal qui lève est ignoré (la réponse ne change pas).

## Dépendances injectables

`createBoostHttpHandlers({ pool?, now?, env?, resolveSession?, log? })` : le pool PostgreSQL (défaut : `getPostgresPool()`, résolu
à la demande), l'horloge de session, l'environnement (défaut : `process.env`, relu à chaque requête), la résolution de session
(défaut : `resolveSession` de `lib/server/auth`) et le journal. `defaultBoostHttpHandlers` utilise les défauts.

## Exploitation

- `NOMA_AUTH_ORIGIN` est obligatoire pour le POST (comme les routes du catalogue). Sans elle, tout POST répond 503.
- La migration 0012 doit être appliquée : sans elle, le POST répond 503 (journal `42P01`). Depuis le lot P1b, la **migration 0015** l'est aussi
  (la réutilisation d'une cotation exclut celles déjà achetées : `boost_purchases`). `MATCHING_REQUIRED_MIGRATION` reste 0010.
- Une cotation indisponible n'est pas une erreur : l'interface (lot suivant) devra lire `status` et `unavailableReason`.

## Limites

- **Aucune limite de débit propre à ces routes.** C'est la réutilisation de 2I2 qui borne les **écritures** : une cotation encore
  valable est renvoyée sans écriture, soit au plus une ligne par offre, durée et fenêtre de validité (900 s par défaut pour une
  cotation disponible, 60 s pour une indisponible), mais chaque appel ouvre tout de même une transaction, prend le verrou de
  l'offre et lit les réglages ; un vendeur multipliant ses offres multiplie la charge. Une limite de débit en amont (proxy) reste à
  prévoir avant une exposition publique.
- **Aucun achat, paiement, crédit, solde, acceptation de cotation, réservation de place ni interface.** Une cotation ne promet
  aucune impression et ne garantit pas la place : la disponibilité sera revérifiée à l'achat (lot paiement).
- **Valeurs tarifaires provisoires** (`BOOST-PRICING.md`), à calibrer sur des usages réels.
- Aucune route d'administration (attribution, historique des prix d'un périmètre) : `readScopeBoostPriceHistory` n'est pas exposé.
- Le contrat `boost-quote/v1` est figé par les tests (liste blanche exacte) : tout champ nouveau passe par une nouvelle version.
