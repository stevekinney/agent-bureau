import { describe, expect, it } from 'bun:test';

import {
  composeHooks,
  everyNSteps,
  onlyOnStep,
  runOnce,
  withTimeout,
} from '../src/hooks/composition';

describe('onlyOnStep', () => {
  it('runs the hook on step 0 when configured for step 0', async () => {
    const calls: number[] = [];
    const hook = onlyOnStep(0, async (context: { step: number }) => {
      calls.push(context.step);
    });

    await hook({ step: 0 });
    await hook({ step: 1 });
    await hook({ step: 2 });
    await hook({ step: 3 });

    expect(calls).toEqual([0]);
  });

  it('runs the hook only on step 3 when configured for step 3', async () => {
    const calls: number[] = [];
    const hook = onlyOnStep(3, async (context: { step: number }) => {
      calls.push(context.step);
    });

    await hook({ step: 0 });
    await hook({ step: 1 });
    await hook({ step: 2 });
    await hook({ step: 3 });
    await hook({ step: 4 });

    expect(calls).toEqual([3]);
  });

  it('returns undefined when the step does not match', async () => {
    const hook = onlyOnStep(5, async (_context: { step: number }) => 'matched');

    const result = await hook({ step: 0 });
    expect(result).toBeUndefined();
  });

  it('returns the hook result when the step matches', async () => {
    const hook = onlyOnStep(2, async (_context: { step: number }) => 'matched');

    const result = await hook({ step: 2 });
    expect(result).toBe('matched');
  });
});

describe('runOnce', () => {
  it('runs the hook on first call', async () => {
    const calls: number[] = [];
    const hook = runOnce(async (context: { step: number }) => {
      calls.push(context.step);
      return 'result';
    });

    const first = await hook({ step: 0 });
    expect(first).toBe('result');
    expect(calls).toEqual([0]);
  });

  it('returns undefined on second and third calls', async () => {
    const calls: number[] = [];
    const hook = runOnce(async (context: { step: number }) => {
      calls.push(context.step);
      return 'result';
    });

    await hook({ step: 0 });
    const second = await hook({ step: 1 });
    const third = await hook({ step: 2 });

    expect(second).toBeUndefined();
    expect(third).toBeUndefined();
    expect(calls).toEqual([0]);
  });

  it('reset() allows the hook to fire again', async () => {
    const calls: number[] = [];
    const hook = runOnce(async (context: { step: number }) => {
      calls.push(context.step);
      return 'result';
    });

    // First invocation fires
    const first = await hook({ step: 0 });
    expect(first).toBe('result');
    expect(calls).toEqual([0]);

    // Blocked before reset
    const blocked = await hook({ step: 1 });
    expect(blocked).toBeUndefined();
    expect(calls).toEqual([0]);

    // Reset and fire again
    hook.reset();
    const afterReset = await hook({ step: 2 });
    expect(afterReset).toBe('result');
    expect(calls).toEqual([0, 2]);

    // Blocked again after second fire
    const blockedAgain = await hook({ step: 3 });
    expect(blockedAgain).toBeUndefined();
    expect(calls).toEqual([0, 2]);
  });
});

describe('everyNSteps', () => {
  it('runs on steps 0, 3, 6 when n is 3', async () => {
    const calls: number[] = [];
    const hook = everyNSteps(3, async (context: { step: number }) => {
      calls.push(context.step);
    });

    for (let i = 0; i < 7; i++) {
      await hook({ step: i });
    }

    expect(calls).toEqual([0, 3, 6]);
  });

  it('skips steps 1, 2, 4, 5 when n is 3', async () => {
    const calls: number[] = [];
    const hook = everyNSteps(3, async (context: { step: number }) => {
      calls.push(context.step);
    });

    for (let i = 0; i < 7; i++) {
      await hook({ step: i });
    }

    expect(calls).not.toContain(1);
    expect(calls).not.toContain(2);
    expect(calls).not.toContain(4);
    expect(calls).not.toContain(5);
  });

  it('returns undefined when step does not match', async () => {
    const hook = everyNSteps(3, async (_context: { step: number }) => 'result');

    const result = await hook({ step: 1 });
    expect(result).toBeUndefined();
  });

  it('returns the hook result when step matches', async () => {
    const hook = everyNSteps(3, async (_context: { step: number }) => 'result');

    const result = await hook({ step: 6 });
    expect(result).toBe('result');
  });
});

describe('withTimeout', () => {
  it('returns undefined if hook takes longer than timeout with ignore mode', async () => {
    const hook = withTimeout(
      50,
      async (_context: { step: number }) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 'slow result';
      },
      'ignore',
    );

    const result = await hook({ step: 0 });
    expect(result).toBeUndefined();
  });

  it('throws if hook takes longer than timeout with error mode', async () => {
    const hook = withTimeout(
      50,
      async (_context: { step: number }) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 'slow result';
      },
      'error',
    );

    await expect(hook({ step: 0 })).rejects.toThrow('timed out');
  });

  it('defaults to ignore when onTimeout is not specified', async () => {
    const hook = withTimeout(50, async (_context: { step: number }) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return 'slow result';
    });

    const result = await hook({ step: 0 });
    expect(result).toBeUndefined();
  });

  it('returns the hook result when it finishes in time', async () => {
    const hook = withTimeout(
      200,
      async (_context: { step: number }) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'fast result';
      },
      'error',
    );

    const result = await hook({ step: 0 });
    expect(result).toBe('fast result');
  });
});

describe('composeHooks', () => {
  it('runs all void hooks', async () => {
    const calls: string[] = [];

    const h1 = async () => {
      calls.push('h1');
    };
    const h2 = async () => {
      calls.push('h2');
    };

    const composed = composeHooks(h1, h2);
    await composed();

    expect(calls).toContain('h1');
    expect(calls).toContain('h2');
  });

  it('chains waterfall hooks where h1 returns modified value fed to h2', async () => {
    const h1 = async (context: { value: number }) => {
      return { value: context.value + 1 };
    };
    const h2 = async (context: { value: number }) => {
      return { value: context.value * 2 };
    };

    const composed = composeHooks(h1, h2);
    const result = await composed({ value: 5 });

    // h1: 5+1=6, h2: 6*2=12
    expect(result).toEqual({ value: 12 });
  });

  it('skips void returns in waterfall and passes original to next', async () => {
    const h1 = async (_context: { value: number }) => {
      return undefined;
    };
    const h2 = async (context: { value: number }) => {
      return { value: context.value * 3 };
    };

    const composed = composeHooks(h1, h2);
    const result = await composed({ value: 4 });

    // h1 returns void, h2 gets original: 4*3=12
    expect(result).toEqual({ value: 12 });
  });

  it('handles a single hook', async () => {
    const h1 = async (context: { value: number }) => {
      return { value: context.value + 10 };
    };

    const composed = composeHooks(h1);
    const result = await composed({ value: 1 });

    expect(result).toEqual({ value: 11 });
  });

  it('handles zero hooks gracefully', async () => {
    const composed = composeHooks<(x: number) => Promise<void>>();
    // Should not throw
    await composed(42);
  });
});
