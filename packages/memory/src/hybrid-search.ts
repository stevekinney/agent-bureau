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

function scoreCandidates(
  ids: Set<string>,
  indexById: Map<string, number>,
  candidates: HybridSearchCandidate[],
  vectorScores: Map<string, number>,
  textScores: Map<number, number>,
  vectorWeight: number,
  textWeight: number,
  threshold: number,
): HybridSearchResult[] {
  const results: HybridSearchResult[] = [];
  for (const id of ids) {
    const index = indexById.get(id);
    if (index === undefined) continue;
    const candidate = candidates[index]!;
    const vectorScore = vectorScores.get(id) ?? 0;
    const textScore = textScores.get(index) ?? 0;
    const combinedScore = vectorWeight * vectorScore + textWeight * textScore;
    if (combinedScore < threshold) continue;
    results.push({ ...candidate, combinedScore, vectorScore, textScore });
  }
  return results;
}

function buildSearchIndexes(
  vectorResults: VectorSearchResult[],
  textScores: Map<number, number>,
  candidates: HybridSearchCandidate[],
): {
  vectorScores: Map<string, number>;
  textScoresByIndex: Map<number, number>;
  candidateIds: Set<string>;
  candidateIndexById: Map<string, number>;
} {
  const vectorScores = new Map(vectorResults.map((result) => [result.id, result.score]));
  const textScoresByIndex = new Map(textScores);
  const candidateIds = new Set(vectorResults.map((result) => result.id));
  for (const [index] of textScores) {
    const candidate = candidates[index];
    if (candidate) candidateIds.add(candidate.id);
  }
  const candidateIndexById = new Map(candidates.map((candidate, index) => [candidate.id, index]));
  return { vectorScores, textScoresByIndex, candidateIds, candidateIndexById };
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

  const { vectorScores, textScoresByIndex, candidateIds, candidateIndexById } = buildSearchIndexes(
    vectorResults,
    textScores,
    candidates,
  );

  return scoreCandidates(
    candidateIds,
    candidateIndexById,
    candidates,
    vectorScores,
    textScoresByIndex,
    vectorWeight,
    textWeight,
    threshold,
  )
    .toSorted((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);
}
