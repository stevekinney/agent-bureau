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
 * Sampling is driven by an injectable RNG (`Math.random` by default) so
 * `sampleRate` is deterministic and testable — a fake RNG that returns a
 * fixed sequence exercises "sampled" and "not sampled" runs exactly.
 */
import { Conversation } from 'conversationalist';
import type { RunResult } from 'operative';

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
  /** Injectable RNG returning a value in `[0, 1)`. Defaults to `Math.random`. */
  rng?: () => number;
}

/** The online eval sampler object returned by {@link createOnlineEvalSampler}. */
export interface OnlineEvalSampler {
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
  /** Stop listening to bureau events. */
  dispose(): void;
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
export function createOnlineEvalSampler(
  bureau: Bureau,
  auditTrail: AuditTrail | undefined,
  webhookNotifier: WebhookNotifier | undefined,
  options: OnlineEvalSamplerOptions | undefined,
): OnlineEvalSampler {
  const judges = options?.judges ?? [];

  if (judges.length === 0 || !options || options.sampleRate <= 0) {
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
      dispose() {
        // Nothing was ever subscribed.
      },
    };
  }

  const sampleRate = options.sampleRate;
  const rng = options.rng ?? Math.random;

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
      let result: EvalScore;
      try {
        result = await judge.evaluate(runResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { pass: false, score: 0, message: `Judge threw: ${message}` };
      }

      await recordScore(runId, judge, result);

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
    trackEvaluation(evaluateRun(action.runId, action.detail));
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
    dispose(): void {
      disposed = true;
      bureau.removeEventListener('action', listener);
    },
  };
}
