import type { EmissionEvent } from 'event-emission';
import type { z } from 'zod';

import type { ToolIdentity } from '../identity';
import {
  buildTextSearchIndex,
  type NormalizedTextQuery,
  normalizeTextQuery,
  schemaHasKeys,
  schemaMatches,
  scoreTextMatchFromIndex,
  scoreTextMatchValueFromIndex,
  tagsMatchAll,
  tagsMatchAny,
  tagsMatchNone,
  type TextQuery,
  type TextQueryField,
  type TextSearchIndex,
  type ToolPredicate,
} from '../query-predicates';
import type { ToolRisk } from '../risk';
import { getSchemaKeys, type ToolSchema } from '../schema-utilities';
import type { JsonObject } from '../serialization/json';
import { normalizeTags } from '../tag-utilities';
import type { AnyToolDefinition as ToolDefinition } from '../tool-definition';
import {
  type Embedder,
  type EmbeddingInfo,
  type EmbeddingVector,
  getQueryEmbeddingInfo,
  getRegistryEmbedder,
  getToolEmbeddings,
  warmToolEmbeddings,
} from './embeddings';

export type {
  RegisterOptions,
  RegistryOptions,
  ResolveOptions,
  ToolRegistry,
  VersionSelector,
} from './registry';
export { createRegistry } from './registry';

/**
 * Tag filtering for tool queries.
 */
export type TagFilter<TTag extends string = string> = {
  /** Match any of these tags (OR). */
  any?: readonly TTag[];
  /** Require all of these tags (AND). */
  all?: readonly TTag[];
  /** Exclude tools with any of these tags. */
  none?: readonly TTag[];
};

export type SchemaFilter<TSchemaKey extends string = string> = {
  /** Require schema to contain these keys. */
  keys?: readonly TSchemaKey[];
  /** Loosely match a schema shape. */
  matches?: ToolSchema;
};

export type MetadataPrimitive = string | number | boolean | null;

export type MetadataRange = {
  min?: number;
  max?: number;
};

export type MetadataFilter<TMetadataKey extends string = string> = {
  /** Require metadata to include these keys. */
  has?: readonly TMetadataKey[];
  /** Require metadata values to equal these fields. */
  eq?: Partial<Record<TMetadataKey, unknown>>;
  /** Require metadata values to contain these substrings or values. */
  contains?: Partial<
    Record<TMetadataKey, MetadataPrimitive | readonly MetadataPrimitive[]>
  >;
  /** Require metadata values to start with these strings. */
  startsWith?: Partial<Record<TMetadataKey, string>>;
  /** Require metadata numeric values to fall within ranges. */
  range?: Partial<Record<TMetadataKey, MetadataRange>>;
  /** Custom metadata predicate. */
  predicate?: (metadata: JsonObject | undefined) => boolean;
};

export type RiskFilter = {
  readOnly?: boolean;
  mutates?: boolean;
  dangerous?: boolean;
  permissions?: readonly string[];
};

export type ToolQuerySelect = 'tool' | 'name' | 'configuration' | 'summary';

export type ToolSummary<TTool extends ToolDefinition = ToolDefinition> = {
  id: TTool['id'];
  identity: ToolIdentity;
  name: string;
  description: string;
  tags?: readonly string[];
  schemaKeys?: readonly string[];
  metadata?: JsonObject;
  risk?: ToolRisk;
  lifecycle?: TTool['lifecycle'];
  deprecated?: boolean;
  schema?: ToolSchema;
  configuration?: TTool;
};

type ToolTagFromMarker<TTool extends ToolDefinition> = TTool extends {
  __tags?: readonly (infer TTag)[];
}
  ? Extract<TTag, string>
  : never;

type ToolTagFromDefinition<TTool extends ToolDefinition> =
  TTool['tags'] extends readonly (infer TTag)[] ? Extract<TTag, string> : never;

type ToolQueryTag<TTool extends ToolDefinition> = [
  ToolTagFromMarker<TTool> | ToolTagFromDefinition<TTool>,
] extends [never]
  ? string
  : ToolTagFromMarker<TTool> | ToolTagFromDefinition<TTool>;

type ToolQuerySchemaKey<TTool extends ToolDefinition> = TTool extends {
  __schema?: infer TSchema;
}
  ? TSchema extends z.ZodTypeAny
    ? Extract<keyof z.infer<TSchema>, string>
    : string
  : string;

type ToolQueryMetadataKey<TTool extends ToolDefinition> = TTool extends {
  metadata: infer TMetadata;
}
  ? Extract<keyof NonNullable<TMetadata>, string>
  : TTool extends { metadata?: infer TMetadata }
    ? Extract<keyof NonNullable<TMetadata>, string>
    : string;

/**
 * Criteria for querying tools.
 *
 * All criteria are combined with AND logic.
 */
export type ToolQueryCriteria<TTool extends ToolDefinition = ToolDefinition> = {
  /** Match tools within a specific namespace. */
  namespace?: string | readonly string[];
  /** Match tools by exact version. */
  version?: string | readonly string[];
  /** Risk filtering based on declarative risk flags. */
  risk?: RiskFilter;
  /** Match deprecated or non-deprecated tools. */
  deprecated?: boolean;
  /** Tag-based filtering. */
  tags?: TagFilter<ToolQueryTag<TTool>>;
  /** Fuzzy text search across name, description, tags, schema keys, and metadata keys. */
  text?: TextQuery;
  /** Schema filtering by keys or shape. */
  schema?: SchemaFilter<ToolQuerySchemaKey<TTool>>;
  /** Metadata filtering. */
  metadata?: MetadataFilter<ToolQueryMetadataKey<TTool>>;
  /** Custom predicate over the full tool. */
  predicate?: ToolPredicate<TTool>;
  /** Require all nested criteria to match. */
  and?: ToolQueryCriteria<TTool>[];
  /** Require at least one nested criterion to match. */
  or?: ToolQueryCriteria<TTool>[];
  /** Exclude tools that match the nested criteria. */
  not?: ToolQueryCriteria<TTool> | ToolQueryCriteria<TTool>[];
};

export type ToolQueryOptions = {
  /** Limit the number of results returned. */
  limit?: number;
  /** Skip a number of results before applying limit. */
  offset?: number;
  /** Select a lighter result shape. */
  select?: ToolQuerySelect;
  /** Include the tool configuration on summary results. */
  includeToolConfiguration?: boolean;
  /** Include the tool schema on summary results. */
  includeSchema?: boolean;
};

export type ToolQuery<TTool extends ToolDefinition = ToolDefinition> =
  ToolQueryCriteria<TTool> & ToolQueryOptions;

export type QueryResult<TTool extends ToolDefinition = ToolDefinition> = TTool[];

export type QuerySelectionResult<TTool extends ToolDefinition = ToolDefinition> =
  | TTool[]
  | string[]
  | ToolSummary<TTool>[];

export type ToolSearchRank = {
  /** Prefer tools with these tags. */
  tags?: readonly string[];
  /** Weight multipliers for specific tags. Higher values increase the score contribution of matching tags. */
  tagWeights?: Record<string, number>;
  /** Prefer tools that match this text. */
  text?: TextQuery;
  /** Optional ranking weights. */
  weights?: {
    tags?: number;
    text?: number;
  };
};

export type ToolMatchDetails = {
  fields?: TextQueryField[];
  tags?: string[];
  schemaKeys?: string[];
  metadataKeys?: string[];
  embedding?: EmbeddingMatch;
};

export type EmbeddingMatch = {
  field: TextQueryField;
  score: number;
};

export type ToolRankResult = {
  score: number;
  reasons?: string[];
  matches?: ToolMatchDetails;
  override?: boolean;
  exclude?: boolean;
};

export type ToolRankContext = {
  text?: NormalizedTextQuery | null;
  preferredTags: string[];
  tagWeights: Record<string, number>;
  weights: {
    tags: number;
    text: number;
  };
  index: TextSearchIndex;
};

export type ToolRanker<TTool extends ToolDefinition = ToolDefinition> = (
  tool: TTool,
  context: ToolRankContext,
) => ToolRankResult | number | null | undefined;

/** Alias for ToolRanker for clarity when used with searchTools. */
export type ToolSearchRanker<TTool extends ToolDefinition = ToolDefinition> =
  ToolRanker<TTool>;

export type ToolTieBreaker<TTool extends ToolDefinition = ToolDefinition> =
  | 'name'
  | 'none'
  | ((a: ToolMatch<TTool>, b: ToolMatch<TTool>) => number);

export type ToolSearchOptions<TTool extends ToolDefinition = ToolDefinition> = {
  /** Filter tools before ranking. */
  filter?: ToolQueryCriteria<TTool>;
  /** Ranking preferences. */
  rank?: ToolSearchRank;
  /** Custom ranker for domain-specific scoring. */
  ranker?: ToolRanker<TTool>;
  /** Deterministic tie-breaking for equal scores. */
  tieBreaker?: ToolTieBreaker<TTool>;
  /** Limit the number of results returned. */
  limit?: number;
  /** Skip a number of results before applying limit. */
  offset?: number;
  /** Select a lighter result shape. */
  select?: ToolQuerySelect;
  /** Include the tool configuration on summary results. */
  includeToolConfiguration?: boolean;
  /** Include the tool schema on summary results. */
  includeSchema?: boolean;
  /** Include match details in results. */
  explain?: boolean;
};

export type ToolMatch<T = ToolDefinition> = {
  tool: T;
  score: number;
  reasons: string[];
  matches?: ToolMatchDetails;
};

export type ToolRegistryLike<TTool extends ToolDefinition = ToolDefinition> = {
  tools: () => readonly TTool[];
  dispatchEvent?: (event: EmissionEvent<unknown>) => boolean;
};

export type ToolQueryInput<TTool extends ToolDefinition = ToolDefinition> =
  | TTool
  | ToolRegistryLike<TTool>
  | Iterable<TTool>
  | readonly TTool[];

export type { Embedder, EmbeddingVector };

export type QueryEvent<TTool extends ToolDefinition = ToolDefinition> = {
  criteria?: ToolQuery<TTool>;
  results: QuerySelectionResult<TTool>;
};
export type SearchEvent<TTool extends ToolDefinition = ToolDefinition> = {
  options: ToolSearchOptions<TTool>;
  results: ToolMatch<TTool>[];
};

const searchIndex = new WeakMap<ToolDefinition, TextSearchIndex>();
const toolLookupCache = new WeakMap<ToolDefinition, ToolLookupCache>();
const registryInvertedIndex = new WeakMap<object, InvertedIndex>();
const registryTextIndex = new WeakMap<object, TextInvertedIndex>();
const registryEmbeddingIndex = new WeakMap<object, EmbeddingIndex>();
const queryCache = new WeakMap<object, Map<string, QuerySelectionResult>>();
const BIGRAM_SIZE = 2;
const GRAM_SIZE = 3;
const EMBEDDING_SEED = 0x1a2b3c4d;

type ToolLookupCache = {
  tags: string[];
  tagsLower: string[];
  tagSet: Set<string>;
  schemaKeysLower: string[];
  schemaKeySet: Set<string>;
};

type InvertedIndex = {
  tagIndex: Map<string, Set<ToolDefinition>>;
  schemaKeyIndex: Map<string, Set<ToolDefinition>>;
  size: number;
};

type FieldTokenIndex = {
  map: Map<string, Set<ToolDefinition>>;
  tokens: string[];
  lengthMap: Map<number, Set<ToolDefinition>>;
  lengths: number[];
  charMap: Map<string, Set<ToolDefinition>>;
  bigramMap: Map<string, Set<ToolDefinition>>;
  gramMap: Map<string, Set<ToolDefinition>>;
};

type TextInvertedIndex = {
  fields: Record<TextQueryField, FieldTokenIndex>;
  size: number;
};

type EmbeddingBucketIndex = {
  dimension: number;
  hashBits: number;
  bandSize: number;
  bands: number;
  bucketSize: number;
  projections: number[][];
  buckets: Record<TextQueryField, Map<number, Set<ToolDefinition>>>;
};

type EmbeddingIndex = {
  dimensions: Map<number, EmbeddingBucketIndex>;
  missing: Set<ToolDefinition>;
  size: number;
};

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
export function queryTools(
  input: ToolQueryInput,
  criteria?: ToolQuery,
): QuerySelectionResult {
  const resolved = resolveTools(input);

  const cacheKey = resolved.registry
    ? createQueryCacheKey(criteria, resolved.tools.length)
    : null;
  const shouldCache = cacheKey && !cacheKey.startsWith('no-cache:');

  if (shouldCache) {
    const registryCache = queryCache.get(resolved.registry!);
    if (registryCache) {
      const cached = registryCache.get(cacheKey);
      if (cached !== undefined) {
        emitQuery(resolved.dispatchEvent, criteria, cached);
        return cached;
      }
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
  const paged = applyPagination(tools, criteria?.limit, criteria?.offset);
  const results = selectQueryResults(paged, criteria);

  if (shouldCache) {
    let registryCache = queryCache.get(resolved.registry!);
    if (!registryCache) {
      registryCache = new Map();
      queryCache.set(resolved.registry!, registryCache);
    }
    registryCache.set(cacheKey, results);
  }

  emitQuery(resolved.dispatchEvent, criteria, results);
  return results;
}

/**
 * @deprecated Use `queryTools` for tool discovery.
 */
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
  const paged = applyPagination(ranked, options.limit, options.offset);
  const results = selectMatchResults(paged, options);
  emitSearch(resolved.dispatchEvent, options, results);
  return results;
}

export function reindexSearchIndex<TTool extends ToolDefinition>(
  input: ToolQueryInput<TTool>,
): void {
  const resolved = resolveTools(input);
  const updateEmbeddingIndex =
    resolved.registry && resolved.embedder
      ? (tool: ToolDefinition) => {
          const registry = resolved.registry as ToolRegistryLike;
          const embeddingIndex = registryEmbeddingIndex.get(registry);
          if (!embeddingIndex) {
            return;
          }
          if (!isToolRegistered(registry, tool)) {
            return;
          }
          addToolToEmbeddingIndex(embeddingIndex, tool);
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
    if (typeof toolsCount === 'number') {
      inverted.size = toolsCount;
    } else {
      inverted.size += 1;
    }
  }

  const text = registryTextIndex.get(registry);
  if (text) {
    addToolToTextIndex(text, tool, textIndex);
    if (typeof toolsCount === 'number') {
      text.size = toolsCount;
    } else {
      text.size += 1;
    }
  }

  const embeddings = registryEmbeddingIndex.get(registry);
  if (embeddings) {
    addToolToEmbeddingIndex(embeddings, tool);
    if (typeof toolsCount === 'number') {
      embeddings.size = toolsCount;
    } else {
      embeddings.size += 1;
    }
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
    if (typeof toolsCount === 'number') {
      inverted.size = toolsCount;
    } else {
      inverted.size = Math.max(0, inverted.size - 1);
    }
  }

  const text = registryTextIndex.get(registry);
  if (text) {
    removeToolFromTextIndex(text, tool, cachedText);
    if (typeof toolsCount === 'number') {
      text.size = toolsCount;
    } else {
      text.size = Math.max(0, text.size - 1);
    }
  }

  const embeddings = registryEmbeddingIndex.get(registry);
  if (embeddings) {
    removeToolFromEmbeddingIndex(embeddings, tool);
    if (typeof toolsCount === 'number') {
      embeddings.size = toolsCount;
    } else {
      embeddings.size = Math.max(0, embeddings.size - 1);
    }
  }
}

function resolveTools(input: ToolQueryInput): {
  tools: readonly ToolDefinition[];
  dispatchEvent?: ToolRegistryLike['dispatchEvent'];
  getIndex: (tool: ToolDefinition) => TextSearchIndex;
  getInvertedIndex?: () => InvertedIndex;
  getTextIndex: () => TextInvertedIndex;
  getEmbeddingIndex?: () => EmbeddingIndex;
  embedder?: Embedder;
  registry?: object;
} {
  const getIndex = (tool: ToolDefinition) => {
    const cached = searchIndex.get(tool);
    if (cached) return cached;
    const index = buildTextSearchIndex(tool);
    searchIndex.set(tool, index);
    return index;
  };

  if (isToolRegistry(input)) {
    const embedder = getRegistryEmbedder(input as object);
    const tools = input.tools();
    const registry = input as object;
    const dispatchEvent = input.dispatchEvent
      ? (input.dispatchEvent.bind(input) as unknown as ToolRegistryLike['dispatchEvent'])
      : undefined;
    const result = {
      tools,
      registry,
      dispatchEvent,
      getIndex,
      getInvertedIndex: () => getRegistryInvertedIndex(registry, tools),
      getTextIndex: () => getRegistryTextIndex(registry, tools, getIndex),
      getEmbeddingIndex: () => getRegistryEmbeddingIndex(registry, tools),
    };
    if (embedder) {
      return { ...result, embedder };
    }
    return result;
  }

  if (isToolDefinition(input)) {
    const tools = [input];
    return {
      tools,
      getIndex,
      getInvertedIndex: () => buildInvertedIndex(tools),
      getTextIndex: () => buildTextInvertedIndex(tools, getIndex),
    };
  }

  if (Array.isArray(input)) {
    const tools = input;
    return {
      tools,
      getIndex,
      getInvertedIndex: () => buildInvertedIndex(tools),
      getTextIndex: () => buildTextInvertedIndex(tools, getIndex),
    };
  }

  if (isIterable(input)) {
    const tools = Array.from(input);
    return {
      tools,
      getIndex,
      getInvertedIndex: () => buildInvertedIndex(tools),
      getTextIndex: () => buildTextInvertedIndex(tools, getIndex),
    };
  }

  throw new TypeError('queryTools expects a ToolQuery input');
}

function buildToolLookup(tool: ToolDefinition): ToolLookupCache {
  const tags = (tool.tags ?? [])
    .filter((tag): tag is string => Boolean(tag))
    .map((tag) => String(tag));
  const tagsLower = tags.map((tag) => tag.toLowerCase());
  const schemaKeysLower = getSchemaKeys(getToolSchema(tool)).map((key) =>
    key.toLowerCase(),
  );
  return {
    tags,
    tagsLower,
    tagSet: new Set(tagsLower),
    schemaKeysLower,
    schemaKeySet: new Set(schemaKeysLower),
  };
}

function getToolLookup(tool: ToolDefinition): ToolLookupCache {
  const cached = toolLookupCache.get(tool);
  if (cached) {
    return cached;
  }
  const lookup = buildToolLookup(tool);
  toolLookupCache.set(tool, lookup);
  return lookup;
}

function buildInvertedIndex(tools: readonly ToolDefinition[]): InvertedIndex {
  const tagIndex = new Map<string, Set<ToolDefinition>>();
  const schemaKeyIndex = new Map<string, Set<ToolDefinition>>();
  for (const tool of tools) {
    const lookup = getToolLookup(tool);
    for (const tag of lookup.tagSet) {
      let bucket = tagIndex.get(tag);
      if (!bucket) {
        bucket = new Set();
        tagIndex.set(tag, bucket);
      }
      bucket.add(tool);
    }
    for (const key of lookup.schemaKeySet) {
      let bucket = schemaKeyIndex.get(key);
      if (!bucket) {
        bucket = new Set();
        schemaKeyIndex.set(key, bucket);
      }
      bucket.add(tool);
    }
  }
  return {
    tagIndex,
    schemaKeyIndex,
    size: tools.length,
  };
}

function buildTextInvertedIndex(
  tools: readonly ToolDefinition[],
  getIndex: (tool: ToolDefinition) => TextSearchIndex,
): TextInvertedIndex {
  const fields: Record<TextQueryField, FieldTokenIndex> = {
    name: createFieldTokenIndex(),
    description: createFieldTokenIndex(),
    tags: createFieldTokenIndex(),
    schemaKeys: createFieldTokenIndex(),
    metadataKeys: createFieldTokenIndex(),
  };

  for (const tool of tools) {
    const index = getIndex(tool);
    addFieldTokens(fields.name, [index.name, ...(index.nameTokens ?? [])], tool);
    addFieldTokens(
      fields.description,
      [index.description, ...(index.descriptionTokens ?? [])],
      tool,
    );
    addFieldTokens(
      fields.tags,
      index.tags.map((token) => token.normalized),
      tool,
    );
    addFieldTokens(
      fields.schemaKeys,
      index.schemaKeys.map((token) => token.normalized),
      tool,
    );
    addFieldTokens(
      fields.metadataKeys,
      index.metadataKeys.map((token) => token.normalized),
      tool,
    );
  }

  return {
    fields,
    size: tools.length,
  };
}

function createFieldTokenIndex(): FieldTokenIndex {
  return {
    map: new Map(),
    tokens: [],
    lengthMap: new Map(),
    lengths: [],
    charMap: new Map(),
    bigramMap: new Map(),
    gramMap: new Map(),
  };
}

function getTokenCharacters(token: string): string[] {
  if (!token) {
    return [];
  }
  const chars = new Set<string>();
  for (const char of token) {
    chars.add(char);
  }
  return Array.from(chars);
}

function isAsciiAlphaNumeric(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}

function getTokenGrams(token: string, size = GRAM_SIZE): string[] {
  if (!token || token.length < size) {
    return [];
  }
  const grams = new Set<string>();
  for (let i = 0; i <= token.length - size; i += 1) {
    const gram = token.slice(i, i + size);
    let valid = true;
    for (const char of gram) {
      if (!isAsciiAlphaNumeric(char)) {
        valid = false;
        break;
      }
    }
    if (!valid) {
      continue;
    }
    grams.add(gram);
  }
  return Array.from(grams);
}

function addFieldTokens(
  fieldIndex: FieldTokenIndex,
  tokens: readonly string[],
  tool: ToolDefinition,
): void {
  for (const token of tokens) {
    if (!token) continue;
    let bucket = fieldIndex.map.get(token);
    if (!bucket) {
      bucket = new Set();
      fieldIndex.map.set(token, bucket);
      fieldIndex.tokens.push(token);
    }
    bucket.add(tool);

    const length = token.length;
    let lengthBucket = fieldIndex.lengthMap.get(length);
    if (!lengthBucket) {
      lengthBucket = new Set();
      fieldIndex.lengthMap.set(length, lengthBucket);
      fieldIndex.lengths.push(length);
    }
    lengthBucket.add(tool);

    for (const char of getTokenCharacters(token)) {
      let charBucket = fieldIndex.charMap.get(char);
      if (!charBucket) {
        charBucket = new Set();
        fieldIndex.charMap.set(char, charBucket);
      }
      charBucket.add(tool);
    }

    for (const gram of getTokenGrams(token, BIGRAM_SIZE)) {
      let gramBucket = fieldIndex.bigramMap.get(gram);
      if (!gramBucket) {
        gramBucket = new Set();
        fieldIndex.bigramMap.set(gram, gramBucket);
      }
      gramBucket.add(tool);
    }

    for (const gram of getTokenGrams(token)) {
      let gramBucket = fieldIndex.gramMap.get(gram);
      if (!gramBucket) {
        gramBucket = new Set();
        fieldIndex.gramMap.set(gram, gramBucket);
      }
      gramBucket.add(tool);
    }
  }
}

function addToolToInvertedIndex(index: InvertedIndex, tool: ToolDefinition): void {
  const lookup = getToolLookup(tool);
  for (const tag of lookup.tagSet) {
    let bucket = index.tagIndex.get(tag);
    if (!bucket) {
      bucket = new Set();
      index.tagIndex.set(tag, bucket);
    }
    bucket.add(tool);
  }
  for (const key of lookup.schemaKeySet) {
    let bucket = index.schemaKeyIndex.get(key);
    if (!bucket) {
      bucket = new Set();
      index.schemaKeyIndex.set(key, bucket);
    }
    bucket.add(tool);
  }
}

function removeToolFromInvertedIndex(index: InvertedIndex, tool: ToolDefinition): void {
  const lookup = getToolLookup(tool);
  for (const tag of lookup.tagSet) {
    const bucket = index.tagIndex.get(tag);
    if (!bucket) continue;
    bucket.delete(tool);
    if (!bucket.size) {
      index.tagIndex.delete(tag);
    }
  }
  for (const key of lookup.schemaKeySet) {
    const bucket = index.schemaKeyIndex.get(key);
    if (!bucket) continue;
    bucket.delete(tool);
    if (!bucket.size) {
      index.schemaKeyIndex.delete(key);
    }
  }
}

function addToolToTextIndex(
  textIndex: TextInvertedIndex,
  tool: ToolDefinition,
  index: TextSearchIndex,
): void {
  addFieldTokens(textIndex.fields.name, [index.name, ...(index.nameTokens ?? [])], tool);
  addFieldTokens(
    textIndex.fields.description,
    [index.description, ...(index.descriptionTokens ?? [])],
    tool,
  );
  addFieldTokens(
    textIndex.fields.tags,
    index.tags.map((token) => token.normalized),
    tool,
  );
  addFieldTokens(
    textIndex.fields.schemaKeys,
    index.schemaKeys.map((token) => token.normalized),
    tool,
  );
  addFieldTokens(
    textIndex.fields.metadataKeys,
    index.metadataKeys.map((token) => token.normalized),
    tool,
  );
}

function removeToolFromTextIndex(
  textIndex: TextInvertedIndex,
  tool: ToolDefinition,
  index: TextSearchIndex,
): void {
  removeFieldTokens(
    textIndex.fields.name,
    [index.name, ...(index.nameTokens ?? [])],
    tool,
  );
  removeFieldTokens(
    textIndex.fields.description,
    [index.description, ...(index.descriptionTokens ?? [])],
    tool,
  );
  removeFieldTokens(
    textIndex.fields.tags,
    index.tags.map((token) => token.normalized),
    tool,
  );
  removeFieldTokens(
    textIndex.fields.schemaKeys,
    index.schemaKeys.map((token) => token.normalized),
    tool,
  );
  removeFieldTokens(
    textIndex.fields.metadataKeys,
    index.metadataKeys.map((token) => token.normalized),
    tool,
  );
}

function removeFieldTokens(
  fieldIndex: FieldTokenIndex,
  tokens: readonly string[],
  tool: ToolDefinition,
): void {
  for (const token of tokens) {
    if (!token) continue;
    const bucket = fieldIndex.map.get(token);
    if (!bucket) continue;
    bucket.delete(tool);
    if (!bucket.size) {
      fieldIndex.map.delete(token);
      const index = fieldIndex.tokens.indexOf(token);
      if (index >= 0) {
        fieldIndex.tokens.splice(index, 1);
      }
    }

    const lengthBucket = fieldIndex.lengthMap.get(token.length);
    if (!lengthBucket) continue;
    lengthBucket.delete(tool);
    if (!lengthBucket.size) {
      fieldIndex.lengthMap.delete(token.length);
      const index = fieldIndex.lengths.indexOf(token.length);
      if (index >= 0) {
        fieldIndex.lengths.splice(index, 1);
      }
    }

    for (const char of getTokenCharacters(token)) {
      const charBucket = fieldIndex.charMap.get(char);
      if (!charBucket) continue;
      charBucket.delete(tool);
      if (!charBucket.size) {
        fieldIndex.charMap.delete(char);
      }
    }

    for (const gram of getTokenGrams(token, BIGRAM_SIZE)) {
      const gramBucket = fieldIndex.bigramMap.get(gram);
      if (!gramBucket) continue;
      gramBucket.delete(tool);
      if (!gramBucket.size) {
        fieldIndex.bigramMap.delete(gram);
      }
    }

    for (const gram of getTokenGrams(token)) {
      const gramBucket = fieldIndex.gramMap.get(gram);
      if (!gramBucket) continue;
      gramBucket.delete(tool);
      if (!gramBucket.size) {
        fieldIndex.gramMap.delete(gram);
      }
    }
  }
}

function buildEmbeddingIndex(tools: readonly ToolDefinition[]): EmbeddingIndex {
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

function getEmbeddingBucketIndex(
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

function createEmbeddingBucketIndex(dimension: number): EmbeddingBucketIndex {
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

function addToolToEmbeddingIndex(index: EmbeddingIndex, tool: ToolDefinition): void {
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

function removeToolFromEmbeddingIndex(index: EmbeddingIndex, tool: ToolDefinition): void {
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

function addEmbeddingBuckets(
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

function removeEmbeddingBuckets(
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

function getEmbeddingSignatureBits(
  projections: number[][],
  vector: EmbeddingVector,
): number[] {
  if (!projections.length || vector.length !== projections[0]?.length) {
    return [];
  }
  const bits = new Array<number>(projections.length);
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

function getEmbeddingBandKeys(bits: number[], bandSize: number): number[] {
  const bands = Math.ceil(bits.length / bandSize);
  const bucketSize = 1 << bandSize;
  const keys = new Array<number>(bands);
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

function createProjectionMatrix(dimension: number, hashBits: number): number[][] {
  if (!dimension) {
    return [];
  }
  const rng = createRng(EMBEDDING_SEED ^ dimension);
  const projections: number[][] = [];
  for (let i = 0; i < hashBits; i += 1) {
    const vector = new Array<number>(dimension);
    for (let j = 0; j < dimension; j += 1) {
      vector[j] = rng() * 2 - 1;
    }
    projections.push(vector);
  }
  return projections;
}

function getEmbeddingConfiguration(dimension: number): {
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

function createRng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function getRegistryInvertedIndex(
  registry: object,
  tools: readonly ToolDefinition[],
): InvertedIndex {
  const cached = registryInvertedIndex.get(registry);
  if (cached && cached.size === tools.length) {
    return cached;
  }
  const built = buildInvertedIndex(tools);
  registryInvertedIndex.set(registry, built);
  return built;
}

function getRegistryTextIndex(
  registry: object,
  tools: readonly ToolDefinition[],
  getIndex: (tool: ToolDefinition) => TextSearchIndex,
): TextInvertedIndex {
  const cached = registryTextIndex.get(registry);
  if (cached && cached.size === tools.length) {
    return cached;
  }
  const built = buildTextInvertedIndex(tools, getIndex);
  registryTextIndex.set(registry, built);
  return built;
}

function getRegistryEmbeddingIndex(
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

function filterTools(
  tools: readonly ToolDefinition[],
  criteria: ToolQueryCriteria | undefined,
  getIndex: (tool: ToolDefinition) => TextSearchIndex,
  getInvertedIndex: (() => InvertedIndex) | undefined,
  getTextIndex: () => TextInvertedIndex,
  embedder?: Embedder,
): ToolDefinition[] {
  if (criteria === undefined) {
    return [...tools];
  }
  if (!isPlainObject(criteria)) {
    throw new TypeError('query expects a ToolQuery object');
  }
  const options = embedder ? { getIndex, embedder } : { getIndex };
  const predicate = compileCriteria(criteria, options);
  const candidates = selectCandidateTools(
    tools,
    criteria,
    getInvertedIndex,
    getTextIndex,
    embedder,
  );
  return candidates.filter(predicate);
}

function selectCandidateTools(
  tools: readonly ToolDefinition[],
  criteria: ToolQueryCriteria,
  getInvertedIndex: (() => InvertedIndex) | undefined,
  getTextIndex: () => TextInvertedIndex,
  embedder?: Embedder,
): ToolDefinition[] {
  const tags = criteria.tags;
  const anyTags = normalizeTags(tags?.any ?? []);
  const allTags = normalizeTags(tags?.all ?? []);
  const schemaKeys = normalizeSchemaKeys(criteria.schema?.keys ?? []);
  const normalizedText = criteria.text ? normalizeTextQuery(criteria.text) : null;
  if (!anyTags.length && !allTags.length && !schemaKeys.length && !normalizedText) {
    return [...tools];
  }
  const index = getInvertedIndex ? getInvertedIndex() : buildInvertedIndex(tools);
  let candidateSet: Set<ToolDefinition> | null = null;

  const tagCandidates = collectTagCandidates(index.tagIndex, anyTags, allTags);
  if (tagCandidates) {
    candidateSet = tagCandidates;
  }

  const schemaCandidates = collectSchemaCandidates(index.schemaKeyIndex, schemaKeys);
  if (schemaCandidates) {
    candidateSet = candidateSet
      ? intersectSets(candidateSet, schemaCandidates)
      : schemaCandidates;
  }

  if (normalizedText && !embedder) {
    const textCandidates = selectTextCandidates(getTextIndex(), normalizedText);
    if (textCandidates) {
      candidateSet = candidateSet
        ? intersectSets(candidateSet, textCandidates)
        : textCandidates;
    }
  }

  if (!candidateSet) {
    return [...tools];
  }
  if (!candidateSet.size) {
    return [];
  }
  return tools.filter((tool) => candidateSet.has(tool));
}

function selectTextCandidates(
  textIndex: TextInvertedIndex,
  normalized: NormalizedTextQuery,
): Set<ToolDefinition> | null {
  if (!normalized.tokens.length) {
    return null;
  }
  if (normalized.mode === 'fuzzy') {
    if (normalized.threshold <= 0) {
      return null;
    }
    const candidates = new Set<ToolDefinition>();
    let matchedAny = false;
    for (const field of normalized.fields) {
      const fieldIndex = textIndex.fields[field];
      if (!fieldIndex) continue;
      for (const queryToken of normalized.tokens) {
        if (!queryToken) continue;
        const length = queryToken.length;
        const minLen = Math.ceil(length * normalized.threshold);
        const maxLen = Math.floor(length / normalized.threshold);
        if (!Number.isFinite(minLen) || !Number.isFinite(maxLen)) {
          return null;
        }
        const lengthCandidates = collectLengthCandidates(fieldIndex, minLen, maxLen);
        if (!lengthCandidates?.size) {
          continue;
        }
        const charCandidates = collectCharCandidates(fieldIndex, queryToken);
        if (!charCandidates?.size) {
          continue;
        }
        const tokenCandidates = intersectSets(lengthCandidates, charCandidates);
        if (!tokenCandidates.size) {
          continue;
        }
        matchedAny = true;
        for (const tool of tokenCandidates) {
          candidates.add(tool);
        }
      }
    }
    return matchedAny ? candidates : new Set();
  }

  const candidates = new Set<ToolDefinition>();
  let matchedAny = false;
  for (const field of normalized.fields) {
    const fieldIndex = textIndex.fields[field];
    if (!fieldIndex) continue;
    if (normalized.mode === 'exact') {
      for (const token of normalized.tokens) {
        const bucket = fieldIndex.map.get(token);
        if (!bucket) {
          continue;
        }
        matchedAny = true;
        for (const tool of bucket) {
          candidates.add(tool);
        }
      }
      continue;
    }
    for (const queryToken of normalized.tokens) {
      if (!queryToken) continue;
      const tokenCandidates =
        queryToken.length >= GRAM_SIZE
          ? (collectGramCandidates(fieldIndex.gramMap, queryToken, GRAM_SIZE) ??
            collectCharIntersectionCandidates(fieldIndex, queryToken))
          : queryToken.length === BIGRAM_SIZE
            ? (collectGramCandidates(fieldIndex.bigramMap, queryToken, BIGRAM_SIZE) ??
              collectCharIntersectionCandidates(fieldIndex, queryToken))
            : collectCharIntersectionCandidates(fieldIndex, queryToken);
      if (!tokenCandidates?.size) {
        continue;
      }
      matchedAny = true;
      for (const tool of tokenCandidates) {
        candidates.add(tool);
      }
    }
  }

  return matchedAny ? candidates : new Set();
}

function selectEmbeddingCandidates(
  embeddingIndex: EmbeddingIndex,
  queryEmbedding: EmbeddingInfo,
  query: NormalizedTextQuery,
): Set<ToolDefinition> | null {
  if (!queryEmbedding.vector.length) {
    return null;
  }
  const bucketIndex = embeddingIndex.dimensions.get(queryEmbedding.vector.length);
  if (!bucketIndex) {
    return embeddingIndex.missing.size ? new Set(embeddingIndex.missing) : null;
  }
  const fields = query.fields.filter((field) => (query.weights[field] ?? 1) > 0);
  if (!fields.length) {
    return null;
  }
  const bits = getEmbeddingSignatureBits(bucketIndex.projections, queryEmbedding.vector);
  if (!bits.length) {
    return null;
  }
  const bandKeys = getEmbeddingBandKeys(bits, bucketIndex.bandSize);
  let candidates: Set<ToolDefinition> | null = null;
  let matchedAny = false;
  for (const field of fields) {
    const buckets = bucketIndex.buckets[field];
    if (!buckets) {
      continue;
    }
    for (const key of bandKeys) {
      const bucket = buckets.get(key);
      if (!bucket) {
        continue;
      }
      matchedAny = true;
      if (!candidates) {
        candidates = new Set(bucket);
        continue;
      }
      for (const tool of bucket) {
        candidates.add(tool);
      }
    }
  }
  if (embeddingIndex.missing.size) {
    if (!candidates) {
      candidates = new Set();
    }
    for (const tool of embeddingIndex.missing) {
      candidates.add(tool);
    }
  }
  if (!matchedAny && !embeddingIndex.missing.size) {
    return null;
  }
  return candidates ?? null;
}

function collectGramCandidates(
  index: Map<string, Set<ToolDefinition>>,
  token: string,
  size: number,
): Set<ToolDefinition> | null {
  const grams = getTokenGrams(token, size);
  if (!grams.length) {
    return null;
  }
  return intersectFromIndex(index, grams);
}

function collectLengthCandidates(
  fieldIndex: FieldTokenIndex,
  minLen: number,
  maxLen: number,
): Set<ToolDefinition> | null {
  let result: Set<ToolDefinition> | null = null;
  for (const tokenLength of fieldIndex.lengths) {
    if (tokenLength < minLen || tokenLength > maxLen) {
      continue;
    }
    const bucket = fieldIndex.lengthMap.get(tokenLength);
    if (!bucket) {
      continue;
    }
    if (!result) {
      result = new Set(bucket);
      continue;
    }
    for (const tool of bucket) {
      result.add(tool);
    }
  }
  return result;
}

function collectCharCandidates(
  fieldIndex: FieldTokenIndex,
  token: string,
): Set<ToolDefinition> | null {
  let result: Set<ToolDefinition> | null = null;
  for (const char of getTokenCharacters(token)) {
    const bucket = fieldIndex.charMap.get(char);
    if (!bucket) {
      continue;
    }
    if (!result) {
      result = new Set(bucket);
      continue;
    }
    for (const tool of bucket) {
      result.add(tool);
    }
  }
  return result;
}

function collectCharIntersectionCandidates(
  fieldIndex: FieldTokenIndex,
  token: string,
): Set<ToolDefinition> | null {
  const chars = getTokenCharacters(token);
  if (!chars.length) {
    return null;
  }
  return intersectFromIndex(fieldIndex.charMap, chars);
}

function collectTagCandidates(
  tagIndex: Map<string, Set<ToolDefinition>>,
  anyTags: string[],
  allTags: string[],
): Set<ToolDefinition> | null {
  if (!anyTags.length && !allTags.length) {
    return null;
  }
  let candidateSet: Set<ToolDefinition> | null = null;
  if (allTags.length) {
    candidateSet = intersectFromIndex(tagIndex, allTags);
  }
  if (anyTags.length) {
    const anySet = unionFromIndex(tagIndex, anyTags);
    candidateSet = candidateSet ? intersectSets(candidateSet, anySet) : anySet;
  }
  return candidateSet;
}

function collectSchemaCandidates(
  schemaIndex: Map<string, Set<ToolDefinition>>,
  keys: string[],
): Set<ToolDefinition> | null {
  if (!keys.length) {
    return null;
  }
  return intersectFromIndex(schemaIndex, keys);
}

function unionFromIndex(
  index: Map<string, Set<ToolDefinition>>,
  keys: string[],
): Set<ToolDefinition> {
  const result = new Set<ToolDefinition>();
  for (const key of keys) {
    const bucket = index.get(key);
    if (!bucket) {
      continue;
    }
    for (const tool of bucket) {
      result.add(tool);
    }
  }
  return result;
}

function intersectFromIndex(
  index: Map<string, Set<ToolDefinition>>,
  keys: string[],
): Set<ToolDefinition> {
  const first = keys[0];
  if (!first) {
    return new Set();
  }
  const initial = index.get(first);
  if (!initial) {
    return new Set();
  }
  let result = new Set<ToolDefinition>(initial);
  for (let i = 1; i < keys.length; i += 1) {
    const key = keys[i];
    if (!key) {
      continue;
    }
    const bucket = index.get(key);
    if (!bucket) {
      return new Set();
    }
    result = intersectSets(result, bucket);
    if (!result.size) {
      return result;
    }
  }
  return result;
}

function intersectSets<T>(left: Set<T>, right: Set<T>): Set<T> {
  const result = new Set<T>();
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const item of small) {
    if (large.has(item)) {
      result.add(item);
    }
  }
  return result;
}

function compileCriteria(
  criteria: ToolQueryCriteria,
  options?: { getIndex?: (tool: ToolDefinition) => TextSearchIndex; embedder?: Embedder },
): ToolPredicate<ToolDefinition> {
  const predicates = buildPredicates(criteria, options);
  const andPredicates = criteria.and?.length
    ? criteria.and.map((entry) => compileCriteria(entry, options))
    : [];
  const orPredicates = criteria.or?.length
    ? criteria.or.map((entry) => compileCriteria(entry, options))
    : [];
  const notPredicates = criteria.not
    ? (Array.isArray(criteria.not) ? criteria.not : [criteria.not]).map((entry) =>
        compileCriteria(entry, options),
      )
    : [];

  return (tool) => {
    if (predicates.length && !evaluatePredicates(tool, predicates)) {
      return false;
    }

    if (andPredicates.length && !andPredicates.every((entry) => entry(tool))) {
      return false;
    }

    if (orPredicates.length && !orPredicates.some((entry) => entry(tool))) {
      return false;
    }

    if (notPredicates.length && notPredicates.some((entry) => entry(tool))) {
      return false;
    }

    return true;
  };
}

function evaluatePredicates(
  tool: ToolDefinition,
  predicates: ToolPredicate<ToolDefinition>[],
): boolean {
  for (const predicate of predicates) {
    try {
      if (!predicate(tool)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function buildPredicates(
  criteria: ToolQueryCriteria,
  options?: { getIndex?: (tool: ToolDefinition) => TextSearchIndex; embedder?: Embedder },
): ToolPredicate<ToolDefinition>[] {
  const predicates: ToolPredicate<ToolDefinition>[] = [];

  if (criteria.namespace !== undefined) {
    const namespaces = normalizeFilterValues(criteria.namespace);
    if (namespaces.length) {
      predicates.push((tool) => namespaces.includes(tool.identity.namespace));
    }
  }

  if (criteria.version !== undefined) {
    const versions = normalizeFilterValues(criteria.version);
    if (versions.length) {
      predicates.push((tool) => versions.includes(tool.identity.version ?? ''));
    }
  }

  if (criteria.deprecated !== undefined) {
    predicates.push(
      (tool) => (tool.lifecycle?.deprecated === true) === criteria.deprecated,
    );
  }

  if (criteria.risk) {
    predicates.push((tool) => riskMatches(tool.risk, criteria.risk!));
  }

  if (criteria.tags) {
    const { any, all, none } = criteria.tags;
    if (any?.length) {
      predicates.push(tagsMatchAny(any));
    }
    if (all?.length) {
      predicates.push(tagsMatchAll(all));
    }
    if (none?.length) {
      predicates.push(tagsMatchNone(none));
    }
  }

  if (criteria.text !== undefined) {
    predicates.push(buildTextPredicate(criteria.text, options));
  }

  if (criteria.schema) {
    const { keys, matches } = criteria.schema;
    if (keys?.length) {
      predicates.push(schemaHasKeys(keys));
    }
    if (matches) {
      predicates.push(schemaMatches(matches));
    }
  }

  if (criteria.metadata) {
    const { has, eq, contains, startsWith, range, predicate } = criteria.metadata;
    if (has?.length) {
      predicates.push((tool) => metadataHasKeys(tool.metadata, has));
    }
    if (eq && Object.keys(eq).length) {
      predicates.push((tool) => metadataEquals(tool.metadata, eq));
    }
    if (contains && Object.keys(contains).length) {
      predicates.push((tool) => metadataContains(tool.metadata, contains));
    }
    if (startsWith && Object.keys(startsWith).length) {
      predicates.push((tool) => metadataStartsWith(tool.metadata, startsWith));
    }
    if (range && Object.keys(range).length) {
      predicates.push((tool) => metadataInRange(tool.metadata, range));
    }
    if (predicate) {
      predicates.push((tool) => predicate(tool.metadata));
    }
  }

  if (criteria.predicate) {
    predicates.push(criteria.predicate);
  }

  return predicates;
}

function buildTextPredicate(
  query: TextQuery,
  options?: { getIndex?: (tool: ToolDefinition) => TextSearchIndex; embedder?: Embedder },
): ToolPredicate<ToolDefinition> {
  const normalized = normalizeTextQuery(query);
  if (!normalized) {
    return () => true;
  }
  const getIndex = options?.getIndex ?? buildTextSearchIndex;
  const embedder = options?.embedder;
  const queryEmbedding =
    embedder && normalized.raw
      ? getQueryEmbeddingInfo(embedder, normalized.raw)
      : undefined;

  return (tool) => {
    const textScore = scoreTextMatchFromIndex(getIndex(tool), normalized);
    if (textScore.score > 0) {
      return true;
    }
    if (!queryEmbedding) {
      return false;
    }
    const embeddingScore = scoreEmbeddingMatch(tool, normalized, queryEmbedding);
    if (!embeddingScore) {
      return false;
    }
    return embeddingScore.similarity >= normalized.threshold;
  };
}

function applyPagination<T>(items: T[], limit?: number, offset?: number): T[] {
  const start = normalizeOffset(offset);
  const max = normalizeLimit(limit);
  if (max === undefined) {
    return items.slice(start);
  }
  return items.slice(start, start + max);
}

function rankTools(
  tools: QueryResult,
  options: ToolSearchOptions = {},
  getIndex?: (tool: ToolDefinition) => TextSearchIndex,
  embedder?: Embedder,
  getEmbeddingIndex?: () => EmbeddingIndex,
): ToolMatch[] {
  const rank = options.rank;
  const preferredTags = normalizeTags(rank?.tags ?? []);
  const tagWeights = normalizeTagWeights(rank?.tagWeights);
  const tagWeight = normalizeWeight(rank?.weights?.tags);
  const textWeight = normalizeWeight(rank?.weights?.text);
  const normalizedText = rank?.text !== undefined ? normalizeTextQuery(rank.text) : null;
  const queryEmbedding =
    embedder && normalizedText?.raw
      ? getQueryEmbeddingInfo(embedder, normalizedText.raw)
      : undefined;
  const embeddingCandidates =
    queryEmbedding && normalizedText && getEmbeddingIndex
      ? selectEmbeddingCandidates(getEmbeddingIndex(), queryEmbedding, normalizedText)
      : null;
  const tagSet = buildTagSet(preferredTags, tagWeights);
  const explain = Boolean(options.explain);
  const ranker = options.ranker;
  const tieBreaker = options.tieBreaker ?? 'name';
  const compare = createMatchComparator(tieBreaker);
  const maxResults = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  const topLimit = maxResults !== undefined ? maxResults + offset : undefined;
  const resolveIndex = (tool: ToolDefinition) =>
    getIndex ? getIndex(tool) : buildTextSearchIndex(tool);

  const canOptimize =
    topLimit !== undefined &&
    topLimit > 0 &&
    topLimit < tools.length &&
    !ranker &&
    (tieBreaker === 'name' || tieBreaker === 'none');
  if (canOptimize) {
    const scored = tools.map((tool) => ({
      tool,
      score: scoreToolMatchValue(tool, {
        tagSet,
        tagWeights,
        tagWeight,
        textWeight,
        normalizedText,
        queryEmbedding,
        embeddingCandidates,
        resolveIndex,
      }),
      reasons: [],
    }));
    const top =
      topLimit !== undefined && scored.length > topLimit
        ? selectTopMatches(scored, topLimit, compare)
        : scored;
    const detailed = top
      .map((match) =>
        buildToolMatch(match.tool, {
          tagSet,
          tagWeights,
          tagWeight,
          textWeight,
          normalizedText,
          queryEmbedding,
          embeddingCandidates,
          explain,
          ranker,
          preferredTags,
          resolveIndex,
        }),
      )
      .filter((entry): entry is ToolMatch<ToolDefinition> => entry !== null);
    detailed.sort(compare);
    return detailed;
  }

  const ranked = tools
    .map((tool) =>
      buildToolMatch(tool, {
        tagSet,
        tagWeights,
        tagWeight,
        textWeight,
        normalizedText,
        queryEmbedding,
        embeddingCandidates,
        explain,
        ranker,
        preferredTags,
        resolveIndex,
      }),
    )
    .filter((entry): entry is ToolMatch<ToolDefinition> => entry !== null);

  if (topLimit !== undefined && ranked.length > topLimit) {
    const top = selectTopMatches(ranked, topLimit, compare);
    top.sort(compare);
    return top;
  }
  ranked.sort(compare);

  return ranked;
}

function scoreToolMatchValue(
  tool: ToolDefinition,
  context: {
    tagSet: Set<string>;
    tagWeights: Record<string, number>;
    tagWeight: number;
    textWeight: number;
    normalizedText: NormalizedTextQuery | null;
    queryEmbedding: EmbeddingInfo | undefined;
    embeddingCandidates: Set<ToolDefinition> | null;
    resolveIndex: (tool: ToolDefinition) => TextSearchIndex;
  },
): number {
  const {
    tagSet,
    tagWeights,
    tagWeight,
    textWeight,
    normalizedText,
    queryEmbedding,
    embeddingCandidates,
    resolveIndex,
  } = context;
  let score = 0;
  if (tagSet.size) {
    score += scoreTagMatchesValue(tool, tagSet, tagWeight, tagWeights);
  }
  if (normalizedText && textWeight !== 0) {
    const textScore = scoreTextMatchValueFromIndex(resolveIndex(tool), normalizedText);
    if (textScore) {
      score += textScore * textWeight;
    }
    if (queryEmbedding && (!embeddingCandidates || embeddingCandidates.has(tool))) {
      const embeddingScore = scoreEmbeddingMatch(tool, normalizedText, queryEmbedding);
      if (embeddingScore) {
        score += embeddingScore.score * textWeight;
      }
    }
  }
  return score;
}

function buildToolMatch(
  tool: ToolDefinition,
  context: {
    tagSet: Set<string>;
    tagWeights: Record<string, number>;
    tagWeight: number;
    textWeight: number;
    normalizedText: NormalizedTextQuery | null;
    queryEmbedding: EmbeddingInfo | undefined;
    embeddingCandidates: Set<ToolDefinition> | null;
    explain: boolean;
    ranker: ToolRanker | undefined;
    preferredTags: string[];
    resolveIndex: (tool: ToolDefinition) => TextSearchIndex;
  },
): ToolMatch<ToolDefinition> | null {
  const {
    tagSet,
    tagWeights,
    tagWeight,
    textWeight,
    normalizedText,
    queryEmbedding,
    embeddingCandidates,
    explain,
    ranker,
    preferredTags,
    resolveIndex,
  } = context;
  let cachedIndex: TextSearchIndex | undefined;
  const ensureIndex = () => {
    if (!cachedIndex) {
      cachedIndex = resolveIndex(tool);
    }
    return cachedIndex;
  };
  let score = 0;
  const reasons: string[] = [];
  const matches: ToolMatchDetails = {};

  if (tagSet.size) {
    const tagMatches = collectTagMatches(tool, tagSet);
    if (tagMatches.length) {
      score += scoreTagMatches(tagMatches, tagWeight, tagWeights);
      reasons.push(...tagMatches.map((tag) => `tag:${tag}`));
      if (explain) {
        matches.tags = mergeUnique(matches.tags, tagMatches);
      }
    }
  }

  if (normalizedText && textWeight !== 0) {
    const textScore = scoreTextMatchFromIndex(ensureIndex(), normalizedText);
    if (textScore.score > 0) {
      score += textScore.score * textWeight;
      reasons.push(...textScore.reasons.map((reason) => `text:${reason}`));
      if (explain) {
        matches.fields = mergeUnique(matches.fields, textScore.fields);
        matches.tags = mergeUnique(matches.tags, textScore.tagMatches);
        matches.schemaKeys = mergeUnique(matches.schemaKeys, textScore.schemaMatches);
        matches.metadataKeys = mergeUnique(
          matches.metadataKeys,
          textScore.metadataMatches,
        );
      }
    }
    if (queryEmbedding && (!embeddingCandidates || embeddingCandidates.has(tool))) {
      const embeddingScore = scoreEmbeddingMatch(tool, normalizedText, queryEmbedding);
      if (embeddingScore) {
        score += embeddingScore.score * textWeight;
        reasons.push(
          `embedding:${embeddingScore.field}:${embeddingScore.similarity.toFixed(2)}`,
        );
        if (explain) {
          matches.embedding = {
            field: embeddingScore.field,
            score: embeddingScore.similarity,
          };
        }
      }
    }
  }

  if (ranker) {
    const rankResult = ranker(tool, {
      text: normalizedText,
      preferredTags,
      tagWeights,
      weights: { tags: tagWeight, text: textWeight },
      index: ensureIndex(),
    });
    if (rankResult && typeof rankResult === 'object') {
      if (rankResult.exclude) {
        return null;
      }
      score = rankResult.override ? rankResult.score : score + rankResult.score;
      if (rankResult.reasons?.length) {
        reasons.push(...rankResult.reasons);
      }
      if (explain && rankResult.matches) {
        mergeMatchDetails(matches, rankResult.matches);
      }
    } else if (typeof rankResult === 'number') {
      score += rankResult;
    }
  }

  if (score < 0) {
    return null;
  }

  const result: ToolMatch<ToolDefinition> = { tool, score, reasons };
  if (explain) {
    result.matches = matches;
  }
  return result;
}

function createMatchComparator(
  tieBreaker: ToolTieBreaker,
): (a: ToolMatch<ToolDefinition>, b: ToolMatch<ToolDefinition>) => number {
  if (typeof tieBreaker === 'function') {
    return (a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return tieBreaker(a, b);
    };
  }
  if (tieBreaker === 'name') {
    return (a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return a.tool.identity.name.localeCompare(b.tool.identity.name);
    };
  }
  return (a, b) => b.score - a.score;
}

function selectTopMatches<T>(
  items: T[],
  limit: number,
  compare: (a: T, b: T) => number,
): T[] {
  return items.sort(compare).slice(0, limit);
}

function selectMatchResults(
  matches: ToolMatch<ToolDefinition>[],
  options: ToolSearchOptions,
): ToolMatch<unknown>[] {
  const select = options.select;
  if (!select || select === 'tool') {
    return matches;
  }
  if (select === 'name') {
    return matches.map((match) => ({
      ...match,
      tool: (match.tool as unknown as { name: string }).name,
    }));
  }
  if (select === 'configuration') {
    return matches;
  }
  if (select === 'summary') {
    const includeConfiguration = options.includeToolConfiguration;
    return matches.map((match) => ({
      ...match,
      tool: createToolSummary(match.tool, includeConfiguration, options.includeSchema),
    }));
  }
  return matches;
}

function selectQueryResults(
  tools: ToolDefinition[],
  criteria: ToolQuery | undefined,
): QuerySelectionResult {
  const select = criteria?.select;
  if (!select || select === 'tool') {
    return tools;
  }
  if (select === 'name') {
    return tools.map((tool) => {
      return (tool as unknown as { name: string }).name;
    });
  }
  if (select === 'configuration') {
    return tools;
  }
  if (select === 'summary') {
    const includeConfiguration = criteria.includeToolConfiguration;
    return tools.map((tool) =>
      createToolSummary(tool, includeConfiguration, criteria.includeSchema),
    );
  }
  return tools;
}

function createToolSummary(
  tool: ToolDefinition,
  includeConfiguration?: boolean,
  includeSchema?: boolean,
): ToolSummary {
  const summary: ToolSummary = {
    id: tool.id,
    identity: tool.identity,
    name: tool.name,
    description: tool.description,
    schemaKeys: getSchemaKeys(getToolSchema(tool)),
  };
  if (tool.tags) summary.tags = tool.tags;
  if (tool.metadata) summary.metadata = tool.metadata;
  if (tool.risk) summary.risk = tool.risk;
  if (tool.lifecycle) {
    summary.lifecycle = tool.lifecycle;
    if (tool.lifecycle.deprecated) summary.deprecated = true;
  }
  if (includeConfiguration) {
    summary.configuration = tool;
  }
  if (includeSchema) {
    summary.schema = getToolSchema(tool);
  }
  return summary;
}

function isToolRegistered(registry: ToolRegistryLike, tool: ToolDefinition): boolean {
  const candidate = registry as unknown as Record<string, unknown>;
  if (typeof candidate['getTool'] === 'function') {
    const registryWithGet = registry as unknown as {
      getTool: (name: string) => ToolDefinition;
    };
    return registryWithGet.getTool(tool.name) === tool;
  }
  return false;
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['identity'] === 'object' &&
    candidate['identity'] !== null &&
    typeof (candidate['identity'] as Record<string, unknown>)['name'] === 'string' &&
    candidate['input'] !== undefined
  );
}

function getToolSchema(tool: ToolDefinition): ToolSchema {
  return tool.input;
}

function isToolRegistry(value: unknown): value is ToolRegistryLike {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['tools'] === 'function' &&
    typeof candidate['register'] === 'function'
  );
}

function emitQuery(
  dispatch: ToolRegistryLike['dispatchEvent'] | undefined,
  criteria: ToolQuery | undefined,
  results: QuerySelectionResult,
): void {
  if (!dispatch) return;
  dispatch({
    type: 'query',
    detail: { criteria, results },
  } as EmissionEvent<QueryEvent>);
}

function emitSearch(
  dispatch: ToolRegistryLike['dispatchEvent'] | undefined,
  options: ToolSearchOptions,
  results: ToolMatch<unknown>[],
): void {
  if (!dispatch) return;
  dispatch({
    type: 'search',
    detail: { options, results },
  } as EmissionEvent<SearchEvent>);
}

function collectTagMatches(tool: ToolDefinition, tagSet: Set<string>): string[] {
  if (!tool.tags) return [];
  return tool.tags.filter((tag) => tagSet.has(tag.toLowerCase()));
}

function scoreTagMatches(
  matches: string[],
  weight: number,
  weights: Record<string, number>,
): number {
  let score = 0;
  for (const tag of matches) {
    const tagWeight = weights[tag.toLowerCase()] ?? 1;
    score += weight * tagWeight;
  }
  return score;
}

function scoreTagMatchesValue(
  tool: ToolDefinition,
  tagSet: Set<string>,
  weight: number,
  weights: Record<string, number>,
): number {
  const matches = collectTagMatches(tool, tagSet);
  return scoreTagMatches(matches, weight, weights);
}

function buildTagSet(
  preferredTags: readonly string[],
  tagWeights: Record<string, number>,
): Set<string> {
  const set = new Set(preferredTags);
  for (const tag of Object.keys(tagWeights)) {
    set.add(tag);
  }
  return set;
}

function normalizeTagWeights(
  weights: Record<string, number> | undefined,
): Record<string, number> {
  const result: Record<string, number> = {};
  if (!weights) return result;
  for (const [key, value] of Object.entries(weights)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

function normalizeWeight(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return value;
}

function normalizeOffset(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeLimit(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

function createQueryCacheKey(
  criteria: ToolQueryCriteria | undefined,
  toolsCount: number,
): string | null {
  if (!criteria) return JSON.stringify({ toolsCount });
  if (hasFunction(criteria)) return null;
  return JSON.stringify({ criteria, toolsCount });
}

function hasFunction(obj: Record<string, unknown>): boolean {
  if (!obj || typeof obj !== 'object') return false;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'function') return true;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (hasFunction(value as Record<string, unknown>)) return true;
    }
  }
  return false;
}

function normalizeFilterValues(value: string | readonly string[]): string[] {
  if (Array.isArray(value)) return value as string[];
  return [value as string];
}

function normalizeSchemaKeys(keys: readonly string[]): string[] {
  return keys
    .map((key) => key.toLowerCase())
    .filter((key): key is string => Boolean(key));
}

function riskMatches(risk: ToolRisk | undefined, filter: RiskFilter): boolean {
  if (!risk) return false;
  if (filter.readOnly !== undefined && (risk.readOnly === true) !== filter.readOnly) {
    return false;
  }
  if (filter.mutates !== undefined && (risk.mutates === true) !== filter.mutates) {
    return false;
  }
  if (filter.dangerous !== undefined && (risk.dangerous === true) !== filter.dangerous) {
    return false;
  }
  return true;
}

function metadataHasKeys(
  metadata: JsonObject | undefined,
  keys: readonly string[],
): boolean {
  if (!metadata) return false;
  for (const key of keys) {
    if (!(key in metadata)) return false;
  }
  return true;
}

function metadataEquals(
  metadata: JsonObject | undefined,
  eq: Record<string, unknown>,
): boolean {
  if (!metadata) return false;
  for (const [key, value] of Object.entries(eq)) {
    if (metadata[key] !== value) return false;
  }
  return true;
}

function metadataContains(
  metadata: JsonObject | undefined,
  contains: Partial<Record<string, MetadataPrimitive | readonly MetadataPrimitive[]>>,
): boolean {
  if (!metadata) return false;
  for (const [key, needle] of Object.entries(contains)) {
    if (needle === undefined) {
      continue;
    }
    const value = metadata[key];
    if (typeof value === 'string' && typeof needle === 'string') {
      if (!value.includes(needle)) return false;
    } else if (Array.isArray(value)) {
      const arrayValue = value as unknown[];
      if (Array.isArray(needle)) {
        if (!needle.every((item) => arrayValue.includes(item))) return false;
      } else {
        if (!arrayValue.includes(needle)) return false;
      }
    } else if (Array.isArray(needle)) {
      if (!needle.includes(value as MetadataPrimitive)) return false;
    } else {
      if (value !== needle) return false;
    }
  }
  return true;
}

function metadataStartsWith(
  metadata: JsonObject | undefined,
  startsWith: Partial<Record<string, string>>,
): boolean {
  if (!metadata) return false;
  for (const [key, prefix] of Object.entries(startsWith)) {
    if (prefix === undefined) {
      continue;
    }
    const value = metadata[key];
    if (typeof value !== 'string') return false;
    if (!value.startsWith(prefix)) return false;
  }
  return true;
}

function metadataInRange(
  metadata: JsonObject | undefined,
  ranges: Partial<Record<string, MetadataRange>>,
): boolean {
  if (!metadata) return false;
  for (const [key, range] of Object.entries(ranges)) {
    if (!range) {
      continue;
    }
    const value = metadata[key];
    if (typeof value !== 'number') return false;
    if (range.min !== undefined && value < range.min) return false;
    if (range.max !== undefined && value > range.max) return false;
  }
  return true;
}

function mergeUnique<T>(a: T[] | undefined, b: T[] | undefined): T[] {
  if (!a) return b ?? [];
  if (!b) return a;
  const set = new Set(a);
  for (const item of b) {
    set.add(item);
  }
  return Array.from(set);
}

function scoreEmbeddingMatch(
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

function cosineSimilarity(a: number[], b: number[], magA: number, magB: number): number {
  if (magA === 0 || magB === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot / (magA * magB);
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.iterator in value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function mergeMatchDetails(target: ToolMatchDetails, source: ToolMatchDetails): void {
  if (source.fields) target.fields = mergeUnique(target.fields, source.fields);
  if (source.tags) target.tags = mergeUnique(target.tags, source.tags);
  if (source.schemaKeys)
    target.schemaKeys = mergeUnique(target.schemaKeys, source.schemaKeys);
  if (source.metadataKeys)
    target.metadataKeys = mergeUnique(target.metadataKeys, source.metadataKeys);
  if (source.embedding) target.embedding = source.embedding;
}
