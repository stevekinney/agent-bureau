import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { expectPromiseToReject } from './async-assertion-test-helpers';

import { createTool } from './create-tool';
import { retry } from './utilities';

describe('retry()', () => {
  const increment = createTool({
    name: 'increment',
    description: 'Adds 1',
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => ({ value: value + 1 }),
  });

  it('retries until success', async () => {
    let attempts = 0;
    const flaky = createTool({
      name: 'flaky',
      description: 'Fails twice',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('boom');
        }
        return { value: value + attempts };
      },
    });

    const wrapped = retry(flaky, { attempts: 3 });
    const result = await wrapped({ value: 1 });

    expect(result).toMatchObject({ value: 4 });
    expect(attempts).toBe(3);
  });

  it('throws after exhausting attempts', async () => {
    let attempts = 0;
    const failing = createTool({
      name: 'failing',
      description: 'Always fails',
      input: z.object({ value: z.number() }),
      execute: async () => {
        attempts += 1;
        throw new Error('boom');
      },
    });

    const wrapped = retry(failing, { attempts: 2 });

    await expectPromiseToReject(wrapped({ value: 1 }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('boom'),
    );
    expect(attempts).toBe(2);
  });

  it('validates retry options', () => {
    expect(() => retry(increment, { attempts: 0 })).toThrow(
      'retry() expects attempts to be a positive integer',
    );
    expect(() => retry(increment, { delayMs: -1 })).toThrow(
      'retry() expects delayMs to be at least 0',
    );
    expect(() => retry(increment, { maxDelayMs: -1 })).toThrow(
      'retry() expects maxDelayMs to be at least 0',
    );
  });

  it('stops retrying when shouldRetry returns false', async () => {
    let attempts = 0;
    const failing = createTool({
      name: 'fail-fast',
      description: 'fails',
      input: z.object({ value: z.number() }),
      execute: async () => {
        attempts += 1;
        throw new Error('stop');
      },
    });

    const wrapped = retry(failing, {
      attempts: 3,
      shouldRetry: async () => false,
    });

    await expectPromiseToReject(wrapped({ value: 1 }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('stop'),
    );
    expect(attempts).toBe(1);
  });

  it('invokes onRetry and honors backoff with maxDelayMs', async () => {
    let attempts = 0;
    const flaky = createTool({
      name: 'flaky',
      description: 'fails once',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('retry me');
        }
        return { value };
      },
    });

    const retries: number[] = [];
    const wrapped = retry(flaky, {
      attempts: 2,
      delayMs: 5,
      backoff: 'exponential',
      maxDelayMs: 1,
      onRetry: async ({ attempt }) => {
        retries.push(attempt);
      },
    });

    const result = await wrapped({ value: 5 });
    expect(result).toMatchObject({ value: 5 });
    expect(retries).toEqual([1]);
  });

  it('normalizes non-Error throws and preserves tags/metadata', async () => {
    const unstable = createTool({
      name: 'unstable',
      description: 'throws string',
      input: z.object({ value: z.number() }),
      tags: ['unstable'],
      metadata: { tier: 'dev' },
      execute: async () => {
        throw 'nope';
      },
    });

    const wrapped = retry(unstable, { attempts: 2 });
    expect(wrapped.tags).toEqual(['unstable']);
    expect(wrapped.metadata).toMatchObject({ tier: 'dev' });
    await expectPromiseToReject(wrapped({ value: 1 }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('nope'),
    );
  });

  it('stringifies thrown objects when retrying', async () => {
    const unstable = createTool({
      name: 'object-throw',
      description: 'throws object',
      input: z.object({ value: z.number() }),
      execute: async () => {
        throw { code: 'OBJECT_FAIL' };
      },
    });

    const wrapped = retry(unstable, { attempts: 1 });
    await expectPromiseToReject(wrapped({ value: 1 }), (error) =>
      expect(() => {
        throw error;
      }).toThrow(JSON.stringify({ code: 'OBJECT_FAIL' })),
    );
  });

  it('falls back when thrown objects are not serializable', async () => {
    const circular: any = { code: 'CYCLE' };
    circular.self = circular;
    const unstable = createTool({
      name: 'circular-throw',
      description: 'throws circular object',
      input: z.object({ value: z.number() }),
      execute: async () => {
        throw circular;
      },
    });

    const wrapped = retry(unstable, { attempts: 1 });
    await expectPromiseToReject(wrapped({ value: 1 }), (error) =>
      expect(() => {
        throw error;
      }).toThrow('[object Object]'),
    );
  });

  it('forwards stream options to retried executions', async () => {
    const observed: Array<{ stream?: boolean }> = [];
    const capture = createTool({
      name: 'retry-stream-capture',
      description: 'captures stream context',
      input: z.object({ value: z.number() }),
      async execute(_params, context) {
        observed.push(context.stream !== undefined ? { stream: context.stream } : {});
        return { value: 42 };
      },
    });

    const wrapped = retry(capture, { attempts: 1 });
    const result = await wrapped.executeWith({
      params: { value: 1 },
      stream: true,
    });

    expect(result.result).toMatchObject({ value: 42 });
    expect(observed).toEqual([{ stream: true }]);
  });
});
