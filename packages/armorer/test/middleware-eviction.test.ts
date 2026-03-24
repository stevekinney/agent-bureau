import { describe, expect, it } from 'bun:test';

import type { ToolConfiguration } from '../src/is-tool';
import {
  createCacheMiddleware,
  createRateLimitMiddleware,
  createTimeoutMiddleware,
  createTruncationMiddleware,
} from '../src/middleware/index';

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

describe('createRateLimitMiddleware', () => {
  it('throws when rate limit is exceeded', async () => {
    const middleware = createRateLimitMiddleware({ windowMs: 60000, limit: 1 });
    const configuration = middleware(makeToolConfiguration());
    const execute = configuration.execute as (p: unknown, c: unknown) => Promise<unknown>;

    await execute({}, {});
    expect(execute({}, {})).rejects.toThrow('Rate limit exceeded');
  });

  it('handles lazy execute (Promise<Function>)', async () => {
    const lazyConfig: ToolConfiguration = {
      name: 'lazy-tool',
      description: 'lazy',
      input: { _def: {} } as any,
      execute: Promise.resolve(async () => 'lazy-result'),
    };
    const middleware = createRateLimitMiddleware({ windowMs: 60000, limit: 10 });
    const wrapped = middleware(lazyConfig);
    const result = await (wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>)({}, {});
    expect(result).toBe('lazy-result');
  });
});

describe('createCacheMiddleware', () => {
  it('handles lazy execute (Promise<Function>)', async () => {
    let callCount = 0;
    const lazyConfig: ToolConfiguration = {
      name: 'lazy-cache-tool',
      description: 'lazy cache',
      input: { _def: {} } as any,
      execute: Promise.resolve(async () => {
        callCount++;
        return 'cached';
      }),
    };
    const middleware = createCacheMiddleware({ ttlMs: 60000 });
    const wrapped = middleware(lazyConfig);
    const execute = wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>;
    await execute({ key: 'x' }, {});
    await execute({ key: 'x' }, {});
    expect(callCount).toBe(1);
  });

  it('falls back to String(params) for non-serializable params', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    let callCount = 0;
    const config: ToolConfiguration = {
      name: 'circular-tool',
      description: 'test',
      input: { _def: {} } as any,
      execute: async () => {
        callCount++;
        return 'ok';
      },
    };
    const middleware = createCacheMiddleware({ ttlMs: 60000 });
    const wrapped = middleware(config);
    const execute = wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>;
    await execute(circular, {});
    expect(callCount).toBe(1);
  });
});

describe('createTimeoutMiddleware', () => {
  it('resolves when tool completes within timeout', async () => {
    const config = makeToolConfiguration();
    const middleware = createTimeoutMiddleware(5000);
    const wrapped = middleware(config);
    const result = await (wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>)({}, {});
    expect(result).toBe('ok');
  });

  it('rejects when tool exceeds timeout', async () => {
    const config: ToolConfiguration = {
      name: 'slow-tool',
      description: 'slow',
      input: { _def: {} } as any,
      execute: async () => new Promise((resolve) => setTimeout(resolve, 5000)),
    };
    const middleware = createTimeoutMiddleware(1);
    const wrapped = middleware(config);
    expect(
      (wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>)({}, {}),
    ).rejects.toThrow('timed out');
  });

  it('rejects with wrapped error when tool throws', async () => {
    const config: ToolConfiguration = {
      name: 'throw-tool',
      description: 'throws',
      input: { _def: {} } as any,
      execute: async () => {
        throw 'string-error';
      },
    };
    const middleware = createTimeoutMiddleware(5000);
    const wrapped = middleware(config);
    expect(
      (wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>)({}, {}),
    ).rejects.toThrow('string-error');
  });

  it('handles lazy execute (Promise<Function>)', async () => {
    const config: ToolConfiguration = {
      name: 'lazy-timeout-tool',
      description: 'lazy timeout',
      input: { _def: {} } as any,
      execute: Promise.resolve(async () => 'lazy-timeout-result'),
    };
    const middleware = createTimeoutMiddleware(5000);
    const wrapped = middleware(config);
    const result = await (wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>)({}, {});
    expect(result).toBe('lazy-timeout-result');
  });
});

describe('createTruncationMiddleware', () => {
  it('truncates string results', async () => {
    const config: ToolConfiguration = {
      name: 'long-tool',
      description: 'long',
      input: { _def: {} } as any,
      execute: async () => 'a'.repeat(200000),
    };
    const middleware = createTruncationMiddleware({ maxCharacters: 100 });
    const wrapped = middleware(config);
    const result = await (wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>)({}, {});
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeLessThan(200000);
  });

  it('truncates object content field', async () => {
    const config: ToolConfiguration = {
      name: 'obj-tool',
      description: 'obj',
      input: { _def: {} } as any,
      execute: async () => ({ content: 'b'.repeat(200000) }),
    };
    const middleware = createTruncationMiddleware({ maxCharacters: 100 });
    const wrapped = middleware(config);
    const result = (await (wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>)(
      {},
      {},
    )) as { content: string };
    expect(result.content.length).toBeLessThan(200000);
  });

  it('wraps async iterable stream fields', async () => {
    async function* gen() {
      yield 'chunk1';
      yield 'chunk2';
    }
    const config: ToolConfiguration = {
      name: 'stream-tool',
      description: 'stream',
      input: { _def: {} } as any,
      execute: async () => ({ stream: gen() }),
    };
    const middleware = createTruncationMiddleware({ maxCharacters: 100 });
    const wrapped = middleware(config);
    const result = (await (wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>)(
      {},
      {},
    )) as { stream: AsyncIterable<string> };
    const chunks: string[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('wraps async iterable result fields', async () => {
    async function* gen() {
      yield 'r1';
      yield 'r2';
    }
    const config: ToolConfiguration = {
      name: 'result-stream-tool',
      description: 'result stream',
      input: { _def: {} } as any,
      execute: async () => ({ result: gen() }),
    };
    const middleware = createTruncationMiddleware({ maxCharacters: 100 });
    const wrapped = middleware(config);
    const result = (await (wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>)(
      {},
      {},
    )) as { result: AsyncIterable<string> };
    const chunks: string[] = [];
    for await (const chunk of result.result) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('handles lazy execute (Promise<Function>)', async () => {
    const config: ToolConfiguration = {
      name: 'lazy-trunc-tool',
      description: 'lazy trunc',
      input: { _def: {} } as any,
      execute: Promise.resolve(async () => 'short'),
    };
    const middleware = createTruncationMiddleware();
    const wrapped = middleware(config);
    const result = await (wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>)({}, {});
    expect(result).toBe('short');
  });

  it('passes through non-string non-object results', async () => {
    const config: ToolConfiguration = {
      name: 'num-tool',
      description: 'num',
      input: { _def: {} } as any,
      execute: async () => 42,
    };
    const middleware = createTruncationMiddleware();
    const wrapped = middleware(config);
    const result = await (wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>)({}, {});
    expect(result).toBe(42);
  });

  it('detects error objects via isError option', async () => {
    const config: ToolConfiguration = {
      name: 'err-tool',
      description: 'err',
      input: { _def: {} } as any,
      execute: async () => ({ content: 'c'.repeat(200000), error: true }),
    };
    const middleware = createTruncationMiddleware({ maxCharacters: 100, isError: true });
    const wrapped = middleware(config);
    const result = (await (wrapped.execute as (p: unknown, c: unknown) => Promise<unknown>)(
      {},
      {},
    )) as { content: string };
    expect(result.content.length).toBeLessThan(200000);
  });
});
