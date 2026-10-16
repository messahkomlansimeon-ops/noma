/**
 * Couche cliente des propositions de vendeur et des devis (lot FIN3-C3) : module partagé navigateur (aucun import serveur), mêmes règles que `reports-api.ts` : fetch même origine, JSON, toute
 * erreur devient une `ApiError { status, code }` construite UNIQUEMENT depuis le corps `{ error: { code, message } }` du serveur (ou un code fixe), réponses relues champ par champ (liste
 * blanche). Le besoin d'un acheteur est relu par le MÊME analyseur que « Acheteurs intéressés » (`parseStoredMatch`). Contrat : lib/server/proposals/http.ts (`proposals/v1`). Voir PROPOSITIONS.md.
 */

import { API_ABORTED, API_INVALID_ID, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, isUuid, parseStoredMatch, type RequestOptions, type StoredMatch } from "./api";
import { PROPOSALS_CONTRACT_VERSION, PROPOSAL_STATUSES, checkProposalInput, type ProposalAction, type ProposalInput, type ProposalStatus } from "../proposals-rules";

export { PROPOSALS_CONTRACT_VERSION };

export interface ProposalLine {
  label: string;
  amountXof: number;
}

export interface Proposal {
  id: string;
  demandId: string;
  offerId: string;
  offerTitle: string;
  needTitle: string;
  priceXof: number;
  lines: ProposalLine[];
  slot: string | null;
  warranty: string | null;
  note: string | null;
  validUntil: string;
  status: ProposalStatus;
  orderId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface RequestOffer {
  offerId: string;
  title: string;
  proposal: { id: string; status: ProposalStatus } | null;
  declined: boolean;
}

export interface SellerRequest {
  need: StoredMatch;
  offers: RequestOffer[];
}

export interface SellerRequests {
  requests: SellerRequest[];
  offersTruncated: boolean;
}

export interface ProposalsList {
  proposals: Proposal[];
  /** Propositions en attente (non échues) que reçoit l'acheteur ; null côté vendeur. */
  pendingCount: number | null;
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isIso = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown, max = 200): value is string => typeof value === "string" && value.length >= 1 && value.length <= max;
const nullableText = (value: unknown, max: number): boolean => value === null || isText(value, max);

function fixedError(status: number, code: string): ApiError {
  const messages: Record<string, string> = {
    [API_NETWORK_ERROR]: "Connexion au serveur impossible.",
    [API_INVALID_RESPONSE]: "Réponse du serveur inattendue.",
    [API_ABORTED]: "Requête interrompue.",
    [API_INVALID_ID]: "Identifiant invalide.",
    invalid_argument: "Paramètre invalide.",
    phone_number_in_proposal: "Pas de numéro de téléphone dans la proposition.",
  };
  return new ApiError(status, code, messages[code] ?? messages[API_INVALID_RESPONSE]);
}

function need(status: number, condition: boolean): void {
  if (!condition) throw fixedError(status, API_INVALID_RESPONSE);
}

function parseProposal(status: number, value: unknown): Proposal {
  need(
    status,
    isObject(value) && isUuid(value.id) && isUuid(value.demandId) && isUuid(value.offerId) && isText(value.offerTitle, 200) && isText(value.needTitle, 200) && isCount(value.priceXof) && value.priceXof >= 1 &&
      Array.isArray(value.lines) && value.lines.length <= 20 && nullableText(value.slot, 120) && nullableText(value.warranty, 120) && nullableText(value.note, 300) && isIso(value.validUntil) &&
      (PROPOSAL_STATUSES as readonly unknown[]).includes(value.status) && (value.orderId === null || isUuid(value.orderId)) && isIso(value.createdAt) && (value.decidedAt === null || isIso(value.decidedAt)),
  );
  const p = value as Json;
  const lines = (p.lines as unknown[]).map((line) => {
    need(status, isObject(line) && isText(line.label, 80) && isCount(line.amountXof));
    return { label: (line as Json).label as string, amountXof: (line as Json).amountXof as number };
  });
  return {
    id: p.id as string,
    demandId: p.demandId as string,
    offerId: p.offerId as string,
    offerTitle: p.offerTitle as string,
    needTitle: p.needTitle as string,
    priceXof: p.priceXof as number,
    lines,
    slot: p.slot as string | null,
    warranty: p.warranty as string | null,
    note: p.note as string | null,
    validUntil: p.validUntil as string,
    status: p.status as ProposalStatus,
    orderId: p.orderId as string | null,
    createdAt: p.createdAt as string,
    decidedAt: p.decidedAt as string | null,
  };
}

function parseRequest(status: number, value: unknown): SellerRequest {
  need(status, isObject(value) && Array.isArray(value.offers) && value.offers.length >= 1);
  const r = value as Json;
  const offers = (r.offers as unknown[]).map((entry) => {
    need(
      status,
      isObject(entry) && isUuid(entry.offerId) && isText(entry.title, 200) && typeof entry.declined === "boolean" &&
        (entry.proposal === null || (isObject(entry.proposal) && isUuid(entry.proposal.id) && (PROPOSAL_STATUSES as readonly unknown[]).includes(entry.proposal.status))),
    );
    const e = entry as Json;
    const proposal = e.proposal === null ? null : { id: (e.proposal as Json).id as string, status: (e.proposal as Json).status as ProposalStatus };
    return { offerId: e.offerId as string, title: e.title as string, proposal, declined: e.declined as boolean };
  });
  return { need: parseStoredMatch(status, r.need), offers };
}

export interface ProposalsClientOptions {
  /** fetch injecté (tests) ; par défaut le fetch global, résolu à chaque appel. */
  fetch?: typeof fetch;
}

export function createProposalsClient(options: ProposalsClientOptions = {}) {
  async function send(method: "GET" | "POST", path: string, body?: unknown, requestOptions: RequestOptions = {}): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const init: RequestInit = { method, headers, credentials: "same-origin", cache: "no-store", signal: requestOptions.signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(path, init);
    } catch {
      throw fixedError(0, requestOptions.signal?.aborted ? API_ABORTED : API_NETWORK_ERROR);
    }
    let json: unknown = undefined;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      if (isObject(json) && isObject(json.error) && typeof json.error.code === "string" && ERROR_CODE.test(json.error.code) && typeof json.error.message === "string" && json.error.message.length <= 300) {
        throw new ApiError(response.status, json.error.code, json.error.message);
      }
      throw fixedError(response.status, API_INVALID_RESPONSE);
    }
    return { status: response.status, json };
  }

  const id = (value: string): string => {
    if (!isUuid(value)) throw fixedError(0, API_INVALID_ID);
    return value;
  };

  function contract(status: number, json: unknown): Json {
    if (!isObject(json) || json.contractVersion !== PROPOSALS_CONTRACT_VERSION) throw fixedError(status, API_INVALID_RESPONSE);
    return json;
  }

  return {
    /** Les besoins qui correspondent aux annonces en ligne du vendeur (mêmes champs que « Acheteurs intéressés », regroupés par besoin). */
    async requests(requestOptions?: RequestOptions): Promise<SellerRequests> {
      const { status, json } = await send("GET", "/api/requests", undefined, requestOptions);
      const body = contract(status, json);
      need(status, Array.isArray(body.requests) && typeof body.offersTruncated === "boolean");
      return { requests: (body.requests as unknown[]).map((entry) => parseRequest(status, entry)), offersTruncated: body.offersTruncated as boolean };
    },
    async request(demandId: string, requestOptions?: RequestOptions): Promise<SellerRequest> {
      const { status, json } = await send("GET", `/api/requests/${id(demandId)}`, undefined, requestOptions);
      return parseRequest(status, contract(status, json).request);
    },
    /** Envoie une proposition (ou un devis, avec des lignes). Contrôlée AVANT l'envoi par la même règle que le serveur : un contenu refusé ne part pas. */
    async propose(demandId: string, input: ProposalInput, requestOptions?: RequestOptions): Promise<Proposal> {
      const wire: Record<string, unknown> = { offerId: input.offerId, validDays: input.validDays };
      if (input.lines.length > 0) wire.lines = input.lines;
      else wire.priceXof = input.priceXof;
      if (input.slot !== null) wire.slot = input.slot;
      if (input.warranty !== null) wire.warranty = input.warranty;
      if (input.note !== null) wire.note = input.note;
      const checked = checkProposalInput(wire);
      if (!checked.ok) throw fixedError(0, checked.reason === "phone" ? "phone_number_in_proposal" : "invalid_argument");
      const { status, json } = await send("POST", `/api/requests/${id(demandId)}/proposals`, wire, requestOptions);
      return parseProposal(status, contract(status, json).proposal);
    },
    /** Propositions envoyées (vendeur) ou reçues (acheteur). */
    async list(as: "seller" | "buyer", requestOptions?: RequestOptions): Promise<ProposalsList> {
      const { status, json } = await send("GET", `/api/proposals?as=${as}`, undefined, requestOptions);
      const body = contract(status, json);
      need(status, Array.isArray(body.proposals) && (body.pendingCount === null || isCount(body.pendingCount)));
      return { proposals: (body.proposals as unknown[]).map((entry) => parseProposal(status, entry)), pendingCount: body.pendingCount as number | null };
    },
    /** Accepter (acheteur : crée la commande), refuser (acheteur) ou retirer (vendeur). */
    async act(proposalId: string, action: ProposalAction, requestOptions?: RequestOptions): Promise<{ proposal: Proposal; orderId: string | null }> {
      if (action !== "accept" && action !== "decline" && action !== "withdraw") throw fixedError(0, "invalid_argument");
      const { status, json } = await send("POST", `/api/proposals/${id(proposalId)}/${action}`, {}, requestOptions);
      const body = contract(status, json);
      need(status, body.orderId === undefined || body.orderId === null || isUuid(body.orderId));
      return { proposal: parseProposal(status, body.proposal), orderId: (body.orderId as string | null | undefined) ?? null };
    },
  };
}

export type ProposalsClient = ReturnType<typeof createProposalsClient>;

/** Client du navigateur : fetch global, même origine. */
export const proposals: ProposalsClient = createProposalsClient();

export type ProposalErrorContext = "send" | "list" | "answer";

/** Message FIXE pour l'utilisateur d'après (contexte, statut, code) : jamais le texte d'une exception ni celui du serveur. */
export function describeProposalError(error: unknown, context: ProposalErrorContext): string {
  if (!(error instanceof ApiError)) return "Une erreur est survenue. Réessayez dans un instant.";
  if (error.code === API_NETWORK_ERROR) return "Connexion impossible. Vérifiez votre réseau et réessayez.";
  if (error.code === API_ABORTED) return "Requête interrompue.";
  if (error.status === 401) return "Votre session a expiré. Reconnectez-vous pour continuer.";
  if (error.status === 403) return "Requête refusée. Rechargez la page et réessayez.";
  if (error.code === "invalid_argument") return "Vérifiez les champs : le prix et les textes ne sont pas valides.";
  if (error.code === "phone_number_in_proposal") return "Pas de numéro de téléphone dans la proposition : l'acheteur vous répondra dans la messagerie de noma.";
  if (error.code === "proposal_active_exists") return "Une proposition de cette annonce est déjà en attente pour ce besoin.";
  if (error.code === "proposal_declined") return "L'acheteur a refusé une proposition de cette annonce pour ce besoin : vous ne pouvez plus lui en envoyer pour cette annonce.";
  if (error.code === "proposals_daily_limit") return "Vous avez atteint le nombre de propositions autorisées aujourd'hui. Réessayez demain.";
  if (error.code === "proposals_need_limit") return "Ce besoin a déjà reçu le nombre maximal de propositions en attente.";
  if (error.code === "proposal_expired") return "Cette proposition a expiré. La page va être actualisée.";
  if (error.code === "proposal_not_open") return "Cette proposition n'est plus en attente de réponse. La page va être actualisée.";
  if (error.code === "order_active_exists") return "Une commande est déjà en attente de confirmation du vendeur pour cette annonce.";
  if (error.code === "order_already_confirmed") return "Cet achat est déjà confirmé par le vendeur pour cette annonce.";
  if (error.code === "offer_not_available") return "Cette annonce n'est plus disponible.";
  if (error.status === 404) return context === "send" ? "Ce besoin ne correspond plus à cette annonce." : "Proposition introuvable.";
  if (error.status === 503) return "Le service est temporairement indisponible. Réessayez dans un instant.";
  if (error.status === 400) return "La demande n'est pas valide. Rechargez la page.";
  return "Une erreur est survenue. Réessayez dans un instant.";
}
