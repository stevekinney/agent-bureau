import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../../src/create-tool';
import { createToolbox, type Toolbox } from '../../src/create-toolbox';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { ToolResultCache } from '../../src/idempotency/types';
import { withToolboxIdempotency } from '../../src/idempotency/with-toolbox-idempotency';
import type { ToolCallInput } from '../../src/types';

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
});
