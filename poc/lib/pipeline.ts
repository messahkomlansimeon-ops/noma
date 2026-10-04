/**
 * Pipeline de classement — séparé du script pour être testable hors ligne
 * (revue P2-8). Les alternatives hors budget ne sont JAMAIS fusionnées avec
 * les candidates : elles sont notées séparément, seulement si demandé.
 */
import type { ParsedNeed } from "./need";
import type { Classification } from "./filter";
import { collectBatchScores, scoreListings, type AiFn, type ScoredListing } from "./scoring";
export { scoreWithAi } from "./scoring";

export interface RankOptions {
  /** Scorer et présenter les alternatives hors budget (défaut : false). */
  includeAlternatives?: boolean;
  batchSize?: number;
  /** IA injectable — hors ligne en tests. */
  ai?: AiFn;
  /** Annulation : les lots restants sont sautés (revue P1). */
  signal?: AbortSignal;
}

export interface RankResult {
  candidates: ScoredListing[];
  alternatives: ScoredListing[];
  invalid: string[];
  scoredCount: number;
  total: number;
  model: string;
}

export async function rankAndSplit(
  need: ParsedNeed,
  classification: Classification,
  opts: RankOptions = {},
): Promise<RankResult> {
  const includeAlternatives = opts.includeAlternatives ?? false;
  const toScore = [
    ...classification.candidates,
    ...(includeAlternatives ? classification.alternatives : []),
  ];

  const batch = await collectBatchScores(need, toScore, {
    ai: opts.ai,
    batchSize: opts.batchSize ?? 10,
    signal: opts.signal,
  });

  const scored = scoreListings(need, toScore, batch.items.length > 0 ? batch.items : null);
  const sorted = [...scored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return {
    candidates: sorted.filter((s) =>
      classification.candidates.some(
        (c) => c.listing === s.evaluated.listing || c.listing.id === s.evaluated.listing.id,
      ),
    ),
    alternatives: includeAlternatives
      ? sorted.filter((s) =>
          classification.alternatives.some(
            (c) => c.listing === s.evaluated.listing || c.listing.id === s.evaluated.listing.id,
          ),
        )
      : [],
    invalid: batch.invalid,
    scoredCount: scored.filter((s) => s.aiStatus === "évalué par IA").length,
    total: scored.length,
    model: batch.model,
  };
}
