import type { Subscription } from 'lifecycle';

import {
  AGENT_RUN_PROVIDER_TURN_POLICY,
  LIVENESS_POLICY_VERSION,
  TOOL_CALL_POLICY,
} from './policies';
import type {
  LivenessAssessment,
  LivenessEvidenceEntry,
  LivenessEvidenceSource,
  LivenessLifecycleStatus,
  LivenessObservable,
  LivenessProgressState,
  LivenessReachability,
  LivenessSnapshot,
} from './types';
import { createStallWatchdog, type StallWatchdog, type StallWatchdogClock } from './watchdog';

export type AgentRunLivenessSnapshot = LivenessSnapshot & { kind: 'agent-run' };

export interface ActiveRunLivenessOptions {
  readonly id: string;
  readonly durability: 'process-local' | 'durable';
  readonly clock?: StallWatchdogClock;
  /**
   * The authenticated principal or Bureau identifier that owns this run
   * (AC4's `owner` field) — absent for a standalone (non-Bureau) run, per
   * AB-88's standalone-run resolution. Distinct from `projection`, which is
   * always `'redacted'` regardless of `owner` (AB-88's single-projection
   * ruling): `owner` records who started the run, `projection` records what
   * detail level THIS caller sees.
   */
  readonly owner?: string;
}

/**
 * The `LivenessObservable` implementation shared by every `ActiveRun`
 * constructor (`createActiveRun`, `createDurableActiveRun`,
 * `reattachDurableActiveRun`) — one implementation, per the repository's No
 * Duplicated Code rule, wired into each constructor's own emitter/result
 * plumbing rather than reimplemented per constructor.
 *
 * Aggregates two `createStallWatchdog` instances (AB-88's AC7 rows for
 * `agent-run.provider-turn` and `tool-call`) into a single agent-run-level
 * `LivenessSnapshot`: the worse of the two governs `reachability`/
 * `progress`/`missedPulseCount`, and their evidence merges chronologically.
 * The tool watchdog exists only while at least one tool call is in flight
 * (`beginToolCall`/`endToolCall`) — an idle run with no active tool call
 * cannot be reported stalled/unreachable purely because it produced no
 * `tool-progress` event (AB-214 review PRRT_kwDORvupsc6esZRy).
 *
 * `subscribeSnapshot` pushes a new snapshot to every subscriber on each
 * explicit revision-advancing call (`recordProviderPulse`,
 * `recordToolProgressPulse`, `setStatus`, `settle`) — not on pure elapsed
 * time with no new evidence. A caller wanting up-to-the-millisecond
 * staleness without a driving event calls `snapshot()` directly, which
 * always recomputes from the watchdogs' current state, EXCEPT that repeated
 * reads at the same `revision` return the identical cached object by
 * reference (the "Cached snapshot" capability's identity-stability
 * contract, `documentation/operative-type-safe-api.md`) — a real state
 * change always advances `revision` first, so identity and freshness never
 * disagree.
 */
export interface ActiveRunLiveness extends LivenessObservable<AgentRunLivenessSnapshot> {
  recordProviderPulse(detail?: unknown): void;
  recordToolProgressPulse(
    detail?: { toolCallId?: string; toolName?: string } & Record<string, unknown>,
  ): void;
  /** Starts the tool watchdog if this is the first in-flight tool call. */
  beginToolCall(): void;
  /** Stops (disposes) the tool watchdog once no tool call remains in flight. */
  endToolCall(): void;
  setStatus(status: LivenessLifecycleStatus): void;
  /**
   * Atomically attaches the terminal `result` and transitions `status` to
   * `'terminal'` as ONE revision (AB-214 review PRRT_kwDORvupsc6esZSx) — a
   * successful settlement must never publish an intermediate snapshot with
   * `status: 'running'` and a populated `result`, which would let a
   * subscriber observe completion before the lifecycle dimension says it
   * occurred.
   */
  settle(result: unknown): void;
  dispose(): void;
}

function worstReachability(a: LivenessReachability, b: LivenessReachability): LivenessReachability {
  // Only 'unknown', 'reachable', 'late', and 'unreachable' are ever produced
  // by createStallWatchdog's assess(); 'not-applicable' is a terminal-only
  // value this aggregation never sees.
  const rank: LivenessReachability[] = ['reachable', 'late', 'unreachable'];
  const ra = rank.indexOf(a);
  const rb = rank.indexOf(b);
  if (ra === -1) return b;
  if (rb === -1) return a;
  return rank[Math.max(ra, rb)] as LivenessReachability;
}

function worstProgress(a: LivenessProgressState, b: LivenessProgressState): LivenessProgressState {
  const rank: LivenessProgressState[] = ['progressing', 'idle', 'stalled'];
  const ra = rank.indexOf(a);
  const rb = rank.indexOf(b);
  if (ra === -1) return b;
  if (rb === -1) return a;
  return rank[Math.max(ra, rb)] as LivenessProgressState;
}

function lastAt(
  evidence: readonly LivenessEvidenceEntry[],
  sources: readonly LivenessEvidenceSource[],
): number | undefined {
  let result: number | undefined;
  for (const entry of evidence) {
    if (sources.includes(entry.source) && (result === undefined || entry.at > result)) {
      result = entry.at;
    }
  }
  return result;
}

function deriveAssessment(
  status: LivenessLifecycleStatus,
  reachability: LivenessReachability,
  progress: LivenessProgressState,
): LivenessAssessment {
  if (status === 'terminal') return 'terminal';
  if (status === 'aborting') return 'aborting';
  if (status === 'cleaning-up') return 'cleaning-up';
  if (reachability === 'unreachable') return 'unreachable';
  if (status === 'waiting') return 'legitimately-waiting';
  if (progress === 'stalled') return 'alive-but-stalled';
  return 'healthy';
}

/**
 * The default production clock. `now()` uses `performance.now()` — a
 * monotonic source, unaffected by a wall-clock adjustment — rather than
 * `Date.now()` (AB-214 review PRRT_kwDORvupsc6esZS3): every cadence/grace/
 * jitter/suspension computation this module performs assumes a
 * monotonically increasing clock, and a backward wall-clock step could
 * otherwise make a fresh pulse compare as older than a stale one. Wall-clock
 * ISO timestamps (`startedAt`, `lastTransitionAt`) stay on `Date`
 * separately — they are for display, never for cadence math.
 */
const realClock: StallWatchdogClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface SubscriberRecord {
  readonly observer: (snapshot: AgentRunLivenessSnapshot) => void;
  closed: boolean;
  /**
   * Detaches this record's `abort` listener from its caller-supplied
   * signal, if any. Called on every close path — `unsubscribe()` and
   * terminal delivery's mass-close alike (AB-214 review
   * PRRT_kwDORvupsc6etXKp) — not only when the signal itself eventually
   * fires, so a long-lived signal shared across many completed-run
   * subscriptions never accumulates listeners.
   */
  detachAbortListener: () => void;
}

export function createActiveRunLiveness(options: ActiveRunLivenessOptions): ActiveRunLiveness {
  const clock = options.clock ?? realClock;

  const startedAt = new Date().toISOString();
  let revision = 0;
  let status: LivenessLifecycleStatus = 'running';
  let lastTransitionAt = startedAt;
  let result: unknown;
  let hasResult = false;
  let disposed = false;
  let toolCallsInFlight = 0;

  const subscribers = new Set<SubscriberRecord>();

  const agentWatchdog: StallWatchdog = createStallWatchdog(AGENT_RUN_PROVIDER_TURN_POLICY, clock, {
    onAssessmentChange: advance,
  });
  let toolWatchdog: StallWatchdog | undefined;

  function ensureToolWatchdog(): StallWatchdog {
    if (!toolWatchdog) {
      toolWatchdog = createStallWatchdog(TOOL_CALL_POLICY, clock, { onAssessmentChange: advance });
    }
    return toolWatchdog;
  }

  let cachedSnapshot: AgentRunLivenessSnapshot | undefined;
  let cachedRevision = -1;

  function computeSnapshot(): AgentRunLivenessSnapshot {
    const agentAssessment = agentWatchdog.assess();
    const toolAssessment = toolWatchdog?.assess();
    const reachability = toolAssessment
      ? worstReachability(agentAssessment.reachability, toolAssessment.reachability)
      : agentAssessment.reachability;
    const progress = toolAssessment
      ? worstProgress(agentAssessment.progress, toolAssessment.progress)
      : agentAssessment.progress;
    const missedPulseCount = Math.max(
      agentAssessment.missedPulseCount,
      toolAssessment?.missedPulseCount ?? 0,
    );
    const evidence = Object.freeze(
      [...agentAssessment.evidence, ...(toolAssessment?.evidence ?? [])].sort(
        (a, b) => a.at - b.at,
      ),
    );

    const lastHeartbeatAt = lastAt(evidence, [
      'host-reachability',
      'transport-keepalive',
      'provider-io',
      'tool-progress',
      'worker-session-heartbeat',
      'task-attempt-heartbeat',
    ]);
    const lastActivityAt = lastAt(evidence, [
      'provider-io',
      'tool-progress',
      'worker-session-heartbeat',
      'task-attempt-heartbeat',
    ]);
    const lastProgressAt = lastAt(evidence, ['tool-progress']);

    // AC1: terminal work collapses reachability/progress to 'not-applicable'
    // — a completed run must not go on reporting whatever live-work
    // dimension its watchdogs held immediately before disposal (AB-214
    // review PRRT_kwDORvupsc6esZS8).
    const isTerminal = status === 'terminal';

    return Object.freeze({
      id: options.id,
      kind: 'agent-run',
      ...(options.owner !== undefined ? { owner: options.owner } : {}),
      startedAt,
      revision,
      status,
      lastTransitionAt,
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: options.durability,
      cancellable: status !== 'terminal' && status !== 'aborting',
      ...(hasResult ? { result } : {}),
      attempt: 0,
      reachability: isTerminal ? 'not-applicable' : reachability,
      progress: isTerminal ? 'not-applicable' : progress,
      assessment: deriveAssessment(status, reachability, progress),
      observedAt: clock.now(),
      ...(lastHeartbeatAt !== undefined ? { lastHeartbeatAt } : {}),
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      ...(lastProgressAt !== undefined ? { lastProgressAt } : {}),
      missedPulseCount,
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence,
    });
  }

  // "Cached snapshot" capability (documentation/operative-type-safe-api.md):
  // repeated reads before a represented change return the identical object
  // by reference. A represented change always advances `revision` first
  // (via `advance()`), so caching keyed on `revision` is exact — never
  // stale, never a false identity match.
  function readSnapshot(): AgentRunLivenessSnapshot {
    if (cachedSnapshot && cachedRevision === revision) {
      return cachedSnapshot;
    }
    cachedSnapshot = computeSnapshot();
    cachedRevision = revision;
    return cachedSnapshot;
  }

  function notify(): void {
    if (disposed && status !== 'terminal') return;
    const snapshot = readSnapshot();
    for (const record of [...subscribers]) {
      if (record.closed) continue;
      try {
        record.observer(snapshot);
      } catch {
        // A throwing subscriber must not escape into the caller driving
        // this revision (AB-214 review PRRT_kwDORvupsc6esZRt) — a
        // monitoring callback failing must never strand the run it
        // observes or replace a successful settlement with the observer's
        // own error. Swallow it here; the observer's own bug is the
        // observer's problem, not this run's.
      }
    }
    if (status === 'terminal') {
      // Already-terminal work delivers one terminal snapshot and no further
      // calls — close every subscription record (not just the Set) so a
      // `Subscription.closed` reader sees the true state (AB-214 review
      // PRRT_kwDORvupsc6esjju), then clear the Set.
      for (const record of subscribers) {
        record.closed = true;
        record.detachAbortListener();
      }
      subscribers.clear();
    }
  }

  function advance(): void {
    revision += 1;
    notify();
  }

  function disposeWatchdogs(): void {
    if (disposed) return;
    disposed = true;
    agentWatchdog.dispose();
    toolWatchdog?.dispose();
  }

  return {
    recordProviderPulse(detail?: unknown): void {
      if (disposed) return;
      agentWatchdog.recordPulse('provider-io', 0, detail);
      advance();
    },

    recordToolProgressPulse(
      detail?: { toolCallId?: string; toolName?: string } & Record<string, unknown>,
    ): void {
      if (disposed) return;
      ensureToolWatchdog().recordPulse('tool-progress', 0, detail);
      advance();
    },

    beginToolCall(): void {
      if (disposed) return;
      toolCallsInFlight += 1;
      if (toolCallsInFlight === 1) {
        ensureToolWatchdog();
      }
    },

    endToolCall(): void {
      if (disposed) return;
      toolCallsInFlight = Math.max(0, toolCallsInFlight - 1);
      if (toolCallsInFlight === 0 && toolWatchdog) {
        toolWatchdog.dispose();
        toolWatchdog = undefined;
        // AB-214 review (PRRT_kwDORvupsc6etXKi): removing the tool
        // watchdog changes represented liveness state — a late/unreachable
        // tool-call assessment must not survive as the cached snapshot
        // once the call that caused it has settled. Advance so
        // `readSnapshot()`/subscribers see the recovered (agent-only)
        // assessment immediately, not on some later, unrelated event.
        advance();
      }
    },

    setStatus(next: LivenessLifecycleStatus): void {
      if (status === 'terminal') return;
      if (status === next) return;
      status = next;
      lastTransitionAt = new Date().toISOString();
      if (next === 'terminal') {
        disposeWatchdogs();
      }
      advance();
    },

    settle(value: unknown): void {
      if (status === 'terminal') return;
      result = value;
      hasResult = true;
      status = 'terminal';
      lastTransitionAt = new Date().toISOString();
      disposeWatchdogs();
      advance();
    },

    snapshot(): AgentRunLivenessSnapshot {
      return readSnapshot();
    },

    subscribeSnapshot(
      observer: (snapshot: AgentRunLivenessSnapshot) => void,
      subscribeOptions?: { signal?: AbortSignal },
    ): Subscription {
      const signal = subscribeOptions?.signal;
      const record: SubscriberRecord = {
        observer,
        closed: false,
        detachAbortListener: () => signal?.removeEventListener('abort', unsubscribe),
      };

      function unsubscribe(): void {
        if (record.closed) return;
        record.closed = true;
        record.detachAbortListener();
        subscribers.delete(record);
      }

      // An already-aborted signal must never deliver more than the
      // synchronous initial snapshot below (AB-214 review
      // PRRT_kwDORvupsc6esUt9 / PRRT_kwDORvupsc6esZSg) — checked before
      // registration, not left to a listener that an already-fired signal
      // will never invoke.
      const alreadyAborted = signal?.aborted ?? false;

      if (alreadyAborted || status === 'terminal') {
        record.closed = true;
        try {
          observer(readSnapshot());
        } catch {
          // Same isolation as `notify()` above.
        }
        return {
          unsubscribe,
          get closed() {
            return record.closed;
          },
        };
      }

      // AB-214 review (PRRT_kwDORvupsc6es7pq): register BEFORE the
      // synchronous initial delivery, not after — otherwise an observer
      // that itself synchronously triggers a revision change (e.g. calling
      // `run.abort()` after inspecting the current snapshot) reopens the
      // exact read-then-subscribe gap this API promises to close: the
      // resulting notification would run while this observer is still
      // absent from `subscribers`, and it would be stuck on the
      // already-stale snapshot it was handed until some unrelated later
      // transition. Registering first means that reentrant notification
      // reaches this observer too (as a nested, in-order second call).
      subscribers.add(record);
      signal?.addEventListener('abort', unsubscribe, { once: true });

      try {
        observer(readSnapshot());
      } catch {
        // Same isolation as `notify()` above — a throwing observer must
        // not prevent registration bookkeeping or propagate into the
        // caller of `subscribeSnapshot` itself.
      }

      return {
        unsubscribe,
        get closed() {
          return record.closed;
        },
      };
    },

    dispose: disposeWatchdogs,
  };
}
