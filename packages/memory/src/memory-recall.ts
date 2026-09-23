import { cosineSimilarity, type EmbeddingVectorLike } from '@lostgradient/embeddings';
import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { HybridSearchCandidate, VectorSearchResult } from './hybrid-search';
import { mergeHybridResults } from './hybrid-search';
import { SOURCE_DOCUMENT_KEY } from './ingest';
import { applyMaximalMarginalRelevance } from './maximal-marginal-relevance';
import type { MemoryRecord, MemoryRecordScope, MemoryRecordStorage } from './memory-record-storage';
import { extractKeywords } from './query-expansion';
import { applyTemporalDecay } from './temporal-decay';
import { filterByValidity } from './temporal-validity';
import { computeBM25Scores } from './text-search';
import type { Memory, MemoryMetadata, MemorySearchOptions, MemorySearchResult } from './types';

function rankRecordsByVector(
  records: readonly MemoryRecord[],
  queryVector: EmbeddingVectorLike,
  threshold?: number,
): { id: string; score: number; record: MemoryRecord }[] {
  return records
    .map((record) => ({
      id: record.id,
      score: cosineSimilarity(queryVector, record.vector),
      record,
    }))
    .filter((hit) => threshold === undefined || hit.score >= threshold)
    .toSorted((left, right) => right.score - left.score);
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' ? value : undefined;
}

function metadataWithNamespace(
  metadata: Record<string, unknown>,
  namespace: string,
): MemoryMetadata {
  const source = metadataString(metadata, 'source');
  return {
    ...metadata,
    namespace,
    source:
      source === 'manual' ||
      source === 'tool' ||
      source === 'experiential' ||
      source === 'auto-capture'
        ? source
        : 'manual',
  };
}

interface RecallContext {
  storage: MemoryRecordStorage;
  defaultNamespace: string;
  defaultSearchOptions: Partial<MemorySearchOptions> | undefined;
  textSearchProvider: import('./text-search-provider').TextSearchProvider | undefined;
  temporalValidity: boolean;
  runtime: RuntimeServices;
  embed(query: string): Promise<number[]>;
  scopeFor(namespace: string): MemoryRecordScope;
  toMemoryMetadata(record: MemoryRecord): MemoryMetadata;
}

function applyResultPolicies(
  initial: (MemorySearchResult & { vector?: number[] })[],
  options: MemorySearchOptions,
  asOf: number | undefined,
  limit: number,
  runtime: RuntimeServices,
): (MemorySearchResult & { vector?: number[] })[] {
  let results = asOf === undefined ? initial : filterByValidity(initial, asOf);
  if (options.temporalDecay)
    results = applyTemporalDecay(results, {
      halfLifeMilliseconds: options.temporalDecay.halfLifeMilliseconds,
      evergreenExempt: options.temporalDecay.evergreenExempt ?? true,
      runtime,
    });
  if (options.diversify)
    results = applyMaximalMarginalRelevance(results, limit, { lambda: options.diversify.lambda });
  return results;
}

async function buildTextScores(
  query: string,
  candidates: HybridSearchCandidate[],
  provider: RecallContext['textSearchProvider'],
  namespace: string,
): Promise<Map<number, number>> {
  if (provider) {
    const idScores = await provider.search(query, namespace);
    return new Map(
      candidates.flatMap((candidate, index) => {
        const score = idScores.get(candidate.id);
        return score === undefined ? [] : [[index, score] as [number, number]];
      }),
    );
  }
  const keywords = extractKeywords(query);
  const documents = candidates.map((candidate) => candidate.content);
  const rawScores =
    keywords.length > 0
      ? computeBM25Scores(query, documents, { queryTerms: keywords })
      : computeBM25Scores(query, documents);
  return new Map(Array.from(rawScores, ([index, score]) => [index, score / (1 + score)]));
}

function dedupeSourceResults(
  results: (MemorySearchResult & { vector?: number[] })[],
): (MemorySearchResult & { vector?: number[] })[] {
  const best = new Map<string, number>();
  for (let index = 0; index < results.length; index++) {
    const source = metadataString(results[index]!.metadata, SOURCE_DOCUMENT_KEY);
    if (!source) continue;
    const previous = best.get(source);
    if (previous === undefined || results[index]!.score > results[previous]!.score)
      best.set(source, index);
  }
  const kept = new Set(best.values());
  return results.filter((result, index) => {
    const source = metadataString(result.metadata, SOURCE_DOCUMENT_KEY);
    return source === undefined || kept.has(index);
  });
}

export function createRecall(context: RecallContext): Memory['recall'] {
  const {
    storage,
    defaultNamespace,
    defaultSearchOptions,
    textSearchProvider,
    temporalValidity,
    runtime,
  } = context;
  const embed = (query: string): Promise<number[]> => context.embed(query);
  const scopeFor = (namespace: string): MemoryRecordScope => context.scopeFor(namespace);
  const toMemoryMetadata = (record: MemoryRecord): MemoryMetadata =>
    context.toMemoryMetadata(record);

  async function recallVector(
    queryVector: EmbeddingVectorLike,
    scope: MemoryRecordScope,
    limit: number,
    threshold: number,
    asOf: number | undefined,
    options: MemorySearchOptions,
  ): Promise<MemorySearchResult[]> {
    // Indexed backends may cap one-shot search limits (Cloudflare caps at
    // 200). Temporal validity needs the whole candidate set so invalid top
    // hits cannot shrink K, so rank the paginatable canonical corpus
    // locally instead of requesting an unbounded ANN top-K.
    const hits =
      asOf === undefined
        ? await storage.searchByVector(queryVector, scope, {
            limit: limit * 3,
            threshold,
          })
        : rankRecordsByVector(await storage.list(scope), queryVector, threshold);

    let results: (MemorySearchResult & { vector?: number[] })[] = hits.map((hit) => ({
      id: hit.id,
      content: hit.record.content,
      score: hit.score,
      metadata: toMemoryMetadata(hit.record),
      createdAt: hit.record.createdAt,
      vector: Array.from(hit.record.vector),
    }));

    results = applyResultPolicies(results, options, asOf, limit, runtime);

    return results.slice(0, limit).map(({ vector: _vector, ...rest }) => rest);
  }

  async function recallHybrid(
    query: string,
    queryVector: EmbeddingVectorLike,
    scope: MemoryRecordScope,
    namespace: string,
    limit: number,
    threshold: number,
    vectorWeight: number,
    textWeight: number,
    asOf: number | undefined,
    options: MemorySearchOptions,
  ): Promise<MemorySearchResult[]> {
    // Hybrid path: enumerate the scoped corpus for BM25, run vector search
    // through storage, then merge.
    const corpus = await storage.list(scope);
    if (corpus.length === 0) return [];
    // Validity filtering happens after hybrid ranking. Rank the canonical
    // corpus locally when enabled so backend ANN limits cannot shrink K.
    const vectorResultLimit = asOf === undefined ? limit * 3 : corpus.length;

    const recordsById = new Map(corpus.map((record) => [record.id, record]));
    const candidates: HybridSearchCandidate[] = corpus.map((record) => ({
      id: record.id,
      content: record.content,
      metadata: record.metadata,
      createdAt: record.createdAt,
    }));

    // Vector similarity search — no threshold here: the recall threshold is
    // applied to the COMBINED score by mergeHybridResults. Pre-filtering the
    // vector half would discard valid hybrid matches.
    const vectorHits =
      asOf === undefined
        ? await storage.searchByVector(queryVector, scope, { limit: vectorResultLimit })
        : rankRecordsByVector(corpus, queryVector);
    const vectorResults: VectorSearchResult[] = vectorHits.map((hit) => ({
      id: hit.id,
      score: hit.score,
    }));

    const textScores = await buildTextScores(query, candidates, textSearchProvider, namespace);

    // Merge hybrid results.
    const hybridResults = mergeHybridResults(vectorResults, textScores, candidates, {
      vectorWeight,
      textWeight,
      limit: vectorResultLimit,
      threshold,
    });

    // Convert to MemorySearchResult with vectors for MMR.
    let results: (MemorySearchResult & { vector?: number[] })[] = hybridResults.map((result) => {
      const matched = recordsById.get(result.id);
      return {
        id: result.id,
        content: result.content,
        score: result.combinedScore,
        metadata: matched
          ? toMemoryMetadata(matched)
          : metadataWithNamespace(result.metadata, namespace),
        createdAt: result.createdAt,
        ...(matched ? { vector: Array.from(matched.vector) } : {}),
      };
    });

    if (asOf !== undefined) {
      results = filterByValidity(results, asOf);
    }

    // Apply temporal decay if configured.
    if (options.temporalDecay) {
      results = applyTemporalDecay(results, {
        halfLifeMilliseconds: options.temporalDecay.halfLifeMilliseconds,
        evergreenExempt: options.temporalDecay.evergreenExempt ?? true,
        runtime,
      });
    }

    // Apply MMR for diversity if configured.
    if (options.diversify) {
      results = applyMaximalMarginalRelevance(results, limit, {
        lambda: options.diversify.lambda,
      });
    }

    results = dedupeSourceResults(results);

    // Final limit and strip vectors from output.
    return results.slice(0, limit).map(({ vector: _vector, ...rest }) => rest);
  }
  return async (
    query: string,
    searchOptions?: MemorySearchOptions,
  ): Promise<MemorySearchResult[]> => {
    const mergedOptions = { ...defaultSearchOptions, ...searchOptions };
    const namespace = mergedOptions.namespace ?? defaultNamespace;
    const scope = scopeFor(namespace);
    const limit = mergedOptions.limit ?? 10;
    const threshold = mergedOptions.threshold ?? 0;
    const vectorWeight = mergedOptions.vectorWeight ?? 0.7;
    const textWeight = mergedOptions.textWeight ?? 0.3;

    const queryVector = await embed(query);
    // Resolve once so both search branches filter to the same instant. Only
    // active when the flag is set — otherwise `asOf` is inert.
    const asOf = temporalValidity ? (mergedOptions.asOf ?? runtime.clock.now()) : undefined;

    // When vectorOnly is set, skip BM25 and return pure cosine similarity
    // scores filtered by the (cosine-semantics) threshold.
    if (mergedOptions.vectorOnly) {
      return recallVector(queryVector, scope, limit, threshold, asOf, mergedOptions);
    }

    return recallHybrid(
      query,
      queryVector,
      scope,
      namespace,
      limit,
      threshold,
      vectorWeight,
      textWeight,
      asOf,
      mergedOptions,
    );
  };
}
