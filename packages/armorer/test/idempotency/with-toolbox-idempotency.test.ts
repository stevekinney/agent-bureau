import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../../src/create-tool';
import { createToolbox, type Toolbox } from '../../src/create-toolbox';
import { claimCacheStarted } from '../../src/idempotency/cache-operations';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { ToolResultCache } from '../../src/idempotency/types';
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

function expectedCacheKey(
  tenantId: string,
  revision: string,
  baseKey: string,
  requestContext = createTestRequestContext(tenantId),
): string {
  return JSON.stringify([
    tenantId,
    requestContext.authority.principalId,
    requestContext.authority.ownerId,
    requestContext.authority.authorizationRevision,
    [...requestContext.authority.capabilities].sort(),
    requestContext.audience,
    requestContext.agentId,
    requestContext.runId,
    'policy:1',
    revision,
    baseKey,
  ]);
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

    await cache.claimStarted(expectedCacheKey('tenant-a', 'default:add', 'add:started-key'), {
      status: 'started',
      toolName: 'add',
      startedAt: Date.now(),
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
    const retry = await idempotentToolbox.execute(
      { id: 'call-2', name: 'add', arguments: { a: 1, b: 2 } },
      {
        idempotencyKey: 'retry-after-review',
        resolutionReceipt: {
          version: 1,
          key: expectedCacheKey('tenant-a', 'default:add', 'add:retry-after-review'),
          attemptId: 'original-attempt',
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

    const firstResume = await idempotentToolbox.resumeApproval(
      paused.pendingApproval! as SignedPendingToolApproval,
      { idempotencyKey: 'charge-once', requestContext },
    );
    await expect(
      idempotentToolbox.resumeApproval(paused.pendingApproval! as SignedPendingToolApproval, {
        idempotencyKey: 'charge-once',
        requestContext,
      }),
    ).rejects.toThrow('already been consumed');

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
    expect(charges).toEqual([100]);
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

    // Simulate a previous attempt that claimed the started entry and then died
    // before recording any result — the orphaned "started" state.
    const claim = await claimCacheStarted(cache, cacheKey, {
      status: 'started',
      toolName: 'charge',
      startedAt: Date.now(),
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
