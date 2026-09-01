import { sha256HexSync } from 'interoperability';

import { assertJsonValue, stableStringifyJson } from '../core/serialization/json';
import {
  approvalConsumeSymbol,
  approvalResumeSymbol,
  executionCallbackStartSymbol,
  policyAuthorizationOnlySymbol,
} from '../internal/approval-resume';
import type {
  Tool,
  ToolCallWithArguments,
  ToolExecuteOptions,
  ToolExecuteWithOptions,
} from '../is-tool';
import { claimCacheStarted, getCacheEntry } from './cache-operations';
import type {
  CachedToolResult,
  IdempotencyOptions,
  IdempotencyResolutionReceipt,
  LegacyIdempotencyResolutionReceipt,
  StartedToolExecution,
} from './types';

const DEFAULT_TTL = 300_000;
const DEFAULT_LEASE_DURATION = 30_000;
const maximumTimerDelay = 2_147_483_647;

function scheduleBoundedTimeout(
  callback: () => void,
  delay: number,
  setTimeoutFunction: NonNullable<ToolExecuteOptions['setTimeoutFunction']> = (
    handler,
    milliseconds,
  ) => setTimeout(handler, milliseconds),
  clearTimeoutFunction: NonNullable<ToolExecuteOptions['clearTimeoutFunction']> = (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
): () => void {
  let remaining = Math.max(0, delay);
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (cancelled) return;
    const chunk = Math.min(remaining, maximumTimerDelay);
    timer = setTimeoutFunction(() => {
      if (cancelled) return;
      remaining -= chunk;
      if (remaining <= 0) callback();
      else schedule();
    }, chunk) as ReturnType<typeof setTimeout>;
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeoutFunction(timer);
  };
}

export type DirectIdempotencyExecuteOptions = ToolExecuteOptions & {
  resolutionReceipt?: IdempotencyResolutionReceipt;
  legacyResolutionReceipt?: LegacyIdempotencyResolutionReceipt;
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

async function inputMatchesToolSchema(
  tool: Tool,
  params: unknown,
  options?: ToolExecuteOptions,
): Promise<boolean> {
  const input = (
    tool as unknown as {
      input?: { safeParseAsync?: (value: unknown) => Promise<{ success: boolean }> };
    }
  ).input;

  if (typeof input?.safeParseAsync !== 'function') {
    return true;
  }
  const safeParseAsync = input.safeParseAsync;

  // `safeParseAsync` (not `safeParse`) so schemas with async refinements —
  // e.g. a non-Zod Standard Schema wrapped via `wrapStandardSchema`, whose
  // validation runs through an async `transform` — resolve instead of
  // throwing synchronously ("Encountered Promise during synchronous parse").
  const result = await raceIdempotencyAwait(() => safeParseAsync(params), options);
  return result.success;
}

function raceIdempotencyAwait<T>(
  operation: () => Promise<T>,
  options?: ToolExecuteOptions,
): Promise<T> {
  const signal = options?.signal;
  const deadline = options?.requestContext?.deadline;
  const now = options?.now ?? Date.now;
  if (deadline !== undefined && !Number.isFinite(deadline)) {
    return Promise.reject(createUnsupportedDeadlineError());
  }
  if (deadline !== undefined && deadline <= now()) {
    return Promise.reject(createPrevalidationDeadlineError());
  }
  if (signal?.aborted) {
    return Promise.reject(createPrevalidationCancellationError(signal.reason));
  }

  let promise: Promise<T>;
  try {
    promise = operation();
  } catch (error) {
    return Promise.reject(normalizeIdempotencyError(error));
  }

  if (!signal && deadline === undefined) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const setTimeoutFunction =
      options?.setTimeoutFunction ??
      ((callback, milliseconds) => setTimeout(callback, milliseconds));
    const clearTimeoutFunction =
      options?.clearTimeoutFunction ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let deadlineTimer: unknown;
    let deadlineTimerScheduled = false;
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      clearDeadline();
    };
    const clearDeadline = () => {
      if (!deadlineTimerScheduled) return;
      deadlineTimerScheduled = false;
      clearTimeoutFunction(deadlineTimer);
    };
    const scheduleDeadline = () => {
      if (deadline === undefined) return;
      const remaining = deadline - now();
      const delay = remaining <= 0 ? 0 : Math.min(remaining, maximumTimerDelay);
      deadlineTimerScheduled = true;
      deadlineTimer = setTimeoutFunction(() => {
        deadlineTimerScheduled = false;
        if (settled) return;
        if (deadline <= now()) {
          rejectOnce(createPrevalidationDeadlineError());
          return;
        }
        scheduleDeadline();
      }, delay);
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    function onAbort() {
      rejectOnce(createPrevalidationCancellationError(signal?.reason));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    scheduleDeadline();
    void promise.then(resolveOnce, (error) => rejectOnce(normalizeIdempotencyError(error)));
  });
}

function createPrevalidationCancellationError(reason?: unknown): Error {
  const message =
    typeof reason === 'string' && reason.length > 0
      ? reason
      : reason instanceof Error && reason.message.length > 0
        ? reason.message
        : 'Cancelled';
  const error = new Error(message) as Error & { category: 'cancelled'; code: 'CANCELLED' };
  error.category = 'cancelled';
  error.code = 'CANCELLED';
  return error;
}

function createPrevalidationDeadlineError(): Error {
  const error = new Error('Execution deadline exceeded') as Error & {
    category: 'timeout';
    code: 'TIMEOUT';
  };
  error.category = 'timeout';
  error.code = 'TIMEOUT';
  return error;
}

function createUnsupportedDeadlineError(): Error {
  return new Error('Execution deadline must be finite.');
}

function createStartedExecution(
  toolName: string,
  startedAt: number,
  inputDigest: string,
  ttl: number,
  leaseDurationMs: number,
  maximumExecutionDurationMs: number,
): StartedToolExecution {
  return {
    status: 'started',
    toolName,
    startedAt,
    ttl,
    attemptId: crypto.randomUUID(),
    leaseExpiresAt: Math.min(startedAt + leaseDurationMs, startedAt + maximumExecutionDurationMs),
    absoluteDeadline: startedAt + maximumExecutionDurationMs,
    inputDigest,
  };
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
    verifyLegacyResolutionReceipt,
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
    if (!requestContext) {
      throw new Error('Idempotency requires request-scoped execution authority.');
    }
    if (requestContext && requestContext.authority.tenantId !== tenantId) {
      throw new Error('Idempotency tenantId must match request authority tenantId.');
    }
    if (executeOptions?.stream) {
      throw new Error('Idempotency does not support streaming executions.');
    }
    const key = stableStringifyJson([
      tenantId,
      completeToolRevision,
      tool.name,
      idempotencyKey!(params),
    ]);

    await inputMatchesToolSchema(tool, params, executeOptions);

    const returnAuthorizedCachedResult = async (cached: CachedToolResult): Promise<unknown> => {
      if (cached.input === undefined) {
        throw new Error('Cached result lacks its original input and cannot be reauthorized.');
      }
      let originalParams: unknown;
      try {
        originalParams = cached.inputWasUndefined ? undefined : JSON.parse(cached.input);
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
    };

    const originalInput = serializeOriginalInput(params);
    const inputDigest = createInputDigest(originalInput);

    const cached = await raceIdempotencyAwait(() => getCacheEntry(cache, key), executeOptions);
    if (cached && cached.status !== 'started') {
      return returnAuthorizedCachedResult(cached);
    }

    let startedExecution: StartedToolExecution;
    if (cached?.status === 'started') {
      if (cached.attemptId === undefined) {
        const legacyReceipt = executeOptions?.legacyResolutionReceipt;
        let validLegacyReceipt = false;
        if (
          legacyReceipt?.version === 1 &&
          legacyReceipt.key === key &&
          legacyReceipt.tenantId === tenantId &&
          legacyReceipt.toolRevision === completeToolRevision &&
          legacyReceipt.toolName === cached.toolName &&
          legacyReceipt.legacyStartedAt === cached.startedAt &&
          legacyReceipt.decision === 'retry' &&
          legacyReceipt.evidence &&
          legacyReceipt.authorizedAt !== undefined &&
          legacyReceipt.authorizedBy &&
          legacyReceipt.nonce &&
          legacyReceipt.authorization &&
          verifyLegacyResolutionReceipt
        ) {
          validLegacyReceipt = Boolean(
            await raceIdempotencyAwait(
              () => Promise.resolve(verifyLegacyResolutionReceipt(legacyReceipt)),
              executeOptions,
            ),
          );
        }
        const replacementTime = now();
        if (
          !validLegacyReceipt ||
          (cached.leaseExpiresAt !== undefined && replacementTime < cached.leaseExpiresAt)
        ) {
          onUnknownOutcome?.(key, cached);
          throw new Error(`Idempotency key "${key}" has an unknown outcome.`);
        }
        startedExecution = createStartedExecution(
          tool.name,
          replacementTime,
          inputDigest,
          ttl,
          leaseDurationMs,
          maximumExecutionDurationMs,
        );
        if (
          !(await cache.replaceLegacyStarted(
            key,
            { toolName: cached.toolName, startedAt: cached.startedAt },
            startedExecution,
            replacementTime,
          ))
        ) {
          onUnknownOutcome?.(key, cached);
          throw new Error(`Idempotency key "${key}" has an unknown outcome.`);
        }
      } else {
        const receipt = executeOptions?.resolutionReceipt;
        const receiptMatchesInput =
          cached.inputDigest !== undefined &&
          receipt?.inputDigest === cached.inputDigest &&
          inputDigest === cached.inputDigest;
        let validReceipt = false;
        if (
          receiptMatchesInput &&
          receipt?.version === 1 &&
          receipt.key === key &&
          receipt.attemptId === cached.attemptId &&
          receipt.tenantId === tenantId &&
          receipt.toolRevision === completeToolRevision &&
          receipt.decision === 'retry' &&
          receipt.evidence &&
          receipt.authorizedAt !== undefined &&
          receipt.authorizedBy &&
          receipt.nonce &&
          receipt.authorization &&
          verifyResolutionReceipt
        ) {
          validReceipt = Boolean(
            await raceIdempotencyAwait(
              () => Promise.resolve(verifyResolutionReceipt(receipt)),
              executeOptions,
            ),
          );
        }
        const replacementTime = now();
        if (
          !validReceipt ||
          (cached.leaseExpiresAt !== undefined && replacementTime < cached.leaseExpiresAt)
        ) {
          onUnknownOutcome?.(key, cached);
          throw new Error(`Idempotency key "${key}" has an unknown outcome.`);
        }
        startedExecution = createStartedExecution(
          tool.name,
          replacementTime,
          inputDigest,
          ttl,
          leaseDurationMs,
          maximumExecutionDurationMs,
        );
        const cachedAttemptId = cached.attemptId;
        if (
          !(await cache.replaceUnknownStarted(
            key,
            cachedAttemptId,
            startedExecution,
            replacementTime,
          ))
        ) {
          onUnknownOutcome?.(key, cached);
          throw new Error(`Idempotency key "${key}" has an unknown outcome.`);
        }
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
        inputDigest,
      };
      // Once the atomic claim begins, observe its result before honoring
      // cancellation. Otherwise the store can commit a claim after the raced
      // caller has already returned, leaving a false unknown outcome.
      const started = await claimCacheStarted(cache, key, startedExecution);
      if (started.outcome === 'existing') {
        if (started.entry.status === 'started') {
          onUnknownOutcome?.(key, started.entry);
          throw new Error(`Idempotency key "${key}" has an unknown outcome.`);
        }
        return returnAuthorizedCachedResult(started.entry);
      }
    }
    try {
      await raceIdempotencyAwait(() => Promise.resolve(), executeOptions);
    } catch (error) {
      await cache.deleteStarted(key, startedExecution.attemptId!);
      throw error;
    }
    const admissionTime = now();
    if (
      startedExecution.absoluteDeadline !== undefined &&
      admissionTime >= startedExecution.absoluteDeadline
    ) {
      await cache.deleteStarted(key, startedExecution.attemptId!);
      throw new Error(`Idempotency key "${key}" exceeded its maximum execution duration.`);
    }
    const initialRenewal = cache.renewStarted(
      key,
      startedExecution.attemptId!,
      Math.min(
        admissionTime + leaseDurationMs,
        startedExecution.absoluteDeadline ?? admissionTime + leaseDurationMs,
      ),
      admissionTime,
    );
    let leaseOwned: boolean;
    try {
      leaseOwned = await raceIdempotencyAwait(() => initialRenewal, executeOptions);
    } catch (error) {
      void initialRenewal
        .then((owned) =>
          owned ? cache.deleteStarted(key, startedExecution.attemptId!) : undefined,
        )
        .catch(() => undefined);
      if (
        executeOptions?.signal?.aborted ||
        (executeOptions?.requestContext?.deadline !== undefined &&
          executeOptions.requestContext.deadline <= (executeOptions.now ?? now)())
      ) {
        throw error;
      }
      throw new Error(`Idempotency key "${key}" lost its execution fence before admission.`, {
        cause: error,
      });
    }
    if (!leaseOwned) {
      throw new Error(`Idempotency key "${key}" lost its execution fence before admission.`);
    }
    let pendingRenewal = Promise.resolve();
    let renewalTimer: (() => void) | undefined;
    let renewalStopped = false;
    const setTimeoutFunction =
      executeOptions?.setTimeoutFunction ??
      ((callback: () => void, milliseconds?: number) => setTimeout(callback, milliseconds));
    const clearTimeoutFunction =
      executeOptions?.clearTimeoutFunction ??
      ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const stopRenewal = () => {
      renewalStopped = true;
      renewalTimer?.();
    };
    const scheduleRenewal = () => {
      if (renewalStopped) return;
      renewalTimer = scheduleBoundedTimeout(
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
            })
            .finally(scheduleRenewal);
        },
        Math.max(1, Math.floor(leaseDurationMs / 2)),
        setTimeoutFunction,
        clearTimeoutFunction,
      );
    };
    scheduleRenewal();
    const cancelDeadlineTimer = scheduleBoundedTimeout(
      stopRenewal,
      Math.max(0, (startedExecution.absoluteDeadline ?? now()) - startedExecution.startedAt),
      setTimeoutFunction,
      clearTimeoutFunction,
    );

    let callbackStarted = false;
    let toolExecution: Awaited<ReturnType<Tool['executeWith']>>;
    try {
      toolExecution = await tool.executeWith({
        params,
        ...(executeOptions ?? {}),
        [executionCallbackStartSymbol]: () => {
          callbackStarted = true;
        },
      } as ToolExecuteWithOptions);
    } catch (error) {
      if (!callbackStarted) {
        await cache.deleteStarted(key, startedExecution.attemptId!);
      }
      throw error;
    } finally {
      stopRenewal();
      cancelDeadlineTimer();
      try {
        await raceIdempotencyAwait(() => pendingRenewal, executeOptions);
      } catch {
        leaseOwned = false;
      }
    }

    if (toolExecution.outcome !== 'success') {
      if (!callbackStarted || isPreExecutionResult(toolExecution)) {
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
      input: originalInput,
      ...(params === undefined ? { inputWasUndefined: true as const } : {}),
    };

    let completed = false;
    if (leaseOwned) {
      try {
        completed = await raceIdempotencyAwait(
          () => cache.completeStarted(key, startedExecution.attemptId!, entry, ttl, now()),
          executeOptions,
        );
      } catch {
        completed = false;
      }
    }
    if (!completed) {
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
      return executeWithCache(input, argArray[1] as DirectIdempotencyExecuteOptions | undefined);
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
  const jsonInput = input === undefined ? null : input;
  assertJsonValue(jsonInput, 'idempotency input');
  return stableStringifyJson(jsonInput);
}

function createInputDigest(serializedOriginalInput: string): string {
  return sha256HexSync(serializedOriginalInput);
}

function normalizeIdempotencyError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : 'Unknown error');
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
