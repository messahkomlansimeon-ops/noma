import "server-only";

import type { Pool, PoolClient } from "pg";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { MATCHING_CURRENT_CLOCK_CTE, MATCHING_FRESHNESS_FROM, buildMatchingFreshnessPredicate, resolveMatchingFreshnessParams } from "../matching/persistence";
import { mapStoredMatchesPageToDto, type StoredMatchesResponseDto } from "../matching/http-dto";
import { listStoredDemandMatchesForOffer } from "../matching/stored-matches";
import { withPostgresTransaction } from "../postgres/client";
import { declareOrderInTransaction } from "../social/orders";
import { PROPOSALS_DAILY_LIMIT, PROPOSALS_NEED_OPEN_LIMIT, type ProposalInput, type ProposalStatus } from "../../proposals-rules";

/**
 * Propositions de vendeur et devis (lot FIN3-C3). Voir PROPOSITIONS.md.
 *  - Le vendeur propose depuis UNE de ses annonces EN LIGNE à un besoin ACTIF qui y correspond encore (`readSellerDemandAccess` : même prédicat de fraîcheur que la fiche et le contact, du
 *    côté du vendeur). Tout autre cas (annonce d'un autre, hors ligne ou indisponible, besoin inconnu, clos, correspondance périmée, besoin porteur d'une mission, vendeur suspendu) :
 *    `not_found`, le MÊME 404.
 *  - Une proposition ENVOYÉE par couple (annonce, besoin) ; au plus `PROPOSALS_NEED_OPEN_LIMIT` en attente par besoin ; `PROPOSALS_DAILY_LIMIT` par vendeur et par jour UTC ; APRÈS UN REFUS,
 *    la même annonce ne propose plus à ce besoin. Les limites sont exactes sous concurrence (verrous consultatifs par vendeur, par besoin et par couple, pris dans cet ordre).
 *  - L'EXPIRATION n'est pas balayée : une proposition « envoyée » dont la validité est échue se LIT « expirée » ; elle est écrite « expirée » (sous le verrou du couple) quand le vendeur en
 *    envoie une nouvelle, pour libérer l'index unique.
 *  - ACCEPTATION (acheteur) : une transaction qui verrouille la proposition, refuse une proposition échue, et crée la COMMANDE par le circuit existant (`declareOrderInTransaction` : accès
 *    à l'annonce, refus d'une commande déjà active, attribution au boost) ; si la commande est refusée, la proposition reste « envoyée ». Rejouée, l'acceptation rend la même commande.
 */

export type ProposalErrorCode = "not_found" | "not_open" | "expired" | "active_exists" | "declined" | "daily_limit" | "need_limit";

export class ProposalError extends Error {
  readonly code: ProposalErrorCode;
  constructor(code: ProposalErrorCode) {
    super(code);
    this.name = "ProposalError";
    this.code = code;
  }
}

export const PROPOSAL_ERROR_MESSAGES: Readonly<Record<ProposalErrorCode, string>> = Object.freeze({
  not_found: "Ressource introuvable.",
  not_open: "Cette proposition n'est plus en attente de réponse.",
  expired: "Cette proposition a expiré.",
  active_exists: "Une proposition de cette annonce est déjà en attente pour ce besoin.",
  declined: "L'acheteur a refusé une proposition de cette annonce pour ce besoin : vous ne pouvez plus lui en envoyer pour cette annonce.",
  daily_limit: "Vous avez atteint le nombre de propositions autorisées aujourd'hui. Réessayez demain.",
  need_limit: "Ce besoin a déjà reçu le nombre maximal de propositions en attente.",
});

const TITLE = (alias: string): string => `coalesce(nullif(btrim(concat_ws(' ', ${alias}.brand, ${alias}.model, ${alias}.variant)), ''), left(${alias}.raw_text, 80))`;

// ───────────── accès du vendeur ─────────────

export type SellerAccess = { ok: true; buyerId: string } | { ok: false };

/**
 * L'accès du VENDEUR à un besoin à travers l'une de SES annonces : l'annonce est à lui, en ligne et pas indisponible ; le besoin est actif, d'un autre compte et n'est pas le besoin porteur d'une
 * mission d'achat en volume ; la correspondance est confirmée et fraîche (même prédicat que `readOfferAccess`, qui exige aussi des comptes actifs). Sinon : aucun accès.
 */
export async function readSellerDemandAccess(client: PoolClient, input: { sellerId: string; demandId: string; offerId: string }): Promise<SellerAccess> {
  const freshness = buildMatchingFreshnessPredicate(resolveMatchingFreshnessParams(), 4);
  const found = await client.query<{ buyer_id: string }>(
    `WITH ${MATCHING_CURRENT_CLOCK_CTE}
     SELECT d.owner_id AS buyer_id
       FROM ${MATCHING_FRESHNESS_FROM}
      WHERE e.demand_id = $1::uuid AND e.offer_id = $2::uuid AND o.owner_id = $3::uuid
        AND e.is_confirmed_match = TRUE
        AND o.status = 'published' AND o.availability_status IS DISTINCT FROM 'unavailable'
        AND d.status = 'active' AND d.owner_id <> o.owner_id
        AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.demand_id = d.id)
        AND ${freshness.conditions.join("\n        AND ")}
      LIMIT 1`,
    [input.demandId, input.offerId, input.sellerId, ...freshness.values],
  );
  return found.rows[0] ? { ok: true, buyerId: found.rows[0].buyer_id } : { ok: false };
}

// ───────────── vues ─────────────

export interface ProposalLineView {
  label: string;
  amountXof: number;
}

export interface ProposalView {
  id: string;
  demandId: string;
  offerId: string;
  /** Titre de l'annonce (acheteur) ; titre du besoin (vendeur : la ligne rappelle à quel besoin il a répondu). */
  offerTitle: string;
  needTitle: string;
  priceXof: number;
  lines: ProposalLineView[];
  slot: string | null;
  warranty: string | null;
  note: string | null;
  validUntil: Date;
  /** État LU : « sent » échu s'affiche « expired ». */
  status: ProposalStatus;
  orderId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

interface Row {
  id: string; demand_id: string; offer_id: string; price_amount: string; slot_text: string | null; warranty_text: string | null; note_text: string | null; valid_until: Date;
  status: ProposalStatus; order_id: string | null; created_at: Date; decided_at: Date | null; offer_title: string | null; need_title: string | null; expired: boolean;
}

const SELECT = `SELECT p.id, p.demand_id, p.offer_id, p.price_amount::text AS price_amount, p.slot_text, p.warranty_text, p.note_text, p.valid_until, p.status, p.order_id, p.created_at, p.decided_at,
        ${TITLE("o")} AS offer_title, ${TITLE("d")} AS need_title, (p.valid_until <= clock_timestamp()) AS expired
   FROM seller_proposals p JOIN offers o ON o.id = p.offer_id JOIN demands d ON d.id = p.demand_id`;

async function toViews(client: Pick<PoolClient, "query">, rows: Row[]): Promise<ProposalView[]> {
  if (rows.length === 0) return [];
  const lines = await client.query<{ proposal_id: string; label: string; amount_xof: string }>(
    "SELECT proposal_id, label, amount_xof::text AS amount_xof FROM seller_proposal_lines WHERE proposal_id = ANY($1::uuid[]) ORDER BY proposal_id, position",
    [rows.map((row) => row.id)],
  );
  const byProposal = new Map<string, ProposalLineView[]>();
  for (const line of lines.rows) byProposal.set(line.proposal_id, [...(byProposal.get(line.proposal_id) ?? []), { label: line.label, amountXof: Number(line.amount_xof) }]);
  return rows.map((row) => ({
    id: row.id,
    demandId: row.demand_id,
    offerId: row.offer_id,
    offerTitle: row.offer_title ?? "Annonce",
    needTitle: row.need_title ?? "Besoin",
    priceXof: Number(row.price_amount),
    lines: byProposal.get(row.id) ?? [],
    slot: row.slot_text,
    warranty: row.warranty_text,
    note: row.note_text,
    validUntil: row.valid_until,
    status: row.status === "sent" && row.expired ? "expired" : row.status,
    orderId: row.order_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  }));
}

export const PROPOSALS_LIST_LIMIT = 100;

/** Propositions d'un compte, du plus récent au plus ancien : celles qu'il a ENVOYÉES (vendeur) ou REÇUES (acheteur). */
export async function listProposals(input: { pool: Pool; userId: string; as: "seller" | "buyer" }): Promise<ProposalView[]> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const column = input.as === "seller" ? "p.seller_id" : "p.buyer_id";
  const rows = await pool.query<Row>(`${SELECT} WHERE ${column} = $1::uuid ORDER BY p.created_at DESC, p.id DESC LIMIT $2::int`, [userId, PROPOSALS_LIST_LIMIT]);
  return toViews(pool, rows.rows);
}

/** Une proposition, pour l'une de ses deux parties ; sinon null (404 indiscernable). */
export async function readProposal(input: { pool: Pool; userId: string; proposalId: string }): Promise<ProposalView | null> {
  const pool = requireTransactionPool(input.pool);
  const userId = requireUuid(input.userId, "userId").toLowerCase();
  const proposalId = requireUuid(input.proposalId, "proposalId").toLowerCase();
  const rows = await pool.query<Row>(`${SELECT} WHERE p.id = $1::uuid AND (p.seller_id = $2::uuid OR p.buyer_id = $2::uuid)`, [proposalId, userId]);
  return (await toViews(pool, rows.rows))[0] ?? null;
}

/** Nombre de propositions EN ATTENTE (non échues) que reçoit un acheteur : « n propositions » sur son écran, sans notification (voir PROPOSITIONS.md). */
export async function countPendingForBuyer(input: { pool: Pool; buyerId: string; demandId?: string }): Promise<number> {
  const pool = requireTransactionPool(input.pool);
  const buyerId = requireUuid(input.buyerId, "buyerId").toLowerCase();
  const demandId = input.demandId === undefined ? null : requireUuid(input.demandId, "demandId").toLowerCase();
  const found = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM seller_proposals WHERE buyer_id = $1::uuid AND status = 'sent' AND valid_until > clock_timestamp() AND ($2::uuid IS NULL OR demand_id = $2::uuid)",
    [buyerId, demandId],
  );
  return found.rows[0].n;
}

// ───────────── création ─────────────

export async function createProposal(input: { pool: Pool; sellerId: string; demandId: string; proposal: ProposalInput }): Promise<ProposalView> {
  const pool = requireTransactionPool(input.pool);
  const sellerId = requireUuid(input.sellerId, "sellerId").toLowerCase();
  const demandId = requireUuid(input.demandId, "demandId").toLowerCase();
  const { proposal } = input;
  const created = await withPostgresTransaction(async (client) => {
    await client.query("SET LOCAL statement_timeout = '10s'");
    // Ordre FIXE des verrous : vendeur, besoin, couple (annonce, besoin).
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`proposals-seller:${sellerId}`]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`proposals-need:${demandId}`]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))", [`proposal:${demandId}`, proposal.offerId]);
    const access = await readSellerDemandAccess(client, { sellerId, demandId, offerId: proposal.offerId });
    if (!access.ok) throw new ProposalError("not_found");
    // Les propositions échues du couple passent à « expirée » (le déclencheur l'exige échues) : l'index unique des « envoyées » est libéré.
    await client.query(
      "UPDATE seller_proposals SET status = 'expired', decided_at = clock_timestamp() WHERE demand_id = $1::uuid AND offer_id = $2::uuid AND status = 'sent' AND valid_until <= clock_timestamp()",
      [demandId, proposal.offerId],
    );
    if ((await client.query("SELECT 1 FROM seller_proposals WHERE demand_id = $1::uuid AND offer_id = $2::uuid AND status = 'declined'", [demandId, proposal.offerId])).rowCount) throw new ProposalError("declined");
    if ((await client.query("SELECT 1 FROM seller_proposals WHERE demand_id = $1::uuid AND offer_id = $2::uuid AND status = 'sent'", [demandId, proposal.offerId])).rowCount) throw new ProposalError("active_exists");
    const open = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM seller_proposals WHERE demand_id = $1::uuid AND status = 'sent' AND valid_until > clock_timestamp()", [demandId]);
    if (open.rows[0].n >= PROPOSALS_NEED_OPEN_LIMIT) throw new ProposalError("need_limit");
    const today = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM seller_proposals WHERE seller_id = $1::uuid AND created_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
      [sellerId],
    );
    if (today.rows[0].n >= PROPOSALS_DAILY_LIMIT) throw new ProposalError("daily_limit");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO seller_proposals (demand_id, offer_id, seller_id, buyer_id, price_amount, slot_text, warranty_text, note_text, valid_until)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::text, $7::text, $8::text, clock_timestamp() + ($9::int * interval '1 day')) RETURNING id`,
      [demandId, proposal.offerId, sellerId, access.buyerId, proposal.priceXof, proposal.slot, proposal.warranty, proposal.note, proposal.validDays],
    );
    const id = inserted.rows[0].id;
    for (const [index, line] of proposal.lines.entries()) {
      await client.query("INSERT INTO seller_proposal_lines (proposal_id, position, label, amount_xof) VALUES ($1::uuid, $2::int, $3::text, $4::bigint)", [id, index + 1, line.label, line.amountXof]);
    }
    return id;
  }, pool);
  const view = await readProposal({ pool, userId: sellerId, proposalId: created });
  if (!view) throw new ProposalError("not_found");
  return view;
}

// ───────────── réponses ─────────────

interface Locked {
  id: string; demand_id: string; offer_id: string; seller_id: string; buyer_id: string; price_amount: string; status: ProposalStatus; order_id: string | null; expired: boolean;
}

async function lockProposal(client: PoolClient, proposalId: string): Promise<Locked | null> {
  const found = await client.query<Locked>(
    "SELECT id, demand_id, offer_id, seller_id, buyer_id, price_amount::text AS price_amount, status, order_id, (valid_until <= clock_timestamp()) AS expired FROM seller_proposals WHERE id = $1::uuid FOR UPDATE",
    [proposalId],
  );
  return found.rows[0] ?? null;
}

/** L'acheteur accepte : la commande est créée dans la MÊME transaction. Rejouée : la même commande. Une commande déjà active pour le couple (FIN1) refuse l'acceptation et laisse la proposition envoyée. */
export async function acceptProposal(input: { pool: Pool; buyerId: string; proposalId: string }): Promise<{ proposal: ProposalView; orderId: string; replayed: boolean }> {
  const pool = requireTransactionPool(input.pool);
  const buyerId = requireUuid(input.buyerId, "buyerId").toLowerCase();
  const proposalId = requireUuid(input.proposalId, "proposalId").toLowerCase();
  const outcome = await withPostgresTransaction(async (client) => {
    await client.query("SET LOCAL statement_timeout = '10s'");
    const proposal = await lockProposal(client, proposalId);
    if (!proposal || proposal.buyer_id !== buyerId) throw new ProposalError("not_found");
    if (proposal.status === "accepted" && proposal.order_id) return { orderId: proposal.order_id, replayed: true };
    if (proposal.status !== "sent") throw new ProposalError("not_open");
    if (proposal.expired) throw new ProposalError("expired");
    const orderId = await declareOrderInTransaction(client, { buyerId, demandId: proposal.demand_id, offerId: proposal.offer_id, price: Number(proposal.price_amount), quantity: 1 });
    await client.query("UPDATE seller_proposals SET status = 'accepted', order_id = $2::uuid, decided_at = clock_timestamp() WHERE id = $1::uuid", [proposalId, orderId]);
    return { orderId, replayed: false };
  }, pool);
  const view = await readProposal({ pool, userId: buyerId, proposalId });
  if (!view) throw new ProposalError("not_found");
  return { proposal: view, orderId: outcome.orderId, replayed: outcome.replayed };
}

/** L'acheteur refuse : définitif pour cette annonce et ce besoin (anti-harcèlement). Rejoué : sans effet. */
export async function declineProposal(input: { pool: Pool; buyerId: string; proposalId: string }): Promise<ProposalView> {
  return settle(input.pool, input.buyerId, input.proposalId, "buyer", "declined");
}

/** Le vendeur retire sa proposition tant qu'elle est en attente. Rejoué : sans effet. */
export async function withdrawProposal(input: { pool: Pool; sellerId: string; proposalId: string }): Promise<ProposalView> {
  return settle(input.pool, input.sellerId, input.proposalId, "seller", "withdrawn");
}

async function settle(poolInput: Pool, userIdInput: string, proposalIdInput: string, side: "buyer" | "seller", target: "declined" | "withdrawn"): Promise<ProposalView> {
  const pool = requireTransactionPool(poolInput);
  const userId = requireUuid(userIdInput, "userId").toLowerCase();
  const proposalId = requireUuid(proposalIdInput, "proposalId").toLowerCase();
  await withPostgresTransaction(async (client) => {
    await client.query("SET LOCAL statement_timeout = '10s'");
    const proposal = await lockProposal(client, proposalId);
    if (!proposal || (side === "buyer" ? proposal.buyer_id : proposal.seller_id) !== userId) throw new ProposalError("not_found");
    if (proposal.status === target) return;
    if (proposal.status !== "sent") throw new ProposalError("not_open");
    if (proposal.expired) throw new ProposalError("expired");
    await client.query("UPDATE seller_proposals SET status = $2::text, decided_at = clock_timestamp() WHERE id = $1::uuid", [proposalId, target]);
  }, pool);
  const view = await readProposal({ pool, userId, proposalId });
  if (!view) throw new ProposalError("not_found");
  return view;
}

// ───────────── besoins reçus par le vendeur ─────────────

export const SELLER_REQUESTS_OFFERS_SCAN = 20;
export const SELLER_REQUESTS_PER_OFFER = 20;
export const SELLER_REQUESTS_LIMIT = 50;

export interface RequestOfferView {
  offerId: string;
  title: string;
  /** Proposition envoyée pour ce couple (annonce, besoin), s'il y en a une : sert à ne pas en renvoyer. */
  proposal: { id: string; status: ProposalStatus } | null;
  declined: boolean;
}

export interface SellerRequestView {
  /** Le besoin, tel que la liste « Acheteurs intéressés » de chaque annonce le montre déjà (même DTO, sans identité). */
  need: StoredMatchesResponseDto["items"][number];
  offers: RequestOfferView[];
}

export interface SellerRequests {
  requests: SellerRequestView[];
  /** Le vendeur a plus d'annonces en ligne que celles qui sont lues (les `SELLER_REQUESTS_OFFERS_SCAN` plus récentes). */
  offersTruncated: boolean;
}

/**
 * Les besoins qui correspondent aux annonces EN LIGNE du vendeur (les 20 plus récentes), regroupés par besoin : une ligne par besoin, avec les annonces du vendeur qui y correspondent. Chaque
 * besoin est le DTO EXACT de `/api/offers/{id}/stored-matches` (mêmes champs, sans identité) : rien de plus n'est montré au vendeur, c'est la même information regroupée. Les besoins porteurs
 * d'une mission sont écartés.
 */
export async function listSellerRequests(input: { pool: Pool; sellerId: string; demandId?: string }): Promise<SellerRequests> {
  const pool = requireTransactionPool(input.pool);
  const sellerId = requireUuid(input.sellerId, "sellerId").toLowerCase();
  const offers = await pool.query<{ id: string; title: string | null }>(
    `SELECT o.id, ${TITLE("o")} AS title FROM offers o
      WHERE o.owner_id = $1::uuid AND o.status = 'published' AND o.availability_status IS DISTINCT FROM 'unavailable'
      ORDER BY o.updated_at DESC, o.id DESC LIMIT $2::int`,
    [sellerId, SELLER_REQUESTS_OFFERS_SCAN + 1],
  );
  const offersTruncated = offers.rows.length > SELLER_REQUESTS_OFFERS_SCAN;
  const scanned = offers.rows.slice(0, SELLER_REQUESTS_OFFERS_SCAN);
  const byDemand = new Map<string, { need: SellerRequestView["need"]; offers: Array<{ offerId: string; title: string }> }>();
  for (const offer of scanned) {
    let page;
    try {
      page = await listStoredDemandMatchesForOffer(sellerId, offer.id, { limit: SELLER_REQUESTS_PER_OFFER, sort: "relevance" }, pool);
    } catch {
      continue; // une annonce dont les correspondances ne sont pas lisibles ne bloque pas les autres
    }
    for (const item of mapStoredMatchesPageToDto(page).items) {
      if (input.demandId !== undefined && item.candidateId !== input.demandId) continue;
      const current = byDemand.get(item.candidateId);
      if (current) current.offers.push({ offerId: offer.id, title: offer.title ?? "Annonce" });
      else byDemand.set(item.candidateId, { need: item, offers: [{ offerId: offer.id, title: offer.title ?? "Annonce" }] });
    }
  }
  const ids = [...byDemand.keys()];
  if (ids.length === 0) return { requests: [], offersTruncated };
  const carriers = await pool.query<{ demand_id: string }>("SELECT demand_id FROM missions WHERE demand_id = ANY($1::uuid[])", [ids]);
  for (const carrier of carriers.rows) byDemand.delete(carrier.demand_id);
  const proposals = await pool.query<{ id: string; demand_id: string; offer_id: string; status: ProposalStatus; expired: boolean }>(
    `SELECT id, demand_id, offer_id, status, (valid_until <= clock_timestamp()) AS expired FROM seller_proposals
      WHERE seller_id = $1::uuid AND demand_id = ANY($2::uuid[]) ORDER BY created_at ASC`,
    [sellerId, [...byDemand.keys()]],
  );
  const requests: SellerRequestView[] = [...byDemand.entries()]
    .sort((left, right) => right[1].need.relevance - left[1].need.relevance)
    .slice(0, SELLER_REQUESTS_LIMIT)
    .map(([demandId, entry]) => ({
      need: entry.need,
      offers: entry.offers.map((offer) => {
        const latest = proposals.rows.filter((row) => row.demand_id === demandId && row.offer_id === offer.offerId).at(-1) ?? null;
        const status: ProposalStatus | null = latest === null ? null : latest.status === "sent" && latest.expired ? "expired" : latest.status;
        return { offerId: offer.offerId, title: offer.title, proposal: latest === null || status === null ? null : { id: latest.id, status }, declined: status === "declined" };
      }),
    }));
  return { requests, offersTruncated };
}
