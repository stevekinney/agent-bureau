import { createManualRuntimeServices, TypedEventTarget } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import type { OperativeEventMap } from '../events';
import { SessionMonitorDoneEvent, SessionMonitorTickEvent } from '../events';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import { createSessionHandleFixture, createTestRunOptions } from './session-handle-test-support';
import { MissingRunOptionsError } from './session-handle-types';
import { createSessionMonitor } from './session-monitor';
import { createMonitorResult, createMonitorRun } from './session-monitor-test-fixture';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

function createMonitorForRun(run: ReturnType<typeof createMonitorRun>) {
  const runtime = createManualRuntimeServices();
  const watchdog = {
    recordPulse() {},
    assess: () => ({
      reachability: 'unknown' as const,
      progress: 'unknown' as const,
      missedPulseCount: 0,
      evidence: [],
    }),
    dispose() {},
  };
  return createSessionMonitor({
    sessionId: 'direct-monitor-test',
    emitter: new TypedEventTarget<OperativeEventMap>(),
    runtime,
    livenessClock: {
      now: () => 0,
      setTimeout: () => 'watchdog',
      clearTimeout: () => {},
    },
    setTimeoutFunction: () => 'timer',
    clearTimeoutFunction: () => {},
    run: () => run,
    setLivenessState: () => {},
    processLocalDelay: async () => {},
    processLocalAbortError: () => new DOMException('aborted', 'AbortError'),
    parseDuration: () => 1,
    getWatchdog: () => watchdog,
    setWatchdog: () => {},
    setWatchdogCadence: () => {},
    advanceLiveness: () => {},
  });
}

describe('session.monitor() — process-local watch loop', () => {
  it('emits done when a recover-only handle cannot create a monitor run', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const handle = createSessionHandle('recover-only-monitor', {
      store,
      agentName: 'agent',
      emitter,
    });
    const events: string[] = [];
    const done: SessionMonitorDoneEvent[] = [];
    emitter.addEventListener('session.monitor.tick', () => events.push('tick'));
    emitter.addEventListener('session.monitor.done', (event) => {
      events.push('done');
      done.push(event);
    });
    expect(handle.monitor({ every: 1, input: 'check', until: () => false })).rejects.toBeInstanceOf(
      MissingRunOptionsError,
    );
    expect(events).toEqual(['tick', 'done']);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ met: false, ticks: 1 });
    expect(await store.load('recover-only-monitor')).toBeUndefined();
  });

  it('propagates an infrastructure rejection from the monitored run', async () => {
    const error = new Error('infrastructure failure');
    const monitor = createMonitorForRun(createMonitorRun(Promise.reject(error)));

    expect(monitor({ every: 1, input: 'check', until: () => false })).rejects.toBe(error);
  });

  it('synthesizes an error when a monitored run reports a failed finish reason without one', async () => {
    const monitor = createMonitorForRun(
      createMonitorRun(Promise.resolve(createMonitorResult('error'))),
    );

    expect(monitor({ every: 1, input: 'check', until: () => false })).rejects.toThrow(
      "monitor tick ended with finishReason 'error'",
    );
  });

  it('propagates a rejected run result and emits a failed monitor completion', async () => {
    const error = new Error('monitor run failed');
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const handle = createSessionHandle('monitor-run-error', {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(async () => {
        throw error;
      }),
    });
    const doneEvents: SessionMonitorDoneEvent[] = [];
    handle.emitter.addEventListener(SessionMonitorDoneEvent.type, (event) => {
      doneEvents.push(event);
    });

    expect(
      handle.monitor({ every: 'PT1H', input: 'check', until: () => false }),
    ).rejects.toMatchObject({ message: error.message, kind: 'generate' });
    expect(doneEvents.at(-1)?.met).toBe(false);
  });

  it('does not emit a monitor tick when the signal is already aborted', async () => {
    const { handle } = createSessionHandleFixture();
    let tickEvents = 0;
    handle.emitter.addEventListener(SessionMonitorTickEvent.type, () => {
      tickEvents += 1;
    });

    let caught: unknown;
    try {
      await handle.monitor({
        every: 'PT1H',
        input: 'check',
        until: () => false,
        signal: AbortSignal.abort(),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(tickEvents).toBe(0);
  });

  it('aborts the active process-local monitor tick', async () => {
    let signalGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });
    const blockingGenerate: GenerateFunction = async ({ signal }) => {
      signalGenerateStarted();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('monitor tick aborted')), {
          once: true,
        });
      });
      throw new Error('abort signal was not delivered');
    };
    const abortController = new AbortController();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('abort-active-monitor-session', {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(blockingGenerate),
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
  });

  it('clears its process-local inter-tick timer and stops when aborted', async () => {
    // The FIRST `setTimeoutFunction` call under this fixture is actually the
    // `session.monitor` liveness watchdog's own check timer (obs-02),
    // scheduled synchronously at `monitor()` construction — before tick 0's
    // run even starts. Waiting for only that first call and aborting
    // immediately (as an earlier version of this test did) exercises
    // mid-tick-0 abort and watchdog disposal, not the inter-tick timer this
    // test is named for. Waiting for the SECOND call isolates the actual
    // inter-tick sleep timer instead (see the AB-210 regression test below
    // for the full discriminator rationale).
    const calls: Array<{ token: symbol; milliseconds: number }> = [];
    const clearedTokens: symbol[] = [];
    let secondCallScheduled: (() => void) | undefined;
    const secondCallWasScheduled = new Promise<void>((resolve) => {
      secondCallScheduled = resolve;
    });
    const abortController = new AbortController();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('abort-local-monitor-session', {
      store,
      agentName: 'test-agent',
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
    let doneEvents = 0;
    handle.emitter.addEventListener(SessionMonitorDoneEvent.type, () => {
      doneEvents += 1;
    });

    const monitoring = handle.monitor({
      every: 'PT1H',
      input: 'check',
      until: () => false,
      signal: abortController.signal,
    });
    await secondCallWasScheduled;
    const sleepTimer = calls[1]!;
    abortController.abort();

    let caught: unknown;
    try {
      await monitoring;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'AbortError' });
    expect(clearedTokens).toContain(sleepTimer.token);
    expect(doneEvents).toBe(1);
  });

  // AB-210 verifies and records — without code change — that monitor()
  // already conforms to AB-38's "cancel inter-attempt sleep and validation
  // immediately" requirement. These two regression tests document that with
  // a passing assertion (a tick count), not merely a comment: signal.abort()
  // stops the loop within the CURRENT tick, and no further tick starts,
  // whether the signal fires mid-LLM-call or mid-inter-tick-sleep.
});
