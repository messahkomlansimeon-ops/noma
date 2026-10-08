import type { ImageRejection } from "./image";

/** Refus de domaine des photos (lot PH1) : code stable ; le texte montré à l'utilisateur est FIXE (http.ts), jamais une donnée de la base ni du fichier. */
export type MediaErrorCode =
  | ImageRejection
  | "resource_not_found"
  | "resource_archived"
  | "photo_limit"
  | "rate_limited"
  | "file_too_large"
  | "request_timeout"
  | "empty_body"
  | "invalid_request"
  | "invalid_key"
  | "storage_unavailable";

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  /** Pour `rate_limited` : secondes avant une nouvelle tentative (au moins 1). */
  readonly retryAfterSeconds: number | undefined;

  constructor(code: MediaErrorCode, retryAfterSeconds?: number) {
    super(code);
    this.name = "MediaError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
