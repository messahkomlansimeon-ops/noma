import "server-only";

import type { Pool } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { withPostgresTransaction } from "../postgres/client";
import { readOfferAccess } from "../metrics/contacts";
import { applyUserStatusInTransaction } from "../admin/actions";
import { MASKED_PHONE_SQL } from "../admin/reads";
import { REPORTS_DAILY_LIMIT, type ReportDecision, type ReportInput, type ReportReason, type ReportStatus, type ReportTargetType } from "../../reports-rules";

/**
 * Signalements d'annonces et de commandes, et dossiers de modération (lot FIN3-C2). Voir SIGNALEMENTS.md.
 *  - ÉCRITURE : le compte doit avoir ACCÈS à la cible : une annonce qu'il a parmi les correspondances confirmées de son besoin (même prédicat que la fiche, la messagerie, les favoris :
 *    `readOfferAccess`), ou une commande dont il est une des deux parties. Sinon : `not_found` (404 indiscernable). L'autre partie (vendeur de l'annonce, ou autre partie de la commande) est
 *    figée comme compte signalé.
 *  - Un seul signalement OUVERT par auteur et par cible ; au plus `REPORTS_DAILY_LIMIT` par jour UTC ; les deux sont exacts sous concurrence (verrou consultatif par auteur).
 *  - DÉCISION (administrateur) : `dismissed` ou `seller_suspended`, avec un motif obligatoire ; la suspension passe par le chemin existant (`updateUser` + journal `admin_actions`) DANS LA MÊME
 *    transaction que la clôture : si la suspension est refusée (compte administrateur, archivé), le dossier reste ouvert.
 */

export type ReportErrorCode = "not_found" | "already_reported" | "daily_limit" | "already_decided";

export class ReportError extends Error {
  readonly code: ReportErrorCode;
  constructor(code: ReportErrorCode) {
    super(code);
    this.name = "ReportError";
    this.code = code;
  }
}

export const REPORT_ERROR_MESSAGES: Readonly<Record<ReportErrorCode, string>> = Object.freeze({
  not_found: "Ressource introuvable.",
  already_reported: "Vous avez déjà signalé cet élément : le signalement est en cours de traitement.",
  daily_limit: "Vous avez atteint le nombre de signalements autorisés aujourd'hui. Réessayez demain.",
  already_decided: "Ce dossier est déjà clos.",
});

const TITLE_SQL = (prefix: string): string =>
  `coalesce(nullif(btrim(concat_ws(' ', ${prefix}.brand, ${prefix}.model, ${prefix}.variant)), ''), left(${prefix}.raw_text, 80))`;

export interface CreatedReport {
  id: string;
  status: "open";
  createdAt: Date;
}

export async function createReport(input: { pool: Pool; reporterId: string; report: ReportInput }): Promise<CreatedReport> {
  const pool = requireTransactionPool(input.pool);
  const reporterId = requireUuid(input.reporterId, "reporterId").toLowerCase();
  const report = input.report;
  return withPostgresTransaction(async (client) => {
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`report:${reporterId}`]);
    let reportedUserId: string;
    let offerId: string | null = null;
    let orderId: string | null = null;
    let demandId: string | null = null;
    if (report.targetType === "offer") {
      if (report.demandId === null) throw new ReportError("not_found");
      const access = await readOfferAccess(client, { viewerId: reporterId, demandId: report.demandId, offerId: report.targetId });
      // Une annonce retirée ou vendue depuis que l'acheteur l'avait parmi ses correspondances reste signalable (il la connaissait) ; tout le reste est introuvable.
      if (!access.ok && access.reason === "not_found") throw new ReportError("not_found");
      const owner = await client.query<{ owner_id: string }>("SELECT owner_id FROM offers WHERE id = $1::uuid", [report.targetId]);
      if (!owner.rows[0] || owner.rows[0].owner_id === reporterId) throw new ReportError("not_found");
      reportedUserId = owner.rows[0].owner_id;
      offerId = report.targetId;
      demandId = report.demandId;
    } else {
      const order = await client.query<{ buyer_id: string; seller_id: string }>(
        "SELECT buyer_id, seller_id FROM orders WHERE id = $1::uuid AND (buyer_id = $2::uuid OR seller_id = $2::uuid)",
        [report.targetId, reporterId],
      );
      const row = order.rows[0];
      if (!row) throw new ReportError("not_found");
      reportedUserId = row.buyer_id === reporterId ? row.seller_id : row.buyer_id;
      orderId = report.targetId;
    }
    const existing = await client.query(
      "SELECT 1 FROM reports WHERE reporter_id = $1::uuid AND status = 'open' AND (offer_id = $2::uuid OR order_id = $3::uuid)",
      [reporterId, offerId, orderId],
    );
    if (existing.rowCount) throw new ReportError("already_reported");
    const today = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM reports WHERE reporter_id = $1::uuid AND created_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
      [reporterId],
    );
    if (today.rows[0].n >= REPORTS_DAILY_LIMIT) throw new ReportError("daily_limit");
    const inserted = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO reports (reporter_id, reported_user_id, target_type, offer_id, order_id, demand_id, reason, detail)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::uuid, $7::text, $8::text) RETURNING id, created_at`,
      [reporterId, reportedUserId, report.targetType, offerId, orderId, demandId, report.reason, report.detail],
    );
    return { id: inserted.rows[0].id, status: "open" as const, createdAt: inserted.rows[0].created_at };
  }, pool);
}

// ───────────── lecture par l'auteur ─────────────

export interface MyReport {
  id: string;
  targetType: ReportTargetType;
  reason: ReportReason;
  status: ReportStatus;
  /** Titre de l'annonce ; « Commande » pour une commande. Jamais un nom ni un numéro. */
  targetTitle: string;
  createdAt: Date;
}

export const MY_REPORTS_LIMIT = 50;

/** Les signalements du compte, du plus récent au plus ancien. L'auteur voit seulement si le dossier est ouvert ou clos : ni la décision, ni le motif de l'administrateur. */
export async function listMyReports(input: { pool: Pool; reporterId: string }): Promise<MyReport[]> {
  const pool = requireTransactionPool(input.pool);
  const reporterId = requireUuid(input.reporterId, "reporterId").toLowerCase();
  const rows = await pool.query<{ id: string; target_type: ReportTargetType; reason: ReportReason; status: ReportStatus; title: string | null; created_at: Date }>(
    `SELECT r.id, r.target_type, r.reason, r.status, ${TITLE_SQL("o")} AS title, r.created_at
       FROM reports r
       LEFT JOIN offers o ON o.id = r.offer_id
      WHERE r.reporter_id = $1::uuid
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $2::int`,
    [reporterId, MY_REPORTS_LIMIT],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    targetType: row.target_type,
    reason: row.reason,
    status: row.status,
    targetTitle: row.target_type === "order" ? "Commande" : (row.title ?? "Annonce"),
    createdAt: row.created_at,
  }));
}

// ───────────── file de l'administration ─────────────

export const ADMIN_REPORTS_PAGE_DEFAULT = 20;
export const ADMIN_REPORTS_PAGE_MAX = 50;

export interface AdminReportRow {
  id: string;
  status: ReportStatus;
  targetType: ReportTargetType;
  reason: ReportReason;
  targetTitle: string;
  reporterMaskedPhone: string | null;
  reportedMaskedPhone: string | null;
  /** Dossiers OUVERTS visant le même compte (ce dossier compris). */
  reportedOpenCount: number;
  decision: ReportDecision | null;
  createdAt: Date;
}

export async function listAdminReports(input: { pool: Pool; status: ReportStatus; limit: number; offset: number }): Promise<{ reports: AdminReportRow[]; total: number }> {
  const pool = requireTransactionPool(input.pool);
  // Ouverts : du plus ancien (à traiter en premier) ; clos : du plus récent.
  const order = input.status === "open" ? "r.created_at ASC, r.id ASC" : "r.decided_at DESC, r.id DESC";
  const rows = await pool.query<{
    id: string; status: ReportStatus; target_type: ReportTargetType; reason: ReportReason; title: string | null; reporter_phone: string | null; reported_phone: string | null;
    reported_open: number; decision: ReportDecision | null; created_at: Date; total: number;
  }>(
    `SELECT r.id, r.status, r.target_type, r.reason, ${TITLE_SQL("o")} AS title,
            ${MASKED_PHONE_SQL("pr.phone_e164")} AS reporter_phone, ${MASKED_PHONE_SQL("pu.phone_e164")} AS reported_phone,
            (SELECT count(*)::int FROM reports x WHERE x.reported_user_id = r.reported_user_id AND x.status = 'open') AS reported_open,
            r.decision, r.created_at, count(*) OVER ()::int AS total
       FROM reports r
       LEFT JOIN offers o ON o.id = r.offer_id
       LEFT JOIN phone_identities pr ON pr.user_id = r.reporter_id AND pr.verified_at IS NOT NULL
       LEFT JOIN phone_identities pu ON pu.user_id = r.reported_user_id AND pu.verified_at IS NOT NULL
      WHERE r.status = $1::text
      ORDER BY ${order}
      LIMIT $2::int OFFSET $3::int`,
    [input.status, input.limit, input.offset],
  );
  let total = rows.rows[0]?.total ?? 0;
  if (rows.rows.length === 0 && input.offset > 0) {
    total = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM reports WHERE status = $1::text", [input.status])).rows[0].n;
  }
  return {
    reports: rows.rows.map((row) => ({
      id: row.id,
      status: row.status,
      targetType: row.target_type,
      reason: row.reason,
      targetTitle: row.target_type === "order" ? "Commande" : (row.title ?? "Annonce"),
      reporterMaskedPhone: row.reporter_phone,
      reportedMaskedPhone: row.reported_phone,
      reportedOpenCount: row.reported_open,
      decision: row.decision,
      createdAt: row.created_at,
    })),
    total,
  };
}

export interface AdminReportDetail extends AdminReportRow {
  detail: string | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  decidedByMaskedPhone: string | null;
  /** Statut du compte signalé : « active », « suspended » ou « archived ». */
  reportedStatus: "active" | "suspended" | "archived";
  /** Tous les dossiers (ouverts et clos) visant le même compte. */
  reportedTotalCount: number;
  /** Faits sur l'annonce (annonce seulement) : jamais le texte brut ni un contact. */
  offer: { status: string; availability: string | null; priceAmount: number | null; priceCurrency: string | null } | null;
  /** Faits sur la commande (commande seulement). */
  order: { status: string; priceAmount: number } | null;
}

export async function readAdminReport(input: { pool: Pool; reportId: string }): Promise<AdminReportDetail | null> {
  const pool = requireTransactionPool(input.pool);
  const reportId = requireUuid(input.reportId, "reportId").toLowerCase();
  const found = await pool.query<{
    id: string; status: ReportStatus; target_type: ReportTargetType; reason: ReportReason; title: string | null; reporter_phone: string | null; reported_phone: string | null;
    reported_open: number; reported_total: number; reported_status: "active" | "suspended" | "archived"; decision: ReportDecision | null; created_at: Date; detail: string | null;
    decision_note: string | null; decided_at: Date | null; decided_by_phone: string | null;
    offer_status: string | null; offer_availability: string | null; offer_price: string | null; offer_currency: string | null; order_status: string | null; order_price: string | null;
  }>(
    `SELECT r.id, r.status, r.target_type, r.reason, ${TITLE_SQL("o")} AS title,
            ${MASKED_PHONE_SQL("pr.phone_e164")} AS reporter_phone, ${MASKED_PHONE_SQL("pu.phone_e164")} AS reported_phone,
            (SELECT count(*)::int FROM reports x WHERE x.reported_user_id = r.reported_user_id AND x.status = 'open') AS reported_open,
            (SELECT count(*)::int FROM reports x WHERE x.reported_user_id = r.reported_user_id) AS reported_total,
            u.status AS reported_status, r.decision, r.created_at, r.detail, r.decision_note, r.decided_at, ${MASKED_PHONE_SQL("pd.phone_e164")} AS decided_by_phone,
            o.status AS offer_status, o.availability_status AS offer_availability, o.price_amount::text AS offer_price, o.price_currency AS offer_currency,
            ord.status AS order_status, ord.price_amount::text AS order_price
       FROM reports r
       JOIN users u ON u.id = r.reported_user_id
       LEFT JOIN offers o ON o.id = r.offer_id
       LEFT JOIN orders ord ON ord.id = r.order_id
       LEFT JOIN phone_identities pr ON pr.user_id = r.reporter_id AND pr.verified_at IS NOT NULL
       LEFT JOIN phone_identities pu ON pu.user_id = r.reported_user_id AND pu.verified_at IS NOT NULL
       LEFT JOIN phone_identities pd ON pd.user_id = r.decided_by AND pd.verified_at IS NOT NULL
      WHERE r.id = $1::uuid`,
    [reportId],
  );
  const row = found.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    targetType: row.target_type,
    reason: row.reason,
    targetTitle: row.target_type === "order" ? "Commande" : (row.title ?? "Annonce"),
    reporterMaskedPhone: row.reporter_phone,
    reportedMaskedPhone: row.reported_phone,
    reportedOpenCount: row.reported_open,
    decision: row.decision,
    createdAt: row.created_at,
    detail: row.detail,
    decisionNote: row.decision_note,
    decidedAt: row.decided_at,
    decidedByMaskedPhone: row.decided_by_phone,
    reportedStatus: row.reported_status,
    reportedTotalCount: row.reported_total,
    offer: row.target_type === "offer" ? { status: row.offer_status ?? "", availability: row.offer_availability, priceAmount: row.offer_price === null ? null : Number(row.offer_price), priceCurrency: row.offer_currency } : null,
    order: row.target_type === "order" ? { status: row.order_status ?? "", priceAmount: Number(row.order_price ?? 0) } : null,
  };
}

export async function decideReport(input: { pool: Pool; adminId: string; reportId: string; decision: ReportDecision; note: string }): Promise<{ status: "closed"; decision: ReportDecision; suspended: boolean }> {
  const pool = requireTransactionPool(input.pool);
  const adminId = requireUuid(input.adminId, "adminId").toLowerCase();
  const reportId = requireUuid(input.reportId, "reportId").toLowerCase();
  return withPostgresTransaction(async (client) => {
    await client.query("SET LOCAL statement_timeout = '10s'");
    const locked = await client.query<{ status: ReportStatus; reported_user_id: string }>("SELECT status, reported_user_id FROM reports WHERE id = $1::uuid FOR UPDATE", [reportId]);
    const report = locked.rows[0];
    if (!report) throw new ReportError("not_found");
    if (report.status !== "open") throw new ReportError("already_decided");
    let suspended = false;
    if (input.decision === "seller_suspended") {
      // Chemin existant : verrou du compte, refus (administrateur, archivé), `updateUser`, journal. Un refus annule TOUT : le dossier reste ouvert.
      await applyUserStatusInTransaction(client, { adminId, targetUserId: report.reported_user_id, action: "suspend" });
      suspended = true;
    }
    await client.query(
      "UPDATE reports SET status = 'closed', decision = $2::text, decision_note = $3::text, decided_by = $4::uuid, decided_at = clock_timestamp() WHERE id = $1::uuid",
      [reportId, input.decision, input.note, adminId],
    );
    return { status: "closed" as const, decision: input.decision, suspended };
  }, pool);
}
