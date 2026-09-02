import type {
  LivenessEvidenceEntry,
  LivenessEvidenceSource,
  LivenessProgressState,
  LivenessReachability,
  StallPolicy,
} from './types';

/**
 * A timer-agnostic clock seam. Every test injects a manual implementation —
 * no real `setTimeout`, no real sleeps (AB-88's verification walk).
 */
export interface StallWatchdogClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StallWatchdogAssessment {
  readonly reachability: LivenessReachability;
  readonly progress: LivenessProgressState;
  readonly missedPulseCount: number;
  readonly evidence: readonly LivenessEvidenceEntry[];
}

/**
 * Options for {@link createStallWatchdog}. `onAssessmentChange` fires only
 * from the watchdog's own cadence timer — a state change with no driving
 * caller event (a missed-pulse tick, a suspension-window recovery). A
 * `recordPulse` call already returns control synchronously to its caller,
 * which is expected to re-derive its own snapshot itself (as
 * `ActiveRunLiveness` does) — this callback exists so a timer-only
 * transition (AB-214 review PRRT_kwDORvupsc6esZRv) is not silently invisible
 * to a subscriber-based consumer.
 */
export interface StallWatchdogOptions {
  onAssessmentChange?: () => void;
}

export interface StallWatchdog {
  recordPulse(source: LivenessEvidenceSource, attempt: number, detail?: unknown): void;
  assess(): StallWatchdogAssessment;
  dispose(): void;
}

/**
 * The specificity rank used to implement AC5's pairwise evidence-isolation
 * table. A pulse only advances the watchdog's "governing activity" clock —
 * the timestamp `missedPulseCount` math is computed against — when its rank
 * is at least the highest rank seen so far; a lower-ranked pulse is still
 * recorded in `evidence` but never resets a higher-ranked source's accrued
 * silence. `lease-renewal` proves ownership, never activity (AC5), so it is
 * excluded from ranking entirely and never touches the activity clock.
 * `absolute-deadline` is not a pulse (AC4/AC7) and is likewise excluded.
 */
const EVIDENCE_RANK: Partial<Record<LivenessEvidenceSource, number>> = {
  'host-reachability': 0,
  'transport-keepalive': 1,
  'provider-io': 2,
  'tool-progress': 3,
  'worker-session-heartbeat': 4,
  'task-attempt-heartbeat': 5,
};

/** Evidence entries retained per watchdog — bounded so a long-lived, high-frequency pulser (per-chunk tool progress) does not grow this array without limit. Oldest entries drop first. */
const MAX_RETAINED_EVIDENCE = 64;

/**
 * The single timer-agnostic implementation of `StallPolicy`'s cadence,
 * grace, jitter, and missed-pulse math (AB-88's AC7, discharged concretely
 * by AB-214/obs-01). obs-02 (`SessionHandle`), obs-03 (child-liveness
 * rollup), and obs-06 (Gateway connection watchdog) import this rather than
 * reimplementing it, per the repository's No Duplicated Code rule.
 *
 * Cadence-gated policies (`cadenceMs` set and `missedPulseThreshold > 0`)
 * check for fresh activity once per `cadenceMs + graceMs + jitterMs` — the
 * full tolerance window a policy declares, not `cadenceMs` alone (AB-214
 * review PRRT_kwDORvupsc6esUtf / PRRT_kwDORvupsc6esZR2): `graceMs` is the
 * declared tolerance before a miss counts at all, and `jitterMs` further
 * absorbs ordinary event-loop scheduling delay (AB-88's verification walk:
 * "jitterMs absorbs loop delay").
 */
export function createStallWatchdog(
  policy: StallPolicy,
  clock: StallWatchdogClock,
  options: StallWatchdogOptions = {},
): StallWatchdog {
  let currentAttempt = 0;
  // Attempt-fencing gate (AC8): true once ANY pulse — including a
  // lease-renewal or absolute-deadline entry — has established `currentAttempt`
  // at all, distinct from `hasActivityPulse` below.
  let attemptEstablished = false;
  // Real-activity gate for the no-cadence reachability/progress read
  // (AC5/review PRRT_kwDORvupsc6esjj0): only a ranked activity source
  // (never `lease-renewal`, which proves ownership, or `absolute-deadline`,
  // which is not a pulse) may make a no-cadence policy report `reachable`/
  // `progressing`.
  let hasActivityPulse = false;
  let highestRankSeen = -1;
  let activityAt: number | undefined;
  let missedPulseCount = 0;
  let lastCheckAt: number | undefined;
  let disposed = false;
  let timerHandle: unknown;
  const evidence: LivenessEvidenceEntry[] = [];

  const constructedAt = clock.now();
  const cadenceGated = policy.cadenceMs !== undefined && policy.missedPulseThreshold > 0;
  const checkIntervalMs = (policy.cadenceMs ?? 0) + policy.graceMs + policy.jitterMs;
  const suspensionWindowMs = 10 * ((policy.cadenceMs ?? 0) + policy.graceMs);

  function pushEvidence(entry: LivenessEvidenceEntry): void {
    evidence.push(entry);
    if (evidence.length > MAX_RETAINED_EVIDENCE) {
      evidence.shift();
    }
  }

  function onCheck(): void {
    if (disposed) return;
    const now = clock.now();
    const previousCheckAt = lastCheckAt ?? constructedAt;
    const gap = now - previousCheckAt;
    const sawFreshPulse = activityAt !== undefined && activityAt >= previousCheckAt;
    const before = missedPulseCount;

    if (policy.suspensionBehavior === 'pause-on-suspected-suspension' && gap > suspensionWindowMs) {
      // A gap this large is a suspected process/laptop suspension, not real
      // silence — this check does not accrue a missed pulse (AC: AB-88's
      // pause-on-suspected-suspension rule).
    } else if (sawFreshPulse) {
      if (policy.recovery === 'resume-on-next-pulse') {
        missedPulseCount = 0;
      }
    } else {
      missedPulseCount += 1;
    }

    lastCheckAt = now;
    scheduleNextCheck();
    if (missedPulseCount !== before) {
      options.onAssessmentChange?.();
    }
  }

  function scheduleNextCheck(): void {
    if (disposed || !cadenceGated) return;
    timerHandle = clock.setTimeout(onCheck, checkIntervalMs);
  }

  scheduleNextCheck();

  return {
    recordPulse(source: LivenessEvidenceSource, attempt: number, detail?: unknown): void {
      if (disposed) return;
      // AC8/AC5: an evidence entry whose attempt is less than the
      // watchdog's current attempt is discarded, never merged.
      if (attemptEstablished && attempt < currentAttempt) return;

      attemptEstablished = true;
      currentAttempt = Math.max(currentAttempt, attempt);

      const at = clock.now();
      pushEvidence({ source, at, attempt, detail });

      if (source === 'lease-renewal') {
        // Proves ownership, never activity — never touches the activity
        // clock and never counts as a real activity pulse.
        return;
      }

      const rank = EVIDENCE_RANK[source];
      if (rank === undefined) {
        // 'absolute-deadline' — not a pulse; moved only forward, only by
        // the watchdog. Recorded in evidence above, nothing else.
        return;
      }

      hasActivityPulse = true;

      if (rank >= highestRankSeen) {
        highestRankSeen = rank;
        activityAt = at;
        // Reset recovery state on the pulse itself (AB-214 review
        // PRRT_kwDORvupsc6esjjp), not only on the next timer tick — a
        // caller reading `assess()` synchronously right after a recovering
        // pulse must see the recovery immediately, and a snapshot
        // subscriber must not wait up to `checkIntervalMs` for a revision
        // that already happened.
        if (cadenceGated && policy.recovery === 'resume-on-next-pulse') {
          missedPulseCount = 0;
        }
      }
    },

    assess(): StallWatchdogAssessment {
      // AC7 (AB-214 review PRRT_kwDORvupsc6esZSQ): an absolute deadline
      // governs independently of cadence — a deadline-only policy (no
      // cadence at all) and a cadence-gated policy both go unreachable/
      // stalled once the deadline passes, regardless of missed-pulse state.
      if (
        policy.absoluteDeadlineMs !== undefined &&
        clock.now() >= constructedAt + policy.absoluteDeadlineMs
      ) {
        return {
          reachability: 'unreachable',
          progress: 'stalled',
          missedPulseCount,
          evidence: [...evidence],
        };
      }

      if (!cadenceGated) {
        return {
          reachability: hasActivityPulse ? 'reachable' : 'unknown',
          progress: hasActivityPulse ? 'progressing' : 'unknown',
          missedPulseCount: 0,
          evidence: [...evidence],
        };
      }

      const reachability: LivenessReachability =
        missedPulseCount === 0
          ? 'reachable'
          : missedPulseCount < policy.missedPulseThreshold
            ? 'late'
            : 'unreachable';

      const progress: LivenessProgressState =
        missedPulseCount === 0
          ? hasActivityPulse
            ? 'progressing'
            : 'unknown'
          : missedPulseCount < policy.missedPulseThreshold
            ? 'idle'
            : 'stalled';

      return { reachability, progress, missedPulseCount, evidence: [...evidence] };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timerHandle !== undefined) {
        clock.clearTimeout(timerHandle);
        timerHandle = undefined;
      }
    },
  };
}
