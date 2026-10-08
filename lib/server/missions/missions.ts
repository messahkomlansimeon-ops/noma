import "server-only";

import type { Pool, PoolClient } from "pg";
import { archiveDemand, createDemand } from "../catalog/demands";
import { CatalogValidationError } from "../catalog/errors";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction } from "../postgres/client";
import {
  MISSION_ACTIVE_LIMIT,
  MISSION_CREATIONS_PER_DAY,
  checkMissionInput,
  checkMissionPatch,
  missionProductLabel,
  missionTitle,
  type MissionAction,
  type MissionInput,
  type MissionStatus,
} from "../../missions-rules";
import { MISSIONS_LIST_LIMIT, MISSIONS_OPEN_LIMIT, MISSION_ORDERS_LIMIT, MISSION_OWNER_LOCK_NAMESPACE, MISSION_TRANSACTION_TIMEOUT } from "./config";
import { MissionError } from "./errors";

/**
 * Missions d'achat en volume (lot MV1) : création, brouillon, activation, pause, reprise, annulation, lecture. Voir MISSIONS.md.
 *  - une mission naît BROUILLON (modifiable) ; l'activer crée (ou, à la reprise après une pause, garde) son besoin PORTEUR, un besoin ordinaire du matching SANS budget ni
 *    quantité : le vendeur d'une annonce qui correspond le voit comme tous les autres, jamais le budget de la mission ;
 *  - plafonds EXACTS sous concurrence (verrou consultatif par acheteur) : 5 missions actives et 20 créations par jour UTC ;
 *  - propriétaire seulement : pour tout autre acheteur, `resource_not_found` (404 indiscernable) ;
 *  - annuler une mission ouverte annule ses commandes encore « proposées » (l'acheteur le décide en annulant) ; son besoin porteur (comme celui d'une mission terminée ou échue) est archivé 24 h
 *    plus tard par l'étape du runner (`MISSION_CARRIER_RELEASE_DELAY`) ; rien d'autre n'est automatique :
 *    aucun message, aucune commande n'est jamais créé par une mission.
 */

export interface MissionRecord {
  id: string;
  ownerId: string;
  status: MissionStatus;
  category: string;
  brand: string;
  model: string;
  variant: string | null;
  condition: string;
  quantity: number;
  unit: string;
  unitBudgetXof: number;
  totalBudgetXof: number;
  location: string | null;
  deadlineDays: number;
  deadlineAt: Date | null;
  demandId: string | null;
  activatedAt: Date | null;
  closedAt: Date | null;
  coveredQuantity: number | null;
  evaluatedAt: Date | null;
  notifiedQuantity: number | null;
  notifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MissionRow {
  id: string;
  owner_id: string;
  status: MissionStatus;
  category: string;
  brand: string;
  model: string;
  variant: string | null;
  condition_text: string;
  quantity_total: number;
  unit: string;
  unit_budget_xof: string;
  total_budget_xof: string;
  location_text: string | null;
  deadline_days: number;
  deadline_at: Date | null;
  demand_id: string | null;
  activated_at: Date | null;
  closed_at: Date | null;
  covered_quantity: number | null;
  evaluated_at: Date | null;
  notified_quantity: number | null;
  notified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMN_LIST = [
  "id", "owner_id", "status", "category", "brand", "model", "variant", "condition_text", "quantity_total", "unit",
  "unit_budget_xof::text AS unit_budget_xof", "total_budget_xof::text AS total_budget_xof", "location_text", "deadline_days", "deadline_at", "demand_id",
  "activated_at", "closed_at", "covered_quantity", "evaluated_at", "notified_quantity", "notified_at", "created_at", "updated_at",
] as const;

/** Colonnes d'une mission (sans alias de table). */
export const MISSION_COLUMNS = COLUMN_LIST.join(", ");

export function mapMission(row: MissionRow): MissionRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    status: row.status,
    category: row.category,
    brand: row.brand,
    model: row.model,
    variant: row.variant,
    condition: row.condition_text,
    quantity: row.quantity_total,
    unit: row.unit,
    unitBudgetXof: Number(row.unit_budget_xof),
    totalBudgetXof: Number(row.total_budget_xof),
    location: row.location_text,
    deadlineDays: row.deadline_days,
    deadlineAt: row.deadline_at,
    demandId: row.demand_id,
    activatedAt: row.activated_at,
    closedAt: row.closed_at,
    coveredQuantity: row.covered_quantity,
    evaluatedAt: row.evaluated_at,
    notifiedQuantity: row.notified_quantity,
    notifiedAt: row.notified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Le contenu d'une mission, sous la forme du formulaire. */
export function missionInputOf(mission: MissionRecord): MissionInput {
  return {
    category: mission.category,
    brand: mission.brand,
    model: mission.model,
    variant: mission.variant,
    condition: mission.condition,
    quantity: mission.quantity,
    unit: mission.unit,
    unitBudgetXof: mission.unitBudgetXof,
    totalBudgetXof: mission.totalBudgetXof,
    location: mission.location,
    deadlineDays: mission.deadlineDays,
  };
}

/** Une mission, ses achats (quantités par état) et ce que le propriétaire peut en faire. */
export interface MissionView extends MissionRecord {
  title: string;
  /** Quantité SÉCURISÉE : somme des commandes CONFIRMÉES rattachées à la mission. */
  securedQuantity: number;
  /** Quantité des commandes encore proposées (en attente du vendeur). */
  pendingQuantity: number;
  /** Montant engagé (commandes proposées ou confirmées) : Σ prix convenu × quantité. */
  committedXof: number;
  actions: { canEdit: boolean; canActivate: boolean; canPause: boolean; canResume: boolean; canCancel: boolean };
}

export interface MissionOrderItem {
  id: string;
  status: "proposed" | "confirmed" | "declined" | "cancelled";
  quantity: number;
  unitPriceXof: number;
  offerId: string;
  title: string;
  createdAt: Date;
}

interface ViewRow extends MissionRow {
  secured: number;
  pending: number;
  committed: string;
}

const VIEW_SELECT = `SELECT ${COLUMN_LIST.map((column) => `m.${column}`).join(", ")},
       coalesce((SELECT sum(o.quantity) FROM orders o WHERE o.mission_id = m.id AND o.status = 'confirmed'), 0)::int AS secured,
       coalesce((SELECT sum(o.quantity) FROM orders o WHERE o.mission_id = m.id AND o.status = 'proposed'), 0)::int AS pending,
       coalesce((SELECT sum(o.quantity * o.price_amount) FROM orders o WHERE o.mission_id = m.id AND o.status IN ('proposed', 'confirmed')), 0)::text AS committed
  FROM missions m`;

export function toView(row: ViewRow): MissionView {
  const mission = mapMission(row);
  return {
    ...mission,
    title: missionTitle(mission),
    securedQuantity: row.secured,
    pendingQuantity: row.pending,
    committedXof: Number(row.committed),
    actions: {
      canEdit: mission.status === "draft",
      canActivate: mission.status === "draft",
      canPause: mission.status === "active",
      canResume: mission.status === "paused",
      canCancel: mission.status === "draft" || mission.status === "active" || mission.status === "paused",
    },
  };
}

function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

async function lockOwner(client: PoolClient, ownerId: string): Promise<void> {
  await client.query(`SET LOCAL statement_timeout = '${MISSION_TRANSACTION_TIMEOUT}'`);
  await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [MISSION_OWNER_LOCK_NAMESPACE, ownerId]);
}

async function lockMission(client: PoolClient, missionId: string, ownerId: string): Promise<MissionRecord> {
  const result = await client.query<MissionRow>(`SELECT ${MISSION_COLUMNS} FROM missions WHERE id = $1::uuid AND owner_id = $2::uuid FOR UPDATE`, [missionId, ownerId]);
  if (!result.rows[0]) throw new MissionError("resource_not_found");
  return mapMission(result.rows[0]);
}

async function assertActiveCapacity(client: PoolClient, ownerId: string): Promise<void> {
  const active = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM missions WHERE owner_id = $1::uuid AND status = 'active'", [ownerId]);
  if (active.rows[0].n >= MISSION_ACTIVE_LIMIT) throw new MissionError("mission_active_limit");
}

/** Le besoin porteur : un besoin ordinaire, actif, sans budget ni quantité (le budget de la mission n'est jamais lisible par un vendeur) et SANS notification d'annonce (suivi en pause). */
async function createCarrierDemand(client: PoolClient, mission: MissionRecord): Promise<string> {
  const demand = await createDemand(
    {
      ownerId: mission.ownerId,
      rawText: `Mission d'achat en volume : ${missionTitle(mission)}`,
      category: mission.category,
      brand: mission.brand,
      model: mission.model,
      variant: mission.variant,
      condition: mission.condition,
      location: mission.location,
      status: "active",
    },
    client,
  );
  // Les nouvelles annonces sont signalées par la mission (une notification par jour au plus), pas annonce par annonce.
  await client.query("UPDATE demands SET notify_paused = TRUE WHERE id = $1::uuid", [demand.id]);
  return demand.id;
}

/** Archive le besoin porteur d'une mission close (24 h après sa fin, par l'étape du runner) : le matching s'arrête (le garde-fou de la base laisse faire : la mission n'est plus ouverte). */
export async function archiveCarrierDemand(client: PoolClient, ownerId: string, demandId: string): Promise<void> {
  const current = await client.query<{ content_version: number; status: string }>("SELECT content_version, status FROM demands WHERE id = $1::uuid FOR UPDATE", [demandId]);
  const row = current.rows[0];
  if (!row || row.status === "archived") return;
  await archiveDemand(ownerId, demandId, row.content_version, client);
}

/**
 * Clôture une mission OUVERTE (terminée, annulée ou échue). Le besoin porteur n'est PAS archivé à cet instant : il l'est 24 h plus tard par l'étape « missions » du runner
 * (`MISSION_CARRIER_RELEASE_DELAY`), pour qu'un vendeur dont la confirmation termine la mission ne le devine pas en voyant le besoin disparaître de ses correspondances.
 * Une mission qui n'est plus ouverte est laissée telle quelle (idempotent) : renvoie faux.
 */
export async function closeOpenMission(client: PoolClient, mission: { id: string; ownerId: string; demandId: string | null }, status: "completed" | "cancelled" | "expired"): Promise<boolean> {
  const closed = await client.query(
    `UPDATE missions SET status = $2, closed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = $1::uuid AND status IN ('active', 'paused')`,
    [mission.id, status],
  );
  if (!closed.rowCount) return false;
  if (status === "cancelled") {
    // Annuler la mission annule les achats que les vendeurs n'ont pas encore décidés (une décision de l'acheteur, prise en annulant).
    await client.query(
      "UPDATE orders SET status = 'cancelled', decided_at = clock_timestamp(), updated_at = clock_timestamp() WHERE mission_id = $1::uuid AND status = 'proposed'",
      [mission.id],
    );
  }
  return true;
}

async function activateLocked(client: PoolClient, mission: MissionRecord): Promise<MissionRecord> {
  await assertActiveCapacity(client, mission.ownerId);
  const demandId = await createCarrierDemand(client, mission);
  const updated = await client.query<MissionRow>(
    `UPDATE missions SET status = 'active', demand_id = $2::uuid, activated_at = clock_timestamp(),
            deadline_at = clock_timestamp() + make_interval(days => deadline_days), updated_at = clock_timestamp()
      WHERE id = $1::uuid AND status = 'draft' RETURNING ${MISSION_COLUMNS}`,
    [mission.id, demandId],
  );
  return mapMission(updated.rows[0]);
}

async function readViewIn(client: PoolClient, missionId: string): Promise<MissionView> {
  const result = await client.query<ViewRow>(`${VIEW_SELECT} WHERE m.id = $1::uuid`, [missionId]);
  return toView(result.rows[0]);
}

// ───────────── création ─────────────

/**
 * Crée une mission en BROUILLON (ou, avec `activate`, la crée et l'active dans la même transaction : un refus de l'activation, par exemple 5 missions déjà actives,
 * annule aussi la création). Au plus 20 créations par jour UTC et par acheteur ; au plus 5 missions actives.
 */
export async function createMission(input: { pool: Pool; ownerId: string; mission: unknown; activate?: boolean }): Promise<MissionView> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const checked = checkMissionInput(input.mission);
  if (!checked.ok) throw new MissionError(checked.code, { field: checked.field });
  const value = checked.value;
  return withPostgresTransaction(async (client) => {
    await lockOwner(client, ownerId);
    const today = await client.query<{ n: number; now: Date }>(
      `SELECT count(*)::int AS n, clock_timestamp() AS now FROM missions
        WHERE owner_id = $1::uuid AND created_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
      [ownerId],
    );
    if (today.rows[0].n >= MISSION_CREATIONS_PER_DAY) throw new MissionError("mission_daily_limit", { retryAfterSeconds: secondsUntilNextUtcDay(today.rows[0].now) });
    const inserted = await client.query<MissionRow>(
      `INSERT INTO missions (owner_id, category, brand, model, variant, condition_text, quantity_total, unit, unit_budget_xof, total_budget_xof, location_text, deadline_days)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::int, $8, $9::bigint, $10::bigint, $11, $12::int) RETURNING ${MISSION_COLUMNS}`,
      [ownerId, value.category, value.brand, value.model, value.variant, value.condition, value.quantity, value.unit, value.unitBudgetXof, value.totalBudgetXof, value.location, value.deadlineDays],
    );
    let mission = mapMission(inserted.rows[0]);
    if (input.activate === true) mission = await activateLocked(client, mission);
    return readViewIn(client, mission.id);
  }, pool);
}

// ───────────── lecture ─────────────

export interface MissionsPage {
  missions: MissionView[];
  /** Curseur opaque de la page suivante, ou null si la liste est épuisée. */
  nextCursor: string | null;
}

const OPEN_STATUSES_SQL = "('draft', 'active', 'paused')";
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type MissionsCursorGroup = "open" | "closed";

/** Curseur opaque de « Mes missions » : le groupe (ouvertes avant closes), l'instant de création à la microseconde et l'identifiant de la dernière mission servie. */
export function encodeMissionsCursor(group: MissionsCursorGroup, createdAt: string, id: string): string {
  return Buffer.from(`${group === "open" ? 0 : 1}|${createdAt}|${id}`, "utf8").toString("base64url");
}

export function decodeMissionsCursor(cursor: unknown): { group: MissionsCursorGroup; createdAt: string; id: string } {
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,140}$/.test(cursor)) throw new CatalogValidationError("cursor invalide.");
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (parts.length !== 3 || (parts[0] !== "0" && parts[0] !== "1") || !CURSOR_AT.test(parts[1]) || !UUID_LOWER.test(parts[2])) throw new CatalogValidationError("cursor invalide.");
  const group: MissionsCursorGroup = parts[0] === "0" ? "open" : "closed";
  if (encodeMissionsCursor(group, parts[1], parts[2]) !== cursor || Number.isNaN(new Date(parts[1]).getTime())) throw new CatalogValidationError("cursor invalide.");
  return { group, createdAt: parts[1], id: parts[2] };
}

/**
 * « Mes missions » : TOUTES les missions OUVERTES (brouillons, actives, en pause) d'abord, TOUJOURS — dans la première réponse, jusqu'à `MISSIONS_OPEN_LIMIT` (200) ; au-delà, par pages
 * de 200 avec le curseur — puis les closes (terminées, annulées, échues) par pages de 50 avec un curseur (instant à la microseconde + identifiant), les plus récentes d'abord dans chaque
 * groupe. Une mission ouverte n'est donc jamais repoussée hors de la liste par des missions plus récentes (ni closes, ni brouillons récents tant qu'il y en a moins de 200).
 */
export async function listMissions(input: { pool: Pool; ownerId: string; cursor?: string | null }): Promise<MissionsPage> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const cursor = input.cursor === undefined || input.cursor === null ? null : decodeMissionsCursor(input.cursor);
  const select = `${VIEW_SELECT.replace("FROM missions m", `, to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM missions m`)}`;
  const group = (open: boolean, after: { createdAt: string; id: string } | null, limit: number) =>
    pool.query<ViewRow & { cursor_at: string }>(
      `${select} WHERE m.owner_id = $1::uuid AND m.status ${open ? "IN" : "NOT IN"} ${OPEN_STATUSES_SQL}
          AND ($2::timestamptz IS NULL OR (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
        ORDER BY m.created_at DESC, m.id DESC LIMIT $4::int`,
      [ownerId, after?.createdAt ?? null, after?.id ?? null, limit],
    );
  const next = (row: ViewRow & { cursor_at: string }, groupName: MissionsCursorGroup): string => encodeMissionsCursor(groupName, row.cursor_at, row.id);
  let opened: Array<ViewRow & { cursor_at: string }> = [];
  if (cursor === null || cursor.group === "open") {
    const read = (await group(true, cursor, MISSIONS_OPEN_LIMIT + 1)).rows;
    opened = read.slice(0, MISSIONS_OPEN_LIMIT);
    // Plus de 200 missions ouvertes : la page n'est faite que d'ouvertes ; les suivantes viennent avec le curseur.
    if (read.length > MISSIONS_OPEN_LIMIT) return { missions: opened.map(toView), nextCursor: next(opened[opened.length - 1], "open") };
  }
  // Les ouvertes sont épuisées : la page se complète avec une page de closes, depuis la plus récente (ou depuis le curseur des closes).
  const read = (await group(false, cursor?.group === "closed" ? cursor : null, MISSIONS_LIST_LIMIT + 1)).rows;
  const closed = read.slice(0, MISSIONS_LIST_LIMIT);
  return {
    missions: [...opened, ...closed].map(toView),
    nextCursor: read.length > MISSIONS_LIST_LIMIT ? next(closed[closed.length - 1], "closed") : null,
  };
}

/** Une mission du propriétaire ; `resource_not_found` pour toute autre personne ou une mission inconnue. */
export async function readMission(input: { pool: Pool; ownerId: string; missionId: string }): Promise<MissionView> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const missionId = requireUuid(input.missionId, "missionId").toLowerCase();
  const rows = await pool.query<ViewRow>(`${VIEW_SELECT} WHERE m.id = $1::uuid AND m.owner_id = $2::uuid`, [missionId, ownerId]);
  if (!rows.rows[0]) throw new MissionError("resource_not_found");
  return toView(rows.rows[0]);
}

/** Les achats rattachés à la mission (les plus récents d'abord), pour le propriétaire seulement. */
export async function listMissionOrders(input: { pool: Pool; ownerId: string; missionId: string }): Promise<MissionOrderItem[]> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const missionId = requireUuid(input.missionId, "missionId").toLowerCase();
  const rows = await pool.query<{ id: string; status: MissionOrderItem["status"]; quantity: number; price_amount: string; offer_id: string; created_at: Date; brand: string | null; model: string | null; variant: string | null }>(
    `SELECT r.id, r.status, r.quantity, r.price_amount::text AS price_amount, r.offer_id, r.created_at, o.brand, o.model, o.variant
       FROM orders r JOIN offers o ON o.id = r.offer_id JOIN missions m ON m.id = r.mission_id
      WHERE r.mission_id = $1::uuid AND m.owner_id = $2::uuid AND r.buyer_id = $2::uuid
      ORDER BY r.created_at DESC, r.id DESC LIMIT $3::int`,
    [missionId, ownerId, MISSION_ORDERS_LIMIT],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    status: row.status,
    quantity: row.quantity,
    unitPriceXof: Number(row.price_amount),
    offerId: row.offer_id,
    title: missionProductLabel({ brand: row.brand ?? "", model: row.model ?? "", variant: row.variant }).trim() || "Annonce",
    createdAt: row.created_at,
  }));
}

// ───────────── brouillon ─────────────

/** Modifie un BROUILLON (au moins un champ) ; une mission déjà lancée ne se modifie plus (`mission_not_draft`). */
export async function updateDraftMission(input: { pool: Pool; ownerId: string; missionId: string; patch: unknown }): Promise<MissionView> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const missionId = requireUuid(input.missionId, "missionId").toLowerCase();
  const patch = checkMissionPatch(input.patch);
  if (!patch.ok) throw new MissionError(patch.code, { field: patch.field });
  return withPostgresTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = '${MISSION_TRANSACTION_TIMEOUT}'`);
    const mission = await lockMission(client, missionId, ownerId);
    if (mission.status !== "draft") throw new MissionError("mission_not_draft");
    const merged = checkMissionInput({ ...missionInputOf(mission), ...patch.patch });
    if (!merged.ok) throw new MissionError(merged.code, { field: merged.field });
    const value = merged.value;
    await client.query(
      `UPDATE missions SET category = $2, brand = $3, model = $4, variant = $5, condition_text = $6, quantity_total = $7::int, unit = $8,
              unit_budget_xof = $9::bigint, total_budget_xof = $10::bigint, location_text = $11, deadline_days = $12::int, updated_at = clock_timestamp()
        WHERE id = $1::uuid`,
      [missionId, value.category, value.brand, value.model, value.variant, value.condition, value.quantity, value.unit, value.unitBudgetXof, value.totalBudgetXof, value.location, value.deadlineDays],
    );
    return readViewIn(client, missionId);
  }, pool);
}

// ───────────── actions ─────────────

/**
 * Lance (`activate`, depuis un brouillon), met en pause (`pause`), reprend (`resume`) ou annule (`cancel`) une mission du propriétaire. Un refus de transition est
 * `mission_state_conflict` ; 5 missions actives déjà : `mission_active_limit` (à l'activation comme à la reprise).
 */
export async function transitionMission(input: { pool: Pool; ownerId: string; missionId: string; action: MissionAction }): Promise<MissionView> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const missionId = requireUuid(input.missionId, "missionId").toLowerCase();
  return withPostgresTransaction(async (client) => {
    await lockOwner(client, ownerId);
    const mission = await lockMission(client, missionId, ownerId);
    switch (input.action) {
      case "activate":
        if (mission.status !== "draft") throw new MissionError("mission_state_conflict");
        await activateLocked(client, mission);
        break;
      case "pause": {
        if (mission.status !== "active") throw new MissionError("mission_state_conflict");
        const open = await client.query("SELECT 1 FROM missions WHERE id = $1::uuid AND deadline_at > clock_timestamp()", [missionId]);
        // Une mission dont l'échéance est passée ne se met plus en pause : l'étape du runner la marque échue (ou terminée).
        if (!open.rowCount) throw new MissionError("mission_state_conflict");
        await client.query("UPDATE missions SET status = 'paused', updated_at = clock_timestamp() WHERE id = $1::uuid", [missionId]);
        break;
      }
      case "resume": {
        if (mission.status !== "paused") throw new MissionError("mission_state_conflict");
        const open = await client.query("SELECT 1 FROM missions WHERE id = $1::uuid AND deadline_at > clock_timestamp()", [missionId]);
        // Une mission dont l'échéance est passée ne reprend pas : l'étape du runner la marque échue.
        if (!open.rowCount) throw new MissionError("mission_state_conflict");
        await assertActiveCapacity(client, ownerId);
        await client.query("UPDATE missions SET status = 'active', updated_at = clock_timestamp() WHERE id = $1::uuid", [missionId]);
        break;
      }
      case "cancel":
        if (mission.status === "draft") {
          await client.query("UPDATE missions SET status = 'cancelled', closed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1::uuid", [missionId]);
        } else if (!(await closeOpenMission(client, mission, "cancelled"))) {
          throw new MissionError("mission_state_conflict");
        }
        break;
      default:
        throw new MissionError("mission_state_conflict");
    }
    return readViewIn(client, missionId);
  }, pool);
}
