import "server-only";

import type { Pool } from "pg";
import { CatalogNotFoundError, CatalogValidationError } from "../catalog/errors";
import { requireTransactionPool, requireUuid } from "../catalog/validation";
import { readDemandOrganicRanking } from "../matching/stored-matches";
import { withReadSnapshot } from "../matching/service";
import type { SqlExecutor } from "../postgres/client";
import { publicFieldText } from "../../phone-text";
import { buildNotificationTitle } from "../notifications/content";
import type { ShortfallReason } from "../../missions-rules";
import { allocateMission, emptyAllocation, type AllocationCandidate, type AllocationResult } from "./allocation";
import { MissionError } from "./errors";
import { MISSION_COLUMNS, mapMission, type MissionRecord, type MissionRow } from "./missions";

/**
 * Proposition de répartition d'une mission (lot MV1) : LECTURE seule. Rien n'est écrit, aucun message ni aucune commande n'est jamais créé par une proposition.
 *  - ce qui est DÉJÀ ENGAGÉ (commandes proposées ou confirmées rattachées à la mission) est affiché à part (« déjà acheté / en attente ») et SOUSTRAIT : la proposition ne répartit
 *    que le RESTE (quantité totale moins les quantités engagées, budget total moins les montants engagés) ; une annonce déjà commandée n'est pas proposée une seconde fois ;
 *  - les candidats sont les correspondances CONFIRMÉES ET FRAÎCHES du besoin porteur, dans l'ordre de pertinence ORGANIQUE (celui du tri par pertinence, sans boost :
 *    `readDemandOrganicRanking`, même lignes et même prédicat que la lecture des résultats) ; le moteur de matching n'est pas dupliqué ;
 *  - la répartition est `allocateMission` (heuristique gloutonne, voir allocation.ts) : budget par unité, budget total restant, quantité annoncée (1 si elle n'est pas renseignée),
 *    10 vendeurs au plus (les vendeurs déjà engagés comptent dans les 10) ;
 *  - les vendeurs sont ÉTIQUETÉS « Vendeur 1 », « Vendeur 2 »… (les vendeurs déjà engagés d'abord, puis dans l'ordre de remplissage) : la proposition ne porte aucun identifiant de
 *    vendeur ni de numéro. UNE étiquette par vendeur : deux annonces d'un même vendeur portent la même (information assumée, MISSIONS.md) ;
 *  - la couverture (`coveredQuantity`) est la quantité engagée PLUS la quantité proposée, plafonnée à la quantité totale : c'est aussi celle que lit l'étape du runner.
 *  - une mission dont l'échéance est passée n'a plus de proposition (`inactive`), même si l'étape du runner ne l'a pas encore marquée échue.
 */

export interface ProposalLine {
  offerId: string;
  /** « Vendeur 1 » : jamais un identifiant. */
  vendorLabel: string;
  title: string;
  location: string | null;
  quantity: number;
  unitPriceXof: number;
  subtotalXof: number;
  /** Quantité annoncée par le vendeur (1 si elle n'est pas renseignée). */
  stock: number;
}

/** Un achat déjà engagé pour la mission (commande proposée ou confirmée), affiché à part. */
export interface ProposalEngaged {
  orderId: string;
  status: "proposed" | "confirmed";
  vendorLabel: string;
  offerId: string;
  title: string;
  location: string | null;
  quantity: number;
  unitPriceXof: number;
  subtotalXof: number;
}

export type ProposalState = "ready" | "inactive" | "unavailable";

export interface MissionProposal {
  /** `ready` : proposition calculée ; `inactive` : la mission n'est ni active ni en pause, ou son échéance est passée ; `unavailable` : le besoin porteur n'est plus lisible. */
  state: ProposalState;
  /** Les lignes proposées pour le RESTE à acheter. */
  lines: ProposalLine[];
  /** Les achats déjà engagés (proposés ou confirmés), du plus ancien au plus récent. */
  engaged: ProposalEngaged[];
  /** Quantité totale de la mission. */
  requestedQuantity: number;
  /** Quantité déjà engagée (commandes proposées ou confirmées) et son montant. */
  committedQuantity: number;
  committedXof: number;
  /** Ce qu'il reste à acheter après l'engagé. */
  remainingQuantity: number;
  /** Engagé + proposé, plafonné à la quantité totale. */
  coveredQuantity: number;
  /** 0 à 1. */
  coverage: number;
  /** Engagé + proposé. */
  budgetUsedXof: number;
  budgetRemainingXof: number;
  totalBudgetXof: number;
  unitBudgetXof: number;
  /** Vendeurs de la mission : déjà engagés ou proposés. */
  sellerCount: number;
  /** Annonces correspondantes lues, avant le filtre des budgets (hors annonces déjà commandées). */
  candidateCount: number;
  reasons: ShortfallReason[];
  readAt: Date;
}

export interface OfferRow {
  id: string;
  owner_id: string;
  price_amount: string | null;
  price_currency: string | null;
  quantity: number | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  location_text: string | null;
}

export interface EngagedOrderRead {
  orderId: string;
  offerId: string;
  sellerKey: string;
  status: "proposed" | "confirmed";
  quantity: number;
  unitPriceXof: number;
}

/** Ce que lisent la proposition ET l'étape du runner : la répartition du RESTE, l'engagé, la couverture totale. */
export interface MissionAllocationRead {
  /** Répartition du reste à acheter. */
  allocation: AllocationResult;
  offers: Map<string, OfferRow>;
  candidateCount: number;
  engaged: EngagedOrderRead[];
  committedQuantity: number;
  committedXof: number;
  remainingQuantity: number;
  remainingBudgetXof: number;
  /** Engagé + proposé, plafonné à la quantité totale. */
  coveredQuantity: number;
}

/**
 * La répartition d'une mission et les annonces lues, dans l'instantané de lecture donné. `null` si le besoin porteur n'est plus lisible (inactif, propriétaire suspendu).
 * Les commandes proposées ou confirmées de la mission sont soustraites (quantité et montant), leurs annonces ne sont pas reproposées.
 */
export async function computeMissionAllocation(client: SqlExecutor, mission: MissionRecord, at: Date): Promise<MissionAllocationRead | null> {
  if (mission.demandId === null) return null;
  let ranking: Awaited<ReturnType<typeof readDemandOrganicRanking>>;
  try {
    ranking = await readDemandOrganicRanking(client, { demandId: mission.demandId, ownerId: mission.ownerId, at });
  } catch (error) {
    if (error instanceof CatalogNotFoundError || error instanceof CatalogValidationError) return null;
    throw error;
  }
  const orders = await client.query<{ id: string; offer_id: string; seller_id: string; status: "proposed" | "confirmed"; quantity: number; price_amount: string }>(
    `SELECT id, offer_id, seller_id, status, quantity, price_amount::text AS price_amount
       FROM orders WHERE mission_id = $1::uuid AND status IN ('proposed', 'confirmed') ORDER BY created_at, id`,
    [mission.id],
  );
  const engaged: EngagedOrderRead[] = orders.rows.map((row) => ({
    orderId: row.id,
    offerId: row.offer_id,
    sellerKey: row.seller_id,
    status: row.status,
    quantity: row.quantity,
    unitPriceXof: Number(row.price_amount),
  }));
  const engagedOffers = new Set(engaged.map((order) => order.offerId));
  const wanted = [...new Set([...ranking.map((entry) => entry.offerId), ...engaged.map((order) => order.offerId)])];
  const offers = new Map<string, OfferRow>();
  if (wanted.length > 0) {
    const rows = await client.query<OfferRow>(
      `SELECT id, owner_id, price_amount::text AS price_amount, price_currency, quantity, brand, model, variant, location_text
         FROM offers WHERE id = ANY($1::uuid[])`,
      [wanted],
    );
    for (const row of rows.rows) offers.set(row.id, row);
  }
  const candidates: AllocationCandidate[] = [];
  for (const entry of ranking) {
    if (engagedOffers.has(entry.offerId)) continue;
    const offer = offers.get(entry.offerId);
    if (!offer) continue;
    const price = offer.price_amount === null || offer.price_currency !== "XOF" ? null : Number(offer.price_amount);
    candidates.push({
      offerId: offer.id,
      sellerKey: offer.owner_id,
      relevance: entry.relevance,
      unitPrice: price !== null && Number.isSafeInteger(price) ? price : null,
      stock: offer.quantity,
    });
  }
  const committedQuantity = engaged.reduce((sum, order) => sum + order.quantity, 0);
  const committedXof = engaged.reduce((sum, order) => sum + order.quantity * order.unitPriceXof, 0);
  const remainingQuantity = Math.max(0, mission.quantity - committedQuantity);
  const remainingBudgetXof = Math.max(0, mission.totalBudgetXof - committedXof);
  const engagedSellers = [...new Set(engaged.map((order) => order.sellerKey))];
  const allocation =
    remainingQuantity >= 1
      ? allocateMission({ quantity: remainingQuantity, unitBudget: mission.unitBudgetXof, totalBudget: remainingBudgetXof, candidates, engagedSellers })
      : emptyAllocation({ totalBudget: remainingBudgetXof, engagedSellers });
  return {
    allocation,
    offers,
    candidateCount: candidates.length,
    engaged,
    committedQuantity,
    committedXof,
    remainingQuantity,
    remainingBudgetXof,
    coveredQuantity: Math.min(mission.quantity, committedQuantity + allocation.coveredQuantity),
  };
}

/** La proposition de la mission du propriétaire (404 indiscernable pour toute autre personne). */
export async function readMissionProposal(input: { pool: Pool; ownerId: string; missionId: string }): Promise<{ mission: MissionRecord; proposal: MissionProposal }> {
  const pool = requireTransactionPool(input.pool);
  const ownerId = requireUuid(input.ownerId, "ownerId").toLowerCase();
  const missionId = requireUuid(input.missionId, "missionId").toLowerCase();
  return withReadSnapshot(pool, async (client) => {
    const found = await client.query<MissionRow>(`SELECT ${MISSION_COLUMNS} FROM missions WHERE id = $1::uuid AND owner_id = $2::uuid`, [missionId, ownerId]);
    if (!found.rows[0]) throw new MissionError("resource_not_found");
    const mission = mapMission(found.rows[0]);
    const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const readAt = clock.rows[0].now;
    const base = {
      lines: [] as ProposalLine[],
      engaged: [] as ProposalEngaged[],
      requestedQuantity: mission.quantity,
      committedQuantity: 0,
      committedXof: 0,
      remainingQuantity: mission.quantity,
      coveredQuantity: 0,
      coverage: 0,
      budgetUsedXof: 0,
      budgetRemainingXof: mission.totalBudgetXof,
      totalBudgetXof: mission.totalBudgetXof,
      unitBudgetXof: mission.unitBudgetXof,
      sellerCount: 0,
      candidateCount: 0,
      reasons: [] as ShortfallReason[],
      readAt,
    };
    // Pas de proposition pour une mission close, ni après l'échéance (même si l'étape du runner ne l'a pas encore marquée échue).
    const open = (mission.status === "active" || mission.status === "paused") && mission.deadlineAt !== null && mission.deadlineAt.getTime() > readAt.getTime();
    if (!open) return { mission, proposal: { state: "inactive" as const, ...base } };
    const computed = await computeMissionAllocation(client, mission, readAt);
    if (computed === null) return { mission, proposal: { state: "unavailable" as const, ...base } };
    const { allocation, offers } = computed;
    const labelOf = (sellerKey: string): string => `Vendeur ${allocation.sellerIndexes.get(sellerKey) as number}`;
    const lines: ProposalLine[] = allocation.lines.map((line) => {
      const offer = offers.get(line.offerId) as OfferRow;
      return {
        offerId: line.offerId,
        vendorLabel: `Vendeur ${line.sellerIndex}`,
        title: buildNotificationTitle({ brand: offer.brand, model: offer.model, variant: offer.variant }),
        location: publicFieldText(offer.location_text),
        quantity: line.quantity,
        unitPriceXof: line.unitPrice,
        subtotalXof: line.subtotal,
        stock: line.stock,
      };
    });
    const engaged: ProposalEngaged[] = computed.engaged.map((order) => {
      const offer = offers.get(order.offerId);
      return {
        orderId: order.orderId,
        status: order.status,
        vendorLabel: labelOf(order.sellerKey),
        offerId: order.offerId,
        title: offer ? buildNotificationTitle({ brand: offer.brand, model: offer.model, variant: offer.variant }) : "Annonce",
        location: offer ? publicFieldText(offer.location_text) : null,
        quantity: order.quantity,
        unitPriceXof: order.unitPriceXof,
        subtotalXof: order.quantity * order.unitPriceXof,
      };
    });
    const budgetUsed = computed.committedXof + allocation.budgetUsed;
    return {
      mission,
      proposal: {
        state: "ready" as const,
        lines,
        engaged,
        requestedQuantity: mission.quantity,
        committedQuantity: computed.committedQuantity,
        committedXof: computed.committedXof,
        remainingQuantity: computed.remainingQuantity,
        coveredQuantity: computed.coveredQuantity,
        coverage: computed.coveredQuantity / mission.quantity,
        budgetUsedXof: budgetUsed,
        budgetRemainingXof: Math.max(0, mission.totalBudgetXof - budgetUsed),
        totalBudgetXof: mission.totalBudgetXof,
        unitBudgetXof: mission.unitBudgetXof,
        sellerCount: allocation.sellerCount,
        candidateCount: computed.candidateCount,
        reasons: allocation.reasons,
        readAt,
      },
    };
  });
}
