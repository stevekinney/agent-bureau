import { describe, expect, it } from 'bun:test';

import {
  AbortAgentRunError,
  AgentRunError,
  AsyncDefinitionLoadError,
  createLazyGenerate,
} from './index';
import { readBackendDescriptors } from './providers/backend-descriptor-attachment';
import { createModelCatalog } from './providers/model-catalog';
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

    const error = await expectRejects(lazy(createContext()), {
      name: 'AsyncDefinitionLoadError',
      kind: 'load',
      code: 'LOAD_FAILED',
      cause,
      message: 'Failed to load lazy generate function "retrying-provider"',
    });
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toBeInstanceOf(AsyncDefinitionLoadError);
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

    const error = await expectRejects(lazy(createContext(controller.signal)), {
      name: 'AbortAgentRunError',
      kind: 'abort',
      code: 'ABORTED',
      cause: 'before',
    });
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toBeInstanceOf(AbortAgentRunError);
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

  it('delegates an abort that fires after the shared load settles to the loaded generate function', async () => {
    const controller = new AbortController();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reasons: unknown[] = [];
    const lazy = createLazyGenerate(async () => {
      await gate;
      return async (context) => {
        reasons.push(context.signal?.reason);
        if (context.signal === undefined) controller.abort('late');
        return response;
      };
    });

    const first = lazy(createContext());
    const second = lazy(createContext(controller.signal));
    release();

    await expectResolves(first, response);
    await expectResolves(second, response);
    expect(reasons).toEqual([undefined, 'late']);
  });

  it('delegates an already-aborted signal to a generate function that has loaded', async () => {
    const seen: unknown[] = [];
    const lazy = createLazyGenerate(async () => async (context) => {
      seen.push(context.signal?.reason);
      return response;
    });
    await lazy(createContext());

    const controller = new AbortController();
    controller.abort('late');
    await expectResolves(lazy(createContext(controller.signal)), response);
    expect(seen).toEqual([undefined, 'late']);
  });

  it('does not start a duplicate load when the loader reenters the wrapper synchronously', async () => {
    let loads = 0;
    let inner: Promise<GenerateResponse> | undefined;
    const lazy: GenerateFunction = createLazyGenerate(() => {
      loads += 1;
      if (loads === 1) inner = lazy(createContext());
      return async () => response;
    });

    await expectResolves(lazy(createContext()), response);
    await expectResolves(inner as Promise<GenerateResponse>, response);
    expect(loads).toBe(1);
  });

  it('releases aborted callers when the loader never settles', async () => {
    const lazy = createLazyGenerate(() => new Promise<GenerateFunction>(() => undefined));
    const refs: WeakRef<AbortSignal>[] = [];

    // Callers are built in a separate frame so no stack or register slot of this test still
    // points at their signals, contexts, or controllers when the collector runs.
    const startAbortedCallers = async (count: number): Promise<void> => {
      const outcomes: Promise<unknown>[] = [];
      for (let index = 0; index < count; index += 1) {
        const controller = new AbortController();
        refs.push(new WeakRef(controller.signal));
        outcomes.push(
          lazy(createContext(controller.signal)).then(
            () => 'resolved',
            (error: unknown) => error,
          ),
        );
        controller.abort(`caller ${index}`);
      }
      for (const outcome of await Promise.all(outcomes)) {
        expect(outcome).toBeInstanceOf(AbortAgentRunError);
      }
    };
    await startAbortedCallers(5);

    // Yield macrotasks so the frames above are fully unwound before collecting.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      Bun.gc(true);
    }
    expect(refs.map((ref) => ref.deref())).toEqual(refs.map(() => undefined));
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

describe('createLazyGenerate — descriptors (AB-64 AC2, AB-245)', () => {
  const FIXED_NOW = () => '2026-09-02T12:00:00.000Z';

  function anthropicDescriptor() {
    const descriptor = createModelCatalog({ now: FIXED_NOW }).descriptors.find(
      (row) => row.provider === 'anthropic',
    );
    if (!descriptor)
      throw new Error('expected at least one anthropic descriptor in the seed catalog');
    return descriptor;
  }

  it('returns a frozen empty descriptor list when none are supplied', () => {
    const lazy = createLazyGenerate(async () => async () => response);
    expect(readBackendDescriptors(lazy)).toEqual([]);
  });

  it('reports the supplied descriptors without invoking the loader', () => {
    const descriptor = anthropicDescriptor();
    const loader = (): never => {
      throw new Error('the loader must not run for a capability read');
    };
    const lazy = createLazyGenerate(loader, { descriptors: [descriptor] });

    expect(readBackendDescriptors(lazy)).toEqual([descriptor]);
  });

  it('attaches descriptors at construction time, before the wrapper is ever called', () => {
    const descriptor = anthropicDescriptor();
    let loaderCalls = 0;
    const lazy = createLazyGenerate(
      () => {
        loaderCalls += 1;
        return Promise.resolve(async () => response);
      },
      { descriptors: [descriptor] },
    );

    expect(readBackendDescriptors(lazy)).toEqual([descriptor]);
    expect(loaderCalls).toBe(0);
  });
});
