import type { JsonValue } from '../core/serialization/json';
import { stableStringifyJson } from '../core/serialization/json';
import {
  approvalConsumeSymbol,
  approvalResumeSymbol,
  policyAuthorizationOnlySymbol,
} from '../internal/approval-resume';
import type { Tool, ToolCallWithArguments, ToolExecuteOptions } from '../is-tool';
import { claimCacheStarted, getCacheEntry } from './cache-operations';
import type {
  CachedToolResult,
  IdempotencyOptions,
  IdempotencyResolutionReceipt,
  StartedToolExecution,
} from './types';

const DEFAULT_TTL = 300_000;
const DEFAULT_LEASE_DURATION = 30_000;

export type DirectIdempotencyExecuteOptions = ToolExecuteOptions & {
  resolutionReceipt?: IdempotencyResolutionReceipt;
};

export type IdempotentTool<T extends Tool> = T & {
  execute: (params: unknown, options?: DirectIdempotencyExecuteOptions) => Promise<unknown>;
};

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
export function withIdempotency<T extends Tool>(
  tool: T,
  options: IdempotencyOptions,
): IdempotentTool<T> {
  const {
    cache,
    tenantId,
    toolRevision: configuredToolRevision,
    ttl = DEFAULT_TTL,
    now = Date.now,
    onCacheHit,
    onUnknownOutcome,
    verifyResolutionReceipt,
    leaseDurationMs = DEFAULT_LEASE_DURATION,
    maximumExecutionDurationMs = Math.max(ttl, DEFAULT_TTL),
  } = options;
  const toolRevision = configuredToolRevision ?? (tool.identity.version ? tool.id : undefined);
  if (!tenantId || !toolRevision) {
    throw new Error('Idempotency requires tenantId and a versioned tool definition revision.');
  }
  const completeToolRevision = toolRevision;
  if (
    !Number.isFinite(leaseDurationMs) ||
    !Number.isFinite(maximumExecutionDurationMs) ||
    leaseDurationMs <= 0 ||
    maximumExecutionDurationMs <= 0
  ) {
    throw new Error('Idempotency lease and execution durations must be finite and positive.');
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
    executeOptions?: DirectIdempotencyExecuteOptions,
  ): Promise<unknown> {
    const requestContext = executeOptions?.requestContext;
    if (executeOptions !== undefined && !requestContext) {
      throw new Error('Idempotency requires request-scoped execution authority.');
    }
    if (requestContext && requestContext.authority.tenantId !== tenantId) {
      throw new Error('Idempotency tenantId must match request authority tenantId.');
    }
    const key = stableStringifyJson([
      tenantId,
      completeToolRevision,
      tool.name,
      idempotencyKey!(params),
    ]);

    if (!(await inputMatchesToolSchema(tool, params))) {
      return tool(params);
    }

    const cached = await getCacheEntry(cache, key);
    if (cached && cached.status !== 'started') {
      if (cached.input === undefined) {
        throw new Error('Cached result lacks its original input and cannot be reauthorized.');
      }
      let originalParams: unknown;
      try {
        originalParams = JSON.parse(cached.input);
      } catch {
        throw new Error('Cached result has invalid original input and cannot be reauthorized.');
      }
      if (typeof tool.executeWith === 'function') {
        const authorizationOptions = createPolicyAuthorizationOnlyOptions(executeOptions);
        const authorizationResult = await tool.executeWith({
          params: originalParams,
          ...(authorizationOptions as ToolExecuteOptions),
        });
        if (authorizationResult.outcome !== 'success' || authorizationResult.error) {
          throw new Error(
            authorizationResult.error?.message ??
              authorizationResult.errorMessage ??
              authorizationResult.pendingApproval?.reason ??
              'Tool execution failed.',
          );
        }
      }
      onCacheHit?.(key, cached);
      return cached.result;
    }

    let startedExecution: StartedToolExecution;
    if (cached?.status === 'started') {
      const receipt = executeOptions?.resolutionReceipt;
      const validReceipt =
        cached.attemptId !== undefined &&
        receipt?.version === 1 &&
        receipt.key === key &&
        receipt.attemptId === cached.attemptId &&
        receipt.tenantId === tenantId &&
        receipt.toolRevision === completeToolRevision &&
        receipt.decision === 'retry' &&
        Boolean(
          receipt.evidence &&
          receipt.authorizedAt !== undefined &&
          receipt.authorizedBy &&
          receipt.nonce &&
          receipt.authorization &&
          verifyResolutionReceipt &&
          (await verifyResolutionReceipt(receipt)),
        );
      const replacementTime = now();
      if (
        !validReceipt ||
        (cached.leaseExpiresAt !== undefined && replacementTime < cached.leaseExpiresAt)
      ) {
        onUnknownOutcome?.(key, cached);
        throw new Error(`Idempotency key "${key}" has an unknown outcome.`);
      }
      startedExecution = {
        status: 'started',
        toolName: tool.name,
        startedAt: replacementTime,
        ttl,
        attemptId: crypto.randomUUID(),
        leaseExpiresAt: Math.min(
          replacementTime + leaseDurationMs,
          replacementTime + maximumExecutionDurationMs,
        ),
        absoluteDeadline: replacementTime + maximumExecutionDurationMs,
      };
      if (
        !(await cache.replaceUnknownStarted(
          key,
          cached.attemptId!,
          startedExecution,
          replacementTime,
        ))
      ) {
        onUnknownOutcome?.(key, cached);
        throw new Error(`Idempotency key "${key}" has an unknown outcome.`);
      }
    } else {
      const startedAt = now();
      startedExecution = {
        status: 'started',
        toolName: tool.name,
        startedAt,
        ttl,
        attemptId: crypto.randomUUID(),
        leaseExpiresAt: Math.min(
          startedAt + leaseDurationMs,
          startedAt + maximumExecutionDurationMs,
        ),
        absoluteDeadline: startedAt + maximumExecutionDurationMs,
      };
      const started = await claimCacheStarted(cache, key, startedExecution);
      if (started.outcome === 'existing') {
        if (started.entry.status === 'started') {
          onUnknownOutcome?.(key, started.entry);
          throw new Error(`Idempotency key "${key}" has an unknown outcome.`);
        }
        onCacheHit?.(key, started.entry);
        return started.entry.result;
      }
    }
    let leaseOwned = true;
    let pendingRenewal = Promise.resolve();
    const stopRenewal = () => {
      clearInterval(renewalInterval);
    };
    const renewalInterval = setInterval(
      () => {
        pendingRenewal = pendingRenewal
          .then(async () => {
            const renewalTime = now();
            if (
              startedExecution.absoluteDeadline !== undefined &&
              renewalTime >= startedExecution.absoluteDeadline
            ) {
              stopRenewal();
              return;
            }
            leaseOwned =
              leaseOwned &&
              (await cache.renewStarted(
                key,
                startedExecution.attemptId!,
                Math.min(
                  renewalTime + leaseDurationMs,
                  startedExecution.absoluteDeadline ?? renewalTime + leaseDurationMs,
                ),
                renewalTime,
              ));
          })
          .catch(() => {
            leaseOwned = false;
          });
      },
      Math.max(1, Math.floor(leaseDurationMs / 2)),
    );
    const deadlineTimer = setTimeout(
      stopRenewal,
      Math.max(0, (startedExecution.absoluteDeadline ?? now()) - startedExecution.startedAt),
    );

    let toolExecution: Awaited<ReturnType<Tool['executeWith']>>;
    try {
      toolExecution = executeOptions
        ? await tool.executeWith({ params, ...executeOptions })
        : await tool.executeWith({ params });
    } catch (error) {
      if (isPreExecutionThrownError(error)) {
        await cache.deleteStarted(key, startedExecution.attemptId!);
      }
      throw error;
    } finally {
      stopRenewal();
      clearTimeout(deadlineTimer);
      await pendingRenewal;
    }

    if (toolExecution.outcome !== 'success') {
      if (isPreExecutionResult(toolExecution)) {
        await cache.deleteStarted(key, startedExecution.attemptId!);
      }
      const message =
        toolExecution.error?.message ??
        toolExecution.errorMessage ??
        toolExecution.pendingApproval?.reason ??
        'Tool execution failed.';
      throw new Error(message);
    }

    const result = toolExecution.result;
    const entry: CachedToolResult = {
      result,
      toolName: tool.name,
      executedAt: now(),
      ttl,
      input: serializeOriginalInput(params),
    };

    if (
      !leaseOwned ||
      !(await cache.completeStarted(key, startedExecution.attemptId!, entry, ttl, now()))
    ) {
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
          return executeWithCache(
            input,
            execOptions as DirectIdempotencyExecuteOptions | undefined,
          );
        };
      }
      return Reflect.get(target, prop, receiver as object) as unknown;
    },
  });
}

function serializeOriginalInput(input: unknown): string {
  return stableStringifyJson(
    JSON.parse(JSON.stringify(input === undefined ? null : input)) as JsonValue,
  );
}

function createPolicyAuthorizationOnlyOptions(
  executeOptions: DirectIdempotencyExecuteOptions | undefined,
): DirectIdempotencyExecuteOptions {
  const authorizationOnlyOptions: DirectIdempotencyExecuteOptions = {
    ...(executeOptions ?? {}),
  };
  const options = authorizationOnlyOptions as DirectIdempotencyExecuteOptions &
    Record<PropertyKey, unknown>;
  const hasApprovalResume = approvalResumeSymbol in options;
  options[policyAuthorizationOnlySymbol] = true;
  if (!hasApprovalResume) {
    delete options[approvalConsumeSymbol];
  }
  return authorizationOnlyOptions;
}

function isPreExecutionThrownError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const category = (error as { category?: unknown }).category;
  return (
    category === 'validation' ||
    category === 'permission' ||
    category === 'not_found' ||
    category === 'unavailable'
  );
}

function isPreExecutionResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const candidate = result as {
    outcome?: unknown;
    errorCategory?: unknown;
    error?: { category?: unknown };
  };
  if (candidate.outcome !== 'error' && candidate.outcome !== 'action_required') return false;
  if (candidate.outcome === 'action_required') return true;

  const category = candidate.error?.category ?? candidate.errorCategory;
  return (
    category === 'validation' ||
    category === 'permission' ||
    category === 'not_found' ||
    category === 'unavailable'
  );
}
