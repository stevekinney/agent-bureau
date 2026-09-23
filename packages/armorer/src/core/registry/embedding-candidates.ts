import type { NormalizedTextQuery } from '../query-predicates';
import { addCandidates } from './candidate-sets';
import { getEmbeddingBandKeys, getEmbeddingSignatureBits } from './embedding-index';
import type { EmbeddingIndex, EmbeddingInfo, ToolDefinition } from './types';

export function selectEmbeddingCandidates(
  embeddingIndex: EmbeddingIndex,
  queryEmbedding: EmbeddingInfo,
  query: NormalizedTextQuery,
): Set<ToolDefinition> | null {
  if (!queryEmbedding.vector.length) return null;
  const bucketIndex = embeddingIndex.dimensions.get(queryEmbedding.vector.length);
  if (!bucketIndex) return embeddingIndex.missing.size ? new Set(embeddingIndex.missing) : null;

  const fields = query.fields.filter((field) => (query.weights[field] ?? 1) > 0);
  const bandKeys = getEmbeddingCandidateBandKeys(
    bucketIndex.projections,
    bucketIndex.bandSize,
    queryEmbedding,
  );
  if (!fields.length || !bandKeys) return null;

  const matched = collectEmbeddingBucketCandidates(bucketIndex.buckets, fields, bandKeys);
  addCandidates(matched.candidates, embeddingIndex.missing);
  if (!matched.matchedAny && !embeddingIndex.missing.size) return null;
  return matched.candidates;
}

function getEmbeddingCandidateBandKeys(
  projections: number[][],
  bandSize: number,
  queryEmbedding: EmbeddingInfo,
): number[] | null {
  const bits = getEmbeddingSignatureBits(projections, queryEmbedding.vector);
  return bits.length ? getEmbeddingBandKeys(bits, bandSize) : null;
}

function collectEmbeddingBucketCandidates(
  bucketsByField: EmbeddingIndex['dimensions'] extends Map<number, infer T>
    ? T extends { buckets: infer TBuckets }
      ? TBuckets
      : never
    : never,
  fields: readonly NormalizedTextQuery['fields'][number][],
  bandKeys: readonly number[],
): { candidates: Set<ToolDefinition>; matchedAny: boolean } {
  const candidates = new Set<ToolDefinition>();
  let matchedAny = false;
  for (const field of fields) {
    const buckets = bucketsByField[field];
    const matched = collectEmbeddingFieldCandidates(buckets, bandKeys);
    if (!matched) continue;
    matchedAny = true;
    addCandidates(candidates, matched);
  }
  return { candidates, matchedAny };
}

function collectEmbeddingFieldCandidates(
  buckets: Map<number, Set<ToolDefinition>>,
  bandKeys: readonly number[],
): Set<ToolDefinition> | null {
  const candidates = new Set<ToolDefinition>();
  for (const key of bandKeys) {
    const bucket = buckets.get(key);
    if (bucket) addCandidates(candidates, bucket);
  }
  return candidates.size ? candidates : null;
}
