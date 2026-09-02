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

/**
 * The single timer-agnostic implementation of `StallPolicy`'s cadence,
 * grace, jitter, and missed-pulse math (AB-88's AC7, discharged concretely
 * by AB-214/obs-01). obs-02 (`SessionHandle`), obs-03 (child-liveness
 * rollup), and obs-06 (Gateway connection watchdog) import this rather than
 * reimplementing it, per the repository's No Duplicated Code rule.
 */
export function createStallWatchdog(policy: StallPolicy, clock: StallWatchdogClock): StallWatchdog {
  let currentAttempt = 0;
  let hasAcceptedPulse = false;
  let highestRankSeen = -1;
  let activityAt: number | undefined;
  let missedPulseCount = 0;
  let lastTickAt: number | undefined;
  let disposed = false;
  let timerHandle: unknown;
  const evidence: LivenessEvidenceEntry[] = [];

  const cadenceGated = policy.cadenceMs !== undefined && policy.missedPulseThreshold > 0;
  const suspensionWindowMs = 10 * ((policy.cadenceMs ?? 0) + policy.graceMs);

  function onTick(): void {
    if (disposed) return;
    const now = clock.now();
    const previousTickAt = lastTickAt ?? now;
    const gap = now - previousTickAt;
    const sawFreshPulse = activityAt !== undefined && activityAt >= previousTickAt;

    if (policy.suspensionBehavior === 'pause-on-suspected-suspension' && gap > suspensionWindowMs) {
      // A gap this large is a suspected process/laptop suspension, not real
      // silence — this tick does not accrue a missed pulse (AC: AB-88's
      // pause-on-suspected-suspension rule).
    } else if (sawFreshPulse) {
      if (policy.recovery === 'resume-on-next-pulse') {
        missedPulseCount = 0;
      }
    } else {
      missedPulseCount += 1;
    }

    lastTickAt = now;
    scheduleTick();
  }

  function scheduleTick(): void {
    if (disposed || !cadenceGated) return;
    timerHandle = clock.setTimeout(onTick, policy.cadenceMs ?? 0);
  }

  if (cadenceGated) {
    // Anchor the first tick's gap measurement at construction time, not at
    // whatever `now()` happens to read when the first tick actually fires —
    // otherwise a suspension gap spanning the very first interval could
    // never be detected (the naive "no prior tick" fallback would read the
    // already-advanced clock as its own baseline).
    lastTickAt = clock.now();
  }
  scheduleTick();

  return {
    recordPulse(source: LivenessEvidenceSource, attempt: number, detail?: unknown): void {
      if (disposed) return;
      // AC8/AC5: an evidence entry whose attempt is less than the
      // watchdog's current attempt is discarded, never merged.
      if (hasAcceptedPulse && attempt < currentAttempt) return;

      hasAcceptedPulse = true;
      currentAttempt = Math.max(currentAttempt, attempt);

      const at = clock.now();
      evidence.push({ source, at, attempt, detail });

      if (source === 'lease-renewal') {
        // Proves ownership, never activity — never touches the activity clock.
        return;
      }

      const rank = EVIDENCE_RANK[source];
      if (rank === undefined) {
        // 'absolute-deadline' — not a pulse; moved only forward, only by
        // the watchdog itself. Recorded in evidence above, nothing else.
        return;
      }

      if (rank >= highestRankSeen) {
        highestRankSeen = rank;
        activityAt = at;
      }
    },

    assess(): StallWatchdogAssessment {
      if (!cadenceGated) {
        return {
          reachability: hasAcceptedPulse ? 'reachable' : 'unknown',
          progress: hasAcceptedPulse ? 'progressing' : 'unknown',
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
          ? hasAcceptedPulse
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
