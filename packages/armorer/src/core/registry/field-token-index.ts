import { type TextSearchIndex } from '../query-predicates';
import { BIGRAM_SIZE, GRAM_SIZE } from './state';
import type { FieldTokenIndex, TextInvertedIndex, ToolDefinition } from './types';

export function createFieldTokenIndex(): FieldTokenIndex {
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

export function getTokenCharacters(token: string): string[] {
  if (!token) {
    return [];
  }
  const chars = new Set<string>();
  for (const char of token) {
    chars.add(char);
  }
  return Array.from(chars);
}

export function isAsciiAlphaNumeric(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}

export function getTokenGrams(token: string, size = GRAM_SIZE): string[] {
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

export function addFieldTokens(
  fieldIndex: FieldTokenIndex,
  tokens: readonly string[],
  tool: ToolDefinition,
): void {
  for (const token of tokens) {
    addFieldToken(fieldIndex, token, tool);
  }
}

function addFieldToken(fieldIndex: FieldTokenIndex, token: string, tool: ToolDefinition): void {
  if (!token) return;
  addIndexedValue(fieldIndex.map, fieldIndex.tokens, token, tool);
  addIndexedValue(fieldIndex.lengthMap, fieldIndex.lengths, token.length, tool);
  addDerivedTokenValues(fieldIndex.charMap, getTokenCharacters(token), tool);
  addDerivedTokenValues(fieldIndex.bigramMap, getTokenGrams(token, BIGRAM_SIZE), tool);
  addDerivedTokenValues(fieldIndex.gramMap, getTokenGrams(token), tool);
}

function addIndexedValue<T>(
  map: Map<T, Set<ToolDefinition>>,
  values: T[],
  value: T,
  tool: ToolDefinition,
): void {
  const bucket = getOrCreateBucket(map, value);
  if (!values.includes(value)) values.push(value);
  bucket.add(tool);
}

function addDerivedTokenValues(
  map: Map<string, Set<ToolDefinition>>,
  values: readonly string[],
  tool: ToolDefinition,
): void {
  for (const value of values) getOrCreateBucket(map, value).add(tool);
}

function getOrCreateBucket<T>(map: Map<T, Set<ToolDefinition>>, value: T): Set<ToolDefinition> {
  const existing = map.get(value);
  if (existing) return existing;
  const created = new Set<ToolDefinition>();
  map.set(value, created);
  return created;
}

export function addToolToTextIndex(
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

export function removeToolFromTextIndex(
  textIndex: TextInvertedIndex,
  tool: ToolDefinition,
  index: TextSearchIndex,
): void {
  removeFieldTokens(textIndex.fields.name, [index.name, ...(index.nameTokens ?? [])], tool);
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

export function removeFieldTokens(
  fieldIndex: FieldTokenIndex,
  tokens: readonly string[],
  tool: ToolDefinition,
): void {
  for (const token of tokens) {
    removeFieldToken(fieldIndex, token, tool);
  }
}

function removeFieldToken(fieldIndex: FieldTokenIndex, token: string, tool: ToolDefinition): void {
  if (!token) return;
  removeIndexedValue(fieldIndex.map, fieldIndex.tokens, token, tool);
  removeIndexedValue(fieldIndex.lengthMap, fieldIndex.lengths, token.length, tool);
  removeDerivedTokenValues(fieldIndex.charMap, getTokenCharacters(token), tool);
  removeDerivedTokenValues(fieldIndex.bigramMap, getTokenGrams(token, BIGRAM_SIZE), tool);
  removeDerivedTokenValues(fieldIndex.gramMap, getTokenGrams(token), tool);
}

function removeIndexedValue<T>(
  map: Map<T, Set<ToolDefinition>>,
  values: T[],
  value: T,
  tool: ToolDefinition,
): void {
  if (removeFromBucket(map, value, tool)) removeStoredValue(values, value);
}

function removeDerivedTokenValues(
  map: Map<string, Set<ToolDefinition>>,
  values: readonly string[],
  tool: ToolDefinition,
): void {
  for (const value of values) removeFromBucket(map, value, tool);
}

function removeFromBucket<T>(
  map: Map<T, Set<ToolDefinition>>,
  value: T,
  tool: ToolDefinition,
): boolean {
  const bucket = map.get(value);
  if (!bucket) return false;
  bucket.delete(tool);
  if (bucket.size) return false;
  map.delete(value);
  return true;
}

function removeStoredValue<T>(values: T[], value: T): void {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}
