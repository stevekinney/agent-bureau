import { getToolEmbeddings } from './embeddings';
import { EMBEDDING_SEED, registryEmbeddingIndex } from './state';
import type {
  EmbeddingBucketIndex,
  EmbeddingIndex,
  EmbeddingVector,
  ToolDefinition,
} from './types';

export function buildEmbeddingIndex(tools: readonly ToolDefinition[]): EmbeddingIndex {
  const index: EmbeddingIndex = {
    dimensions: new Map(),
    missing: new Set(),
    size: tools.length,
  };
  for (const tool of tools) {
    addToolToEmbeddingIndex(index, tool);
  }
  return index;
}

export function getEmbeddingBucketIndex(
  index: EmbeddingIndex,
  dimension: number,
): EmbeddingBucketIndex {
  let bucketIndex = index.dimensions.get(dimension);
  if (!bucketIndex) {
    bucketIndex = createEmbeddingBucketIndex(dimension);
    index.dimensions.set(dimension, bucketIndex);
  }
  return bucketIndex;
}

export function createEmbeddingBucketIndex(dimension: number): EmbeddingBucketIndex {
  const configuration = getEmbeddingConfiguration(dimension);
  return {
    dimension,
    hashBits: configuration.hashBits,
    bandSize: configuration.bandSize,
    bands: configuration.bands,
    bucketSize: configuration.bucketSize,
    projections: createProjectionMatrix(dimension, configuration.hashBits),
    buckets: {
      name: new Map(),
      description: new Map(),
      tags: new Map(),
      schemaKeys: new Map(),
      metadataKeys: new Map(),
    },
  };
}

export function addToolToEmbeddingIndex(index: EmbeddingIndex, tool: ToolDefinition): void {
  const embeddings = getToolEmbeddings(tool);
  if (!embeddings?.length) {
    index.missing.add(tool);
    return;
  }
  index.missing.delete(tool);
  for (const entry of embeddings) {
    const dimension = entry.vector.length;
    if (!dimension) {
      continue;
    }
    const bucketIndex = getEmbeddingBucketIndex(index, dimension);
    const bits = getEmbeddingSignatureBits(bucketIndex.projections, entry.vector);
    if (!bits.length) {
      continue;
    }
    const keys = getEmbeddingBandKeys(bits, bucketIndex.bandSize);
    addEmbeddingBuckets(bucketIndex.buckets[entry.field], keys, tool);
  }
}

export function removeToolFromEmbeddingIndex(index: EmbeddingIndex, tool: ToolDefinition): void {
  index.missing.delete(tool);
  const embeddings = getToolEmbeddings(tool);
  if (!embeddings?.length) {
    return;
  }
  for (const entry of embeddings) {
    const bucketIndex = index.dimensions.get(entry.vector.length);
    if (!bucketIndex) {
      continue;
    }
    const bits = getEmbeddingSignatureBits(bucketIndex.projections, entry.vector);
    if (!bits.length) {
      continue;
    }
    const keys = getEmbeddingBandKeys(bits, bucketIndex.bandSize);
    removeEmbeddingBuckets(bucketIndex.buckets[entry.field], keys, tool);
  }
}

export function addEmbeddingBuckets(
  buckets: Map<number, Set<ToolDefinition>>,
  keys: number[],
  tool: ToolDefinition,
): void {
  for (const key of keys) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = new Set();
      buckets.set(key, bucket);
    }
    bucket.add(tool);
  }
}

export function removeEmbeddingBuckets(
  buckets: Map<number, Set<ToolDefinition>>,
  keys: number[],
  tool: ToolDefinition,
): void {
  for (const key of keys) {
    const bucket = buckets.get(key);
    if (!bucket) {
      continue;
    }
    bucket.delete(tool);
    if (!bucket.size) {
      buckets.delete(key);
    }
  }
}

export function getEmbeddingSignatureBits(
  projections: number[][],
  vector: EmbeddingVector,
): number[] {
  if (!projections.length || vector.length !== projections[0]?.length) {
    return [];
  }
  const bits = Array.from<number>({ length: projections.length });
  for (let i = 0; i < projections.length; i += 1) {
    const projection = projections[i];
    if (!projection) {
      return [];
    }
    let dot = 0;
    for (let j = 0; j < vector.length; j += 1) {
      const pv = projection[j];
      const vv = vector[j];
      if (pv === undefined || vv === undefined) {
        return [];
      }
      dot += pv * vv;
    }
    bits[i] = dot >= 0 ? 1 : 0;
  }
  return bits;
}

export function getEmbeddingBandKeys(bits: number[], bandSize: number): number[] {
  const bands = Math.ceil(bits.length / bandSize);
  const bucketSize = 1 << bandSize;
  const keys = Array.from<number>({ length: bands });
  for (let band = 0; band < bands; band += 1) {
    let bucket = 0;
    const offset = band * bandSize;
    for (let index = 0; index < bandSize; index += 1) {
      const bit = bits[offset + index] ?? 0;
      bucket = (bucket << 1) | (bit ? 1 : 0);
    }
    keys[band] = band * bucketSize + bucket;
  }
  return keys;
}

export function createProjectionMatrix(dimension: number, hashBits: number): number[][] {
  if (!dimension) {
    return [];
  }
  const rng = createRng(EMBEDDING_SEED ^ dimension);
  const projections: number[][] = [];
  for (let i = 0; i < hashBits; i += 1) {
    const vector = Array.from<number>({ length: dimension });
    for (let j = 0; j < dimension; j += 1) {
      vector[j] = rng() * 2 - 1;
    }
    projections.push(vector);
  }
  return projections;
}

export function getEmbeddingConfiguration(dimension: number): {
  hashBits: number;
  bandSize: number;
  bands: number;
  bucketSize: number;
} {
  let hashBits = 24;
  if (dimension <= 64) {
    hashBits = 16;
  } else if (dimension <= 192) {
    hashBits = 20;
  } else if (dimension > 512) {
    hashBits = 28;
  }
  const bandSize = 4;
  const bands = Math.ceil(hashBits / bandSize);
  const bucketSize = 1 << bandSize;
  return { hashBits, bandSize, bands, bucketSize };
}

export function createRng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function getRegistryEmbeddingIndex(
  registry: object,
  tools: readonly ToolDefinition[],
): EmbeddingIndex {
  const cached = registryEmbeddingIndex.get(registry);
  if (cached && cached.size === tools.length) {
    return cached;
  }
  const built = buildEmbeddingIndex(tools);
  registryEmbeddingIndex.set(registry, built);
  return built;
}
