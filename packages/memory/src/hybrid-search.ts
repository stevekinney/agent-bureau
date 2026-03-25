export interface HybridSearchOptions {
  /** Weight for vector similarity scores. Default: 0.7 */
  vectorWeight?: number;
  /** Weight for BM25 text scores. Default: 0.3 */
  textWeight?: number;
  /** Maximum number of results to return. Default: 10 */
  limit?: number;
  /** Minimum combined score to include a result. Default: 0 */
  threshold?: number;
  /** Multiplier for candidate pool size. Default: 3 */
  candidateMultiplier?: number;
}

export interface HybridSearchCandidate {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface HybridSearchResult {
  id: string;
  content: string;
  combinedScore: number;
  vectorScore: number;
  textScore: number;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface VectorSearchResult {
  id: string;
  score: number;
}

/**
 * Merges vector search results and BM25 text search results into a single ranked list.
 *
 * Each candidate's combined score is:
 *   vectorWeight * vectorScore + textWeight * textScore
 *
 * Results are sorted by combined score descending and filtered by threshold.
 */
export function mergeHybridResults(
  vectorResults: VectorSearchResult[],
  textScores: Map<number, number>,
  candidates: HybridSearchCandidate[],
  options?: HybridSearchOptions,
): HybridSearchResult[] {
  if (candidates.length === 0) return [];

  const vectorWeight = options?.vectorWeight ?? 0.7;
  const textWeight = options?.textWeight ?? 0.3;
  const limit = options?.limit ?? 10;
  const threshold = options?.threshold ?? 0;

  // Build a lookup from candidate id to vector score
  const vectorScoreById = new Map<string, number>();
  for (const vectorResult of vectorResults) {
    vectorScoreById.set(vectorResult.id, vectorResult.score);
  }

  // Build a lookup from candidate index to text score
  const textScoreByIndex = new Map<number, number>();
  for (const [index, score] of textScores) {
    textScoreByIndex.set(index, score);
  }

  // Collect all candidate IDs that appear in either result set
  const candidateIds = new Set<string>();
  for (const vectorResult of vectorResults) {
    candidateIds.add(vectorResult.id);
  }
  for (const [index] of textScores) {
    const candidate = candidates[index];
    if (candidate) {
      candidateIds.add(candidate.id);
    }
  }

  // Build candidate index by id for text score lookup
  const candidateIndexById = new Map<string, number>();
  for (let i = 0; i < candidates.length; i++) {
    candidateIndexById.set(candidates[i]!.id, i);
  }

  const results: HybridSearchResult[] = [];

  for (const id of candidateIds) {
    const candidateIndex = candidateIndexById.get(id);
    if (candidateIndex === undefined) continue;

    const candidate = candidates[candidateIndex]!;
    const vectorScore = vectorScoreById.get(id) ?? 0;
    const textSearchScore = textScoreByIndex.get(candidateIndex) ?? 0;
    const combinedScore = vectorWeight * vectorScore + textWeight * textSearchScore;

    if (combinedScore < threshold) continue;

    results.push({
      id: candidate.id,
      content: candidate.content,
      combinedScore,
      vectorScore,
      textScore: textSearchScore,
      metadata: candidate.metadata,
      createdAt: candidate.createdAt,
    });
  }

  results.sort((a, b) => b.combinedScore - a.combinedScore);

  return results.slice(0, limit);
}
