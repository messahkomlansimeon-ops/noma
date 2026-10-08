import "server-only";

import { noStoreJsonResponse } from "../http/protection";
import {
  MISSION_ACTIONS,
  MISSION_FIELDS,
  MISSIONS_CONTRACT_VERSION,
  SHORTFALL_TEXT,
  type MissionAction,
} from "../../missions-rules";
import { UUID, createSocialContext, hasUnexpectedQuery, invalidRequest, logCodeOf, type SocialHttpDependencies } from "../social/http-common";
import { MissionError } from "./errors";
import { missionErrorResponse } from "./http-errors";
import { createMission, listMissionOrders, listMissions, readMission, transitionMission, updateDraftMission, type MissionOrderItem, type MissionView } from "./missions";
import { readMissionProposal, type MissionProposal } from "./proposal";

/**
 * Routes HTTP des missions d'achat en volume (lot MV1). Voir MISSIONS.md.
 *  - GET  /api/missions[?cursor=…]         : « Mes missions » : les missions ouvertes d'abord, puis les closes, par pages de 50 avec un curseur opaque (`nextCursor`) ;
 *  - POST /api/missions                    : crée une mission (brouillon, ou lancée avec `activate: true`) ;
 *  - GET  /api/missions/{id}               : la mission et ses achats ; PUT : modifie un BROUILLON ; POST `{ action }` : activate | pause | resume | cancel ;
 *  - GET  /api/missions/{id}/proposal      : la proposition de répartition (lecture seule : ni message ni commande).
 * Propriétaire seulement (la session donne TOUJOURS le propriétaire) : pour tout autre, la MÊME réponse 404 que pour une mission inconnue. Toute écriture : origine vérifiée AVANT
 * la session. Réponses `no-store`, textes fixes, corps en liste blanche (champs de la mission uniquement). Aucun paiement ne passe par noma.
 */

export const MISSION_BODY_MAX_BYTES = 4_096;

export interface MissionsHttpHandlers {
  list(request: Request): Promise<Response>;
  create(request: Request): Promise<Response>;
  read(request: Request, missionId: string): Promise<Response>;
  update(request: Request, missionId: string): Promise<Response>;
  act(request: Request, missionId: string): Promise<Response>;
  proposal(request: Request, missionId: string): Promise<Response>;
}

// ───────────── DTO (liste blanche) ─────────────

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function missionDto(mission: MissionView) {
  return {
    id: mission.id,
    status: mission.status,
    title: mission.title,
    category: mission.category,
    brand: mission.brand,
    model: mission.model,
    variant: mission.variant,
    condition: mission.condition,
    quantity: mission.quantity,
    unit: mission.unit,
    securedQuantity: mission.securedQuantity,
    pendingQuantity: mission.pendingQuantity,
    unitBudgetXof: mission.unitBudgetXof,
    totalBudgetXof: mission.totalBudgetXof,
    committedXof: mission.committedXof,
    location: mission.location,
    deadlineDays: mission.deadlineDays,
    deadlineAt: iso(mission.deadlineAt),
    // Besoin porteur : un besoin ordinaire de l'acheteur, nécessaire pour ouvrir une conversation, voir une fiche et déclarer un achat depuis la proposition.
    demandId: mission.demandId,
    coveredQuantity: mission.coveredQuantity,
    evaluatedAt: iso(mission.evaluatedAt),
    activatedAt: iso(mission.activatedAt),
    closedAt: iso(mission.closedAt),
    createdAt: mission.createdAt.toISOString(),
    updatedAt: mission.updatedAt.toISOString(),
    canEdit: mission.actions.canEdit,
    canActivate: mission.actions.canActivate,
    canPause: mission.actions.canPause,
    canResume: mission.actions.canResume,
    canCancel: mission.actions.canCancel,
  };
}

function orderDto(order: MissionOrderItem) {
  return {
    id: order.id,
    status: order.status,
    quantity: order.quantity,
    unitPriceXof: order.unitPriceXof,
    offerId: order.offerId,
    title: order.title,
    createdAt: order.createdAt.toISOString(),
  };
}

function proposalDto(proposal: MissionProposal) {
  return {
    state: proposal.state,
    lines: proposal.lines.map((line) => ({
      offerId: line.offerId,
      vendor: line.vendorLabel,
      title: line.title,
      location: line.location,
      quantity: line.quantity,
      unitPriceXof: line.unitPriceXof,
      subtotalXof: line.subtotalXof,
      stock: line.stock,
    })),
    engaged: proposal.engaged.map((order) => ({
      orderId: order.orderId,
      status: order.status,
      vendor: order.vendorLabel,
      offerId: order.offerId,
      title: order.title,
      location: order.location,
      quantity: order.quantity,
      unitPriceXof: order.unitPriceXof,
      subtotalXof: order.subtotalXof,
    })),
    requestedQuantity: proposal.requestedQuantity,
    committedQuantity: proposal.committedQuantity,
    committedXof: proposal.committedXof,
    remainingQuantity: proposal.remainingQuantity,
    coveredQuantity: proposal.coveredQuantity,
    coveragePercent: Math.floor((proposal.coveredQuantity * 100) / proposal.requestedQuantity),
    budgetUsedXof: proposal.budgetUsedXof,
    budgetRemainingXof: proposal.budgetRemainingXof,
    totalBudgetXof: proposal.totalBudgetXof,
    unitBudgetXof: proposal.unitBudgetXof,
    sellerCount: proposal.sellerCount,
    candidateCount: proposal.candidateCount,
    reasons: proposal.reasons.map((code) => ({ code, text: SHORTFALL_TEXT[code] })),
    readAt: proposal.readAt.toISOString(),
  };
}

const json = (status: number, body: unknown): Response => noStoreJsonResponse(status, body);

export function createMissionsHttpHandlers(dependencies: SocialHttpDependencies = {}): MissionsHttpHandlers {
  const context = createSocialContext(dependencies, "missions-http");

  /** Gabarit : (origine pour l'écriture) → session → identifiants valides, aucun paramètre de requête → traitement. */
  async function guarded(request: Request, options: { write: boolean; ids?: readonly string[]; query?: readonly string[] }, run: (userId: string) => Promise<Response>): Promise<Response> {
    if (options.write) {
      const refusal = context.originGuard(request);
      if (refusal) return refusal;
    }
    const authenticated = await context.authenticate(request);
    if (!authenticated.ok) return authenticated.response;
    if ((options.ids ?? []).some((id) => !UUID.test(id)) || hasUnexpectedQuery(request, options.query ?? [])) return invalidRequest();
    try {
      return await run(authenticated.userId);
    } catch (error) {
      if (error instanceof MissionError) return missionErrorResponse(error);
      const mapped = context.mapError(error);
      if (mapped) return mapped;
      return context.unavailable(logCodeOf(error), "missions");
    }
  }

  return {
    list: (request) =>
      guarded(request, { write: false, query: ["cursor"] }, async (ownerId) => {
        const page = await listMissions({ pool: context.poolOf(), ownerId, cursor: new URL(request.url).searchParams.get("cursor") });
        return json(200, { contractVersion: MISSIONS_CONTRACT_VERSION, missions: page.missions.map(missionDto), nextCursor: page.nextCursor });
      }),

    create: (request) =>
      guarded(request, { write: true }, async (ownerId) => {
        const body = await context.readJsonObject(request, MISSION_BODY_MAX_BYTES);
        if (body === null) return invalidRequest();
        // Liste blanche : les champs de la mission, plus `activate`. Tout autre champ est refusé (jamais ignoré).
        const { activate, ...fields } = body;
        if (activate !== undefined && typeof activate !== "boolean") return invalidRequest();
        const mission = await createMission({ pool: context.poolOf(), ownerId, mission: fields, activate: activate === true });
        return json(201, { contractVersion: MISSIONS_CONTRACT_VERSION, mission: missionDto(mission) });
      }),

    read: (request, missionId) =>
      guarded(request, { write: false, ids: [missionId] }, async (ownerId) => {
        const pool = context.poolOf();
        const mission = await readMission({ pool, ownerId, missionId });
        const orders = await listMissionOrders({ pool, ownerId, missionId });
        return json(200, { contractVersion: MISSIONS_CONTRACT_VERSION, mission: missionDto(mission), orders: orders.map(orderDto) });
      }),

    update: (request, missionId) =>
      guarded(request, { write: true, ids: [missionId] }, async (ownerId) => {
        const body = await context.readJsonObject(request, MISSION_BODY_MAX_BYTES);
        if (body === null) return invalidRequest();
        const mission = await updateDraftMission({ pool: context.poolOf(), ownerId, missionId, patch: body });
        return json(200, { contractVersion: MISSIONS_CONTRACT_VERSION, mission: missionDto(mission) });
      }),

    act: (request, missionId) =>
      guarded(request, { write: true, ids: [missionId] }, async (ownerId) => {
        const body = await context.readJsonObject(request, 256);
        if (body === null || Object.keys(body).length !== 1 || typeof body.action !== "string" || !(MISSION_ACTIONS as readonly string[]).includes(body.action)) return invalidRequest();
        const mission = await transitionMission({ pool: context.poolOf(), ownerId, missionId, action: body.action as MissionAction });
        return json(200, { contractVersion: MISSIONS_CONTRACT_VERSION, mission: missionDto(mission) });
      }),

    proposal: (request, missionId) =>
      guarded(request, { write: false, ids: [missionId] }, async (ownerId) => {
        const { mission, proposal } = await readMissionProposal({ pool: context.poolOf(), ownerId, missionId });
        return json(200, { contractVersion: MISSIONS_CONTRACT_VERSION, missionId: mission.id, proposal: proposalDto(proposal) });
      }),
  };
}

export const defaultMissionsHttpHandlers = createMissionsHttpHandlers();

/** Les champs acceptés par la création et la modification (liste blanche), pour les essais. */
export const MISSION_BODY_FIELDS: readonly string[] = [...MISSION_FIELDS];
