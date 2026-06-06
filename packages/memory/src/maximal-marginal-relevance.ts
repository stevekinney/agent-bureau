import { cosineSimilarity } from 'interoperability';

export interface MaximalMarginalRelevanceOptions {
  /** Tradeoff between relevance (1) and diversity (0). */
  lambda: number;
}

/**
 * Applies Maximal Marginal Relevance to re-rank results, balancing relevance and diversity.
 *
 * MMR(d) = lambda * relevance - (1 - lambda) * max_similarity_to_selected
 *
 * Relevance is taken from each candidate's `score` field (typically a pre-computed
 * similarity score from the search backend). The diversity term uses cosine
 * similarity between candidate vectors and already-selected vectors.
 *
 * Items without vectors fall back to score-only ordering (sorted descending by score).
 */
export function applyMaximalMarginalRelevance<T extends { score: number; vector?: number[] }>(
  results: T[],
  limit: number,
  options: MaximalMarginalRelevanceOptions,
): T[] {
  if (results.length === 0) return [];

  // If no items have vectors, fall back to score-only ordering
  const hasAnyVectors = results.some((r) => r.vector !== undefined);
  if (!hasAnyVectors) {
    return [...results].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  const { lambda } = options;
  const selected: T[] = [];
  const remaining = new Set(results.map((_, index) => index));
  const effectiveLimit = Math.min(limit, results.length);

  for (let step = 0; step < effectiveLimit; step++) {
    let bestIndex = -1;
    let bestMMRScore = -Infinity;

    for (const index of remaining) {
      const candidate = results[index]!;
      const relevance = candidate.score;

      // Compute max similarity to already-selected items
      let maxSimilarity = 0;
      if (candidate.vector) {
        for (const selectedItem of selected) {
          if (selectedItem.vector) {
            const similarity = cosineSimilarity(candidate.vector, selectedItem.vector);
            maxSimilarity = Math.max(maxSimilarity, similarity);
          }
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;

      if (mmrScore > bestMMRScore) {
        bestMMRScore = mmrScore;
        bestIndex = index;
      }
    }

    if (bestIndex >= 0) {
      selected.push(results[bestIndex]!);
      remaining.delete(bestIndex);
    }
  }

  return selected;
}
