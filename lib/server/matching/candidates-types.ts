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
