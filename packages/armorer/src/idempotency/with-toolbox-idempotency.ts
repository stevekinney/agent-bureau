import { sha256HexSync } from 'interoperability';
import { createDefaultRuntimeServices, type RuntimeServices } from 'lifecycle';

import type { JsonValue } from '../core/serialization/json';
import { stableStringifyJson } from '../core/serialization/json';
import type { AnyToolbox } from '../create-toolbox';
import type { ToolRequestContext } from '../execution-context';
import {
  approvalConsumeSymbol,
  approvalResumeSymbol,
  policyAuthorizationOnlySymbol,
} from '../internal/approval-resume';
import type { ToolCallInput, ToolExecutionResult } from '../types';
import { normalizeConcurrency } from '../utilities/concurrency';
import { claimCacheStarted, getCacheEntry } from './cache-operations';
import { fullInputKey, namespacedKey } from './key-generators';
import type {
  CachedToolResult,
  IdempotencyResolutionReceipt,
  LegacyIdempotencyResolutionReceipt,
  StartedToolExecution,
  ToolResultCache,
} from './types';

const DEFAULT_TTL = 300_000;
const maximumTimerDelay = 2_147_483_647;

async function cleanLateStartedWrite(
  cache: ToolResultCache,
  cacheKey: string,
  attemptId: string,
  write: Promise<boolean>,
): Promise<void> {
  try {
    if (await write) await cache.deleteStarted(cacheKey, attemptId);
  } catch {
    return;
  }
}

async function cleanLateClaim(
  cache: ToolResultCache,
  cacheKey: string,
  attemptId: string,
  claim: ReturnType<typeof claimCacheStarted>,
): Promise<void> {
  try {
    const claimResult = await claim;
    if (claimResult.outcome === 'claimed') await cache.deleteStarted(cacheKey, attemptId);
  } catch {
    return;
  }
}

function scheduleBoundedTimeout(
  callback: () => void,
  delay: number,
  runtime: RuntimeServices,
): () => void {
  const scheduleTimeout = runtime.timers.setTimeout;
  const cancelTimeout = runtime.timers.clearTimeout;
  let remaining = Math.max(0, delay);
  let cancelled = false;
  let timer: unknown;
  const schedule = () => {
    if (cancelled) return;
    const chunk = Math.min(remaining, maximumTimerDelay);
    timer = scheduleTimeout(() => {
      if (cancelled) return;
      remaining -= chunk;
      if (remaining <= 0) callback();
      else schedule();
    }, chunk);
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer !== undefined) cancelTimeout(timer);
  };
}

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
  tenantId: string;
  toolRevision?: string;
  policyRevision?: string;
  leaseDurationMs?: number;
  maximumExecutionDurationMs?: number;
  verifyResolutionReceipt?: (receipt: IdempotencyResolutionReceipt) => boolean | Promise<boolean>;
  verifyLegacyResolutionReceipt?: (
    receipt: LegacyIdempotencyResolutionReceipt,
  ) => boolean | Promise<boolean>;
  now?: () => number;
  createAttemptId?: () => string;
  /**
   * The injectable runtime-service seam (AB-92's `RuntimeServices`, AB-254):
   * wall time, timers, and identifiers backing this wrap's default `now`,
   * lease-renewal timer, and attempt-identifier generation. Resolved once,
   * at wrap time. A test composes its own from `armorer/test`'s
   * `createManualRuntimeServices()` instead of touching a real timer or a
   * real clock.
   */
  runtime?: RuntimeServices;
};

type ToolboxExecuteOptionsWithIdempotencyKey = {
  idempotencyKey?: string | ((call: ToolCallInput) => string | undefined);
  resolutionReceipt?: IdempotencyResolutionReceipt;
  legacyResolutionReceipt?: LegacyIdempotencyResolutionReceipt;
  requestContext?: ToolRequestContext;
  signal?: AbortSignal;
  now?: () => number;
  setTimeoutFunction?: (callback: () => void, milliseconds?: number) => unknown;
  clearTimeoutFunction?: (handle: unknown) => void;
  mode?: 'parallel' | 'sequential';
  concurrency?: number;
  stream?: boolean;
};

const PRE_EXECUTION_CONFLICT_CODES = new Set(['BUDGET_EXCEEDED', 'LOOP_BLOCKED']);

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const code = (error as { code?: unknown })['code'];
  return typeof code === 'string' ? code : undefined;
}

function isPreExecutionConflict(error: unknown): boolean {
  const code = getErrorCode(error);
  return code !== undefined && PRE_EXECUTION_CONFLICT_CODES.has(code);
}

function shouldClearStartedState(result: ToolExecutionResult): boolean {
  if (result.outcome === 'action_required') {
    return true;
  }

  if (result.outcome !== 'error') {
    return true;
  }

  const category = result.error?.category ?? result.errorCategory;
  return (
    category === 'validation' ||
    category === 'permission' ||
    category === 'unavailable' ||
    category === 'not_found' ||
    isPreExecutionConflict(result.error)
  );
}

function shouldClearStartedStateForThrownError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const category = (error as { category?: unknown })['category'];
  return (
    category === 'validation' ||
    category === 'permission' ||
    category === 'unavailable' ||
    category === 'not_found' ||
    isPreExecutionConflict(error)
  );
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
  toolbox: AnyToolbox,
  options: WithToolboxIdempotencyOptions,
): AnyToolbox {
  const runtime: RuntimeServices = options.runtime ?? createDefaultRuntimeServices();
  const {
    cache,
    defaultTTL = DEFAULT_TTL,
    requireExplicitKey = true,
    tenantId,
    toolRevision,
    policyRevision = 'policy:1',
    leaseDurationMs = 30_000,
    maximumExecutionDurationMs = Math.max(defaultTTL, DEFAULT_TTL),
    verifyResolutionReceipt,
    verifyLegacyResolutionReceipt,
    now = runtime.clock.now,
    createAttemptId = () => runtime.identifiers.next('attempt'),
  } = options;

  if (!tenantId) throw new Error('Idempotency requires a non-empty tenantId.');
  if (!policyRevision) throw new Error('Idempotency requires a non-empty policyRevision.');
  if (
    !Number.isFinite(leaseDurationMs) ||
    !Number.isFinite(maximumExecutionDurationMs) ||
    leaseDurationMs <= 0 ||
    maximumExecutionDurationMs <= 0
  ) {
    throw new Error('Idempotency lease and execution durations must be finite and positive.');
  }

  function getKeyFn(toolName: string): ((input: unknown) => string) | undefined {
    const tool = toolbox.getTool(toolName);
    if (!tool) return undefined;

    const explicitKey = (tool as unknown as Record<string, unknown>)['idempotencyKey'] as
      ((input: unknown) => string) | undefined;

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
    options: { attemptId?: string; inputDigest?: string; legacyStartedAt?: number } = {},
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
        ...(options.attemptId ? { attemptId: options.attemptId } : {}),
        ...(options.inputDigest ? { inputDigest: options.inputDigest } : {}),
        ...(options.legacyStartedAt !== undefined
          ? { legacyStartedAt: options.legacyStartedAt }
          : {}),
      },
      action: {
        type: 'approval',
        message:
          'This idempotency key has an unknown outcome. Re-approve before retrying the side effect.',
      },
    };
  }

  function createInterruptedResult(
    fields: { id: string },
    toolName: string,
    category: 'cancelled' | 'timeout',
    message: string,
    code: 'CANCELLED' | 'TIMEOUT',
  ): ToolExecutionResult {
    const error = { code, category, retryable: category === 'timeout', message };
    return {
      callId: fields.id,
      outcome: 'error',
      content: message,
      toolCallId: fields.id,
      toolName,
      result: undefined,
      error,
      errorMessage: message,
      errorCategory: category,
    };
  }

  async function awaitBeforeExecution<T>(
    operation: () => Promise<T>,
    fields: { id: string },
    toolName: string,
    executeOptions: unknown,
  ): Promise<
    { outcome: 'completed'; value: T } | { outcome: 'interrupted'; result: ToolExecutionResult }
  > {
    const controls = executeOptions as ToolboxExecuteOptionsWithIdempotencyKey | undefined;
    const signal = controls?.signal;
    const deadline = controls?.requestContext?.deadline;
    const currentTime = controls?.now ?? now;
    const cancelled = () =>
      createInterruptedResult(
        fields,
        toolName,
        'cancelled',
        formatCancellationReason(signal?.reason),
        'CANCELLED',
      );
    const timedOut = () =>
      createInterruptedResult(
        fields,
        toolName,
        'timeout',
        'Execution deadline exceeded',
        'TIMEOUT',
      );

    if (deadline !== undefined && !Number.isFinite(deadline)) {
      throw new Error('Execution deadline must be finite.');
    }
    if (deadline !== undefined && deadline <= currentTime()) {
      return { outcome: 'interrupted', result: timedOut() };
    }
    if (signal?.aborted) {
      return { outcome: 'interrupted', result: cancelled() };
    }

    let promise: Promise<T>;
    try {
      promise = operation();
    } catch (error) {
      return Promise.reject(normalizeIdempotencyError(error));
    }

    if (!signal && deadline === undefined) {
      return { outcome: 'completed', value: await promise };
    }

    return new Promise((resolve, reject) => {
      const setTimeoutFunction = controls?.setTimeoutFunction ?? runtime.timers.setTimeout;
      const clearTimeoutFunction = controls?.clearTimeoutFunction ?? runtime.timers.clearTimeout;
      let deadlineTimer: unknown;
      let deadlineTimerScheduled = false;
      let settled = false;

      const clearDeadline = () => {
        if (!deadlineTimerScheduled) return;
        deadlineTimerScheduled = false;
        clearTimeoutFunction(deadlineTimer);
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        clearDeadline();
      };
      const resolveOnce = (
        result:
          | { outcome: 'completed'; value: T }
          | { outcome: 'interrupted'; result: ToolExecutionResult },
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(normalizeIdempotencyError(error));
      };
      const scheduleDeadline = () => {
        if (deadline === undefined) return;
        const remaining = deadline - currentTime();
        const delay = remaining <= 0 ? 0 : Math.min(remaining, maximumTimerDelay);
        deadlineTimerScheduled = true;
        deadlineTimer = setTimeoutFunction(() => {
          deadlineTimerScheduled = false;
          if (settled) return;
          if (deadline <= currentTime()) {
            resolveOnce({ outcome: 'interrupted', result: timedOut() });
            return;
          }
          scheduleDeadline();
        }, delay);
      };
      function onAbort() {
        resolveOnce({ outcome: 'interrupted', result: cancelled() });
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      scheduleDeadline();
      void promise.then((value) => resolveOnce({ outcome: 'completed', value }), rejectOnce);
    });
  }

  function createAuthorizationRequiredResult(
    fields: { id: string },
    cacheKey: string,
    toolName: string,
  ): ToolExecutionResult {
    return {
      callId: fields.id,
      outcome: 'action_required',
      content: 'Cached result requires authorization under the current policy revision.',
      toolCallId: fields.id,
      toolName,
      result: undefined,
      idempotency: { key: cacheKey, outcome: 'authorization-required' },
      action: {
        type: 'approval',
        message: 'Re-authorize this cached result under the current policy revision.',
      },
    };
  }

  function createPolicyAuthorizationOnlyOptions(executeOptions: unknown): unknown {
    const hasApprovalResume =
      executeOptions !== undefined &&
      executeOptions !== null &&
      typeof executeOptions === 'object' &&
      approvalResumeSymbol in executeOptions;
    const authorizationOnlyOptions: Record<PropertyKey, unknown> = {
      ...(executeOptions as Record<PropertyKey, unknown> | undefined),
    };
    authorizationOnlyOptions[policyAuthorizationOnlySymbol] = true;
    if (!hasApprovalResume) {
      delete authorizationOnlyOptions[approvalConsumeSymbol];
    }
    return authorizationOnlyOptions;
  }

  async function createCompletedCacheHitResult(
    fields: { id: string },
    cacheKey: string,
    cached: CachedToolResult,
    call: ToolCallInput,
    originalExecute: (call: ToolCallInput, options?: unknown) => Promise<ToolExecutionResult>,
    executeOptions?: unknown,
  ): Promise<ToolExecutionResult> {
    if (cached.policyRevision !== policyRevision) {
      return createAuthorizationRequiredResult(fields, cacheKey, cached.toolName);
    }
    if (cached.input === undefined) {
      throw new Error('Cached result lacks its original input and cannot be reauthorized.');
    }
    let originalArguments: unknown;
    try {
      originalArguments = JSON.parse(cached.input);
    } catch {
      throw new Error('Cached result has invalid original input and cannot be reauthorized.');
    }
    const authorizationResult = await originalExecute(
      {
        ...call,
        arguments: originalArguments,
      },
      createPolicyAuthorizationOnlyOptions(executeOptions),
    );
    if (authorizationResult.outcome !== 'success' || authorizationResult.error) {
      return authorizationResult;
    }

    return createDedupedResult(fields, cacheKey, cached);
  }

  function hasReceiptAuthorization(
    receipt: IdempotencyResolutionReceipt | LegacyIdempotencyResolutionReceipt | undefined,
  ): boolean {
    return Boolean(
      receipt?.evidence && receipt.authorizedBy && receipt.nonce && receipt.authorization,
    );
  }

  function createStartedExecution(
    toolName: string,
    startedAt: number,
    inputDigest: string,
    previousAttemptId?: string,
  ): StartedToolExecution {
    const attemptId = createAttemptId();
    if (!attemptId || attemptId === previousAttemptId) {
      throw new Error('Idempotency attempt identifiers must be non-empty and unique.');
    }
    return {
      status: 'started',
      toolName,
      startedAt,
      ttl: defaultTTL,
      attemptId,
      leaseExpiresAt: Math.min(startedAt + leaseDurationMs, startedAt + maximumExecutionDurationMs),
      absoluteDeadline: startedAt + maximumExecutionDurationMs,
      inputDigest,
    };
  }

  async function createUnknownOutcomeAfterReplacementRace(
    fields: { id: string },
    cacheKey: string,
    fallbackToolName: string,
    call: ToolCallInput,
    originalExecute: (call: ToolCallInput, options?: unknown) => Promise<ToolExecutionResult>,
    executeOptions?: unknown,
  ): Promise<ToolExecutionResult> {
    const currentRead = await awaitBeforeExecution(
      () => cache.getState(cacheKey),
      fields,
      fallbackToolName,
      executeOptions,
    );
    if (currentRead.outcome === 'interrupted') {
      return currentRead.result;
    }
    const current = currentRead.value;
    if (current?.status === 'completed') {
      return createCompletedCacheHitResult(
        fields,
        cacheKey,
        current,
        call,
        originalExecute,
        executeOptions,
      );
    }
    const currentAttemptId = current?.status === 'started' ? current.attemptId : undefined;
    const legacyStartedAt =
      current?.status === 'started' && current.attemptId === undefined
        ? current.startedAt
        : undefined;
    return createUnknownOutcomeResult(fields, cacheKey, current?.toolName ?? fallbackToolName, {
      attemptId: currentAttemptId,
      inputDigest: current?.status === 'started' ? current.inputDigest : undefined,
      legacyStartedAt,
    });
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
    };
  }

  async function executeWithCache(
    call: ToolCallInput,
    originalExecute: (call: ToolCallInput, options?: unknown) => Promise<ToolExecutionResult>,
    executeOptions?: unknown,
  ): Promise<ToolExecutionResult> {
    if ((executeOptions as ToolboxExecuteOptionsWithIdempotencyKey | undefined)?.stream) {
      throw new Error('Idempotency does not support streaming executions.');
    }
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

    const tool = toolbox.getTool(fields.name);
    if (!tool) {
      return originalExecute(call, executeOptions);
    }
    const revision = toolRevision ?? formatToolRevision(tool);
    const baseKey = namespacedKey(fields.name, externalKey ?? keyFn!(fields.arguments));
    if (!revision) {
      throw new Error(`Idempotency requires a complete revision for tool ${fields.name}.`);
    }
    const executionIdempotencyOptions = executeOptions as
      ToolboxExecuteOptionsWithIdempotencyKey | undefined;
    const requestContext = executionIdempotencyOptions?.requestContext;
    if (!requestContext) {
      throw new Error('Idempotency requires request-scoped execution authority.');
    }
    if (requestContext.authority.tenantId !== tenantId) {
      throw new Error('Idempotency tenantId must match the request authority tenantId.');
    }
    const cacheKey = stableStringifyJson([tenantId, revision, baseKey]);
    const serializedOriginalInput = serializeOriginalInput(call.arguments);
    const inputDigest = createInputDigest(serializedOriginalInput);
    const cachedRead = await awaitBeforeExecution(
      () => getCacheEntry(cache, cacheKey),
      fields,
      fields.name,
      executeOptions,
    );
    if (cachedRead.outcome === 'interrupted') {
      return cachedRead.result;
    }
    const cached = cachedRead.value;

    const receipt = executionIdempotencyOptions?.resolutionReceipt;
    const legacyReceipt = executionIdempotencyOptions?.legacyResolutionReceipt;

    if (cached && cached.status !== 'started') {
      return createCompletedCacheHitResult(
        fields,
        cacheKey,
        cached,
        call,
        originalExecute,
        executeOptions,
      );
    }

    let execution: StartedToolExecution;
    let started;
    if (cached?.status === 'started') {
      if (cached.attemptId === undefined) {
        let validLegacyReceipt = false;
        if (
          legacyReceipt?.version === 1 &&
          legacyReceipt.key === cacheKey &&
          legacyReceipt.tenantId === tenantId &&
          legacyReceipt.toolRevision === revision &&
          legacyReceipt.toolName === cached.toolName &&
          legacyReceipt.legacyStartedAt === cached.startedAt &&
          legacyReceipt.decision === 'retry' &&
          hasReceiptAuthorization(legacyReceipt) &&
          verifyLegacyResolutionReceipt
        ) {
          const legacyReceiptVerification = await awaitBeforeExecution(
            () => Promise.resolve(verifyLegacyResolutionReceipt(legacyReceipt)),
            fields,
            cached.toolName,
            executeOptions,
          );
          if (legacyReceiptVerification.outcome === 'interrupted') {
            return legacyReceiptVerification.result;
          }
          validLegacyReceipt = legacyReceiptVerification.value === true;
        }
        if (!validLegacyReceipt) {
          return createUnknownOutcomeResult(fields, cacheKey, cached.toolName, {
            legacyStartedAt: cached.startedAt,
          });
        }
        const startedAt = now();
        if (cached.leaseExpiresAt !== undefined && startedAt < cached.leaseExpiresAt) {
          return createUnknownOutcomeResult(fields, cacheKey, cached.toolName, {
            legacyStartedAt: cached.startedAt,
          });
        }
        execution = createStartedExecution(fields.name, startedAt, inputDigest);
        const replacement = cache.replaceLegacyStarted(
          cacheKey,
          { toolName: cached.toolName, startedAt: cached.startedAt },
          execution,
          startedAt,
        );
        const replacedResult = await awaitBeforeExecution(
          () => replacement,
          fields,
          cached.toolName,
          executeOptions,
        );
        if (replacedResult.outcome === 'interrupted') {
          void cleanLateStartedWrite(cache, cacheKey, execution.attemptId!, replacement);
          return replacedResult.result;
        }
        const replaced = replacedResult.value;
        if (!replaced) {
          return createUnknownOutcomeAfterReplacementRace(
            fields,
            cacheKey,
            cached.toolName,
            call,
            originalExecute,
            executeOptions,
          );
        }
        started = { outcome: 'claimed' } as const;
      } else {
        const receiptMatchesInput =
          cached.inputDigest !== undefined &&
          receipt?.inputDigest === cached.inputDigest &&
          inputDigest === cached.inputDigest;
        let validReceipt = false;
        if (
          receiptMatchesInput &&
          receipt?.version === 1 &&
          receipt.key === cacheKey &&
          receipt.attemptId === cached.attemptId &&
          receipt.tenantId === tenantId &&
          receipt.toolRevision === revision &&
          receipt.decision === 'retry' &&
          hasReceiptAuthorization(receipt) &&
          verifyResolutionReceipt
        ) {
          const receiptVerification = await awaitBeforeExecution(
            () => Promise.resolve(verifyResolutionReceipt(receipt)),
            fields,
            cached.toolName,
            executeOptions,
          );
          if (receiptVerification.outcome === 'interrupted') {
            return receiptVerification.result;
          }
          validReceipt = receiptVerification.value === true;
        }
        if (!validReceipt) {
          return createUnknownOutcomeResult(fields, cacheKey, cached.toolName, {
            attemptId: cached.attemptId,
            inputDigest: cached.inputDigest,
          });
        }
        const startedAt = now();
        if (cached.leaseExpiresAt !== undefined && startedAt < cached.leaseExpiresAt) {
          return createUnknownOutcomeResult(fields, cacheKey, cached.toolName, {
            attemptId: cached.attemptId,
            inputDigest: cached.inputDigest,
          });
        }
        const cachedAttemptId = cached.attemptId;
        execution = createStartedExecution(fields.name, startedAt, inputDigest, cachedAttemptId);
        const replacement = cache.replaceUnknownStarted(
          cacheKey,
          cachedAttemptId,
          execution,
          startedAt,
        );
        const replacedResult = await awaitBeforeExecution(
          () => replacement,
          fields,
          cached.toolName,
          executeOptions,
        );
        if (replacedResult.outcome === 'interrupted') {
          void cleanLateStartedWrite(cache, cacheKey, execution.attemptId!, replacement);
          return replacedResult.result;
        }
        const replaced = replacedResult.value;
        if (!replaced) {
          return createUnknownOutcomeAfterReplacementRace(
            fields,
            cacheKey,
            cached.toolName,
            call,
            originalExecute,
            executeOptions,
          );
        }
        started = { outcome: 'claimed' } as const;
      }
    } else {
      const startedAt = now();
      execution = createStartedExecution(fields.name, startedAt, inputDigest);
      const claim = claimCacheStarted(cache, cacheKey, execution);
      const startedResult = await awaitBeforeExecution(
        () => claim,
        fields,
        fields.name,
        executeOptions,
      );
      if (startedResult.outcome === 'interrupted') {
        void cleanLateClaim(cache, cacheKey, execution.attemptId!, claim);
        return startedResult.result;
      }
      started = startedResult.value;
    }

    if (started.outcome === 'existing') {
      const entry = started.entry;
      if (entry.status === 'started') {
        return createUnknownOutcomeResult(fields, cacheKey, entry.toolName, {
          attemptId: entry.attemptId,
          inputDigest: entry.inputDigest,
          legacyStartedAt: entry.attemptId === undefined ? entry.startedAt : undefined,
        });
      }

      return createCompletedCacheHitResult(
        fields,
        cacheKey,
        entry,
        call,
        originalExecute,
        executeOptions,
      );
    }

    const admissionTime = now();
    if (admissionTime >= execution.absoluteDeadline!) {
      await cache.deleteStarted(cacheKey, execution.attemptId!);
      return createInterruptedResult(
        fields,
        fields.name,
        'timeout',
        'Idempotency execution duration exceeded',
        'TIMEOUT',
      );
    }
    const initialRenewal = cache.renewStarted(
      cacheKey,
      execution.attemptId!,
      Math.min(admissionTime + leaseDurationMs, execution.absoluteDeadline!),
      admissionTime,
    );
    let initialRenewalResult: Awaited<ReturnType<typeof awaitBeforeExecution<boolean>>>;
    try {
      initialRenewalResult = await awaitBeforeExecution(
        () => initialRenewal,
        fields,
        fields.name,
        executeOptions,
      );
    } catch {
      return createUnknownOutcomeResult(fields, cacheKey, fields.name, {
        attemptId: execution.attemptId,
        inputDigest: execution.inputDigest,
      });
    }
    if (initialRenewalResult.outcome === 'interrupted') {
      void cleanLateStartedWrite(cache, cacheKey, execution.attemptId!, initialRenewal);
      return initialRenewalResult.result;
    }
    let leaseOwned = initialRenewalResult.value;
    if (!leaseOwned) {
      return createUnknownOutcomeResult(fields, cacheKey, fields.name, {
        attemptId: execution.attemptId,
        inputDigest: execution.inputDigest,
      });
    }
    let result: ToolExecutionResult;
    let pendingRenewal = Promise.resolve();
    let renewalTimer: (() => void) | undefined;
    let renewalStopped = false;
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
              if (renewalTime >= execution.absoluteDeadline!) {
                stopRenewal();
                return;
              }
              leaseOwned =
                leaseOwned &&
                (await cache.renewStarted(
                  cacheKey,
                  execution.attemptId!,
                  Math.min(renewalTime + leaseDurationMs, execution.absoluteDeadline!),
                  renewalTime,
                ));
            })
            .catch(() => {
              leaseOwned = false;
            })
            .finally(scheduleRenewal);
        },
        Math.max(1, Math.floor(leaseDurationMs / 2)),
        runtime,
      );
    };
    scheduleRenewal();
    const cancelDeadlineTimer = scheduleBoundedTimeout(
      stopRenewal,
      Math.max(0, execution.absoluteDeadline! - execution.startedAt),
      runtime,
    );
    try {
      result = await originalExecute(call, executeOptions);
    } catch (error) {
      if (shouldClearStartedStateForThrownError(error)) {
        await cache.deleteStarted(cacheKey, execution.attemptId!);
      }
      throw error;
    } finally {
      stopRenewal();
      cancelDeadlineTimer();
      const renewalWait = await awaitBeforeExecution(
        () => pendingRenewal,
        fields,
        fields.name,
        executeOptions,
      );
      if (renewalWait.outcome === 'interrupted') leaseOwned = false;
    }

    if (!leaseOwned) {
      return createUnknownOutcomeResult(fields, cacheKey, result.toolName, {
        attemptId: execution.attemptId,
        inputDigest: execution.inputDigest,
      });
    }

    // Only cache successful results
    if (result.outcome === 'success' && !result.error && leaseOwned) {
      const entry: CachedToolResult = {
        result: result.result,
        toolName: result.toolName,
        executedAt: now(),
        ttl: defaultTTL,
        policyRevision,
        input: serializedOriginalInput,
      };
      const completion = await awaitBeforeExecution(
        () => cache.completeStarted(cacheKey, execution.attemptId!, entry, defaultTTL, now()),
        fields,
        result.toolName,
        executeOptions,
      );
      const completed = completion.outcome === 'completed' && completion.value;
      if (!completed) {
        return createUnknownOutcomeResult(fields, cacheKey, result.toolName, {
          attemptId: execution.attemptId,
          inputDigest: execution.inputDigest,
        });
      }
      result.idempotency = {
        key: cacheKey,
        outcome: 'fresh',
      };
    } else if (leaseOwned && shouldClearStartedState(result)) {
      await cache.deleteStarted(cacheKey, execution.attemptId!);
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
            const controls = executeOptions as ToolboxExecuteOptionsWithIdempotencyKey | undefined;
            if (controls?.mode === 'sequential') {
              const results: ToolExecutionResult[] = [];
              for (const call of input) {
                results.push(await executeWithCache(call, originalExecute, executeOptions));
              }
              return results;
            }
            const concurrency = normalizeConcurrency(controls?.concurrency);
            if (concurrency !== undefined && concurrency > 0 && concurrency < input.length) {
              const results = new Array<ToolExecutionResult>(input.length);
              let nextIndex = 0;
              await Promise.all(
                Array.from({ length: concurrency }, async () => {
                  while (nextIndex < input.length) {
                    const index = nextIndex++;
                    results[index] = await executeWithCache(
                      input[index]!,
                      originalExecute,
                      executeOptions,
                    );
                  }
                }),
              );
              return results;
            }
            return Promise.all(
              input.map((call) => executeWithCache(call, originalExecute, executeOptions)),
            );
          }

          return executeWithCache(input, originalExecute, executeOptions);
        };
      }
      if (prop === 'resumeApproval') {
        // Keep approval resumption bound to this proxy so the toolbox's
        // internal execute call is intercepted by the idempotency wrapper,
        // including when callers destructure the method as a callback.
        return target.resumeApproval.bind(receiver);
      }
      return Reflect.get(target, prop, receiver as object) as unknown;
    },
  });
}

function serializeOriginalInput(input: unknown): string {
  return stableStringifyJson(
    JSON.parse(JSON.stringify(input === undefined ? {} : input)) as JsonValue,
  );
}

function createInputDigest(serializedOriginalInput: string): string {
  return sha256HexSync(serializedOriginalInput);
}

function normalizeIdempotencyError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : 'Unknown error');
}

function formatCancellationReason(reason: unknown): string {
  if (typeof reason === 'string' && reason.length > 0) {
    return reason;
  }
  if (reason instanceof Error && reason.message.length > 0) {
    return reason.message;
  }
  return 'Cancelled';
}

function formatToolRevision(tool: unknown): string {
  const candidate = tool as
    | {
        id?: string;
        identity?: { namespace?: string; name?: string; version?: string };
        configuration?: { identity?: { namespace?: string; name?: string; version?: string } };
      }
    | undefined;
  const identity = candidate?.identity ?? candidate?.configuration?.identity;
  return candidate?.id ?? identity?.version ?? '';
}
