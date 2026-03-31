import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../../src/create-tool';
import { createToolbox } from '../../src/create-toolbox';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { ToolResultCache } from '../../src/idempotency/types';
import { withToolboxIdempotency } from '../../src/idempotency/with-toolbox-idempotency';

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
    expect(addCallCount).toBe(1); // Cached on second call
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

  it('handles empty toolbox gracefully', () => {
    const toolbox = createToolbox([]);
    const idempotentToolbox = withToolboxIdempotency(toolbox, { cache });

    expect(idempotentToolbox.tools()).toHaveLength(0);
  });
});
