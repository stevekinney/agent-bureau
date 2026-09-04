import { createDefaultRuntimeServices, type RuntimeServices, type Subscription } from 'lifecycle';

import type { ChildRunDescriptor, ChildRunRegistry } from '../child-run';
import {
  AGENT_RUN_PROVIDER_TURN_POLICY,
  LIVENESS_POLICY_VERSION,
  TOOL_CALL_POLICY,
} from './policies';
import type {
  DeclaredWait,
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
   * The AB-92/AB-252 `RuntimeServices` seam (AB-325) — its `monotonic` and
   * `timers` back the default `StallWatchdogClock` when `options.clock` is
   * not supplied, and its `clock.nowISO()` backs `startedAt`/
   * `lastTransitionAt`. Defaults to the real implementation. `options.clock`
   * still takes precedence over `runtime` for the watchdog seam when both
   * are supplied, for backward compatibility with a caller that customizes
   * only the monotonic/timer seam.
   */
  readonly runtime?: RuntimeServices;
  /**
   * The authenticated principal or Bureau identifier that owns this run
   * (AC4's `owner` field) — absent for a standalone (non-Bureau) run, per
   * AB-88's standalone-run resolution. Distinct from `projection`, which is
   * always `'redacted'` regardless of `owner` (AB-88's single-projection
   * ruling): `owner` records who started the run, `projection` records what
   * detail level THIS caller sees.
   */
  readonly owner?: string;
  /**
   * Backs `LivenessSnapshot.worstChildAssessment` (AB-216). Optional and
   * opt-in, matching `children()`/`abortChild()`'s own opt-in pattern
   * (AB-50): omit it and `worstChildAssessment` stays permanently absent,
   * never a throw.
   */
  readonly childRegistry?: ChildRunRegistry;
}

/**
 * AB-216's severity ordering, most severe first — `'terminal'` is
 * deliberately absent: a terminal child is excluded from the fold before
 * this array is ever consulted, never ranked by it.
 */
const CHILD_ASSESSMENT_SEVERITY: readonly Exclude<LivenessAssessment, 'terminal'>[] = [
  'unreachable',
  'alive-but-stalled',
  'aborting',
  'cleaning-up',
  'legitimately-waiting',
  'healthy',
];

/**
 * Folds a set of `ChildRunDescriptor`s down to the single most severe
 * `LivenessAssessment` among the non-terminal ones (AB-216's AC2), or
 * `undefined` when there are none — recomputed from the FULL current set
 * every time, never incrementally, so "never a stale value from a prior
 * tick" holds by construction rather than by careful bookkeeping.
 */
function foldWorstChildAssessment(
  children: readonly ChildRunDescriptor[],
): LivenessAssessment | undefined {
  let worst: LivenessAssessment | undefined;
  let worstRank = CHILD_ASSESSMENT_SEVERITY.length;
  for (const child of children) {
    if (child.assessment === undefined || child.assessment === 'terminal') continue;
    const rank = CHILD_ASSESSMENT_SEVERITY.indexOf(child.assessment);
    if (rank === -1 || rank >= worstRank) continue;
    worstRank = rank;
    worst = child.assessment;
  }
  return worst;
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
  /**
   * `'waiting'` is excluded here on purpose (AB-336): AC1 makes `'waiting'`
   * legal ONLY paired with a `DeclaredWait` — `setStatus('waiting')` alone
   * would produce exactly the illegal combination AC1 forbids. Use
   * {@link beginWait}/{@link endWait} instead, which manage `status` and
   * `declaredWait` as one atomic pair so that combination is unreachable
   * through this interface.
   */
  setStatus(status: Exclude<LivenessLifecycleStatus, 'waiting'>): void;
  /**
   * Enters a declared wait (AB-336): sets `status` to `'waiting'` and
   * attaches `wait` as `LivenessSnapshot.declaredWait` in the SAME revision
   * (AC1's pairing requirement — no intermediate snapshot has one without
   * the other). A no-op once `status` is `'terminal'`, matching every other
   * transition here.
   */
  /**
   * `startedAt` is stamped internally from this module's own clock (the
   * same one every other cadence/evidence timestamp here uses) rather than
   * accepted from the caller — a park's caller (e.g. `create-run.ts`'s
   * `HumanWaitParkedEvent` listener) has no reason to own a second clock
   * reading of its own.
   */
  beginWait(wait: Omit<DeclaredWait, 'startedAt'>): void;
  /**
   * Leaves a declared wait: clears `declaredWait` and returns `status` to
   * `'running'` — but ONLY when `status` is still `'waiting'`. A run that
   * moved to `'aborting'`/`'cleaning-up'`/`'terminal'` while waiting (e.g. an
   * abort raced the park) must not be yanked back to `'running'` by a
   * continuation that resolves afterward; `declaredWait` itself is still
   * cleared unconditionally, since the wait is over either way.
   */
  endWait(): void;
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
 * Adapts a `RuntimeServices` instance (AB-92/AB-252/AB-325) into a
 * `StallWatchdogClock`. `now()` reads `runtime.monotonic` — a monotonic
 * source, unaffected by a wall-clock adjustment — rather than
 * `runtime.clock` (AB-214 review PRRT_kwDORvupsc6esZS3): every
 * cadence/grace/jitter/suspension computation this module performs assumes
 * a monotonically increasing clock, and a backward wall-clock step could
 * otherwise make a fresh pulse compare as older than a stale one. Wall-clock
 * ISO timestamps (`startedAt`, `lastTransitionAt`) stay on `runtime.clock`
 * separately — they are for display, never for cadence math.
 */
function stallWatchdogClockFromRuntime(runtime: RuntimeServices): StallWatchdogClock {
  return {
    now: () => runtime.monotonic.now(),
    setTimeout: (callback, ms) => runtime.timers.setTimeout(callback, ms),
    clearTimeout: (handle) => runtime.timers.clearTimeout(handle),
  };
}

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
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const clock = options.clock ?? stallWatchdogClockFromRuntime(runtime);

  const startedAt = runtime.clock.nowISO();
  let revision = 0;
  let status: LivenessLifecycleStatus = 'running';
  let lastTransitionAt = startedAt;
  // AB-336 — paired with `status === 'waiting'` exclusively through
  // `beginWait`/`endWait`; see `ActiveRunLiveness`'s doc comments.
  let declaredWait: DeclaredWait | undefined;
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

  // AB-216 — child-liveness rollup. `worstChildAssessmentValue` is the
  // only state; `recomputeChildRollup` always re-folds `children()`'s
  // FULL current set (never incrementally) and advances the revision only
  // when the folded value actually changed, per this issue's own
  // acceptance criteria: "the parent's own `revision` advances ... even
  // when none of the parent's own dimensions changed", and "never a stale
  // value from a prior tick".
  let worstChildAssessmentValue: LivenessAssessment | undefined;

  function recomputeChildRollup(): void {
    const next = foldWorstChildAssessment(options.childRegistry?.children() ?? []);
    if (next === worstChildAssessmentValue) return;
    worstChildAssessmentValue = next;
    advance();
  }

  const childRollupSubscription = options.childRegistry?.subscribeLiveness(recomputeChildRollup);
  // A registry can already hold children at construction time (e.g. a
  // reused registry, or a test that registers before constructing this
  // liveness) — establish the correct initial value rather than waiting
  // for the next child-side change.
  if (options.childRegistry) {
    worstChildAssessmentValue = foldWorstChildAssessment(options.childRegistry.children());
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
      ...(declaredWait !== undefined ? { declaredWait } : {}),
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence,
      ...(worstChildAssessmentValue !== undefined
        ? { worstChildAssessment: worstChildAssessmentValue }
        : {}),
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
    childRollupSubscription?.unsubscribe();
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

    setStatus(next: Exclude<LivenessLifecycleStatus, 'waiting'>): void {
      if (status === 'terminal') return;
      if (status === next) return;
      // AB-336: `declaredWait` is documented "present iff `status` is
      // `'waiting'`" — a status transition AWAY from `'waiting'` through
      // this method (e.g. an abort racing the park) must clear it in the
      // SAME revision, or a subscriber could observe `status: 'aborting'`
      // with a stale `declaredWait` still attached until `endWait()`
      // eventually runs.
      if (status === 'waiting') {
        declaredWait = undefined;
      }
      status = next;
      lastTransitionAt = runtime.clock.nowISO();
      if (next === 'terminal') {
        disposeWatchdogs();
      }
      advance();
    },

    beginWait(wait: Omit<DeclaredWait, 'startedAt'>): void {
      // Copilot review (PR #535): only a genuinely running run can begin a
      // declared wait — a `HumanWaitParkedEvent` racing an abort (e.g. the
      // tool call committed and dispatched the event in the same tick
      // `setStatus('aborting')` fired) must not overwrite `'aborting'`/
      // `'cleaning-up'`/`'terminal'` back to `'waiting'` and hide the
      // in-progress abort. `'waiting'` itself is excluded too: a second
      // park while already waiting (should not happen — `pendingHumanWait`/
      // `pendingWakeup` are consumed before a run can re-park — but this
      // guard makes the impossible case a no-op rather than silently
      // discarding the first wait's `declaredWait` without an `endWait()`
      // in between) is also refused.
      if (status !== 'running') return;
      status = 'waiting';
      declaredWait = { ...wait, startedAt: clock.now() };
      lastTransitionAt = new Date().toISOString();
      advance();
    },

    endWait(): void {
      if (declaredWait === undefined && status !== 'waiting') return;
      declaredWait = undefined;
      if (status === 'waiting') {
        status = 'running';
        lastTransitionAt = new Date().toISOString();
      }
      advance();
    },

    settle(value: unknown): void {
      if (status === 'terminal') return;
      result = value;
      hasResult = true;
      // AB-336: same "present iff `status` is `'waiting'`" invariant
      // `setStatus` enforces — a run settling directly out of a declared
      // wait must not leave a stale `declaredWait` on the terminal snapshot.
      declaredWait = undefined;
      status = 'terminal';
      lastTransitionAt = runtime.clock.nowISO();
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
