import type { RuntimeServices } from '@lostgradient/lifecycle';
import { executionCallbackStartSymbol } from '../internal/approval-resume';
import type { Tool, ToolExecuteWithOptions } from '../is-tool';
import { scheduleBoundedTimeout } from './bounded-timeout';
import {
  isPreExecutionResult,
  raceIdempotencyAwait,
  type DirectExecuteOptions,
} from './direct-idempotency-support';
import type { CachedToolResult, StartedToolExecution, ToolResultCache } from './types';

export type DirectExecutionContext = {
  cache: ToolResultCache;
  leaseDurationMs: number;
  maximumExecutionDurationMs: number;
  now: () => number;
  runtime: RuntimeServices;
  tool: Tool;
  ttl: number;
};
type Lease = { owned: boolean };
type Renewal = { pending: () => Promise<void>; stop: () => void };

export async function executeClaimed(
  params: unknown,
  options: DirectExecuteOptions | undefined,
  key: string,
  originalInput: string,
  started: StartedToolExecution,
  context: DirectExecutionContext,
): Promise<unknown> {
  const lease: Lease = { owned: await renewOnAdmission(key, options, started, context) };
  assertLeaseOwned(lease.owned, key, 'admission');
  const renewal = startRenewal(key, options, started, lease, context);
  const callback = await executeCallback(params, options, key, started, renewal, context);
  const result = await requireSuccessfulResult(
    callback.started,
    callback.result,
    key,
    started,
    context,
  );
  const entry: CachedToolResult = {
    result,
    toolName: context.tool.name,
    executedAt: context.now(),
    ttl: context.ttl,
    input: originalInput,
    ...(params === undefined ? { inputWasUndefined: true as const } : {}),
  };
  await requireCompletedClaim(lease.owned, key, started, entry, options, context);
  return result;
}

function assertLeaseOwned(owned: boolean, key: string, phase: string): void {
  if (!owned) throw new Error(`Idempotency key "${key}" lost its execution fence before ${phase}.`);
}

async function requireSuccessfulResult(
  callbackStarted: boolean,
  result: Awaited<ReturnType<Tool['executeWith']>>,
  key: string,
  started: StartedToolExecution,
  context: DirectExecutionContext,
): Promise<unknown> {
  if (result.outcome === 'success') return result.result;
  if (!callbackStarted || isPreExecutionResult(result))
    await context.cache.deleteStarted(key, started.attemptId!);
  throw new Error(
    result.error?.message ?? result.pendingApproval?.reason ?? 'Tool execution failed.',
  );
}

async function requireCompletedClaim(
  owned: boolean,
  key: string,
  started: StartedToolExecution,
  entry: CachedToolResult,
  options: DirectExecuteOptions | undefined,
  context: DirectExecutionContext,
): Promise<void> {
  if (owned && (await completeClaim(key, started, entry, options, context))) return;
  throw new Error(`Idempotency key "${key}" lost its execution fence before completion.`);
}

function startRenewal(
  key: string,
  options: DirectExecuteOptions | undefined,
  started: StartedToolExecution,
  lease: Lease,
  context: DirectExecutionContext,
): Renewal {
  let pending = Promise.resolve();
  let stopped = false;
  let timer: (() => void) | undefined;
  const schedule = () => {
    if (stopped) return;
    timer = scheduleBoundedTimeout(
      () => {
        pending = pending
          .then(() => renewLease(key, started, context))
          .then((owned) => {
            lease.owned = lease.owned && owned;
            return undefined;
          })
          .catch(() => {
            lease.owned = false;
          })
          .finally(schedule);
      },
      Math.max(1, Math.floor(context.leaseDurationMs / 2)),
      context.runtime,
      options?.setTimeoutFunction,
      options?.clearTimeoutFunction,
    );
  };
  schedule();
  const deadline = scheduleBoundedTimeout(
    () => {
      stopped = true;
      timer?.();
    },
    Math.max(0, (started.absoluteDeadline ?? context.now()) - started.startedAt),
    context.runtime,
    options?.setTimeoutFunction,
    options?.clearTimeoutFunction,
  );
  return {
    pending: () => pending,
    stop: () => {
      stopped = true;
      timer?.();
      deadline();
    },
  };
}

async function executeCallback(
  params: unknown,
  options: DirectExecuteOptions | undefined,
  key: string,
  started: StartedToolExecution,
  renewal: Renewal,
  context: DirectExecutionContext,
): Promise<{ started: boolean; result: Awaited<ReturnType<Tool['executeWith']>> }> {
  let callbackStarted = false;
  try {
    const result = await context.tool.executeWith({
      params,
      ...options,
      [executionCallbackStartSymbol]: () => {
        callbackStarted = true;
      },
    } as ToolExecuteWithOptions);
    renewal.stop();
    try {
      await raceIdempotencyAwait(() => renewal.pending(), context.runtime, options);
    } catch {
      /* completion observes lease ownership */
    }
    return { started: callbackStarted, result };
  } catch (error) {
    renewal.stop();
    if (!callbackStarted) await context.cache.deleteStarted(key, started.attemptId!);
    throw error;
  }
}

async function renewLease(
  key: string,
  started: StartedToolExecution,
  context: DirectExecutionContext,
): Promise<boolean> {
  const observedAt = context.now();
  if (started.absoluteDeadline !== undefined && observedAt >= started.absoluteDeadline)
    return false;
  return context.cache.renewStarted(
    key,
    started.attemptId!,
    Math.min(
      observedAt + context.leaseDurationMs,
      started.absoluteDeadline ?? observedAt + context.leaseDurationMs,
    ),
    observedAt,
  );
}

async function completeClaim(
  key: string,
  started: StartedToolExecution,
  entry: CachedToolResult,
  options: DirectExecuteOptions | undefined,
  context: DirectExecutionContext,
): Promise<boolean> {
  try {
    return await raceIdempotencyAwait(
      () =>
        context.cache.completeStarted(key, started.attemptId!, entry, context.ttl, context.now()),
      context.runtime,
      options,
    );
  } catch {
    return false;
  }
}

async function renewOnAdmission(
  key: string,
  options: DirectExecuteOptions | undefined,
  started: StartedToolExecution,
  context: DirectExecutionContext,
): Promise<boolean> {
  try {
    await raceIdempotencyAwait(() => Promise.resolve(), context.runtime, options);
    const observedAt = context.now();
    if (started.absoluteDeadline !== undefined && observedAt >= started.absoluteDeadline)
      return expireAdmission(key, started, context);
    return await raceIdempotencyAwait(
      () =>
        context.cache.renewStarted(
          key,
          started.attemptId!,
          Math.min(
            observedAt + context.leaseDurationMs,
            started.absoluteDeadline ?? observedAt + context.leaseDurationMs,
          ),
          observedAt,
        ),
      context.runtime,
      options,
    );
  } catch (error) {
    await context.cache.deleteStarted(key, started.attemptId!);
    if (isAdmissionBoundaryError(error, options, context)) throw error;
    throw new Error(`Idempotency key "${key}" lost its execution fence before admission.`, {
      cause: error,
    });
  }
}

async function expireAdmission(
  key: string,
  started: StartedToolExecution,
  context: DirectExecutionContext,
): Promise<never> {
  await context.cache.deleteStarted(key, started.attemptId!);
  throw new Error(`Idempotency key "${key}" exceeded its maximum execution duration.`);
}

function isAdmissionBoundaryError(
  error: unknown,
  options: DirectExecuteOptions | undefined,
  context: DirectExecutionContext,
): boolean {
  if (error instanceof Error && error.message.includes('exceeded its maximum execution duration'))
    return true;
  return (
    options?.signal?.aborted === true ||
    (options?.requestContext?.deadline !== undefined &&
      options.requestContext.deadline <= (options.now ?? context.now)())
  );
}
