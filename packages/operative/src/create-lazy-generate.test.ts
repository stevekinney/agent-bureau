import { describe, expect, it } from 'bun:test';

import { AsyncDefinitionLoadError, createLazyGenerate } from './index';
import type { GenerateFunction } from './types';

const response = { content: 'loaded', toolCalls: [] };

async function expectResolves<T>(promise: Promise<T>, expected: Awaited<T>): Promise<void> {
  expect(await promise).toEqual(expected);
}

async function expectRejects(
  promise: Promise<unknown>,
  expected: Record<string, unknown>,
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    expect(error).toMatchObject(expected);
  }
}

describe('createLazyGenerate', () => {
  it('loads a direct function once and caches it', async () => {
    let loads = 0;
    const generate: GenerateFunction = async () => response;
    const lazy = createLazyGenerate(async () => {
      loads += 1;
      return generate;
    });

    await expectResolves(lazy({} as never), response);
    await expectResolves(lazy({} as never), response);
    expect(loads).toBe(1);
  });

  it('shares concurrent loads', async () => {
    let loads = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const lazy = createLazyGenerate(async () => {
      loads += 1;
      await pending;
      return { default: async () => response };
    });

    const first = lazy({} as never);
    const second = lazy({} as never);
    release();
    await expectResolves(Promise.all([first, second]), [response, response]);
    expect(loads).toBe(1);
  });

  it('retries after a failed load and preserves its cause', async () => {
    const cause = new Error('network');
    let loads = 0;
    const lazy = createLazyGenerate(async () => {
      loads += 1;
      if (loads === 1) throw cause;
      return async () => response;
    });

    await expectRejects(lazy({} as never), {
      name: 'AsyncDefinitionLoadError',
      code: 'LOAD_FAILED',
      cause,
    });
    await expectResolves(lazy({} as never), response);
    expect(loads).toBe(2);
  });

  it('rejects non-callable modules without caching the failure', async () => {
    let loads = 0;
    const lazy = createLazyGenerate(async () => {
      loads += 1;
      return loads === 1 ? ({ default: 42 } as never) : async () => response;
    });

    await expectRejects(lazy({} as never), {
      name: 'AsyncDefinitionLoadError',
      code: 'INVALID_MODULE',
    });
    await expectResolves(lazy({} as never), response);
    expect(loads).toBe(2);
  });

  it('handles synchronous loader throws', async () => {
    const cause = new Error('sync');
    const lazy = createLazyGenerate(() => {
      throw cause;
    });

    await expectRejects(lazy({} as never), { code: 'LOAD_FAILED', cause });
  });

  it('honors pre-aborted and during-load signals', async () => {
    const pre = new AbortController();
    pre.abort('before');
    let loads = 0;
    const lazy = createLazyGenerate(
      async () => {
        loads += 1;
        await Promise.resolve();
        return async () => response;
      },
      { signal: pre.signal },
    );
    await expectRejects(lazy({} as never), { code: 'ABORTED', cause: 'before' });
    expect(loads).toBe(0);

    const during = new AbortController();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const retryable = createLazyGenerate(
      async () => {
        loads += 1;
        await pending;
        return async () => response;
      },
      { signal: during.signal },
    );
    const pendingResult = retryable({} as never);
    during.abort('during');
    release();
    await expectRejects(pendingResult, { code: 'ABORTED', cause: 'during' });
    expect(loads).toBe(1);
  });

  it('aborts one concurrent caller without poisoning another caller', async () => {
    const first = new AbortController();
    const second = new AbortController();
    let loads = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const lazy = createLazyGenerate(async () => {
      loads += 1;
      await pending;
      return async () => response;
    });

    const firstResult = lazy({ signal: first.signal } as never);
    const secondResult = lazy({ signal: second.signal } as never);
    first.abort('first caller');
    release();
    await expectRejects(firstResult, { code: 'ABORTED', cause: 'first caller' });
    await expectResolves(secondResult, response);
    expect(loads).toBe(1);
  });

  it('forwards a shared load failure to an active caller', async () => {
    const lazy = createLazyGenerate(async () => {
      throw new Error('shared failure');
    });
    const caller = new AbortController();
    await expectRejects(lazy({ signal: caller.signal } as never), { code: 'LOAD_FAILED' });
  });

  it('returns the exact GenerateFunction type', () => {
    const lazy: GenerateFunction = createLazyGenerate(async () => async () => response);
    expect(lazy).toBeFunction();
    expect(AsyncDefinitionLoadError).toBeDefined();
  });
});
