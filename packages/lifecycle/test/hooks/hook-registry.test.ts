import { describe, expect, it } from 'bun:test';

import { HookRegistry } from '../../src/hooks/hook-registry';

type TestHooks = {
  beforeRun: (context: { runId: string }) => void;
  afterRun: (context: { runId: string; result: string }) => void;
  transform: (value: string) => string;
};

describe('HookRegistry', () => {
  describe('on', () => {
    it('returns a dispose function that removes the handler', async () => {
      const registry = new HookRegistry<TestHooks>();
      const calls: string[] = [];

      const dispose = registry.on('beforeRun', (context) => {
        calls.push(context.runId);
      });

      await registry.run('beforeRun', { runId: 'run-1' });
      expect(calls).toEqual(['run-1']);

      dispose();

      await registry.run('beforeRun', { runId: 'run-2' });
      expect(calls).toEqual(['run-1']);
    });

    it('orders handlers by priority (higher priority runs first)', async () => {
      const registry = new HookRegistry<TestHooks>();
      const order: number[] = [];

      registry.on(
        'beforeRun',
        () => {
          order.push(1);
        },
        { priority: 1 },
      );
      registry.on(
        'beforeRun',
        () => {
          order.push(10);
        },
        { priority: 10 },
      );
      registry.on(
        'beforeRun',
        () => {
          order.push(5);
        },
        { priority: 5 },
      );

      await registry.run('beforeRun', { runId: 'run-1' });

      expect(order).toEqual([10, 5, 1]);
    });
  });

  describe('has', () => {
    it('returns true when handlers exist for a hook', () => {
      const registry = new HookRegistry<TestHooks>();
      registry.on('beforeRun', () => {});

      expect(registry.has('beforeRun')).toBe(true);
    });

    it('returns false when no handlers exist for a hook', () => {
      const registry = new HookRegistry<TestHooks>();

      expect(registry.has('beforeRun')).toBe(false);
    });

    it('returns false after the only handler is disposed', () => {
      const registry = new HookRegistry<TestHooks>();
      const dispose = registry.on('beforeRun', () => {});

      dispose();

      expect(registry.has('beforeRun')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes only the specified hook handlers when called with a hook name', async () => {
      const registry = new HookRegistry<TestHooks>();
      const calls: string[] = [];

      registry.on('beforeRun', () => {
        calls.push('beforeRun');
      });
      registry.on('afterRun', () => {
        calls.push('afterRun');
      });

      registry.clear('beforeRun');

      expect(registry.has('beforeRun')).toBe(false);
      expect(registry.has('afterRun')).toBe(true);

      await registry.run('beforeRun', { runId: 'run-1' });
      await registry.run('afterRun', { runId: 'run-1', result: 'done' });

      expect(calls).toEqual(['afterRun']);
    });

    it('removes all handlers when called without arguments', () => {
      const registry = new HookRegistry<TestHooks>();

      registry.on('beforeRun', () => {});
      registry.on('afterRun', () => {});
      registry.on('transform', (value) => value);

      registry.clear();

      expect(registry.has('beforeRun')).toBe(false);
      expect(registry.has('afterRun')).toBe(false);
      expect(registry.has('transform')).toBe(false);
    });
  });

  describe('run', () => {
    it('returns undefined when no handlers are registered', async () => {
      const registry = new HookRegistry<TestHooks>();

      const result = await registry.run('beforeRun', { runId: 'run-1' });

      expect(result).toBeUndefined();
    });
  });
});
