import "server-only";

import type { SqlExecutor } from "../postgres/client";
import { productKeyOf, productKeyString } from "../external/product-key";
import { INSTANT_TEXT_SQL } from "../subscriptions/time";
import {
  ACTIVE_SEARCH_ADMISSION_LOCK_KEY, ACTIVE_SEARCH_MAX_ACCELERATED_KEYS_PER_USER, ACTIVE_SEARCH_PLACES_START_TOLERANCE_MS, ACTIVE_SEARCH_USER_LOCK_NAMESPACE,
} from "./config";

/**
 * PLACES de collecte accélérée (lot RA1-ter). Le quota journalier de chaque source ne porte qu'un nombre borné de surveillances accélérées (`acceleratedWatchLimit` : 4 produits avec le
 * quota par défaut). Une « place » est le droit d'UNE clé produit à être surveillée toutes les heures ; la table `active_search_places` (migration 0029) est la SEULE source de vérité des
 * clés accélérées : `syncMarketWatches` n'accélère une surveillance que si sa clé a une place. Cette table n'est écrite QUE par `reconcileAcceleratedPlaces`, ci-dessous.
 *
 * INVARIANT UNIQUE : le nombre de places ne dépasse jamais la capacité des sources, et un utilisateur ne porte jamais plus de `ACTIVE_SEARCH_MAX_ACCELERATED_KEYS_PER_USER` places. Il est maintenu
 * par `reconcileAcceleratedPlaces`, sous le verrou consultatif GLOBAL d'admission (`lockAdmission`), appelée :
 *  - à l'ACHAT (activation) et à la PROLONGATION (purchase.ts) ;
 *  - à la RÉACTIVATION d'un besoin suspendu et à la MODIFICATION d'un besoin, quand sa clé produit change (places-hook.ts, depuis le catalogue) : l'option reste en vigueur mais SANS accélération
 *    quand il n'y a pas de place (« accélération en attente de place ») ;
 *  - à chaque cycle de collecte (collect.ts), qui réattribue les places libérées (option terminée, besoin satisfait ou archivé, clé modifiée) aux options en attente, plus ancien achat d'abord,
 *    et retire les places au-delà de la capacité si les quotas ont baissé.
 *
 * Règles de la fonction, dans l'ordre :
 *  1. une place est VALIDE si son besoin porteur a toujours une option en vigueur, est actif et porte toujours la clé de la place ;
 *  2. une place invalide est TRANSFÉRÉE à une autre option en vigueur de la même clé (plus ancien achat d'abord) dont le propriétaire n'a pas atteint son plafond, sinon libérée ;
 *  3. si `trim` : au-delà de la capacité, les places les plus RÉCENTES sont retirées (les plus anciennes sont gardées : une place attribuée n'est jamais reprise pour une option plus ancienne) ;
 *  4. les options en vigueur d'un besoin ACTIF dont la clé n'a pas de place reçoivent une place, plus ancien achat d'abord, tant qu'il en reste et que leur propriétaire est sous son plafond ;
 *     les autres sont « en attente de place » : leurs notifications restent actives sur la collecte ordinaire. Aucun remboursement automatique.
 * Une place est PAR CLÉ : plusieurs besoins d'une même clé partagent la surveillance, donc la place.
 */

/** Un instant : `Date` (millisecondes) ou texte ISO UTC (microsecondes, tel que l'horloge de la base le donne : une période qui commence « maintenant » est alors en vigueur). */
export type Instant = Date | string;

/** Une option EN VIGUEUR d'un besoin (période courante, non remboursée) avec sa clé produit. */
export interface LiveOption {
  demandId: string;
  userId: string;
  /** `active` ou `satisfied` (option suspendue). */
  demandStatus: string;
  /** Clé produit (texte normalisé). */
  key: string;
  /** Instant du plus ancien achat en vigueur du besoin (ISO UTC à la microseconde : l'ordre lexicographique est l'ordre chronologique). */
  seniority: string;
}

export interface PlaceRow {
  key: string;
  demandId: string;
  userId: string;
  grantedAt: Date;
  grantedAtText: string;
}

interface LiveOptionRow {
  demand_id: string;
  owner_id: string;
  status: string;
  category: string;
  brand: string;
  model: string;
  variant: string | null;
  location_text: string | null;
  seniority: string;
}

/**
 * Options en vigueur à `now` : besoin actif OU satisfait (option suspendue, qui compte pour le plafond), non archivé, propriétaire actif, clé produit complète, jamais le besoin porteur d'une mission
 * (lot MV1). `ownerId` restreint à un utilisateur. Les clés vides sont écartées. Le début d'une période est comparé avec une tolérance de quelques secondes
 * (`ACTIVE_SEARCH_PLACES_START_TOLERANCE_MS`) : un `now` lu avant l'obtention du verrou global ne retire pas la place d'un achat validé entre-temps.
 */
export async function readLiveOptions(executor: SqlExecutor, now: Instant, ownerId: string | null = null): Promise<LiveOption[]> {
  const missions = await executor.query<{ present: boolean }>("SELECT to_regclass('missions') IS NOT NULL AS present");
  const carriers = missions.rows[0]?.present === true ? "AND NOT EXISTS (SELECT 1 FROM missions mc WHERE mc.demand_id = d.id)" : "";
  const rows = await executor.query<LiveOptionRow>(
    `SELECT d.id AS demand_id, d.owner_id, d.status, d.category, d.brand, d.model, d.variant, d.location_text, ${INSTANT_TEXT_SQL("min(p.created_at)")} AS seniority
       FROM demands d
       JOIN users u ON u.id = d.owner_id
       JOIN active_search_purchases p ON p.demand_id = d.id
      WHERE d.status IN ('active', 'satisfied') AND d.archived_at IS NULL AND u.status = 'active' AND u.archived_at IS NULL
        ${carriers}
        AND d.category IS NOT NULL AND d.brand IS NOT NULL AND d.model IS NOT NULL AND ($2::uuid IS NULL OR d.owner_id = $2::uuid)
        AND p.status = 'active' AND p.refunded_at IS NULL AND p.starts_at <= $1::timestamptz + make_interval(secs => $3::int) AND p.ends_at > $1::timestamptz
      GROUP BY d.id, d.owner_id, d.status, d.category, d.brand, d.model, d.variant, d.location_text`,
    [now, ownerId, Math.ceil(ACTIVE_SEARCH_PLACES_START_TOLERANCE_MS / 1000)],
  );
  const options: LiveOption[] = [];
  for (const row of rows.rows) {
    const key = productKeyOf({ category: row.category, brand: row.brand, model: row.model, variant: row.variant, location: row.location_text });
    if (key === null) continue;
    options.push({ demandId: row.demand_id, userId: row.owner_id, demandStatus: row.status, key: productKeyString(key), seniority: row.seniority });
  }
  return options.sort((left, right) => (left.seniority < right.seniority ? -1 : left.seniority > right.seniority ? 1 : left.demandId < right.demandId ? -1 : left.demandId > right.demandId ? 1 : 0));
}

/** Clés produit distinctes des options en vigueur d'un utilisateur (suspendues comprises) : ce que compte le plafond par utilisateur. */
export async function userKeysInForce(executor: SqlExecutor, userId: string, now: Instant): Promise<Set<string>> {
  return new Set((await readLiveOptions(executor, now, userId)).map((option) => option.key));
}

/** Le plafond par utilisateur est-il respecté si l'utilisateur détient aussi `key` ? (L'achat et la prolongation refusent sinon : `user_cap`.) */
export function userCapAllows(keysInForce: ReadonlySet<string>, key: string): boolean {
  const next = new Set(keysInForce);
  next.add(key);
  return next.size <= ACTIVE_SEARCH_MAX_ACCELERATED_KEYS_PER_USER;
}

/** Verrou consultatif GLOBAL d'admission : à prendre APRÈS le verrou de l'utilisateur, la ligne du besoin et ses périodes, AVANT les comptes du grand livre. Libéré à la fin de la transaction. */
export async function lockAdmission(executor: SqlExecutor): Promise<void> {
  await executor.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [ACTIVE_SEARCH_USER_LOCK_NAMESPACE, ACTIVE_SEARCH_ADMISSION_LOCK_KEY]);
}

export async function readPlaces(executor: SqlExecutor, options: { lock?: boolean } = {}): Promise<PlaceRow[]> {
  const result = await executor.query<{ product_key: string; demand_id: string; user_id: string; granted_at: Date; granted_at_text: string }>(
    `SELECT product_key, demand_id, user_id, granted_at, ${INSTANT_TEXT_SQL("granted_at")} AS granted_at_text FROM active_search_places ORDER BY granted_at, product_key${options.lock ? " FOR UPDATE" : ""}`,
  );
  return result.rows.map((row) => ({ key: row.product_key, demandId: row.demand_id, userId: row.user_id, grantedAt: row.granted_at, grantedAtText: row.granted_at_text }));
}

function instantText(now: Instant): string {
  return typeof now === "string" ? now : now.toISOString();
}

export interface ReconcileResult {
  /** Capacité utilisée pour ce passage. */
  limit: number;
  /** Clés qui ont une place à l'issue du passage (triées). */
  held: string[];
  /** Besoins actifs dont l'option est en vigueur mais SANS place (accélération en attente). */
  pendingDemandIds: string[];
  granted: number;
  transferred: number;
  released: number;
  trimmed: number;
}

/**
 * Attribue, transfère et libère les places (voir l'en-tête du module). À appeler DANS une transaction qui tient le verrou global d'admission (`lockAdmission`). `limit` : capacité des sources
 * (nombre de surveillances accélérées portables). `trim` : retire les places au-delà de `limit` (cycle de collecte, qui connaît les vrais connecteurs) ; sans `trim` une capacité plus basse
 * que le nombre de places n'ajoute jamais de place mais n'en retire pas (changement de besoin, achat : l'environnement de l'appelant ne fait pas autorité sur les quotas). `dryRun` : calcule sans rien
 * écrire ni verrouiller (le cycle de collecte s'en sert pour ne prendre ni connexion dédiée ni verrou global quand il n'y a rien à faire).
 */
export async function reconcileAcceleratedPlaces(executor: SqlExecutor, input: { now: Instant; limit: number; trim: boolean; dryRun?: boolean }): Promise<ReconcileResult> {
  const limit = Math.max(0, Math.floor(input.limit));
  const all = await readLiveOptions(executor, input.now);
  const options = all.filter((option) => option.demandStatus === "active");
  const places = await readPlaces(executor, { lock: input.dryRun !== true });
  const result: ReconcileResult = { limit, held: [], pendingDemandIds: [], granted: 0, transferred: 0, released: 0, trimmed: 0 };

  const perUser = new Map<string, number>();
  const bump = (userId: string, delta: number) => perUser.set(userId, (perUser.get(userId) ?? 0) + delta);
  const kept = new Map<string, { demandId: string; userId: string; grantedAt: string }>();
  const invalid: PlaceRow[] = [];
  for (const place of places) {
    const holder = options.find((option) => option.demandId === place.demandId && option.key === place.key);
    if (holder && holder.userId === place.userId) {
      kept.set(place.key, { demandId: place.demandId, userId: place.userId, grantedAt: place.grantedAtText });
      bump(place.userId, 1);
    } else invalid.push(place);
  }

  const toDelete: string[] = [];
  const toTransfer: Array<{ key: string; demandId: string; userId: string }> = [];
  for (const place of invalid) {
    const successor = options.find((option) => option.key === place.key && (perUser.get(option.userId) ?? 0) < ACTIVE_SEARCH_MAX_ACCELERATED_KEYS_PER_USER);
    if (successor) {
      toTransfer.push({ key: place.key, demandId: successor.demandId, userId: successor.userId });
      kept.set(place.key, { demandId: successor.demandId, userId: successor.userId, grantedAt: place.grantedAtText });
      bump(successor.userId, 1);
    } else toDelete.push(place.key);
  }

  if (input.trim && kept.size > limit) {
    // Les plus récentes d'abord : une place déjà attribuée n'est jamais reprise pour une option plus ancienne arrivée après.
    const newest = [...kept.entries()].sort(([leftKey, left], [rightKey, right]) => (left.grantedAt < right.grantedAt ? 1 : left.grantedAt > right.grantedAt ? -1 : leftKey < rightKey ? 1 : -1));
    for (const [key, holder] of newest) {
      if (kept.size <= limit) break;
      kept.delete(key);
      bump(holder.userId, -1);
      if (toTransfer.some((transfer) => transfer.key === key)) toTransfer.splice(toTransfer.findIndex((transfer) => transfer.key === key), 1);
      toDelete.push(key);
      result.trimmed += 1;
    }
  }

  const toGrant: Array<{ key: string; demandId: string; userId: string }> = [];
  for (const option of options) {
    if (kept.has(option.key)) continue;
    if (kept.size >= limit) break;
    if ((perUser.get(option.userId) ?? 0) >= ACTIVE_SEARCH_MAX_ACCELERATED_KEYS_PER_USER) continue;
    kept.set(option.key, { demandId: option.demandId, userId: option.userId, grantedAt: instantText(input.now) });
    bump(option.userId, 1);
    toGrant.push({ key: option.key, demandId: option.demandId, userId: option.userId });
  }

  // Écritures : retraits, transferts, attributions (une instruction chacune, sous le verrou global). Un essai à blanc (`dryRun`, sur un simple pool, sans verrou) ne fait que calculer ce qui serait fait.
  const existing = new Set(places.map((place) => place.key));
  const removed = toDelete.filter((key) => existing.has(key));
  if (input.dryRun === true) {
    result.granted = toGrant.length;
    result.transferred = toTransfer.length;
    result.released = removed.length - result.trimmed;
    result.held = [...kept.keys()].sort();
    result.pendingDemandIds = options.filter((option) => !kept.has(option.key)).map((option) => option.demandId);
    return result;
  }
  if (removed.length > 0) await executor.query("DELETE FROM active_search_places WHERE product_key = ANY($1::text[])", [removed]);
  for (const transfer of toTransfer) {
    await executor.query("UPDATE active_search_places SET demand_id = $2::uuid, user_id = $3::uuid WHERE product_key = $1", [transfer.key, transfer.demandId, transfer.userId]);
  }
  for (const grant of toGrant) {
    await executor.query("INSERT INTO active_search_places (product_key, demand_id, user_id, granted_at) VALUES ($1, $2::uuid, $3::uuid, $4::timestamptz)", [grant.key, grant.demandId, grant.userId, instantText(input.now)]);
  }

  result.granted = toGrant.length;
  result.transferred = toTransfer.length;
  result.released = removed.length - result.trimmed;
  result.held = [...kept.keys()].sort();
  result.pendingDemandIds = options.filter((option) => !kept.has(option.key)).map((option) => option.demandId);
  return result;
}
