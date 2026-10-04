import type { Capabilities } from "../lib/query";
import type { RawListing } from "../lib/normalize";

export type SourceStatus =
  | "ok" // annonces trouvées
  | "empty" // succès sans annonce
  | "blocked" // mur de connexion / anti-bot
  | "timeout"
  | "error";

export interface SourceResult {
  source: string;
  /** URL/requête effective envoyée au connecteur. */
  query: string;
  capabilities: Capabilities;
  warnings: string[];
  listings: RawListing[];
  status: SourceStatus;
  durationMs: number;
  errors: string[];
  evidence?: string[];
  /** true = résultat servi depuis le cache (revue P2 : distinguer la durée
   *  de lecture actuelle de la durée réseau initiale). */
  fromCache?: boolean;
  /** Durée réseau de la recherche d'origine quand fromCache. */
  networkMs?: number;
}

/** Un connecteur ne lève jamais : les pannes sont isolées dans le résultat. */
export function emptyResult(
  source: string,
  query: string,
  capabilities: Capabilities,
  status: SourceStatus,
  durationMs: number,
  errors: string[] = [],
): SourceResult {
  return {
    source,
    query,
    capabilities,
    warnings: capabilities.unsupported,
    listings: [],
    status,
    durationMs,
    errors,
  };
}