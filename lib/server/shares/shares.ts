import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction } from "../postgres/client";
import { SHARE_DAILY_LIMIT, SHARE_TOKEN_PATTERN, publicNeedView, type PublicNeed } from "../../shares-rules";

/**
 * Lien de partage d'un besoin (lot FIN3-C4). Voir PARTAGE.md.
 *  - Le jeton (128 bits, base64url) n'est montré qu'à la création ; seule son EMPREINTE (SHA-256) est stockée. Un jeton à 128 bits aléatoires n'a pas besoin d'un secret serveur : il ne se devine pas.
 *  - Un lien actif par besoin : en créer un révoque le précédent (même transaction). 10 créations par jour UTC et par compte (exact : verrou consultatif).
 *  - Réservé au propriétaire d'un besoin ACTIF qui n'est pas le besoin porteur d'une mission ; sinon `not_found` (404 indiscernable).
 *  - LECTURE PUBLIQUE : un jeton inconnu, révoqué, d'un besoin plus actif ou d'un compte plus actif donne le MÊME `null` (aucun oracle).
 */

export type ShareErrorCode = "not_found" | "daily_limit";

export class ShareError extends Error {
  readonly code: ShareErrorCode;
  constructor(code: ShareErrorCode) {
    super(code);
    this.name = "ShareError";
    this.code = code;
  }
}

export const SHARE_ERROR_MESSAGES: Readonly<Record<ShareErrorCode, string>> = Object.freeze({
  not_found: "Ressource introuvable.",
  daily_limit: "Vous avez créé le nombre de liens autorisés aujourd'hui. Réessayez demain.",
});

export const hashShareToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
export const newShareToken = (): string => randomBytes(16).toString("base64url");

/** Le besoin appartient au compte, est actif et n'est pas le besoin porteur d'une mission d'achat en volume. */
const SHAREABLE = `d.id = $1::uuid AND d.owner_id = $2::uuid AND d.status = 'active' AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.demand_id = d.id)`;

export interface ShareStatus {
  active: boolean;
  createdAt: Date | null;
}

export async function createShareLink(input: { pool: Pool; ownerId: string; demandId: string }): Promise<{ token: string; createdAt: Date }> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  return withPostgresTransaction(async (client) => {
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`share:${ownerId}`]);
    const found = await client.query(`SELECT 1 FROM demands d WHERE ${SHAREABLE}`, [demandId, ownerId]);
    if (!found.rowCount) throw new ShareError("not_found");
    const today = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM demand_share_links WHERE owner_id = $1::uuid AND created_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
      [ownerId],
    );
    if (today.rows[0].n >= SHARE_DAILY_LIMIT) throw new ShareError("daily_limit");
    await client.query("UPDATE demand_share_links SET revoked_at = clock_timestamp() WHERE demand_id = $1::uuid AND revoked_at IS NULL", [demandId]);
    const token = newShareToken();
    const inserted = await client.query<{ created_at: Date }>(
      "INSERT INTO demand_share_links (demand_id, owner_id, token_hash) VALUES ($1::uuid, $2::uuid, $3::text) RETURNING created_at",
      [demandId, ownerId, hashShareToken(token)],
    );
    return { token, createdAt: inserted.rows[0].created_at };
  }, pool);
}

/** L'état du lien d'un besoin pour son propriétaire (le jeton n'est pas relisible : seule l'empreinte existe). */
export async function readShareStatus(input: { pool: Pool; ownerId: string; demandId: string }): Promise<ShareStatus> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  const owned = await pool.query("SELECT 1 FROM demands d WHERE d.id = $1::uuid AND d.owner_id = $2::uuid", [demandId, ownerId]);
  if (!owned.rowCount) throw new ShareError("not_found");
  const active = await pool.query<{ created_at: Date }>("SELECT created_at FROM demand_share_links WHERE demand_id = $1::uuid AND revoked_at IS NULL", [demandId]);
  return { active: active.rowCount === 1, createdAt: active.rows[0]?.created_at ?? null };
}

/** Révoque le lien actif d'un besoin. Rejoué : sans effet. */
export async function revokeShareLink(input: { pool: Pool; ownerId: string; demandId: string }): Promise<{ revoked: boolean }> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  const owned = await pool.query("SELECT 1 FROM demands d WHERE d.id = $1::uuid AND d.owner_id = $2::uuid", [demandId, ownerId]);
  if (!owned.rowCount) throw new ShareError("not_found");
  const revoked = await pool.query("UPDATE demand_share_links SET revoked_at = clock_timestamp() WHERE demand_id = $1::uuid AND revoked_at IS NULL", [demandId]);
  return { revoked: (revoked.rowCount ?? 0) > 0 };
}

interface NeedRow {
  category: string | null; brand: string | null; model: string | null; variant: string | null; condition_text: string | null; quantity: number | null; unit: string | null;
  location_text: string | null; budget_amount: string | null; budget_currency: string | null;
}

/** La lecture PUBLIQUE : null si le jeton n'a pas la bonne forme, est inconnu, révoqué, ou si le besoin ou le compte n'est plus actif (le même null : aucun oracle). */
export async function readSharedNeed(input: { pool: Pool; token: string }): Promise<PublicNeed | null> {
  if (!SHARE_TOKEN_PATTERN.test(input.token)) return null;
  const pool = requireTransactionPool(input.pool);
  const found = await pool.query<NeedRow>(
    `SELECT d.category, d.brand, d.model, d.variant, d.condition_text, d.quantity, d.unit, d.location_text, d.budget_amount::text AS budget_amount, d.budget_currency
       FROM demand_share_links l
       JOIN demands d ON d.id = l.demand_id
       JOIN users u ON u.id = d.owner_id
      WHERE l.token_hash = $1::text AND l.revoked_at IS NULL AND d.status = 'active' AND u.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.demand_id = d.id)`,
    [hashShareToken(input.token)],
  );
  const row = found.rows[0];
  if (!row) return null;
  return publicNeedView({ ...row, budget_amount: row.budget_amount === null ? null : Number(row.budget_amount) });
}
