import type { RuntimeServices } from 'lifecycle';

import type {
  DeclaredWait,
  LivenessAssessment,
  LivenessLifecycleStatus,
  LivenessProgressState,
  LivenessReachability,
  StallWatchdog,
  StallWatchdogClock,
} from '../liveness';
import { createStallWatchdog, LIVENESS_POLICY_VERSION, sessionMonitorPolicy } from '../liveness';
import type { SessionLivenessSnapshot } from './session-handle-types';

export interface LivenessSubscriberRecord {
  readonly observer: (snapshot: SessionLivenessSnapshot) => void;
  closed: boolean;
  readonly detach: () => void;
}

export interface SessionLivenessDependencies {
  sessionId: string;
  runtime: RuntimeServices;
  setTimeoutFunction: (callback: () => void, milliseconds: number) => unknown;
  clearTimeoutFunction: (timer: unknown) => void;
}

export function createSessionLiveness({
  sessionId,
  runtime,
  setTimeoutFunction,
  clearTimeoutFunction,
}: SessionLivenessDependencies) {
  const livenessClock: StallWatchdogClock = {
    now: () => runtime.monotonic.now(),
    setTimeout: setTimeoutFunction,
    clearTimeout: clearTimeoutFunction,
  };

  const livenessStartedAt = runtime.clock.nowISO();
  let livenessRevision = 0;
  let livenessStatus: LivenessLifecycleStatus = 'created';
  let livenessLastTransitionAt = livenessStartedAt;
  let declaredWait: DeclaredWait | undefined;

  /**
   * The `session.monitor` watchdog (obs-01's `sessionMonitorPolicy` row).
   * Created when `monitor()` starts — its cadence is the caller's `every`,
   * only known then — and disposed in `monitor()`'s `finally`: a session not
   * currently being polled accrues no missed pulses. Also temporarily
   * disposed (without clearing `sessionWatchdogCadenceMs`) while a
   * `HumanWaitParkedEvent` is outstanding, per AB-88's unbounded-wait
   * exception for `'signal'`/`'review'` declared waits: elapsed time during
   * an unbounded human wait must not accrue toward stalled/unreachable, and
   * disposing (rather than merely ignoring ticks) discards that elapsed time
   * outright instead of letting it appear as a burst of missed pulses the
   * moment the watchdog is asked to assess again.
   */
  let sessionWatchdog: StallWatchdog | undefined;
  let sessionWatchdogCadenceMs: number | undefined;

  const livenessSubscribers = new Set<LivenessSubscriberRecord>();
  let cachedLivenessSnapshot: SessionLivenessSnapshot | undefined;
  let cachedLivenessRevision = -1;

  function deriveSessionAssessment(
    reachability: LivenessReachability,
    progress: LivenessProgressState,
  ): LivenessAssessment {
    if (declaredWait || livenessStatus === 'waiting') return 'legitimately-waiting';
    if (reachability === 'unreachable') return 'unreachable';
    if (progress === 'stalled') return 'alive-but-stalled';
    return 'healthy';
  }

  function computeLivenessSnapshot(): SessionLivenessSnapshot {
    const watchdogAssessment = sessionWatchdog?.assess();
    // A fresh, frozen copy — `watchdog.assess()` already returns a spread
    // copy, not its own internal array, but freezing here (not just the
    // outer snapshot) keeps a caller's mutation from corrupting a CACHED
    // snapshot object read again at the same revision (the "Cached
    // snapshot" capability's identity-stability contract).
    const evidence = Object.freeze(
      watchdogAssessment?.evidence ? [...watchdogAssessment.evidence] : [],
    );
    // AC3: `session.monitor.tick`'s `'host-reachability'` pulse is this
    // session's only evidence source, so it — and only it — governs
    // `lastHeartbeatAt`/`lastActivityAt`/`lastProgressAt` here. Unlike
    // `active-run-liveness.ts`'s agent-run-level aggregation (where a host
    // pulse proves scheduling, not the watched work's own progress), a
    // session has no finer-grained evidence to prefer.
    const lastPulseAt = evidence.length > 0 ? evidence[evidence.length - 1]?.at : undefined;
    const reachability: LivenessReachability = watchdogAssessment?.reachability ?? 'unknown';
    const progress: LivenessProgressState = watchdogAssessment?.progress ?? 'unknown';

    return Object.freeze({
      id: sessionId,
      kind: 'session',
      startedAt: livenessStartedAt,
      revision: livenessRevision,
      status: livenessStatus,
      lastTransitionAt: livenessLastTransitionAt,
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: true,
      attempt: 0,
      reachability,
      progress,
      assessment: deriveSessionAssessment(reachability, progress),
      observedAt: livenessClock.now(),
      ...(lastPulseAt !== undefined
        ? { lastHeartbeatAt: lastPulseAt, lastActivityAt: lastPulseAt, lastProgressAt: lastPulseAt }
        : {}),
      missedPulseCount: watchdogAssessment?.missedPulseCount ?? 0,
      ...(declaredWait !== undefined ? { declaredWait } : {}),
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence,
    });
  }

  // "Cached snapshot" capability: repeated reads before a represented change
  // return the identical object by reference — a real state change always
  // advances `livenessRevision` first (via `advanceLiveness()`), so caching
  // keyed on it is exact.
  function readLivenessSnapshot(): SessionLivenessSnapshot {
    if (cachedLivenessSnapshot && cachedLivenessRevision === livenessRevision) {
      return cachedLivenessSnapshot;
    }
    cachedLivenessSnapshot = computeLivenessSnapshot();
    cachedLivenessRevision = livenessRevision;
    return cachedLivenessSnapshot;
  }

  function notifyLiveness(): void {
    const snapshot = readLivenessSnapshot();
    for (const record of [...livenessSubscribers]) {
      if (record.closed) continue;
      try {
        record.observer(snapshot);
      } catch {
        // A throwing subscriber must not escape into the caller driving this
        // revision — mirrors `active-run-liveness.ts`'s identical isolation.
      }
    }
  }

  function advanceLiveness(): void {
    livenessRevision += 1;
    notifyLiveness();
  }

  /**
   * Sets this session's own lifecycle status and declared wait as ONE
   * revision. Always advances (even when `next` equals the current status)
   * so a wait payload change while already `'waiting'` (not expected today,
   * but not excluded) still reaches subscribers. Omitting `wait` clears any
   * previously declared wait.
   */
  function setLivenessState(next: LivenessLifecycleStatus, wait?: DeclaredWait): void {
    if (livenessStatus !== next) {
      livenessStatus = next;
      livenessLastTransitionAt = runtime.clock.nowISO();
    }
    // Frozen so a caller mutating a returned snapshot's `declaredWait`
    // cannot corrupt this handle's own internal liveness state (the
    // snapshot's `Object.freeze` is shallow and does not reach here on its
    // own) — every snapshot embeds this SAME reference until the wait ends.
    declaredWait = wait ? Object.freeze({ ...wait }) : undefined;
    advanceLiveness();
  }

  /**
   * Disposes the active `session.monitor` watchdog without clearing
   * `sessionWatchdogCadenceMs`, so `resumeSessionWatchdogAfterWait` can
   * rebuild it once the outstanding wait clears. A no-op when no watchdog is
   * active (a `HumanWaitParkedEvent` outside `monitor()`).
   */
  function pauseSessionWatchdogForWait(): void {
    if (!sessionWatchdog) return;
    sessionWatchdog.dispose();
    sessionWatchdog = undefined;
  }

  /**
   * Rebuilds the `session.monitor` watchdog with a FRESH instance (discarding
   * whatever elapsed time and evidence accrued while paused) once an
   * outstanding wait clears. A no-op when no `monitor()` loop is active
   * (`sessionWatchdogCadenceMs` was never set, or its own `finally` already
   * cleared it).
   */
  function resumeSessionWatchdogAfterWait(): void {
    if (sessionWatchdogCadenceMs === undefined || sessionWatchdog !== undefined) return;
    sessionWatchdog = createStallWatchdog(
      sessionMonitorPolicy(sessionWatchdogCadenceMs),
      livenessClock,
      { onAssessmentChange: advanceLiveness },
    );
    sessionWatchdog.recordPulse('host-reachability', 0);
  }

  return {
    livenessSubscribers,
    livenessClock,
    readLivenessSnapshot,
    setLivenessState,
    pauseSessionWatchdogForWait,
    resumeSessionWatchdogAfterWait,
    getWatchdog: () => sessionWatchdog,
    setWatchdog: (watchdog: StallWatchdog | undefined) => {
      sessionWatchdog = watchdog;
    },
    setWatchdogCadence: (cadence: number | undefined) => {
      sessionWatchdogCadenceMs = cadence;
    },
    advanceLiveness,
  };
}
