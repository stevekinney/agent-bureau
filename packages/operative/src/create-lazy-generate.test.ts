import { describe, expect, it } from 'bun:test';

import { AbortAgentRunError, AsyncDefinitionLoadError, createLazyGenerate } from './index';
import type { GenerateContext, GenerateFunction, GenerateResponse } from './types';

const response = { content: 'loaded', toolCalls: [] } satisfies GenerateResponse;

function createContext(signal?: AbortSignal): GenerateContext {
  return {
    conversation: {} as GenerateContext['conversation'],
    step: 0,
    signal,
    toolbox: {} as GenerateContext['toolbox'],
  };
}

async function expectResolves<T>(promise: Promise<T>, expected: Awaited<T>): Promise<void> {
  expect(await promise).toEqual(expected);
}

async function expectRejects(
  promise: Promise<unknown>,
  expected: Record<string, unknown>,
): Promise<unknown> {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    expect(error).toMatchObject(expected);
    return error;
  }
}

describe('createLazyGenerate', () => {
  it('loads a direct function once and caches the successful result', async () => {
    let loads = 0;
    const generate: GenerateFunction = async () => response;
    const lazy = createLazyGenerate(() => {
      loads += 1;
      return generate;
    });

    await expectResolves(lazy(createContext()), response);
    await expectResolves(lazy(createContext()), response);
    expect(loads).toBe(1);
  });

  it('loads a promise-like function once', async () => {
    let loads = 0;
    const generate: GenerateFunction = async () => response;
    const lazy = createLazyGenerate(() => {
      loads += 1;
      return Promise.resolve(generate);
    });

    await expectResolves(lazy(createContext()), response);
    await expectResolves(lazy(createContext()), response);
    expect(loads).toBe(1);
  });

  it('shares the exact pending load across concurrent calls', async () => {
    let loads = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const lazy = createLazyGenerate(async () => {
      loads += 1;
      await pending;
      return async () => response;
    });

    const first = lazy(createContext());
    const second = lazy(createContext());
    release();

    await expectResolves(Promise.all([first, second]), [response, response]);
    expect(loads).toBe(1);
  });

  it('retries after a failed load and preserves its cause', async () => {
    const cause = new Error('network');
    let loads = 0;
    const lazy = createLazyGenerate(
      async () => {
        loads += 1;
        if (loads === 1) throw cause;
        return async () => response;
      },
      { label: 'retrying-provider' },
    );

    await expectRejects(lazy(createContext()), {
      name: 'AsyncDefinitionLoadError',
      kind: 'load',
      code: 'LOAD_FAILED',
      cause,
      message: 'Failed to load lazy generate function "retrying-provider"',
    });
    await expectResolves(lazy(createContext()), response);
    expect(loads).toBe(2);
  });

  it('handles synchronous loader throws the same as asynchronous load failures', async () => {
    const cause = new Error('sync');
    const lazy = createLazyGenerate(() => {
      throw cause;
    });

    await expectRejects(lazy(createContext()), {
      name: 'AsyncDefinitionLoadError',
      kind: 'load',
      code: 'LOAD_FAILED',
      cause,
    });
  });

  it('rejects non-callable loader results without caching the failure', async () => {
    let loads = 0;
    const lazy = createLazyGenerate(async () => {
      loads += 1;
      return loads === 1 ? (42 as never) : async () => response;
    });

    await expectRejects(lazy(createContext()), {
      name: 'AsyncDefinitionLoadError',
      kind: 'load',
      code: 'INVALID_EXPORT',
      cause: 42,
    });
    await expectResolves(lazy(createContext()), response);
    expect(loads).toBe(2);
  });

  it('throws AbortAgentRunError for an already-aborted invocation without starting the load', async () => {
    const controller = new AbortController();
    controller.abort('before');
    let loads = 0;
    const lazy = createLazyGenerate(async () => {
      loads += 1;
      return async () => response;
    });

    await expectRejects(lazy(createContext(controller.signal)), {
      name: 'AbortAgentRunError',
      kind: 'abort',
      cause: 'before',
    });
    expect(loads).toBe(0);
  });

  it('aborts one loading invocation without poisoning another caller or the cache', async () => {
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

    const firstResult = lazy(createContext(first.signal));
    const secondResult = lazy(createContext(second.signal));
    first.abort('first caller');
    release();

    await expectRejects(firstResult, {
      name: 'AbortAgentRunError',
      kind: 'abort',
      cause: 'first caller',
    });
    await expectResolves(secondResult, response);
    await expectResolves(lazy(createContext()), response);
    expect(loads).toBe(1);
  });

  it('lets an aborted loading invocation reject while the module still finishes and caches', async () => {
    const controller = new AbortController();
    let loads = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const lazy = createLazyGenerate(async () => {
      loads += 1;
      await pending;
      return async () => response;
    });

    const result = lazy(createContext(controller.signal));
    controller.abort('during import');
    release();

    await expectRejects(result, {
      name: 'AbortAgentRunError',
      kind: 'abort',
      cause: 'during import',
    });
    await expectResolves(lazy(createContext()), response);
    expect(loads).toBe(1);
  });

  it('rechecks a signal that fires while subscribing to a pending load', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const lazy = createLazyGenerate(async () => {
      await pending;
      return async () => response;
    });

    const signal = controller.signal;
    const addEventListener = signal.addEventListener.bind(signal);
    Object.defineProperty(signal, 'addEventListener', {
      value: (...args: Parameters<AbortSignal['addEventListener']>) => {
        controller.abort('subscribed');
        addEventListener(...args);
      },
    });

    const result = lazy(createContext(signal));
    release();

    await expectRejects(result, {
      name: 'AbortAgentRunError',
      kind: 'abort',
      cause: 'subscribed',
    });
  });

  it('forwards a shared load failure to active callers', async () => {
    const controller = new AbortController();
    const lazy = createLazyGenerate(async () => {
      throw new Error('shared failure');
    });

    await expectRejects(lazy(createContext(controller.signal)), {
      name: 'AsyncDefinitionLoadError',
      kind: 'load',
      code: 'LOAD_FAILED',
    });
  });

  it('returns an ordinary GenerateFunction', () => {
    const lazy: GenerateFunction = createLazyGenerate(async () => async () => response);
    expect(lazy).toBeFunction();
    expect('preload' in lazy).toBe(false);
    expect('reset' in lazy).toBe(false);
    expect(AsyncDefinitionLoadError).toBeDefined();
    expect(AbortAgentRunError).toBeDefined();
  });
});
