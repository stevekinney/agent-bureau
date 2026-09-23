import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { SessionSleepEvent } from '../events';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
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

describe('session.sleep()', () => {
  it('does not emit a sleep event when the signal is already aborted', async () => {
    const { handle } = createSessionHandleFixture();
    let sleepEvents = 0;
    handle.emitter.addEventListener(SessionSleepEvent.type, () => {
      sleepEvents += 1;
    });

    let caught: unknown;
    try {
      await handle.sleep('PT1H', { signal: AbortSignal.abort() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(sleepEvents).toBe(0);
  });

  it('clears a timer when abort races with timer registration', async () => {
    const timerToken = Symbol('timer');
    const clearedTimers: unknown[] = [];
    const abortController = new AbortController();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('racing-local-sleep-session', {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(),
      setTimeoutFunction: () => {
        abortController.abort();
        return timerToken;
      },
      clearTimeoutFunction: (timer) => {
        clearedTimers.push(timer);
      },
    });

    let caught: unknown;
    try {
      await handle.sleep('PT1H', { signal: abortController.signal });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(clearedTimers).toEqual([timerToken]);
  });

  it('clears the default process-local timer when aborted', async () => {
    const abortController = new AbortController();
    const { handle } = createSessionHandleFixture();

    const sleeping = handle.sleep('PT1H', { signal: abortController.signal });
    abortController.abort();

    let caught: unknown;
    try {
      await sleeping;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
  });

  it('uses and clears a process-local timer when aborted, even with a durable engine', async () => {
    const timerToken = Symbol('timer');
    const clearedTimers: unknown[] = [];
    const abortController = new AbortController();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const engine = createSessionEngine({});
    const handle = createSessionHandle('abort-local-sleep-session', {
      store,
      agentName: 'test-agent',
      engine,
      runOptions: createTestRunOptions(),
      setTimeoutFunction: () => timerToken,
      clearTimeoutFunction: (timer) => {
        clearedTimers.push(timer);
      },
    });

    const sleeping = handle.sleep('PT1H', { signal: abortController.signal });
    abortController.abort();

    let caught: unknown;
    try {
      await sleeping;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(clearedTimers).toEqual([timerToken]);
  });

  // AB-330: the two default-(real)-runtime timing proofs ("resolves after
  // the specified milliseconds...", "parses ISO-8601 PT duration strings")
  // moved to `session-handle-sleep-default-runtime.test.ts` — see that
  // file's header comment.

  // Regression: PRRT_kwDORvupsc6Mc3gS — sleep() must reject non-ISO-8601
  // duration strings the same way monitor({ every }) does. parseDuration()
  // returns 0 for unrecognised strings (e.g. '5m' instead of 'PT5M'), which
  // previously made the session resume immediately instead of pausing.
  it('throws when given a non-ISO-8601 duration string (PRRT_kwDORvupsc6Mc3gS)', async () => {
    const { handle } = createSessionHandleFixture();

    let caught: unknown;
    try {
      await handle.sleep('5m'); // not 'PT5M' — parseDuration returns 0
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorMessage(caught)).toMatch(/invalid duration string/i);
  });

  it('does not throw for an explicit numeric 0 (zero is a valid millisecond value)', async () => {
    const { handle } = createSessionHandleFixture();
    // A numeric 0 is a deliberate no-delay sleep — only string parse-to-0 is rejected.
    await handle.sleep(0);
    // Reaching here without throwing is the assertion.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// signal() — fire-and-forget signal
// ---------------------------------------------------------------------------
