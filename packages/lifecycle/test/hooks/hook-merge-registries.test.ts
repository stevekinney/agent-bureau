import { describe, expect, it } from 'bun:test';

import { HookRegistry } from '../../src/hooks/hook-registry';
import { mergeHookRegistries } from '../../src/hooks/merge-hook-registries';

type TestHooks = {
  transform: (value: string) => string;
  notify: (message: string) => void;
};

describe('mergeHookRegistries', () => {
  it('returns an empty registry when merging zero registries', async () => {
    const merged = mergeHookRegistries<TestHooks>();

    expect(merged.has('transform')).toBe(false);

    const result = await merged.run('transform', 'input');
    expect(result).toBeUndefined();
  });

  it('returns an equivalent registry when merging one registry', async () => {
    const original = new HookRegistry<TestHooks>();
    original.on('transform', (value) => value + '-only');

    const merged = mergeHookRegistries(original);

    const result = await merged.run('transform', 'input');
    expect(result).toBe('input-only');
  });

  it('gives handlers from earlier registries a +1000 priority offset', async () => {
    const first = new HookRegistry<TestHooks>();
    const second = new HookRegistry<TestHooks>();

    first.on(
      'transform',
      (value) => {
        return value + '-first';
      },
      { priority: 0 },
    );

    second.on(
      'transform',
      (value) => {
        return value + '-second';
      },
      { priority: 0 },
    );

    const merged = mergeHookRegistries(first, second);

    // first registry gets +1000 offset, so its handler (effective priority 1000)
    // runs before second registry's handler (effective priority 0)
    const result = await merged.run('transform', 'start');
    expect(result).toBe('start-first-second');
  });

  it('interleaves handlers from both registries correctly by final priority', async () => {
    const first = new HookRegistry<TestHooks>();
    const second = new HookRegistry<TestHooks>();
    const order: string[] = [];

    first.on(
      'notify',
      () => {
        order.push('first-low');
      },
      { priority: 0 },
    );

    second.on(
      'notify',
      () => {
        order.push('second-high');
      },
      { priority: 1500 },
    );

    first.on(
      'notify',
      () => {
        order.push('first-high');
      },
      { priority: 500 },
    );

    second.on(
      'notify',
      () => {
        order.push('second-low');
      },
      { priority: 0 },
    );

    const merged = mergeHookRegistries(first, second);

    // first-high: 500 + 1000 = 1500
    // second-high: 1500 + 0 = 1500 (same priority, but first-high from earlier registry)
    // first-low: 0 + 1000 = 1000
    // second-low: 0 + 0 = 0
    // Execution order by descending priority: first-high(1500), second-high(1500), first-low(1000), second-low(0)
    await merged.run('notify', 'test');

    expect(order).toEqual(['first-high', 'second-high', 'first-low', 'second-low']);
  });

  it('skips undefined registries in the input', async () => {
    const registry = new HookRegistry<TestHooks>();
    registry.on('transform', (value) => value + '-present');

    const merged = mergeHookRegistries(undefined, registry, undefined);

    // The non-undefined registry is at index 1, which gets +1000 * (count - 1 - index) offset
    // But actually, undefined registries should be filtered out first
    const result = await merged.run('transform', 'input');
    expect(result).toBe('input-present');
  });
});
