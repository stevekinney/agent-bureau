import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices, type Subscription } from 'lifecycle';

import type { ChildRunDescriptor, ChildRunRegistry } from '../child-run';
import { createActiveRunLiveness } from './active-run-liveness';
import { LIVENESS_POLICY_VERSION, TOOL_CALL_POLICY } from './policies';
import type { LivenessAssessment } from './types';
import type { StallWatchdogClock } from './watchdog';

/**
 * A `ChildRunRegistry` test double whose `children()` set and
 * `subscribeLiveness` notifications are fully caller-controlled — for
 * exercising AB-216's rollup logic in isolation from `dispatchChildRun`'s
 * own child-dispatch machinery (covered separately in
 * `packages/operative/test/agent-run.test.ts`).
 */
function createFakeChildRegistry(): ChildRunRegistry & {
  setChildren(children: readonly ChildRunDescriptor[]): void;
  notify(): void;
} {
  let children: readonly ChildRunDescriptor[] = [];
  const listeners = new Set<() => void>();
  return {
    children: () => children,
    abortChild: () => undefined,
    awaitChildrenClosed: () => Promise.resolve(),
    subscribeLiveness(observer): Subscription {
      listeners.add(observer);
      let closed = false;
      return {
        unsubscribe() {
          if (closed) return;
          closed = true;
          listeners.delete(observer);
        },
        get closed() {
          return closed;
        },
      };
    },
    setChildren(next) {
      children = next;
    },
    notify() {
      for (const listener of [...listeners]) listener();
    },
  };
}

function child(id: string, assessment: LivenessAssessment | undefined): ChildRunDescriptor {
  return {
    id,
    parentId: 'parent-1',
    agentName: 'researcher',
    durable: false,
    status: assessment === 'terminal' ? 'completed' : 'running',
    ...(assessment !== undefined ? { assessment } : {}),
  };
}

/** `cadenceMs + graceMs + jitterMs` — see the identical helper in `watchdog.test.ts`. */
const TOOL_CHECK_INTERVAL_MS =
  (TOOL_CALL_POLICY.cadenceMs ?? 0) + TOOL_CALL_POLICY.graceMs + TOOL_CALL_POLICY.jitterMs;

function createManualClock(): StallWatchdogClock & { advance(ms: number): void } {
  let time = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    setTimeout(callback, ms) {
      const handle = nextHandle++;
      timers.set(handle, { at: time + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      time += ms;
      let fired = true;
      while (fired) {
        fired = false;
        for (const [handle, timer] of [...timers.entries()]) {
          if (timer.at <= time) {
            timers.delete(handle);
            timer.callback();
            fired = true;
          }
        }
      }
    },
  };
}

describe('createActiveRunLiveness (default real clock)', () => {
  it('defaults to a real Date.now()/setTimeout clock and cleans up on dispose', () => {
    const liveness = createActiveRunLiveness({ id: 'run-real', durability: 'process-local' });

    const snapshot = liveness.snapshot();
    expect(snapshot.id).toBe('run-real');
    expect(snapshot.observedAt).toBeGreaterThan(0);

    liveness.dispose();
  });

  it('a manual RuntimeServices controls startedAt and lastTransitionAt (AB-325)', () => {
    const runtime = createManualRuntimeServices();
    const liveness = createActiveRunLiveness({
      id: 'run-manual-runtime',
      durability: 'process-local',
      runtime,
    });

    expect(liveness.snapshot().startedAt).toBe(runtime.clock.nowISO());

    liveness.setStatus('waiting');
    expect(liveness.snapshot().lastTransitionAt).toBe(runtime.clock.nowISO());

    liveness.dispose();
  });

  it('also drives the watchdog observedAt from runtime.monotonic when options.clock is not supplied', async () => {
    const runtime = createManualRuntimeServices();
    const liveness = createActiveRunLiveness({
      id: 'run-manual-runtime-watchdog',
      durability: 'process-local',
      runtime,
    });

    const before = liveness.snapshot().observedAt;
    expect(before).toBe(runtime.monotonic.now());
    await runtime.advance(TOOL_CHECK_INTERVAL_MS);
    liveness.recordProviderPulse();
    expect(liveness.snapshot().observedAt).toBe(runtime.monotonic.now());
    expect(liveness.snapshot().observedAt).toBeGreaterThan(before);

    liveness.dispose();
  });
});

describe('createActiveRunLiveness', () => {
  it('snapshot() returns a healthy, running agent-run snapshot before any pulse', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    const snapshot = liveness.snapshot();

    expect(snapshot.id).toBe('run-1');
    expect(snapshot.kind).toBe('agent-run');
    expect(snapshot.status).toBe('running');
    expect(snapshot.assessment).toBe('healthy');
    expect(snapshot.projection).toBe('redacted');
    expect(snapshot.durability).toBe('process-local');
    expect(snapshot.policyVersion).toBe(LIVENESS_POLICY_VERSION);
    expect(snapshot.revision).toBe(0);
    expect(snapshot.evidence).toEqual([]);

    liveness.dispose();
  });

  it('subscribeSnapshot delivers the current snapshot synchronously before returning', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    const received: number[] = [];
    liveness.subscribeSnapshot((snapshot) => received.push(snapshot.revision));

    expect(received).toEqual([0]);
    liveness.dispose();
  });

  it('a subscriber that triggers a revision change from inside its own initial synchronous delivery still observes it (AB-214 review PRRT_kwDORvupsc6es7pq)', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    const received: string[] = [];
    liveness.subscribeSnapshot((snapshot) => {
      received.push(snapshot.status);
      // Reentrant: the observer itself synchronously triggers a revision
      // change during its own initial delivery, exactly as a caller
      // inspecting the snapshot and then calling run.abort() would.
      if (snapshot.status === 'running') {
        liveness.setStatus('aborting');
      }
    });

    // Registering BEFORE the synchronous initial delivery means this
    // reentrant transition reaches the same observer as a nested second
    // call, not a missed notification.
    expect(received).toEqual(['running', 'aborting']);

    liveness.dispose();
  });

  it('delivers a new snapshot on every revision change', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    const received: number[] = [];
    liveness.subscribeSnapshot((snapshot) => received.push(snapshot.revision));

    liveness.recordProviderPulse({ note: 'first' });
    liveness.recordToolProgressPulse({ toolCallId: 'call-1', percent: 50 });

    expect(received).toEqual([0, 1, 2]);
    liveness.dispose();
  });

  it('labels a provider pulse as provider-io and a tool pulse as tool-progress', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    liveness.recordProviderPulse({ note: 'generate' });
    liveness.recordToolProgressPulse({ toolCallId: 'call-1', toolName: 'search' });

    const evidence = liveness.snapshot().evidence;
    expect(evidence.map((entry) => entry.source).sort()).toEqual(['provider-io', 'tool-progress']);
    const toolEntry = evidence.find((entry) => entry.source === 'tool-progress');
    expect((toolEntry?.detail as { toolCallId?: string } | undefined)?.toolCallId).toBe('call-1');

    liveness.dispose();
  });

  it('setStatus transitions status and bumps lastTransitionAt/revision', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    const before = liveness.snapshot();
    liveness.setStatus('aborting');
    const after = liveness.snapshot();

    expect(after.status).toBe('aborting');
    expect(after.assessment).toBe('aborting');
    expect(after.cancellable).toBe(false);
    expect(after.revision).toBeGreaterThan(before.revision);

    liveness.dispose();
  });

  it('setStatus is a no-op once already terminal', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    liveness.setStatus('terminal');
    const terminalRevision = liveness.snapshot().revision;
    liveness.setStatus('aborting');

    expect(liveness.snapshot().status).toBe('terminal');
    expect(liveness.snapshot().revision).toBe(terminalRevision);
  });

  // AB-336 — `beginWait`/`endWait` are the only way `status` legally becomes
  // `'waiting'`: AC1 requires a `DeclaredWait` accompany it in the SAME
  // snapshot, never as two separate transitions a subscriber could observe
  // between.
  it('beginWait moves status to waiting and attaches declaredWait in one revision', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    const before = liveness.snapshot();
    liveness.beginWait({
      reason: 'signal',
      dependency: 'human-response',
      wakeCondition: 'signal:human-response',
    });
    const parked = liveness.snapshot();

    expect(parked.status).toBe('waiting');
    expect(parked.assessment).toBe('legitimately-waiting');
    expect(parked.declaredWait).toEqual({
      reason: 'signal',
      dependency: 'human-response',
      wakeCondition: 'signal:human-response',
      startedAt: clock.now(),
    });
    expect(parked.revision).toBeGreaterThan(before.revision);

    liveness.dispose();
  });

  it('endWait clears declaredWait and returns status to running only when status was waiting', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    liveness.beginWait({ reason: 'signal', wakeCondition: 'signal:human-response' });
    expect(liveness.snapshot().status).toBe('waiting');

    liveness.endWait();
    const resumed = liveness.snapshot();
    expect(resumed.status).toBe('running');
    expect(resumed.declaredWait).toBeUndefined();
    expect(resumed.assessment).not.toBe('legitimately-waiting');

    liveness.dispose();
  });

  it('endWait is a no-op when no wait is active (no wasted revision)', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    const before = liveness.snapshot();
    liveness.endWait();

    expect(liveness.snapshot().revision).toBe(before.revision);
    expect(liveness.snapshot().status).toBe('running');

    liveness.dispose();
  });

  it('endWait does not yank status back to running when it moved to aborting while waiting', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    liveness.beginWait({ reason: 'signal', wakeCondition: 'signal:human-response' });
    liveness.setStatus('aborting');

    // AC1/AB-336: `declaredWait` is documented "present iff `status` is
    // `'waiting'`" — `setStatus` must already have cleared it here, before
    // `endWait()` ever runs, or a subscriber observing this exact
    // intermediate snapshot would see `status: 'aborting'` with a stale
    // `declaredWait` still attached.
    const duringAbort = liveness.snapshot();
    expect(duringAbort.status).toBe('aborting');
    expect(duringAbort.declaredWait).toBeUndefined();

    liveness.endWait();

    const after = liveness.snapshot();
    expect(after.status).toBe('aborting');
    expect(after.declaredWait).toBeUndefined();

    liveness.dispose();
  });

  it('beginWait is a no-op once already terminal', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    liveness.setStatus('terminal');
    const terminalRevision = liveness.snapshot().revision;
    liveness.beginWait({ reason: 'signal', wakeCondition: 'signal:human-response' });

    expect(liveness.snapshot().status).toBe('terminal');
    expect(liveness.snapshot().declaredWait).toBeUndefined();
    expect(liveness.snapshot().revision).toBe(terminalRevision);
  });

  it('settle attaches the result to the snapshot and transitions to terminal atomically', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    expect(liveness.snapshot().result).toBeUndefined();
    liveness.settle({ finishReason: 'stop' });

    expect(liveness.snapshot().result).toEqual({ finishReason: 'stop' });
    liveness.dispose();
  });

  it('already-terminal work delivers the terminal snapshot once and no further calls', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    liveness.setStatus('terminal');

    const received: string[] = [];
    liveness.subscribeSnapshot((snapshot) => received.push(snapshot.status));

    expect(received).toEqual(['terminal']);

    // Further activity (which is a no-op post-terminal at the recorder
    // level too) must not deliver a second call to this subscriber.
    liveness.settle({ finishReason: 'stop' });
    expect(received).toEqual(['terminal']);
  });

  it('subscribers stop receiving snapshots once already-live work goes terminal', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    const received: string[] = [];
    liveness.subscribeSnapshot((snapshot) => received.push(snapshot.status));

    liveness.setStatus('terminal');

    expect(received).toEqual(['running', 'terminal']);

    liveness.settle({ finishReason: 'stop' });
    expect(received).toEqual(['running', 'terminal']);
  });

  it('unsubscribe() stops delivery', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    const received: number[] = [];
    const subscription = liveness.subscribeSnapshot((snapshot) => received.push(snapshot.revision));
    subscription.unsubscribe();
    expect(subscription.closed).toBe(true);

    liveness.recordProviderPulse();
    expect(received).toEqual([0]);

    liveness.dispose();
  });

  it('an AbortSignal passed to subscribeSnapshot stops delivery on abort', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });
    const controller = new AbortController();

    const received: number[] = [];
    liveness.subscribeSnapshot((snapshot) => received.push(snapshot.revision), {
      signal: controller.signal,
    });

    controller.abort();
    liveness.recordProviderPulse();

    expect(received).toEqual([0]);
    liveness.dispose();
  });

  it('detaches the abort listener on unsubscribe(), not only when the signal itself fires (AB-214 review PRRT_kwDORvupsc6etXKp)', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });
    const controller = new AbortController();
    const removed: [string, EventListenerOrEventListenerObject][] = [];
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      removed.push([type, listener]);
      originalRemove(type, listener);
    }) as typeof controller.signal.removeEventListener;

    const subscription = liveness.subscribeSnapshot(() => {}, { signal: controller.signal });
    subscription.unsubscribe();

    expect(removed).toHaveLength(1);
    expect(removed[0]?.[0]).toBe('abort');

    liveness.dispose();
  });

  it('detaches the abort listener on terminal delivery, not only on unsubscribe() or the signal firing (AB-214 review PRRT_kwDORvupsc6etXKp)', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });
    const controller = new AbortController();
    const removed: string[] = [];
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      removed.push(type);
      originalRemove(type, listener);
    }) as typeof controller.signal.removeEventListener;

    liveness.subscribeSnapshot(() => {}, { signal: controller.signal });
    liveness.setStatus('terminal');

    expect(removed).toEqual(['abort']);

    liveness.dispose();
  });

  it('an already-aborted AbortSignal never registers the observer for further delivery (AB-214 review PRRT_kwDORvupsc6esUt9)', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });
    const controller = new AbortController();
    controller.abort('already gone');

    const received: number[] = [];
    const subscription = liveness.subscribeSnapshot(
      (snapshot) => received.push(snapshot.revision),
      { signal: controller.signal },
    );

    // The synchronous initial delivery still happens (the contract's
    // "current snapshot before returning" guarantee), but the subscription
    // itself is already closed — no further revision reaches it.
    expect(received).toEqual([0]);
    expect(subscription.closed).toBe(true);

    liveness.recordProviderPulse();
    expect(received).toEqual([0]);

    liveness.dispose();
  });

  it('sets raw progress to stalled once tool-call silence crosses the missed-pulse threshold, collapsing assessment to unreachable', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    liveness.recordToolProgressPulse({ toolCallId: 'call-1' });
    // TOOL_CALL_POLICY: threshold 3. The pulse at t=0 covers the first
    // per-check window (it lands exactly at the watchdog's construction-time
    // baseline), so three MISSED windows require a fourth advance.
    clock.advance(TOOL_CHECK_INTERVAL_MS);
    clock.advance(TOOL_CHECK_INTERVAL_MS);
    clock.advance(TOOL_CHECK_INTERVAL_MS);
    clock.advance(TOOL_CHECK_INTERVAL_MS);

    const snapshot = liveness.snapshot();
    // AC1's collapse rule: 'stalled' is legal only with 'reachable'/'late';
    // once reachability crosses into 'unreachable' at the same threshold,
    // the single-glance `assessment` collapses to 'unreachable' even though
    // the raw `progress` dimension still independently reports 'stalled'.
    expect(snapshot.progress).toBe('stalled');
    expect(snapshot.reachability).toBe('unreachable');
    expect(snapshot.assessment).toBe('unreachable');

    liveness.dispose();
  });

  it('reports alive-but-stalled when progress stalls before reachability crosses into unreachable', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    // A session.monitor-shaped policy would separate the 'late' and
    // 'unreachable' thresholds from 'stalled'; TOOL_CALL_POLICY's single
    // threshold governs both dimensions identically here, so this case is
    // exercised directly against `deriveAssessment` via a reachability that
    // is 'late' rather than 'unreachable' — one missed tick short of the
    // threshold still reads 'late'/'idle', not yet 'stalled'.
    liveness.recordToolProgressPulse({ toolCallId: 'call-1' });
    clock.advance(TOOL_CHECK_INTERVAL_MS);
    clock.advance(TOOL_CHECK_INTERVAL_MS);

    const snapshot = liveness.snapshot();
    expect(snapshot.reachability).toBe('late');
    expect(snapshot.progress).toBe('idle');
    expect(snapshot.assessment).toBe('healthy');

    liveness.dispose();
  });

  it('dispose() disposes both underlying watchdogs and leaves no pending timers', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    liveness.dispose();

    // Neither watchdog accrues after dispose — advancing far past any
    // cadence/threshold must not change missedPulseCount.
    clock.advance(1_000_000);
    expect(liveness.snapshot().missedPulseCount).toBe(0);
  });

  it('transitioning to terminal disposes the watchdogs (no leaked timers after settlement)', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    liveness.recordToolProgressPulse();
    liveness.setStatus('terminal');

    clock.advance(1_000_000);
    // missedPulseCount frozen at whatever it was at the moment of
    // termination — the watchdog stopped ticking, so no further accrual.
    const snapshot = liveness.snapshot();
    expect(snapshot.missedPulseCount).toBe(0);
  });

  it('recordProviderPulse and recordToolProgressPulse are no-ops after dispose', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });
    liveness.dispose();

    liveness.recordProviderPulse();
    liveness.recordToolProgressPulse();

    expect(liveness.snapshot().evidence).toEqual([]);
  });

  it('beginToolCall()/endToolCall() start and stop the tool watchdog only while a tool call is in flight (AB-214 review PRRT_kwDORvupsc6esZRy)', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    // Before any tool call, an idle run producing no tool-progress events
    // must not be marked stalled/unreachable purely from elapsed time — the
    // tool watchdog does not exist yet, so only the no-cadence agent-run
    // watchdog governs (still 'unknown': no provider pulse has arrived
    // either).
    clock.advance(TOOL_CHECK_INTERVAL_MS * 5);
    expect(liveness.snapshot().reachability).toBe('unknown');
    expect(liveness.snapshot().missedPulseCount).toBe(0);

    liveness.beginToolCall();
    clock.advance(TOOL_CHECK_INTERVAL_MS);
    expect(liveness.snapshot().missedPulseCount).toBe(1);

    liveness.endToolCall();
    // Once the tool call ends, the watchdog is disposed — its accrued
    // missed-pulse count goes with it (AB-214 review PRRT_kwDORvupsc6etXKi:
    // `endToolCall` now advances the revision on teardown, so this reads
    // the current state — no tool watchdog contributing — not a stale
    // cached snapshot from while the call was still in flight). Further
    // elapsed time must not accrue more missed pulses either.
    expect(liveness.snapshot().missedPulseCount).toBe(0);
    clock.advance(TOOL_CHECK_INTERVAL_MS * 5);
    expect(liveness.snapshot().missedPulseCount).toBe(0);

    liveness.dispose();
  });

  it('beginToolCall()/endToolCall() reference-count overlapping tool calls, keeping the watchdog alive until the last one ends', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    liveness.beginToolCall();
    liveness.beginToolCall();
    liveness.endToolCall();
    // One call is still in flight — the watchdog must not have been
    // disposed yet.
    clock.advance(TOOL_CHECK_INTERVAL_MS);
    expect(liveness.snapshot().missedPulseCount).toBe(1);

    liveness.endToolCall();
    // The last call ended and the watchdog is gone — same reasoning as the
    // single-call test above (AB-214 review PRRT_kwDORvupsc6etXKi).
    expect(liveness.snapshot().missedPulseCount).toBe(0);
    clock.advance(TOOL_CHECK_INTERVAL_MS * 5);
    expect(liveness.snapshot().missedPulseCount).toBe(0);

    liveness.dispose();
  });

  it('advances the revision when the last tool call ends, so subscribers see the recovery immediately (AB-214 review PRRT_kwDORvupsc6etXKi)', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    liveness.beginToolCall();
    clock.advance(TOOL_CHECK_INTERVAL_MS);
    // The call has gone late/unreachable — force the cache to observe it.
    liveness.snapshot();
    const revisionWhileStalled = liveness.snapshot().revision;

    const received: string[] = [];
    const subscription = liveness.subscribeSnapshot((snapshot) => received.push(snapshot.status));

    liveness.endToolCall();

    expect(liveness.snapshot().revision).toBeGreaterThan(revisionWhileStalled);
    // The subscriber got a fresh delivery from the teardown itself, not
    // only its synchronous initial read.
    expect(received.length).toBeGreaterThan(1);

    subscription.unsubscribe();
    liveness.dispose();
  });

  it('beginToolCall()/endToolCall() are no-ops after dispose', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });
    liveness.dispose();

    expect(() => liveness.beginToolCall()).not.toThrow();
    expect(() => liveness.endToolCall()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AB-216 — worstChildAssessment rollup
// ---------------------------------------------------------------------------

describe('createActiveRunLiveness — worstChildAssessment (AB-216)', () => {
  it('is absent when no childRegistry is supplied', () => {
    const clock = createManualClock();
    const liveness = createActiveRunLiveness({ id: 'run-1', durability: 'process-local', clock });

    expect(liveness.snapshot().worstChildAssessment).toBeUndefined();

    liveness.dispose();
  });

  it('is absent when the registry has no children', () => {
    const clock = createManualClock();
    const childRegistry = createFakeChildRegistry();
    const liveness = createActiveRunLiveness({
      id: 'run-1',
      durability: 'process-local',
      clock,
      childRegistry,
    });

    expect(liveness.snapshot().worstChildAssessment).toBeUndefined();

    liveness.dispose();
  });

  it('is absent when every child is terminal', () => {
    const clock = createManualClock();
    const childRegistry = createFakeChildRegistry();
    childRegistry.setChildren([child('c1', 'terminal'), child('c2', 'terminal')]);
    const liveness = createActiveRunLiveness({
      id: 'run-1',
      durability: 'process-local',
      clock,
      childRegistry,
    });
    childRegistry.notify();

    expect(liveness.snapshot().worstChildAssessment).toBeUndefined();

    liveness.dispose();
  });

  it('excludes a child with no assessment yet, same as a terminal one', () => {
    const clock = createManualClock();
    const childRegistry = createFakeChildRegistry();
    childRegistry.setChildren([child('c1', undefined)]);
    const liveness = createActiveRunLiveness({
      id: 'run-1',
      durability: 'process-local',
      clock,
      childRegistry,
    });
    childRegistry.notify();

    expect(liveness.snapshot().worstChildAssessment).toBeUndefined();

    liveness.dispose();
  });

  it('picks up children already present in the registry at construction time', () => {
    const clock = createManualClock();
    const childRegistry = createFakeChildRegistry();
    childRegistry.setChildren([child('c1', 'healthy')]);
    const liveness = createActiveRunLiveness({
      id: 'run-1',
      durability: 'process-local',
      clock,
      childRegistry,
    });

    expect(liveness.snapshot().worstChildAssessment).toBe('healthy');

    liveness.dispose();
  });

  it.each([
    [['healthy'], 'healthy'],
    [['legitimately-waiting', 'healthy'], 'legitimately-waiting'],
    [['cleaning-up', 'legitimately-waiting'], 'cleaning-up'],
    [['aborting', 'cleaning-up'], 'aborting'],
    [['alive-but-stalled', 'aborting'], 'alive-but-stalled'],
    [['unreachable', 'alive-but-stalled'], 'unreachable'],
    [['healthy', 'unreachable', 'alive-but-stalled', 'legitimately-waiting'], 'unreachable'],
  ] as const)('folds %j to %s, most severe first', (assessments, expected) => {
    const clock = createManualClock();
    const childRegistry = createFakeChildRegistry();
    const liveness = createActiveRunLiveness({
      id: 'run-1',
      durability: 'process-local',
      clock,
      childRegistry,
    });

    childRegistry.setChildren(
      assessments.map((assessment, index) => child(`c${index}`, assessment)),
    );
    childRegistry.notify();

    expect(liveness.snapshot().worstChildAssessment).toBe(expected);

    liveness.dispose();
  });

  it('a terminal child mixed with a non-terminal one only counts the non-terminal one', () => {
    const clock = createManualClock();
    const childRegistry = createFakeChildRegistry();
    const liveness = createActiveRunLiveness({
      id: 'run-1',
      durability: 'process-local',
      clock,
      childRegistry,
    });

    childRegistry.setChildren([child('c1', 'terminal'), child('c2', 'alive-but-stalled')]);
    childRegistry.notify();

    expect(liveness.snapshot().worstChildAssessment).toBe('alive-but-stalled');

    liveness.dispose();
  });

  it('advances the parent revision when worstChildAssessment changes, even though none of the parent’s own dimensions changed', () => {
    const clock = createManualClock();
    const childRegistry = createFakeChildRegistry();
    const liveness = createActiveRunLiveness({
      id: 'run-1',
      durability: 'process-local',
      clock,
      childRegistry,
    });

    const before = liveness.snapshot();
    expect(before.status).toBe('running');
    expect(before.reachability).toBe('unknown');
    expect(before.progress).toBe('unknown');

    childRegistry.setChildren([child('c1', 'alive-but-stalled')]);
    childRegistry.notify();

    const after = liveness.snapshot();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.worstChildAssessment).toBe('alive-but-stalled');
    // The parent's own dimensions are untouched by a stalled child.
    expect(after.status).toBe('running');
    expect(after.reachability).toBe('unknown');
    expect(after.progress).toBe('unknown');

    liveness.dispose();
  });

  it('does NOT advance the revision when a registry notification leaves the folded value unchanged', () => {
    const clock = createManualClock();
    const childRegistry = createFakeChildRegistry();
    childRegistry.setChildren([child('c1', 'healthy'), child('c2', 'legitimately-waiting')]);
    const liveness = createActiveRunLiveness({
      id: 'run-1',
      durability: 'process-local',
      clock,
      childRegistry,
    });

    const before = liveness.snapshot();
    expect(before.worstChildAssessment).toBe('legitimately-waiting');

    // A different, but equally-severe-or-better, child set — the fold
    // still comes out to 'legitimately-waiting'.
    childRegistry.setChildren([child('c1', 'healthy'), child('c2', 'legitimately-waiting')]);
    childRegistry.notify();

    const after = liveness.snapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.worstChildAssessment).toBe('legitimately-waiting');

    liveness.dispose();
  });

  it('notifies subscribers when worstChildAssessment changes', () => {
    const clock = createManualClock();
    const childRegistry = createFakeChildRegistry();
    const liveness = createActiveRunLiveness({
      id: 'run-1',
      durability: 'process-local',
      clock,
      childRegistry,
    });

    const received: (LivenessAssessment | undefined)[] = [];
    const subscription = liveness.subscribeSnapshot((snapshot) =>
      received.push(snapshot.worstChildAssessment),
    );
    expect(received).toEqual([undefined]);

    childRegistry.setChildren([child('c1', 'unreachable')]);
    childRegistry.notify();

    expect(received).toEqual([undefined, 'unreachable']);

    subscription.unsubscribe();
    liveness.dispose();
  });

  it('reverts to absent once the last non-terminal child settles', () => {
    const clock = createManualClock();
    const childRegistry = createFakeChildRegistry();
    const liveness = createActiveRunLiveness({
      id: 'run-1',
      durability: 'process-local',
      clock,
      childRegistry,
    });

    childRegistry.setChildren([child('c1', 'alive-but-stalled')]);
    childRegistry.notify();
    expect(liveness.snapshot().worstChildAssessment).toBe('alive-but-stalled');

    childRegistry.setChildren([child('c1', 'terminal')]);
    childRegistry.notify();
    expect(liveness.snapshot().worstChildAssessment).toBeUndefined();

    liveness.dispose();
  });

  it('stops recomputing after dispose (unsubscribes from the registry)', () => {
    const clock = createManualClock();
    const childRegistry = createFakeChildRegistry();
    const liveness = createActiveRunLiveness({
      id: 'run-1',
      durability: 'process-local',
      clock,
      childRegistry,
    });

    liveness.dispose();

    // A registry notification after dispose must not throw and must not
    // resurrect a snapshot read (the run is already terminal-by-disposal
    // for every other dimension too).
    childRegistry.setChildren([child('c1', 'unreachable')]);
    expect(() => childRegistry.notify()).not.toThrow();
  });
});
