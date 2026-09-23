import { type TextQueryField, type TextSearchIndex } from '../query-predicates';
import { getSchemaKeys } from '../schema-utilities';
import { addFieldTokens, createFieldTokenIndex } from './field-token-index';
import { registryInvertedIndex, registryTextIndex, toolLookupCache } from './state';
import type {
  FieldTokenIndex,
  InvertedIndex,
  TextInvertedIndex,
  ToolDefinition,
  ToolLookupCache,
} from './types';

export function buildToolLookup(tool: ToolDefinition): ToolLookupCache {
  const tags = (tool.tags ?? []).filter((tag): tag is string => Boolean(tag));
  const tagsLower = tags.map((tag) => tag.toLowerCase());
  const schemaKeysLower = getSchemaKeys(tool.input).map((key) => key.toLowerCase());
  return {
    tags,
    tagsLower,
    tagSet: new Set(tagsLower),
    schemaKeysLower,
    schemaKeySet: new Set(schemaKeysLower),
  };
}

export function getToolLookup(tool: ToolDefinition): ToolLookupCache {
  const cached = toolLookupCache.get(tool);
  if (cached) {
    return cached;
  }
  const lookup = buildToolLookup(tool);
  toolLookupCache.set(tool, lookup);
  return lookup;
}

export function buildInvertedIndex(tools: readonly ToolDefinition[]): InvertedIndex {
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

export function buildTextInvertedIndex(
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

export function addToolToInvertedIndex(index: InvertedIndex, tool: ToolDefinition): void {
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

export function removeToolFromInvertedIndex(index: InvertedIndex, tool: ToolDefinition): void {
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

export function getRegistryInvertedIndex(
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

export function getRegistryTextIndex(
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
