import { sha256HexSync } from '@lostgradient/cryptography';
import { type RuntimeServices } from '@lostgradient/lifecycle';

import { assertJsonValue, stableStringifyJson } from '../core/serialization/json';
import type { InternalToolExecuteOptions } from '../create-tool/execution-options';
import {
  approvalConsumeSymbol,
  approvalResumeSymbol,
  policyAuthorizationOnlySymbol,
} from '../internal/approval-resume';
import type { Tool, ToolCallWithArguments, ToolExecuteOptions } from '../is-tool';
import { maximumTimerDelay } from './bounded-timeout';
import type { IdempotencyResolutionReceipt, LegacyIdempotencyResolutionReceipt } from './types';

export type DirectExecuteOptions = ToolExecuteOptions & {
  resolutionReceipt?: IdempotencyResolutionReceipt;
  legacyResolutionReceipt?: LegacyIdempotencyResolutionReceipt;
};

export function isToolCall(value: unknown): value is ToolCallWithArguments {
  if (value === null || typeof value !== 'object') return false;
  const record = value;
  const name = Reflect.get(record, 'name');
  if (typeof name !== 'string') return false;
  const id = Reflect.get(record, 'id');
  return typeof id === 'string' && Reflect.has(record, 'arguments');
}

export async function inputMatchesToolSchema(
  tool: Tool,
  params: unknown,
  runtime: RuntimeServices,
  options?: ToolExecuteOptions,
): Promise<boolean> {
  const input = tool.input;
  if (typeof input?.safeParseAsync !== 'function') return true;
  const safeParseAsync = input.safeParseAsync.bind(undefined);
  const result = await raceIdempotencyAwait(() => safeParseAsync(params), runtime, options);
  return result.success;
}

export function raceIdempotencyAwait<T>(
  operation: () => Promise<T>,
  runtime: RuntimeServices,
  options?: ToolExecuteOptions,
): Promise<T> {
  const signal = options?.signal;
  const deadline = options?.requestContext?.deadline;
  const now = options?.now ?? runtime.clock.now;
  const validationError = validateAwaitBoundary(signal, deadline, now);
  if (validationError) return Promise.reject(validationError);
  const promise = invokeAwaitOperation(operation);
  if (!signal && deadline === undefined) return promise;
  return raceAwaitOperation(promise, signal, deadline, now, runtime, options);
}

function validateAwaitBoundary(
  signal: AbortSignal | undefined,
  deadline: number | undefined,
  now: () => number,
): Error | undefined {
  if (deadline !== undefined && !Number.isFinite(deadline)) return createUnsupportedDeadlineError();
  if (deadline !== undefined && deadline <= now()) return createPrevalidationDeadlineError();
  if (signal?.aborted) return createPrevalidationCancellationError(signal.reason);
  return undefined;
}

function invokeAwaitOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return operation();
  } catch (error) {
    return Promise.reject(normalizeIdempotencyError(error));
  }
}

function raceAwaitOperation<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number | undefined,
  now: () => number,
  runtime: RuntimeServices,
  options?: ToolExecuteOptions,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: unknown;
    let deadlineTimerScheduled = false;
    const clearDeadline = () => {
      if (!deadlineTimerScheduled) return;
      deadlineTimerScheduled = false;
      (options?.clearTimeoutFunction ?? runtime.timers.clearTimeout)(deadlineTimer);
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      clearDeadline();
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
    const scheduleDeadline = () => {
      if (deadline === undefined) return;
      const remaining = deadline - now();
      deadlineTimerScheduled = true;
      deadlineTimer = (options?.setTimeoutFunction ?? runtime.timers.setTimeout)(
        () => {
          deadlineTimerScheduled = false;
          if (settled) return;
          if (deadline <= now()) rejectOnce(createPrevalidationDeadlineError());
          else scheduleDeadline();
        },
        remaining <= 0 ? 0 : Math.min(remaining, maximumTimerDelay),
      );
    };
    function onAbort() {
      rejectOnce(createPrevalidationCancellationError(signal?.reason));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    scheduleDeadline();
    void promise.then(resolveOnce, (error) => rejectOnce(normalizeIdempotencyError(error)));
  });
}

export function createPrevalidationCancellationError(reason?: unknown): Error {
  const message =
    typeof reason === 'string' && reason.length > 0
      ? reason
      : reason instanceof Error && reason.message.length > 0
        ? reason.message
        : 'Cancelled';
  return Object.assign(new Error(message), {
    category: 'cancelled' as const,
    code: 'CANCELLED' as const,
  });
}

export function createPrevalidationDeadlineError(): Error {
  return Object.assign(new Error('Execution deadline exceeded'), {
    category: 'timeout' as const,
    code: 'TIMEOUT' as const,
  });
}

function createUnsupportedDeadlineError(): Error {
  return new Error('Execution deadline must be finite.');
}

export function serializeOriginalInput(input: unknown): string {
  const jsonInput = input === undefined ? null : input;
  assertJsonValue(jsonInput, 'idempotency input');
  return stableStringifyJson(jsonInput);
}

export function createInputDigest(serializedOriginalInput: string): string {
  return sha256HexSync(serializedOriginalInput);
}

export function normalizeIdempotencyError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : 'Unknown error');
}

export function createPolicyAuthorizationOnlyOptions(
  executeOptions: DirectExecuteOptions | undefined,
): DirectExecuteOptions & InternalToolExecuteOptions {
  const authorizationOnlyOptions: DirectExecuteOptions & InternalToolExecuteOptions = {
    ...executeOptions,
    [policyAuthorizationOnlySymbol]: true,
  };
  const hasApprovalResume = approvalResumeSymbol in authorizationOnlyOptions;
  if (!hasApprovalResume) delete authorizationOnlyOptions[approvalConsumeSymbol];
  return authorizationOnlyOptions;
}

export function isPreExecutionResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const outcome = Reflect.get(result, 'outcome');
  if (outcome !== 'error' && outcome !== 'action_required') return false;
  if (outcome === 'action_required') return true;
  const error = Reflect.get(result, 'error');
  const category =
    (error !== null && (typeof error === 'object' || typeof error === 'function')
      ? Reflect.get(error, 'category')
      : undefined) ?? Reflect.get(result, 'errorCategory');
  return isPreExecutionCategory(category);
}

function isPreExecutionCategory(
  value: unknown,
): value is 'validation' | 'permission' | 'not_found' | 'unavailable' {
  return (
    typeof value === 'string' &&
    ['validation', 'permission', 'not_found', 'unavailable'].includes(value)
  );
}
