import { describe, expect, it } from 'bun:test';

import { AsyncDefinitionLoadError, createLazyGenerate } from './index';
import type { GenerateFunction } from './types';

const response = { content: 'loaded', toolCalls: [] };

describe('createLazyGenerate', () => {
  it('loads a direct function once and caches it', async () => {
    let loads = 0;
    const generate: GenerateFunction = async () => response;
    const lazy = createLazyGenerate(async () => {
      loads += 1;
      return generate;
    });

    expect(lazy({} as never)).resolves.toEqual(response);
    expect(lazy({} as never)).resolves.toEqual(response);
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
    expect(Promise.all([first, second])).resolves.toEqual([response, response]);
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

    expect(lazy({} as never)).rejects.toMatchObject({
      name: 'AsyncDefinitionLoadError',
      code: 'LOAD_FAILED',
      cause,
    });
    expect(lazy({} as never)).resolves.toEqual(response);
    expect(loads).toBe(2);
  });

  it('rejects non-callable modules without caching the failure', async () => {
    let loads = 0;
    const lazy = createLazyGenerate(async () => {
      loads += 1;
      return loads === 1 ? ({ default: 42 } as never) : async () => response;
    });

    expect(lazy({} as never)).rejects.toMatchObject({
      name: 'AsyncDefinitionLoadError',
      code: 'INVALID_MODULE',
    });
    expect(lazy({} as never)).resolves.toEqual(response);
  });

  it('handles synchronous loader throws', async () => {
    const cause = new Error('sync');
    const lazy = createLazyGenerate(() => {
      throw cause;
    });

    expect(lazy({} as never)).rejects.toMatchObject({ code: 'LOAD_FAILED', cause });
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
    expect(lazy({} as never)).rejects.toMatchObject({ code: 'ABORTED', cause: 'before' });
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
    expect(pendingResult).rejects.toMatchObject({ code: 'ABORTED', cause: 'during' });
    expect(loads).toBe(1);
  });

  it('returns the exact GenerateFunction type', () => {
    const lazy: GenerateFunction = createLazyGenerate(async () => async () => response);
    expect(lazy).toBeFunction();
    expect(AsyncDefinitionLoadError).toBeDefined();
  });
});
