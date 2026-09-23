import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createSessionHandleFixture } from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('SessionHandle liveness — snapshots', () => {
  it('reports a redacted, process-local, unknown-reachability snapshot before any activity', () => {
    const { handle, sessionId } = createSessionHandleFixture();
    const snap = handle.snapshot();

    expect(snap.kind).toBe('session');
    expect(snap.id).toBe(sessionId);
    expect(snap.status).toBe('created');
    expect(snap.projection).toBe('redacted');
    expect(snap.ownership).toBe('independent');
    expect(snap.detached).toBe(false);
    // AC5: session liveness stays process-local, per AB-39.
    expect(snap.durability).toBe('process-local');
    expect(snap.reachability).toBe('unknown');
    expect(snap.progress).toBe('unknown');
    expect(snap.assessment).toBe('healthy');
    expect(snap.missedPulseCount).toBe(0);
    expect(snap.evidence).toEqual([]);
    expect(snap.declaredWait).toBeUndefined();
  });

  it('returns the identical cached object by reference when no revision has advanced', () => {
    const { handle } = createSessionHandleFixture();
    const first = handle.snapshot();
    const second = handle.snapshot();
    expect(second).toBe(first);
  });

  it('subscribeSnapshot delivers the current snapshot synchronously, then a new one per revision', async () => {
    const { handle } = createSessionHandleFixture();
    const received: Array<ReturnType<typeof handle.snapshot>> = [];
    const subscription = handle.subscribeSnapshot((snap) => {
      received.push(snap);
    });

    expect(received.length).toBe(1);
    expect(received[0]?.status).toBe('created');

    await handle.run('hello').result();
    // run() eagerly advances to 'running', then back to 'created' once it
    // settles — at least two more deliveries beyond the initial one.
    expect(received.length).toBeGreaterThan(1);
    expect(subscription.closed).toBe(false);

    subscription.unsubscribe();
    expect(subscription.closed).toBe(true);
    const beforeUnsubscribeCount = received.length;
    await handle.run('hello again').result();
    expect(received.length).toBe(beforeUnsubscribeCount);
  });

  it('delivers exactly once and never again when options.signal is already aborted', () => {
    const { handle } = createSessionHandleFixture();
    const received: unknown[] = [];
    const subscription = handle.subscribeSnapshot((snap) => received.push(snap), {
      signal: AbortSignal.abort(),
    });
    expect(received.length).toBe(1);
    expect(subscription.closed).toBe(true);
  });

  it('stops delivering once options.signal aborts', async () => {
    const { handle } = createSessionHandleFixture();
    const controller = new AbortController();
    const received: unknown[] = [];
    handle.subscribeSnapshot((snap) => received.push(snap), { signal: controller.signal });
    controller.abort();
    const beforeCount = received.length;
    await handle.run('hello').result();
    expect(received.length).toBe(beforeCount);
  });

  it('isolates a throwing subscriber from other subscribers and from the caller driving the revision', async () => {
    const { handle } = createSessionHandleFixture();
    let goodCalls = 0;
    handle.subscribeSnapshot(() => {
      throw new Error('boom');
    });
    handle.subscribeSnapshot(() => {
      goodCalls += 1;
    });
    await handle.run('hello').result();
    expect(goodCalls).toBeGreaterThan(1);
  });
});
