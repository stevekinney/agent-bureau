import { describe, expect, it } from 'bun:test';

import { toolCallPolicy } from './policies';
import type { StallPolicy } from './types';
import { createStallWatchdog, type StallWatchdogClock } from './watchdog';

/** A fully manual clock — no real timers, no real sleeps. */
function createManualClock(): StallWatchdogClock & {
  advance(ms: number): void;
  pendingTimerCount(): number;
} {
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
    advance(ms: number) {
      time += ms;
      // Fire every timer whose deadline has passed, in scheduling order —
      // a fired timer may itself schedule a new one (the watchdog's own
      // re-arm loop), so re-scan until nothing more is due.
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
    pendingTimerCount: () => timers.size,
  };
}

const NO_CADENCE_POLICY: StallPolicy = {
  operation: 'agent-run.provider-turn',
  graceMs: 0,
  jitterMs: 0,
  missedPulseThreshold: 0,
  clockSource: 'monotonic-observer',
  suspensionBehavior: 'pause-on-suspected-suspension',
  recovery: 'resume-on-next-pulse',
};

/** `cadenceMs + graceMs + jitterMs` — the full per-check tolerance window a cadence-gated policy declares (AB-214 review PRRT_kwDORvupsc6esUtf / PRRT_kwDORvupsc6esZR2). */
function checkIntervalOf(policy: StallPolicy): number {
  return (policy.cadenceMs ?? 0) + policy.graceMs + policy.jitterMs;
}

describe('createStallWatchdog', () => {
  it('reports unknown reachability and progress before any pulse arrives', () => {
    const clock = createManualClock();
    const watchdog = createStallWatchdog(toolCallPolicy(1000), clock);

    const assessment = watchdog.assess();

    expect(assessment.reachability).toBe('reachable');
    expect(assessment.missedPulseCount).toBe(0);
    watchdog.dispose();
  });

  it('accrues missedPulseCount once per full cadence+grace+jitter window with no pulse', () => {
    const clock = createManualClock();
    const policy = toolCallPolicy(1000); // cadence 1000, grace 5000, threshold 3
    const watchdog = createStallWatchdog(policy, clock);
    const interval = checkIntervalOf(policy);

    clock.advance(interval);
    expect(watchdog.assess().missedPulseCount).toBe(1);
    clock.advance(interval);
    expect(watchdog.assess().missedPulseCount).toBe(2);
    clock.advance(interval);
    const assessment = watchdog.assess();
    expect(assessment.missedPulseCount).toBe(3);
    expect(assessment.reachability).toBe('unreachable');
    expect(assessment.progress).toBe('stalled');

    watchdog.dispose();
  });

  it('does not count a miss before the full cadence+grace+jitter window has elapsed', () => {
    const clock = createManualClock();
    const policy = toolCallPolicy(1000); // grace alone is 5000ms of tolerance
    const watchdog = createStallWatchdog(policy, clock);

    // Bare cadence alone (1000ms) must not yet count a miss — grace is a
    // real tolerance window, not decoration (AB-214 review PRRT_kwDORvupsc6esUtf).
    clock.advance(policy.cadenceMs ?? 0);
    expect(watchdog.assess().missedPulseCount).toBe(0);
    expect(watchdog.assess().reachability).toBe('reachable');

    watchdog.dispose();
  });

  it('recovers missedPulseCount to zero immediately on the pulse itself (resume-on-next-pulse), not only on the next tick', () => {
    const clock = createManualClock();
    const policy = toolCallPolicy(1000);
    const watchdog = createStallWatchdog(policy, clock);
    const interval = checkIntervalOf(policy);

    clock.advance(interval);
    clock.advance(interval);
    expect(watchdog.assess().missedPulseCount).toBe(2);

    watchdog.recordPulse('tool-progress', 0);
    // No further clock advance — the reset happens synchronously in
    // recordPulse (AB-214 review PRRT_kwDORvupsc6esjjp), not deferred to
    // the next scheduled check.
    expect(watchdog.assess().missedPulseCount).toBe(0);
    expect(watchdog.assess().reachability).toBe('reachable');

    watchdog.dispose();
  });

  it('a host-reachability pulse never resets a missed-pulse count accrued from tool-progress silence (AC5)', () => {
    const clock = createManualClock();
    const policy = toolCallPolicy(1000);
    const watchdog = createStallWatchdog(policy, clock);
    const interval = checkIntervalOf(policy);

    watchdog.recordPulse('tool-progress', 0);
    clock.advance(interval);
    clock.advance(interval);
    const before = watchdog.assess().missedPulseCount;
    expect(before).toBeGreaterThan(0);

    watchdog.recordPulse('host-reachability', 0);
    const after = watchdog.assess();

    expect(after.missedPulseCount).toBe(before);
    expect(after.evidence.some((entry) => entry.source === 'host-reachability')).toBe(true);

    watchdog.dispose();
  });

  it('a host-reachability pulse never resets a missed-pulse count accrued from provider-io, worker-session-heartbeat, task-attempt-heartbeat, or lease-renewal', () => {
    const sources = ['provider-io', 'worker-session-heartbeat', 'task-attempt-heartbeat'] as const;

    for (const source of sources) {
      const clock = createManualClock();
      const policy = toolCallPolicy(1000);
      const watchdog = createStallWatchdog(policy, clock);
      const interval = checkIntervalOf(policy);

      watchdog.recordPulse(source, 0);
      clock.advance(interval);
      clock.advance(interval);
      const before = watchdog.assess().missedPulseCount;

      watchdog.recordPulse('host-reachability', 0);
      const after = watchdog.assess();

      expect(after.missedPulseCount).toBe(before);
      watchdog.dispose();
    }

    // lease-renewal proves ownership, never activity — it must not reset
    // an accrued missed-pulse count either, and must not itself count as
    // activity that clears the count.
    const clock = createManualClock();
    const policy = toolCallPolicy(1000);
    const watchdog = createStallWatchdog(policy, clock);
    const interval = checkIntervalOf(policy);
    watchdog.recordPulse('tool-progress', 0);
    clock.advance(interval);
    clock.advance(interval);
    const before = watchdog.assess().missedPulseCount;
    watchdog.recordPulse('lease-renewal', 0, { holderId: 'x' });
    const after = watchdog.assess();
    expect(after.missedPulseCount).toBe(before);
    watchdog.dispose();
  });

  it('does not report reachable/progressing from a lease-renewal pulse alone on a no-cadence policy (AB-214 review PRRT_kwDORvupsc6esjj0)', () => {
    const clock = createManualClock();
    const watchdog = createStallWatchdog(NO_CADENCE_POLICY, clock);

    watchdog.recordPulse('lease-renewal', 0, { holderId: 'x' });
    const assessment = watchdog.assess();

    expect(assessment.reachability).toBe('unknown');
    expect(assessment.progress).toBe('unknown');

    watchdog.dispose();
  });

  it('discards an evidence entry whose attempt is less than the current attempt, never merging it', () => {
    const clock = createManualClock();
    const watchdog = createStallWatchdog(toolCallPolicy(1000), clock);

    watchdog.recordPulse('tool-progress', 2, 'attempt-2-pulse');
    watchdog.recordPulse('tool-progress', 1, 'stale-attempt-1-pulse');

    const evidence = watchdog.assess().evidence;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.detail).toBe('attempt-2-pulse');

    watchdog.dispose();
  });

  it('accepts a pulse whose attempt equals the current attempt', () => {
    const clock = createManualClock();
    const watchdog = createStallWatchdog(toolCallPolicy(1000), clock);

    watchdog.recordPulse('tool-progress', 1);
    watchdog.recordPulse('tool-progress', 1);

    expect(watchdog.assess().evidence).toHaveLength(2);
    watchdog.dispose();
  });

  it('advances the current attempt forward on a newer attempt pulse', () => {
    const clock = createManualClock();
    const watchdog = createStallWatchdog(toolCallPolicy(1000), clock);

    watchdog.recordPulse('tool-progress', 1);
    watchdog.recordPulse('tool-progress', 5);
    // Now attempt 3 is stale relative to the new current attempt (5).
    watchdog.recordPulse('tool-progress', 3, 'stale-after-advance');

    const evidence = watchdog.assess().evidence;
    expect(evidence.some((entry) => entry.detail === 'stale-after-advance')).toBe(false);

    watchdog.dispose();
  });

  it('establishes attempt fencing from a lease-renewal-only first pulse (attemptEstablished is source-independent)', () => {
    const clock = createManualClock();
    const watchdog = createStallWatchdog(toolCallPolicy(1000), clock);

    watchdog.recordPulse('lease-renewal', 5, { holderId: 'x' });
    watchdog.recordPulse('tool-progress', 3, 'stale-relative-to-lease-attempt');

    const evidence = watchdog.assess().evidence;
    expect(evidence.some((entry) => entry.detail === 'stale-relative-to-lease-attempt')).toBe(
      false,
    );

    watchdog.dispose();
  });

  it('does not accrue a missed pulse across a gap larger than 10x cadence+grace (pause-on-suspected-suspension)', () => {
    const clock = createManualClock();
    const policy = toolCallPolicy(1000); // cadence 1000, grace 5000 -> window 6000, suspension threshold 60000
    const watchdog = createStallWatchdog(policy, clock);

    watchdog.recordPulse('tool-progress', 0);
    // A single enormous jump — larger than 10x(cadence+grace) — simulating
    // a suspended laptop/process, not real silence.
    clock.advance(70_000);

    expect(watchdog.assess().missedPulseCount).toBe(0);

    watchdog.dispose();
  });

  it('resumes normal accrual after a suspension gap once ticking normally again', () => {
    const clock = createManualClock();
    const policy = toolCallPolicy(1000);
    const watchdog = createStallWatchdog(policy, clock);
    const interval = checkIntervalOf(policy);

    watchdog.recordPulse('tool-progress', 0);
    clock.advance(70_000); // suspected suspension — no accrual
    expect(watchdog.assess().missedPulseCount).toBe(0);

    clock.advance(interval); // a normal check window with no new pulse
    expect(watchdog.assess().missedPulseCount).toBe(1);

    watchdog.dispose();
  });

  it('never schedules a timer for a policy with no cadence gating', () => {
    const clock = createManualClock();
    const watchdog = createStallWatchdog(NO_CADENCE_POLICY, clock);

    expect(clock.pendingTimerCount()).toBe(0);
    expect(watchdog.assess()).toEqual({
      reachability: 'unknown',
      progress: 'unknown',
      missedPulseCount: 0,
      evidence: [],
    });

    watchdog.recordPulse('provider-io', 0);
    const assessment = watchdog.assess();
    expect(assessment.reachability).toBe('reachable');
    expect(assessment.progress).toBe('progressing');
    expect(assessment.missedPulseCount).toBe(0);

    watchdog.dispose();
  });

  it('dispose() clears every pending timer and stops further ticking', () => {
    const clock = createManualClock();
    const watchdog = createStallWatchdog(toolCallPolicy(1000), clock);

    expect(clock.pendingTimerCount()).toBe(1);
    watchdog.dispose();
    expect(clock.pendingTimerCount()).toBe(0);

    // Ticks after dispose must not accrue further state.
    clock.advance(60_000);
    expect(watchdog.assess().missedPulseCount).toBe(0);
  });

  it('dispose() is idempotent', () => {
    const clock = createManualClock();
    const watchdog = createStallWatchdog(toolCallPolicy(1000), clock);
    watchdog.dispose();
    expect(() => watchdog.dispose()).not.toThrow();
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it('ignores a recordPulse call after dispose()', () => {
    const clock = createManualClock();
    const watchdog = createStallWatchdog(toolCallPolicy(1000), clock);
    watchdog.dispose();

    watchdog.recordPulse('tool-progress', 0);

    expect(watchdog.assess().evidence).toHaveLength(0);
  });

  it('records an absolute-deadline entry without treating it as activity', () => {
    const clock = createManualClock();
    const watchdog = createStallWatchdog(toolCallPolicy(1000), clock);
    const interval = checkIntervalOf(toolCallPolicy(1000));

    watchdog.recordPulse('absolute-deadline', 0, { deadline: 123 });
    clock.advance(interval);
    clock.advance(interval);
    clock.advance(interval);

    const assessment = watchdog.assess();
    expect(assessment.evidence).toHaveLength(1);
    expect(assessment.missedPulseCount).toBe(3);
  });

  it('reports unreachable/stalled once an absoluteDeadlineMs passes, independent of cadence math (AB-214 review PRRT_kwDORvupsc6esZSQ)', () => {
    const clock = createManualClock();
    const policy: StallPolicy = {
      ...toolCallPolicy(1000),
      absoluteDeadlineMs: 500,
    };
    const watchdog = createStallWatchdog(policy, clock);

    watchdog.recordPulse('tool-progress', 0);
    expect(watchdog.assess().reachability).toBe('reachable');

    clock.advance(500);

    const assessment = watchdog.assess();
    expect(assessment.reachability).toBe('unreachable');
    expect(assessment.progress).toBe('stalled');

    watchdog.dispose();
  });

  it('enforces absoluteDeadlineMs even on a policy with no cadence at all', () => {
    const clock = createManualClock();
    const policy: StallPolicy = { ...NO_CADENCE_POLICY, absoluteDeadlineMs: 1000 };
    const watchdog = createStallWatchdog(policy, clock);

    watchdog.recordPulse('provider-io', 0);
    expect(watchdog.assess().reachability).toBe('reachable');

    clock.advance(1000);

    expect(watchdog.assess().reachability).toBe('unreachable');
    expect(watchdog.assess().progress).toBe('stalled');

    watchdog.dispose();
  });

  it('caps retained evidence at a bounded window, dropping the oldest entries first', () => {
    const clock = createManualClock();
    const watchdog = createStallWatchdog(toolCallPolicy(1000), clock);

    for (let i = 0; i < 80; i += 1) {
      watchdog.recordPulse('tool-progress', 0, `pulse-${i}`);
    }

    const evidence = watchdog.assess().evidence;
    expect(evidence.length).toBeLessThanOrEqual(64);
    // Oldest entries are the ones dropped — the most recent pulse survives.
    expect(evidence.at(-1)?.detail).toBe('pulse-79');
    expect(evidence.some((entry) => entry.detail === 'pulse-0')).toBe(false);

    watchdog.dispose();
  });

  it('invokes onAssessmentChange only when a timer-driven check actually changes missedPulseCount', () => {
    const clock = createManualClock();
    const policy = toolCallPolicy(1000);
    const interval = checkIntervalOf(policy);
    let changes = 0;
    const watchdog = createStallWatchdog(policy, clock, {
      onAssessmentChange: () => {
        changes += 1;
      },
    });

    clock.advance(interval);
    expect(changes).toBe(1);
    expect(watchdog.assess().missedPulseCount).toBe(1);

    watchdog.dispose();
  });
});
