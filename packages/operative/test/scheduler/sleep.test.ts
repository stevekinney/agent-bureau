import { describe, expect, it } from 'bun:test';

import { sleep } from '../../src/scheduler/sleep';

const sleepRuntimeOverrideSymbol = Symbol.for('agent-bureau.operative.scheduler.sleep.runtime');

describe('sleep', () => {
  it('delegates to the Bun runtime when available', async () => {
    const originalRuntime = (globalThis as Record<symbol, unknown>)[sleepRuntimeOverrideSymbol];
    const requestedDelays: number[] = [];

    (globalThis as Record<symbol, unknown>)[sleepRuntimeOverrideSymbol] = {
      bunSleep: async (milliseconds: number) => {
        requestedDelays.push(milliseconds);
      },
    };

    try {
      await sleep(10);
      expect(requestedDelays).toEqual([10]);
    } finally {
      (globalThis as Record<symbol, unknown>)[sleepRuntimeOverrideSymbol] = originalRuntime;
    }
  });

  it('passes zero millisecond sleeps to the runtime', async () => {
    const originalRuntime = (globalThis as Record<symbol, unknown>)[sleepRuntimeOverrideSymbol];
    const requestedDelays: number[] = [];

    (globalThis as Record<symbol, unknown>)[sleepRuntimeOverrideSymbol] = {
      bunSleep: async (milliseconds: number) => {
        requestedDelays.push(milliseconds);
      },
    };

    try {
      await sleep(0);
      expect(requestedDelays).toEqual([0]);
    } finally {
      (globalThis as Record<symbol, unknown>)[sleepRuntimeOverrideSymbol] = originalRuntime;
    }
  });

  it('falls back to the standard timer runtime when the Bun runtime is unavailable', async () => {
    const originalRuntime = (globalThis as Record<symbol, unknown>)[sleepRuntimeOverrideSymbol];
    let usedStandardTimer = false;

    (globalThis as Record<symbol, unknown>)[sleepRuntimeOverrideSymbol] = {
      bunSleep: undefined,
      ['set' + 'TimeoutFunction']: (handler: TimerHandler, milliseconds?: number) => {
        usedStandardTimer = true;
        expect(milliseconds).toBe(5);
        (handler as () => void)();
        return 1 as never;
      },
    };

    try {
      await sleep(5);
      expect(usedStandardTimer).toBe(true);
    } finally {
      (globalThis as Record<symbol, unknown>)[sleepRuntimeOverrideSymbol] = originalRuntime;
    }
  });
});
