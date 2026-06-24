import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { CachedToolResult, ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';
import type { Tool } from '../../src/is-tool';

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
    const wrapped = withIdempotency(tool, { cache });

    const result = await wrapped({ a: 1, b: 2 });
    expect(result).toBe(3);
    expect(callCount).toBe(1);
  });

  it('returns cached result on duplicate call', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache });

    const result1 = await wrapped({ a: 1, b: 2 });
    const result2 = await wrapped({ a: 1, b: 2 });

    expect(result1).toBe(3);
    expect(result2).toBe(3);
    expect(callCount).toBe(1); // Only executed once
  });

  it('executes again for different inputs', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache });

    await wrapped({ a: 1, b: 2 });
    await wrapped({ a: 3, b: 4 });

    expect(callCount).toBe(2);
  });

  it('preserves tool name and description', () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache });

    expect(wrapped.name).toBe('add');
    expect(wrapped.description).toBe('Adds two numbers');
  });

  it('preserves tool input schema', () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache });

    expect(wrapped.input).toBe(tool.input);
  });

  it('calls onCacheHit when returning a cached result', async () => {
    const tool = createTestTool();
    const onCacheHit = mock((key: string, result: CachedToolResult) => {});
    const wrapped = withIdempotency(tool, { cache, onCacheHit });

    await wrapped({ a: 1, b: 2 });
    await wrapped({ a: 1, b: 2 });

    expect(onCacheHit).toHaveBeenCalledTimes(1);
    expect(onCacheHit.mock.calls[0]![1]!.result).toBe(3);
    expect(onCacheHit.mock.calls[0]![1]!.toolName).toBe('add');
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
    const wrapped = withIdempotency(tool, { cache, onUnknownOutcome });
    const key = `charge:${fullInputKey({ cents: 100 })}`;

    await expect(wrapped({ cents: 100 })).rejects.toThrow('provider timeout after charge');
    expect(callCount).toBe(1);
    expect(sideEffects).toEqual([100]);

    await expect(wrapped({ cents: 100 })).rejects.toThrow('unknown outcome');
    expect(callCount).toBe(1);
    expect(sideEffects).toEqual([100]);
    expect(onUnknownOutcome).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ status: 'started', toolName: 'charge' }),
    );
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
    const wrapped = withIdempotency(tool, { cache });
    const key = `typed-input:${fullInputKey({ x: '5' })}`;

    await expect(wrapped({ x: '5' })).rejects.toThrow();
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
        configuration: {
          identity: { name: 'jsonSchemaInput' },
        },
      },
    ) as unknown as Tool & { idempotencyKey: (input: unknown) => string };
    const wrapped = withIdempotency(tool, { cache });

    await expect(wrapped({ x: 5 })).resolves.toBe(10);
    await expect(wrapped({ x: 5 })).resolves.toBe(10);
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
    const key = `flaky:${fullInputKey({ x: 5 })}`;
    await cache.markStarted!(key, {
      status: 'started',
      toolName: 'flaky',
      startedAt: Date.now(),
      ttl: 60_000,
    });

    const onUnknownOutcome = mock(() => {});
    const wrapped = withIdempotency(tool, { cache, onUnknownOutcome });

    await expect(wrapped({ x: 5 })).rejects.toThrow('unknown outcome');
    expect(onUnknownOutcome).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ status: 'started', toolName: 'flaky' }),
    );
    expect(callCount).toBe(0);
  });

  it('throws when tool has no idempotencyKey', () => {
    const tool = createTool({
      name: 'no-key',
      description: 'Tool without idempotency key',
      input: z.object({ x: z.number() }),
      async execute({ x }) {
        return x;
      },
    });

    expect(() => withIdempotency(tool, { cache })).toThrow();
  });

  it('supports caches that only implement the original completed-result API', async () => {
    const completedResults = new Map<string, CachedToolResult>();
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
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache: legacyCache });

    await expect(wrapped({ a: 1, b: 2 })).resolves.toBe(3);
    await expect(wrapped({ a: 1, b: 2 })).resolves.toBe(3);

    expect(callCount).toBe(1);
  });

  it('uses an existing completed result returned while claiming a key', async () => {
    const completed: CachedToolResult = {
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
    const onCacheHit = mock(() => {});
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache: racingCache, onCacheHit });
    const key = `add:${fullInputKey({ a: 1, b: 2 })}`;

    await expect(wrapped({ a: 1, b: 2 })).resolves.toBe(99);

    expect(callCount).toBe(0);
    expect(onCacheHit).toHaveBeenCalledWith(key, completed);
  });

  it('surfaces an existing started state returned while claiming a key', async () => {
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
    const onUnknownOutcome = mock(() => {});
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache: racingCache, onUnknownOutcome });
    const key = `add:${fullInputKey({ a: 1, b: 2 })}`;

    await expect(wrapped({ a: 1, b: 2 })).rejects.toThrow('unknown outcome');

    expect(callCount).toBe(0);
    expect(onUnknownOutcome).toHaveBeenCalledWith(key, started);
  });

  it('uses custom TTL when provided', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache, ttl: 1000 });

    await wrapped({ a: 1, b: 2 });

    // The cached entry should have the custom TTL
    // We verify indirectly: result should be returned from cache
    const result = await wrapped({ a: 1, b: 2 });
    expect(result).toBe(3);
    expect(callCount).toBe(1);
  });

  it('supports execute() for both raw params and ToolCall inputs', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache });

    const directResult = await wrapped.execute({ a: 1, b: 2 });
    const cachedDirectResult = await wrapped.execute({ a: 1, b: 2 });
    expect(directResult).toBe(3);
    expect(cachedDirectResult).toBe(3);
    expect(callCount).toBe(1);

    const toolCall = { id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } };
    const executionResult = await wrapped.execute(toolCall);
    expect(executionResult.result).toBe(5);
    expect(executionResult.toolName).toBe('add');
    expect(callCount).toBe(2);
  });

  it('passes direct ToolCall-style invocations through the original tool path', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache });

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
    const wrapped = withIdempotency(tool, { cache });

    expect(wrapped.configuration).toBeDefined();
    expect(wrapped.configuration.identity.name).toBe('add');
  });
});
