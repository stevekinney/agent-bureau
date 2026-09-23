import type { ToolDefinition, ToolMatch, ToolMatchDetails, ToolTieBreaker } from './types';

export function createMatchComparator(
  tieBreaker: ToolTieBreaker,
): (a: ToolMatch, b: ToolMatch) => number {
  if (typeof tieBreaker === 'function') return (a, b) => compareScore(a, b) || tieBreaker(a, b);
  if (tieBreaker === 'name')
    return (a, b) => compareScore(a, b) || a.tool.identity.name.localeCompare(b.tool.identity.name);
  return compareScore;
}

function compareScore(a: ToolMatch, b: ToolMatch): number {
  return b.score - a.score;
}

export function selectTopMatches<T>(
  items: T[],
  limit: number,
  compare: (a: T, b: T) => number,
): T[] {
  return items.toSorted(compare).slice(0, limit);
}

export function collectTagMatches(tool: ToolDefinition, tagSet: Set<string>): string[] {
  return tool.tags?.filter((tag) => tagSet.has(tag.toLowerCase())) ?? [];
}

export function scoreTagMatches(
  matches: readonly string[],
  weight: number,
  weights: Record<string, number>,
): number {
  return matches.reduce((score, tag) => score + weight * (weights[tag.toLowerCase()] ?? 1), 0);
}

export function scoreTagMatchesValue(
  tool: ToolDefinition,
  tagSet: Set<string>,
  weight: number,
  weights: Record<string, number>,
): number {
  return scoreTagMatches(collectTagMatches(tool, tagSet), weight, weights);
}

export function buildTagSet(
  preferredTags: readonly string[],
  tagWeights: Record<string, number>,
): Set<string> {
  return new Set([...preferredTags, ...Object.keys(tagWeights)]);
}

export function normalizeTagWeights(
  weights: Record<string, number> | undefined,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(weights ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

export function normalizeWeight(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}

export function mergeUnique<T>(a: T[] | undefined, b: T[] | undefined): T[] {
  return Array.from(new Set([...(a ?? []), ...(b ?? [])]));
}

export function mergeMatchDetails(target: ToolMatchDetails, source: ToolMatchDetails): void {
  if (source.fields) target.fields = mergeUnique(target.fields, source.fields);
  if (source.tags) target.tags = mergeUnique(target.tags, source.tags);
  if (source.schemaKeys) target.schemaKeys = mergeUnique(target.schemaKeys, source.schemaKeys);
  if (source.metadataKeys)
    target.metadataKeys = mergeUnique(target.metadataKeys, source.metadataKeys);
  if (source.embedding) target.embedding = source.embedding;
}
