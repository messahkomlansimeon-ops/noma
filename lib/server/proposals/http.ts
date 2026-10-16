import "server-only";

import { noStoreJsonResponse } from "../http/protection";
import { UUID, createSocialContext, failure, hasUnexpectedQuery, invalidRequest, logCodeOf, resourceNotFound, type SocialHttpDependencies } from "../social/http-common";
import { PHONE_IN_PROPOSAL_MESSAGE, PROPOSALS_CONTRACT_VERSION, PROPOSAL_ACTIONS, checkProposalInput, type ProposalAction } from "../../proposals-rules";
import {
  PROPOSAL_ERROR_MESSAGES,
  ProposalError,
  acceptProposal,
  countPendingForBuyer,
  createProposal,
  declineProposal,
  listProposals,
  listSellerRequests,
  withdrawProposal,
  type ProposalView,
} from "./proposals";

/**
 * Routes HTTP des propositions et des devis (lot FIN3-C3) : `no-store`, origine vérifiée sur les écritures (AVANT la session), session obligatoire, 404 indiscernable pour tout ce qui n'est pas
 * accessible (annonce d'un autre, besoin sans correspondance, proposition d'un autre compte).
 *  - GET  /api/requests                         : les besoins qui correspondent aux annonces en ligne du vendeur (même DTO que « Acheteurs intéressés », regroupés par besoin) ;
 *  - GET  /api/requests/{demandId}              : un de ces besoins ;
 *  - POST /api/requests/{demandId}/proposals    : { offerId, priceXof | lines, slot?, warranty?, note?, validDays? } → 201 { proposal } ;
 *  - GET  /api/proposals?as=seller|buyer        : propositions envoyées ou reçues ; `pendingCount` (en attente, non échues) pour l'acheteur ;
 *  - POST /api/proposals/{id}/accept|decline|withdraw : { } → 200 ; `accept` crée la commande (200 { proposal, orderId }).
 */

const BODY_MAX_BYTES = 8_192;

export interface ProposalsHttpHandlers {
  requests(request: Request): Promise<Response>;
  request(request: Request, demandId: string): Promise<Response>;
  create(request: Request, demandId: string): Promise<Response>;
  list(request: Request): Promise<Response>;
  act(request: Request, proposalId: string, action: string): Promise<Response>;
}

export function proposalDto(proposal: ProposalView): Record<string, unknown> {
  return {
    id: proposal.id,
    demandId: proposal.demandId,
    offerId: proposal.offerId,
    offerTitle: proposal.offerTitle,
    needTitle: proposal.needTitle,
    priceXof: proposal.priceXof,
    lines: proposal.lines.map((line) => ({ label: line.label, amountXof: line.amountXof })),
    slot: proposal.slot,
    warranty: proposal.warranty,
    note: proposal.note,
    validUntil: proposal.validUntil.toISOString(),
    status: proposal.status,
    orderId: proposal.orderId,
    createdAt: proposal.createdAt.toISOString(),
    decidedAt: proposal.decidedAt === null ? null : proposal.decidedAt.toISOString(),
  };
}

export function mapProposalError(error: unknown): Response | null {
  if (!(error instanceof ProposalError)) return null;
  switch (error.code) {
    case "not_found":
      return resourceNotFound();
    case "daily_limit":
      return failure(429, "proposals_daily_limit", PROPOSAL_ERROR_MESSAGES.daily_limit);
    case "need_limit":
      return failure(409, "proposals_need_limit", PROPOSAL_ERROR_MESSAGES.need_limit);
    case "active_exists":
      return failure(409, "proposal_active_exists", PROPOSAL_ERROR_MESSAGES.active_exists);
    case "declined":
      return failure(409, "proposal_declined", PROPOSAL_ERROR_MESSAGES.declined);
    case "expired":
      return failure(409, "proposal_expired", PROPOSAL_ERROR_MESSAGES.expired);
    case "not_open":
      return failure(409, "proposal_not_open", PROPOSAL_ERROR_MESSAGES.not_open);
  }
}

export function createProposalsHttpHandlers(dependencies: SocialHttpDependencies = {}): ProposalsHttpHandlers {
  const context = createSocialContext(dependencies, "proposals-http");

  async function guarded(request: Request, options: { write: boolean }, run: (userId: string) => Promise<Response>): Promise<Response> {
    if (options.write) {
      const refusal = context.originGuard(request);
      if (refusal) return refusal;
    }
    const authenticated = await context.authenticate(request);
    if (!authenticated.ok) return authenticated.response;
    try {
      return await run(authenticated.userId);
    } catch (error) {
      const mapped = mapProposalError(error) ?? context.mapError(error);
      if (mapped) return mapped;
      return context.unavailable(logCodeOf(error), "proposals");
    }
  }

  return {
    requests: (request) =>
      guarded(request, { write: false }, async (userId) => {
        if (hasUnexpectedQuery(request)) return invalidRequest();
        const result = await listSellerRequests({ pool: context.poolOf(), sellerId: userId });
        return noStoreJsonResponse(200, { contractVersion: PROPOSALS_CONTRACT_VERSION, requests: result.requests, offersTruncated: result.offersTruncated });
      }),

    request: (request, demandId) =>
      guarded(request, { write: false }, async (userId) => {
        if (!UUID.test(demandId) || hasUnexpectedQuery(request)) return resourceNotFound();
        const result = await listSellerRequests({ pool: context.poolOf(), sellerId: userId, demandId: demandId.toLowerCase() });
        if (result.requests.length === 0) return resourceNotFound();
        return noStoreJsonResponse(200, { contractVersion: PROPOSALS_CONTRACT_VERSION, request: result.requests[0] });
      }),

    create: (request, demandId) =>
      guarded(request, { write: true }, async (userId) => {
        if (!UUID.test(demandId) || hasUnexpectedQuery(request)) return resourceNotFound();
        const body = await context.readJsonObject(request, BODY_MAX_BYTES);
        if (body === null) return invalidRequest();
        const checked = checkProposalInput(body);
        if (!checked.ok) return checked.reason === "phone" ? failure(400, "phone_number_in_proposal", PHONE_IN_PROPOSAL_MESSAGE) : invalidRequest();
        const proposal = await createProposal({ pool: context.poolOf(), sellerId: userId, demandId: demandId.toLowerCase(), proposal: checked.value });
        return noStoreJsonResponse(201, { contractVersion: PROPOSALS_CONTRACT_VERSION, proposal: proposalDto(proposal) });
      }),

    list: (request) =>
      guarded(request, { write: false }, async (userId) => {
        if (hasUnexpectedQuery(request, ["as"])) return invalidRequest();
        const as = new URL(request.url).searchParams.get("as");
        if (as !== "seller" && as !== "buyer") return invalidRequest();
        const proposals = await listProposals({ pool: context.poolOf(), userId, as });
        const pendingCount = as === "buyer" ? await countPendingForBuyer({ pool: context.poolOf(), buyerId: userId }) : null;
        return noStoreJsonResponse(200, { contractVersion: PROPOSALS_CONTRACT_VERSION, proposals: proposals.map(proposalDto), pendingCount });
      }),

    act: (request, proposalId, action) =>
      guarded(request, { write: true }, async (userId) => {
        if (!UUID.test(proposalId) || hasUnexpectedQuery(request) || !(PROPOSAL_ACTIONS as readonly string[]).includes(action)) return resourceNotFound();
        const body = await context.readJsonObject(request, 64);
        if (body === null || Object.keys(body).length > 0) return invalidRequest();
        const id = proposalId.toLowerCase();
        const verb = action as ProposalAction;
        if (verb === "accept") {
          const accepted = await acceptProposal({ pool: context.poolOf(), buyerId: userId, proposalId: id });
          return noStoreJsonResponse(200, { contractVersion: PROPOSALS_CONTRACT_VERSION, proposal: proposalDto(accepted.proposal), orderId: accepted.orderId, replayed: accepted.replayed });
        }
        const settled = verb === "decline" ? await declineProposal({ pool: context.poolOf(), buyerId: userId, proposalId: id }) : await withdrawProposal({ pool: context.poolOf(), sellerId: userId, proposalId: id });
        return noStoreJsonResponse(200, { contractVersion: PROPOSALS_CONTRACT_VERSION, proposal: proposalDto(settled) });
      }),
  };
}

export const defaultProposalsHttpHandlers = createProposalsHttpHandlers();
