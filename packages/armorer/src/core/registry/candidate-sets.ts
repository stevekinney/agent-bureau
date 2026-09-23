import { getTokenCharacters, getTokenGrams } from './field-token-index';
import type { FieldTokenIndex, ToolDefinition } from './types';

export function collectGramCandidates(
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

export function collectLengthCandidates(
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

export function collectCharCandidates(
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

export function collectCharIntersectionCandidates(
  fieldIndex: FieldTokenIndex,
  token: string,
): Set<ToolDefinition> | null {
  const chars = getTokenCharacters(token);
  if (!chars.length) {
    return null;
  }
  return intersectFromIndex(fieldIndex.charMap, chars);
}

export function collectTagCandidates(
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

export function collectSchemaCandidates(
  schemaIndex: Map<string, Set<ToolDefinition>>,
  keys: string[],
): Set<ToolDefinition> | null {
  if (!keys.length) {
    return null;
  }
  return intersectFromIndex(schemaIndex, keys);
}

export function unionFromIndex(
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

export function intersectFromIndex(
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

export function intersectSets<T>(left: Set<T>, right: Set<T>): Set<T> {
  const result = new Set<T>();
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const item of small) {
    if (large.has(item)) {
      result.add(item);
    }
  }
  return result;
}

export function addCandidates(target: Set<ToolDefinition>, source: Iterable<ToolDefinition>): void {
  for (const tool of source) target.add(tool);
}
