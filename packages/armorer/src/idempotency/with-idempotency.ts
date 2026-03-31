import type { Tool } from '../is-tool';
import type { CachedToolResult, IdempotencyOptions } from './types';

const DEFAULT_TTL = 300_000;

/**
 * Wraps a tool with idempotency behavior. Duplicate executions with the same
 * input (as determined by the tool's `idempotencyKey`) return cached results
 * instead of re-executing. Errors are never cached — only successful results
 * are stored.
 *
 * The tool must have an `idempotencyKey` function defined in its options.
 * If not, this function throws a descriptive error.
 *
 * @param tool - The tool to wrap.
 * @param options - Idempotency configuration including cache, TTL, and callbacks.
 * @returns A new tool with the same interface but idempotent execution.
 */
export function withIdempotency<T extends Tool>(tool: T, options: IdempotencyOptions): T {
  const { cache, ttl = DEFAULT_TTL, onCacheHit } = options;

  // Access the idempotencyKey from the tool (set via createTool options)
  const idempotencyKey = (tool as unknown as Record<string, unknown>)['idempotencyKey'] as
    | ((input: unknown) => string)
    | undefined;

  if (!idempotencyKey) {
    throw new Error(
      `Tool "${tool.name}" does not have an idempotencyKey. ` +
        'Define an idempotencyKey function in the tool options before wrapping with withIdempotency().',
    );
  }

  async function executeWithCache(params: unknown): Promise<unknown> {
    const key = idempotencyKey!(params);

    const cached = await cache.get(key);
    if (cached) {
      onCacheHit?.(key, cached);
      return cached.result;
    }

    // Execute the tool's raw execute (params → result, throws on error)
    const result = await (tool as unknown as (params: unknown) => Promise<unknown>)(params);

    const entry: CachedToolResult = {
      result,
      toolName: tool.name,
      executedAt: Date.now(),
      ttl,
    };

    await cache.set(key, entry, ttl);

    return result;
  }

  // Create a proxy that intercepts callable behavior and the execute property
  return new Proxy(tool, {
    apply(_target, _thisArg, argArray: unknown[]) {
      const input: unknown = argArray[0];
      // If it looks like a ToolCall (has name + id properties), delegate to original
      if (input !== null && typeof input === 'object' && 'name' in input && 'id' in input) {
        // ToolCall-style execution goes through the original
        return (tool as unknown as (params: unknown) => Promise<unknown>)(input);
      }
      return executeWithCache(input);
    },
    get(target, prop, receiver) {
      if (prop === 'execute') {
        // Return a function that handles both ToolCall and direct params
        return (input: unknown, execOptions?: unknown) => {
          if (
            input !== null &&
            typeof input === 'object' &&
            'name' in (input as Record<string, unknown>) &&
            'id' in (input as Record<string, unknown>)
          ) {
            return target.execute(input as never, execOptions as never);
          }
          return executeWithCache(input);
        };
      }
      return Reflect.get(target as object, prop, receiver as object) as unknown;
    },
  });
}
