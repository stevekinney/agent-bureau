import { TypedEventTarget } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import type { OperativeEventMap } from '../events';
import { SessionMonitorTickEvent } from '../events';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import { createTestRunOptions } from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('session.monitor() — abort races', () => {
  it('AB-210 regression: stops within one tick when the signal fires mid-LLM-call — no second tick starts', async () => {
    let signalGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });
    const blockingGenerate: GenerateFunction = async ({ signal }) => {
      signalGenerateStarted();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('tick aborted')), {
          once: true,
        });
      });
      throw new Error('abort signal was not delivered');
    };
    const abortController = new AbortController();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const handle = createSessionHandle('monitor-signal-mid-generate', {
      store,
      agentName: 'test-agent',
      emitter,
      runOptions: createTestRunOptions(blockingGenerate),
    });

    const tickEvents: SessionMonitorTickEvent[] = [];
    emitter.addEventListener('session.monitor.tick', (e) => {
      tickEvents.push(e);
    });

    const monitoring = handle.monitor({
      every: 'PT1H',
      input: 'check',
      until: () => false,
      signal: abortController.signal,
    });
    await generateStarted;
    abortController.abort();

    let caught: unknown;
    try {
      await monitoring;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
    // Only tick 0's tick-started event fires (met=null) — the run aborted
    // mid-generate, before predicate evaluation, and no tick 1 ever starts.
    expect(tickEvents).toHaveLength(1);
    expect(tickEvents[0]!.tick).toBe(0);
    expect(tickEvents[0]!.met).toBeNull();
  });

  it('AB-210 regression: stops within one tick when the signal fires mid-inter-tick-sleep — no next tick starts', async () => {
    // Mocked timers, discriminated by CALL ORDER rather than duration: the
    // `session.monitor` liveness watchdog (obs-02) schedules its own first
    // check with the identical `everyMs` duration the inter-tick sleep
    // below uses (`sessionMonitorPolicy`'s `graceMs`/`jitterMs` are both 0),
    // so duration alone cannot tell the two timers apart. Order can: the
    // watchdog's timer is scheduled synchronously at `monitor()` construction
    // — before tick 0's tick-started event ever fires — so it is always
    // call #1. The inter-tick sleep is only entered once tick 0 has fully
    // completed, so it is always call #2. This is verified by a debug run
    // against this exact fixture (only 1 event present when call #1 lands).
    const calls: Array<{ token: symbol; milliseconds: number }> = [];
    const clearedTokens: symbol[] = [];
    let secondCallScheduled: (() => void) | undefined;
    const secondCallWasScheduled = new Promise<void>((resolve) => {
      secondCallScheduled = resolve;
    });
    const abortController = new AbortController();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const handle = createSessionHandle('monitor-signal-mid-sleep', {
      store,
      agentName: 'test-agent',
      emitter,
      runOptions: createTestRunOptions(),
      setTimeoutFunction: (_callback, milliseconds) => {
        const token = Symbol(`timer-${calls.length}`);
        calls.push({ token, milliseconds });
        if (calls.length === 2) secondCallScheduled?.();
        return token;
      },
      clearTimeoutFunction: (timer) => {
        if (typeof timer !== 'symbol') throw new TypeError('Expected a symbol timer');
        clearedTokens.push(timer);
      },
    });

    const tickEvents: SessionMonitorTickEvent[] = [];
    emitter.addEventListener('session.monitor.tick', (e) => {
      tickEvents.push(e);
    });

    const monitoring = handle.monitor({
      every: 'PT1H',
      input: 'check',
      until: () => false,
      signal: abortController.signal,
    });

    // Wait for the SECOND setTimeoutFunction call specifically — the sleep
    // timer having already been scheduled (not merely about to be) is what
    // makes this "mid-sleep" rather than "before the sleep starts".
    await secondCallWasScheduled;
    expect(tickEvents).toHaveLength(2);
    expect(tickEvents.map((e) => e.tick)).toEqual([0, 0]);
    const sleepTimer = calls[1]!;

    abortController.abort();

    let caught: unknown;
    try {
      await monitoring;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
    // No tick 1 ever starts, and the sleep timer specifically — not just
    // some timer — was torn down by the abort.
    expect(tickEvents).toHaveLength(2);
    expect(clearedTokens).toContain(sleepTimer.token);
  });
});
