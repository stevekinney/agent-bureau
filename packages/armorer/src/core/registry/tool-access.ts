import { ToolboxQueryEvent, ToolboxSearchEvent } from '../../toolbox-discovery-events';
import { buildTextSearchIndex, type TextSearchIndex } from '../query-predicates';
import type { ToolSchema } from '../schema-utilities';
import { getRegistryEmbeddingIndex } from './embedding-index';
import { getRegistryEmbedder } from './embeddings';
import {
  buildInvertedIndex,
  buildTextInvertedIndex,
  getRegistryInvertedIndex,
  getRegistryTextIndex,
} from './indexes';
import { searchIndex } from './state';
import type {
  Embedder,
  EmbeddingIndex,
  InvertedIndex,
  QuerySelectionResult,
  TextInvertedIndex,
  ToolDefinition,
  ToolMatch,
  ToolQuery,
  ToolQueryCriteria,
  ToolQueryInput,
  ToolRegistryLike,
  ToolSearchOptions,
} from './types';

function getCachedTextIndex(tool: ToolDefinition): TextSearchIndex {
  const cached = searchIndex.get(tool);
  if (cached) return cached;
  const index = buildTextSearchIndex(tool);
  searchIndex.set(tool, index);
  return index;
}

function getObjectProperty(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

type RegistryWithGetTool = ToolRegistryLike & { getTool: (name: string) => ToolDefinition };

function hasGetTool(registry: ToolRegistryLike): registry is RegistryWithGetTool {
  return typeof getObjectProperty(registry, 'getTool') === 'function';
}

export function resolveTools(input: ToolQueryInput): {
  tools: readonly ToolDefinition[];
  dispatchEvent?: ToolRegistryLike['dispatchEvent'];
  getIndex: (tool: ToolDefinition) => TextSearchIndex;
  getInvertedIndex?: () => InvertedIndex;
  getTextIndex: () => TextInvertedIndex;
  getEmbeddingIndex?: () => EmbeddingIndex;
  embedder?: Embedder;
  registry?: ToolRegistryLike;
} {
  const getIndex = getCachedTextIndex;

  if (isToolRegistry(input)) {
    const embedder = getRegistryEmbedder(input);
    const tools = input.tools();
    const registry = input;
    const dispatchEvent = input.dispatchEvent?.bind(input);
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

export function isToolRegistered(registry: ToolRegistryLike, tool: ToolDefinition): boolean {
  if (hasGetTool(registry)) {
    return registry.getTool(tool.name) === tool;
  }
  return false;
}

export function isToolDefinition(value: unknown): value is ToolDefinition {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  const id = getObjectProperty(value, 'id');
  const identity = getObjectProperty(value, 'identity');
  const input = getObjectProperty(value, 'input');
  return (
    typeof id === 'string' &&
    typeof identity === 'object' &&
    identity !== null &&
    typeof getObjectProperty(identity, 'name') === 'string' &&
    input !== undefined
  );
}

export function getToolSchema(tool: ToolDefinition): ToolSchema {
  return tool.input;
}

export function isToolRegistry(value: unknown): value is ToolRegistryLike {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return typeof getObjectProperty(value, 'tools') === 'function';
}

export function emitQuery(
  dispatch: ToolRegistryLike['dispatchEvent'] | undefined,
  criteria: ToolQuery | undefined,
  results: QuerySelectionResult,
): void {
  if (!dispatch) return;
  dispatch(new ToolboxQueryEvent({ ...(criteria === undefined ? {} : { criteria }), results }));
}

export function emitSearch(
  dispatch: ToolRegistryLike['dispatchEvent'] | undefined,
  options: ToolSearchOptions,
  results: ToolMatch<unknown>[],
): void {
  if (!dispatch) return;
  dispatch(new ToolboxSearchEvent({ options, results }));
}

export function createQueryCacheKey(
  criteria: ToolQueryCriteria | undefined,
  toolsCount: number,
): string | null {
  if (!criteria) return JSON.stringify({ toolsCount });
  if (hasFunction(criteria)) return null;
  return JSON.stringify({ criteria, toolsCount });
}

export function hasFunction(obj: Record<string, unknown>): boolean {
  if (!obj || typeof obj !== 'object') return false;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'function') return true;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (isPlainObject(value) && hasFunction(value)) return true;
    }
  }
  return false;
}

export function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.iterator in value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}
