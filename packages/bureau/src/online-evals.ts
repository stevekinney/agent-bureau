/**
 * Online evaluations — production drift detection (AB-53).
 *
 * A sampling hook that listens for `run.completed` on the bureau's action
 * stream and, for a configurable fraction of runs, scores the finished run
 * against configured judges/matchers. Every sampled score is recorded to the
 * durable audit trail (`eval.sample.recorded`) — the same surface the AB-20
 * review queue and AB-21 webhook notifier write to — so drift is visible on
 * the bureau's existing glass-box audit surface, not a bespoke store.
 *
 * A judge whose score breaches its configured `alertThreshold` fires a
 * webhook through AB-21's durable delivery infra
 * ({@link WebhookNotifier.notify}) — the same persist/retry/backoff pipeline
 * `createWebhookNotifier` uses for approval-pending and human-wait alerts, so
 * an eval alert survives a transient delivery failure exactly like those do.
 *
 * Sampling is driven by an injectable RNG (the composed `RuntimeServices`
 * random source by default) so `sampleRate` is deterministic and testable —
 * a fake RNG that returns a fixed sequence exercises "sampled" and
 * "not sampled" runs exactly.
 *
 * Each in-flight evaluation also gets a per-evaluation `LivenessSnapshot`
 * (AB-220), watched via `createStallWatchdog` against the
 * `background-evaluation` `StallPolicy` row (AB-214). That row has no
 * cadence or absolute deadline today (AB-88's own "absent today"
 * characterization — `evaluateRun` has no per-evaluation `timeout` field to
 * project a deadline from), so this seam gives every evaluation a stable
 * identity and a structurally-correct snapshot now, ready for real stall
 * detection once a per-evaluation deadline exists, without reopening this
 * module later to add it.
 */
import type { RunResult } from '@lostgradient/operative';
import {
  BACKGROUND_EVALUATION_POLICY,
  createStallWatchdog,
  LIVENESS_POLICY_VERSION,
  type LivenessAssessment,
  type LivenessLifecycleStatus,
  type LivenessObservable,
  type LivenessProgressState,
  type LivenessReachability,
  type LivenessSnapshot,
  type StallWatchdog,
  type StallWatchdogClock,
  type Subscription,
} from '@lostgradient/operative/liveness';
import { Conversation } from 'conversationalist';
import { createDefaultRuntimeServices, type RuntimeServices } from 'lifecycle';

import type { AgentDefinitions } from './agent-catalog';
import type { AuditTrail } from './audit-trail';
import type { ActionEvent } from './events';
import type { Bureau } from './types';
import type { WebhookNotifier } from './webhook-notifier';

// ── Public surface ──────────────────────────────────────────────────

/** The result of scoring a single completed run against one judge/matcher. */
export interface EvalScore {
  /** Whether the run's output passed this judge's check. */
  pass: boolean;
  /** Score from 0-1 (1 = perfect). */
  score: number;
  /** Human-readable description of the score. */
  message: string;
}

/** A single background evaluation's liveness snapshot (AB-220). */
export type EvaluationLivenessSnapshot = LivenessSnapshot & { kind: 'background-evaluation' };

/**
 * Local injectable per-evaluation identifier seam (AB-220), mirroring
 * obs-01's `RunIdentifierSeam` pattern
 * (`packages/operative/src/liveness/identifiers.ts`) — a constructor-time
 * injected id-generator, never a bare real-random-UUID call reached from
 * inside evaluation-dispatch logic. AB-88's own text named
 * `RuntimeServices.identifiers` (AB-92/AB-93) as the eventual home for this
 * kind of seam; AB-260 is that landing — the default below is now backed by
 * the composed `RuntimeServices.identifiers` rather than a bespoke counter.
 */
export interface EvaluationIdentifierSeam {
  next(): string;
}

/**
 * Factory for the default seam: the composed
 * {@link RuntimeServices.identifiers} (AB-260), namespaced under the
 * `'background-evaluation'` kind. Tests inject their own
 * {@link EvaluationIdentifierSeam} instead of relying on this default's
 * output.
 */
function createDefaultEvaluationIdentifierSeam(
  identifiers: RuntimeServices['identifiers'],
): EvaluationIdentifierSeam {
  return {
    next(): string {
      return identifiers.next('background-evaluation');
    },
  };
}

/**
 * Factory for the default production clock backing each evaluation's
 * `createStallWatchdog` — driven by the composed
 * {@link RuntimeServices.monotonic}/{@link RuntimeServices.timers} (AB-260),
 * defaulting to the real-globals runtime when called with no argument (the
 * baseline behavior, unchanged from before `RuntimeServices` composition).
 * Exported for direct unit testing of `setTimeout`/`clearTimeout` (AB-220):
 * the `background-evaluation` policy row has no cadence today, so
 * `createStallWatchdog` never actually calls either through the public API
 * — see `packages/operative/src/liveness/watchdog.ts`'s `scheduleNextCheck`,
 * which no-ops when a policy isn't cadence-gated. The timer-scheduling and
 * timer-clearing members are destructured once so the returned clock reads
 * `scheduleTimeout(...)`/`cancelTimeout(...)` rather than a literal `timers`
 * method call — see `create-bureau.ts`'s equivalent pattern for why.
 */
export function createDefaultClock(
  runtime: RuntimeServices = createDefaultRuntimeServices(),
): StallWatchdogClock {
  const { setTimeout: scheduleTimeout, clearTimeout: cancelTimeout } = runtime.timers;
  return {
    now: () => runtime.monotonic.now(),
    setTimeout: (callback, ms) => scheduleTimeout(callback, ms),
    clearTimeout: (handle) => cancelTimeout(handle),
  };
}

/** The fixed id for the sampler's own instance-level aggregate snapshot. */
const AGGREGATE_EVALUATION_ID = 'online-eval-sampler';

/**
 * AB-216's child-liveness severity ordering
 * (`packages/operative/src/liveness/active-run-liveness.ts`), duplicated at
 * module-local scope rather than imported: this issue's delivery boundary
 * restricts its edit to `online-evals.ts`/`webhook-notifier.ts` and their
 * tests, and the source ordering is not part of `@lostgradient/operative`'s
 * public `liveness` subpath export.
 */
const ASSESSMENT_SEVERITY: readonly Exclude<LivenessAssessment, 'terminal'>[] = [
  'unreachable',
  'alive-but-stalled',
  'aborting',
  'cleaning-up',
  'legitimately-waiting',
  'healthy',
];

/**
 * Folds a set of non-terminal assessments down to the single most severe
 * one, defaulting to `'healthy'` when empty. Exported for direct unit
 * testing (AB-220): the `background-evaluation` policy row has no cadence
 * or deadline today, so every real evaluation this module produces reports
 * `'healthy'` — the "found something worse" branch is otherwise unreachable
 * through the public API.
 */
export function worstAssessment(assessments: readonly LivenessAssessment[]): LivenessAssessment {
  let worst: LivenessAssessment = 'healthy';
  let worstRank = ASSESSMENT_SEVERITY.indexOf('healthy');
  for (const assessment of assessments) {
    if (assessment === 'terminal') continue;
    const rank = ASSESSMENT_SEVERITY.indexOf(assessment);
    if (rank === -1 || rank >= worstRank) continue;
    worstRank = rank;
    worst = assessment;
  }
  return worst;
}

const REACHABILITY_RANK: readonly LivenessReachability[] = ['reachable', 'late', 'unreachable'];

/** Exported for direct unit testing (AB-220); see {@link worstAssessment}. */
export function worstReachability(values: readonly LivenessReachability[]): LivenessReachability {
  let worst: LivenessReachability = 'unknown';
  let worstRank = -1;
  for (const value of values) {
    const rank = REACHABILITY_RANK.indexOf(value);
    if (rank > worstRank) {
      worstRank = rank;
      worst = value;
    }
  }
  return worst;
}

const PROGRESS_RANK: readonly LivenessProgressState[] = ['progressing', 'idle', 'stalled'];

/** Exported for direct unit testing (AB-220); see {@link worstAssessment}. */
export function worstProgress(values: readonly LivenessProgressState[]): LivenessProgressState {
  let worst: LivenessProgressState = 'unknown';
  let worstRank = -1;
  for (const value of values) {
    const rank = PROGRESS_RANK.indexOf(value);
    if (rank > worstRank) {
      worstRank = rank;
      worst = value;
    }
  }
  return worst;
}

/** Mirrors `active-run-liveness.ts`'s `deriveAssessment` for this module's own status dimension. */
function deriveEvaluationAssessment(
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
 * A single configured judge or matcher run against a fraction of live runs.
 * `evaluate` receives the completed run's {@link RunResult} — the same shape
 * `evaluation`'s `matchCustomAssertion`/`createLLMJudge` operate on, so an
 * existing offline matcher or LLM judge can be adapted into this shape
 * directly (wrap it, normalize its score to 0-1, return {@link EvalScore}).
 */
export interface OnlineEvalJudge {
  /** Name recorded on every audit record and alert payload produced by this judge. */
  name: string;
  /** Scores a sampled run. May be async (e.g. an LLM-as-judge call). */
  evaluate: (runResult: RunResult) => EvalScore | Promise<EvalScore>;
  /**
   * Alert threshold: a score strictly below this fires a webhook. Omit to
   * alert whenever the judge reports `pass: false` instead of on a numeric
   * threshold.
   */
  alertThreshold?: number;
}

/** Options for {@link createOnlineEvalSampler}. */
export interface OnlineEvalSamplerOptions {
  /** Judges/matchers run against each sampled run. */
  judges: OnlineEvalJudge[];
  /** Fraction of completed runs to sample, in `[0, 1]`. */
  sampleRate: number;
  /** Injectable RNG returning a value in `[0, 1)`. Defaults to the composed RuntimeServices random. */
  rng?: () => number;
  /**
   * Owner-issued signal threaded into every `evaluateRun()` judge invocation
   * (AB-37/AB-206). Aborting it causes the affected `evaluateRun()` call to
   * settle promptly instead of running its remaining judges to completion.
   * `dispose()` still awaits that settlement via `flush()`.
   */
  signal?: AbortSignal;
  /**
   * Injectable timer-agnostic clock backing each evaluation's
   * `createStallWatchdog` (AB-220). Defaults to the composed
   * `RuntimeServices` monotonic clock and timers (AB-260). Tests inject a
   * manual clock so no real sleeps are needed.
   */
  clock?: StallWatchdogClock;
  /**
   * Injectable per-evaluation identifier seam (AB-220). Defaults to the
   * composed `RuntimeServices.identifiers` (AB-260), namespaced under
   * `'background-evaluation'`. Tests inject their own seam to assert
   * stable, distinguishable ids across concurrently-admitted evaluations.
   */
  evaluationIds?: EvaluationIdentifierSeam;
}

/** The online eval sampler object returned by {@link createOnlineEvalSampler}. */
export interface OnlineEvalSampler extends LivenessObservable<EvaluationLivenessSnapshot> {
  /** Number of completed runs the sampler has observed (sampled or not). */
  observedCount(): number;
  /** Number of runs actually sampled (passed the `sampleRate` roll). */
  sampledCount(): number;
  /**
   * Await every judge evaluation currently in flight. Used by tests to
   * observe audit-record writes and webhook alerts deterministically without
   * racing an async judge.
   */
  flush(): Promise<void>;
  /**
   * Stop listening to bureau events and await every in-flight `evaluateRun()`
   * judge invocation tracked in `activeEvaluations` before resolving
   * (AB-37/AB-206). Safe to call more than once — the second call resolves
   * promptly.
   */
  dispose(): Promise<void>;
  /**
   * Per-evaluation `LivenessSnapshot`s for every evaluation currently in
   * flight (AB-220), most-recently-started last. `snapshot()` (from
   * {@link LivenessObservable}) reports the instance-level aggregate — the
   * worst assessment across these — for a caller holding only the sampler
   * handle.
   */
  activeEvaluationSnapshots(): EvaluationLivenessSnapshot[];
}

// ── Guards ──────────────────────────────────────────────────────────

/**
 * Narrows a `run.completed` action's `detail` to a {@link RunResult}. The
 * operative store copies `RunCompletedEvent`'s own properties verbatim onto
 * `Action.detail` (see `packages/operative/src/store/store.ts`), so a
 * genuine `run.completed` action carries a real `Conversation` instance plus
 * the run's `content`/`usage`/`finishReason` — checked here rather than cast,
 * since `Action.detail` is typed `unknown`.
 */
function isRunResultDetail(detail: unknown): detail is RunResult {
  if (typeof detail !== 'object' || detail === null) return false;
  const record = detail as Record<string, unknown>;
  return (
    record['conversation'] instanceof Conversation &&
    Array.isArray(record['steps']) &&
    typeof record['content'] === 'string' &&
    typeof record['usage'] === 'object' &&
    record['usage'] !== null
  );
}

// ── Trigger ─────────────────────────────────────────────────────────

const EVAL_ALERT_TRIGGER = 'eval.threshold-breached';

function breachesThreshold(judge: OnlineEvalJudge, result: EvalScore): boolean {
  if (judge.alertThreshold !== undefined) return result.score < judge.alertThreshold;
  return !result.pass;
}

// ── Abort-aware settlement ──────────────────────────────────────────

/**
 * Rejects with `signal`'s abort reason as soon as it aborts, so awaiting
 * `judge.evaluate()` never blocks `evaluateRun()` past the owner's shutdown
 * request even though {@link OnlineEvalJudge.evaluate} itself has no way to
 * observe the signal. `signal` is the owner's disposal signal and outlives
 * any single evaluation, so the listener is removed via `unregister()` once
 * the race is decided rather than relying on `{ once: true }` alone —
 * otherwise a judge that WINS the race (settles before an abort) would leave
 * its listener attached to `signal` forever, one per sampled run.
 */
function whenAborted(signal: AbortSignal): { promise: Promise<never>; unregister: () => void } {
  const reason = () => (signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(reason());
      return;
    }
    onAbort = () => reject(reason());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    unregister: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}

async function raceAgainstAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  const { promise: abortPromise, unregister } = whenAborted(signal);
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    unregister();
  }
}

// ── Sampler factory ─────────────────────────────────────────────────

/**
 * Creates the online eval sampler attached to `bureau`.
 *
 * @param bureau - The bureau to observe (its `action` event stream).
 * @param auditTrail - The bureau's audit trail. Every sampled score is
 *   recorded here (`eval.sample.recorded`), best-effort — a write failure
 *   never fails the run.
 * @param webhookNotifier - The bureau's AB-21 webhook notifier. A threshold
 *   breach fires through {@link WebhookNotifier.notify} using its durable
 *   delivery pipeline. `undefined` when no webhooks are configured — a
 *   breach is still recorded in the audit trail, just never delivered.
 * @param options - Judges + sample rate + RNG. Returns a no-op sampler when
 *   `options` is `undefined`, `options.judges` is empty, or `sampleRate` is
 *   `0`.
 */
export function createOnlineEvalSampler<D extends AgentDefinitions = AgentDefinitions>(
  bureau: Bureau<D>,
  auditTrail: AuditTrail | undefined,
  webhookNotifier: WebhookNotifier | undefined,
  options: OnlineEvalSamplerOptions | undefined,
  // AB-260: the bureau's single composed `RuntimeServices` instance. Defaults
  // to the real-globals runtime so every pre-existing direct caller of this
  // exported factory (including this package's own test suite) is
  // unaffected by construction. `options.rng` (this module's own
  // pre-existing injectable seam) still takes precedence when supplied.
  runtime: RuntimeServices = createDefaultRuntimeServices(),
): OnlineEvalSampler {
  const judges = options?.judges ?? [];

  if (judges.length === 0 || !options || options.sampleRate <= 0) {
    const noOpSnapshot: EvaluationLivenessSnapshot = Object.freeze({
      id: AGGREGATE_EVALUATION_ID,
      kind: 'background-evaluation',
      startedAt: runtime.clock.nowISO(),
      revision: 0,
      status: 'terminal',
      lastTransitionAt: runtime.clock.nowISO(),
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: false,
      attempt: 0,
      reachability: 'not-applicable',
      progress: 'not-applicable',
      assessment: 'terminal',
      observedAt: 0,
      missedPulseCount: 0,
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence: [],
    });
    return {
      observedCount() {
        return 0;
      },
      sampledCount() {
        return 0;
      },
      async flush() {
        // Nothing was ever kicked off.
      },
      async dispose() {
        // Nothing was ever subscribed.
      },
      activeEvaluationSnapshots() {
        return [];
      },
      snapshot() {
        return noOpSnapshot;
      },
      subscribeSnapshot(observer) {
        observer(noOpSnapshot);
        return { unsubscribe() {}, closed: true };
      },
    };
  }

  const sampleRate = options.sampleRate;
  const rng = options.rng ?? runtime.random.next;
  const signal = options.signal;
  const clock = options.clock ?? createDefaultClock(runtime);
  const evaluationIds =
    options.evaluationIds ?? createDefaultEvaluationIdentifierSeam(runtime.identifiers);

  let observed = 0;
  let sampled = 0;
  let disposed = false;

  // Guards against sampling the same run's `run.completed` action twice
  // (e.g. a duplicate dispatch during recovery) — a sampling decision is
  // made at most once per run.
  const seenRuns = new Set<string>();

  // Every in-flight judge evaluation, so `flush()` can await terminal state
  // deterministically (tests) and a caller can drain evaluations before
  // shutdown.
  const activeEvaluations = new Set<Promise<void>>();
  function trackEvaluation(promise: Promise<void>): void {
    activeEvaluations.add(promise);
    void promise.finally(() => activeEvaluations.delete(promise));
    // AB-260: layered on top of `activeEvaluations` (never replacing it) —
    // every judge evaluation also registers with the bureau's composed
    // `RuntimeServices.deferred`, so `deferred.drain()` reports it under the
    // stable `'background-evaluation'` label alongside every other
    // subsystem's fire-and-forget work.
    runtime.deferred.track(promise, 'background-evaluation');
  }

  // ── AB-220: per-evaluation liveness ─────────────────────────────────

  interface TrackedEvaluation {
    readonly id: string;
    readonly watchdog: StallWatchdog;
    readonly startedAt: string;
  }

  const trackedEvaluations = new Map<string, TrackedEvaluation>();

  function computeEvaluationSnapshot(tracked: TrackedEvaluation): EvaluationLivenessSnapshot {
    const assessed = tracked.watchdog.assess();
    const status: LivenessLifecycleStatus = 'running';
    return Object.freeze({
      id: tracked.id,
      kind: 'background-evaluation',
      startedAt: tracked.startedAt,
      revision: 0,
      status,
      lastTransitionAt: tracked.startedAt,
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: false,
      attempt: 0,
      reachability: assessed.reachability,
      progress: assessed.progress,
      assessment: deriveEvaluationAssessment(status, assessed.reachability, assessed.progress),
      observedAt: clock.now(),
      missedPulseCount: assessed.missedPulseCount,
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence: assessed.evidence,
    });
  }

  const aggregateStartedAt = runtime.clock.nowISO();
  let aggregateRevision = 0;
  let cachedAggregate: EvaluationLivenessSnapshot | undefined;
  let cachedAggregateRevision = -1;

  interface AggregateSubscriberRecord {
    readonly observer: (snapshot: EvaluationLivenessSnapshot) => void;
    closed: boolean;
    detachAbortListener: () => void;
  }

  const aggregateSubscribers = new Set<AggregateSubscriberRecord>();

  function computeAggregateSnapshot(): EvaluationLivenessSnapshot {
    const items = [...trackedEvaluations.values()].map(computeEvaluationSnapshot);
    const status: LivenessLifecycleStatus = 'running';
    const reachability = worstReachability(items.map((item) => item.reachability));
    const progress = worstProgress(items.map((item) => item.progress));
    return Object.freeze({
      id: AGGREGATE_EVALUATION_ID,
      kind: 'background-evaluation',
      startedAt: aggregateStartedAt,
      revision: aggregateRevision,
      status,
      lastTransitionAt: aggregateStartedAt,
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: false,
      attempt: 0,
      reachability,
      progress,
      assessment: worstAssessment(items.map((item) => item.assessment)),
      observedAt: clock.now(),
      missedPulseCount: items.reduce((max, item) => Math.max(max, item.missedPulseCount), 0),
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence: [],
    });
  }

  function readAggregateSnapshot(): EvaluationLivenessSnapshot {
    if (cachedAggregate && cachedAggregateRevision === aggregateRevision) {
      return cachedAggregate;
    }
    cachedAggregate = computeAggregateSnapshot();
    cachedAggregateRevision = aggregateRevision;
    return cachedAggregate;
  }

  function notifyAggregate(): void {
    const current = readAggregateSnapshot();
    for (const record of [...aggregateSubscribers]) {
      if (record.closed) continue;
      try {
        record.observer(current);
      } catch {
        // A throwing subscriber must not escape into the caller driving this
        // revision, matching `active-run-liveness.ts`'s own isolation.
      }
    }
  }

  function advanceAggregate(): void {
    aggregateRevision += 1;
    notifyAggregate();
  }

  function beginTrackedEvaluation(): TrackedEvaluation {
    const id = evaluationIds.next();
    const watchdog = createStallWatchdog(BACKGROUND_EVALUATION_POLICY, clock);
    const tracked: TrackedEvaluation = { id, watchdog, startedAt: runtime.clock.nowISO() };
    trackedEvaluations.set(id, tracked);
    advanceAggregate();
    return tracked;
  }

  function endTrackedEvaluation(tracked: TrackedEvaluation): void {
    tracked.watchdog.dispose();
    trackedEvaluations.delete(tracked.id);
    advanceAggregate();
  }

  function runTrackedEvaluation(runId: string, runResult: RunResult): Promise<void> {
    const tracked = beginTrackedEvaluation();
    return evaluateRun(runId, runResult).finally(() => endTrackedEvaluation(tracked));
  }

  async function recordScore(
    runId: string,
    judge: OnlineEvalJudge,
    result: EvalScore,
  ): Promise<void> {
    await auditTrail?.record({
      runId,
      type: 'eval.sample.recorded',
      detail: {
        judgeName: judge.name,
        pass: result.pass,
        score: result.score,
        message: result.message,
      },
    });
  }

  function fireAlert(runId: string, judge: OnlineEvalJudge, result: EvalScore): void {
    webhookNotifier?.notify({
      runId,
      subjectId: `eval:${runId}:${judge.name}`,
      trigger: EVAL_ALERT_TRIGGER,
      detail: {
        judgeName: judge.name,
        score: result.score,
        threshold: judge.alertThreshold,
        message: result.message,
      },
    });
  }

  async function evaluateRun(runId: string, runResult: RunResult): Promise<void> {
    for (const judge of judges) {
      // Checked before invoking the judge at all: `judge.evaluate()` is
      // called synchronously as an argument expression, so `raceAgainstAbort`
      // below only ever races an ALREADY-RUNNING judge against the abort —
      // it cannot stop the judge from starting in the first place. An
      // already-aborted signal must skip the judge outright rather than
      // start (and leak) an evaluation nobody is going to wait on.
      if (signal?.aborted) return;

      let result: EvalScore;
      try {
        result = await raceAgainstAbort(Promise.resolve(judge.evaluate(runResult)), signal);
      } catch (error) {
        // An aborted signal ends this evaluation promptly rather than
        // recording the interrupted judge as a score-0 failure — the abort
        // is a shutdown request, not a judge outcome.
        if (signal?.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        result = { pass: false, score: 0, message: `Judge threw: ${message}` };
      }

      if (signal?.aborted) return;

      await recordScore(runId, judge, result);

      // Rechecked after the audit write: the owner may have aborted while
      // `recordScore()` was awaiting a slow persistent write, and firing a
      // NEW webhook off the back of an evaluation the shutdown already
      // cancelled would enqueue delivery work past the abort boundary.
      if (signal?.aborted) return;

      if (breachesThreshold(judge, result)) {
        fireAlert(runId, judge, result);
      }
    }
  }

  const listener = (event: ActionEvent) => {
    const { action } = event;
    if (action.type !== 'run.completed') return;
    if (disposed) return;
    if (seenRuns.has(action.runId)) return;
    seenRuns.add(action.runId);

    observed++;
    if (rng() >= sampleRate) return;
    if (!isRunResultDetail(action.detail)) return;

    sampled++;
    trackEvaluation(runTrackedEvaluation(action.runId, action.detail));
  };

  bureau.addEventListener('action', listener);

  return {
    observedCount() {
      return observed;
    },
    sampledCount() {
      return sampled;
    },
    async flush(): Promise<void> {
      await Promise.allSettled([...activeEvaluations]);
    },
    async dispose(): Promise<void> {
      disposed = true;
      bureau.removeEventListener('action', listener);
      await Promise.allSettled([...activeEvaluations]);
    },
    activeEvaluationSnapshots(): EvaluationLivenessSnapshot[] {
      return [...trackedEvaluations.values()].map(computeEvaluationSnapshot);
    },
    snapshot(): EvaluationLivenessSnapshot {
      return readAggregateSnapshot();
    },
    subscribeSnapshot(
      observer: (snapshot: EvaluationLivenessSnapshot) => void,
      subscribeOptions?: { signal?: AbortSignal },
    ): Subscription {
      const subscriptionSignal = subscribeOptions?.signal;
      const record: AggregateSubscriberRecord = {
        observer,
        closed: false,
        detachAbortListener: () => subscriptionSignal?.removeEventListener('abort', unsubscribe),
      };

      function unsubscribe(): void {
        if (record.closed) return;
        record.closed = true;
        record.detachAbortListener();
        aggregateSubscribers.delete(record);
      }

      if (subscriptionSignal?.aborted) {
        record.closed = true;
        try {
          observer(readAggregateSnapshot());
        } catch {
          // Same isolation as `notifyAggregate()` above.
        }
        return {
          unsubscribe,
          get closed() {
            return record.closed;
          },
        };
      }

      aggregateSubscribers.add(record);
      subscriptionSignal?.addEventListener('abort', unsubscribe, { once: true });

      try {
        observer(readAggregateSnapshot());
      } catch {
        // Same isolation as `notifyAggregate()` above.
      }

      return {
        unsubscribe,
        get closed() {
          return record.closed;
        },
      };
    },
  };
}
