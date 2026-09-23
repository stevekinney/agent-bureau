import type { NormalizedTextQuery, TextQueryField } from '../query-predicates';
import { getToolEmbeddings, type EmbeddingInfo } from './embeddings';
import type { ToolDefinition } from './types';

export function scoreEmbeddingMatch(
  tool: ToolDefinition,
  query: NormalizedTextQuery,
  queryEmbedding: EmbeddingInfo,
): { score: number; field: TextQueryField; similarity: number } | undefined {
  const embeddings = getToolEmbeddings(tool);
  if (!embeddings?.length) return undefined;

  let best: { score: number; field: TextQueryField; similarity: number } | undefined;

  for (const entry of embeddings) {
    const weight = query.weights[entry.field] ?? 0;
    if (weight <= 0) continue;

    const sim = cosineSimilarity(
      queryEmbedding.vector,
      entry.vector,
      queryEmbedding.magnitude,
      entry.magnitude,
    );
    if (sim < query.threshold) continue;

    const score = sim * weight;
    if (!best || score > best.score) {
      best = { score, field: entry.field, similarity: sim };
    }
  }

  return best;
}

export function cosineSimilarity(a: number[], b: number[], magA: number, magB: number): number {
  if (magA === 0 || magB === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot / (magA * magB);
}
