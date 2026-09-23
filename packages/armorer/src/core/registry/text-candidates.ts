import type { NormalizedTextQuery } from '../query-predicates';
import {
  addCandidates,
  collectCharCandidates,
  collectCharIntersectionCandidates,
  collectGramCandidates,
  collectLengthCandidates,
  intersectSets,
} from './candidate-sets';
import { BIGRAM_SIZE, GRAM_SIZE } from './state';
import type { FieldTokenIndex, TextInvertedIndex, ToolDefinition } from './types';

export function selectTextCandidates(
  textIndex: TextInvertedIndex,
  normalized: NormalizedTextQuery,
): Set<ToolDefinition> | null {
  if (!normalized.tokens.length) return null;
  if (normalized.mode === 'fuzzy') return selectFuzzyTextCandidates(textIndex, normalized);
  if (normalized.mode === 'exact') return selectExactTextCandidates(textIndex, normalized);
  return selectPartialTextCandidates(textIndex, normalized);
}

function selectFuzzyTextCandidates(
  textIndex: TextInvertedIndex,
  normalized: NormalizedTextQuery,
): Set<ToolDefinition> | null {
  if (normalized.threshold <= 0) return null;
  return collectTextCandidateMatches(textIndex, normalized, collectFuzzyTokenCandidates);
}

function selectExactTextCandidates(
  textIndex: TextInvertedIndex,
  normalized: NormalizedTextQuery,
): Set<ToolDefinition> | null {
  return collectTextCandidateMatches(textIndex, normalized, collectExactTokenCandidates);
}

function selectPartialTextCandidates(
  textIndex: TextInvertedIndex,
  normalized: NormalizedTextQuery,
): Set<ToolDefinition> | null {
  return collectTextCandidateMatches(textIndex, normalized, collectPartialTokenCandidates);
}

type TokenCandidateCollector = (
  fieldIndex: FieldTokenIndex,
  queryToken: string,
  normalized: NormalizedTextQuery,
) => Set<ToolDefinition> | null;

function collectTextCandidateMatches(
  textIndex: TextInvertedIndex,
  normalized: NormalizedTextQuery,
  collectTokenCandidates: TokenCandidateCollector,
): Set<ToolDefinition> | null {
  const candidates = new Set<ToolDefinition>();
  let matchedAny = false;
  for (const field of normalized.fields) {
    const matchedField = collectFieldTextCandidates(
      textIndex.fields[field],
      normalized,
      collectTokenCandidates,
    );
    if (!matchedField) continue;
    matchedAny = true;
    addCandidates(candidates, matchedField);
  }
  return matchedAny ? candidates : new Set();
}

function collectFieldTextCandidates(
  fieldIndex: FieldTokenIndex | undefined,
  normalized: NormalizedTextQuery,
  collectTokenCandidates: TokenCandidateCollector,
): Set<ToolDefinition> | null {
  if (!fieldIndex) return null;
  const candidates = new Set<ToolDefinition>();
  let matchedAny = false;
  for (const queryToken of normalized.tokens) {
    if (!queryToken) continue;
    const tokenCandidates = collectTokenCandidates(fieldIndex, queryToken, normalized);
    if (!tokenCandidates?.size) continue;
    matchedAny = true;
    addCandidates(candidates, tokenCandidates);
  }
  return matchedAny ? candidates : null;
}

function collectFuzzyTokenCandidates(
  fieldIndex: FieldTokenIndex,
  queryToken: string,
  normalized: NormalizedTextQuery,
): Set<ToolDefinition> | null {
  const bounds = getFuzzyLengthBounds(queryToken, normalized.threshold);
  if (!bounds) return null;
  const lengthCandidates = collectLengthCandidates(fieldIndex, bounds.minLen, bounds.maxLen);
  const charCandidates = collectCharCandidates(fieldIndex, queryToken);
  return lengthCandidates?.size && charCandidates?.size
    ? intersectSets(lengthCandidates, charCandidates)
    : null;
}

function getFuzzyLengthBounds(
  queryToken: string,
  threshold: number,
): { minLen: number; maxLen: number } | null {
  const length = queryToken.length;
  const minLen = Math.ceil(length * threshold);
  const maxLen = Math.floor(length / threshold);
  return Number.isFinite(minLen) && Number.isFinite(maxLen) ? { minLen, maxLen } : null;
}

function collectExactTokenCandidates(
  fieldIndex: FieldTokenIndex,
  queryToken: string,
): Set<ToolDefinition> | null {
  return fieldIndex.map.get(queryToken) ?? null;
}

function collectPartialTokenCandidates(
  fieldIndex: FieldTokenIndex,
  queryToken: string,
): Set<ToolDefinition> | null {
  if (queryToken.length >= GRAM_SIZE) {
    return (
      collectGramCandidates(fieldIndex.gramMap, queryToken, GRAM_SIZE) ??
      collectCharIntersectionCandidates(fieldIndex, queryToken)
    );
  }
  if (queryToken.length === BIGRAM_SIZE) {
    return (
      collectGramCandidates(fieldIndex.bigramMap, queryToken, BIGRAM_SIZE) ??
      collectCharIntersectionCandidates(fieldIndex, queryToken)
    );
  }
  return collectCharIntersectionCandidates(fieldIndex, queryToken);
}
