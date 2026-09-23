import {
  type NormalizedTextQuery,
  normalizeTextQuery,
  type TextSearchIndex,
} from '../query-predicates';
import { normalizeTags } from '../tag-utilities';
import { collectSchemaCandidates, collectTagCandidates, intersectSets } from './candidate-sets';
import { compileCriteria, normalizeSchemaKeys } from './filters';
import { buildInvertedIndex } from './indexes';
import { selectTextCandidates } from './text-candidates';
import { isPlainObject } from './tool-access';
import type {
  Embedder,
  InvertedIndex,
  TextInvertedIndex,
  ToolDefinition,
  ToolQueryCriteria,
} from './types';

export {
  collectCharCandidates,
  collectCharIntersectionCandidates,
  collectGramCandidates,
  collectLengthCandidates,
  collectSchemaCandidates,
  collectTagCandidates,
  intersectFromIndex,
  intersectSets,
  unionFromIndex,
} from './candidate-sets';
export { selectEmbeddingCandidates } from './embedding-candidates';
export { selectTextCandidates } from './text-candidates';

export function filterTools(
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

export function selectCandidateTools(
  tools: readonly ToolDefinition[],
  criteria: ToolQueryCriteria,
  getInvertedIndex: (() => InvertedIndex) | undefined,
  getTextIndex: () => TextInvertedIndex,
  embedder?: Embedder,
): ToolDefinition[] {
  const request = buildCandidateRequest(criteria);
  if (!hasCandidateConstraints(request)) return [...tools];

  const index = getInvertedIndex ? getInvertedIndex() : buildInvertedIndex(tools);
  const candidateSet = combineCandidateSets([
    collectTagCandidates(index.tagIndex, request.anyTags, request.allTags),
    collectSchemaCandidates(index.schemaKeyIndex, request.schemaKeys),
    selectTextCandidateSet(request.normalizedText, getTextIndex, embedder),
  ]);

  if (!candidateSet) return [...tools];
  if (!candidateSet.size) return [];
  return tools.filter((tool) => candidateSet.has(tool));
}

type CandidateRequest = {
  anyTags: string[];
  allTags: string[];
  schemaKeys: string[];
  normalizedText: NormalizedTextQuery | null;
};

function buildCandidateRequest(criteria: ToolQueryCriteria): CandidateRequest {
  const tags = criteria.tags;
  return {
    anyTags: normalizeTags(tags?.any ?? []),
    allTags: normalizeTags(tags?.all ?? []),
    schemaKeys: normalizeSchemaKeys(criteria.schema?.keys ?? []),
    normalizedText: criteria.text ? normalizeTextQuery(criteria.text) : null,
  };
}

function hasCandidateConstraints(request: CandidateRequest): boolean {
  return Boolean(
    request.anyTags.length ||
    request.allTags.length ||
    request.schemaKeys.length ||
    request.normalizedText,
  );
}

function selectTextCandidateSet(
  normalizedText: NormalizedTextQuery | null,
  getTextIndex: () => TextInvertedIndex,
  embedder: Embedder | undefined,
): Set<ToolDefinition> | null {
  return normalizedText && !embedder ? selectTextCandidates(getTextIndex(), normalizedText) : null;
}

function combineCandidateSets(
  candidateSets: readonly (Set<ToolDefinition> | null)[],
): Set<ToolDefinition> | null {
  let result: Set<ToolDefinition> | null = null;
  for (const candidates of candidateSets) {
    if (!candidates) continue;
    result = result ? intersectSets(result, candidates) : candidates;
  }
  return result;
}
