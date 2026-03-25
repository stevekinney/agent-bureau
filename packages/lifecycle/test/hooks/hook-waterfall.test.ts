import { describe, expect, it } from 'bun:test';

import { HookRegistry } from '../../src/hooks/hook-registry';

type TransformHooks = {
  transform: (value: string) => string;
  multiply: (value: number) => number;
  process: (value: { count: number }) => { count: number };
};

describe('HookRegistry waterfall execution', () => {
  it('single handler receives correct arguments and returns value', async () => {
    const registry = new HookRegistry<TransformHooks>();

    registry.on('transform', (value) => {
      return value.toUpperCase();
    });

    const result = await registry.run('transform', 'hello');

    expect(result).toBe('HELLO');
  });

  it('two handlers chain: second receives first output as first argument', async () => {
    const registry = new HookRegistry<TransformHooks>();

    registry.on(
      'transform',
      (value) => {
        return value + '-first';
      },
      { priority: 10 },
    );

    registry.on(
      'transform',
      (value) => {
        return value + '-second';
      },
      { priority: 5 },
    );

    const result = await registry.run('transform', 'start');

    expect(result).toBe('start-first-second');
  });

  it('three handlers with different priorities execute in correct order', async () => {
    const registry = new HookRegistry<TransformHooks>();

    registry.on(
      'multiply',
      (value) => {
        return value + 1;
      },
      { priority: 5 },
    );

    registry.on(
      'multiply',
      (value) => {
        return value * 2;
      },
      { priority: 10 },
    );

    registry.on(
      'multiply',
      (value) => {
        return value * 3;
      },
      { priority: 1 },
    );

    // Priority order: 10 (x2), 5 (+1), 1 (x3)
    // Start: 4 -> *2 = 8 -> +1 = 9 -> *3 = 27
    const result = await registry.run('multiply', 4);

    expect(result).toBe(27);
  });

  it('handler returning void/undefined does not modify the waterfall value', async () => {
    const registry = new HookRegistry<TransformHooks>();

    registry.on(
      'transform',
      (value) => {
        return value + '-modified';
      },
      { priority: 10 },
    );

    registry.on(
      'transform',
      (_value) => {
        // Intentionally returns void
      },
      { priority: 5 },
    );

    registry.on(
      'transform',
      (value) => {
        return value + '-final';
      },
      { priority: 1 },
    );

    const result = await registry.run('transform', 'start');

    // void handler should not modify the waterfall value
    expect(result).toBe('start-modified-final');
  });

  it('multiple handlers modifying same value: last writer wins (lowest priority)', async () => {
    const registry = new HookRegistry<TransformHooks>();

    registry.on(
      'process',
      (value) => {
        return { count: value.count + 10 };
      },
      { priority: 100 },
    );

    registry.on(
      'process',
      (value) => {
        return { count: value.count + 1 };
      },
      { priority: 1 },
    );

    // Priority 100 runs first: {count: 0} -> {count: 10}
    // Priority 1 runs last: {count: 10} -> {count: 11}
    const result = await registry.run('process', { count: 0 });

    expect(result).toEqual({ count: 11 });
  });
});
