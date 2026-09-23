import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import { createSessionHandleFixture, createTestRunOptions } from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('SessionHandle liveness — watchdog', () => {
  it('threads the constructor setTimeoutFunction/clearTimeoutFunction into the session.monitor watchdog and observes it obey the injected clock', async () => {
    const scheduled: Array<() => void> = [];
    const cleared: unknown[] = [];
    let nextId = 0;
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    let releaseGenerate!: () => void;
    const generateGate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    const blockingGenerate: GenerateFunction = async () => {
      await generateGate;
      return { content: 'done', toolCalls: [] };
    };

    const handle = createSessionHandle('watchdog-cadence-session', {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(blockingGenerate),
      setTimeoutFunction: (callback) => {
        scheduled.push(callback);
        return ++nextId;
      },
      clearTimeoutFunction: (timer) => {
        cleared.push(timer);
      },
    });

    // No watchdog exists before monitor() ever runs — session.monitor's
    // StallPolicy row needs the caller's `every`, only known then.
    expect(handle.snapshot().reachability).toBe('unknown');

    const monitoring = handle.monitor({
      every: 20,
      input: 'poll',
      until: () => true,
    });

    // The tick-start pulse and the watchdog's own cadence-check scheduling
    // both happen synchronously inside monitor() before its first `await` —
    // no microtask flush is required, but a couple are harmless insurance.
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduled.length).toBeGreaterThan(0);
    expect(handle.snapshot().reachability).toBe('reachable');

    // The first manually-fired check sees the tick-start pulse as fresh
    // (recorded after the watchdog's own construction) — no miss.
    const firstCheck = scheduled.shift();
    firstCheck?.();
    expect(handle.snapshot().reachability).toBe('reachable');
    expect(handle.snapshot().missedPulseCount).toBe(0);

    // The second manually-fired check has seen no NEW pulse since the
    // first check ran — a genuine missed pulse, and the threshold is 1.
    const secondCheck = scheduled.shift();
    secondCheck?.();
    expect(handle.snapshot().reachability).toBe('unreachable');
    expect(handle.snapshot().missedPulseCount).toBeGreaterThanOrEqual(1);

    releaseGenerate();
    const result = await monitoring;
    expect(result).toBe(true);

    // The watchdog is disposed once monitor() returns — its cadence timer
    // is cleared and the session reports its resting, un-gated state again.
    expect(cleared.length).toBeGreaterThan(0);
    expect(handle.snapshot().reachability).toBe('unknown');
    expect(handle.snapshot().status).toBe('created');
  });

  it("sets lastHeartbeatAt/lastActivityAt/lastProgressAt from the tick's 'host-reachability' pulse (AC3)", async () => {
    const { handle } = createSessionHandleFixture();
    const seen: Array<ReturnType<typeof handle.snapshot>> = [];
    handle.subscribeSnapshot((snap) => seen.push(snap));

    const result = await handle.monitor({ every: 5, input: 'poll', until: () => true });
    expect(result).toBe(true);

    const withActivity = seen.find((snap) => snap.lastActivityAt !== undefined);
    expect(withActivity).toBeDefined();
    expect(withActivity?.lastHeartbeatAt).toBe(withActivity?.lastActivityAt);
    expect(withActivity?.lastProgressAt).toBe(withActivity?.lastActivityAt);
    expect(withActivity?.evidence.length).toBeGreaterThan(0);
    expect(withActivity?.evidence[0]?.source).toBe('host-reachability');
  });
});
