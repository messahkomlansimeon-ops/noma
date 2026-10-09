import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { productKeyString } from "../external/product-key";
import { loadSourceDemand } from "../matching/service";
import { withPostgresTransaction } from "../postgres/client";
import { currentInstant } from "../subscriptions/time";
import { postWalletTransaction } from "../wallet/ledger";
import {
  ACTIVE_SEARCH_FRESH_COLLECTION_MS,
  ACTIVE_SEARCH_DURATION_DAYS,
  ACTIVE_SEARCH_LOCK_TIMEOUT_MS,
  ACTIVE_SEARCH_MAX_HORIZON_DAYS,
  ACTIVE_SEARCH_PRICE_XOF,
  ACTIVE_SEARCH_USER_LOCK_NAMESPACE,
} from "./config";
import { acceleratedLimit, capacityAllows, externalCollectionAvailable, type Environment } from "./availability";
import { markBaselinePending, takeBaseline } from "./baseline";
import { ELIGIBILITY_COLUMNS, demandIneligibility, eligibilityKeyOf, type DemandEligibilityInput } from "./eligibility";
import { ActiveSearchError } from "./errors";
import { lockAdmission, reconcileAcceleratedPlaces, userCapAllows, userKeysInForce } from "./places";
import { activeSearchSchemaPresent, computeCoverage, readLivePeriods } from "./state";

/**
 * Achat d'une période de RECHERCHE ACTIVE pour un besoin (lots RA1 et RA1-bis). UNE transaction SQL, sous le verrou de l'utilisateur :
 *  1. rejeu de la clé d'idempotence (même besoin et même prix affiché : l'achat déjà enregistré est renvoyé, AUCUN nouveau débit ; autre besoin : `idempotency_conflict` ; achat REMBOURSÉ :
 *     `purchase_refunded`, jamais « déjà enregistré ») ;
 *  2. le besoin est celui de l'utilisateur (sinon « introuvable », comme un besoin inconnu) et ÉLIGIBLE : `demandIneligibility`, fonction unique (besoin actif, clé produit, collecte
 *     externe disponible : `demand_not_active`, `no_product_key`, `unavailable`) ;
 *  3. le PRIX AFFICHÉ (`expectedPriceXof`) est le prix courant, sinon `price_changed` : l'acheteur ne paie jamais un prix qu'il n'a pas vu ;
 *  4. la période : une ACTIVATION commence maintenant ; une EXTENSION commence exactement à la fin de la chaîne en vigueur (périodes contiguës) ; la fin ne dépasse jamais
 *     maintenant + 180 jours (`max_horizon`) ; PLAFOND PAR UTILISATEUR (lot RA1-ter, `user_cap`) : un acheteur n'a jamais des options en vigueur sur plus de deux clés produit distinctes, à l'ACHAT
 *     comme à la PROLONGATION ; une ACTIVATION d'une clé produit qui n'a pas encore de place est soumise au contrôle d'ADMISSION (`capacity` : les quotas des sources ne portent qu'un
 *     nombre borné de surveillances accélérées, voir RECHERCHE-ACTIVE.md), sous un verrou global qui sérialise les attributions de places (`places.ts`, fonction unique appelée avant le
 *     contrôle puis après l'écriture de l'achat, pour une activation comme pour une prolongation) ;
 *  5. le débit, en crédits PAYÉS seulement (`search_purchase` : acheteur −prix, revenus de la recherche active +prix) : solde insuffisant, tout est annulé, rien n'est écrit ;
 *  6. l'achat, le suivi des notifications du besoin (au moins jusqu'à la fin de l'option), et, pour une activation, le relevé des annonces d'autres sites DÉJÀ PRÉSENTES (elles ne
 *     notifieront jamais) : fait tout de suite si la surveillance a une collecte RÉUSSIE de moins de 48 h, sinon en attente de la première collecte réussie.
 * Pas de renouvellement automatique. Ordre des verrous : utilisateur → ligne du besoin → périodes du besoin → verrou global d'admission → comptes du grand livre.
 */

const ZERO = BigInt(0);

export interface ActiveSearchPurchaseResult {
  purchaseId: string;
  demandId: string;
  kind: "activation" | "extension";
  /** Vrai si cet appel a renvoyé l'achat déjà enregistré pour la même clé d'idempotence : aucun nouveau débit. */
  reused: boolean;
  startsAt: Date;
  endsAt: Date;
  priceXof: bigint;
  /** Solde en crédits payés après l'opération. */
  balance: bigint;
}

export interface ActiveSearchTestHooks {
  /** Réservé aux tests : appelé après tous les contrôles, juste avant le débit. */
  beforeDebit?: () => void | Promise<void>;
  /** Réservé aux tests : appelé juste après le débit, avant l'écriture de l'achat. */
  afterDebit?: () => void | Promise<void>;
}

async function readBalance(client: PoolClient, userId: string): Promise<bigint> {
  const result = await client.query<{ balance: string }>("SELECT balance::text AS balance FROM wallet_accounts WHERE kind = 'user' AND owner_id = $1::uuid", [userId]);
  return result.rows[0] ? BigInt(result.rows[0].balance) : ZERO;
}

async function addDays(client: PoolClient, instant: string, days: number): Promise<string> {
  const result = await client.query<{ at: string }>(
    `SELECT to_char((($1::timestamptz AT TIME ZONE 'UTC') + make_interval(days => $2::int)), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
    [instant, days],
  );
  return result.rows[0].at;
}

export async function purchaseActiveSearch(input: {
  pool: Pool;
  userId: string;
  demandId: string;
  idempotencyKey: string;
  /** Prix affiché à l'acheteur (XOF, entier) : `price_changed` s'il diffère du prix courant. Obligatoire. */
  expectedPriceXof: number;
  /** Environnement qui dit si la collecte externe peut fournir des annonces (défaut : `process.env`). */
  env?: Environment;
  /** Horloge injectable (essais, outils) : défaut, l'horloge de la base. */
  now?: Date;
  hooks?: ActiveSearchTestHooks;
}): Promise<ActiveSearchPurchaseResult> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  const idempotencyKey = requireUuid(input.idempotencyKey, "idempotencyKey").toLowerCase();
  if (typeof input.expectedPriceXof !== "number" || !Number.isSafeInteger(input.expectedPriceXof) || input.expectedPriceXof <= 0) {
    throw new CatalogValidationError("expectedPriceXof doit être un entier positif (le prix affiché).");
  }
  const expectedPriceXof = input.expectedPriceXof;
  const env = input.env ?? process.env;

  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '${ACTIVE_SEARCH_LOCK_TIMEOUT_MS}ms'`);
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [ACTIVE_SEARCH_USER_LOCK_NAMESPACE, userId]);
    // Base à laquelle il manque une migration de la recherche active (0028, 0029) : l'option n'est pas vendable, jamais une erreur SQL (la migration s'applique AVANT le code).
    if (!(await activeSearchSchemaPresent(client))) throw new ActiveSearchError("unavailable");

    const replay = await client.query<{ id: string; demand_id: string; kind: "activation" | "extension"; price: string; starts_at: Date; ends_at: Date; refunded: boolean }>(
      `SELECT id, demand_id, kind, price_xof::text AS price, starts_at, ends_at, (refunded_at IS NOT NULL) AS refunded
         FROM active_search_purchases WHERE user_id = $1::uuid AND idempotency_key = $2::uuid`,
      [userId, idempotencyKey],
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (row.demand_id !== demandId) throw new ActiveSearchError("idempotency_conflict");
      // Une clé dont l'achat a été REMBOURSÉ ne renvoie jamais « déjà enregistré » : l'option n'existe plus, un nouvel achat exige une nouvelle clé.
      if (row.refunded) throw new ActiveSearchError("purchase_refunded");
      if (BigInt(row.price) !== BigInt(expectedPriceXof)) throw new ActiveSearchError("price_changed");
      return { purchaseId: row.id, demandId, kind: row.kind, reused: true, startsAt: row.starts_at, endsAt: row.ends_at, priceXof: BigInt(row.price), balance: await readBalance(client, userId) };
    }

    const demand = await client.query<DemandEligibilityInput & { owner_id: string }>(
      `SELECT ${ELIGIBILITY_COLUMNS}, d.owner_id FROM demands d WHERE d.id = $1::uuid FOR UPDATE`,
      [demandId],
    );
    if (!demand.rows[0] || demand.rows[0].owner_id !== userId) throw new CatalogNotFoundError("demande");
    // UNE seule fonction décide de l'éligibilité du besoin (eligibility.ts) : la même que celle de l'écran.
    const ineligible = demandIneligibility(demand.rows[0], { collectionAvailable: await externalCollectionAvailable(client, env) });
    // Le besoin PORTEUR d'une mission n'est pas un besoin de l'acheteur : MÊME refus qu'un besoin d'autrui (404), jamais un motif qui révélerait qu'il existe (lot MV1).
    if (ineligible === "mission_carrier") throw new CatalogNotFoundError("demande");
    if (ineligible !== null) throw new ActiveSearchError(ineligible);
    if (expectedPriceXof !== ACTIVE_SEARCH_PRICE_XOF) throw new ActiveSearchError("price_changed");
    const demandKey = eligibilityKeyOf(demand.rows[0]);
    if (demandKey === null) throw new ActiveSearchError("no_product_key");
    const keyText = productKeyString(demandKey);

    const nowText = await currentInstant(client, input.now);
    const now = new Date(nowText);
    const coverage = computeCoverage(await readLivePeriods(client, demandId, { lock: true }), now);
    const extension = coverage.chainEnd !== null;
    // PLAFOND PAR UTILISATEUR, à l'achat comme à la prolongation, avant tout verrou global et tout débit : les clés produit distinctes de ses options en vigueur (suspendues comprises),
    // plus celle de ce besoin, ne dépassent jamais le plafond. Une prolongation garde sa clé mais ne passe pas si l'utilisateur a entre-temps d'autres options au-delà du plafond.
    if (!userCapAllows(await userKeysInForce(client, userId, nowText), keyText)) throw new ActiveSearchError("user_cap");
    // ADMISSION et PLACES : verrou global (jamais attendu plus de 5 s). La fonction unique d'attribution (places.ts) est appelée AVANT le contrôle, pour qu'il voie l'état réel (places libérées
    // réattribuées, places devenues invalides retirées), puis APRÈS l'écriture de l'achat pour attribuer la place à ce besoin. Une activation d'une clé SANS place est refusée (`capacity`)
    // quand toutes les places sont prises ; une prolongation, ou une clé qui a déjà une place, n'ajoute rien.
    await lockAdmission(client);
    // L'instant des places est lu APRÈS le verrou : il ne précède jamais un achat qu'un autre processus vient de valider.
    const placesNow = await currentInstant(client, input.now);
    const limit = await acceleratedLimit(client, env);
    const before = await reconcileAcceleratedPlaces(client, { now: placesNow, limit, trim: false });
    if (!extension && !capacityAllows({ maxWatches: limit, keys: before.held }, keyText)) throw new ActiveSearchError("capacity");
    const startsAt = coverage.chainEnd !== null ? coverage.chainEnd.endsAtText : nowText;
    const endsAt = await addDays(client, startsAt, ACTIVE_SEARCH_DURATION_DAYS);
    const horizon = await client.query<{ beyond: boolean }>(
      "SELECT ($1::timestamptz > $2::timestamptz + make_interval(days => $3::int)) AS beyond",
      [endsAt, nowText, ACTIVE_SEARCH_MAX_HORIZON_DAYS],
    );
    if (horizon.rows[0].beyond) throw new ActiveSearchError("max_horizon");
    const rank = await client.query<{ next: number }>("SELECT (COALESCE(max(number), 0) + 1)::int AS next FROM active_search_purchases WHERE demand_id = $1::uuid", [demandId]);

    const purchaseId = randomUUID();
    const price = BigInt(ACTIVE_SEARCH_PRICE_XOF);
    if (input.hooks?.beforeDebit) await input.hooks.beforeDebit();
    // Crédits PAYÉS seulement : le sous-compte promotionnel n'est jamais touché (la base le refuse aussi, voir wallet_guard_account_usage).
    const posted = await postWalletTransaction(client, {
      kind: "search_purchase",
      reference: `search_purchase:${purchaseId}`,
      metadata: { activeSearchId: purchaseId },
      entries: [
        { account: { kind: "user", ownerId: userId }, amount: -price },
        { account: { kind: "active_search_revenue" }, amount: price },
      ],
    });
    if (input.hooks?.afterDebit) await input.hooks.afterDebit();
    await client.query(
      `INSERT INTO active_search_purchases (id, user_id, demand_id, number, kind, price_xof, duration_days, starts_at, ends_at, transaction_id, idempotency_key, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6::bigint, $7::int, $8::timestamptz, $9::timestamptz, $10::uuid, $11::uuid, $12::timestamptz)`,
      [purchaseId, userId, demandId, rank.rows[0].next, extension ? "extension" : "activation", price.toString(), ACTIVE_SEARCH_DURATION_DAYS, startsAt, endsAt, posted.id, idempotencyKey, nowText],
    );

    // Suivi des notifications : au moins jusqu'à la fin de l'option (jamais raccourci). Une pause choisie par l'acheteur est conservée.
    await client.query("UPDATE demands SET notify_until = GREATEST(notify_until, $2::timestamptz) WHERE id = $1::uuid", [demandId, endsAt]);

    // Le besoin a maintenant une option en vigueur : sa place (ou son attente) est décidée par la MÊME fonction, sous le même verrou.
    await reconcileAcceleratedPlaces(client, { now: placesNow, limit, trim: false });

    if (!extension) {
      // Nouvelle ACTIVATION : les annonces d'autres sites déjà présentes ne notifieront jamais. Le relevé se fait tout de suite si la surveillance du besoin a une collecte RÉUSSIE de moins de
      // 48 h (au-delà, ses annonces ont toutes cessé d'être visibles : une liste vide serait faussement « complète ») ; sinon il attend la première collecte réussie qui suit.
      const demandRecord = await loadSourceDemand(userId, demandId, client);
      const known = await client.query(
        `SELECT 1 FROM market_watches w JOIN external_collect_runs r ON r.watch_id = w.id AND r.status = 'ok' AND r.finished_at >= $2::timestamptz
          WHERE w.product_key = $1 LIMIT 1`,
        [keyText, new Date(now.getTime() - ACTIVE_SEARCH_FRESH_COLLECTION_MS)],
      );
      if ((known.rowCount ?? 0) > 0) await takeBaseline(client, userId, demandId, now);
      else await markBaselinePending(client, demandId, keyText, demandRecord.contentVersion, nowText);
    }
    const stored = await client.query<{ starts_at: Date; ends_at: Date }>("SELECT starts_at, ends_at FROM active_search_purchases WHERE id = $1::uuid", [purchaseId]);
    return {
      purchaseId, demandId, kind: extension ? "extension" : "activation", reused: false, startsAt: stored.rows[0].starts_at, endsAt: stored.rows[0].ends_at, priceXof: price,
      balance: await readBalance(client, userId),
    };
  }, pool);
}
