import type { ActivityContext } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { TOOL_CALL_POLICY, WEFT_ACTIVITY_POLICY } from '../liveness/policies';
import type { StallWatchdogClock } from '../liveness/watchdog';
import {
  createToolCallLivenessWatchdog,
  recordToolCallProgress,
  selectToolCallClockSource,
  selectToolCallStallPolicy,
} from './tool-activity-liveness';

function createManualClock(): StallWatchdogClock & { advance(ms: number): void } {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextHandle = 1;
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
  };
}

function createFakeActivityContext(
  overrides: Partial<ActivityContext> = {},
): ActivityContext & { heartbeatCalls: unknown[] } {
  const heartbeatCalls: unknown[] = [];
  return {
    signal: new AbortController().signal,
    activityAttemptToken: 'attempt-token-1',
    heartbeat(details?: unknown) {
      heartbeatCalls.push(details);
    },
    completeAsync(): never {
      throw new Error('not implemented in test double');
    },
    heartbeatCalls,
    ...overrides,
  };
}

describe('selectToolCallClockSource', () => {
  it("returns 'wall-clock-owner' when the ActivityContext carries a defined activityAttemptToken", () => {
    const context = createFakeActivityContext({ activityAttemptToken: 'token-a' });
    expect(selectToolCallClockSource(context)).toBe('wall-clock-owner');
  });

  it("returns 'monotonic-observer' when no ActivityContext is present", () => {
    expect(selectToolCallClockSource(undefined)).toBe('monotonic-observer');
  });

  it("returns 'monotonic-observer' when the ActivityContext's activityAttemptToken is undefined", () => {
    const context = createFakeActivityContext({ activityAttemptToken: undefined });
    expect(selectToolCallClockSource(context)).toBe('monotonic-observer');
  });

  it('never infers the selection from a tool name or configuration argument', () => {
    // selectToolCallClockSource's signature accepts only the ActivityContext —
    // there is no tool-name or config parameter for a caller to (mis)use.
    expect(selectToolCallClockSource.length).toBe(1);
  });
});

describe('selectToolCallStallPolicy', () => {
  it('selects WEFT_ACTIVITY_POLICY verbatim when activity-backed', () => {
    const context = createFakeActivityContext();
    const policy = selectToolCallStallPolicy(context);
    expect(policy).toBe(WEFT_ACTIVITY_POLICY);
    expect(policy.clockSource).toBe('wall-clock-owner');
    expect(policy.recovery).toBe('requires-explicit-recovered-transition');
  });

  it('selects the default tool-call policy when not activity-backed', () => {
    const policy = selectToolCallStallPolicy(undefined);
    expect(policy.operation).toBe(TOOL_CALL_POLICY.operation);
    expect(policy.clockSource).toBe('monotonic-observer');
    expect(policy.cadenceMs).toBe(TOOL_CALL_POLICY.cadenceMs);
  });

  it('honors a tool-declared cadence override when not activity-backed', () => {
    const policy = selectToolCallStallPolicy(undefined, 5000);
    expect(policy.cadenceMs).toBe(5000);
  });

  it('ignores a supplied cadence override when activity-backed (Weft owns cadence)', () => {
    const context = createFakeActivityContext();
    const policy = selectToolCallStallPolicy(context, 5000);
    expect(policy.cadenceMs).toBeUndefined();
  });
});

describe('createToolCallLivenessWatchdog', () => {
  it('builds a non-cadence-gated watchdog for an activity-backed tool call (no competing local timer)', () => {
    const clock = createManualClock();
    const context = createFakeActivityContext();
    const { watchdog, clockSource, policy } = createToolCallLivenessWatchdog(context, clock);
    expect(clockSource).toBe('wall-clock-owner');
    expect(policy).toBe(WEFT_ACTIVITY_POLICY);

    // No cadence => assess() reports 'unknown' until a real pulse arrives,
    // and advancing the clock alone never accrues missed pulses (no timer
    // was ever scheduled against this policy).
    expect(watchdog.assess().reachability).toBe('unknown');
    clock.advance(10 * 60 * 1000);
    expect(watchdog.assess().missedPulseCount).toBe(0);
    watchdog.dispose();
  });

  it('builds a cadence-gated watchdog for a non-activity tool call, exactly as today', () => {
    const clock = createManualClock();
    const { watchdog, clockSource } = createToolCallLivenessWatchdog(undefined, clock);
    expect(clockSource).toBe('monotonic-observer');

    watchdog.recordPulse('tool-progress', 1);
    expect(watchdog.assess().reachability).toBe('reachable');

    const tolerance =
      (TOOL_CALL_POLICY.cadenceMs ?? 0) + TOOL_CALL_POLICY.graceMs + TOOL_CALL_POLICY.jitterMs;
    for (let i = 0; i < TOOL_CALL_POLICY.missedPulseThreshold + 1; i += 1) {
      clock.advance(tolerance);
    }
    expect(watchdog.assess().reachability).toBe('unreachable');
    watchdog.dispose();
  });
});

describe('recordToolCallProgress', () => {
  it('forwards progress({ checkpoint }) to ActivityContext.heartbeat with the checkpoint verbatim when activity-backed', () => {
    const clock = createManualClock();
    const context = createFakeActivityContext();
    const { watchdog } = createToolCallLivenessWatchdog(context, clock);

    recordToolCallProgress(context, watchdog, 1, { checkpoint: { done: 3 } });

    expect(context.heartbeatCalls).toEqual([{ done: 3 }]);
  });

  it('forwards the whole update to ActivityContext.heartbeat when checkpoint is absent', () => {
    const clock = createManualClock();
    const context = createFakeActivityContext();
    const { watchdog } = createToolCallLivenessWatchdog(context, clock);

    recordToolCallProgress(context, watchdog, 1, { percent: 50, message: 'halfway' });

    expect(context.heartbeatCalls).toEqual([{ percent: 50, message: 'halfway' }]);
  });

  it('records the forwarded heartbeat as task-attempt-heartbeat evidence on the local watchdog', () => {
    const clock = createManualClock();
    const context = createFakeActivityContext();
    const { watchdog } = createToolCallLivenessWatchdog(context, clock);

    recordToolCallProgress(context, watchdog, 3, { checkpoint: { done: 1 } });

    const evidence = watchdog.assess().evidence;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      source: 'task-attempt-heartbeat',
      attempt: 3,
      detail: { done: 1 },
    });
  });

  it('never forwards to Weft for a non-activity tool call, and records tool-progress evidence instead', () => {
    const clock = createManualClock();
    const { watchdog } = createToolCallLivenessWatchdog(undefined, clock);

    recordToolCallProgress(undefined, watchdog, 1, { percent: 10 });

    const evidence = watchdog.assess().evidence;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.source).toBe('tool-progress');
  });

  it("never forwards to Weft when the ActivityContext's token is undefined (not truly activity-backed)", () => {
    const clock = createManualClock();
    const context = createFakeActivityContext({ activityAttemptToken: undefined });
    const { watchdog } = createToolCallLivenessWatchdog(context, clock);

    recordToolCallProgress(context, watchdog, 1, { percent: 10 });

    expect(context.heartbeatCalls).toHaveLength(0);
    expect(watchdog.assess().evidence[0]?.source).toBe('tool-progress');
  });
});
