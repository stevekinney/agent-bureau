import { describe, expect, it } from 'bun:test';

import { HookRegistry } from '../../src/hooks/hook-registry';
import type { HookErrorHandler } from '../../src/hooks/types';

type TestHooks = {
  process: (value: string) => string;
};

describe('HookRegistry error handling', () => {
  it('propagates the error when no error handler is configured', async () => {
    const registry = new HookRegistry<TestHooks>();

    registry.on('process', () => {
      throw new Error('handler failed');
    });

    await expect(registry.run('process', 'input')).rejects.toThrow('handler failed');
  });

  it('skips the handler and runs the next when per-hook onError returns continue', async () => {
    const registry = new HookRegistry<TestHooks>();

    registry.on(
      'process',
      () => {
        throw new Error('handler failed');
      },
      {
        priority: 10,
        onError: () => 'continue',
      },
    );

    registry.on(
      'process',
      (value) => {
        return value + '-recovered';
      },
      { priority: 5 },
    );

    const result = await registry.run('process', 'input');

    expect(result).toBe('input-recovered');
  });

  it('re-throws the error when per-hook onError returns abort', async () => {
    const registry = new HookRegistry<TestHooks>();

    registry.on(
      'process',
      () => {
        throw new Error('critical failure');
      },
      {
        priority: 10,
        onError: () => 'abort',
      },
    );

    registry.on(
      'process',
      (value) => {
        return value + '-should-not-run';
      },
      { priority: 5 },
    );

    await expect(registry.run('process', 'input')).rejects.toThrow('critical failure');
  });

  it('uses registry-level onError as fallback when per-hook onError is not set', async () => {
    const registry = new HookRegistry<TestHooks>({
      onError: () => 'continue',
    });

    registry.on(
      'process',
      () => {
        throw new Error('handler failed');
      },
      { priority: 10 },
    );

    registry.on(
      'process',
      (value) => {
        return value + '-fallback';
      },
      { priority: 5 },
    );

    const result = await registry.run('process', 'input');

    expect(result).toBe('input-fallback');
  });

  it('per-hook onError overrides the registry-level onError', async () => {
    const registry = new HookRegistry<TestHooks>({
      onError: () => 'continue',
    });

    registry.on(
      'process',
      () => {
        throw new Error('critical failure');
      },
      {
        priority: 10,
        onError: () => 'abort',
      },
    );

    await expect(registry.run('process', 'input')).rejects.toThrow('critical failure');
  });

  it('error handler receives correct hookName and handlerIndex', async () => {
    const receivedContexts: Array<{ hookName: string; handlerIndex: number }> = [];

    const onError: HookErrorHandler = (_error, context) => {
      receivedContexts.push(context);
      return 'continue';
    };

    const registry = new HookRegistry<TestHooks>({ onError });

    registry.on(
      'process',
      (value) => {
        return value + '-ok';
      },
      { priority: 30 },
    );

    registry.on(
      'process',
      () => {
        throw new Error('first error');
      },
      { priority: 20 },
    );

    registry.on(
      'process',
      () => {
        throw new Error('second error');
      },
      { priority: 10 },
    );

    await registry.run('process', 'input');

    expect(receivedContexts).toEqual([
      { hookName: 'process', handlerIndex: 1 },
      { hookName: 'process', handlerIndex: 2 },
    ]);
  });

  it('handles async handler rejection with the same error handling', async () => {
    const registry = new HookRegistry<TestHooks>();

    registry.on(
      'process',
      async () => {
        throw new Error('async failure');
      },
      {
        priority: 10,
        onError: () => 'continue',
      },
    );

    registry.on(
      'process',
      (value) => {
        return value + '-after-async';
      },
      { priority: 5 },
    );

    const result = await registry.run('process', 'input');

    expect(result).toBe('input-after-async');
  });
});
