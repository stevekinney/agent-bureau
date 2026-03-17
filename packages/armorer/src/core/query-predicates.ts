import { z } from 'zod';

import { getSchemaKeys, schemasLooselyMatch, type ToolSchema } from './schema-utilities';
import type { JsonObject } from './serialization/json';
import { type ToolDefinition } from './tool-definition';

type AnyTool = ToolDefinition;

export type ToolPredicate<T extends AnyTool = AnyTool> = (tool: T) => boolean;

export type TextQueryMode = 'contains' | 'exact' | 'fuzzy';

export type TextQueryField =
  | 'name'
  | 'description'
  | 'tags'
  | 'schemaKeys'
  | 'metadataKeys';

export type TextQueryWeights = Partial<Record<TextQueryField, number>>;

export type TextQuery =
  | string
  | {
      query: string;
      mode?: TextQueryMode;
      fields?: readonly TextQueryField[];
      threshold?: number;
      weights?: TextQueryWeights;
    };

export type NormalizedTextQuery = {
  raw: string;
  query: string;
  mode: TextQueryMode;
  fields: TextQueryField[];
  threshold: number;
  tokens: string[];
  weights: Record<TextQueryField, number>;
};

export type TextSearchIndex = {
  name: string;
  description: string;
  nameTokens?: string[];
  descriptionTokens?: string[];
  tags: TextToken[];
  schemaKeys: TextToken[];
  metadataKeys: TextToken[];
};

export type TextMatchScore = {
  score: number;
  fields: TextQueryField[];
  tagMatches: string[];
  schemaMatches: string[];
  metadataMatches: string[];
  reasons: string[];
};

export type TextToken = {
  raw: string;
  normalized: string;
};

const DEFAULT_TEXT_FIELDS: TextQueryField[] = [
  'name',
  'description',
  'tags',
  'schemaKeys',
  'metadataKeys',
];

/**
 * Matches tools that have ANY of the provided tags (OR logic).
 * Returns a match-all predicate if tags array is empty.
 *
 * Tag matching is case-insensitive.
 */
export function tagsMatchAny(tags: readonly string[]): ToolPredicate {
  const normalized = normalizeTags(tags);
  if (!normalized.length) {
    return () => true;
  }
  const tagSet = new Set(normalized);
  return (tool) => {
    const toolTags = tool.tags ?? [];
    return toolTags.some((tag) => tagSet.has(tag.toLowerCase()));
  };
}

/**
 * Matches tools that have ALL of the provided tags (AND logic).
 * Returns a match-all predicate if tags array is empty.
 *
 * Tag matching is case-insensitive.
 */
export function tagsMatchAll(tags: readonly string[]): ToolPredicate {
  const normalized = normalizeTags(tags);
  if (!normalized.length) {
    return () => true;
  }
  return (tool) => {
    const toolTags = tool.tags ?? [];
    const lowerTags = toolTags.map((tag) => tag.toLowerCase());
    return normalized.every((tag) => lowerTags.includes(tag));
  };
}

/**
 * Matches tools that have NONE of the provided tags (exclusion).
 * Returns a match-all predicate if tags array is empty.
 *
 * Tag matching is case-insensitive.
 */
export function tagsMatchNone(tags: readonly string[]): ToolPredicate {
  const normalized = normalizeTags(tags);
  if (!normalized.length) {
    return () => true;
  }
  const forbiddenSet = new Set(normalized);
  return (tool) => {
    const toolTags = tool.tags ?? [];
    return !toolTags.some((tag) => forbiddenSet.has(tag.toLowerCase()));
  };
}

/**
 * Creates a predicate that matches tools with compatible schemas.
 *
 * Checks if a tool's input schema is compatible with the provided schema.
 * Uses structural matching to allow tools with additional optional properties.
 *
 * @param schema - The schema to match against
 * @returns A predicate function for filtering tools
 *
 * @example
 * ```typescript
 * import { schemaMatches } from 'armorer/query';
 * import { z } from 'zod';
 *
 * const predicate = schemaMatches(z.object({ userId: z.string() }));
 * const compatible = toolbox.tools().filter(predicate);
 * ```
 */
export function schemaMatches(schema: ToolSchema): ToolPredicate {
  return (tool) => schemasLooselyMatch(getToolSchema(tool), schema);
}

/**
 * Creates a predicate that matches tools based on text search across name, description, and tags.
 *
 * Performs fuzzy text matching with configurable scoring weights. Supports exact matching,
 * prefix matching, and word boundary detection. Returns tools ranked by relevance score.
 *
 * @param query - Search query (string or object with query/mode/weights)
 * @returns A predicate function that also attaches a relevance score to matching tools
 *
 * @example Basic text search
 * ```typescript
 * import { textMatches } from 'armorer/query';
 *
 * const predicate = textMatches('user profile');
 * const matches = toolbox.tools().filter(predicate);
 * ```
 *
 * @example With custom weights
 * ```typescript
 * const predicate = textMatches({
 *   query: 'database',
 *   weights: {
 *     name: 3,         // Name matches weighted 3x
 *     description: 1,  // Description matches weighted 1x
 *     tags: 2,         // Tag matches weighted 2x
 *   },
 * });
 * ```
 */
export function textMatches(
  query: TextQuery,
  options?: { getIndex?: (tool: ToolDefinition) => TextSearchIndex },
): ToolPredicate {
  const normalized = normalizeTextQuery(query);
  if (!normalized) {
    return () => true;
  }
  const getIndex = options?.getIndex ?? buildTextSearchIndex;
  return (tool) => scoreTextMatchFromIndex(getIndex(tool), normalized).score > 0;
}

export function normalizeTextQuery(input: TextQuery): NormalizedTextQuery | null {
  const raw = typeof input === 'string' ? input : input.query;
  const rawTrimmed = raw.trim();
  const query = normalizeText(rawTrimmed).trim();
  if (!query) return null;
  const tokens = tokenize(raw);
  if (!tokens.length) return null;
  const mode = typeof input === 'string' ? 'contains' : (input.mode ?? 'contains');
  const fields =
    typeof input === 'string'
      ? DEFAULT_TEXT_FIELDS.slice()
      : normalizeFields(input.fields);
  const threshold = clampThreshold(
    typeof input === 'string' ? undefined : input.threshold,
  );
  const weights = normalizeTextWeights(
    typeof input === 'string' ? undefined : input.weights,
  );
  return {
    raw: rawTrimmed,
    query,
    mode,
    fields,
    threshold,
    tokens,
    weights,
  };
}

export function buildTextSearchIndex(tool: ToolDefinition): TextSearchIndex {
  const candidate = tool as unknown as Record<string, unknown>;
  const name = tool.identity?.name ?? (candidate['name'] as string | undefined) ?? '';
  const description =
    tool.display?.description ?? (candidate['description'] as string | undefined) ?? '';
  return {
    name: normalizeText(name),
    description: normalizeText(description),
    nameTokens: tokenize(name),
    descriptionTokens: tokenize(description),
    tags: (tool.tags ?? []).map(toToken),
    schemaKeys: getSchemaKeys(getToolSchema(tool)).map(toToken),
    metadataKeys: extractMetadataKeys(tool.metadata).map(toToken),
  };
}

export function scoreTextMatch(tool: ToolDefinition, query: TextQuery): TextMatchScore {
  const normalized = normalizeTextQuery(query);
  if (!normalized) {
    return emptyTextScore();
  }
  return scoreTextMatchFromIndex(buildTextSearchIndex(tool), normalized);
}

export function scoreTextMatchFromIndex(
  index: TextSearchIndex,
  normalized: NormalizedTextQuery,
): TextMatchScore {
  const result: TextMatchScore = {
    score: 0,
    fields: [],
    tagMatches: [],
    schemaMatches: [],
    metadataMatches: [],
    reasons: [],
  };

  if (normalized.fields.includes('name')) {
    const weight = normalized.weights.name;
    if (weight > 0) {
      const score = scoreStringMatch(
        index.name,
        index.nameTokens ?? tokenize(index.name),
        normalized,
      );
      if (score > 0) {
        result.score += score * weight;
        result.fields.push('name');
        result.reasons.push('name');
      }
    }
  }

  if (normalized.fields.includes('description')) {
    const weight = normalized.weights.description;
    if (weight > 0) {
      const score = scoreStringMatch(
        index.description,
        index.descriptionTokens ?? tokenize(index.description),
        normalized,
      );
      if (score > 0) {
        result.score += score * weight;
        result.fields.push('description');
        result.reasons.push('description');
      }
    }
  }

  if (normalized.fields.includes('tags')) {
    const weight = normalized.weights.tags;
    if (weight > 0) {
      const tagResult = scoreTokenMatches(index.tags, normalized);
      if (tagResult.matches.length) {
        result.score += tagResult.score * weight;
        result.fields.push('tags');
        result.tagMatches = tagResult.matches;
        result.reasons.push(`tags(${tagResult.matches.join(', ')})`);
      }
    }
  }

  if (normalized.fields.includes('schemaKeys')) {
    const weight = normalized.weights.schemaKeys;
    if (weight > 0) {
      const schemaResult = scoreTokenMatches(index.schemaKeys, normalized);
      if (schemaResult.matches.length) {
        result.score += schemaResult.score * weight;
        result.fields.push('schemaKeys');
        result.schemaMatches = schemaResult.matches;
        result.reasons.push(`schema-keys(${schemaResult.matches.join(', ')})`);
      }
    }
  }

  if (normalized.fields.includes('metadataKeys')) {
    const weight = normalized.weights.metadataKeys;
    if (weight > 0) {
      const metadataResult = scoreTokenMatches(index.metadataKeys, normalized);
      if (metadataResult.matches.length) {
        result.score += metadataResult.score * weight;
        result.fields.push('metadataKeys');
        result.metadataMatches = metadataResult.matches;
        result.reasons.push(`metadata-keys(${metadataResult.matches.join(', ')})`);
      }
    }
  }

  return result;
}

export function scoreTextMatchValueFromIndex(
  index: TextSearchIndex,
  normalized: NormalizedTextQuery,
): number {
  let score = 0;

  if (normalized.fields.includes('name')) {
    const weight = normalized.weights.name;
    if (weight > 0) {
      const matchScore = scoreStringMatch(
        index.name,
        index.nameTokens ?? tokenize(index.name),
        normalized,
      );
      if (matchScore > 0) {
        score += matchScore * weight;
      }
    }
  }

  if (normalized.fields.includes('description')) {
    const weight = normalized.weights.description;
    if (weight > 0) {
      const matchScore = scoreStringMatch(
        index.description,
        index.descriptionTokens ?? tokenize(index.description),
        normalized,
      );
      if (matchScore > 0) {
        score += matchScore * weight;
      }
    }
  }

  if (normalized.fields.includes('tags')) {
    const weight = normalized.weights.tags;
    if (weight > 0) {
      const matchScore = scoreTokenMatchValue(index.tags, normalized);
      if (matchScore > 0) {
        score += matchScore * weight;
      }
    }
  }

  if (normalized.fields.includes('schemaKeys')) {
    const weight = normalized.weights.schemaKeys;
    if (weight > 0) {
      const matchScore = scoreTokenMatchValue(index.schemaKeys, normalized);
      if (matchScore > 0) {
        score += matchScore * weight;
      }
    }
  }

  if (normalized.fields.includes('metadataKeys')) {
    const weight = normalized.weights.metadataKeys;
    if (weight > 0) {
      const matchScore = scoreTokenMatchValue(index.metadataKeys, normalized);
      if (matchScore > 0) {
        score += matchScore * weight;
      }
    }
  }

  return score;
}

/**
 * Creates a predicate that matches tools whose schema contains specific property keys.
 *
 * Checks if a tool's input schema has all the specified keys as properties.
 * Useful for finding tools that accept certain parameters.
 *
 * @param keys - Array of property keys to check for
 * @returns A predicate function for filtering tools
 *
 * @example
 * ```typescript
 * import { schemaHasKeys } from 'armorer/query';
 *
 * const predicate = schemaHasKeys(['userId', 'action']);
 * const tools = toolbox.tools().filter(predicate);
 * // Returns tools that have both 'userId' and 'action' in their schema
 * ```
 */
export function schemaHasKeys(keys: readonly string[]): ToolPredicate {
  const normalized = keys
    .map((key) => key.toLowerCase())
    .filter((key): key is string => Boolean(key));
  if (!normalized.length) {
    return () => true;
  }
  return (tool) => {
    const schemaKeys = getSchemaKeys(getToolSchema(tool)).map((key) => key.toLowerCase());
    if (!schemaKeys.length) return false;
    return normalized.every((needle) => schemaKeys.includes(needle));
  };
}

function getToolSchema(tool: ToolDefinition): ToolSchema {
  const candidate = tool as ToolDefinition & {
    input?: z.ZodTypeAny;
  };
  return candidate.input ?? z.object({});
}

function normalizeTags(tags: readonly string[]): string[] {
  return tags.filter(Boolean).map((tag) => String(tag).toLowerCase());
}

function normalizeFields(
  fields: readonly TextQueryField[] | undefined,
): TextQueryField[] {
  if (!fields?.length) {
    return DEFAULT_TEXT_FIELDS.slice();
  }
  const normalized = fields.filter((field): field is TextQueryField => Boolean(field));
  return normalized.length ? normalized : DEFAULT_TEXT_FIELDS.slice();
}

function normalizeTextWeights(
  weights: TextQueryWeights | undefined,
): Record<TextQueryField, number> {
  const normalized: Record<TextQueryField, number> = {
    name: 1,
    description: 1,
    tags: 1,
    schemaKeys: 1,
    metadataKeys: 1,
  };
  if (!weights) return normalized;
  for (const [field, value] of Object.entries(weights)) {
    if (!(field in normalized)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    normalized[field as TextQueryField] = Math.max(0, value);
  }
  return normalized;
}

function clampThreshold(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0.7;
  }
  return Math.min(1, Math.max(0, value));
}

function emptyTextScore(): TextMatchScore {
  return {
    score: 0,
    fields: [],
    tagMatches: [],
    schemaMatches: [],
    metadataMatches: [],
    reasons: [],
  };
}

function extractMetadataKeys(metadata: JsonObject | undefined): string[] {
  if (!metadata || typeof metadata !== 'object') {
    return [];
  }
  return Object.keys(metadata);
}

function toToken(value: string): TextToken {
  return {
    raw: value,
    normalized: normalizeText(value),
  };
}

function scoreStringMatch(
  value: string,
  tokens: readonly string[],
  query: NormalizedTextQuery,
): number {
  if (!value) return 0;
  if (!query.tokens.length) return 0;
  if (query.mode === 'contains') {
    let score = 0;
    for (const token of query.tokens) {
      if (value.includes(token)) {
        score += 1;
      }
    }
    return score;
  }
  if (query.mode === 'exact') {
    let score = 0;
    for (const token of query.tokens) {
      if (value === token || tokens.includes(token)) {
        score += 1;
      }
    }
    return score;
  }
  let score = 0;
  for (const token of query.tokens) {
    let best = 0;
    for (const valueToken of tokens) {
      const maxPossible = maxSimilarityPossible(valueToken, token);
      if (maxPossible < query.threshold) {
        continue;
      }
      const score = similarity(valueToken, token);
      if (score > best) {
        best = score;
        if (best === 1) {
          break;
        }
      }
    }
    if (best >= query.threshold) {
      score += best;
    }
  }
  return score;
}

function scoreTokenMatches(
  tokens: readonly TextToken[],
  query: NormalizedTextQuery,
): { matches: string[]; score: number } {
  if (!tokens.length || !query.tokens.length) {
    return { matches: [], score: 0 };
  }
  const matches = new Set<string>();
  let score = 0;
  for (const queryToken of query.tokens) {
    let best = 0;
    let bestToken: string | null = null;
    for (const token of tokens) {
      const matchScore = scoreTokenMatch(
        token.normalized,
        queryToken,
        query.mode,
        query.threshold,
      );
      if (matchScore > best) {
        best = matchScore;
        bestToken = token.raw;
      }
    }
    if (best > 0) {
      score += best;
      if (bestToken) {
        matches.add(bestToken);
      }
    }
  }
  return { matches: Array.from(matches), score };
}

function scoreTokenMatchValue(
  tokens: readonly TextToken[],
  query: NormalizedTextQuery,
): number {
  if (!tokens.length || !query.tokens.length) {
    return 0;
  }
  let score = 0;
  for (const queryToken of query.tokens) {
    let best = 0;
    for (const token of tokens) {
      const matchScore = scoreTokenMatch(
        token.normalized,
        queryToken,
        query.mode,
        query.threshold,
      );
      if (matchScore > best) {
        best = matchScore;
        if (best === 1) {
          break;
        }
      }
    }
    if (best > 0) {
      score += best;
    }
  }
  return score;
}

function scoreTokenMatch(
  token: string,
  queryToken: string,
  mode: TextQueryMode,
  threshold: number,
): number {
  if (!token) return 0;
  if (mode === 'contains') {
    return token.includes(queryToken) ? 1 : 0;
  }
  if (mode === 'exact') {
    return token === queryToken ? 1 : 0;
  }
  if (token === queryToken) {
    return 1;
  }
  const maxPossible = maxSimilarityPossible(token, queryToken);
  if (maxPossible < threshold) {
    return 0;
  }
  const score = similarity(token, queryToken);
  return score >= threshold ? score : 0;
}

function tokenize(value: string): string[] {
  if (!value) return [];
  const normalized = normalizeForSearch(value);
  const withBoundaries = normalized
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2');
  return withBoundaries
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function normalizeText(value: string): string {
  return normalizeForSearch(value).toLowerCase();
}

function normalizeForSearch(value: unknown): string {
  if (typeof value === 'string') {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLength = Math.max(a.length, b.length);
  if (!maxLength) return 1;
  return 1 - levenshteinDistance(a, b) / maxLength;
}

function maxSimilarityPossible(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  if (!maxLength) {
    return 1;
  }
  const minDistance = Math.abs(a.length - b.length);
  return 1 - minDistance / maxLength;
}

function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  if (!aLen) return bLen;
  if (!bLen) return aLen;

  const prev = new Array<number>(bLen + 1);
  const curr = new Array<number>(bLen + 1);
  for (let j = 0; j <= bLen; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j++) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      const deletion = (prev[j] ?? 0) + 1;
      const insertion = (curr[j - 1] ?? 0) + 1;
      const substitution = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(deletion, insertion, substitution);
    }
    for (let j = 0; j <= bLen; j++) {
      prev[j] = curr[j] ?? 0;
    }
  }
  return prev[bLen] ?? 0;
}

export const internalQueryPredicateTestUtilities = {
  maxSimilarityPossible,
  normalizeForSearch,
};
