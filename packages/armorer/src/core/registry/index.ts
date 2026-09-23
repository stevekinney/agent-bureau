import { buildTextSearchIndex } from '../query-predicates';
import { filterTools } from './candidates';
import {
  addToolToEmbeddingIndex,
  buildEmbeddingIndex,
  removeToolFromEmbeddingIndex,
} from './embedding-index';
import { warmToolEmbeddings } from './embeddings';
import { addToolToTextIndex, removeToolFromTextIndex } from './field-token-index';
import {
  addToolToInvertedIndex,
  buildInvertedIndex,
  buildTextInvertedIndex,
  buildToolLookup,
  removeToolFromInvertedIndex,
} from './indexes';
import { rankTools } from './ranking';
import { applyPagination, selectMatchResults, selectQueryResults } from './selection';
import {
  queryCache,
  registryEmbeddingIndex,
  registryInvertedIndex,
  registryTextIndex,
  searchIndex,
  toolLookupCache,
} from './state';
import {
  createQueryCacheKey,
  emitQuery,
  emitSearch,
  isPlainObject,
  isToolRegistered,
  resolveTools,
} from './tool-access';
import type {
  QueryResult,
  QuerySelectionResult,
  ToolDefinition,
  ToolMatch,
  ToolQuery,
  ToolQueryInput,
  ToolSearchOptions,
  ToolSummary,
} from './types';

export { awaitToolEmbeddings, registerToolEmbeddings } from './embeddings';
export { createRegistry } from './registry';
export type {
  RegisterOptions,
  RegistryOptions,
  ResolveOptions,
  ToolRegistry,
  VersionSelector,
} from './registry';
export { buildRegistryNameCandidates, resolveName } from './resolve-name';
export type { RegistryResolutionResult, ResolveNameOptions } from './resolve-name';
export type {
  Embedder,
  EmbeddingEntry,
  EmbeddingMatch,
  EmbeddingVector,
  MetadataFilter,
  MetadataPrimitive,
  MetadataRange,
  QueryEvent,
  QueryResult,
  QuerySelectionResult,
  RiskFilter,
  SchemaFilter,
  SearchEvent,
  TagFilter,
  ToolMatch,
  ToolMatchDetails,
  ToolQuery,
  ToolQueryCriteria,
  ToolQueryInput,
  ToolQueryOptions,
  ToolQuerySelect,
  ToolRankContext,
  ToolRanker,
  ToolRankResult,
  ToolRegistryLike,
  ToolSearchOptions,
  ToolSearchRank,
  ToolSearchRanker,
  ToolSummary,
  ToolTieBreaker,
} from './types';

export function queryTools<TTool extends ToolDefinition>(
  input: ToolQueryInput<TTool>,
): QueryResult<TTool>;
export function queryTools<TTool extends ToolDefinition>(
  input: ToolQueryInput<TTool>,
  criteria?: ToolQuery<TTool> & { select?: 'tool' },
): QueryResult<TTool>;
export function queryTools<TTool extends ToolDefinition>(
  input: ToolQueryInput<TTool>,
  criteria: ToolQuery<TTool> & { select: 'name' },
): string[];
export function queryTools<TTool extends ToolDefinition>(
  input: ToolQueryInput<TTool>,
  criteria: ToolQuery<TTool> & { select: 'configuration' },
): TTool[];
export function queryTools<TTool extends ToolDefinition>(
  input: ToolQueryInput<TTool>,
  criteria: ToolQuery<TTool> & { select: 'summary' },
): ToolSummary<TTool>[];
export function queryTools(input: ToolQueryInput, criteria?: ToolQuery): QuerySelectionResult {
  const resolved = resolveTools(input);
  const cacheKey = resolved.registry ? createQueryCacheKey(criteria, resolved.tools.length) : null;
  const shouldCache = cacheKey && !cacheKey.startsWith('no-cache:');

  if (shouldCache) {
    const cached = queryCache.get(resolved.registry!)?.get(cacheKey);
    if (cached !== undefined) {
      emitQuery(resolved.dispatchEvent, criteria, cached);
      return cached;
    }
  }

  const tools = filterTools(
    resolved.tools,
    criteria,
    resolved.getIndex,
    resolved.getInvertedIndex,
    resolved.getTextIndex,
    resolved.embedder,
  );
  const results = selectQueryResults(
    applyPagination(tools, criteria?.limit, criteria?.offset),
    criteria,
  );

  if (shouldCache) {
    const registry = resolved.registry!;
    const registryCache = queryCache.get(registry) ?? new Map();
    registryCache.set(cacheKey, results);
    queryCache.set(registry, registryCache);
  }

  emitQuery(resolved.dispatchEvent, criteria, results);
  return results;
}

export function searchTools<TTool extends ToolDefinition>(
  input: ToolQueryInput<TTool>,
): ToolMatch<TTool>[];
export function searchTools<TTool extends ToolDefinition>(
  input: ToolQueryInput<TTool>,
  options?: ToolSearchOptions<TTool> & { select?: 'tool' },
): ToolMatch<TTool>[];
export function searchTools<TTool extends ToolDefinition>(
  input: ToolQueryInput<TTool>,
  options: ToolSearchOptions<TTool> & { select: 'name' },
): ToolMatch<string>[];
export function searchTools<TTool extends ToolDefinition>(
  input: ToolQueryInput<TTool>,
  options: ToolSearchOptions<TTool> & { select: 'configuration' },
): ToolMatch<TTool>[];
export function searchTools<TTool extends ToolDefinition>(
  input: ToolQueryInput<TTool>,
  options: ToolSearchOptions<TTool> & { select: 'summary' },
): ToolMatch<ToolSummary<TTool>>[];
export function searchTools(
  input: ToolQueryInput,
  options: ToolSearchOptions = {},
): ToolMatch<unknown>[] {
  if (!isPlainObject(options)) {
    throw new TypeError('search expects a ToolSearchOptions object');
  }
  const resolved = resolveTools(input);
  const tools = filterTools(
    resolved.tools,
    options.filter,
    resolved.getIndex,
    resolved.getInvertedIndex,
    resolved.getTextIndex,
    resolved.embedder,
  );
  const ranked = rankTools(
    tools,
    options,
    resolved.getIndex,
    resolved.embedder,
    resolved.getEmbeddingIndex,
  );
  const results = selectMatchResults(
    applyPagination(ranked, options.limit, options.offset),
    options,
  );
  emitSearch(resolved.dispatchEvent, options, results);
  return results;
}

export function reindexSearchIndex<TTool extends ToolDefinition>(
  input: ToolQueryInput<TTool>,
): void {
  const resolved = resolveTools(input);
  const registry = resolved.registry;
  const updateEmbeddingIndex =
    registry && resolved.embedder
      ? (tool: ToolDefinition) => {
          const embeddingIndex = registryEmbeddingIndex.get(registry);
          if (embeddingIndex && isToolRegistered(registry, tool)) {
            addToolToEmbeddingIndex(embeddingIndex, tool);
          }
        }
      : undefined;
  for (const tool of resolved.tools) {
    searchIndex.set(tool, buildTextSearchIndex(tool));
    toolLookupCache.set(tool, buildToolLookup(tool));
    if (resolved.embedder) {
      warmToolEmbeddings(tool, resolved.embedder, updateEmbeddingIndex);
    }
  }
  if (resolved.registry) {
    registryInvertedIndex.set(resolved.registry, buildInvertedIndex(resolved.tools));
    registryTextIndex.set(
      resolved.registry,
      buildTextInvertedIndex(resolved.tools, resolved.getIndex),
    );
    if (resolved.embedder) {
      registryEmbeddingIndex.set(resolved.registry, buildEmbeddingIndex(resolved.tools));
    }
  }
}

export function registerToolIndexes(
  registry: object,
  tool: ToolDefinition,
  toolsCount?: number,
): void {
  const textIndex = buildTextSearchIndex(tool);
  searchIndex.set(tool, textIndex);
  toolLookupCache.set(tool, buildToolLookup(tool));
  queryCache.delete(registry);

  const inverted = registryInvertedIndex.get(registry);
  if (inverted) {
    addToolToInvertedIndex(inverted, tool);
    inverted.size = toolsCount ?? inverted.size + 1;
  }
  const text = registryTextIndex.get(registry);
  if (text) {
    addToolToTextIndex(text, tool, textIndex);
    text.size = toolsCount ?? text.size + 1;
  }
  const embeddings = registryEmbeddingIndex.get(registry);
  if (embeddings) {
    addToolToEmbeddingIndex(embeddings, tool);
    embeddings.size = toolsCount ?? embeddings.size + 1;
  }
}

export function unregisterToolIndexes(
  registry: object,
  tool: ToolDefinition,
  toolsCount?: number,
): void {
  queryCache.delete(registry);
  const cachedText = searchIndex.get(tool) ?? buildTextSearchIndex(tool);

  const inverted = registryInvertedIndex.get(registry);
  if (inverted) {
    removeToolFromInvertedIndex(inverted, tool);
    inverted.size = toolsCount ?? Math.max(0, inverted.size - 1);
  }
  const text = registryTextIndex.get(registry);
  if (text) {
    removeToolFromTextIndex(text, tool, cachedText);
    text.size = toolsCount ?? Math.max(0, text.size - 1);
  }
  const embeddings = registryEmbeddingIndex.get(registry);
  if (embeddings) {
    removeToolFromEmbeddingIndex(embeddings, tool);
    embeddings.size = toolsCount ?? Math.max(0, embeddings.size - 1);
  }
}

export { internalRegistryTestUtilities } from './test-utilities';
