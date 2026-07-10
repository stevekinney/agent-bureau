import type { Tool, ToolCallWithArguments } from '../is-tool';
import { claimCacheStarted, getCacheEntry } from './cache-operations';
import { namespacedKey } from './key-generators';
import type { CachedToolResult, IdempotencyOptions } from './types';

const DEFAULT_TTL = 300_000;

/**
 * Checks whether a value is a ToolCall rather than raw tool input params.
 * A ToolCall has `id` (string), `name` (string), and `arguments` (the parsed input).
 * Requiring all three fields avoids false positives from tool inputs that happen
 * to have `name` and `id` string fields (e.g., a "create user" tool).
 */
function isToolCall(value: unknown): value is ToolCallWithArguments {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' && typeof record['id'] === 'string' && 'arguments' in record
  );
}

async function inputMatchesToolSchema(tool: Tool, params: unknown): Promise<boolean> {
  const input = (
    tool as unknown as {
      input?: { safeParseAsync?: (value: unknown) => Promise<{ success: boolean }> };
    }
  ).input;

  if (typeof input?.safeParseAsync !== 'function') {
    return true;
  }

  // `safeParseAsync` (not `safeParse`) so schemas with async refinements —
  // e.g. a non-Zod Standard Schema wrapped via `wrapStandardSchema`, whose
  // validation runs through an async `transform` — resolve instead of
  // throwing synchronously ("Encountered Promise during synchronous parse").
  const result = await input.safeParseAsync(params);
  return result.success;
}

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
  const { cache, ttl = DEFAULT_TTL, onCacheHit, onUnknownOutcome } = options;

  // Access the idempotencyKey from the tool (set via createTool options).
  // Tools store this as an own property set by createTool when configured.
  const idempotencyKey =
    'idempotencyKey' in tool
      ? (tool.idempotencyKey as ((input: unknown) => string) | undefined)
      : undefined;

  if (!idempotencyKey) {
    throw new Error(
      `Tool "${tool.name}" does not have an idempotencyKey. ` +
        'Define an idempotencyKey function in the tool options before wrapping with withIdempotency().',
    );
  }

  async function executeWithCache(params: unknown): Promise<unknown> {
    const key = namespacedKey(tool.name, idempotencyKey!(params));

    if (!(await inputMatchesToolSchema(tool, params))) {
      return tool(params);
    }

    const cached = await getCacheEntry(cache, key);
    if (cached?.status === 'started') {
      onUnknownOutcome?.(key, cached);
      throw new Error(`Idempotency key "${key}" has an unknown outcome.`);
    }
    if (cached) {
      onCacheHit?.(key, cached);
      return cached.result;
    }

    const started = await claimCacheStarted(cache, key, {
      status: 'started',
      toolName: tool.name,
      startedAt: Date.now(),
      ttl,
    });

    if (started.outcome === 'existing') {
      if (started.entry.status === 'started') {
        onUnknownOutcome?.(key, started.entry);
        throw new Error(`Idempotency key "${key}" has an unknown outcome.`);
      }
      onCacheHit?.(key, started.entry);
      return started.entry.result;
    }

    // Execute the tool via its callable interface (params → result)
    const result = await tool(params);

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
      // ToolCall-style execution goes through the original tool directly
      if (isToolCall(input)) {
        return tool(input);
      }
      return executeWithCache(input);
    },
    get(target, prop, receiver) {
      if (prop === 'execute') {
        // Return a function that handles both ToolCall and direct params
        return (input: unknown, execOptions?: unknown) => {
          if (isToolCall(input)) {
            return target.execute(input, execOptions as Record<string, unknown>);
          }
          return executeWithCache(input);
        };
      }
      return Reflect.get(target as object, prop, receiver as object) as unknown;
    },
  });
}
