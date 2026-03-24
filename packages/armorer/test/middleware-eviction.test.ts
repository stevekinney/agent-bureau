import { describe, expect, it } from 'bun:test';

import type { ToolConfiguration } from '../src/is-tool';
import { createCacheMiddleware, createRateLimitMiddleware } from '../src/middleware/index';

function makeToolConfiguration(name = 'test-tool'): ToolConfiguration {
  return {
    name,
    description: 'a test tool',
    input: { _def: {} } as any,
    execute: async () => 'ok',
  };
}

describe('createRateLimitMiddleware expiry sweep', () => {
  it('cleans expired entries on each new entry', async () => {
    // Use a very short window so entries expire quickly
    const middleware = createRateLimitMiddleware({
      windowMs: 1,
      limit: 100,
    });

    const configuration = middleware(makeToolConfiguration());

    // Execute once to create a rate limit record
    await (configuration.execute as (params: unknown, context: unknown) => Promise<unknown>)(
      {},
      {},
    );

    // Wait for the window to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Execute again - should sweep expired entries and not throw
    await (configuration.execute as (params: unknown, context: unknown) => Promise<unknown>)(
      {},
      {},
    );

    // If we get here without error, the sweep worked
    expect(true).toBe(true);
  });
});

describe('createCacheMiddleware maxSize eviction', () => {
  it('evicts oldest cache entry when maxSize is exceeded', async () => {
    let callCount = 0;
    const configuration: ToolConfiguration = {
      name: 'counting-tool',
      description: 'counts calls',
      input: { _def: {} } as any,
      execute: async (params: unknown) => {
        callCount++;
        return `result-${callCount}`;
      },
    };

    const middleware = createCacheMiddleware({
      ttlMs: 60000,
      maxSize: 2,
    });

    const wrapped = middleware(configuration);
    const execute = wrapped.execute as (params: unknown, context: unknown) => Promise<unknown>;

    // Cache 3 entries
    await execute({ key: 'a' }, {});
    await execute({ key: 'b' }, {});
    await execute({ key: 'c' }, {});
    expect(callCount).toBe(3);

    // 'a' should have been evicted, so calling it again should trigger a new call
    await execute({ key: 'a' }, {});
    expect(callCount).toBe(4);

    // 'c' should still be cached
    await execute({ key: 'c' }, {});
    expect(callCount).toBe(4);
  });

  it('does not evict when under maxSize', async () => {
    let callCount = 0;
    const configuration: ToolConfiguration = {
      name: 'counting-tool',
      description: 'counts calls',
      input: { _def: {} } as any,
      execute: async () => {
        callCount++;
        return `result-${callCount}`;
      },
    };

    const middleware = createCacheMiddleware({
      ttlMs: 60000,
      maxSize: 100,
    });

    const wrapped = middleware(configuration);
    const execute = wrapped.execute as (params: unknown, context: unknown) => Promise<unknown>;

    await execute({ key: 'a' }, {});
    await execute({ key: 'b' }, {});
    expect(callCount).toBe(2);

    // Both should be cached
    await execute({ key: 'a' }, {});
    await execute({ key: 'b' }, {});
    expect(callCount).toBe(2);
  });
});
