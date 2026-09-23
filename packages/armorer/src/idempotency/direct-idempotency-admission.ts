import type { RuntimeServices } from '@lostgradient/lifecycle';

import type { Tool } from '../is-tool';
import { claimCacheStarted, getCacheEntry } from './cache-operations';
import {
  hasLegacyReceiptFields,
  hasReceiptFields,
  hasRetryAuthorization,
} from './direct-idempotency-receipts';
import {
  createPolicyAuthorizationOnlyOptions,
  raceIdempotencyAwait,
  type DirectExecuteOptions,
} from './direct-idempotency-support';
import type {
  CachedToolResult,
  IdempotencyResolutionReceipt,
  LegacyIdempotencyResolutionReceipt,
  StartedToolExecution,
  ToolResultCache,
} from './types';

export type DirectAdmissionContext = {
  cache: ToolResultCache;
  completeToolRevision: string;
  executeOptions?: DirectExecuteOptions | undefined;
  inputDigest: string;
  key: string;
  leaseDurationMs: number;
  maximumExecutionDurationMs: number;
  now: () => number;
  onCacheHit?: ((key: string, result: CachedToolResult) => void) | undefined;
  onUnknownOutcome?: ((key: string, execution: StartedToolExecution) => void) | undefined;
  runtime: RuntimeServices;
  tenantId: string;
  tool: Tool;
  ttl: number;
  verifyLegacyResolutionReceipt?:
    ((receipt: LegacyIdempotencyResolutionReceipt) => boolean | Promise<boolean>) | undefined;
  verifyResolutionReceipt?:
    ((receipt: IdempotencyResolutionReceipt) => boolean | Promise<boolean>) | undefined;
};

export type DirectAdmission =
  { kind: 'execute'; startedExecution: StartedToolExecution } | { kind: 'cached'; result: unknown };

export async function admitDirectExecution(
  context: DirectAdmissionContext,
): Promise<DirectAdmission> {
  const cached = await raceIdempotencyAwait(
    () => getCacheEntry(context.cache, context.key),
    context.runtime,
    context.executeOptions,
  );
  if (cached && cached.status !== 'started') {
    return {
      kind: 'cached',
      result: await returnAuthorizedCachedResult(cached, context),
    };
  }
  let startedExecution: StartedToolExecution;
  if (cached?.status === 'started') {
    startedExecution = await replaceStartedExecution(cached, context);
  } else {
    const startedAt = context.now();
    startedExecution = createStartedExecution(startedAt, context);
    const started = await claimCacheStarted(context.cache, context.key, startedExecution);
    if (started.outcome === 'existing') {
      if (started.entry.status === 'started') {
        context.onUnknownOutcome?.(context.key, started.entry);
        throw unknownOutcome(context.key);
      }
      return {
        kind: 'cached',
        result: await returnAuthorizedCachedResult(started.entry, context),
      };
    }
  }
  return { kind: 'execute', startedExecution };
}

export async function returnAuthorizedCachedResult(
  cached: CachedToolResult,
  context: DirectAdmissionContext,
): Promise<unknown> {
  const originalParams = parseCachedInput(cached);
  await authorizeCachedInput(originalParams, context);
  context.onCacheHit?.(context.key, cached);
  return cached.result;
}

function parseCachedInput(cached: CachedToolResult): unknown {
  if (cached.input === undefined) {
    throw new Error('Cached result lacks its original input and cannot be reauthorized.');
  }
  try {
    return cached.inputWasUndefined ? undefined : JSON.parse(cached.input);
  } catch {
    throw new Error('Cached result has invalid original input and cannot be reauthorized.');
  }
}

async function authorizeCachedInput(
  originalParams: unknown,
  context: DirectAdmissionContext,
): Promise<void> {
  if (typeof context.tool.executeWith !== 'function') return;
  const authorizationOptions = createPolicyAuthorizationOnlyOptions(context.executeOptions);
  const authorizationResult = await context.tool.executeWith({
    params: originalParams,
    ...authorizationOptions,
  });
  if (authorizationResult.outcome === 'success' && !authorizationResult.error) return;
  throw new Error(
    authorizationResult.error?.message ??
      authorizationResult.pendingApproval?.reason ??
      'Tool execution failed.',
  );
}

function createStartedExecution(
  startedAt: number,
  context: DirectAdmissionContext,
): StartedToolExecution {
  return {
    status: 'started',
    toolName: context.tool.name,
    startedAt,
    ttl: context.ttl,
    attemptId: context.runtime.identifiers.next('attempt'),
    leaseExpiresAt: Math.min(
      startedAt + context.leaseDurationMs,
      startedAt + context.maximumExecutionDurationMs,
    ),
    absoluteDeadline: startedAt + context.maximumExecutionDurationMs,
    inputDigest: context.inputDigest,
  };
}

async function replaceStartedExecution(
  cached: StartedToolExecution,
  context: DirectAdmissionContext,
): Promise<StartedToolExecution> {
  const replacementTime = context.now();
  if (cached.attemptId === undefined) return replaceLegacyStarted(cached, replacementTime, context);
  return replaceFencedStarted(cached, replacementTime, context);
}

async function replaceLegacyStarted(
  cached: StartedToolExecution,
  replacementTime: number,
  context: DirectAdmissionContext,
): Promise<StartedToolExecution> {
  const valid = await validLegacyReceipt(
    context.executeOptions?.legacyResolutionReceipt,
    cached,
    context,
  );
  if (!valid || (cached.leaseExpiresAt !== undefined && replacementTime < cached.leaseExpiresAt))
    return rejectUnknown(cached, context);
  const replacement = createStartedExecution(replacementTime, context);
  const replaced = await context.cache.replaceLegacyStarted(
    context.key,
    { toolName: cached.toolName, startedAt: cached.startedAt },
    replacement,
    replacementTime,
  );
  if (!replaced) return rejectUnknown(cached, context);
  return replacement;
}

async function replaceFencedStarted(
  cached: StartedToolExecution,
  replacementTime: number,
  context: DirectAdmissionContext,
): Promise<StartedToolExecution> {
  if (cached.attemptId === undefined) return rejectUnknown(cached, context);
  const attemptId = cached.attemptId;
  const receipt = context.executeOptions?.resolutionReceipt;
  const valid = await validReceipt(receipt, cached, context);
  if (!valid || (cached.leaseExpiresAt !== undefined && replacementTime < cached.leaseExpiresAt)) {
    return rejectUnknown(cached, context);
  }
  const replacement = createStartedExecution(replacementTime, context);
  const replaced = await context.cache.replaceUnknownStarted(
    context.key,
    attemptId,
    replacement,
    replacementTime,
  );
  if (!replaced) return rejectUnknown(cached, context);
  return replacement;
}

async function validLegacyReceipt(
  receipt: LegacyIdempotencyResolutionReceipt | undefined,
  cached: StartedToolExecution,
  context: DirectAdmissionContext,
): Promise<boolean> {
  if (
    !hasLegacyReceiptFields(
      receipt,
      cached,
      context.key,
      context.tenantId,
      context.completeToolRevision,
    )
  )
    return false;
  const verify = context.verifyLegacyResolutionReceipt;
  if (!hasRetryAuthorization(receipt) || !verify) return false;
  return raceIdempotencyAwait(
    () => Promise.resolve(verify(receipt)),
    context.runtime,
    context.executeOptions,
  );
}

async function validReceipt(
  receipt: IdempotencyResolutionReceipt | undefined,
  cached: StartedToolExecution,
  context: DirectAdmissionContext,
): Promise<boolean> {
  if (
    !hasReceiptFields(
      receipt,
      cached,
      context.inputDigest,
      context.key,
      context.tenantId,
      context.completeToolRevision,
    )
  )
    return false;
  const verify = context.verifyResolutionReceipt;
  if (!hasRetryAuthorization(receipt) || !verify) return false;
  return raceIdempotencyAwait(
    () => Promise.resolve(verify(receipt)),
    context.runtime,
    context.executeOptions,
  );
}

function rejectUnknown(cached: StartedToolExecution, context: DirectAdmissionContext): never {
  context.onUnknownOutcome?.(context.key, cached);
  throw unknownOutcome(context.key);
}

function unknownOutcome(key: string): Error {
  return new Error(`Idempotency key "${key}" has an unknown outcome.`);
}
