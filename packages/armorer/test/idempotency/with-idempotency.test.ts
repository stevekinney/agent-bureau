import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { StandardSchemaV1 } from 'interoperability';
import { createManualRuntimeServices } from 'lifecycle';
import { z } from 'zod';

import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type {
  CachedToolResult,
  IdempotencyResolutionReceipt,
  LegacyIdempotencyResolutionReceipt,
  ToolResultCache,
} from '../../src/idempotency/types';
import {
  type DirectIdempotencyExecuteOptions,
  withIdempotency,
} from '../../src/idempotency/with-idempotency';
import { policyAuthorizationOnlySymbol } from '../../src/internal/approval-resume';
import type { Tool } from '../../src/is-tool';

const requestContext = {
  runId: 'run-a',
  agentId: 'agent-a',
  authority: {
    tenantId: 'tenant-a',
    principalId: 'principal-a',
    ownerId: 'owner-a',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization:1',
  },
} as const;

/** A minimal hand-rolled Standard Schema V1 validator — no vendor dependency required. */
function greetingSchema(): StandardSchemaV1<unknown, { name: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        const name = (value as { name?: unknown })?.name;
        if (typeof name !== 'string' || !name.trim()) {
          return { issues: [{ message: 'expected { name: non-empty string }' }] };
        }
        return { value: { name: name.trim() } };
      },
    },
  };
}

/** Accepts intentionally non-JSON values so idempotency serialization owns that rejection. */
function acceptsAnySchema(): StandardSchemaV1<unknown, unknown> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        return { value };
      },
    },
  };
}

function createTestStore() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async (prefix: string) => [...map.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
}

function createManualDeadlineTiming(initialNow = 0): {
  clearCount: () => number;
  fireTimeout: () => void;
  firstTimeoutScheduled: Promise<void>;
  scheduledDelays: () => readonly number[];
  setNow: (nextNow: number) => void;
  options: DirectIdempotencyExecuteOptions;
} {
  let now = initialNow;
  let nextTimerHandle = 1;
  const timerHandlers = new Map<number, () => void>();
  const delays: number[] = [];
  const clearedHandles: unknown[] = [];
  let resolveFirstTimeoutScheduled!: () => void;
  const firstTimeoutScheduled = new Promise<void>((resolve) => {
    resolveFirstTimeoutScheduled = resolve;
  });
  type ScheduleTimeoutFunctionKey = `set${'Timeout'}Function`;
  type ClearTimeoutFunctionKey = `clear${'Timeout'}Function`;
  const scheduleTimeoutFunctionKey: ScheduleTimeoutFunctionKey = `set${'Timeout'}Function`;
  const clearTimeoutFunctionKey: ClearTimeoutFunctionKey = `clear${'Timeout'}Function`;

  return {
    clearCount(): number {
      return clearedHandles.length;
    },
    fireTimeout(): void {
      const [handle, timerHandler] = timerHandlers.entries().next().value ?? [];
      if (typeof handle === 'number') {
        timerHandlers.delete(handle);
      }
      if (!timerHandler) {
        throw new Error('Manual timeout was not scheduled');
      }
      timerHandler();
    },
    firstTimeoutScheduled,
    scheduledDelays(): readonly number[] {
      return delays;
    },
    setNow(nextNow): void {
      now = nextNow;
    },
    options: {
      now: () => now,
      [scheduleTimeoutFunctionKey]: (handler, milliseconds) => {
        const handle = nextTimerHandle++;
        timerHandlers.set(handle, handler);
        delays.push(milliseconds);
        resolveFirstTimeoutScheduled();
        return handle;
      },
      [clearTimeoutFunctionKey]: (handle: unknown) => {
        clearedHandles.push(handle);
        if (typeof handle === 'number') {
          timerHandlers.delete(handle);
        }
      },
    } as DirectIdempotencyExecuteOptions,
  };
}

describe('withIdempotency', () => {
  let cache: ToolResultCache;
  let callCount: number;

  beforeEach(() => {
    callCount = 0;
    cache = createToolResultCache({
      store: createTestStore(),
      defaultTTL: 60_000,
    });
  });

  function createTestTool() {
    return createTool({
      name: 'add',
      description: 'Adds two numbers',
      version: '1.0.0',
      input: z.object({ a: z.number(), b: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ a, b }) {
        callCount++;
        return a + b;
      },
    });
  }

  it('executes normally on the first call', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
    });

    const result = await wrapped({ a: 1, b: 2 }, { requestContext });
    expect(result).toBe(3);
    expect(callCount).toBe(1);
  });

  it('rejects streaming before claiming or executing an idempotency key', async () => {
    const wrapped = withIdempotency(createTestTool(), { cache, tenantId: 'tenant-a' });

    await expect(wrapped({ a: 1, b: 2 }, { requestContext, stream: true })).rejects.toThrow(
      'Idempotency does not support streaming executions',
    );
    expect(callCount).toBe(0);
  });

  it('returns cached result on duplicate call', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
    });

    const result1 = await wrapped({ a: 1, b: 2 }, { requestContext });
    const result2 = await wrapped({ a: 1, b: 2 }, { requestContext });

    expect(result1).toBe(3);
    expect(result2).toBe(3);
    expect(callCount).toBe(1); // Only executed once
  });

  it('executes again for different inputs', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    await wrapped({ a: 1, b: 2 }, { requestContext });
    await wrapped({ a: 3, b: 4 }, { requestContext });

    expect(callCount).toBe(2);
  });

  it('preserves tool name and description', () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    expect(wrapped.name).toBe('add');
    expect(wrapped.description).toBe('Adds two numbers');
  });

  it('preserves tool input schema', () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    expect(wrapped.input).toBe(tool.input);
  });

  it('calls onCacheHit when returning a cached result', async () => {
    const tool = createTestTool();
    const onCacheHit = mock((key: string, result: CachedToolResult) => {});
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a', onCacheHit });

    await wrapped({ a: 1, b: 2 }, { requestContext });
    await wrapped({ a: 1, b: 2 }, { requestContext });

    expect(onCacheHit).toHaveBeenCalledTimes(1);
    expect(onCacheHit.mock.calls[0]![1]!.result).toBe(3);
    expect(onCacheHit.mock.calls[0]![1]!.toolName).toBe('add');
  });

  it('re-runs current policy before returning a completed cache hit', async () => {
    const tool = createTool({
      name: 'policy-cached',
      description: 'Policy-protected cached tool',
      version: '1.0.0',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute(context) {
          const currentContext = context.policyContext as
            { requestContext?: typeof requestContext } | undefined;
          return currentContext?.requestContext?.authority.principalId === 'principal-a'
            ? { allow: true }
            : { allow: false, reason: 'principal denied' };
        },
      },
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a' });
    const deniedContext = {
      ...requestContext,
      authority: { ...requestContext.authority, principalId: 'principal-b' },
    };

    await expect(wrapped.execute({ value: 'cached' }, { requestContext })).resolves.toBe('cached');
    await expect(
      wrapped.execute({ value: 'cached' }, { requestContext: deniedContext }),
    ).rejects.toThrow('principal denied');
    expect(callCount).toBe(1);
  });

  it('fails closed for completed cache entries without original input', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a' });
    await wrapped({ a: 1, b: 2 }, { requestContext });
    const key = JSON.stringify(['tenant-a', tool.id, tool.name, fullInputKey({ a: 1, b: 2 })]);
    const cached = await cache.getState(key);
    expect(cached?.status).toBe('completed');
    await cache.set(key, { ...cached!, input: undefined });

    await expect(wrapped({ a: 1, b: 2 }, { requestContext })).rejects.toThrow('original input');
    expect(callCount).toBe(1);
  });

  it('fails closed for completed cache entries with invalid original input', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a' });
    await wrapped({ a: 1, b: 2 }, { requestContext });
    const key = JSON.stringify(['tenant-a', tool.id, tool.name, fullInputKey({ a: 1, b: 2 })]);
    const cached = await cache.getState(key);
    expect(cached?.status).toBe('completed');
    await cache.set(key, { ...cached!, input: '{invalid' });

    await expect(wrapped({ a: 1, b: 2 }, { requestContext })).rejects.toThrow(
      'invalid original input',
    );
    expect(callCount).toBe(1);
  });

  it('reauthorizes completed cache hits against the original input', async () => {
    let allowAll = true;
    const tool = createTool({
      name: 'input-bound-cache',
      description: 'Input-sensitive cached tool',
      version: '1.0.0',
      input: z.object({ value: z.string() }),
      idempotencyKey: () => 'same-operation',
      policy: {
        beforeExecute({ policyContext }) {
          const value = (policyContext as { params?: { value?: string } } | undefined)?.params
            ?.value;
          return allowAll || value === 'safe'
            ? { allow: true }
            : { allow: false, reason: 'unsafe original input' };
        },
      },
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a' });

    await expect(wrapped({ value: 'unsafe' }, { requestContext })).resolves.toBe('unsafe');
    allowAll = false;
    await expect(wrapped({ value: 'safe' }, { requestContext })).rejects.toThrow(
      'unsafe original input',
    );
    expect(callCount).toBe(1);
  });

  it('keeps started state when execution throws after claiming a key', async () => {
    const sideEffects: number[] = [];
    const tool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
      input: z.object({ cents: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ cents }) {
        callCount++;
        sideEffects.push(cents);
        throw new Error('provider timeout after charge');
      },
    });

    const onUnknownOutcome = mock(() => {});
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'charge:1',
      onUnknownOutcome,
    });
    const key = `["tenant-a","charge:1","charge",${JSON.stringify(fullInputKey({ cents: 100 }))}]`;

    await expect(wrapped({ cents: 100 }, { requestContext })).rejects.toThrow(
      'provider timeout after charge',
    );
    expect(callCount).toBe(1);
    expect(sideEffects).toEqual([100]);

    await expect(wrapped({ cents: 100 }, { requestContext })).rejects.toThrow('unknown outcome');
    expect(callCount).toBe(1);
    expect(sideEffects).toEqual([100]);
    expect(onUnknownOutcome).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ status: 'started', toolName: 'charge' }),
    );
  });

  it('replaces a fenced started marker with an authorized resolution receipt', async () => {
    const tool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
      version: '1.0.0',
      input: z.object({ cents: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ cents }) {
        callCount++;
        if (callCount === 1) throw new Error('provider timeout after charge');
        return cents;
      },
    });
    let now = 100;
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'charge:1',
      leaseDurationMs: 10,
      maximumExecutionDurationMs: 100,
      now: () => now,
      verifyResolutionReceipt: async () => true,
    });
    const key = JSON.stringify(['tenant-a', 'charge:1', 'charge', fullInputKey({ cents: 100 })]);

    await expect(wrapped({ cents: 100 }, { requestContext })).rejects.toThrow(
      'provider timeout after charge',
    );
    const started = await cache.getState(key);
    expect(started?.status).toBe('started');
    expect(started?.attemptId).toBeString();
    expect(started?.inputDigest).toBeString();

    now = 110;
    const receipt: IdempotencyResolutionReceipt = {
      version: 1,
      key,
      attemptId: started!.attemptId!,
      inputDigest: started!.inputDigest!,
      tenantId: 'tenant-a',
      toolRevision: 'charge:1',
      decision: 'retry',
      evidence: 'provider confirmed no duplicate charge',
      authorizedAt: now,
      authorizedBy: 'operator-a',
      nonce: 'nonce-a',
      authorization: 'signed-approval',
    };
    const result = await wrapped.execute(
      { cents: 100 },
      { requestContext, resolutionReceipt: receipt },
    );

    expect(result).toBe(100);
    expect(callCount).toBe(2);
    const completed = await cache.getState(key);
    expect(completed?.status).toBe('completed');
  });

  it('migrates direct legacy started markers only with an authorized legacy receipt', async () => {
    const legacyStore = createTestStore();
    const legacyCache = createToolResultCache({ store: legacyStore, defaultTTL: 60_000 });
    const tool = createTool({
      name: 'legacy-direct',
      description: 'Migrates a legacy direct marker',
      version: '1.0.0',
      input: z.object({ value: z.number() }),
      idempotencyKey: () => 'legacy-direct',
      async execute({ value }) {
        callCount += 1;
        return value;
      },
    });
    const key = JSON.stringify(['tenant-a', 'legacy-direct:1', tool.name, 'legacy-direct']);
    await legacyStore.set(
      key,
      JSON.stringify({ status: 'started', toolName: tool.name, startedAt: 1_000, ttl: 60_000 }),
    );
    const wrapped = withIdempotency(tool, {
      cache: legacyCache,
      tenantId: 'tenant-a',
      toolRevision: 'legacy-direct:1',
      now: () => 2_000,
      verifyLegacyResolutionReceipt: async (receipt) => receipt.authorization === 'authorized',
    });
    const receipt: LegacyIdempotencyResolutionReceipt = {
      version: 1,
      key,
      tenantId: 'tenant-a',
      toolRevision: 'legacy-direct:1',
      toolName: tool.name,
      legacyStartedAt: 1_000,
      decision: 'retry',
      evidence: 'provider confirmed no side effect',
      authorizedAt: 2_000,
      authorizedBy: 'operator-a',
      nonce: 'legacy-direct-receipt',
      authorization: 'denied',
    };

    await expect(
      wrapped.execute({ value: 7 }, { requestContext, legacyResolutionReceipt: receipt }),
    ).rejects.toThrow('unknown outcome');
    expect(callCount).toBe(0);

    const result = await wrapped.execute(
      { value: 7 },
      {
        requestContext,
        legacyResolutionReceipt: { ...receipt, authorization: 'authorized' },
      },
    );
    expect(result).toBe(7);
    expect(callCount).toBe(1);
    expect(await legacyCache.getState(key)).toEqual(
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('fails closed when a direct legacy marker replacement loses its compare-and-set race', async () => {
    const tool = createTool({
      name: 'legacy-direct-race',
      description: 'Loses a legacy marker migration race',
      version: '1.0.0',
      input: z.object({}),
      idempotencyKey: () => 'legacy-direct-race',
      async execute() {
        callCount += 1;
        return 'unexpected';
      },
    });
    const key = JSON.stringify([
      'tenant-a',
      'legacy-direct-race:1',
      tool.name,
      'legacy-direct-race',
    ]);
    const started = {
      status: 'started' as const,
      toolName: tool.name,
      startedAt: 1_000,
      ttl: 60_000,
    };
    const racingCache: ToolResultCache = {
      ...cache,
      getState: async () => started,
      replaceLegacyStarted: async () => false,
    };
    const wrapped = withIdempotency(tool, {
      cache: racingCache,
      tenantId: 'tenant-a',
      toolRevision: 'legacy-direct-race:1',
      now: () => 2_000,
      verifyLegacyResolutionReceipt: async () => true,
    });

    await expect(
      wrapped.execute(
        {},
        {
          requestContext,
          legacyResolutionReceipt: {
            version: 1,
            key,
            tenantId: 'tenant-a',
            toolRevision: 'legacy-direct-race:1',
            toolName: tool.name,
            legacyStartedAt: 1_000,
            decision: 'retry',
            evidence: 'provider confirmed no side effect',
            authorizedAt: 2_000,
            authorizedBy: 'operator-a',
            nonce: 'legacy-direct-race-receipt',
            authorization: 'authorized',
          },
        },
      ),
    ).rejects.toThrow('unknown outcome');
    expect(callCount).toBe(0);
  });

  it('renews an active lease and rejects completion after losing the fence', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = createTool({
      name: 'slow-fenced',
      description: 'Slow fenced execution',
      version: '1.0.0',
      input: z.object({ value: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        await blocked;
        return value;
      },
    });
    let renewals = 0;
    const renewingCache: ToolResultCache = {
      ...cache,
      async renewStarted(key, attemptId, leaseExpiresAt, observedAt) {
        renewals++;
        return cache.renewStarted(key, attemptId, leaseExpiresAt, observedAt);
      },
    };
    const wrapped = withIdempotency(tool, {
      cache: renewingCache,
      tenantId: 'tenant-a',
      leaseDurationMs: 10,
      maximumExecutionDurationMs: 100,
    });
    const timing = createManualDeadlineTiming();
    const execution = wrapped.execute({ value: 7 }, { requestContext, ...timing.options });
    await timing.firstTimeoutScheduled;
    expect(timing.scheduledDelays()).toEqual([5, 100]);
    timing.setNow(5);
    timing.fireTimeout();
    await Promise.resolve();
    await Promise.resolve();
    expect(renewals).toBeGreaterThan(0);
    release();
    await expect(execution).resolves.toBe(7);

    let lostFenceCallbackRuns = 0;
    const lostFenceCache: ToolResultCache = {
      ...cache,
      async renewStarted() {
        return false;
      },
    };
    const lostFenceTool = createTool({
      name: 'lost-fence',
      description: 'Loses its fence',
      version: '1.0.0',
      input: z.object({ value: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        lostFenceCallbackRuns += 1;
        return value;
      },
    });
    const lostFence = withIdempotency(lostFenceTool, {
      cache: lostFenceCache,
      tenantId: 'tenant-a',
      leaseDurationMs: 10,
      maximumExecutionDurationMs: 100,
    });
    const lostExecution = lostFence.execute({ value: 8 }, { requestContext });
    await expect(lostExecution).rejects.toThrow('lost its execution fence');
    expect(lostFenceCallbackRuns).toBe(0);
  });

  it('stops renewing at the absolute deadline and rejects renewal failures', async () => {
    const createSlowTool = (name: string) =>
      createTool({
        name,
        description: 'Slow direct idempotency execution',
        version: '1.0.0',
        input: z.object({ value: z.number() }),
        idempotencyKey: (input: unknown) => fullInputKey(input),
        async execute({ value }) {
          await new Promise((resolve) => setTimeout(resolve, 12));
          return value;
        },
      });

    let clockReads = 0;
    const deadlineTool = withIdempotency(createSlowTool('deadline-fence'), {
      cache,
      tenantId: 'tenant-a',
      leaseDurationMs: 4,
      maximumExecutionDurationMs: 5,
      now: () => [100, 100, 105][clockReads++] ?? 105,
    });
    const deadlineExecution = deadlineTool.execute({ value: 9 }, { requestContext });
    await expect(deadlineExecution).rejects.toThrow('lost its execution fence');

    let renewalCalls = 0;
    const rejectingRenewalCache: ToolResultCache = {
      ...cache,
      async renewStarted() {
        renewalCalls += 1;
        if (renewalCalls === 1) return true;
        throw new Error('renewal store unavailable');
      },
    };
    const renewalFailureTool = withIdempotency(createSlowTool('renewal-failure'), {
      cache: rejectingRenewalCache,
      tenantId: 'tenant-a',
      leaseDurationMs: 4,
      maximumExecutionDurationMs: 100,
    });

    await expect(renewalFailureTool.execute({ value: 10 }, { requestContext })).rejects.toThrow(
      'lost its execution fence',
    );
  });

  it('settles cancellation without waiting for an in-flight direct lease renewal', async () => {
    let signalRenewalStarted!: () => void;
    const renewalStarted = new Promise<void>((resolve) => {
      signalRenewalStarted = resolve;
    });
    let releaseRenewal!: () => void;
    const renewalReleased = new Promise<boolean>((resolve) => {
      releaseRenewal = () => resolve(true);
    });
    let renewalCalls = 0;
    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const pendingRenewalCache: ToolResultCache = {
      ...cache,
      async renewStarted() {
        renewalCalls += 1;
        if (renewalCalls === 1) return true;
        signalRenewalStarted();
        return renewalReleased;
      },
    };
    const tool = createTool({
      name: 'pending-direct-renewal',
      description: 'Waits while its lease renewal remains pending',
      version: '1.0.0',
      input: z.object({}),
      idempotencyKey: () => 'pending-direct-renewal',
      async execute() {
        await toolReleased;
        return 'done';
      },
    });
    const controller = new AbortController();
    const execution = withIdempotency(tool, {
      cache: pendingRenewalCache,
      tenantId: 'tenant-a',
      leaseDurationMs: 4,
      maximumExecutionDurationMs: 100,
    }).execute({}, { requestContext, signal: controller.signal });

    await renewalStarted;
    controller.abort('cancel pending renewal');
    releaseTool();
    expect(
      await Promise.race([
        execution.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
      ]),
    ).toBe('settled');
    releaseRenewal();
  });

  it('cleans up direct admission claims that expire or are cancelled during initial renewal', async () => {
    const expiringTool = createTestTool();
    let expirationClockReads = 0;
    const expiring = withIdempotency(expiringTool, {
      cache,
      tenantId: 'tenant-a',
      maximumExecutionDurationMs: 5,
      now: () => [0, 5][expirationClockReads++] ?? 5,
    });
    await expect(expiring.execute({ value: 'expired' }, { requestContext })).rejects.toThrow(
      'exceeded its maximum execution duration',
    );

    let resolveRenewal!: (owned: boolean) => void;
    const renewal = new Promise<boolean>((resolve) => {
      resolveRenewal = resolve;
    });
    let renewalStarted!: () => void;
    const renewalDidStart = new Promise<void>((resolve) => {
      renewalStarted = resolve;
    });
    let deletes = 0;
    const controller = new AbortController();
    const pending = withIdempotency(createTestTool(), {
      cache: {
        ...cache,
        renewStarted: () => {
          renewalStarted();
          return renewal;
        },
        deleteStarted: async () => {
          deletes += 1;
          return true;
        },
      },
      tenantId: 'tenant-a',
    }).execute({ value: 'cancelled' }, { requestContext, signal: controller.signal });
    await renewalDidStart;
    controller.abort('cancel initial renewal');
    await expect(pending).rejects.toThrow('cancel initial renewal');
    resolveRenewal(true);
    await renewal;
    await Promise.resolve();
    expect(deletes).toBe(1);

    const rejected = withIdempotency(createTestTool(), {
      cache: {
        ...cache,
        renewStarted: async () => {
          throw new Error('renewal rejected');
        },
      },
      tenantId: 'tenant-a',
    });
    await expect(rejected.execute({ value: 'rejected' }, { requestContext })).rejects.toThrow(
      'lost its execution fence before admission',
    );
  });

  it('clears a direct idempotency claim when execution throws a pre-execution error', async () => {
    const tool = createTestTool();
    const throwingTool = new Proxy(tool, {
      get(target, property, receiver) {
        if (property === 'executeWith') {
          return async () => {
            throw Object.assign(new Error('current authority denied'), {
              category: 'permission',
            });
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const wrapped = withIdempotency(throwingTool, {
      cache,
      tenantId: 'tenant-a',
    });
    const key = JSON.stringify(['tenant-a', tool.id, 'add', fullInputKey({ a: 1, b: 2 })]);

    await expect(wrapped.execute({ a: 1, b: 2 }, { requestContext })).rejects.toThrow(
      'current authority denied',
    );
    expect(await cache.getState(key)).toBeUndefined();
  });

  it('clears a direct idempotency claim when cancellation wins before the callback starts', async () => {
    let callbackRuns = 0;
    const tool = createTool({
      name: 'cancel-before-callback',
      description: 'Stalls in policy before the callback',
      version: '1.0.0',
      input: z.object({}),
      idempotencyKey: () => 'cancel-before-callback',
      policy: { beforeExecute: () => new Promise(() => {}) },
      async execute() {
        callbackRuns += 1;
        return 'unexpected';
      },
    });
    const controller = new AbortController();
    let deleteAttempts = 0;
    const trackedCache: ToolResultCache = {
      ...cache,
      async deleteStarted(key, attemptId) {
        deleteAttempts += 1;
        return cache.deleteStarted(key, attemptId);
      },
    };
    const wrapped = withIdempotency(tool, { cache: trackedCache, tenantId: 'tenant-a' });
    const key = JSON.stringify([
      'tenant-a',
      tool.id,
      'cancel-before-callback',
      'cancel-before-callback',
    ]);
    const execution = wrapped.execute({}, { requestContext, signal: controller.signal });

    while ((await cache.getState(key)) === undefined) await Promise.resolve();
    controller.abort('cancel before callback');
    await expect(execution).rejects.toThrow('cancel before callback');
    expect(callbackRuns).toBe(0);
    expect(deleteAttempts).toBe(1);
    expect(await cache.getState(key)).toBeUndefined();
  });

  it('bounds a stalled direct completion write by request cancellation', async () => {
    let completionStarted!: () => void;
    const completionPending = new Promise<void>((resolve) => {
      completionStarted = resolve;
    });
    const stalledCompletionCache: ToolResultCache = {
      ...cache,
      completeStarted: async () => {
        completionStarted();
        return new Promise(() => undefined);
      },
    };
    const controller = new AbortController();
    const execution = withIdempotency(createTestTool(), {
      cache: stalledCompletionCache,
      tenantId: 'tenant-a',
    }).execute({ a: 1, b: 2 }, { requestContext, signal: controller.signal });

    await completionPending;
    controller.abort('cancel stalled completion');
    await expect(execution).rejects.toThrow('lost its execution fence before completion');
    expect(callCount).toBe(1);
  });

  it('rejects invalid direct idempotency lease durations', () => {
    const tool = createTestTool();

    expect(() =>
      withIdempotency(tool, {
        cache,
        tenantId: 'tenant-a',
        leaseDurationMs: 0,
      }),
    ).toThrow('Idempotency lease and execution durations must be finite and positive.');
  });

  it('preserves unknown outcome when authorized replacement loses its race', async () => {
    const tool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
      version: '1.0.0',
      input: z.object({ cents: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute() {
        throw new Error('provider timeout after charge');
      },
    });
    let now = 100;
    const onUnknownOutcome = mock(() => {});
    const replacementLosingCache: ToolResultCache = {
      ...cache,
      replaceUnknownStarted: async () => false,
    };
    const wrapped = withIdempotency(tool, {
      cache: replacementLosingCache,
      tenantId: 'tenant-a',
      toolRevision: 'charge:1',
      leaseDurationMs: 10,
      maximumExecutionDurationMs: 100,
      now: () => now,
      onUnknownOutcome,
      verifyResolutionReceipt: async () => true,
    });
    const key = JSON.stringify(['tenant-a', 'charge:1', 'charge', fullInputKey({ cents: 100 })]);

    await expect(wrapped({ cents: 100 }, { requestContext })).rejects.toThrow(
      'provider timeout after charge',
    );
    const started = await cache.getState(key);
    expect(started?.status).toBe('started');
    now = 110;
    const receipt: IdempotencyResolutionReceipt = {
      version: 1,
      key,
      attemptId: started!.attemptId!,
      inputDigest: started!.inputDigest!,
      tenantId: 'tenant-a',
      toolRevision: 'charge:1',
      decision: 'retry',
      evidence: 'provider confirmed no duplicate charge',
      authorizedAt: now,
      authorizedBy: 'operator-a',
      nonce: 'nonce-a',
      authorization: 'signed-approval',
    };

    await expect(
      wrapped.execute({ cents: 100 }, { requestContext, resolutionReceipt: receipt }),
    ).rejects.toThrow('unknown outcome');
    expect(onUnknownOutcome).toHaveBeenCalledWith(key, started);
  });

  it('does not mark invalid inputs as started', async () => {
    const tool = createTool({
      name: 'typed-input',
      description: 'Requires a numeric input',
      input: z.object({ x: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ x }) {
        callCount++;
        return x * 2;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'typed-input:1',
    });
    const key = `["tenant-a","typed-input:1","typed-input",${JSON.stringify(fullInputKey({ x: '5' }))}]`;

    await expect(wrapped({ x: '5' }, { requestContext })).rejects.toThrow();
    expect(await cache.getState!(key)).toBeUndefined();
    expect(callCount).toBe(0);
  });

  it('supports tools with non-Zod input schemas', async () => {
    const tool = Object.assign(
      async function jsonSchemaInput(input: { x: number }) {
        callCount++;
        return input.x * 2;
      },
      {
        description: 'Uses a JSON schema input',
        input: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
        idempotencyKey: (input: unknown) => fullInputKey(input),
        execute(input: { x: number }) {
          return tool(input);
        },
        async executeWith(options: {
          params: { x: number };
          callId?: string;
          [policyAuthorizationOnlySymbol]?: boolean;
        }) {
          const result = options[policyAuthorizationOnlySymbol]
            ? undefined
            : await tool(options.params);
          const callId = options.callId ?? 'json-schema-input-call';
          return {
            callId,
            outcome: 'success' as const,
            content: result,
            toolCallId: callId,
            toolName: 'jsonSchemaInput',
            result,
          };
        },
        configuration: {
          identity: { name: 'jsonSchemaInput' },
        },
      },
    ) as unknown as Tool & { idempotencyKey: (input: unknown) => string };
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'json-schema-input:1',
    });

    await expect(wrapped({ x: 5 }, { requestContext })).resolves.toBe(10);
    await expect(wrapped({ x: 5 }, { requestContext })).resolves.toBe(10);
    expect(callCount).toBe(1);
  });

  it('surfaces an unknown outcome when a key was started without a result', async () => {
    const tool = createTool({
      name: 'flaky',
      description: 'A flaky tool',
      input: z.object({ x: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ x }) {
        callCount++;
        return x * 2;
      },
    });
    const key = `["tenant-a","flaky:1","flaky",${JSON.stringify(fullInputKey({ x: 5 }))}]`;
    await cache.claimStarted(key, {
      status: 'started',
      toolName: 'flaky',
      startedAt: Date.now(),
      ttl: 60_000,
    });

    const onUnknownOutcome = mock(() => {});
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'flaky:1',
      onUnknownOutcome,
    });

    await expect(wrapped({ x: 5 }, { requestContext })).rejects.toThrow('unknown outcome');
    expect(onUnknownOutcome).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ status: 'started', toolName: 'flaky' }),
    );
    expect(callCount).toBe(0);
  });

  it('throws when tool has no idempotencyKey', () => {
    const tool = createTool({
      name: 'no-key',
      version: '1.0.0',
      description: 'Tool without idempotency key',
      input: z.object({ x: z.number() }),
      async execute({ x }) {
        return x;
      },
    });

    expect(() => withIdempotency(tool, { cache, tenantId: 'tenant-a' })).toThrow(
      'does not have an idempotencyKey',
    );
  });

  it('requires a tenant and complete tool revision', () => {
    const tool = createTestTool();
    expect(() => withIdempotency(tool, { cache, tenantId: '' })).toThrow(
      'requires tenantId and a versioned tool definition revision',
    );
    expect(() => withIdempotency(tool, { cache, tenantId: 'tenant-a', toolRevision: '' })).toThrow(
      'requires tenantId and a versioned tool definition revision',
    );
  });

  it('rejects an unversioned tool without an explicit durable revision', () => {
    const tool = createTool({
      name: 'unversioned-charge',
      description: 'Charges a card',
      input: z.object({ cents: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ cents }) {
        return cents;
      },
    });

    expect(() => withIdempotency(tool, { cache, tenantId: 'tenant-a' })).toThrow(
      'versioned tool definition revision',
    );
  });

  it('requires matching request authority and dedupes logical retries across request identity', async () => {
    const wrapped = withIdempotency(createTestTool(), { cache, tenantId: 'tenant-a' });

    await expect(wrapped({ a: 1, b: 2 })).rejects.toThrow(
      'requires request-scoped execution authority',
    );
    await expect(wrapped.execute({ a: 1, b: 2 }, {})).rejects.toThrow(
      'requires request-scoped execution authority',
    );
    await expect(
      wrapped.execute(
        { a: 1, b: 2 },
        {
          requestContext: {
            ...requestContext,
            authority: { ...requestContext.authority, tenantId: 'tenant-b' },
          },
        },
      ),
    ).rejects.toThrow('tenantId must match request authority tenantId');

    await expect(wrapped.execute({ a: 1, b: 2 }, { requestContext })).resolves.toBe(3);
    await expect(
      wrapped.execute(
        { a: 1, b: 2 },
        {
          requestContext: {
            ...requestContext,
            runId: 'run-b',
            agentId: 'agent-b',
            authority: {
              ...requestContext.authority,
              principalId: 'principal-b',
              ownerId: 'owner-b',
              capabilities: ['payments:charge', 'tools:execute'],
              authorizationRevision: 'authorization:2',
            },
          },
        },
      ),
    ).resolves.toBe(3);
    expect(callCount).toBe(1);

    await expect(
      wrapped.execute(
        { a: 1, b: 2 },
        {
          requestContext: {
            ...requestContext,
            authority: { ...requestContext.authority, tenantId: 'tenant-b' },
          },
        },
      ),
    ).rejects.toThrow('tenantId must match request authority tenantId');
    expect(callCount).toBe(1);
  });

  it('keeps direct cached results tenant-isolated when request identity fields change', async () => {
    const tenantA = withIdempotency(createTestTool(), { cache, tenantId: 'tenant-a' });
    const tenantB = withIdempotency(createTestTool(), { cache, tenantId: 'tenant-b' });
    const tenantBRequestContext = {
      ...requestContext,
      runId: 'run-b',
      agentId: 'agent-b',
      authority: {
        ...requestContext.authority,
        tenantId: 'tenant-b',
        principalId: 'principal-b',
        ownerId: 'owner-b',
        authorizationRevision: 'authorization:2',
      },
    };

    await expect(tenantA.execute({ a: 1, b: 2 }, { requestContext })).resolves.toBe(3);
    await expect(
      tenantB.execute({ a: 9, b: 9 }, { requestContext: tenantBRequestContext }),
    ).resolves.toBe(18);

    expect(callCount).toBe(2);
  });

  it('uses the injected clock for started and completed cache timestamps', async () => {
    const cacheHits: CachedToolResult[] = [];
    const timestamp = Date.now();
    const wrapped = withIdempotency(createTestTool(), {
      cache,
      tenantId: 'tenant-a',
      now: () => timestamp,
      onCacheHit: (_key, entry) => cacheHits.push(entry),
    });

    await wrapped({ a: 1, b: 2 }, { requestContext });
    await wrapped({ a: 1, b: 2 }, { requestContext });

    expect(cacheHits).toHaveLength(1);
    expect(cacheHits[0]?.executedAt).toBe(timestamp);
  });

  it('uses the cache wall clock for TTL expiration when execution uses another clock', async () => {
    let cacheClock = 1_000;
    const wallClockCache = createToolResultCache({
      store: createTestStore(),
      defaultTTL: 100,
      now: () => cacheClock,
    });
    const wrapped = withIdempotency(createTestTool(), {
      cache: wallClockCache,
      tenantId: 'tenant-a',
      ttl: 100,
      now: () => 10_000_000,
    });

    await expect(wrapped({ a: 1, b: 2 }, { requestContext })).resolves.toBe(3);
    await expect(wrapped({ a: 1, b: 2 }, { requestContext })).resolves.toBe(3);
    expect(callCount).toBe(1);

    cacheClock = 1_101;
    await expect(wrapped({ a: 1, b: 2 }, { requestContext })).resolves.toBe(3);
    expect(callCount).toBe(2);
  });

  it('clears claims when policy stops execution before the callback runs', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'approval-gated',
      description: 'Requires approval before execution',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute: () => ({
          status: 'needs_approval' as const,
          reason: 'Operator approval required',
          action: { message: 'Approve execution' },
        }),
      },
      async execute({ value }) {
        executions += 1;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'approval-gated:1',
    });

    const first = wrapped.execute({ value: 'one' }, { requestContext });
    const second = wrapped.execute({ value: 'one' }, { requestContext });

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(outcomes.map((outcome) => outcome.status)).toContain('rejected');
    expect(executions).toBe(0);
  });

  it('clears callable claims when policy stops execution before the callback runs', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'callable-approval-gated',
      description: 'Requires approval before callable execution',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute: () => ({
          status: 'needs_approval' as const,
          reason: 'Callable approval required',
          action: { message: 'Approve callable execution' },
        }),
      },
      async execute({ value }) {
        executions += 1;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'callable-approval-gated:1',
    });
    const input = { value: 'one' };
    const key = JSON.stringify([
      'tenant-a',
      'callable-approval-gated:1',
      'callable-approval-gated',
      fullInputKey(input),
    ]);

    await expect(wrapped(input, { requestContext })).rejects.toThrow('Callable approval required');
    expect(await cache.getState(key)).toBeUndefined();
    await expect(wrapped(input, { requestContext })).rejects.toThrow('Callable approval required');
    expect(await cache.getState(key)).toBeUndefined();
    expect(executions).toBe(0);
  });

  it('clears claims when policy denies execution before the callback runs', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'policy-denied',
      description: 'Is denied before execution',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute: () => ({ allow: false, reason: 'Execution denied' }),
      },
      async execute({ value }) {
        executions += 1;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'policy-denied:1',
    });

    await expect(wrapped.execute({ value: 'one' }, { requestContext })).rejects.toThrow(
      'Execution denied',
    );
    await expect(wrapped.execute({ value: 'one' }, { requestContext })).rejects.toThrow(
      'Execution denied',
    );
    expect(executions).toBe(0);
  });

  it('clears callable claims when policy denies execution before the callback runs', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'callable-policy-denied',
      description: 'Callable path is denied before execution',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute: () => ({ allow: false, reason: 'Callable execution denied' }),
      },
      async execute({ value }) {
        executions += 1;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'callable-policy-denied:1',
    });
    const input = { value: 'one' };
    const key = JSON.stringify([
      'tenant-a',
      'callable-policy-denied:1',
      'callable-policy-denied',
      fullInputKey(input),
    ]);

    await expect(wrapped(input, { requestContext })).rejects.toThrow('Callable execution denied');
    expect(await cache.getState(key)).toBeUndefined();
    await expect(wrapped(input, { requestContext })).rejects.toThrow('Callable execution denied');
    expect(await cache.getState(key)).toBeUndefined();
    expect(executions).toBe(0);
  });

  it('keeps delimiter-bearing tenant and revision tuples in distinct cache scopes', async () => {
    const first = withIdempotency(createTestTool(), {
      cache,
      tenantId: 'tenant:a',
      toolRevision: 'revision',
    });
    const second = withIdempotency(createTestTool(), {
      cache,
      tenantId: 'tenant',
      toolRevision: 'a:revision',
    });

    await expect(
      first(
        { a: 1, b: 2 },
        {
          requestContext: {
            ...requestContext,
            authority: { ...requestContext.authority, tenantId: 'tenant:a' },
          },
        },
      ),
    ).resolves.toBe(3);
    await expect(
      second(
        { a: 1, b: 2 },
        {
          requestContext: {
            ...requestContext,
            authority: { ...requestContext.authority, tenantId: 'tenant' },
          },
        },
      ),
    ).resolves.toBe(3);

    const firstKey = `["tenant:a","revision","add",${JSON.stringify(fullInputKey({ a: 1, b: 2 }))}]`;
    const secondKey = `["tenant","a:revision","add",${JSON.stringify(fullInputKey({ a: 1, b: 2 }))}]`;
    expect(firstKey).not.toBe(secondKey);
    expect(await cache.getState(firstKey)).toBeDefined();
    expect(await cache.getState(secondKey)).toBeDefined();
  });

  it('honors atomic claim races and rejects a lost completion fence', async () => {
    const tool = createTestTool();
    const completed: CachedToolResult = {
      result: 99,
      toolName: 'add',
      executedAt: Date.now(),
      ttl: 60_000,
      input: JSON.stringify({ a: 1, b: 2 }),
    };
    const completedRace: ToolResultCache = {
      ...cache,
      getState: async () => undefined,
      claimStarted: async () => ({ outcome: 'existing', entry: completed }),
    };
    await expect(
      withIdempotency(tool, { cache: completedRace, tenantId: 'tenant-a' })(
        { a: 1, b: 2 },
        { requestContext },
      ),
    ).resolves.toBe(99);

    const startedRace: ToolResultCache = {
      ...cache,
      getState: async () => undefined,
      claimStarted: async (_key, execution) => ({ outcome: 'existing', entry: execution }),
    };
    await expect(
      withIdempotency(tool, { cache: startedRace, tenantId: 'tenant-a' })(
        { a: 1, b: 2 },
        { requestContext },
      ),
    ).rejects.toThrow('unknown outcome');

    const lostFence: ToolResultCache = {
      ...cache,
      completeStarted: async () => false,
    };
    await expect(
      withIdempotency(tool, { cache: lostFence, tenantId: 'tenant-a' })(
        { a: 3, b: 4 },
        { requestContext },
      ),
    ).rejects.toThrow('lost its execution fence');
  });

  it('reauthorizes completed claim-race cache entries before returning cached data', async () => {
    let executions = 0;
    const onCacheHit = mock((_key: string, _result: CachedToolResult) => {});
    const tool = createTool({
      name: 'claim-race-policy',
      description: 'Policy-protected claim race',
      version: '1.0.0',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute(context) {
          const currentContext = context.policyContext as
            { requestContext?: typeof requestContext } | undefined;
          return currentContext?.requestContext?.authority.principalId === 'principal-a'
            ? { allow: true }
            : { allow: false, reason: 'claim race principal denied' };
        },
      },
      async execute({ value }) {
        executions += 1;
        return value;
      },
    });
    const completed: CachedToolResult = {
      result: 'cached-sensitive-data',
      toolName: 'claim-race-policy',
      executedAt: Date.now(),
      ttl: 60_000,
      input: JSON.stringify({ value: 'cached' }),
    };
    const completedRace: ToolResultCache = {
      ...cache,
      getState: async () => undefined,
      claimStarted: async () => ({ outcome: 'existing', entry: completed }),
    };
    const wrapped = withIdempotency(tool, {
      cache: completedRace,
      tenantId: 'tenant-a',
      onCacheHit,
    });
    const deniedContext = {
      ...requestContext,
      authority: { ...requestContext.authority, principalId: 'principal-b' },
    };

    await expect(
      wrapped.execute({ value: 'cached' }, { requestContext: deniedContext }),
    ).rejects.toThrow('claim race principal denied');
    expect(onCacheHit).not.toHaveBeenCalled();
    expect(executions).toBe(0);
  });

  it('uses custom TTL when provided', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a', ttl: 1000 });

    await wrapped({ a: 1, b: 2 }, { requestContext });

    // The cached entry should have the custom TTL
    // We verify indirectly: result should be returned from cache
    const result = await wrapped({ a: 1, b: 2 }, { requestContext });
    expect(result).toBe(3);
    expect(callCount).toBe(1);
  });

  it('supports execute() for both raw params and ToolCall inputs', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    const directResult = await wrapped.execute({ a: 1, b: 2 }, { requestContext });
    const cachedDirectResult = await wrapped.execute({ a: 1, b: 2 }, { requestContext });
    expect(directResult).toBe(3);
    expect(cachedDirectResult).toBe(3);
    expect(callCount).toBe(1);

    const toolCall = { id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } };
    const executionResult = await wrapped.execute(toolCall);
    expect(executionResult.result).toBe(5);
    expect(executionResult.toolName).toBe('add');
    expect(callCount).toBe(2);
  });

  it('replays undefined direct inputs without converting them to null', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'undefined-input',
      description: 'Accepts no input',
      input: acceptsAnySchema(),
      inputSchema: {},
      idempotencyKey: () => 'undefined-input',
      execute() {
        executions += 1;
        return 'ok';
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'undefined-input:1',
    });

    await expect(wrapped.execute(undefined, { requestContext })).resolves.toBe('ok');
    await expect(wrapped.execute(undefined, { requestContext })).resolves.toBe('ok');

    expect(executions).toBe(1);
    const key = JSON.stringify(['tenant-a', 'undefined-input:1', tool.name, 'undefined-input']);
    expect(await cache.getState(key)).toEqual(
      expect.objectContaining({ input: 'null', inputWasUndefined: true }),
    );
  });

  it('keeps invalid async-schema inputs on the canonical authorized execution path', async () => {
    let policyCalls = 0;
    const tool = createTool({
      name: 'invalid-async-input',
      description: 'Rejects invalid input asynchronously',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async ({ value }, context) => {
        await Promise.resolve();
        if (value === 'invalid') context.addIssue({ code: 'custom', message: 'invalid value' });
      }),
      idempotencyKey: () => 'invalid-async-input',
      policy: {
        beforeExecute({ requestContext: currentRequestContext }) {
          policyCalls += 1;
          expect(currentRequestContext).toEqual(requestContext);
          return { allow: true };
        },
      },
      execute() {
        throw new Error('invalid input must not execute');
      },
    });
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a' });

    await expect(wrapped.execute({ value: 'invalid' }, { requestContext })).rejects.toThrow();
    expect(policyCalls).toBe(0);
  });

  it('passes direct ToolCall-style invocations through the original tool path', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    await expect(
      (wrapped as unknown as (input: unknown) => Promise<unknown>)({
        id: 'call-1',
        name: 'add',
        arguments: { a: 1, b: 2 },
      }),
    ).rejects.toThrow();
    expect(callCount).toBe(0);
  });

  it('preserves the tool configuration', () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    expect(wrapped.configuration).toBeDefined();
    expect(wrapped.configuration.identity.name).toBe('add');
  });

  it('wraps a non-Zod Standard Schema tool without throwing on the schema-match check', async () => {
    // A Standard Schema tool's `input` is `wrapStandardSchema(...)` — a
    // `z.any().transform(async ...)` pipe. `inputMatchesToolSchema` used to
    // call `input.safeParse(params)`, and Zod's SYNC `safeParse` throws for
    // an async transform ("Encountered Promise during synchronous parse")
    // instead of returning `{ success: false }`, so every idempotent call to
    // a Standard Schema tool rejected before `execute()` ever ran.
    const tool = createTool({
      name: 'greet',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute(params: { name: string }) {
        callCount++;
        return `hello, ${params.name}`;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    const result = await wrapped({ name: 'ada' }, { requestContext });
    expect(result).toBe('hello, ada');
    expect(callCount).toBe(1);

    const cached = await wrapped({ name: 'ada' }, { requestContext });
    expect(cached).toBe('hello, ada');
    expect(callCount).toBe(1);
  });

  it('cancels stalled async schema prevalidation before reading the cache', async () => {
    let startPrevalidation!: () => void;
    const prevalidationStarted = new Promise<void>((resolve) => {
      startPrevalidation = resolve;
    });
    let cacheReads = 0;
    let cacheClaims = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        cacheReads++;
        throw new Error('cache read should not run before cancellation');
      },
      claimStarted: async () => {
        cacheClaims++;
        throw new Error('cache claim should not run before cancellation');
      },
    };
    const tool = createTool({
      name: 'stalled-prevalidation-cancel',
      description: 'Stalls during idempotency prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {
        startPrevalidation();
        await new Promise<void>(() => {});
      }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });
    const controller = new AbortController();

    const pending = wrapped.execute(
      { value: 'blocked' },
      { requestContext, signal: controller.signal },
    );
    await prevalidationStarted;
    controller.abort('caller aborted prevalidation');

    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('caller aborted prevalidation');
    expect((thrown as { category?: string; code?: string }).category).toBe('cancelled');
    expect((thrown as { category?: string; code?: string }).code).toBe('CANCELLED');
    expect(cacheReads).toBe(0);
    expect(cacheClaims).toBe(0);
    expect(callCount).toBe(0);
  });

  it('cancels pre-aborted async schema prevalidation before reading the cache', async () => {
    let cacheReads = 0;
    let cacheClaims = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        cacheReads++;
        throw new Error('cache read should not run after pre-abort');
      },
      claimStarted: async () => {
        cacheClaims++;
        throw new Error('cache claim should not run after pre-abort');
      },
    };
    const tool = createTool({
      name: 'preaborted-prevalidation',
      description: 'Checks pre-aborted idempotency prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {
        await new Promise<void>(() => {});
      }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });
    const controller = new AbortController();
    controller.abort(new Error('already aborted prevalidation'));

    let thrown: unknown;
    try {
      await wrapped.execute({ value: 'blocked' }, { requestContext, signal: controller.signal });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('already aborted prevalidation');
    expect((thrown as { category?: string; code?: string }).category).toBe('cancelled');
    expect((thrown as { category?: string; code?: string }).code).toBe('CANCELLED');
    expect(cacheReads).toBe(0);
    expect(cacheClaims).toBe(0);
    expect(callCount).toBe(0);
  });

  it('times out stalled async schema prevalidation before reading the cache', async () => {
    const timing = createManualDeadlineTiming();
    let startPrevalidation!: () => void;
    const prevalidationStarted = new Promise<void>((resolve) => {
      startPrevalidation = resolve;
    });
    let cacheReads = 0;
    let cacheClaims = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        cacheReads++;
        throw new Error('cache read should not run before deadline');
      },
      claimStarted: async () => {
        cacheClaims++;
        throw new Error('cache claim should not run before deadline');
      },
    };
    const tool = createTool({
      name: 'stalled-prevalidation-deadline',
      description: 'Stalls during idempotency deadline prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {
        startPrevalidation();
        await new Promise<void>(() => {});
      }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });

    const pending = wrapped.execute(
      { value: 'blocked' },
      {
        requestContext: { ...requestContext, deadline: 10 },
        ...timing.options,
      },
    );
    await prevalidationStarted;
    timing.setNow(10);
    timing.fireTimeout();

    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Execution deadline exceeded');
    expect((thrown as { category?: string; code?: string }).category).toBe('timeout');
    expect((thrown as { category?: string; code?: string }).code).toBe('TIMEOUT');
    expect(cacheReads).toBe(0);
    expect(cacheClaims).toBe(0);
    expect(callCount).toBe(0);
  });

  it('times out already-expired async schema prevalidation before reading the cache', async () => {
    let cacheReads = 0;
    let cacheClaims = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        cacheReads++;
        throw new Error('cache read should not run after deadline');
      },
      claimStarted: async () => {
        cacheClaims++;
        throw new Error('cache claim should not run after deadline');
      },
    };
    const tool = createTool({
      name: 'expired-prevalidation',
      description: 'Checks expired idempotency prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {
        await new Promise<void>(() => {});
      }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });

    let thrown: unknown;
    try {
      await wrapped.execute(
        { value: 'blocked' },
        {
          requestContext: { ...requestContext, deadline: 10 },
          now: () => 10,
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Execution deadline exceeded');
    expect((thrown as { category?: string; code?: string }).category).toBe('timeout');
    expect((thrown as { category?: string; code?: string }).code).toBe('TIMEOUT');
    expect(cacheReads).toBe(0);
    expect(cacheClaims).toBe(0);
    expect(callCount).toBe(0);
  });

  it('continues after async schema prevalidation passes under a live signal and deadline', async () => {
    const timing = createManualDeadlineTiming();
    const controller = new AbortController();
    const tool = createTool({
      name: 'successful-prevalidation',
      description: 'Completes async idempotency prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {}),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
    });

    await expect(
      wrapped.execute(
        { value: 'allowed' },
        {
          requestContext: { ...requestContext, deadline: 10 },
          signal: controller.signal,
          ...timing.options,
        },
      ),
    ).resolves.toBe('allowed');
    expect(callCount).toBe(1);
    expect(timing.clearCount()).toBeGreaterThan(0);
  });

  it('uses the default prevalidation deadline scheduler when no scheduler is supplied', async () => {
    const controller = new AbortController();
    const tool = createTool({
      name: 'default-scheduled-prevalidation',
      description: 'Completes async idempotency prevalidation with default scheduling',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {}),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
    });

    await expect(
      wrapped.execute(
        { value: 'allowed' },
        {
          requestContext: { ...requestContext, deadline: Date.now() + 60_000 },
          signal: controller.signal,
        },
      ),
    ).resolves.toBe('allowed');
    expect(callCount).toBe(1);
  });

  it('re-arms long async schema prevalidation deadlines without overflowing timer delay', async () => {
    const maximumTimerDelay = 2_147_483_647;
    const timing = createManualDeadlineTiming();
    const controller = new AbortController();
    let startPrevalidation!: () => void;
    const prevalidationStarted = new Promise<void>((resolve) => {
      startPrevalidation = resolve;
    });
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        throw new Error('cache read should not run before long deadline prevalidation settles');
      },
      claimStarted: async () => {
        throw new Error('cache claim should not run before long deadline prevalidation settles');
      },
    };
    const tool = createTool({
      name: 'long-prevalidation-deadline',
      description: 'Stalls during a long idempotency deadline prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {
        startPrevalidation();
        await new Promise<void>(() => {});
      }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });

    const pending = wrapped.execute(
      { value: 'blocked' },
      {
        requestContext: { ...requestContext, deadline: maximumTimerDelay + 1_000 },
        signal: controller.signal,
        ...timing.options,
      },
    );
    const pendingResult = pending.then(
      () => 'resolved',
      () => 'rejected',
    );
    await prevalidationStarted;

    expect(timing.scheduledDelays()).toEqual([maximumTimerDelay]);
    timing.fireTimeout();
    expect(await Promise.race([pendingResult, Promise.resolve('pending')])).toBe('pending');
    expect(timing.scheduledDelays()).toEqual([maximumTimerDelay, maximumTimerDelay]);

    controller.abort('stop long prevalidation');

    await expect(pending).rejects.toThrow('stop long prevalidation');
    expect(callCount).toBe(0);
  });

  it('rejects non-finite async schema prevalidation deadlines before scheduling or cache access', async () => {
    const timing = createManualDeadlineTiming();
    let cacheReads = 0;
    let cacheClaims = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        cacheReads++;
        throw new Error('cache read should not run for a non-finite deadline');
      },
      claimStarted: async () => {
        cacheClaims++;
        throw new Error('cache claim should not run for a non-finite deadline');
      },
    };
    const tool = createTool({
      name: 'non-finite-prevalidation-deadline',
      description: 'Rejects unsupported idempotency prevalidation deadlines',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {}),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });

    await expect(
      wrapped.execute(
        { value: 'blocked' },
        {
          requestContext: { ...requestContext, deadline: Infinity },
          ...timing.options,
        },
      ),
    ).rejects.toThrow('Execution deadline must be finite.');
    expect(timing.scheduledDelays()).toEqual([]);
    expect(cacheReads).toBe(0);
    expect(cacheClaims).toBe(0);
    expect(callCount).toBe(0);
  });

  it('serializes accepted direct inputs before claiming an idempotency key or executing', async () => {
    let cacheClaims = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      claimStarted: async () => {
        cacheClaims++;
        throw new Error('cache claim should not run before input serialization');
      },
    };
    const tool = createTool({
      name: 'json-serializable-input',
      description: 'Requires idempotent inputs to be JSON serializable',
      version: '1.0.0',
      input: acceptsAnySchema(),
      inputSchema: {},
      idempotencyKey: () => 'same-operation',
      async execute(value: unknown) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });
    const circularInput: Record<string, unknown> = { value: 'circular' };
    circularInput['self'] = circularInput;

    await expect(wrapped.execute(1n, { requestContext })).rejects.toThrow(
      'BigInt is not valid JSON at idempotency input',
    );
    await expect(wrapped.execute(function rootFunction() {}, { requestContext })).rejects.toThrow(
      'Function is not valid JSON at idempotency input',
    );
    await expect(wrapped.execute(circularInput, { requestContext })).rejects.toThrow(
      'Circular reference detected at idempotency input.self',
    );
    expect(cacheClaims).toBe(0);
    expect(callCount).toBe(0);
  });

  it('serializes accepted retry inputs before replacing an unknown started marker', async () => {
    let replacements = 0;
    const key = JSON.stringify([
      'tenant-a',
      'serializable-retry:1',
      'serializable-retry',
      'same-operation',
    ]);
    const started = {
      status: 'started',
      toolName: 'serializable-retry',
      startedAt: 0,
      ttl: 60_000,
      attemptId: 'attempt-a',
      leaseExpiresAt: 50,
    } as const;
    const replacementGuardedCache: ToolResultCache = {
      ...cache,
      getState: async () => started,
      replaceUnknownStarted: async () => {
        replacements++;
        throw new Error('started marker replacement should not run before input serialization');
      },
    };
    const tool = createTool({
      name: 'serializable-retry',
      description: 'Requires retry inputs to be JSON serializable before replacement',
      version: '1.0.0',
      input: acceptsAnySchema(),
      inputSchema: {},
      idempotencyKey: () => 'same-operation',
      async execute(value: unknown) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache: replacementGuardedCache,
      tenantId: 'tenant-a',
      toolRevision: 'serializable-retry:1',
      now: () => 100,
      verifyResolutionReceipt: async () => true,
    });
    const receipt: IdempotencyResolutionReceipt = {
      version: 1,
      key,
      attemptId: 'attempt-a',
      inputDigest: 'unused-input-digest',
      tenantId: 'tenant-a',
      toolRevision: 'serializable-retry:1',
      decision: 'retry',
      evidence: 'operator verified no external effect',
      authorizedAt: 100,
      authorizedBy: 'operator-a',
      nonce: 'nonce-a',
      authorization: 'signed-retry',
    };
    const circularInput: Record<string, unknown> = { value: 'retry' };
    circularInput['self'] = circularInput;

    await expect(
      wrapped.execute(circularInput, { requestContext, resolutionReceipt: receipt }),
    ).rejects.toThrow('Circular reference detected at idempotency input.self');
    expect(replacements).toBe(0);
    expect(callCount).toBe(0);
  });

  it('normalizes non-Error async schema prevalidation rejections', async () => {
    const tool = createTool({
      name: 'rejected-prevalidation',
      description: 'Rejects async idempotency prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {
        throw 'schema rejected';
      }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
    });

    await expect(
      wrapped.execute(
        { value: 'blocked' },
        {
          requestContext: { ...requestContext, deadline: 10 },
          ...createManualDeadlineTiming().options,
        },
      ),
    ).rejects.toThrow('schema rejected');
    expect(callCount).toBe(0);
  });

  it('normalizes synchronous schema prevalidation throws before cache access', async () => {
    let cacheReads = 0;
    const guardedCache: ToolResultCache = {
      ...cache,
      getState: async () => {
        cacheReads++;
        return undefined;
      },
    };
    const baseTool = createTool({
      name: 'sync-throwing-prevalidation',
      description: 'Throws synchronously during idempotency prevalidation',
      version: '1.0.0',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute() {
        return 'unreachable';
      },
    });
    const tool = {
      ...baseTool,
      id: baseTool.id,
      identity: baseTool.identity,
      idempotencyKey: (input: unknown) => fullInputKey(input),
      input: {
        safeParseAsync() {
          throw 'synchronous schema failure';
        },
      },
    } as unknown as Tool;
    const wrapped = withIdempotency(tool, {
      cache: guardedCache,
      tenantId: 'tenant-a',
    });

    await expect(wrapped.execute({ value: 'blocked' }, { requestContext })).rejects.toThrow(
      'synchronous schema failure',
    );
    expect(cacheReads).toBe(0);
  });

  it('NEUTER CHECK: a sync `safeParse` on the wrapped schema throws (proves the fix is load-bearing)', () => {
    const tool = createTool({
      name: 'greet-neuter',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      execute: async (params: { name: string }) => `hello, ${params.name}`,
    });
    const input = (tool as unknown as { input: { safeParse: (v: unknown) => unknown } }).input;
    expect(() => input.safeParse({ name: 'ada' })).toThrow(
      'Encountered Promise during synchronous parse',
    );
  });

  describe('AB-92/AB-254: RuntimeServices composition', () => {
    it('drives lease-renewal timing entirely through ManualRuntimeServices.advance, with no real timer', async () => {
      const runtime = createManualRuntimeServices();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tool = createTool({
        name: 'slow-fenced-manual-runtime',
        description: 'Slow fenced execution driven by a manual runtime',
        version: '1.0.0',
        input: z.object({ value: z.number() }),
        idempotencyKey: (input: unknown) => fullInputKey(input),
        async execute({ value }) {
          await blocked;
          return value;
        },
      });
      let renewals = 0;
      const renewingCache: ToolResultCache = {
        ...cache,
        async renewStarted(key, attemptId, leaseExpiresAt, observedAt) {
          renewals++;
          return cache.renewStarted(key, attemptId, leaseExpiresAt, observedAt);
        },
      };
      const wrapped = withIdempotency(tool, {
        cache: renewingCache,
        tenantId: 'tenant-a',
        leaseDurationMs: 10,
        maximumExecutionDurationMs: 100,
        runtime,
      });

      const execution = wrapped.execute({ value: 7 }, { requestContext });

      // The renewal timer is armed at half the lease duration (5ms) — wait
      // for it to appear on the manual runtime's own bookkeeping rather than
      // a real timer.
      while (runtime.pendingTimers().length === 0) {
        await Promise.resolve();
      }
      const renewalsBeforeAdvance = renewals;
      await runtime.advance(5);
      expect(renewals).toBeGreaterThan(renewalsBeforeAdvance);

      release();
      await expect(execution).resolves.toBe(7);
    });
  });
});
