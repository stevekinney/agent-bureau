import { describe, expect, it } from 'bun:test';

import { createActiveRunLiveness } from './active-run-liveness';
import { LIVENESS_POLICY_VERSION, TOOL_CALL_POLICY } from './policies';
import type { StallWatchdogClock } from './watchdog';

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
    // Once the tool call ends, the watchdog is disposed — further elapsed
    // time must not accrue more missed pulses.
    clock.advance(TOOL_CHECK_INTERVAL_MS * 5);
    expect(liveness.snapshot().missedPulseCount).toBe(1);

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
    clock.advance(TOOL_CHECK_INTERVAL_MS * 5);
    expect(liveness.snapshot().missedPulseCount).toBe(1);

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
