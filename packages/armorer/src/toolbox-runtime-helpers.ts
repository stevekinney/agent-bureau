import {
  TOOLBOX_BUDGET_EXCEEDED_MARKER,
  type ToolboxBudgetExceededToolError,
  type ToolError,
  type ToolErrorCategory,
} from './core/errors';
import type { Embedder, EmbeddingVector } from './core/registry/embeddings';
import { isPromise } from './type-guards';

export function createToolError(
  category: ToolErrorCategory,
  message: string,
  code: string,
  retryable: boolean,
): ToolError {
  return { code, category, retryable, message };
}

export function createToolboxBudgetExceededToolError(
  message: string,
): ToolboxBudgetExceededToolError {
  return {
    ...createToolError('conflict', message, 'BUDGET_EXCEEDED', false),
    [TOOLBOX_BUDGET_EXCEEDED_MARKER]: true,
  };
}

export function extractErrorCode(error: unknown): string | undefined {
  const code = getStringProperty(error, 'code');
  if (code) return code;
  const name = getStringProperty(error, 'name');
  return name && name !== 'Error' ? name : undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const property = Reflect.get(value, key);
  return typeof property === 'string' ? property : undefined;
}

const embedderCache = new WeakMap<
  Embedder,
  Map<string, EmbeddingVector[] | Promise<EmbeddingVector[]>>
>();

export function createCachedEmbedder(
  embedder: Embedder,
  options?: { maxCacheSize?: number },
): Embedder {
  const maxCacheSize = options?.maxCacheSize ?? 1000;
  return (texts: string[]): EmbeddingVector[] | Promise<EmbeddingVector[]> => {
    const cacheKey = JSON.stringify(texts);
    let cache = embedderCache.get(embedder);
    if (!cache) {
      cache = new Map();
      embedderCache.set(embedder, cache);
    }
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    if (cache.size >= maxCacheSize) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    const result = embedder(texts);
    cache.set(cacheKey, result);
    if (isPromise(result)) result.catch(() => cache.delete(cacheKey));
    return result;
  };
}
