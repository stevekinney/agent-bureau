import type { RuntimeServices, TypedEventTarget } from 'lifecycle';

import type { AgentRun } from '../agent-run';
import type { OperativeEventMap } from '../events';
import { SessionMonitorDoneEvent, SessionMonitorTickEvent } from '../events';
import type { DeclaredWait, StallWatchdog, StallWatchdogClock } from '../liveness';
import { createStallWatchdog, sessionMonitorPolicy } from '../liveness';
import type { RunResult } from '../types';
import type { MonitorOptions } from './session-handle-types';

const FAILURE_FINISH_REASONS = new Set([
  'error',
  'aborted',
  'budget-exceeded',
  'elicitation-denied',
  'tripwire',
]);

export interface SessionMonitorDependencies {
  sessionId: string;
  emitter: TypedEventTarget<OperativeEventMap>;
  runtime: RuntimeServices;
  livenessClock: StallWatchdogClock;
  setTimeoutFunction: (callback: () => void, milliseconds: number) => unknown;
  clearTimeoutFunction: (timer: unknown) => void;
  run: (input: string) => AgentRun;
  setLivenessState: (status: 'created' | 'running' | 'waiting', wait?: DeclaredWait) => void;
  processLocalDelay: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;
  processLocalAbortError: () => DOMException;
  parseDuration: (iso: string) => number;
  getWatchdog: () => StallWatchdog | undefined;
  setWatchdog: (watchdog: StallWatchdog | undefined) => void;
  setWatchdogCadence: (cadence: number | undefined) => void;
  advanceLiveness: () => void;
}

export function createSessionMonitor(dependencies: SessionMonitorDependencies) {
  const {
    sessionId,
    emitter,
    runtime,
    livenessClock,
    run: runAgent,
    setLivenessState,
    processLocalDelay,
    processLocalAbortError,
    parseDuration,
    getWatchdog,
    setWatchdog,
    setWatchdogCadence,
    advanceLiveness,
  } = dependencies;
  return async function monitor(options: MonitorOptions): Promise<boolean> {
    const { every, input, until, maxDuration, signal } = options;
    const everyMs = typeof every === 'number' ? every : parseDuration(every);

    // Reject string durations that parsed to 0 ms — this means the string
    // was not a recognised ISO-8601 PT duration (e.g. '5m' instead of 'PT5M').
    // Silently treating 0 ms as valid would cause a tight spin loop that issues
    // LLM calls as fast as the network allows with no inter-tick sleep.
    if (typeof every === 'string' && everyMs === 0) {
      throw new Error(
        `monitor({ every }) received an invalid duration string: "${every}". ` +
          `Use a number (milliseconds) or an ISO-8601 PT duration such as 'PT5M' or 'PT1H30M'.`,
      );
    }

    // Reject non-positive / non-finite NUMERIC intervals — the string guard
    // above only covers strings. A numeric `every` of 0, a negative value, or
    // NaN/Infinity flows through as `everyMs <= 0` (or non-finite); the
    // inter-tick sleep below is `Math.min(everyMs, remainingMs)` gated on
    // `sleepMs > 0`, so it is skipped entirely and the loop spins through
    // back-to-back agent runs and provider calls with no pause until the
    // predicate or maxDuration stops it. Require a positive, finite interval
    // (PRRT_kwDORvupsc6Mddv9).
    if (typeof every === 'number' && !(everyMs > 0 && Number.isFinite(everyMs))) {
      throw new Error(
        `monitor({ every }) received an invalid numeric interval: ${every}. ` +
          `Use a positive, finite number of milliseconds (e.g. 5000) or an ISO-8601 ` +
          `PT duration such as 'PT5M'.`,
      );
    }

    const maxMs =
      maxDuration !== undefined
        ? typeof maxDuration === 'number'
          ? maxDuration
          : parseDuration(maxDuration)
        : undefined;

    // Reject string maxDuration values that parsed to 0 ms — same guard as
    // `every`. parseDuration returns 0 for unrecognised strings (e.g. '24h'
    // instead of 'PT24H'), which would make the deadline check fire before the
    // first tick ever runs, silently skipping the entire monitor loop.
    if (typeof maxDuration === 'string' && maxMs === 0) {
      throw new Error(
        `monitor({ maxDuration }) received an invalid duration string: "${maxDuration}". ` +
          `Use a number (milliseconds) or an ISO-8601 PT duration such as 'PT24H' or 'PT1H30M'.`,
      );
    }

    // Reject non-finite / negative NUMERIC maxDuration — the string guard above
    // only covers strings. A numeric `maxDuration` of NaN or Infinity is
    // accepted as-is and lands in `maxMs`; the deadline check
    // `runtime.monotonic.now() - startedAt >= maxMs` is then ALWAYS false (every comparison
    // with NaN is false; nothing is >= Infinity), so the loop runs with no
    // effective time cap until the predicate passes or a tick throws. Unlike
    // `every`, a numeric `maxDuration` of 0 is VALID — it means "already
    // expired" (return false on the first deadline check) — so the bound is
    // `>= 0 && finite`, not `> 0` (PRRT_kwDORvupsc6MkjBe).
    if (
      typeof maxDuration === 'number' &&
      !(maxMs !== undefined && maxMs >= 0 && Number.isFinite(maxMs))
    ) {
      throw new Error(
        `monitor({ maxDuration }) received an invalid numeric value: ${maxDuration}. ` +
          `Use a non-negative, finite number of milliseconds (e.g. 60000) or an ISO-8601 ` +
          `PT duration such as 'PT24H'.`,
      );
    }

    const startedAt = runtime.monotonic.now();
    let tick = 0;

    // Liveness (AB-215): the `session.monitor` `StallPolicy` row (obs-01's
    // `policies.ts`) drives a watchdog for the lifetime of this loop only —
    // created here (its cadence is `everyMs`, only known now) and disposed
    // in `finally` below, so a session not currently being polled accrues
    // no missed pulses.
    setWatchdogCadence(everyMs);
    setWatchdog(
      createStallWatchdog(sessionMonitorPolicy(everyMs), livenessClock, {
        onAssessmentChange: advanceLiveness,
      }),
    );

    try {
      while (true) {
        // Deadline guard — check before starting a new tick.
        if (maxMs !== undefined && runtime.monotonic.now() - startedAt >= maxMs) {
          emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick));
          return false;
        }

        // Emit tick-started (met = null — run hasn't completed yet).
        // Each tick is a full agent run. `'host-reachability'` specifically
        // (AB-215/AC3): a caller's own poll tick proves the process is
        // scheduling callbacks, not that the underlying watched work is
        // progressing.
        signal?.throwIfAborted();
        // Optional chaining: `sessionWatchdog` can be transiently paused
        // (undefined) by a `HumanWaitParkedEvent` from the PREVIOUS tick's
        // run racing this check — read the live reference each iteration
        // rather than a value captured before the loop started.
        getWatchdog()?.recordPulse('host-reachability', 0);
        setLivenessState('running');
        emitter.dispatchEvent(new SessionMonitorTickEvent(sessionId, tick, null));
        let result: RunResult;
        try {
          const run = runAgent(input);
          const abortRun = () => run.abort('session monitor aborted');
          signal?.addEventListener('abort', abortRun, { once: true });
          try {
            result = await run.result();
          } finally {
            signal?.removeEventListener('abort', abortRun);
          }
        } catch (err) {
          // A run error is treated as a non-met tick — we emit done(false) and
          // propagate. The caller should handle this as an error condition.
          emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick + 1));
          if (signal?.aborted) throw processLocalAbortError();
          throw err;
        }

        // Surface terminal run FAILURES as errors instead of feeding them to the
        // predicate. `run.result()` resolves (it does not throw) for normal
        // operative failures — `error`, `aborted`, `budget-exceeded`,
        // `elicitation-denied` — so the catch above never runs for these. Without
        // this check a predicate that returns false would keep sleeping and
        // re-running after a provider/tool failure instead of surfacing it, the
        // same way the catch block does for thrown errors (PRRT_kwDORvupsc6MddwB).
        if (signal?.aborted) {
          emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick + 1));
          throw processLocalAbortError();
        }
        if (FAILURE_FINISH_REASONS.has(result.finishReason)) {
          emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick + 1));
          // Prefer the run's own error; otherwise synthesize one naming the
          // finish reason ('aborted'/'budget-exceeded'/'elicitation-denied'
          // typically carry no `error`).
          throw result.error instanceof Error
            ? result.error
            : new Error(
                `monitor tick ended with finishReason '${result.finishReason}' before the ` +
                  `predicate could be evaluated.`,
              );
        }

        // Evaluate the predicate.
        const met = until(result);
        tick += 1;

        // Emit tick-completed with the predicate result.
        emitter.dispatchEvent(new SessionMonitorTickEvent(sessionId, tick - 1, met));

        if (met) {
          emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, true, tick));
          return true;
        }

        // Sleep between ticks — respects the maxDuration deadline (don't sleep
        // past the deadline; wake up early if needed).
        const elapsed = runtime.monotonic.now() - startedAt;
        if (maxMs !== undefined && elapsed >= maxMs) {
          emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick));
          return false;
        }
        const remainingMs = maxMs !== undefined ? maxMs - elapsed : Infinity;
        const sleepMs = Math.min(everyMs, remainingMs);
        if (sleepMs > 0) {
          // Liveness: a bounded 'sleep' declared wait — unlike 'signal'/
          // 'review', AB-88 requires a deadline for this reason, and the
          // session.monitor watchdog stays live through it (its own
          // cadence check governs whether the next tick's pulse arrives
          // in time).
          setLivenessState('waiting', {
            reason: 'sleep',
            startedAt: livenessClock.now(),
            deadline: livenessClock.now() + sleepMs,
            wakeCondition: 'session.monitor inter-tick timer',
          });
          try {
            await processLocalDelay(sleepMs, signal);
          } catch (error) {
            emitter.dispatchEvent(new SessionMonitorDoneEvent(sessionId, false, tick));
            throw error;
          }
        }
      }
    } finally {
      getWatchdog()?.dispose();
      setWatchdog(undefined);
      setWatchdogCadence(undefined);
      setLivenessState('created');
    }
  };
}
