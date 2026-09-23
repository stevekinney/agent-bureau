import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';

import { stableStringifyJson } from '../core/serialization/json';
import type { Tool, ToolExecuteOptions } from '../is-tool';
import { admitDirectExecution, type DirectAdmissionContext } from './direct-idempotency-admission';
import { executeClaimed, type DirectExecutionContext } from './direct-idempotency-execution';
import {
  createInputDigest,
  inputMatchesToolSchema,
  isToolCall,
  serializeOriginalInput,
  type DirectExecuteOptions,
} from './direct-idempotency-support';
import type { IdempotencyOptions } from './types';

const DEFAULT_TTL = 300_000;
const DEFAULT_LEASE_DURATION = 30_000;

export type DirectIdempotencyExecuteOptions = DirectExecuteOptions;
export type IdempotentTool<T extends Tool> = T & {
  execute: (params: unknown, options?: DirectIdempotencyExecuteOptions) => Promise<unknown>;
};

type DirectConfiguration = {
  cache: IdempotencyOptions['cache'];
  completeToolRevision: string;
  idempotencyKey: (input: unknown) => string;
  leaseDurationMs: number;
  maximumExecutionDurationMs: number;
  now: () => number;
  onCacheHit: IdempotencyOptions['onCacheHit'];
  onUnknownOutcome: IdempotencyOptions['onUnknownOutcome'];
  runtime: RuntimeServices;
  tenantId: string;
  ttl: number;
  verifyLegacyResolutionReceipt: IdempotencyOptions['verifyLegacyResolutionReceipt'];
  verifyResolutionReceipt: IdempotencyOptions['verifyResolutionReceipt'];
};

/** Wraps a tool with request-scoped, fenced idempotent execution. */
export function withIdempotency<T extends Tool>(
  tool: T,
  options: IdempotencyOptions,
): IdempotentTool<T> {
  const configuration = createConfiguration(tool, options);
  async function executeWithCache(
    params: unknown,
    executeOptions?: DirectIdempotencyExecuteOptions,
  ): Promise<unknown> {
    validateExecutionRequest(executeOptions, configuration.tenantId);
    const key = stableStringifyJson([
      configuration.tenantId,
      configuration.completeToolRevision,
      tool.name,
      configuration.idempotencyKey.call(tool, params),
    ]);
    await inputMatchesToolSchema(tool, params, configuration.runtime, executeOptions);
    const originalInput = serializeOriginalInput(params);
    const admissionContext: DirectAdmissionContext = {
      cache: configuration.cache,
      completeToolRevision: configuration.completeToolRevision,
      executeOptions,
      inputDigest: createInputDigest(originalInput),
      key,
      leaseDurationMs: configuration.leaseDurationMs,
      maximumExecutionDurationMs: configuration.maximumExecutionDurationMs,
      now: configuration.now,
      onCacheHit: configuration.onCacheHit,
      onUnknownOutcome: configuration.onUnknownOutcome,
      runtime: configuration.runtime,
      tenantId: configuration.tenantId,
      tool,
      ttl: configuration.ttl,
      verifyLegacyResolutionReceipt: configuration.verifyLegacyResolutionReceipt,
      verifyResolutionReceipt: configuration.verifyResolutionReceipt,
    };
    const admission = await admitDirectExecution(admissionContext);
    if (admission.kind === 'cached') return admission.result;
    const executionContext: DirectExecutionContext = {
      cache: configuration.cache,
      leaseDurationMs: configuration.leaseDurationMs,
      maximumExecutionDurationMs: configuration.maximumExecutionDurationMs,
      now: configuration.now,
      runtime: configuration.runtime,
      tool,
      ttl: configuration.ttl,
    };
    return executeClaimed(
      params,
      executeOptions,
      key,
      originalInput,
      admission.startedExecution,
      executionContext,
    );
  }

  return new Proxy(tool, {
    apply(_target, _thisArg, argArray: unknown[]) {
      const input = argArray[0];
      return isToolCall(input)
        ? tool(input)
        : executeWithCache(input, asDirectOptions(argArray[1]));
    },
    get(target, prop, receiver) {
      if (prop === 'execute')
        return (input: unknown, execOptions?: unknown) =>
          isToolCall(input)
            ? target.execute(input, asToolOptions(execOptions))
            : executeWithCache(input, asDirectOptions(execOptions));
      return Reflect.get(target, prop, receiver);
    },
  });
}

function asDirectOptions(value: unknown): DirectIdempotencyExecuteOptions | undefined {
  return value === undefined ? undefined : isOptionsObject(value) ? value : undefined;
}

function asToolOptions(value: unknown): ToolExecuteOptions | undefined {
  return value === undefined ? undefined : isOptionsObject(value) ? value : undefined;
}

function isOptionsObject(value: unknown): value is DirectIdempotencyExecuteOptions {
  return typeof value === 'object' && value !== null;
}

function createConfiguration(tool: Tool, options: IdempotencyOptions): DirectConfiguration {
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const ttl = options.ttl ?? DEFAULT_TTL;
  const toolRevision = resolveToolRevision(tool, options);
  const { leaseDurationMs, maximumExecutionDurationMs } = resolveDurations(options, ttl);
  const idempotencyKey = readIdempotencyKey(tool);
  return {
    cache: options.cache,
    completeToolRevision: toolRevision,
    idempotencyKey,
    leaseDurationMs,
    maximumExecutionDurationMs,
    now: options.now ?? runtime.clock.now,
    onCacheHit: options.onCacheHit,
    onUnknownOutcome: options.onUnknownOutcome,
    runtime,
    tenantId: options.tenantId,
    ttl,
    verifyLegacyResolutionReceipt: options.verifyLegacyResolutionReceipt,
    verifyResolutionReceipt: options.verifyResolutionReceipt,
  };
}

function resolveToolRevision(tool: Tool, options: IdempotencyOptions): string {
  const revision = options.toolRevision ?? (tool.identity.version ? tool.id : undefined);
  if (!options.tenantId || !revision)
    throw new Error('Idempotency requires tenantId and a versioned tool definition revision.');
  return revision;
}

function resolveDurations(
  options: IdempotencyOptions,
  ttl: number,
): { leaseDurationMs: number; maximumExecutionDurationMs: number } {
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION;
  const maximumExecutionDurationMs =
    options.maximumExecutionDurationMs ?? Math.max(ttl, DEFAULT_TTL);
  if (!validDuration(leaseDurationMs) || !validDuration(maximumExecutionDurationMs))
    throw new Error('Idempotency lease and execution durations must be finite and positive.');
  return { leaseDurationMs, maximumExecutionDurationMs };
}

function validDuration(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function readIdempotencyKey(tool: Tool): (input: unknown) => string {
  const candidate: unknown = 'idempotencyKey' in tool ? tool.idempotencyKey : undefined;
  if (isIdempotencyKey(candidate)) return candidate;
  throw new Error(
    `Tool "${tool.name}" does not have an idempotencyKey. Define an idempotencyKey function in the tool options before wrapping with withIdempotency().`,
  );
}

function isIdempotencyKey(value: unknown): value is (input: unknown) => string {
  return typeof value === 'function';
}

function validateExecutionRequest(
  options: DirectIdempotencyExecuteOptions | undefined,
  tenantId: string,
): void {
  if (!options?.requestContext)
    throw new Error('Idempotency requires request-scoped execution authority.');
  if (options.requestContext.authority.tenantId !== tenantId)
    throw new Error('Idempotency tenantId must match request authority tenantId.');
  if (options.stream) throw new Error('Idempotency does not support streaming executions.');
}
