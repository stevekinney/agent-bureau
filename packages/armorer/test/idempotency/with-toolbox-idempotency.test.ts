import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../../src/create-tool';
import { createToolbox, type Toolbox } from '../../src/create-toolbox';
import { claimCacheStarted } from '../../src/idempotency/cache-operations';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { ToolResultCache } from '../../src/idempotency/types';
import { withToolboxIdempotency } from '../../src/idempotency/with-toolbox-idempotency';
import type { SignedPendingToolApproval, ToolCallInput } from '../../src/types';

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
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

    // Execute add twice with same args
    const result1 = await idempotentToolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } });
    const result2 = await idempotentToolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } });

    expect(result1.result).toBe(3);
    expect(result2.result).toBe(3);
    expect(result1.idempotency?.outcome).toBe('fresh');
    expect(result2.idempotency?.outcome).toBe('deduped');
    expect(addCallCount).toBe(1); // Cached on second call
    expect(await cache.getState!(`add:${fullInputKey({ a: 1, b: 2 })}`)).toEqual(
      expect.objectContaining({
        status: 'completed',
        toolName: 'add',
        result: 3,
      }),
    );
  });

  it('accepts an externally supplied idempotency key', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

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
      key: 'add:temporal-tool-call-id',
      outcome: 'deduped',
    });
    expect(addCallCount).toBe(1);
  });

  it('uses externally supplied idempotency keys for tools without their own key', async () => {
    const toolbox = createToolbox([createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

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
      key: 'multiply:orchestrator-tool-call-id',
      outcome: 'deduped',
    });
    expect(mulCallCount).toBe(1);
  });

  it('scopes externally supplied idempotency keys by tool name', async () => {
    const toolbox = createToolbox([createToolWithKey(), createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache,
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
    expect(addResult.idempotency?.key).toBe('add:shared-key');
    expect(multiplyResult.idempotency?.key).toBe('multiply:shared-key');
    expect(addCallCount).toBe(1);
    expect(mulCallCount).toBe(1);
  });

  it('returns unknown-outcome when a key was started without a recorded result', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

    await cache.markStarted!('add:started-key', {
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
      key: 'add:started-key',
      outcome: 'unknown-outcome',
    });
    expect(addCallCount).toBe(0);
  });

  it('retries an unknown outcome only after explicit approval', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

    await cache.markStarted!('add:retry-after-review', {
      status: 'started',
      toolName: 'add',
      startedAt: Date.now(),
      ttl: 60_000,
    });

    const pause = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'retry-after-review' },
    );
    const retry = await idempotentToolbox.execute(
      { id: 'call-2', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'retry-after-review', retryUnknownOutcome: true },
    );

    expect(pause.outcome).toBe('action_required');
    expect(retry.outcome).toBe('success');
    expect(retry.result).toBe(3);
    expect(retry.idempotency).toEqual({
      key: 'add:retry-after-review',
      outcome: 'fresh',
    });
    expect(addCallCount).toBe(1);
    expect(await cache.getState!('add:retry-after-review')).toEqual(
      expect.objectContaining({
        status: 'completed',
        toolName: 'add',
        result: 3,
      }),
    );
  });

  it('retries an unknown outcome returned by an atomic claim only after explicit approval', async () => {
    const started = {
      status: 'started' as const,
      toolName: 'add',
      startedAt: Date.now(),
      ttl: 60_000,
    };
    let claims = 0;
    let deletes = 0;
    const atomicCache: ToolResultCache = {
      async get() {
        return undefined;
      },
      async claimStarted(_key, execution) {
        claims++;
        if (claims === 1) {
          return { outcome: 'existing', entry: started };
        }
        return { outcome: 'claimed' };
      },
      async set() {},
      async delete() {
        deletes++;
      },
      async clear() {},
    };
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache: atomicCache });

    const result = await idempotentToolbox.execute(
      { id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'atomic-retry', retryUnknownOutcome: true },
    );

    expect(result.outcome).toBe('success');
    expect(result.result).toBe(3);
    expect(result.idempotency).toEqual({
      key: 'add:atomic-retry',
      outcome: 'fresh',
    });
    expect(claims).toBe(2);
    expect(deletes).toBe(1);
    expect(addCallCount).toBe(1);
  });

  it('does not keep started state for validation failures', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

    const result = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: '1', b: 2 } },
      { idempotencyKey: 'invalid-input' },
    );

    expect(result.outcome).toBe('error');
    expect(result.idempotency).toBeUndefined();
    expect(await cache.getState!('add:invalid-input')).toBeUndefined();
    expect(addCallCount).toBe(0);
  });

  it('does not keep started state when fail-fast validation throws', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

    await expect(
      idempotentToolbox.execute(
        { name: 'add', arguments: { a: '1', b: 2 } },
        { idempotencyKey: 'invalid-input', errorMode: 'failFast' },
      ),
    ).rejects.toMatchObject({ category: 'validation' });

    expect(await cache.getState!('add:invalid-input')).toBeUndefined();

    const retry = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: '1', b: 2 } },
      { idempotencyKey: 'invalid-input' },
    );

    expect(retry.outcome).toBe('error');
    expect(retry.idempotency).toBeUndefined();
    expect(await cache.getState!('add:invalid-input')).toBeUndefined();
    expect(addCallCount).toBe(0);
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
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

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
    expect(await cache.getState!('add:approval-pause')).toBeUndefined();
    expect(addCallCount).toBe(0);
  });

  it('does not keep started state for budget blocks before execution', async () => {
    const toolbox = createToolbox([createToolWithKey()], {
      budget: { maxCalls: 0 },
    });
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

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
    expect(await cache.getState!('add:budget-block')).toBeUndefined();
    expect(addCallCount).toBe(0);
  });

  it('does not keep started state when fail-fast budget blocks throw', async () => {
    const toolbox = createToolbox([createToolWithKey()], {
      budget: { maxCalls: 0 },
    });
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

    await expect(
      idempotentToolbox.execute(
        { name: 'add', arguments: { a: 1, b: 2 } },
        { idempotencyKey: 'budget-block', errorMode: 'failFast' },
      ),
    ).rejects.toMatchObject({ category: 'conflict', code: 'BUDGET_EXCEEDED' });

    expect(await cache.getState!('add:budget-block')).toBeUndefined();

    const retry = await idempotentToolbox.execute(
      { name: 'add', arguments: { a: 1, b: 2 } },
      { idempotencyKey: 'budget-block' },
    );

    expect(retry.outcome).toBe('error');
    expect(retry.idempotency).toBeUndefined();
    expect(await cache.getState!('add:budget-block')).toBeUndefined();
    expect(addCallCount).toBe(0);
  });

  it('routes signed approval resumes through toolbox idempotency', async () => {
    const charges: number[] = [];
    const chargeTool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
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
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });
    const paused = await idempotentToolbox.execute(
      { id: 'charge-call', name: 'charge', arguments: { cents: 100 } },
      { idempotencyKey: 'charge-once' },
    );

    const firstResume = await idempotentToolbox.resumeApproval(
      paused.pendingApproval! as SignedPendingToolApproval,
      { idempotencyKey: 'charge-once' },
    );
    const secondResume = await idempotentToolbox.resumeApproval(
      paused.pendingApproval! as SignedPendingToolApproval,
      { idempotencyKey: 'charge-once' },
    );

    expect(firstResume.result).toEqual({ charged: 100 });
    expect(firstResume.idempotency).toEqual({
      key: 'charge:charge-once',
      outcome: 'fresh',
    });
    expect(secondResume.result).toEqual({ charged: 100 });
    expect(secondResume.idempotency).toEqual({
      key: 'charge:charge-once',
      outcome: 'deduped',
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
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

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
    expect(await cache.getState!('add:policy-denied')).toBeUndefined();
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
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

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
      key: 'charge:charge-once',
      outcome: 'unknown-outcome',
    });
    expect(sideEffects).toEqual([100]);
    expect(await cache.getState!('charge:charge-once')).toEqual(
      expect.objectContaining({ status: 'started', toolName: 'charge' }),
    );
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
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

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
      key: 'add:primitive-error',
      outcome: 'unknown-outcome',
    });
    expect(await cache.getState!('add:primitive-error')).toEqual(
      expect.objectContaining({ status: 'started', toolName: 'add' }),
    );
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
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

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
      key: 'add:error-without-object',
      outcome: 'unknown-outcome',
    });
    expect(await cache.getState!('add:error-without-object')).toEqual(
      expect.objectContaining({ status: 'started', toolName: 'add' }),
    );
  });

  it('does not wrap tools without idempotencyKey by default (requireExplicitKey: true)', async () => {
    const toolbox = createToolbox([createToolWithKey(), createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache,
      requireExplicitKey: true,
    });

    // multiply should execute normally each time
    await idempotentToolbox.execute({ name: 'multiply', arguments: { a: 2, b: 3 } });
    await idempotentToolbox.execute({ name: 'multiply', arguments: { a: 2, b: 3 } });

    expect(mulCallCount).toBe(2); // Not cached
  });

  it('supports caches that only implement the original completed-result API', async () => {
    const completedResults = new Map<string, Awaited<ReturnType<ToolResultCache['get']>>>();
    const legacyCache: ToolResultCache = {
      async get(key) {
        return completedResults.get(key);
      },
      async set(key, result) {
        completedResults.set(key, result);
      },
      async delete(key) {
        completedResults.delete(key);
      },
      async clear() {
        completedResults.clear();
      },
    };
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache: legacyCache });

    const first = await idempotentToolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } });
    const second = await idempotentToolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } });

    expect(first.result).toBe(3);
    expect(second.idempotency?.outcome).toBe('deduped');
    expect(addCallCount).toBe(1);
  });

  it('uses an existing completed result returned while claiming a toolbox key', async () => {
    const completed = {
      result: 99,
      toolName: 'add',
      executedAt: Date.now(),
      ttl: 60_000,
    };
    let reads = 0;
    const racingCache: ToolResultCache = {
      async get() {
        reads++;
        return reads === 1 ? undefined : completed;
      },
      async set() {
        throw new Error('set should not be called');
      },
      async delete() {
        throw new Error('delete should not be called');
      },
      async clear() {},
    };
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache: racingCache });
    const key = `add:${fullInputKey({ a: 1, b: 2 })}`;

    const result = await idempotentToolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } });

    expect(result).toMatchObject({
      outcome: 'success',
      result: 99,
      idempotency: {
        key,
        outcome: 'deduped',
      },
    });
    expect(addCallCount).toBe(0);
  });

  it('surfaces an existing started result returned while claiming a toolbox key', async () => {
    const started = {
      status: 'started' as const,
      toolName: 'add',
      startedAt: Date.now(),
      ttl: 60_000,
    };
    let reads = 0;
    const racingCache: ToolResultCache = {
      async getState() {
        reads++;
        return reads === 1 ? undefined : started;
      },
      async get() {
        return undefined;
      },
      async set() {
        throw new Error('set should not be called');
      },
      async delete() {
        throw new Error('delete should not be called');
      },
      async clear() {},
    };
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache: racingCache });
    const key = `add:${fullInputKey({ a: 1, b: 2 })}`;

    const result = await idempotentToolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } });

    expect(result).toMatchObject({
      outcome: 'action_required',
      idempotency: {
        key,
        outcome: 'unknown-outcome',
      },
      action: {
        type: 'approval',
      },
    });
    expect(addCallCount).toBe(0);
  });

  it('wraps all tools with fullInputKey when requireExplicitKey is false', async () => {
    const toolbox = createToolbox([createToolWithKey(), createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache,
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
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

    expect(idempotentToolbox).not.toBe(toolbox);
  });

  it('preserves all tools in the toolbox', () => {
    const toolbox = createToolbox([createToolWithKey(), createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

    const originalTools = toolbox.tools();
    const wrappedTools = idempotentToolbox.tools();

    expect(wrappedTools).toHaveLength(originalTools.length);
    expect(wrappedTools.map((t) => t.name).sort()).toEqual(originalTools.map((t) => t.name).sort());
  });

  it('applies defaultTTL to wrapped tools', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, {
      cache,
      defaultTTL: 1000,
    });

    await idempotentToolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } });
    await idempotentToolbox.execute({ name: 'add', arguments: { a: 1, b: 2 } });

    expect(addCallCount).toBe(1);
  });

  it('passes unnamed calls through to the original toolbox execution', async () => {
    const toolbox = createToolbox([createToolWithKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

    const result = await idempotentToolbox.execute({ name: '', arguments: { a: 1, b: 2 } } as any);

    expect(result.outcome).toBe('error');
    expect(result.errorMessage).toContain('Tool not found');
    expect(addCallCount).toBe(0);
  });

  it('supports array execution when wrapping toolbox calls with idempotency', async () => {
    const toolbox = createToolbox([createToolWithKey(), createToolWithoutKey()]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

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
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

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
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

    const callerKey = 'orchestrator-tool-call-id-abc123';
    const cacheKey = `charge:${callerKey}`;

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

  it('leaves a caller-supplied key orphaned in "started" state when the tool throws an uncategorized error after its side effect', async () => {
    // Regression for A1 (error-path contract): an uncategorized thrown error
    // (no validation/permission/not_found/pre-execution-conflict category) is
    // treated as a possible mid-execution crash — the "started" entry is NOT
    // cleared, so a retry reports unknown-outcome rather than blindly re-running.
    // This pins the specific behavior of shouldClearStartedStateForThrownError
    // for uncategorized errors; the durable-state contract is covered above.
    const sideEffects: number[] = [];
    const chargeTool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
      input: z.object({ cents: z.number() }),
      async execute({ cents }) {
        sideEffects.push(cents);
        // Uncategorized error: the side effect happened but no result is
        // recorded, leaving the idempotency key in "started" state.
        throw new Error('provider unavailable after charge');
      },
    });
    const toolbox = createToolbox([chargeTool]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

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
      key: 'charge:orchestrator-tool-call-id-xyz789',
      outcome: 'unknown-outcome',
    });
  });
});
