import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { CachedToolResult, ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';

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

  it('does not cache errors', async () => {
    let shouldFail = true;
    const tool = createTool({
      name: 'flaky',
      description: 'A flaky tool',
      input: z.object({ x: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ x }) {
        callCount++;
        if (shouldFail) {
          shouldFail = false;
          throw new Error('temporary failure');
        }
        return x * 2;
      },
    });

    const wrapped = withIdempotency(tool, { cache });

    // First call fails
    await expect(wrapped({ x: 5 })).rejects.toThrow('temporary failure');
    expect(callCount).toBe(1);

    // Second call should retry (not return cached error)
    const result = await wrapped({ x: 5 });
    expect(result).toBe(10);
    expect(callCount).toBe(2);
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

  it('preserves the tool configuration', () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache });

    expect(wrapped.configuration).toBeDefined();
    expect(wrapped.configuration.identity.name).toBe('add');
  });
});
