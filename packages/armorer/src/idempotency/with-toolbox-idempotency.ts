import type { Toolbox } from '../create-toolbox';
import type { ToolCallInput, ToolExecutionResult } from '../types';
import { claimCacheStarted, getCacheEntry } from './cache-operations';
import { fullInputKey, namespacedKey } from './key-generators';
import type { CachedToolResult, ToolResultCache } from './types';

const DEFAULT_TTL = 300_000;

/**
 * Options for wrapping a toolbox with idempotency.
 */
export type WithToolboxIdempotencyOptions = {
  /** The result cache shared across all tools in the toolbox. */
  cache: ToolResultCache;
  /** Default TTL in milliseconds for cached results. */
  defaultTTL?: number;
  /**
   * When true (default), only tools with an explicit `idempotencyKey` are wrapped.
   * When false, tools without an `idempotencyKey` are wrapped using `fullInputKey` as the default.
   */
  requireExplicitKey?: boolean;
};

type ToolboxExecuteOptionsWithIdempotencyKey = {
  idempotencyKey?: string | ((call: ToolCallInput) => string | undefined);
  retryUnknownOutcome?: boolean;
};

function shouldClearStartedState(result: ToolExecutionResult): boolean {
  if (result.outcome === 'action_required') {
    return true;
  }

  if (result.outcome !== 'error') {
    return true;
  }

  const category = result.error?.category ?? result.errorCategory;
  return category === 'validation' || category === 'permission' || category === 'not_found';
}

function shouldClearStartedStateForThrownError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const category = (error as { category?: unknown })['category'];
  return category === 'validation' || category === 'permission' || category === 'not_found';
}

/**
 * Wraps a toolbox so that tool executions are deduplicated via an idempotency
 * cache. Returns a new toolbox object — the original is not mutated.
 *
 * By default only tools that defined an `idempotencyKey` in their options
 * are wrapped. Set `requireExplicitKey: false` to auto-wrap all tools
 * using `fullInputKey` as the default key generator.
 */
export function withToolboxIdempotency(
  toolbox: Toolbox,
  options: WithToolboxIdempotencyOptions,
): Toolbox {
  const { cache, defaultTTL = DEFAULT_TTL, requireExplicitKey = true } = options;

  function getKeyFn(toolName: string): ((input: unknown) => string) | undefined {
    const tool = toolbox.getTool(toolName);
    if (!tool) return undefined;

    const explicitKey = (tool as unknown as Record<string, unknown>)['idempotencyKey'] as
      | ((input: unknown) => string)
      | undefined;

    if (explicitKey) return explicitKey;
    if (!requireExplicitKey) return fullInputKey;
    return undefined;
  }

  function extractCallFields(call: ToolCallInput): {
    name: string;
    id: string;
    arguments: unknown;
  } {
    const asRecord = call as unknown as Record<string, unknown>;
    return {
      name: asRecord['name'] as string,
      id: (asRecord['id'] as string) ?? '',
      arguments: asRecord['arguments'],
    };
  }

  function createUnknownOutcomeResult(
    fields: { id: string },
    cacheKey: string,
    toolName: string,
  ): ToolExecutionResult {
    return {
      callId: fields.id,
      outcome: 'action_required',
      content: 'Tool execution started earlier, but no result was recorded.',
      toolCallId: fields.id,
      toolName,
      result: undefined,
      idempotency: {
        key: cacheKey,
        outcome: 'unknown-outcome',
      },
      action: {
        type: 'approval',
        message:
          'This idempotency key has an unknown outcome. Re-approve before retrying the side effect.',
      },
    } as ToolExecutionResult;
  }

  function createDedupedResult(
    fields: { id: string },
    cacheKey: string,
    cached: CachedToolResult,
  ): ToolExecutionResult {
    return {
      callId: fields.id,
      outcome: 'success',
      content: typeof cached.result === 'string' ? cached.result : JSON.stringify(cached.result),
      toolCallId: fields.id,
      toolName: cached.toolName,
      result: cached.result,
      idempotency: {
        key: cacheKey,
        outcome: 'deduped',
      },
    } as ToolExecutionResult;
  }

  async function executeWithCache(
    call: ToolCallInput,
    originalExecute: (call: ToolCallInput, options?: unknown) => Promise<ToolExecutionResult>,
    executeOptions?: unknown,
  ): Promise<ToolExecutionResult> {
    const fields = extractCallFields(call);
    if (!fields.name) {
      return originalExecute(call, executeOptions);
    }

    const suppliedKey = (executeOptions as ToolboxExecuteOptionsWithIdempotencyKey | undefined)
      ?.idempotencyKey;
    const externalKey =
      typeof suppliedKey === 'function'
        ? suppliedKey(call)
        : typeof suppliedKey === 'string'
          ? suppliedKey
          : undefined;
    const keyFn = getKeyFn(fields.name);
    if (!keyFn && externalKey === undefined) {
      return originalExecute(call, executeOptions);
    }

    const cacheKey = namespacedKey(fields.name, externalKey ?? keyFn!(fields.arguments));
    const cached = await getCacheEntry(cache, cacheKey);

    const retryUnknownOutcome = (
      executeOptions as ToolboxExecuteOptionsWithIdempotencyKey | undefined
    )?.retryUnknownOutcome;

    if (cached?.status === 'started') {
      if (retryUnknownOutcome) {
        await cache.delete(cacheKey);
      } else {
        return createUnknownOutcomeResult(fields, cacheKey, cached.toolName);
      }
    } else if (cached) {
      return createDedupedResult(fields, cacheKey, cached);
    }

    let started = await claimCacheStarted(cache, cacheKey, {
      status: 'started',
      toolName: fields.name,
      startedAt: Date.now(),
      ttl: defaultTTL,
    });

    if (
      started.outcome === 'existing' &&
      started.entry.status === 'started' &&
      retryUnknownOutcome
    ) {
      await cache.delete(cacheKey);
      started = await claimCacheStarted(cache, cacheKey, {
        status: 'started',
        toolName: fields.name,
        startedAt: Date.now(),
        ttl: defaultTTL,
      });
    }

    if (started.outcome === 'existing') {
      const entry = started.entry;
      if (entry.status === 'started') {
        return createUnknownOutcomeResult(fields, cacheKey, entry.toolName);
      }

      return createDedupedResult(fields, cacheKey, entry);
    }

    let result: ToolExecutionResult;
    try {
      result = await originalExecute(call, executeOptions);
    } catch (error) {
      if (shouldClearStartedStateForThrownError(error)) {
        await cache.delete(cacheKey);
      }
      throw error;
    }

    // Only cache successful results
    if (result.outcome === 'success' && !result.error) {
      const entry: CachedToolResult = {
        result: result.result,
        toolName: result.toolName,
        executedAt: Date.now(),
        ttl: defaultTTL,
      };
      await cache.set(cacheKey, entry, defaultTTL);
      result.idempotency = {
        key: cacheKey,
        outcome: 'fresh',
      };
    } else if (shouldClearStartedState(result)) {
      await cache.delete(cacheKey);
    }

    return result;
  }

  // Proxy the toolbox to intercept execute calls
  return new Proxy(toolbox, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return async (
          input: ToolCallInput | ToolCallInput[],
          executeOptions?: unknown,
        ): Promise<ToolExecutionResult | ToolExecutionResult[]> => {
          const originalExecute = target.execute.bind(target) as (
            call: ToolCallInput,
            options?: unknown,
          ) => Promise<ToolExecutionResult>;

          if (Array.isArray(input)) {
            return Promise.all(
              input.map((call) => executeWithCache(call, originalExecute, executeOptions)),
            );
          }

          return executeWithCache(input, originalExecute, executeOptions);
        };
      }
      return Reflect.get(target as object, prop, receiver as object) as unknown;
    },
  });
}
