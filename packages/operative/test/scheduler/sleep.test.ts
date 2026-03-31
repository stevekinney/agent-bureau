import { describe, expect, it } from 'bun:test';

import { sleep } from '../../src/scheduler/sleep';

const sleepRuntimeOverrideSymbol = Symbol.for('agent-bureau.operative.scheduler.sleep.runtime');

describe('sleep', () => {
  it('resolves after approximately the specified duration', async () => {
    const start = performance.now();
    await sleep(10);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(9); // Small tolerance for timer precision
  });

  it('resolves on the next tick when given 0', async () => {
    const start = performance.now();
    await sleep(0);
    const elapsed = performance.now() - start;

    // Should resolve nearly immediately (within a few ms)
    expect(elapsed).toBeLessThan(50);
  });

  it('falls back to setTimeout when Bun.sleep is unavailable', async () => {
    const originalRuntime = (globalThis as Record<symbol, unknown>)[sleepRuntimeOverrideSymbol];
    let usedSetTimeout = false;

    (globalThis as Record<symbol, unknown>)[sleepRuntimeOverrideSymbol] = {
      bunSleep: undefined,
      setTimeoutFunction: (handler: TimerHandler) => {
        usedSetTimeout = true;
        return setTimeout(handler, 0);
      },
    };

    try {
      await sleep(5);
      expect(usedSetTimeout).toBe(true);
    } finally {
      (globalThis as Record<symbol, unknown>)[sleepRuntimeOverrideSymbol] = originalRuntime;
    }
  });
});
