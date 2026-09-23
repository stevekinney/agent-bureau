import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import {
  createSessionHandleFixture,
  createTestRunOptions,
  errorMessage,
} from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

const failingGenerate: GenerateFunction = async () => {
  throw new Error('provider exploded');
};

describe('regression — monitor input validation', () => {
  it('throws immediately when every is a non-ISO-8601 duration string', async () => {
    const { handle } = createSessionHandleFixture();

    // '5m', '1hour', 'five minutes' etc. are NOT valid ISO-8601 PT durations.
    // parseDuration() returns 0 for them, which previously caused a tight spin
    // loop. The fix throws an Error instead of silently treating 0 as valid.
    let caught: unknown;
    try {
      await handle.monitor({ every: '5m', input: 'check', until: () => true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorMessage(caught)).toMatch(/invalid duration string/i);
  });

  it('throws for other common mis-formatted duration strings', async () => {
    const { handle } = createSessionHandleFixture();

    let caught: unknown;
    try {
      await handle.monitor({ every: '1hour', input: 'check', until: () => true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorMessage(caught)).toMatch(/invalid duration string/i);
  });

  it('accepts valid ISO-8601 PT duration strings without throwing', async () => {
    const { handle } = createSessionHandleFixture();

    // 'PT5M' is valid — parseDuration returns 300_000, no throw.
    const result = await handle.monitor({
      every: 'PT5M',
      input: 'check',
      until: () => true,
      maxDuration: 1, // 1ms cap so the test finishes instantly
    });
    // maxDuration expires before the first inter-tick sleep, returning false.
    expect(typeof result).toBe('boolean');
  });

  // Regression: PRRT_kwDORvupsc6Ma-Dt — invalid string maxDuration silently
  // skips all ticks. parseDuration('5m') = 0, so Date.now()-startedAt >= 0 is
  // immediately true → returns false before the first tick runs.
  it('throws immediately when maxDuration is a non-ISO-8601 duration string', async () => {
    const { handle } = createSessionHandleFixture();

    let tickCount = 0;
    let caught: unknown;
    try {
      await handle.monitor({
        every: 1,
        input: 'check',
        until: () => {
          tickCount += 1;
          return false;
        },
        maxDuration: '5m', // non-ISO-8601 — parseDuration returns 0
      });
    } catch (err) {
      caught = err;
    }
    // Must throw, not silently return false.
    expect(caught).toBeInstanceOf(Error);
    expect(errorMessage(caught)).toMatch(/invalid duration string/i);
    // No tick should have run before the throw.
    expect(tickCount).toBe(0);
  });

  it('throws for other common mis-formatted maxDuration strings', async () => {
    const { handle } = createSessionHandleFixture();

    let caught: unknown;
    try {
      await handle.monitor({
        every: 1,
        input: 'check',
        until: () => false,
        maxDuration: '24h', // should be 'PT24H'
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorMessage(caught)).toMatch(/invalid duration string/i);
  });

  it('accepts a valid ISO-8601 string for maxDuration without throwing', async () => {
    const { handle } = createSessionHandleFixture();

    // 'PT0.01S' = 10ms. The first tick runs, then the deadline check fires.
    const result = await handle.monitor({
      every: 1,
      input: 'check',
      until: () => false,
      maxDuration: 'PT0.01S', // valid ISO-8601
    });
    // Deadline expired before predicate was met.
    expect(result).toBe(false);
  });

  it('accepts numeric 0 for maxDuration (zero budget is valid, not an error)', async () => {
    const { handle } = createSessionHandleFixture();

    // maxDuration: 0 (number) means "already expired" — returns false immediately.
    // This must NOT throw: neither the string guard nor the numeric guard (0 is a
    // valid non-negative finite value) should fire here.
    const result = await handle.monitor({
      every: 1,
      input: 'check',
      until: () => true,
      maxDuration: 0,
    });
    expect(result).toBe(false);
  });

  // Regression: PRRT_kwDORvupsc6MkjBe (Cursor Bugbot) — numeric maxDuration was
  // accepted as-is, so NaN/Infinity/negative made the deadline check
  // `Date.now() - startedAt >= maxMs` ALWAYS false → no effective time cap (the
  // loop runs until the predicate passes or a tick throws). The symmetric gap to
  // the numeric `every` guard above.
  it('throws for a non-finite numeric maxDuration (Infinity / NaN) without running unbounded', async () => {
    const { handle } = createSessionHandleFixture();

    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
      let tickCount = 0;
      let caught: unknown;
      try {
        await handle.monitor({
          every: 1,
          input: 'check',
          until: () => {
            tickCount += 1;
            return false; // never met — an unbounded loop would run forever
          },
          maxDuration: bad,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(errorMessage(caught)).toMatch(/invalid numeric value/i);
      // The throw happens before the loop starts — no tick ran.
      expect(tickCount).toBe(0);
    }
  });

  it('throws for a negative numeric maxDuration', async () => {
    const { handle } = createSessionHandleFixture();

    let caught: unknown;
    try {
      await handle.monitor({ every: 1, input: 'check', until: () => false, maxDuration: -5 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorMessage(caught)).toMatch(/invalid numeric value/i);
  });

  it('accepts a positive finite numeric maxDuration without throwing', async () => {
    const { handle } = createSessionHandleFixture();

    // 5ms cap with 1ms ticks and a never-met predicate → returns false at the
    // deadline. Proves a valid numeric maxDuration is not rejected.
    const result = await handle.monitor({
      every: 1,
      input: 'check',
      until: () => false,
      maxDuration: 5,
    });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6Mddv9 — monitor() rejects non-positive numeric
// intervals (the string guard above only covered strings; a numeric `every` of
// 0 / negative / non-finite flowed through as everyMs<=0 → no inter-tick sleep
// → tight spin of back-to-back agent runs).
// ---------------------------------------------------------------------------

describe('regression: monitor() rejects non-positive numeric intervals (PRRT_kwDORvupsc6Mddv9)', () => {
  it('throws immediately for every: 0 without running a single tick', async () => {
    const { handle } = createSessionHandleFixture();

    let tickCount = 0;
    let caught: unknown;
    try {
      await handle.monitor({
        every: 0,
        input: 'check',
        until: () => {
          tickCount += 1;
          return false; // never met — a spin loop would run forever
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorMessage(caught)).toMatch(/invalid numeric interval/i);
    // The throw happens before the loop starts — no tick (and no agent run) ran.
    expect(tickCount).toBe(0);
  });

  it('throws for a negative numeric interval', async () => {
    const { handle } = createSessionHandleFixture();

    let caught: unknown;
    try {
      await handle.monitor({ every: -5, input: 'check', until: () => false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorMessage(caught)).toMatch(/invalid numeric interval/i);
  });

  it('throws for a non-finite numeric interval (Infinity / NaN)', async () => {
    const { handle } = createSessionHandleFixture();

    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN]) {
      let caught: unknown;
      try {
        await handle.monitor({ every: bad, input: 'check', until: () => false });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(errorMessage(caught)).toMatch(/invalid numeric interval/i);
    }
  });

  it('accepts a positive numeric interval without throwing', async () => {
    const { handle } = createSessionHandleFixture();

    // every: 5 is valid; predicate met on first tick → returns true.
    const result = await handle.monitor({ every: 5, input: 'check', until: () => true });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6MddwB — monitor() stops on a failed tick instead
// of feeding the failure RunResult to the predicate. `run.result()` RESOLVES
// (does not throw) for normal operative failures, so the catch block never ran
// and a predicate returning false kept re-running after provider/tool failures.
// ---------------------------------------------------------------------------

describe('regression: monitor() surfaces failed tick finish reasons (PRRT_kwDORvupsc6MddwB)', () => {
  it("throws (does not call until) when a tick's run finishes with finishReason 'error'", async () => {
    // A generate that throws makes the loop resolve a RunResult with
    // finishReason 'error' (the loop catches the throw internally — run.result()
    // resolves rather than rejects), exactly the case the predicate must not see.
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('monitor-fail-session', {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(failingGenerate),
    });

    let predicateCalls = 0;
    let caught: unknown;
    try {
      await handle.monitor({
        every: 5,
        input: 'check',
        until: () => {
          predicateCalls += 1;
          return false; // a spin loop would re-run forever after the failure
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    // The original run error is surfaced, not swallowed.
    expect(errorMessage(caught)).toMatch(/provider exploded/i);
    // The predicate must NEVER see a failed tick.
    expect(predicateCalls).toBe(0);
  });

  it('still evaluates the predicate normally on a successful tick', async () => {
    // Sanity: a healthy run (finishReason 'maximum-steps') is NOT treated as a
    // failure — the predicate runs as before.
    const { handle } = createSessionHandleFixture();
    let predicateCalls = 0;
    const result = await handle.monitor({
      every: 5,
      input: 'check',
      until: () => {
        predicateCalls += 1;
        return true;
      },
    });
    expect(result).toBe(true);
    expect(predicateCalls).toBe(1);
  });
});
