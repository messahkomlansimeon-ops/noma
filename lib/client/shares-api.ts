/**
 * Couche cliente du lien de partage d'un besoin (lot FIN3-C4) : module partagé navigateur (aucun import serveur), mêmes règles que `reports-api.ts` : fetch même origine, JSON, toute erreur
 * devient une `ApiError { status, code }` construite UNIQUEMENT depuis le corps `{ error: { code, message } }` du serveur (ou un code fixe), réponses relues champ par champ (liste blanche).
 * Contrat : lib/server/shares/http.ts (`shares/v1`). Voir PARTAGE.md.
 */

import { API_ABORTED, API_INVALID_ID, API_INVALID_RESPONSE, API_NETWORK_ERROR, ApiError, isUuid, type RequestOptions } from "./api";
import { SHARES_CONTRACT_VERSION, SHARE_PATH_PREFIX, SHARE_TOKEN_PATTERN, type PublicNeed } from "../shares-rules";

export { SHARES_CONTRACT_VERSION };
export type { PublicNeed };

export interface ShareStatus {
  active: boolean;
  createdAt: string | null;
}

export interface CreatedShare {
  path: string;
  token: string;
  createdAt: string;
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isIso = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const nullableText = (value: unknown): boolean => value === null || (typeof value === "string" && value.length >= 1 && value.length <= 120);

function fixedError(status: number, code: string): ApiError {
  const messages: Record<string, string> = {
    [API_NETWORK_ERROR]: "Connexion au serveur impossible.",
    [API_INVALID_RESPONSE]: "Réponse du serveur inattendue.",
    [API_ABORTED]: "Requête interrompue.",
    [API_INVALID_ID]: "Identifiant invalide.",
  };
  return new ApiError(status, code, messages[code] ?? messages[API_INVALID_RESPONSE]);
}

function need(status: number, condition: boolean): void {
  if (!condition) throw fixedError(status, API_INVALID_RESPONSE);
}

export interface SharesClientOptions {
  /** fetch injecté (tests) ; par défaut le fetch global, résolu à chaque appel. */
  fetch?: typeof fetch;
}

export function createSharesClient(options: SharesClientOptions = {}) {
  async function send(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, requestOptions: RequestOptions = {}): Promise<{ status: number; json: unknown }> {
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
    if (!isObject(json) || json.contractVersion !== SHARES_CONTRACT_VERSION) throw fixedError(status, API_INVALID_RESPONSE);
    return json;
  }

  return {
    /** L'état du lien d'un de MES besoins : actif ou non (le jeton n'est jamais relisible). */
    async status(demandId: string, requestOptions?: RequestOptions): Promise<ShareStatus> {
      const { status, json } = await send("GET", `/api/demands/${id(demandId)}/share`, undefined, requestOptions);
      const share = contract(status, json).share;
      need(status, isObject(share) && typeof share.active === "boolean" && (share.createdAt === null || isIso(share.createdAt)));
      return { active: (share as Json).active as boolean, createdAt: (share as Json).createdAt as string | null };
    },
    /** Crée un lien (révoque le précédent). Le jeton n'est montré qu'ici. */
    async create(demandId: string, requestOptions?: RequestOptions): Promise<CreatedShare> {
      const { status, json } = await send("POST", `/api/demands/${id(demandId)}/share`, {}, requestOptions);
      const share = contract(status, json).share;
      need(status, isObject(share) && typeof share.token === "string" && SHARE_TOKEN_PATTERN.test(share.token) && share.path === `${SHARE_PATH_PREFIX}${share.token}` && isIso(share.createdAt));
      return { path: (share as Json).path as string, token: (share as Json).token as string, createdAt: (share as Json).createdAt as string };
    },
    async revoke(demandId: string, requestOptions?: RequestOptions): Promise<boolean> {
      const { status, json } = await send("DELETE", `/api/demands/${id(demandId)}/share`, undefined, requestOptions);
      const body = contract(status, json);
      need(status, typeof body.revoked === "boolean");
      return body.revoked as boolean;
    },
    /** PUBLIC (sans session) : le résumé d'un besoin partagé, sans identité. 404 pour tout lien qui ne marche plus. */
    async shared(token: string, requestOptions?: RequestOptions): Promise<PublicNeed> {
      if (!SHARE_TOKEN_PATTERN.test(token)) throw fixedError(404, "resource_not_found");
      const { status, json } = await send("GET", `/api/shared-needs/${token}`, undefined, requestOptions);
      const value = contract(status, json).need;
      need(
        status,
        isObject(value) && typeof value.title === "string" && value.title.length >= 1 && value.title.length <= 200 && nullableText(value.category) && nullableText(value.condition) && nullableText(value.location) &&
          nullableText(value.unit) && (value.quantity === null || (typeof value.quantity === "number" && Number.isSafeInteger(value.quantity) && value.quantity > 0)) &&
          (value.budget === null || (isObject(value.budget) && typeof value.budget.amount === "number" && Number.isSafeInteger(value.budget.amount) && value.budget.amount >= 0 && value.budget.currency === "XOF")),
      );
      const n = value as Json;
      return {
        title: n.title as string,
        category: n.category as string | null,
        condition: n.condition as string | null,
        location: n.location as string | null,
        quantity: n.quantity as number | null,
        unit: n.unit as string | null,
        budget: n.budget === null ? null : { amount: (n.budget as Json).amount as number, currency: "XOF" },
      };
    },
  };
}

export type SharesClient = ReturnType<typeof createSharesClient>;

/** Client du navigateur : fetch global, même origine. */
export const shares: SharesClient = createSharesClient();

/** Message FIXE pour l'utilisateur d'après (statut, code) : jamais le texte d'une exception ni celui du serveur. */
export function describeShareError(error: unknown): string {
  if (!(error instanceof ApiError)) return "Une erreur est survenue. Réessayez dans un instant.";
  if (error.code === API_NETWORK_ERROR) return "Connexion impossible. Vérifiez votre réseau et réessayez.";
  if (error.code === API_ABORTED) return "Requête interrompue.";
  if (error.status === 401) return "Votre session a expiré. Reconnectez-vous pour continuer.";
  if (error.status === 403) return "Requête refusée. Rechargez la page et réessayez.";
  if (error.code === "share_daily_limit") return "Vous avez créé le nombre de liens autorisés aujourd'hui. Réessayez demain.";
  if (error.status === 404) return "Ce besoin ne peut pas être partagé : il n'est plus actif, ou il fait partie d'une mission.";
  if (error.status === 503) return "Le service est temporairement indisponible. Réessayez dans un instant.";
  return "Une erreur est survenue. Réessayez dans un instant.";
}
