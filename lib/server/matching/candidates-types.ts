import type { DemandRecord, OfferRecord } from "../catalog/types";

export interface CandidateQueryOptions {
  /**
   * Nombre maximum de candidats retournés par page.
   * Doit être un entier compris entre 1 et 100 (défaut : 20).
   */
  limit?: number;

  /**
   * Curseur opaque de pagination (encodé en base64url).
   * Contient le timestamp SQL exact (avec microsecondes) et l'identifiant UUID de départage.
   */
  cursor?: string | null;
}

export interface CandidateCursorPayload {
  createdAtIso: string;
  id: string;
}

export interface CandidatePage<T extends OfferRecord | DemandRecord> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

/**
 * Options INTERNES (worker temporel, lot 2E4C2) : restreignent la sélection des demandes candidates d'une offre à
 * UN seul candidat, avec exactement la même éligibilité que la recherche normale. Jamais exposées par une route :
 * `parseQueryParams` (http.ts) ne transmet que `limit` et `cursor`.
 */
export interface InternalDemandCandidateQueryOptions extends CandidateQueryOptions {
  /** UUID du seul candidat à considérer. Incompatible avec un `cursor` non nul. */
  candidateId?: string;
}
