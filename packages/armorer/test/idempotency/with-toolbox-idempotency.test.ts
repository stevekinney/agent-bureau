import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createProcessLocalApprovalStateStore } from '../../src/approval-binding';
import { createTool } from '../../src/create-tool';
import { createToolbox, type Toolbox } from '../../src/create-toolbox';
import { claimCacheStarted } from '../../src/idempotency/cache-operations';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { CachedToolResult, ToolResultCache } from '../../src/idempotency/types';
import { withToolboxIdempotency as createIdempotentToolbox } from '../../src/idempotency/with-toolbox-idempotency';
import type { SignedPendingToolApproval, ToolCallInput } from '../../src/types';

const createTestRequestContext = (tenantId: string) => ({
  authority: {
    principalId: 'principal-a',
    tenantId,
    ownerId: 'owner-a',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization:1',
  },
  audience: 'tenant' as const,
  agentId: 'agent-a',
  runId: 'run-a',
});

function expectedCacheKey(tenantId: string, revision: string, baseKey: string): string {
  return JSON.stringify([tenantId, revision, baseKey]);
}

const withToolboxIdempotency = (
  ...arguments_: Parameters<typeof createIdempotentToolbox>
): ReturnType<typeof createIdempotentToolbox> => {
  const toolbox = createIdempotentToolbox(...arguments_);
  const requestContext = createTestRequestContext(arguments_[1].tenantId);
  return new Proxy(toolbox, {
    get(target, property, receiver) {
      if (property !== 'execute') return Reflect.get(target, property, receiver);
      return (input: unknown, options?: Record<string, unknown>) =>
        target.execute(input as ToolCallInput, {
          ...options,
          requestContext: options?.['requestContext'] ?? requestContext,
        });
    },
  });
};

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

describe('withToolboxIdempotency', () => {
  let cache: ToolResultCache;
  let addCallCount: number;
  let mulCallCount: number;

  beforeEach(() => {
    addCallCount = 0;
    mulCallCount = 0;
    cache = createToolResultCache({
      store: createTestStore(),
      defaultTTL: 60_000,
    });
  });

  function createToolWithKey() {
    return createTool({
      name: 'add',
      description: 'Adds two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ a, b }) {
        addCallCount++;
        return a + b;
      },
    });
  }

  function createToolWithoutKey() {
    return createTool({
      name: 'multiply',
      description: 'Multiplies two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      async execute({ a, b }) {
        mulCallCount++;
        return a * b;
      },
    });
  }

  it('uses the cache wall clock for TTL expiration when execution uses another clock', async () => {
    let cacheClock = 1_000;
    const wallClockCache = createToolResultCache({
      store: createTestStore(),
      defaultTTL: 100,
      now: () => cacheClock,
    });
    const toolbox = withToolboxIdempotency(createToolbox([createToolWithKey()]), {
      cache: wallClockCache,
      tenantId: 'tenant-a',
      defaultTTL: 100,
      now: () => 10_000_000,
    });
    const call = { name: 'add', arguments: { a: 1, b: 2 } };

    const firstResult = await toolbox.execute(call);
    const secondResult = await toolbox.execute(call);
    expect(firstResult.result).toBe(3);
    expect(secondResult.result).toBe(3);
    expect(addCallCount).toBe(1);

    cacheClock = 1_101;
    const expiredResult = await toolbox.execute(call);
    expect(expiredResult.result).toBe(3);
    expect(addCallCount).toBe(2);
  });

  it('wraps tools that have idempotencyKey by default', async () => {
    const toolbox = createToolbox([createToolWithKey(), createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    // Execute add twice with same args
    const result1 = await idempotentToolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } });
    const result2 = await idempotentToolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } });

    expect(result1.result).toBe(3);
    expect(result2.result).toBe(3);
    expect(result1.idempotency?.outcome).toBe('fresh');
    expect(result2.idempotency?.outcome).toBe('deduped');
    expect(addCallCount).toBe(1); // Cached on second call
    expect(
      await cache.getState!(
        expectedCacheKey('tenant-a', 'default:add', `add:${fullInputKey({ a: 1, b: 2 })}`),
      ),
    ).toEqual(
      expect.objectContaining({
        status: 'completed',
        toolName: 'add',
        result: 3,
        policyRevision: 'policy:1',
      }),
    );
  });

  it('accepts an externally supplied idempotency key', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const result1 = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'temporal-tool-call-id' },
    );
    const result2 = await idempotentToolbox.execute(
      { id: 'call-2', name: 'add', arguments: { a: 9, b: 9 } },
      { idempotencyKey: 'temporal-tool-call-id' },
    );

    expect(result1.result).toBe(3);
    expect(result2.result).toBe(3);
    expect(result2.idempotency).toEqual({
      key: expectedCacheKey('tenant-a', 'default:add', 'add:temporal-tool-call-id'),
      outcome: 'deduped',
    });
    expect(addCallCount).toBe(1);
  });

  it('keeps operation keys stable across logical retries with new request authority', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });
    const firstRequestContext = createTestRequestContext('tenant-a');
    const retryRequestContext = {
      ...firstRequestContext,
      agentId: 'agent-b',
      runId: 'run-b',
      authority: {
        ...firstRequestContext.authority,
        principalId: 'principal-b',
        ownerId: 'owner-b',
        capabilities: ['payments:charge', 'tools:execute'],
        authorizationRevision: 'authorization:2',
      },
    };

    const first = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'logical-operation-id', requestContext: firstRequestContext },
    );
    const retry = await idempotentToolbox.execute(
      { id: 'call-2', name: 'add', arguments: { a: 9, b: 9 } },
      { idempotencyKey: 'logical-operation-id', requestContext: retryRequestContext },
    );

    expect(first.idempotency).toEqual({
      key: expectedCacheKey('tenant-a', 'default:add', 'add:logical-operation-id'),
      outcome: 'fresh',
    });
    expect(retry.idempotency).toEqual({
      key: expectedCacheKey('tenant-a', 'default:add', 'add:logical-operation-id'),
      outcome: 'deduped',
    });
    expect(retry.result).toBe(3);
    expect(addCallCount).toBe(1);
  });

  it('binds completed cache-hit access to the current policy revision without changing the operation key', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const revisionOneToolbox = withToolboxIdempotency(toolbox, {
      cache,
      tenantId: 'tenant-a',
      policyRevision: 'policy:1',
    });
    const revisionTwoToolbox = withToolboxIdempotency(toolbox, {
      cache,
      tenantId: 'tenant-a',
      policyRevision: 'policy:2',
    });
    const expectedKey = expectedCacheKey('tenant-a', 'default:add', 'add:policy-bound-key');

    const first = await revisionOneToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'policy-bound-key' },
    );
    const sameRevisionRetry = await revisionOneToolbox.execute(
      { id: 'call-2', name: 'add', arguments: { a: 9, b: 9 } },
      { idempotencyKey: 'policy-bound-key' },
    );
    const changedRevisionRetry = await revisionTwoToolbox.execute(
      { id: 'call-3', name: 'add', arguments: { a: 9, b: 9 } },
      { idempotencyKey: 'policy-bound-key' },
    );

    expect(first.idempotency).toEqual({ key: expectedKey, outcome: 'fresh' });
    expect(sameRevisionRetry.idempotency).toEqual({ key: expectedKey, outcome: 'deduped' });
    expect(changedRevisionRetry.outcome).toBe('success');
    expect(changedRevisionRetry.result).toBe(3);
    expect(changedRevisionRetry.idempotency).toEqual({
      key: expectedKey,
      outcome: 'deduped',
    });
    expect(addCallCount).toBe(1);
  });

  it('does not return legacy completed cache entries that lack a policy revision', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache,
      tenantId: 'tenant-a',
      policyRevision: 'policy:1',
    });
    const key = expectedCacheKey('tenant-a', 'default:add', 'add:legacy-completed-key');
    const legacyCompleted: CachedToolResult = {
      result: 99,
      toolName: 'add',
      executedAt: Date.now(),
      ttl: 60_000,
    };
    await cache.set(key, legacyCompleted);

    const result = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'legacy-completed-key' },
    );

    expect(result.outcome).toBe('success');
    expect(result.result).toBe(99);
    expect(result.idempotency).toEqual({
      key,
      outcome: 'deduped',
    });
    expect(addCallCount).toBe(0);
  });

  it('reruns current access policy before returning same-revision completed cache hits', async () => {
    let readCount = 0;
    const observedPolicyRequests: string[] = [];
    const authorizedRequestContext = {
      ...createTestRequestContext('tenant-a'),
      authority: {
        ...createTestRequestContext('tenant-a').authority,
        capabilities: ['records:read'],
        authorizationRevision: 'authorization:1',
      },
    };
    const createRequestContext = (
      authorityOverrides: Partial<typeof authorizedRequestContext.authority>,
    ) => ({
      ...authorizedRequestContext,
      authority: {
        ...authorizedRequestContext.authority,
        ...authorityOverrides,
      },
    });
    const sensitiveTool = createTool({
      name: 'read-sensitive-record',
      description: 'Reads a sensitive record',
      input: z.object({ recordId: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute(context) {
          const policyContext = context.policyContext as
            | {
                capabilities?: readonly string[];
                requestContext?: typeof authorizedRequestContext;
              }
            | undefined;
          const requestContext = policyContext?.requestContext;
          const capabilities = policyContext?.capabilities ?? [];
          observedPolicyRequests.push(
            `${requestContext?.authority.principalId}:${capabilities.join(',')}:${
              requestContext?.authority.authorizationRevision
            }`,
          );
          if (requestContext?.authority.principalId !== 'principal-a') {
            return { allow: false, status: 'deny', reason: 'principal denied' };
          }
          if (!capabilities.includes('records:read')) {
            return { allow: false, status: 'deny', reason: 'capability denied' };
          }
          if (requestContext.authority.authorizationRevision !== 'authorization:1') {
            return { allow: false, status: 'deny', reason: 'authorization revision denied' };
          }
          return { allow: true };
        },
      },
      async execute({ recordId }) {
        readCount += 1;
        return { recordId, secret: 'cached-sensitive-data' };
      },
    });
    const toolbox = withToolboxIdempotency(createToolbox([sensitiveTool]), {
      cache,
      tenantId: 'tenant-a',
      policyRevision: 'policy:1',
    });
    const call = {
      id: 'read-call-1',
      name: 'read-sensitive-record',
      arguments: { recordId: 'record-a' },
    };
    const cacheKey = expectedCacheKey(
      'tenant-a',
      'default:read-sensitive-record',
      'read-sensitive-record:sensitive-read-key',
    );
    const first = await toolbox.execute(call, {
      idempotencyKey: 'sensitive-read-key',
      requestContext: authorizedRequestContext,
    });
    const allowedRetry = await toolbox.execute(
      {
        ...call,
        id: 'read-call-allowed-retry',
      },
      {
        idempotencyKey: 'sensitive-read-key',
        requestContext: authorizedRequestContext,
      },
    );

    const deniedRetries = [
      {
        name: 'different principal',
        requestContext: createRequestContext({ principalId: 'principal-b' }),
        reason: 'principal denied',
      },
      {
        name: 'missing capability',
        requestContext: createRequestContext({ capabilities: ['records:list'] }),
        reason: 'capability denied',
      },
      {
        name: 'changed authorization revision',
        requestContext: createRequestContext({ authorizationRevision: 'authorization:2' }),
        reason: 'authorization revision denied',
      },
    ];

    expect(first.outcome).toBe('success');
    expect(first.idempotency).toEqual({
      key: cacheKey,
      outcome: 'fresh',
    });
    expect(allowedRetry.result).toEqual({
      recordId: 'record-a',
      secret: 'cached-sensitive-data',
    });
    expect(allowedRetry.idempotency).toEqual({
      key: cacheKey,
      outcome: 'deduped',
    });

    for (const retry of deniedRetries) {
      const retryResult = await toolbox.execute(
        {
          ...call,
          id: `read-call-${retry.name}`,
        },
        {
          idempotencyKey: 'sensitive-read-key',
          requestContext: retry.requestContext,
        },
      );
      expect(retryResult.outcome).toBe('error');
      expect(retryResult.error?.category).toBe('permission');
      expect(retryResult.error?.message).toBe(retry.reason);
      expect(retryResult.idempotency).toBeUndefined();
    }
    expect(readCount).toBe(1);
    expect(observedPolicyRequests).toEqual([
      'principal-a:records:read:authorization:1',
      'principal-a:records:read:authorization:1',
      'principal-b:records:read:authorization:1',
      'principal-a:records:list:authorization:1',
      'principal-a:records:read:authorization:2',
    ]);
  });

  it('keeps cached results tenant-isolated after operation-key dedupe', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const tenantA = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });
    const tenantB = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-b' });

    const tenantAResult = await tenantA.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'shared-logical-id' },
    );
    const tenantBResult = await tenantB.execute(
      { id: 'call-2', name: 'add', arguments: { a: 9, b: 9 } },
      { idempotencyKey: 'shared-logical-id' },
    );

    expect(tenantAResult.result).toBe(3);
    expect(tenantBResult.result).toBe(18);
    expect(tenantBResult.idempotency).toEqual({
      key: expectedCacheKey('tenant-b', 'default:add', 'add:shared-logical-id'),
      outcome: 'fresh',
    });
    expect(addCallCount).toBe(2);
  });

  it('uses externally supplied idempotency keys for tools without their own key', async () => {
    const toolbox = createToolbox([createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const result1 = await idempotentToolbox.execute(
      { id: 'call-1', name: 'multiply', arguments: { a: 2, b: 3 } },
      { idempotencyKey: 'orchestrator-tool-call-id' },
    );
    const result2 = await idempotentToolbox.execute(
      { id: 'call-2', name: 'multiply', arguments: { a: 9, b: 9 } },
      { idempotencyKey: 'orchestrator-tool-call-id' },
    );

    expect(result1.result).toBe(6);
    expect(result2.result).toBe(6);
    expect(result2.idempotency).toEqual({
      key: expectedCacheKey('tenant-a', 'default:multiply', 'multiply:orchestrator-tool-call-id'),
      outcome: 'deduped',
    });
    expect(mulCallCount).toBe(1);
  });

  it('scopes externally supplied idempotency keys by tool name', async () => {
    const toolbox = createToolbox([createToolWithKey(), createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache,
      tenantId: 'tenant-a',
      requireExplicitKey: false,
    });

    const addResult = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'shared-key' },
    );
    const multiplyResult = await idempotentToolbox.execute(
      { name: 'multiply', arguments: { a: 3, b: 4 } },
      { idempotencyKey: 'shared-key' },
    );

    expect(addResult.result).toBe(3);
    expect(multiplyResult.result).toBe(12);
    expect(addResult.idempotency?.key).toBe(
      expectedCacheKey('tenant-a', 'default:add', 'add:shared-key'),
    );
    expect(multiplyResult.idempotency?.key).toBe(
      expectedCacheKey('tenant-a', 'default:multiply', 'multiply:shared-key'),
    );
    expect(addCallCount).toBe(1);
    expect(mulCallCount).toBe(1);
  });

  it('returns unknown-outcome when a key was started without a recorded result', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });
    const startedAt = Date.now();

    await cache.claimStarted(expectedCacheKey('tenant-a', 'default:add', 'add:started-key'), {
      status: 'started',
      toolName: 'add',
      startedAt,
      ttl: 60_000,
    });

    const result = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'started-key' },
    );

    expect(result.outcome).toBe('action_required');
    expect(result.idempotency).toEqual({
      key: expectedCacheKey('tenant-a', 'default:add', 'add:started-key'),
      outcome: 'unknown-outcome',
      legacyStartedAt: startedAt,
    });
    expect(addCallCount).toBe(0);
  });

  it('does not resolve legacy unfenced started entries without separate legacy authorization', async () => {
    const store = createTestStore();
    const legacyCache = createToolResultCache({ store, defaultTTL: 60_000 });
    const toolbox = createToolbox([createToolWithKey()]);
    const key = expectedCacheKey('tenant-a', 'default:add', 'add:legacy-started');
    await store.set(
      key,
      JSON.stringify({
        status: 'started',
        toolName: 'add',
        startedAt: 1_000,
        ttl: 60_000,
      }),
    );
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache: legacyCache,
      tenantId: 'tenant-a',
      verifyResolutionReceipt: async () => true,
      verifyLegacyResolutionReceipt: async () => false,
    });

    const normalReceiptResult = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'legacy-started',
        resolutionReceipt: {
          version: 1,
          key,
          attemptId: 'invented-attempt',
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          decision: 'retry',
          evidence: 'operator checked provider',
          authorizedAt: 2_000,
          authorizedBy: 'operator-a',
          nonce: 'normal-receipt',
          authorization: 'signed',
        },
      },
    );
    const rejectedLegacyReceiptResult = await idempotentToolbox.execute(
      { id: 'call-2', name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'legacy-started',
        legacyResolutionReceipt: {
          version: 1,
          key,
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          toolName: 'add',
          legacyStartedAt: 1_000,
          decision: 'retry',
          evidence: 'operator checked provider',
          authorizedAt: 2_000,
          authorizedBy: 'operator-a',
          nonce: 'legacy-receipt',
          authorization: 'signed',
        },
      },
    );

    expect(normalReceiptResult.idempotency).toEqual({
      key,
      outcome: 'unknown-outcome',
      legacyStartedAt: 1_000,
    });
    expect(rejectedLegacyReceiptResult.idempotency).toEqual({
      key,
      outcome: 'unknown-outcome',
      legacyStartedAt: 1_000,
    });
    expect(addCallCount).toBe(0);
    expect(await legacyCache.getState(key)).toEqual(
      expect.objectContaining({
        status: 'started',
        toolName: 'add',
        startedAt: 1_000,
      }),
    );
  });

  it('resolves legacy unfenced started entries through an authorized migration receipt', async () => {
    const store = createTestStore();
    const legacyCache = createToolResultCache({ store, defaultTTL: 60_000 });
    const toolbox = createToolbox([createToolWithKey()]);
    const key = expectedCacheKey('tenant-a', 'default:add', 'add:legacy-resolution');
    await store.set(
      key,
      JSON.stringify({
        status: 'started',
        toolName: 'add',
        startedAt: 1_000,
        ttl: 60_000,
      }),
    );
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache: legacyCache,
      tenantId: 'tenant-a',
      now: () => 2_000,
      createAttemptId: () => 'replacement-attempt',
      verifyLegacyResolutionReceipt: async (receipt) => receipt.authorization === 'legacy-signed',
    });

    const result = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'legacy-resolution',
        legacyResolutionReceipt: {
          version: 1,
          key,
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          toolName: 'add',
          legacyStartedAt: 1_000,
          decision: 'retry',
          evidence: 'Operator confirmed the original side effect did not occur.',
          authorizedAt: 2_000,
          authorizedBy: 'operator-a',
          nonce: 'legacy-resolution-receipt',
          authorization: 'legacy-signed',
        },
      },
    );

    expect(result.outcome).toBe('success');
    expect(result.result).toBe(3);
    expect(result.idempotency).toEqual({ key, outcome: 'fresh' });
    expect(addCallCount).toBe(1);
    expect(await legacyCache.getState(key)).toEqual(
      expect.objectContaining({
        status: 'completed',
        toolName: 'add',
        result: 3,
      }),
    );
  });

  it('does not migrate a legacy unfenced entry while its lease is active', async () => {
    const store = createTestStore();
    const legacyCache = createToolResultCache({ store, defaultTTL: 60_000 });
    const toolbox = createToolbox([createToolWithKey()]);
    const key = expectedCacheKey('tenant-a', 'default:add', 'add:leased-legacy-resolution');
    await store.set(
      key,
      JSON.stringify({
        status: 'started',
        toolName: 'add',
        startedAt: 1_000,
        leaseExpiresAt: 3_000,
        ttl: 60_000,
      }),
    );
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache: legacyCache,
      tenantId: 'tenant-a',
      now: () => 2_000,
      verifyLegacyResolutionReceipt: async () => true,
    });

    const result = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'leased-legacy-resolution',
        legacyResolutionReceipt: {
          version: 1,
          key,
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          toolName: 'add',
          legacyStartedAt: 1_000,
          decision: 'retry',
          evidence: 'Operator confirmed the original side effect did not occur.',
          authorizedAt: 2_000,
          authorizedBy: 'operator-a',
          nonce: 'leased-legacy-resolution-receipt',
          authorization: 'legacy-signed',
        },
      },
    );

    expect(result.idempotency).toEqual({
      key,
      outcome: 'unknown-outcome',
      legacyStartedAt: 1_000,
    });
    expect(addCallCount).toBe(0);
  });

  it('returns the current outcome when legacy migration loses its compare-and-set race', async () => {
    const store = createTestStore();
    const legacyCache = createToolResultCache({ store, defaultTTL: 60_000 });
    const key = expectedCacheKey('tenant-a', 'default:add', 'add:legacy-migration-race');
    await store.set(
      key,
      JSON.stringify({ status: 'started', toolName: 'add', startedAt: 1_000, ttl: 60_000 }),
    );
    const racingCache: ToolResultCache = {
      ...legacyCache,
      replaceLegacyStarted: async () => false,
    };
    const idempotentToolbox = withToolboxIdempotency(createToolbox([createToolWithKey()]), {
      cache: racingCache,
      tenantId: 'tenant-a',
      now: () => 2_000,
      verifyLegacyResolutionReceipt: async () => true,
    });

    const result = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'legacy-migration-race',
        legacyResolutionReceipt: {
          version: 1,
          key,
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          toolName: 'add',
          legacyStartedAt: 1_000,
          decision: 'retry',
          evidence: 'Operator confirmed the original side effect did not occur.',
          authorizedAt: 2_000,
          authorizedBy: 'operator-a',
          nonce: 'legacy-migration-race-receipt',
          authorization: 'legacy-signed',
        },
      },
    );

    expect(result.idempotency).toEqual({
      key,
      outcome: 'unknown-outcome',
      legacyStartedAt: 1_000,
    });
    expect(addCallCount).toBe(0);
  });

  it('rejects stale legacy receipts and legacy receipts against fenced started entries', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const staleKey = expectedCacheKey('tenant-a', 'default:add', 'add:stale-legacy-receipt');
    await cache.claimStarted(staleKey, {
      status: 'started',
      toolName: 'add',
      startedAt: 1_000,
      ttl: 60_000,
    });
    const fencedKey = expectedCacheKey('tenant-a', 'default:add', 'add:fenced-started');
    await cache.claimStarted(fencedKey, {
      status: 'started',
      toolName: 'add',
      startedAt: 1_000,
      ttl: 60_000,
      attemptId: 'fenced-attempt',
    });
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache,
      tenantId: 'tenant-a',
      verifyLegacyResolutionReceipt: async () => true,
    });

    const staleResult = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'stale-legacy-receipt',
        legacyResolutionReceipt: {
          version: 1,
          key: staleKey,
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          toolName: 'add',
          legacyStartedAt: 999,
          decision: 'retry',
          evidence: 'operator checked provider',
          authorizedAt: 2_000,
          authorizedBy: 'operator-a',
          nonce: 'stale-legacy-receipt',
          authorization: 'signed',
        },
      },
    );
    const fencedResult = await idempotentToolbox.execute(
      { id: 'call-2', name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'fenced-started',
        legacyResolutionReceipt: {
          version: 1,
          key: fencedKey,
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          toolName: 'add',
          legacyStartedAt: 1_000,
          decision: 'retry',
          evidence: 'operator checked provider',
          authorizedAt: 2_000,
          authorizedBy: 'operator-a',
          nonce: 'fenced-legacy-receipt',
          authorization: 'signed',
        },
      },
    );

    expect(staleResult.idempotency).toEqual({
      key: staleKey,
      outcome: 'unknown-outcome',
      legacyStartedAt: 1_000,
    });
    expect(fencedResult.idempotency).toEqual({
      key: fencedKey,
      outcome: 'unknown-outcome',
      attemptId: 'fenced-attempt',
    });
    expect(addCallCount).toBe(0);
  });

  it('retries an unknown outcome only after explicit approval', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache,
      tenantId: 'tenant-a',
      verifyResolutionReceipt: (receipt) => receipt.authorization === 'authorized-signature',
    });

    await cache.claimStarted(
      expectedCacheKey('tenant-a', 'default:add', 'add:retry-after-review'),
      {
        status: 'started',
        toolName: 'add',
        startedAt: Date.now(),
        ttl: 60_000,
        attemptId: 'original-attempt',
      },
    );

    const pause = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'retry-after-review' },
    );
    expect(pause.idempotency).toEqual({
      key: expectedCacheKey('tenant-a', 'default:add', 'add:retry-after-review'),
      outcome: 'unknown-outcome',
      attemptId: 'original-attempt',
    });
    const receiptAttemptId = pause.idempotency?.attemptId;
    if (!receiptAttemptId) throw new Error('Expected unknown outcome to expose attemptId.');
    const retry = await idempotentToolbox.execute(
      { id: 'call-2', name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'retry-after-review',
        resolutionReceipt: {
          version: 1,
          key: pause.idempotency.key,
          attemptId: receiptAttemptId,
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          decision: 'retry',
          evidence: 'Operator confirmed the original side effect did not occur.',
          authorizedAt: Date.now(),
          authorizedBy: 'operator-1',
          nonce: 'receipt-1',
          authorization: 'authorized-signature',
        },
      },
    );

    expect(pause.outcome).toBe('action_required');
    expect(retry.outcome).toBe('success');
    expect(retry.result).toBe(3);
    expect(retry.idempotency).toEqual({
      key: expectedCacheKey('tenant-a', 'default:add', 'add:retry-after-review'),
      outcome: 'fresh',
    });
    expect(addCallCount).toBe(1);
    expect(
      await cache.getState!(expectedCacheKey('tenant-a', 'default:add', 'add:retry-after-review')),
    ).toEqual(
      expect.objectContaining({
        status: 'completed',
        toolName: 'add',
        result: 3,
      }),
    );
  });

  it('does not keep started state for validation failures', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const result = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: '1', b: 2 } },
      { idempotencyKey: 'invalid-input' },
    );

    expect(result.outcome).toBe('error');
    expect(result.idempotency).toBeUndefined();
    expect(
      await cache.getState!(expectedCacheKey('tenant-a', 'default:add', 'add:invalid-input')),
    ).toBeUndefined();
    expect(addCallCount).toBe(0);
  });

  it('does not keep started state when fail-fast validation throws', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    await expect(
      idempotentToolbox.execute(
        { name: 'add', arguments: { a: '1', b: 2 } },
        { idempotencyKey: 'invalid-input', errorMode: 'failFast' },
      ),
    ).rejects.toMatchObject({ category: 'validation' });

    expect(
      await cache.getState!(expectedCacheKey('tenant-a', 'default:add', 'add:invalid-input')),
    ).toBeUndefined();

    const retry = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: '1', b: 2 } },
      { idempotencyKey: 'invalid-input' },
    );

    expect(retry.outcome).toBe('error');
    expect(retry.idempotency).toBeUndefined();
    expect(
      await cache.getState!(expectedCacheKey('tenant-a', 'default:add', 'add:invalid-input')),
    ).toBeUndefined();
    expect(addCallCount).toBe(0);
  });

  it('does not keep started state for unavailable tools before execution', async () => {
    let available = false;
    const tool = createTool({
      name: 'add',
      description: 'Adds two numbers when available',
      input: z.object({ a: z.number(), b: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      availability: () => available,
      async execute({ a, b }) {
        addCallCount++;
        return a + b;
      },
    });
    const toolbox = createToolbox([tool]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const first = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'unavailable-now' },
    );
    available = true;
    const second = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'unavailable-now' },
    );

    expect(first.outcome).toBe('error');
    expect(first.error?.category).toBe('unavailable');
    expect(first.idempotency).toBeUndefined();
    expect(
      await cache.getState!(expectedCacheKey('tenant-a', 'default:add', 'add:unavailable-now')),
    ).toEqual(
      expect.objectContaining({
        status: 'completed',
        toolName: 'add',
        result: 3,
      }),
    );
    expect(second.outcome).toBe('success');
    expect(second.result).toBe(3);
    expect(second.idempotency).toEqual({
      key: expectedCacheKey('tenant-a', 'default:add', 'add:unavailable-now'),
      outcome: 'fresh',
    });
    expect(addCallCount).toBe(1);
  });

  it('does not keep started state for approval pauses before execution', async () => {
    const toolbox = createToolbox([createToolWithKey()], {
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'approval required',
          };
        },
      },
    });
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const first = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'approval-pause' },
    );
    const second = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'approval-pause' },
    );

    expect(first.outcome).toBe('action_required');
    expect(second.outcome).toBe('action_required');
    expect(first.idempotency).toBeUndefined();
    expect(second.idempotency).toBeUndefined();
    expect(
      await cache.getState!(expectedCacheKey('tenant-a', 'default:add', 'add:approval-pause')),
    ).toBeUndefined();
    expect(addCallCount).toBe(0);
  });

  it('does not keep started state for budget blocks before execution', async () => {
    const toolbox = createToolbox([createToolWithKey()], {
      budget: { maxCalls: 0 },
    });
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const first = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'budget-block' },
    );
    const second = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'budget-block' },
    );

    expect(first.outcome).toBe('error');
    expect(first.error?.category).toBe('conflict');
    expect(first.error?.code).toBe('BUDGET_EXCEEDED');
    expect(second.outcome).toBe('error');
    expect(second.idempotency).toBeUndefined();
    expect(
      await cache.getState!(expectedCacheKey('tenant-a', 'default:add', 'add:budget-block')),
    ).toBeUndefined();
    expect(addCallCount).toBe(0);
  });

  it('does not keep started state when fail-fast budget blocks throw', async () => {
    const toolbox = createToolbox([createToolWithKey()], {
      budget: { maxCalls: 0 },
    });
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    await expect(
      idempotentToolbox.execute(
        { name: 'add', arguments: { a: 1, b: 2 } },
        { idempotencyKey: 'budget-block', errorMode: 'failFast' },
      ),
    ).rejects.toMatchObject({ category: 'conflict', code: 'BUDGET_EXCEEDED' });

    expect(
      await cache.getState!(expectedCacheKey('tenant-a', 'default:add', 'add:budget-block')),
    ).toBeUndefined();

    const retry = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'budget-block' },
    );

    expect(retry.outcome).toBe('error');
    expect(retry.idempotency).toBeUndefined();
    expect(
      await cache.getState!(expectedCacheKey('tenant-a', 'default:add', 'add:budget-block')),
    ).toBeUndefined();
    expect(addCallCount).toBe(0);
  });

  it('routes signed approval resumes through toolbox idempotency', async () => {
    const charges: number[] = [];
    const chargeTool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
      version: '1.0.0',
      input: z.object({ cents: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ cents }) {
        charges.push(cents);
        return { charged: cents };
      },
    });
    const toolbox = createToolbox([chargeTool], {
      approvalSecret: 'approval-idempotency-secret',
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'approval required',
          };
        },
      },
    });
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });
    const requestContext = {
      authority: {
        principalId: 'principal-a',
        tenantId: 'tenant-a',
        ownerId: 'owner-a',
        capabilities: ['payments:charge'],
        authorizationRevision: 'authorization:1',
      },
      audience: 'tenant' as const,
      agentId: 'agent-a',
      runId: 'run-a',
    };
    const paused = await idempotentToolbox.execute(
      { id: 'charge-call', name: 'charge', arguments: { cents: 100 } },
      { idempotencyKey: 'charge-once', requestContext },
    );

    const { resumeApproval } = idempotentToolbox;
    const firstResume = await resumeApproval(paused.pendingApproval! as SignedPendingToolApproval, {
      idempotencyKey: 'charge-once',
      requestContext,
    });

    expect(firstResume.result).toEqual({ charged: 100 });
    expect(firstResume.idempotency).toEqual({
      key: expectedCacheKey(
        'tenant-a',
        'default:charge@1.0.0',
        'charge:charge-once',
        requestContext,
      ),
      outcome: 'fresh',
    });
    await expect(
      idempotentToolbox.resumeApproval(paused.pendingApproval! as SignedPendingToolApproval, {
        idempotencyKey: 'charge-once',
        requestContext,
      }),
    ).rejects.toThrow('already been consumed');
    expect(charges).toEqual([100]);
  });

  it('requires and consumes signed approval before returning cached results guarded by current policy', async () => {
    const reads: string[] = [];
    const secretTool = createTool({
      name: 'read-secret',
      description: 'Reads sensitive data',
      version: '1.0.0',
      input: z.object({ recordId: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ recordId }) {
        reads.push(recordId);
        return { recordId, secret: 'classified' };
      },
    });
    const requestContext = {
      authority: {
        principalId: 'principal-a',
        tenantId: 'tenant-a',
        ownerId: 'owner-a',
        capabilities: ['records:read'],
        authorizationRevision: 'authorization:1',
      },
      audience: 'tenant' as const,
      agentId: 'agent-a',
      runId: 'run-a',
    };
    const call = {
      id: 'read-secret-call',
      name: 'read-secret',
      arguments: { recordId: 'record-1' },
    };
    const idempotencyKey = 'read-secret-once';
    const initialToolbox = withToolboxIdempotency(createToolbox([secretTool]), {
      cache,
      tenantId: 'tenant-a',
    });
    const initialResult = await initialToolbox.execute(call, { idempotencyKey, requestContext });
    expect(initialResult.idempotency?.outcome).toBe('fresh');
    expect(initialResult.result).toEqual({ recordId: 'record-1', secret: 'classified' });
    expect(reads).toEqual(['record-1']);

    const approvalStateStore = createProcessLocalApprovalStateStore();
    const guardedToolbox = createToolbox([secretTool], {
      approvalSecret: 'cached-result-approval-secret',
      approvalStateStore,
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'cached result access requires approval',
          };
        },
      },
    });
    const idempotentGuardedToolbox = withToolboxIdempotency(guardedToolbox, {
      cache,
      tenantId: 'tenant-a',
      policyRevision: 'policy:2',
    });

    const approvalRequired = await idempotentGuardedToolbox.execute(call, {
      idempotencyKey,
      requestContext,
    });
    expect(approvalRequired.outcome).toBe('action_required');
    expect(approvalRequired.pendingApproval?.approvalToken).toEqual(expect.any(String));
    expect(reads).toEqual(['record-1']);

    const approval = approvalRequired.pendingApproval! as SignedPendingToolApproval;
    expect(approval.approvalBinding).toBeDefined();
    expect(await approvalStateStore.state(approval.approvalBinding!)).toBe('issued');

    const resumed = await idempotentGuardedToolbox.resumeApproval(approval, {
      idempotencyKey,
      requestContext,
    });
    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toEqual({ recordId: 'record-1', secret: 'classified' });
    expect(resumed.idempotency).toEqual({
      key: expectedCacheKey(
        'tenant-a',
        'default:read-secret@1.0.0',
        `read-secret:${idempotencyKey}`,
      ),
      outcome: 'deduped',
    });
    expect(reads).toEqual(['record-1']);
    expect(await approvalStateStore.state(approval.approvalBinding!)).toBe('consumed');

    await expect(
      idempotentGuardedToolbox.resumeApproval(approval, { idempotencyKey, requestContext }),
    ).rejects.toThrow('already been consumed');
    expect(reads).toEqual(['record-1']);
  });

  it('does not keep started state for denied results before execution', async () => {
    const tool = createToolWithKey();
    const toolbox = {
      getTool(name: string) {
        return name === 'add' ? tool : undefined;
      },
      async execute(call: ToolCallInput) {
        return {
          callId: call.id ?? '',
          outcome: 'denied',
          content: 'not allowed',
          toolCallId: call.id ?? '',
          toolName: call.name,
          result: undefined,
        };
      },
    } as Toolbox;
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const first = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'policy-denied' },
    );
    const second = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'policy-denied' },
    );

    expect(first.outcome).toBe('denied');
    expect(second.outcome).toBe('denied');
    expect(first.idempotency).toBeUndefined();
    expect(second.idempotency).toBeUndefined();
    expect(
      await cache.getState!(expectedCacheKey('tenant-a', 'default:add', 'add:policy-denied')),
    ).toBeUndefined();
    expect(addCallCount).toBe(0);
  });

  it('keeps started state when execution errors after a side effect', async () => {
    const sideEffects: number[] = [];
    const chargeTool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
      input: z.object({ cents: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ cents }) {
        sideEffects.push(cents);
        throw new Error('provider timeout after charge');
      },
    });
    const toolbox = createToolbox([chargeTool]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const first = await idempotentToolbox.execute(
      { id: 'call-1', name: 'charge', arguments: { cents: 100 } },
      { idempotencyKey: 'charge-once' },
    );
    const second = await idempotentToolbox.execute(
      { id: 'call-2', name: 'charge', arguments: { cents: 100 } },
      { idempotencyKey: 'charge-once' },
    );

    expect(first.outcome).toBe('error');
    expect(first.idempotency).toBeUndefined();
    expect(second.outcome).toBe('action_required');
    expect(second.idempotency).toEqual({
      key: expectedCacheKey('tenant-a', 'default:charge', 'charge:charge-once'),
      outcome: 'unknown-outcome',
      attemptId: expect.any(String),
    });
    expect(sideEffects).toEqual([100]);
    expect(
      await cache.getState!(expectedCacheKey('tenant-a', 'default:charge', 'charge:charge-once')),
    ).toEqual(expect.objectContaining({ status: 'started', toolName: 'charge' }));
  });

  it('keeps started state when execution throws an unknown primitive error', async () => {
    const tool = createToolWithKey();
    const toolbox = {
      getTool(name: string) {
        return name === 'add' ? tool : undefined;
      },
      async execute() {
        throw 'provider timeout after side effect';
      },
    } as Toolbox;
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    await expect(
      idempotentToolbox.execute(
        { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
        { idempotencyKey: 'primitive-error' },
      ),
    ).rejects.toBe('provider timeout after side effect');

    const retry = await idempotentToolbox.execute(
      { id: 'call-2', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'primitive-error' },
    );

    expect(retry.outcome).toBe('action_required');
    expect(retry.idempotency).toEqual({
      key: expectedCacheKey('tenant-a', 'default:add', 'add:primitive-error'),
      outcome: 'unknown-outcome',
      attemptId: expect.any(String),
    });
    expect(
      await cache.getState!(expectedCacheKey('tenant-a', 'default:add', 'add:primitive-error')),
    ).toEqual(expect.objectContaining({ status: 'started', toolName: 'add' }));
  });

  it('keeps started state for error results without an error object', async () => {
    const tool = createToolWithKey();
    const toolbox = {
      getTool(name: string) {
        return name === 'add' ? tool : undefined;
      },
      async execute(call: ToolCallInput) {
        return {
          callId: call.id ?? '',
          outcome: 'error',
          content: 'provider failed after side effect',
          toolCallId: call.id ?? '',
          toolName: call.name,
          result: undefined,
          errorCategory: 'transient',
        };
      },
    } as Toolbox;
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const first = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'error-without-object' },
    );
    const second = await idempotentToolbox.execute(
      { id: 'call-2', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'error-without-object' },
    );

    expect(first.outcome).toBe('error');
    expect(second.outcome).toBe('action_required');
    expect(second.idempotency).toEqual({
      key: expectedCacheKey('tenant-a', 'default:add', 'add:error-without-object'),
      outcome: 'unknown-outcome',
      attemptId: expect.any(String),
    });
    expect(
      await cache.getState!(
        expectedCacheKey('tenant-a', 'default:add', 'add:error-without-object'),
      ),
    ).toEqual(expect.objectContaining({ status: 'started', toolName: 'add' }));
  });

  it('does not wrap tools without idempotencyKey by default (requireExplicitKey: true)', async () => {
    const toolbox = createToolbox([createToolWithKey(), createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache,
      tenantId: 'tenant-a',
      requireExplicitKey: true,
    });

    // multiply should execute normally each time
    await idempotentToolbox.execute({ name: 'multiply', arguments: { a: 2, b: 3 } });
    await idempotentToolbox.execute({ name: 'multiply', arguments: { a: 2, b: 3 } });

    expect(mulCallCount).toBe(2); // Not cached
  });

  it('wraps all tools with fullInputKey when requireExplicitKey is false', async () => {
    const toolbox = createToolbox([createToolWithKey(), createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache,
      tenantId: 'tenant-a',
      requireExplicitKey: false,
    });

    // multiply should now be cached
    const r1 = await idempotentToolbox.execute({ name: 'multiply', arguments: { a: 2, b: 3 } });
    const r2 = await idempotentToolbox.execute({ name: 'multiply', arguments: { a: 2, b: 3 } });

    expect(r1.result).toBe(6);
    expect(r2.result).toBe(6);
    expect(mulCallCount).toBe(1); // Cached
  });

  it('returns a new toolbox without mutating the original', () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    expect(idempotentToolbox).not.toBe(toolbox);
  });

  it('preserves all tools in the toolbox', () => {
    const toolbox = createToolbox([createToolWithKey(), createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const originalTools = toolbox.tools();
    const wrappedTools = idempotentToolbox.tools();

    expect(wrappedTools).toHaveLength(originalTools.length);
    expect(wrappedTools.map((t) => t.name).sort()).toEqual(originalTools.map((t) => t.name).sort());
  });

  it('applies defaultTTL to wrapped tools', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache,
      tenantId: 'tenant-a',
      defaultTTL: 1000,
    });

    await idempotentToolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } });
    await idempotentToolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } });

    expect(addCallCount).toBe(1);
  });

  it('passes unnamed calls through to the original toolbox execution', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const result = await idempotentToolbox.execute({ name: '', arguments: { a: 1, b: 2 } } as any);

    expect(result.outcome).toBe('error');
    expect(result.errorMessage).toContain('Tool not found');
    expect(addCallCount).toBe(0);
  });

  it('supports array execution when wrapping toolbox calls with idempotency', async () => {
    const toolbox = createToolbox([createToolWithKey(), createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const results = await idempotentToolbox.execute([
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      { id: 'call-2', name: 'add', arguments: { a: 1, b: 2 } },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]?.result).toBe(3);
    expect(results[1]?.outcome).toBe('action_required');
    expect(results[1]?.idempotency?.outcome).toBe('unknown-outcome');
    expect(results[1]?.idempotency?.attemptId).toEqual(expect.any(String));
    expect(addCallCount).toBe(1);
  });

  it('handles empty toolbox gracefully', () => {
    const toolbox = createToolbox([]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    expect(idempotentToolbox.tools()).toHaveLength(0);
  });

  it('reports unknown-outcome on retry when a caller-supplied key is in the durable "started" state with no recorded result', async () => {
    // Regression for A1 (orphaned-start, the true crash failure mode): the
    // idempotency layer claims a "started" entry BEFORE running the side effect.
    // If the process dies after the claim but before a result is recorded, the
    // entry is left orphaned in "started" state. A retry with the same
    // caller-supplied key must report unknown-outcome and NOT re-run the side
    // effect — regardless of HOW the start was orphaned. We drive the cache into
    // that exact state directly (via claimCacheStarted, the same primitive the
    // layer uses) rather than depending on a thrown tool error as the setup,
    // so the test pins the durable-state contract, not the error-category path.
    const sideEffects: number[] = [];
    const chargeTool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
      input: z.object({ cents: z.number() }),
      async execute({ cents }) {
        sideEffects.push(cents);
        return { charged: cents };
      },
    });
    // Note: chargeTool has NO idempotencyKey; the caller supplies one externally.
    const toolbox = createToolbox([chargeTool]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const callerKey = 'orchestrator-tool-call-id-abc123';
    const cacheKey = expectedCacheKey('tenant-a', 'default:charge', `charge:${callerKey}`);
    const startedAt = Date.now();

    // Simulate a previous attempt that claimed the started entry and then died
    // before recording any result — the orphaned "started" state.
    const claim = await claimCacheStarted(cache, cacheKey, {
      status: 'started',
      toolName: 'charge',
      startedAt,
      ttl: 60_000,
    });
    expect(claim.outcome).toBe('claimed');

    // Retry with the same caller-supplied key: must NOT run the charge.
    const retry = await idempotentToolbox.execute(
      { id: 'retry-call', name: 'charge', arguments: { cents: 500 } },
      { idempotencyKey: callerKey },
    );

    // The side effect must NOT have run — the orphaned start blocks it.
    expect(sideEffects).toEqual([]);
    // The result surfaces as unknown-outcome (needs human review before retrying).
    expect(retry.outcome).toBe('action_required');
    expect(retry.idempotency).toEqual({
      key: cacheKey,
      outcome: 'unknown-outcome',
      legacyStartedAt: startedAt,
    });
  });

  it('leaves a caller-supplied key orphaned in "started" state when the tool fails with an uncategorized error after its side effect', async () => {
    // Regression for A1 (error-path contract). The tool's execute throws, but
    // createToolbox defaults to errorMode: 'collect', so the toolbox converts the
    // throw into an `outcome: 'error'` RESULT before it reaches the idempotency
    // wrapper — the wrapper's try/catch never sees a thrown error. So this pins
    // `shouldClearStartedState(result)` (the error-RESULT path), not
    // `shouldClearStartedStateForThrownError` (the rethrow path). For an
    // uncategorized error result the "started" entry is NOT cleared, so a retry
    // reports unknown-outcome rather than blindly re-running. The durable-state
    // contract is covered above; the rethrow path that does run
    // shouldClearStartedStateForThrownError is covered by the failFast
    // validation-throws test and the 'throws an unknown primitive error' test.
    const sideEffects: number[] = [];
    const chargeTool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
      input: z.object({ cents: z.number() }),
      async execute({ cents }) {
        sideEffects.push(cents);
        // The side effect happened, then the tool fails. Under errorMode 'collect'
        // this surfaces as an error-outcome result, leaving the idempotency key
        // in "started" state.
        throw new Error('provider unavailable after charge');
      },
    });
    const toolbox = createToolbox([chargeTool]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a' });

    const callerKey = 'orchestrator-tool-call-id-xyz789';

    const first = await idempotentToolbox.execute(
      { id: 'call-1', name: 'charge', arguments: { cents: 500 } },
      { idempotencyKey: callerKey },
    );
    expect(first.outcome).toBe('error');
    expect(sideEffects).toEqual([500]);

    const second = await idempotentToolbox.execute(
      { id: 'call-2', name: 'charge', arguments: { cents: 500 } },
      { idempotencyKey: callerKey },
    );

    // The side effect must NOT have run again.
    expect(sideEffects).toEqual([500]);
    expect(second.outcome).toBe('action_required');
    expect(second.idempotency).toEqual({
      key: expectedCacheKey(
        'tenant-a',
        'default:charge',
        'charge:orchestrator-tool-call-id-xyz789',
      ),
      outcome: 'unknown-outcome',
      attemptId: expect.any(String),
    });
  });

  it('validates idempotency scope and duration options', () => {
    const toolbox = createToolbox([createToolWithKey()]);
    expect(() => withToolboxIdempotency(toolbox, { cache, tenantId: '' })).toThrow(
      'non-empty tenantId',
    );
    expect(() =>
      withToolboxIdempotency(toolbox, {
        cache,
        tenantId: 'tenant-a',
        leaseDurationMs: 0,
      }),
    ).toThrow('durations must be finite and positive');
    const unversioned = withToolboxIdempotency(toolbox, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: '',
    });
    expect(
      unversioned.execute(
        { name: 'add', arguments: { a: 1, b: 2 } },
        { idempotencyKey: 'unversioned' },
      ),
    ).rejects.toThrow('complete revision');
  });

  it('uses atomic claim results that arrive after the initial read', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const completed = {
      result: 99,
      toolName: 'add',
      executedAt: Date.now(),
      ttl: 60_000,
      policyRevision: 'policy:1',
    };
    const completedRace: ToolResultCache = {
      ...cache,
      getState: async () => undefined,
      claimStarted: async () => ({ outcome: 'existing', entry: completed }),
    };
    const completedResult = await withToolboxIdempotency(toolbox, {
      cache: completedRace,
      tenantId: 'tenant-a',
    }).execute({ name: 'add', arguments: { a: 1, b: 2 } });
    expect(completedResult.result).toBe(99);

    const startedRace: ToolResultCache = {
      ...cache,
      getState: async () => undefined,
      claimStarted: async (_key, execution) => ({ outcome: 'existing', entry: execution }),
    };
    const startedResult = await withToolboxIdempotency(toolbox, {
      cache: startedRace,
      tenantId: 'tenant-a',
    }).execute({ name: 'add', arguments: { a: 1, b: 2 } });
    expect(startedResult.outcome).toBe('action_required');
  });

  it('renews active leases and stops completion after losing a fence', async () => {
    let renewals = 0;
    const slowTool = createTool({
      name: 'slow-add',
      description: 'Waits before adding',
      input: z.object({ value: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        await new Promise((resolve) => setTimeout(resolve, 12));
        return value + 1;
      },
    });
    const renewingCache: ToolResultCache = {
      ...cache,
      async renewStarted(key, attemptId, leaseExpiresAt) {
        renewals += 1;
        return cache.renewStarted(key, attemptId, leaseExpiresAt);
      },
    };
    const result = await withToolboxIdempotency(createToolbox([slowTool]), {
      cache: renewingCache,
      tenantId: 'tenant-a',
      leaseDurationMs: 4,
      maximumExecutionDurationMs: 100,
    }).execute({ name: 'slow-add', arguments: { value: 1 } });
    expect(result.result).toBe(2);
    expect(renewals).toBeGreaterThan(0);

    const lostFenceCache: ToolResultCache = {
      ...cache,
      completeStarted: async () => false,
    };
    const unfenced = await withToolboxIdempotency(createToolbox([createToolWithKey()]), {
      cache: lostFenceCache,
      tenantId: 'tenant-b',
    }).execute({ name: 'add', arguments: { a: 2, b: 3 } });
    expect(unfenced.result).toBe(5);
    expect(unfenced.idempotency).toBeUndefined();
    const lostFenceKey = expectedCacheKey(
      'tenant-b',
      'default:add',
      `add:${fullInputKey({ a: 2, b: 3 })}`,
    );
    await expect(cache.getState(lostFenceKey)).resolves.toMatchObject({ status: 'started' });
    const unknown = await withToolboxIdempotency(createToolbox([createToolWithKey()]), {
      cache,
      tenantId: 'tenant-b',
    }).execute({ name: 'add', arguments: { a: 2, b: 3 } });
    expect(unknown.outcome).toBe('action_required');
    expect(addCallCount).toBe(1);

    const failedRenewalCache: ToolResultCache = {
      ...cache,
      renewStarted: async () => {
        throw new Error('lease storage unavailable');
      },
    };
    const renewalFailure = await withToolboxIdempotency(createToolbox([slowTool]), {
      cache: failedRenewalCache,
      tenantId: 'tenant-c',
      leaseDurationMs: 4,
      maximumExecutionDurationMs: 100,
    }).execute({ name: 'slow-add', arguments: { value: 2 } });
    expect(renewalFailure.result).toBe(3);
    expect(renewalFailure.idempotency).toBeUndefined();
  });

  it('checks the deadline after queued renewal wait', async () => {
    let renewals = 0;
    let clockIndex = 0;
    let releaseFirstRenewal!: () => void;
    const firstRenewalReleased = new Promise<void>((resolve) => {
      releaseFirstRenewal = resolve;
    });
    const slowTool = createTool({
      name: 'queued-renewal',
      description: 'Waits for queued lease renewal',
      input: z.object({ value: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        await new Promise((resolve) => setTimeout(resolve, 8));
        releaseFirstRenewal();
        return value;
      },
    });
    const renewalCache: ToolResultCache = {
      ...cache,
      async renewStarted(key, attemptId, leaseExpiresAt, observedAt) {
        renewals += 1;
        if (renewals === 1) await firstRenewalReleased;
        return cache.renewStarted(key, attemptId, leaseExpiresAt, observedAt);
      },
    };

    const result = await withToolboxIdempotency(createToolbox([slowTool]), {
      cache: renewalCache,
      tenantId: 'tenant-a',
      leaseDurationMs: 4,
      maximumExecutionDurationMs: 10,
      now: () => [0, 0, 100][clockIndex++] ?? 100,
    }).execute({ name: 'queued-renewal', arguments: { value: 7 } });

    expect(result.result).toBe(7);
    expect(renewals).toBe(1);
  });

  it('rechecks cache state when authorized unknown replacement loses its race', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const key = expectedCacheKey('tenant-a', 'default:add', 'add:replacement-race');
    const started = {
      status: 'started' as const,
      toolName: 'add',
      startedAt: Date.now(),
      ttl: 60_000,
      attemptId: 'original-attempt',
    };
    const completed = {
      status: 'completed' as const,
      result: 42,
      toolName: 'add',
      executedAt: Date.now(),
      ttl: 60_000,
      policyRevision: 'policy:1',
    };
    let reads = 0;
    const racingCache: ToolResultCache = {
      ...cache,
      getState: async () => (reads++ === 0 ? started : completed),
      replaceUnknownStarted: async () => false,
    };
    const idempotent = withToolboxIdempotency(toolbox, {
      cache: racingCache,
      tenantId: 'tenant-a',
      verifyResolutionReceipt: async () => true,
    });
    const result = await idempotent.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'replacement-race',
        requestContext: createTestRequestContext('tenant-a'),
        resolutionReceipt: {
          version: 1,
          key,
          attemptId: 'original-attempt',
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          decision: 'retry',
          evidence: 'Provider ledger proves no side effect occurred.',
          authorizedAt: Date.now(),
          authorizedBy: 'operator-a',
          nonce: 'receipt-race',
          authorization: 'signed-receipt',
        },
      },
    );
    expect(result.result).toBe(42);
    expect(result.idempotency?.outcome).toBe('deduped');

    reads = 0;
    const missingRaceCache: ToolResultCache = {
      ...racingCache,
      getState: async () => (reads++ === 0 ? started : undefined),
    };
    const missingResult = await withToolboxIdempotency(toolbox, {
      cache: missingRaceCache,
      tenantId: 'tenant-a',
      verifyResolutionReceipt: async () => true,
    }).execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'replacement-race',
        requestContext: createTestRequestContext('tenant-a'),
        resolutionReceipt: {
          version: 1,
          key,
          attemptId: 'original-attempt',
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          decision: 'retry',
          evidence: 'Provider ledger proves no side effect occurred.',
          authorizedAt: Date.now(),
          authorizedBy: 'operator-a',
          nonce: 'receipt-race-2',
          authorization: 'signed-receipt',
        },
      },
    );
    expect(missingResult.outcome).toBe('action_required');

    reads = 0;
    const malformedCurrent = {
      status: 'reserved',
      toolName: 'add',
    } as unknown as Awaited<ReturnType<ToolResultCache['getState']>>;
    const malformedRaceCache: ToolResultCache = {
      ...racingCache,
      getState: async () => (reads++ === 0 ? started : malformedCurrent),
    };
    const malformedResult = await withToolboxIdempotency(toolbox, {
      cache: malformedRaceCache,
      tenantId: 'tenant-a',
      verifyResolutionReceipt: async () => true,
    }).execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'replacement-race',
        requestContext: createTestRequestContext('tenant-a'),
        resolutionReceipt: {
          version: 1,
          key,
          attemptId: 'original-attempt',
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          decision: 'retry',
          evidence: 'Provider ledger proves no side effect occurred.',
          authorizedAt: Date.now(),
          authorizedBy: 'operator-a',
          nonce: 'receipt-race-3',
          authorization: 'signed-receipt',
        },
      },
    );
    expect(malformedResult.outcome).toBe('action_required');
    expect(malformedResult.idempotency).toEqual({
      key,
      outcome: 'unknown-outcome',
    });
    expect(malformedResult.idempotency).not.toHaveProperty('attemptId');
  });

  it('starts replacement leases after receipt verification and uses the injected completion clock', async () => {
    const key = expectedCacheKey('tenant-a', 'default:add', 'add:fresh-retry-clock');
    await cache.claimStarted(key, {
      status: 'started',
      toolName: 'add',
      startedAt: 100,
      ttl: 60_000,
      attemptId: 'expired-attempt',
      leaseExpiresAt: 500,
      absoluteDeadline: 900,
    });
    let clock = 1_000;
    let replacementStartedAt: number | undefined;
    let replacementLeaseExpiresAt: number | undefined;
    let completedAt: number | undefined;
    const observingCache: ToolResultCache = {
      ...cache,
      async replaceUnknownStarted(cacheKey, expectedAttemptId, replacement, currentTime) {
        replacementStartedAt = replacement.startedAt;
        replacementLeaseExpiresAt = replacement.leaseExpiresAt;
        return cache.replaceUnknownStarted!(cacheKey, expectedAttemptId, replacement, currentTime);
      },
      async completeStarted(cacheKey, attemptId, result, ttl, currentTime) {
        completedAt = result.executedAt;
        return cache.completeStarted!(cacheKey, attemptId, result, ttl, currentTime);
      },
    };
    const toolbox = withToolboxIdempotency(createToolbox([createToolWithKey()]), {
      cache: observingCache,
      tenantId: 'tenant-a',
      leaseDurationMs: 200,
      maximumExecutionDurationMs: 1_000,
      now: () => clock,
      verifyResolutionReceipt: async () => {
        clock = 2_000;
        return true;
      },
    });

    const result = await toolbox.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'fresh-retry-clock',
        requestContext: createTestRequestContext('tenant-a'),
        resolutionReceipt: {
          version: 1,
          key,
          attemptId: 'expired-attempt',
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          decision: 'retry',
          evidence: 'the original attempt did not produce an external effect',
          authorizedAt: 1_000,
          authorizedBy: 'operator-a',
          nonce: 'fresh-clock-receipt',
          authorization: 'signed',
        },
      },
    );

    expect(result.result).toBe(3);
    expect(replacementStartedAt).toBe(2_000);
    expect(replacementLeaseExpiresAt).toBe(2_200);
    expect(completedAt).toBe(2_000);
  });

  it('requires current request authority and rejects a mismatched tenant', async () => {
    const toolbox = createIdempotentToolbox(createToolbox([createToolWithKey()]), {
      cache,
      tenantId: 'tenant-a',
    });
    await expect(toolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } })).rejects.toThrow(
      'request-scoped execution authority',
    );
    await expect(
      toolbox.execute(
        { name: 'add', arguments: { a: 1, b: 2 } },
        { requestContext: createTestRequestContext('tenant-b') },
      ),
    ).rejects.toThrow('tenantId must match');
  });

  it('rejects non-finite lease and execution durations', () => {
    const toolbox = createToolbox([createToolWithKey()]);
    for (const options of [
      { leaseDurationMs: Number.NaN },
      { leaseDurationMs: Number.POSITIVE_INFINITY },
      { maximumExecutionDurationMs: Number.NaN },
      { maximumExecutionDurationMs: Number.POSITIVE_INFINITY },
    ]) {
      expect(() =>
        withToolboxIdempotency(toolbox, { cache, tenantId: 'tenant-a', ...options }),
      ).toThrow('finite and positive');
    }
  });

  it('does not replace an active lease even with an authorized receipt', async () => {
    const key = expectedCacheKey('tenant-a', 'default:add', 'add:active-lease');
    await cache.claimStarted(key, {
      status: 'started',
      toolName: 'add',
      startedAt: 100,
      ttl: 60_000,
      attemptId: 'active-attempt',
      leaseExpiresAt: 500,
      absoluteDeadline: 1_000,
    });
    const toolbox = withToolboxIdempotency(createToolbox([createToolWithKey()]), {
      cache,
      tenantId: 'tenant-a',
      now: () => 200,
      verifyResolutionReceipt: () => true,
    });
    const result = await toolbox.execute(
      { id: 'retry', name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'active-lease',
        requestContext: createTestRequestContext('tenant-a'),
        resolutionReceipt: {
          version: 1,
          key,
          attemptId: 'active-attempt',
          tenantId: 'tenant-a',
          toolRevision: 'default:add',
          decision: 'retry',
          evidence: 'operator verified the external effect',
          authorizedAt: 200,
          authorizedBy: 'operator-a',
          nonce: 'active-lease-receipt',
          authorization: 'signed',
        },
      },
    );
    expect(result.idempotency?.outcome).toBe('unknown-outcome');
    expect(result.idempotency?.attemptId).toBe('active-attempt');
    expect(addCallCount).toBe(0);
  });

  it('preserves sequential and bounded-concurrency batch controls', async () => {
    let active = 0;
    let maximumActive = 0;
    const order: number[] = [];
    const tool = createTool({
      name: 'controlled',
      description: 'records execution order',
      input: z.object({ value: z.number() }),
      idempotencyKey: ({ value }: { value: number }) => String(value),
      async execute({ value }) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        order.push(value);
        active -= 1;
        return value;
      },
    });
    const toolbox = withToolboxIdempotency(createToolbox([tool]), {
      cache,
      tenantId: 'tenant-a',
    });
    const calls = [1, 2, 3].map((value) => ({
      id: `call-${value}`,
      name: 'controlled',
      arguments: { value },
    }));
    await toolbox.execute(calls, { mode: 'sequential' });
    expect(order).toEqual([1, 2, 3]);
    expect(maximumActive).toBe(1);

    order.length = 0;
    maximumActive = 0;
    await toolbox.execute(
      calls.map((call, index) => ({
        ...call,
        id: `bounded-${index}`,
        arguments: { value: index + 4 },
      })),
      { concurrency: 2 },
    );
    expect(order).toHaveLength(3);
    expect(maximumActive).toBe(2);
  });
});
