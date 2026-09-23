import { createManualRuntimeServices, TypedEventTarget } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import type { OperativeEventMap } from '../events';
import { SessionMonitorDoneEvent, SessionMonitorTickEvent } from '../events';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import { createSessionHandleFixture, createTestRunOptions } from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('session.monitor() — outcomes and persistence', () => {
  it('returns true when the predicate is satisfied on the first tick', async () => {
    const { handle } = createSessionHandleFixture();
    const result = await handle.monitor({
      every: 5,
      input: 'check the deploy',
      until: () => true,
    });
    expect(result).toBe(true);
  });

  it('returns true after multiple ticks when the predicate eventually returns true', async () => {
    const { handle } = createSessionHandleFixture();
    let callCount = 0;
    const result = await handle.monitor({
      every: 5,
      input: 'poll',
      until: () => {
        callCount += 1;
        return callCount >= 3;
      },
    });
    expect(result).toBe(true);
    expect(callCount).toBe(3);
  });

  it('returns false when the maxDuration deadline is reached before the predicate is met', async () => {
    const { handle } = createSessionHandleFixture();
    const result = await handle.monitor({
      every: 1,
      input: 'poll',
      until: () => false,
      maxDuration: 5, // Only 5ms — ticks take ~1ms each so this will hit the deadline quickly
    });
    expect(result).toBe(false);
  });

  it('accepts ISO-8601 duration strings for every and maxDuration', async () => {
    const { handle } = createSessionHandleFixture();
    // 'PT0.01S' = 10ms; maxDuration 'PT0.005S' = 5ms → should expire before the first tick interval
    const result = await handle.monitor({
      every: 'PT0.05S', // 50ms between ticks
      input: 'poll',
      until: () => false,
      maxDuration: 'PT0.01S', // 10ms total — less than one full cycle
    });
    expect(result).toBe(false);
  });

  it('each tick executes a full agent run and the predicate receives the RunResult', async () => {
    const { handle } = createSessionHandleFixture(undefined);
    const results: string[] = [];
    await handle.monitor({
      every: 5,
      input: 'check status',
      until: (runResult) => {
        results.push(runResult.finishReason);
        return results.length >= 2;
      },
    });
    // Each tick completes a run; finishReason should be populated.
    expect(results).toHaveLength(2);
    expect(results[0]).toBeDefined();
  });

  it('dispatches SessionMonitorTickEvent on each tick', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('monitor-tick-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });

    const tickEvents: SessionMonitorTickEvent[] = [];
    emitter.addEventListener('session.monitor.tick', (e) => {
      tickEvents.push(e);
    });

    let count = 0;
    await h.monitor({
      every: 5,
      input: 'tick check',
      until: () => {
        count += 1;
        return count >= 2;
      },
    });

    // Each tick emits TWO events: one at tick-started (met=null) and one after
    // predicate evaluation (met=true|false). With 2 ticks we expect 4 events.
    expect(tickEvents.length).toBeGreaterThanOrEqual(2);
    // First event of first tick: met=null (run hasn't completed yet).
    expect(tickEvents[0]!.sessionId).toBe('monitor-tick-session');
    expect(tickEvents[0]!.tick).toBe(0);
    expect(tickEvents[0]!.met).toBeNull();
    // Second event of first tick: met=false (predicate returned false).
    expect(tickEvents[1]!.met).toBe(false);
    // Second tick: met=true (predicate returned true).
    const lastTickEvent = tickEvents[tickEvents.length - 1];
    expect(lastTickEvent!.met).toBe(true);
  });

  it('dispatches SessionMonitorDoneEvent when the condition is met', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('monitor-done-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });

    const doneEvents: SessionMonitorDoneEvent[] = [];
    emitter.addEventListener('session.monitor.done', (e) => {
      doneEvents.push(e);
    });

    await h.monitor({
      every: 5,
      input: 'check',
      until: () => true,
    });

    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]!.sessionId).toBe('monitor-done-session');
    expect(doneEvents[0]!.met).toBe(true);
    expect(doneEvents[0]!.ticks).toBe(1);
  });

  it('dispatches SessionMonitorDoneEvent(met=false) when maxDuration expires', async () => {
    const runtime = createManualRuntimeServices();
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('monitor-deadline-session', {
      store,
      agentName: 'agent',
      emitter,
      runtime,
      runOptions: createTestRunOptions(async () => {
        await runtime.advance(5);
        return { content: 'checked', toolCalls: [] };
      }),
    });

    const doneEvents: SessionMonitorDoneEvent[] = [];
    emitter.addEventListener('session.monitor.done', (e) => {
      doneEvents.push(e);
    });

    await h.monitor({
      every: 1,
      input: 'check',
      until: () => false,
      maxDuration: 5,
    });

    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]!.met).toBe(false);
    expect(doneEvents[0]!.ticks).toBe(1);
    expect(runtime.pendingTimers()).toHaveLength(0);
  });

  it('accumulates runs in the session for each tick', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('monitor-runs-session', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(),
    });

    let count = 0;
    await h.monitor({
      every: 5,
      input: 'poll',
      until: () => {
        count += 1;
        return count >= 2;
      },
    });

    // Give persistence callbacks a moment to flush.
    await yieldToPortableEventLoop();

    const session = await store.load('monitor-runs-session');
    // 2 ticks × 1 run each.
    expect(session!.runs.length).toBeGreaterThanOrEqual(2);
  });
});
