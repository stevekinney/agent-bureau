import { getSchemaKeys, schemasLooselyMatch, type ToolSchema } from './schema-utilities';
import type { TextQuery, TextSearchIndex } from './text-query';
import { buildTextSearchIndex, getToolSchema, normalizeTextQuery } from './text-query';
import {
  emptyTextScore,
  maxSimilarityPossible,
  normalizeForSearch,
  scoreTextMatchFromIndex,
} from './text-scoring';
import type { ToolDefinition } from './tool-definition';

export { buildTextSearchIndex, normalizeTextQuery } from './text-query';
export type {
  NormalizedTextQuery,
  TextMatchScore,
  TextQuery,
  TextQueryField,
  TextQueryMode,
  TextQueryWeights,
  TextSearchIndex,
  TextToken,
} from './text-query';
export { scoreTextMatchFromIndex, scoreTextMatchValueFromIndex } from './text-scoring';

type AnyTool = ToolDefinition;

export type ToolPredicate<T extends AnyTool = AnyTool> = (tool: T) => boolean;

/**
 * Matches tools that have ANY of the provided tags (OR logic).
 * Returns a match-all predicate if tags array is empty.
 */
export function tagsMatchAny(tags: readonly string[]): ToolPredicate {
  const normalized = normalizeTags(tags);
  if (!normalized.length) return () => true;
  const tagSet = new Set(normalized);
  return (tool) => (tool.tags ?? []).some((tag) => tagSet.has(tag.toLowerCase()));
}

/**
 * Matches tools that have ALL of the provided tags (AND logic).
 * Returns a match-all predicate if tags array is empty.
 */
export function tagsMatchAll(tags: readonly string[]): ToolPredicate {
  const normalized = normalizeTags(tags);
  if (!normalized.length) return () => true;
  return (tool) => {
    const lowerTags = (tool.tags ?? []).map((tag) => tag.toLowerCase());
    return normalized.every((tag) => lowerTags.includes(tag));
  };
}

/**
 * Matches tools that have NONE of the provided tags (exclusion).
 * Returns a match-all predicate if tags array is empty.
 */
export function tagsMatchNone(tags: readonly string[]): ToolPredicate {
  const normalized = normalizeTags(tags);
  if (!normalized.length) return () => true;
  const forbiddenSet = new Set(normalized);
  return (tool) => !(tool.tags ?? []).some((tag) => forbiddenSet.has(tag.toLowerCase()));
}

/** Creates a predicate that matches tools with compatible schemas. */
export function schemaMatches(schema: ToolSchema): ToolPredicate {
  return (tool) => schemasLooselyMatch(getToolSchema(tool), schema);
}

/** Creates a predicate that matches tools based on text search. */
export function textMatches(
  query: TextQuery,
  options?: { getIndex?: (tool: ToolDefinition) => TextSearchIndex },
): ToolPredicate {
  const normalized = normalizeTextQuery(query);
  if (!normalized) return () => true;
  const getIndex = options?.getIndex ?? buildTextSearchIndex;
  return (tool) => scoreTextMatchFromIndex(getIndex(tool), normalized).score > 0;
}

export function scoreTextMatch(tool: ToolDefinition, query: TextQuery) {
  const normalized = normalizeTextQuery(query);
  if (!normalized) return emptyTextScore();
  return scoreTextMatchFromIndex(buildTextSearchIndex(tool), normalized);
}

/** Creates a predicate that matches tools whose schema contains specific property keys. */
export function schemaHasKeys(keys: readonly string[]): ToolPredicate {
  const normalized = keys.map((key) => key.toLowerCase()).filter(Boolean);
  if (!normalized.length) return () => true;
  return (tool) => {
    const schemaKeys = getSchemaKeys(getToolSchema(tool)).map((key) => key.toLowerCase());
    return schemaKeys.length > 0 && normalized.every((needle) => schemaKeys.includes(needle));
  };
}

function normalizeTags(tags: readonly string[]): string[] {
  return tags.filter(Boolean).map((tag) => tag.toLowerCase());
}

export const internalQueryPredicateTestUtilities = {
  maxSimilarityPossible,
  normalizeForSearch,
};
