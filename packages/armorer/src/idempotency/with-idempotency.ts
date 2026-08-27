import { stableStringifyJson } from '../core/serialization/json';
import type { Tool, ToolCallWithArguments, ToolExecuteOptions } from '../is-tool';
import { claimCacheStarted, getCacheEntry } from './cache-operations';
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
  const {
    cache,
    tenantId,
    toolRevision = tool.id,
    ttl = DEFAULT_TTL,
    now = Date.now,
    onCacheHit,
    onUnknownOutcome,
  } = options;
  if (!tenantId || !toolRevision) {
    throw new Error('Idempotency requires tenantId and toolRevision.');
  }

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

  async function executeWithCache(
    params: unknown,
    executeOptions?: ToolExecuteOptions,
  ): Promise<unknown> {
    const requestContext = executeOptions?.requestContext;
    if (executeOptions !== undefined && !requestContext) {
      throw new Error('Idempotency requires request-scoped execution authority.');
    }
    if (requestContext && requestContext.authority.tenantId !== tenantId) {
      throw new Error('Idempotency tenantId must match request authority tenantId.');
    }
    const authorityScope = requestContext
      ? [
          tenantId,
          requestContext.authority.principalId,
          requestContext.authority.authorizationRevision,
          [...requestContext.authority.capabilities].sort(),
          requestContext.agentId ?? null,
        ]
      : [tenantId];
    const key = stableStringifyJson([
      ...(requestContext ? [authorityScope] : [tenantId]),
      toolRevision,
      tool.name,
      idempotencyKey!(params),
    ] as never);

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

    const attemptId = crypto.randomUUID();
    const started = await claimCacheStarted(cache, key, {
      status: 'started',
      toolName: tool.name,
      startedAt: now(),
      ttl,
      attemptId,
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
    let result: unknown;
    try {
      result = executeOptions
        ? await tool.executeWith({ params, ...executeOptions })
        : await tool(params);
    } catch (error) {
      if (isPreExecutionFailure(error)) await cache.deleteStarted(key, attemptId);
      throw error;
    }

    if (isPreExecutionResult(result)) {
      await cache.deleteStarted(key, attemptId);
      return result;
    }

    const entry: CachedToolResult = {
      result,
      toolName: tool.name,
      executedAt: now(),
      ttl,
    };

    if (!(await cache.completeStarted(key, attemptId, entry, ttl))) {
      throw new Error(`Idempotency key "${key}" lost its execution fence before completion.`);
    }

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
          return executeWithCache(input, execOptions as ToolExecuteOptions | undefined);
        };
      }
      return Reflect.get(target, prop, receiver as object) as unknown;
    },
  });
}

function isPreExecutionFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { category?: unknown; code?: unknown };
  return (
    ['validation', 'permission', 'unavailable', 'not_found'].includes(String(candidate.category)) ||
    ['VALIDATION_ERROR', 'PERMISSION_DENIED', 'TOOL_UNAVAILABLE', 'NOT_FOUND'].includes(
      String(candidate.code),
    )
  );
}

function isPreExecutionResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const candidate = result as { outcome?: unknown; errorCategory?: unknown; error?: unknown };
  if (candidate.outcome !== 'error' && candidate.outcome !== 'action_required') return false;
  return (
    candidate.outcome === 'action_required' ||
    isPreExecutionFailure(candidate.error) ||
    ['validation', 'permission', 'unavailable', 'not_found'].includes(
      String(candidate.errorCategory),
    )
  );
}
