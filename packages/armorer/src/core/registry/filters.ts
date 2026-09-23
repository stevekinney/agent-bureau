import {
  buildTextSearchIndex,
  normalizeTextQuery,
  schemaHasKeys,
  schemaMatches,
  scoreTextMatchFromIndex,
  tagsMatchAll,
  tagsMatchAny,
  tagsMatchNone,
  type TextQuery,
  type TextSearchIndex,
  type ToolPredicate,
} from '../query-predicates';
import type { ToolRisk } from '../risk';
import type { JsonObject } from '../serialization/json';
import { scoreEmbeddingMatch } from './embedding-scoring';
import { getQueryEmbeddingInfo } from './embeddings';
import type {
  Embedder,
  MetadataPrimitive,
  MetadataRange,
  RiskFilter,
  ToolDefinition,
  ToolQueryCriteria,
} from './types';

export function compileCriteria(
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

export function evaluatePredicates(
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

export function buildPredicates(
  criteria: ToolQueryCriteria,
  options?: { getIndex?: (tool: ToolDefinition) => TextSearchIndex; embedder?: Embedder },
): ToolPredicate<ToolDefinition>[] {
  return [
    ...buildIdentityPredicates(criteria),
    ...buildRiskPredicates(criteria),
    ...buildTagPredicates(criteria),
    ...buildTextPredicates(criteria, options),
    ...buildSchemaPredicates(criteria),
    ...buildMetadataPredicates(criteria),
    ...buildCustomPredicates(criteria),
  ];
}

function buildIdentityPredicates(criteria: ToolQueryCriteria): ToolPredicate<ToolDefinition>[] {
  const predicates: ToolPredicate<ToolDefinition>[] = [];
  if (criteria.namespace !== undefined) {
    const namespaces = normalizeFilterValues(criteria.namespace);
    if (namespaces.length) predicates.push((tool) => namespaces.includes(tool.identity.namespace));
  }
  if (criteria.version !== undefined) {
    const versions = normalizeFilterValues(criteria.version);
    if (versions.length) predicates.push((tool) => versions.includes(tool.identity.version ?? ''));
  }
  if (criteria.deprecated !== undefined) {
    predicates.push((tool) => !!tool.lifecycle?.deprecated === criteria.deprecated);
  }
  return predicates;
}

function buildRiskPredicates(criteria: ToolQueryCriteria): ToolPredicate<ToolDefinition>[] {
  return criteria.risk ? [(tool) => riskMatches(tool.risk, criteria.risk!)] : [];
}

function buildTagPredicates(criteria: ToolQueryCriteria): ToolPredicate<ToolDefinition>[] {
  const predicates: ToolPredicate<ToolDefinition>[] = [];
  const { any, all, none } = criteria.tags ?? {};
  if (any?.length) predicates.push(tagsMatchAny(any));
  if (all?.length) predicates.push(tagsMatchAll(all));
  if (none?.length) predicates.push(tagsMatchNone(none));
  return predicates;
}

function buildTextPredicates(
  criteria: ToolQueryCriteria,
  options?: { getIndex?: (tool: ToolDefinition) => TextSearchIndex; embedder?: Embedder },
): ToolPredicate<ToolDefinition>[] {
  return criteria.text === undefined ? [] : [buildTextPredicate(criteria.text, options)];
}

function buildSchemaPredicates(criteria: ToolQueryCriteria): ToolPredicate<ToolDefinition>[] {
  const predicates: ToolPredicate<ToolDefinition>[] = [];
  const { keys, matches } = criteria.schema ?? {};
  if (keys?.length) predicates.push(schemaHasKeys(keys));
  if (matches) predicates.push(schemaMatches(matches));
  return predicates;
}

function buildMetadataPredicates(criteria: ToolQueryCriteria): ToolPredicate<ToolDefinition>[] {
  const metadata = criteria.metadata;
  if (!metadata) return [];
  return [
    ...buildMetadataKeyPredicates(metadata),
    ...buildMetadataValuePredicates(metadata),
    ...buildMetadataCustomPredicates(metadata),
  ];
}

function buildMetadataKeyPredicates(
  metadata: NonNullable<ToolQueryCriteria['metadata']>,
): ToolPredicate<ToolDefinition>[] {
  return metadata.has?.length ? [(tool) => metadataHasKeys(tool.metadata, metadata.has!)] : [];
}

function buildMetadataValuePredicates(
  metadata: NonNullable<ToolQueryCriteria['metadata']>,
): ToolPredicate<ToolDefinition>[] {
  const predicates: ToolPredicate<ToolDefinition>[] = [];
  if (metadata.eq && Object.keys(metadata.eq).length) {
    predicates.push((tool) => metadataEquals(tool.metadata, metadata.eq!));
  }
  if (metadata.contains && Object.keys(metadata.contains).length) {
    predicates.push((tool) => metadataContains(tool.metadata, metadata.contains!));
  }
  if (metadata.startsWith && Object.keys(metadata.startsWith).length) {
    predicates.push((tool) => metadataStartsWith(tool.metadata, metadata.startsWith!));
  }
  if (metadata.range && Object.keys(metadata.range).length) {
    predicates.push((tool) => metadataInRange(tool.metadata, metadata.range!));
  }
  return predicates;
}

function buildMetadataCustomPredicates(
  metadata: NonNullable<ToolQueryCriteria['metadata']>,
): ToolPredicate<ToolDefinition>[] {
  return metadata.predicate ? [(tool) => metadata.predicate!(tool.metadata)] : [];
}

function buildCustomPredicates(criteria: ToolQueryCriteria): ToolPredicate<ToolDefinition>[] {
  return criteria.predicate ? [criteria.predicate] : [];
}

export function buildTextPredicate(
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
    embedder && normalized.raw ? getQueryEmbeddingInfo(embedder, normalized.raw) : undefined;

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

export function normalizeFilterValues(value: string | readonly string[]): string[] {
  return typeof value === 'string' ? [value] : [...value];
}

export function normalizeSchemaKeys(keys: readonly string[]): string[] {
  return keys.map((key) => key.toLowerCase()).filter((key): key is string => Boolean(key));
}

export function riskMatches(risk: ToolRisk | undefined, filter: RiskFilter): boolean {
  return (
    matchesRiskFlag(risk, filter, 'readOnly') &&
    matchesRiskFlag(risk, filter, 'mutates') &&
    matchesRiskFlag(risk, filter, 'dangerous') &&
    matchesRiskFlag(risk, filter, 'untrustedOutput') &&
    matchesRiskPermissions(risk, filter.permissions)
  );
}

function matchesRiskFlag(
  risk: ToolRisk | undefined,
  filter: RiskFilter,
  key: 'readOnly' | 'mutates' | 'dangerous' | 'untrustedOutput',
): boolean {
  return filter[key] === undefined || (risk?.[key] === true) === filter[key];
}

function matchesRiskPermissions(
  risk: ToolRisk | undefined,
  permissions: readonly string[] | undefined,
): boolean {
  if (!permissions?.length) return true;
  const availablePermissions = risk?.permissions;
  if (!availablePermissions) return false;
  return permissions.every((permission) => availablePermissions.includes(permission));
}

export function metadataHasKeys(
  metadata: JsonObject | undefined,
  keys: readonly string[],
): boolean {
  if (!metadata) return false;
  for (const key of keys) {
    if (!(key in metadata)) return false;
  }
  return true;
}

export function metadataEquals(
  metadata: JsonObject | undefined,
  eq: Record<string, unknown>,
): boolean {
  if (!metadata) return false;
  for (const [key, value] of Object.entries(eq)) {
    if (metadata[key] !== value) return false;
  }
  return true;
}

export function metadataContains(
  metadata: JsonObject | undefined,
  contains: Partial<Record<string, MetadataPrimitive | readonly MetadataPrimitive[]>>,
): boolean {
  if (!metadata) return false;
  return Object.entries(contains).every(([key, needle]) =>
    needle === undefined ? true : metadataValueContains(metadata[key], needle),
  );
}

function metadataValueContains(
  value: JsonObject[string] | undefined,
  needle: MetadataPrimitive | readonly MetadataPrimitive[],
): boolean {
  if (typeof value === 'string' && typeof needle === 'string') return value.includes(needle);
  if (Array.isArray(value)) return arrayMetadataContains(value, needle);
  if (Array.isArray(needle)) return needle.includes(value);
  return value === needle;
}

function arrayMetadataContains(
  value: readonly unknown[],
  needle: MetadataPrimitive | readonly MetadataPrimitive[],
): boolean {
  return Array.isArray(needle)
    ? needle.every((item) => value.includes(item))
    : value.includes(needle);
}

export function metadataStartsWith(
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

export function metadataInRange(
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
