import { stableStringifyJson } from '../core/serialization/json';
import type { AnyToolbox } from '../create-toolbox';
import type { ToolRequestContext } from '../execution-context';
import type { ToolCallInput, ToolExecutionResult } from '../types';
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
};

type ToolboxExecuteOptionsWithIdempotencyKey = {
  idempotencyKey?: string | ((call: ToolCallInput) => string | undefined);
  resolutionReceipt?: IdempotencyResolutionReceipt;
  legacyResolutionReceipt?: LegacyIdempotencyResolutionReceipt;
  requestContext?: ToolRequestContext;
  mode?: 'parallel' | 'sequential';
  concurrency?: number;
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
    now = Date.now,
    createAttemptId = () => crypto.randomUUID(),
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
    options: { attemptId?: string; legacyStartedAt?: number } = {},
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

  function createPolicyAuthorizationRequiredResult(
    fields: { id: string },
    cacheKey: string,
    cached: CachedToolResult,
  ): ToolExecutionResult {
    return {
      callId: fields.id,
      outcome: 'action_required',
      content: 'Cached tool result was recorded under a different policy revision.',
      toolCallId: fields.id,
      toolName: cached.toolName,
      result: undefined,
      idempotency: {
        key: cacheKey,
        outcome: 'authorization-required',
      },
      action: {
        type: 'approval',
        message:
          'This idempotency key has a completed result recorded under a different policy revision. Re-authorize cached-result access before returning it.',
      },
    };
  }

  function createCompletedCacheHitResult(
    fields: { id: string },
    cacheKey: string,
    cached: CachedToolResult,
  ): ToolExecutionResult {
    if (cached.policyRevision !== policyRevision) {
      return createPolicyAuthorizationRequiredResult(fields, cacheKey, cached);
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

  function createStartedExecution(toolName: string, startedAt: number): StartedToolExecution {
    return {
      status: 'started',
      toolName,
      startedAt,
      ttl: defaultTTL,
      attemptId: createAttemptId(),
      leaseExpiresAt: Math.min(startedAt + leaseDurationMs, startedAt + maximumExecutionDurationMs),
      absoluteDeadline: startedAt + maximumExecutionDurationMs,
    };
  }

  async function createUnknownOutcomeAfterReplacementRace(
    fields: { id: string },
    cacheKey: string,
    fallbackToolName: string,
  ): Promise<ToolExecutionResult> {
    const current = await cache.getState(cacheKey);
    if (current?.status === 'completed') {
      return createCompletedCacheHitResult(fields, cacheKey, current);
    }
    const currentAttemptId = current?.status === 'started' ? current.attemptId : undefined;
    const legacyStartedAt =
      current?.status === 'started' && current.attemptId === undefined
        ? current.startedAt
        : undefined;
    return createUnknownOutcomeResult(fields, cacheKey, current?.toolName ?? fallbackToolName, {
      attemptId: currentAttemptId,
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
    const cached = await getCacheEntry(cache, cacheKey);

    const receipt = executionIdempotencyOptions?.resolutionReceipt;
    const legacyReceipt = executionIdempotencyOptions?.legacyResolutionReceipt;

    if (cached && cached.status !== 'started') {
      return createCompletedCacheHitResult(fields, cacheKey, cached);
    }

    let execution: StartedToolExecution;
    let started;
    if (cached?.status === 'started') {
      if (cached.attemptId === undefined) {
        const validLegacyReceipt =
          legacyReceipt?.version === 1 &&
          legacyReceipt.key === cacheKey &&
          legacyReceipt.tenantId === tenantId &&
          legacyReceipt.toolRevision === revision &&
          legacyReceipt.toolName === cached.toolName &&
          legacyReceipt.legacyStartedAt === cached.startedAt &&
          legacyReceipt.decision === 'retry' &&
          hasReceiptAuthorization(legacyReceipt) &&
          Boolean(
            verifyLegacyResolutionReceipt && (await verifyLegacyResolutionReceipt(legacyReceipt)),
          );
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
        execution = createStartedExecution(fields.name, startedAt);
        const replaced = await cache.replaceLegacyStarted(
          cacheKey,
          { toolName: cached.toolName, startedAt: cached.startedAt },
          execution,
          startedAt,
        );
        if (!replaced) {
          return createUnknownOutcomeAfterReplacementRace(fields, cacheKey, cached.toolName);
        }
        started = { outcome: 'claimed' } as const;
      } else {
        const validReceipt =
          receipt?.version === 1 &&
          receipt.key === cacheKey &&
          receipt.attemptId === cached.attemptId &&
          receipt.tenantId === tenantId &&
          receipt.toolRevision === revision &&
          receipt.decision === 'retry' &&
          hasReceiptAuthorization(receipt) &&
          Boolean(verifyResolutionReceipt && (await verifyResolutionReceipt(receipt)));
        if (!validReceipt) {
          return createUnknownOutcomeResult(fields, cacheKey, cached.toolName, {
            attemptId: cached.attemptId,
          });
        }
        const startedAt = now();
        if (cached.leaseExpiresAt !== undefined && startedAt < cached.leaseExpiresAt) {
          return createUnknownOutcomeResult(fields, cacheKey, cached.toolName, {
            attemptId: cached.attemptId,
          });
        }
        execution = createStartedExecution(fields.name, startedAt);
        const replaced = await cache.replaceUnknownStarted(
          cacheKey,
          cached.attemptId,
          execution,
          startedAt,
        );
        if (!replaced) {
          return createUnknownOutcomeAfterReplacementRace(fields, cacheKey, cached.toolName);
        }
        started = { outcome: 'claimed' } as const;
      }
    } else {
      const startedAt = now();
      execution = createStartedExecution(fields.name, startedAt);
      started = await claimCacheStarted(cache, cacheKey, execution);
    }

    if (started.outcome === 'existing') {
      const entry = started.entry;
      if (entry.status === 'started') {
        return createUnknownOutcomeResult(fields, cacheKey, entry.toolName, {
          attemptId: entry.attemptId,
          legacyStartedAt: entry.attemptId === undefined ? entry.startedAt : undefined,
        });
      }

      return createCompletedCacheHitResult(fields, cacheKey, entry);
    }

    let result: ToolExecutionResult;
    let leaseOwned = true;
    let pendingRenewal = Promise.resolve();
    const renewalInterval = setInterval(
      () => {
        pendingRenewal = pendingRenewal
          .then(async () => {
            const renewalTime = now();
            if (renewalTime >= execution.absoluteDeadline!) return;
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
          });
      },
      Math.max(1, Math.floor(leaseDurationMs / 2)),
    );
    try {
      result = await originalExecute(call, executeOptions);
    } catch (error) {
      if (shouldClearStartedStateForThrownError(error)) {
        await cache.deleteStarted(cacheKey, execution.attemptId!);
      }
      throw error;
    } finally {
      clearInterval(renewalInterval);
      await pendingRenewal;
    }

    // Only cache successful results
    if (result.outcome === 'success' && !result.error && leaseOwned) {
      const entry: CachedToolResult = {
        result: result.result,
        toolName: result.toolName,
        executedAt: now(),
        ttl: defaultTTL,
        policyRevision,
      };
      const completed = await cache.completeStarted(
        cacheKey,
        execution.attemptId!,
        entry,
        defaultTTL,
        now(),
      );
      if (!completed) return result;
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
            const concurrency = controls?.concurrency;
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
      return Reflect.get(target, prop, receiver as object) as unknown;
    },
  });
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
