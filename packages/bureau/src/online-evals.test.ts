/**
 * Tests for `createOnlineEvalSampler` (AB-53).
 *
 * Uses a hand-crafted `Bureau` stub — same pattern as `webhook-notifier.test.ts`
 * — and a fake `WebhookNotifier` so alert delivery is observed without a real
 * durable pipeline. Sampling is driven by an injected RNG so `sampleRate` is
 * exercised deterministically: no test depends on `Math.random`.
 */
import type { RunResult } from '@lostgradient/operative';
import { LIVENESS_POLICY_VERSION, type StallWatchdogClock } from '@lostgradient/operative/liveness';
import type { Action } from '@lostgradient/operative/store';
import { describe, expect, it, spyOn } from 'bun:test';
import { Conversation } from 'conversationalist';

import type { AuditTrail } from './audit-trail';
import { ActionEvent } from './events';
import {
  createOnlineEvalSampler,
  type EvalScore,
  type EvaluationIdentifierSeam,
  type OnlineEvalJudge,
  realClock,
  worstAssessment,
  worstProgress,
  worstReachability,
} from './online-evals';
import type { Bureau } from './types';
import type { WebhookDeliveryLivenessSnapshot, WebhookNotifier } from './webhook-notifier';

// ── Minimal Bureau stub ──────────────────────────────────────────────

type ActionListener = (event: ActionEvent) => void;

function createStubBureau(): { bureau: Bureau; emit: (action: Action) => void } {
  const listeners = new Set<ActionListener>();

  const bureau = {
    addEventListener(_type: string, listener: ActionListener) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: ActionListener) {
      listeners.delete(listener);
    },
  } as unknown as Bureau;

  const emit = (action: Action) => {
    const event = new ActionEvent(action);
    for (const listener of listeners) {
      listener(event);
    }
  };

  return { bureau, emit };
}

function makeAction(overrides: Partial<Action> & { type: string; runId: string }): Action {
  return {
    sequence: 1,
    detail: null,
    timestamp: 1_000,
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    conversation: new Conversation(),
    steps: [],
    content: 'the final answer',
    usage: { prompt: 10, completion: 5, total: 15 },
    finishReason: 'stop',
    ...overrides,
  } as RunResult;
}

function createStubAuditTrail(): { auditTrail: AuditTrail; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const auditTrail: AuditTrail = {
    async record(entry) {
      records.push(entry);
    },
    async query() {
      return [];
    },
    async dispose() {},
  };
  return { auditTrail, records };
}

interface RecordedNotification {
  runId: string;
  subjectId: string;
  trigger: string;
  detail?: Record<string, unknown>;
}

function createStubWebhookNotifier(): {
  webhookNotifier: WebhookNotifier;
  notifications: RecordedNotification[];
} {
  const notifications: RecordedNotification[] = [];
  const noOpSnapshot: WebhookDeliveryLivenessSnapshot = {
    id: 'stub-webhook-notifier',
    kind: 'webhook-delivery',
    startedAt: new Date().toISOString(),
    revision: 0,
    status: 'terminal',
    lastTransitionAt: new Date().toISOString(),
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
  };
  const webhookNotifier: WebhookNotifier = {
    async listDeliveries() {
      return [];
    },
    async flush() {},
    notify(input) {
      notifications.push(input);
    },
    async dispose() {},
    activeDeliverySnapshots() {
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
  return { webhookNotifier, notifications };
}

/** Deterministic RNG that replays a fixed sequence, then repeats the last value. */
function scriptedRng(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)]!;
    index++;
    return value;
  };
}

/** A timer-agnostic manual clock (AB-220) — no real timers, `setTimeout`/`clearTimeout` unused by a no-cadence policy. */
function manualClock(start = 0): StallWatchdogClock & { advance: (milliseconds: number) => void } {
  let time = start;
  return {
    now: () => time,
    setTimeout: () => 0,
    clearTimeout: () => {},
    advance(milliseconds: number) {
      time += milliseconds;
    },
  };
}

/** A scripted `EvaluationIdentifierSeam` that replays a fixed sequence of ids. */
function scriptedEvaluationIds(ids: string[]): EvaluationIdentifierSeam {
  let index = 0;
  return {
    next(): string {
      const id = ids[index];
      if (id === undefined) throw new Error('scriptedEvaluationIds: ran out of scripted ids');
      index++;
      return id;
    },
  };
}

/** A judge whose `evaluate()` never resolves until `resolveAll()` is called. */
function blockingJudge(name = 'blocking-judge'): {
  judge: OnlineEvalJudge;
  resolveAll: () => void;
} {
  const resolvers: (() => void)[] = [];
  const judge: OnlineEvalJudge = {
    name,
    evaluate: () =>
      new Promise<EvalScore>((resolve) => {
        resolvers.push(() => resolve({ pass: true, score: 1, message: 'unblocked' }));
      }),
  };
  return {
    judge,
    resolveAll: () => {
      for (const resolve of resolvers) resolve();
    },
  };
}

function passingMatcher(name = 'exact-match'): OnlineEvalJudge {
  return {
    name,
    evaluate: (): EvalScore => ({ pass: true, score: 1, message: 'matched' }),
  };
}

function failingMatcher(name = 'exact-match', score = 0): OnlineEvalJudge {
  return {
    name,
    evaluate: (): EvalScore => ({ pass: false, score, message: 'did not match' }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('createOnlineEvalSampler', () => {
  it('is a no-op when no judges are configured', async () => {
    const { bureau } = createStubBureau();
    const sampler = createOnlineEvalSampler(bureau, undefined, undefined, {
      judges: [],
      sampleRate: 1,
    });
    expect(sampler.observedCount()).toBe(0);
    expect(sampler.sampledCount()).toBe(0);
    await sampler.flush();
    await sampler.dispose();
  });

  it('is a no-op when sampleRate is 0', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [passingMatcher()],
      sampleRate: 0,
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(sampler.observedCount()).toBe(0);
    expect(records).toHaveLength(0);
    await sampler.dispose();
  });

  it('ignores non-run.completed actions', async () => {
    const { bureau, emit } = createStubBureau();
    const sampler = createOnlineEvalSampler(bureau, undefined, undefined, {
      judges: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(sampler.observedCount()).toBe(0);
    await sampler.dispose();
  });

  // ── Fraction respected ─────────────────────────────────────────────

  it('respects sampleRate: a roll below sampleRate samples, at/above does not', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    // sampleRate 0.5: rolls of 0.1 (sampled), 0.9 (not sampled), 0.4 (sampled).
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [passingMatcher()],
      sampleRate: 0.5,
      rng: scriptedRng([0.1, 0.9, 0.4]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    emit(makeAction({ type: 'run.completed', runId: 'run-2', detail: makeRunResult() }));
    emit(makeAction({ type: 'run.completed', runId: 'run-3', detail: makeRunResult() }));
    await sampler.flush();

    expect(sampler.observedCount()).toBe(3);
    expect(sampler.sampledCount()).toBe(2);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r['runId'])).toEqual(['run-1', 'run-3']);

    await sampler.dispose();
  });

  it('never samples a run when sampleRate is 1 regardless of RNG output', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0.999999]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(sampler.sampledCount()).toBe(1);
    expect(records).toHaveLength(1);
    await sampler.dispose();
  });

  it('samples a run.completed action at most once, even if the action fires twice', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    emit(
      makeAction({ type: 'run.completed', runId: 'run-1', sequence: 2, detail: makeRunResult() }),
    );
    await sampler.flush();

    expect(sampler.observedCount()).toBe(1);
    expect(records).toHaveLength(1);
    await sampler.dispose();
  });

  // ── Scores recorded ────────────────────────────────────────────────

  it('records every judge score to the audit trail for a sampled run', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [passingMatcher('judge-a'), failingMatcher('judge-b', 0.2)],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      runId: 'run-1',
      type: 'eval.sample.recorded',
      detail: { judgeName: 'judge-a', pass: true, score: 1, message: 'matched' },
    });
    expect(records[1]).toMatchObject({
      runId: 'run-1',
      type: 'eval.sample.recorded',
      detail: { judgeName: 'judge-b', pass: false, score: 0.2, message: 'did not match' },
    });

    await sampler.dispose();
  });

  it('records a failed judge (throws) as a score-0 audit entry instead of crashing', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const throwingJudge: OnlineEvalJudge = {
      name: 'flaky-judge',
      evaluate: () => {
        throw new Error('judge exploded');
      },
    };
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [throwingJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId: 'run-1',
      type: 'eval.sample.recorded',
      detail: { judgeName: 'flaky-judge', pass: false, score: 0 },
    });

    await sampler.dispose();
  });

  it('skips sampling when the action detail is not a RunResult-shaped object', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: { not: 'a run result' } }));
    await sampler.flush();

    expect(sampler.observedCount()).toBe(1);
    expect(sampler.sampledCount()).toBe(0);
    expect(records).toHaveLength(0);

    await sampler.dispose();
  });

  // ── Threshold breach fires webhook (neuter-verified) ────────────────

  it('fires a webhook via the notifier when a judge score breaches alertThreshold', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail } = createStubAuditTrail();
    const { webhookNotifier, notifications } = createStubWebhookNotifier();
    const breachingJudge: OnlineEvalJudge = {
      name: 'quality-judge',
      alertThreshold: 0.5,
      evaluate: (): EvalScore => ({ pass: true, score: 0.2, message: 'quality dropped' }),
    };
    const sampler = createOnlineEvalSampler(bureau, auditTrail, webhookNotifier, {
      judges: [breachingJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      runId: 'run-1',
      subjectId: 'eval:run-1:quality-judge',
      trigger: 'eval.threshold-breached',
      detail: {
        judgeName: 'quality-judge',
        score: 0.2,
        threshold: 0.5,
        message: 'quality dropped',
      },
    });

    await sampler.dispose();
  });

  it('does NOT fire a webhook when the score is at or above alertThreshold', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail } = createStubAuditTrail();
    const { webhookNotifier, notifications } = createStubWebhookNotifier();
    const okJudge: OnlineEvalJudge = {
      name: 'quality-judge',
      alertThreshold: 0.5,
      evaluate: (): EvalScore => ({ pass: true, score: 0.5, message: 'fine' }),
    };
    const sampler = createOnlineEvalSampler(bureau, auditTrail, webhookNotifier, {
      judges: [okJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(notifications).toHaveLength(0);
    await sampler.dispose();
  });

  it('falls back to firing on pass:false when no alertThreshold is configured', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail } = createStubAuditTrail();
    const { webhookNotifier, notifications } = createStubWebhookNotifier();
    const sampler = createOnlineEvalSampler(bureau, auditTrail, webhookNotifier, {
      judges: [failingMatcher('no-threshold-judge', 0.9)],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.trigger).toBe('eval.threshold-breached');

    await sampler.dispose();
  });

  it('does not fire a webhook when no notifier is configured, even on breach', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const breachingJudge: OnlineEvalJudge = {
      name: 'quality-judge',
      alertThreshold: 0.5,
      evaluate: (): EvalScore => ({ pass: false, score: 0.1, message: 'bad' }),
    };
    // No webhookNotifier passed (undefined) — the breach is still recorded.
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [breachingJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(1);
    await sampler.dispose();
  });

  it('NEUTER: removing the threshold check would fire a webhook for a passing score (guards the guard)', async () => {
    // This test documents the property the implementation must uphold: a
    // score comfortably above threshold must never fire. If `breachesThreshold`
    // were neutered to `return true` unconditionally, this assertion fails.
    const { bureau, emit } = createStubBureau();
    const { auditTrail } = createStubAuditTrail();
    const { webhookNotifier, notifications } = createStubWebhookNotifier();
    const healthyJudge: OnlineEvalJudge = {
      name: 'quality-judge',
      alertThreshold: 0.1,
      evaluate: (): EvalScore => ({ pass: true, score: 0.95, message: 'excellent' }),
    };
    const sampler = createOnlineEvalSampler(bureau, auditTrail, webhookNotifier, {
      judges: [healthyJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(notifications).toHaveLength(0);
    await sampler.dispose();
  });

  it('stops observing actions after dispose', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    await sampler.dispose();
    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(0);
  });

  // ── Awaitable dispose() and AbortSignal threading (AB-37/AB-206) ────

  it('dispose() returns a promise that resolves only after every in-flight evaluateRun() settles', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();

    let releaseJudge: (() => void) | undefined;
    const gatedJudge: OnlineEvalJudge = {
      name: 'gated-judge',
      evaluate: () =>
        new Promise<EvalScore>((resolve) => {
          releaseJudge = () => resolve({ pass: true, score: 1, message: 'released' });
        }),
    };
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [gatedJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));

    let disposeResolved = false;
    const disposePromise = sampler.dispose().then(() => {
      disposeResolved = true;
    });

    // Give the gated evaluation's microtasks a chance to run: dispose() must
    // still be pending because the judge has not been released.
    await Promise.resolve();
    await Promise.resolve();
    expect(disposeResolved).toBe(false);
    expect(records).toHaveLength(0);

    releaseJudge?.();
    await disposePromise;

    expect(disposeResolved).toBe(true);
    expect(records).toHaveLength(1);
  });

  it('threads the owner-issued AbortSignal into every evaluateRun() judge invocation, unblocking a never-settling judge on abort', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const controller = new AbortController();

    // A judge that never settles on its own: if `options.signal` were not
    // actually threaded into this judge's race, `flush()` below would hang
    // forever instead of resolving once the signal aborts.
    const neverSettlingJudge: OnlineEvalJudge = {
      name: 'never-settling-judge',
      evaluate: () => new Promise<EvalScore>(() => {}),
    };
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [neverSettlingJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
      signal: controller.signal,
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));

    // Give the sampler a chance to kick off the judge's evaluation before
    // aborting it.
    await Promise.resolve();
    controller.abort(new Error('shutting down'));

    await sampler.flush();

    expect(records).toHaveLength(0);
    await sampler.dispose();
  });

  it('aborting the signal mid-evaluation settles the affected evaluateRun() promptly, skipping remaining judges', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const controller = new AbortController();

    let releaseFirstJudge: (() => void) | undefined;
    const firstJudge: OnlineEvalJudge = {
      name: 'first-judge',
      evaluate: () =>
        new Promise<EvalScore>((resolve) => {
          releaseFirstJudge = () => resolve({ pass: true, score: 1, message: 'first' });
        }),
    };
    let secondJudgeCalled = false;
    const secondJudge: OnlineEvalJudge = {
      name: 'second-judge',
      evaluate: (): EvalScore => {
        secondJudgeCalled = true;
        return { pass: true, score: 1, message: 'second' };
      },
    };
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [firstJudge, secondJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
      signal: controller.signal,
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));

    // Give the sampler a chance to kick off the first judge's evaluation
    // before aborting mid-evaluation.
    await Promise.resolve();
    controller.abort(new Error('shutting down'));

    await sampler.flush();

    expect(secondJudgeCalled).toBe(false);
    expect(records).toHaveLength(0);

    // The first judge's own promise settling later (as if it had continued
    // running in the background) must not resurrect the aborted evaluation.
    releaseFirstJudge?.();
    await sampler.flush();
    expect(records).toHaveLength(0);

    await sampler.dispose();
  });

  it('a judge that aborts the signal as a side effect of starting settles promptly via the already-aborted race branch', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const controller = new AbortController();

    // The top-of-loop `if (signal?.aborted) return;` check only catches a
    // signal already aborted BEFORE this judge starts. This judge instead
    // aborts as a side effect of its own synchronous invocation — the
    // signal is still unaborted when the loop check runs, but IS aborted by
    // the time `raceAgainstAbort`'s internal `whenAborted()` observes it a
    // few synchronous steps later, exercising that already-aborted-at-race
    // -time branch rather than the abort-mid-wait one.
    const selfAbortingJudge: OnlineEvalJudge = {
      name: 'self-aborting-judge',
      evaluate: () => {
        controller.abort(new Error('aborted by the judge itself'));
        return new Promise<EvalScore>(() => {});
      },
    };
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [selfAbortingJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
      signal: controller.signal,
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(0);
    await sampler.dispose();
  });

  it('an already-aborted signal at evaluation start settles evaluateRun promptly without invoking the judge or recording a score', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const controller = new AbortController();
    controller.abort(new Error('shutting down before evaluation started'));

    // Tracks whether the judge was actually invoked, not just whether the
    // eventual race against `signal` rejects — `judge.evaluate(runResult)`
    // is evaluated as a plain argument expression BEFORE `raceAgainstAbort`
    // runs, so a race-only guard cannot prevent the judge from starting.
    let judgeInvoked = false;
    const trackedJudge: OnlineEvalJudge = {
      name: 'tracked-judge',
      evaluate: () => {
        judgeInvoked = true;
        return { pass: true, score: 1, message: 'ok' };
      },
    };

    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [trackedJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
      signal: controller.signal,
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(judgeInvoked).toBe(false);
    expect(records).toHaveLength(0);
    await sampler.dispose();
  });

  it('aborting the signal while the audit write is in flight suppresses the alert fired after it settles', async () => {
    const { bureau, emit } = createStubBureau();
    const controller = new AbortController();

    // Gates `auditTrail.record()` so the signal can be aborted WHILE
    // `recordScore()` is mid-await, after the judge already reported a
    // threshold breach but before `fireAlert()` would run.
    let releaseRecord: (() => void) | undefined;
    const records: Record<string, unknown>[] = [];
    const auditTrail: AuditTrail = {
      record(entry) {
        records.push(entry);
        return new Promise<void>((resolve) => {
          releaseRecord = resolve;
        });
      },
      async query() {
        return [];
      },
      async dispose() {},
    };
    const { webhookNotifier, notifications } = createStubWebhookNotifier();

    const breachingJudge: OnlineEvalJudge = {
      name: 'breaching-judge',
      evaluate: () => ({ pass: false, score: 0, message: 'breach' }),
    };
    const sampler = createOnlineEvalSampler(bureau, auditTrail, webhookNotifier, {
      judges: [breachingJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
      signal: controller.signal,
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));

    // Give the judge's microtasks a chance to run and reach the gated
    // audit write.
    while (records.length === 0) {
      await Promise.resolve();
    }
    expect(records).toHaveLength(1);

    controller.abort(new Error('shutting down mid audit write'));
    releaseRecord?.();
    await sampler.flush();

    // The audit write itself already landed (best-effort, in flight before
    // the abort), but the NEW webhook alert enqueued after it must not fire
    // once the owner has aborted.
    expect(notifications).toHaveLength(0);
    await sampler.dispose();
  });

  it('calling dispose() twice does not throw and the second call resolves promptly', async () => {
    const { bureau } = createStubBureau();
    const { auditTrail } = createStubAuditTrail();
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    const firstDispose = await sampler.dispose();
    expect(firstDispose).toBeUndefined();
    const secondDispose = await sampler.dispose();
    expect(secondDispose).toBeUndefined();
  });

  // ── AB-220: per-evaluation liveness ─────────────────────────────────

  describe('per-evaluation liveness (AB-220)', () => {
    it('mints a stable, distinguishable id for each concurrently-admitted evaluation', async () => {
      const { bureau, emit } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const { judge: judgeA, resolveAll: resolveA } = blockingJudge('judge-a');
      const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
        judges: [judgeA],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
        evaluationIds: scriptedEvaluationIds(['eval-a', 'eval-b']),
      });

      emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
      emit(makeAction({ type: 'run.completed', runId: 'run-2', detail: makeRunResult() }));

      const snapshots = sampler.activeEvaluationSnapshots();
      expect(snapshots).toHaveLength(2);
      expect(snapshots.map((snapshot) => snapshot.id)).toEqual(['eval-a', 'eval-b']);
      expect(new Set(snapshots.map((snapshot) => snapshot.id)).size).toBe(2);

      resolveA();
      await sampler.flush();
      await sampler.dispose();
    });

    it('every per-evaluation snapshot has kind "background-evaluation" and the current policy version', async () => {
      const { bureau, emit } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const { judge, resolveAll } = blockingJudge();
      const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
        judges: [judge],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });

      emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));

      const [snapshot] = sampler.activeEvaluationSnapshots();
      expect(snapshot?.kind).toBe('background-evaluation');
      expect(snapshot?.policyVersion).toBe(LIVENESS_POLICY_VERSION);
      expect(snapshot?.status).toBe('running');
      expect(snapshot?.assessment).toBe('healthy');

      resolveAll();
      await sampler.flush();
      await sampler.dispose();
    });

    it('removes an evaluation from activeEvaluationSnapshots() once it settles', async () => {
      const { bureau, emit } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
        judges: [passingMatcher()],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });

      emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
      await sampler.flush();

      expect(sampler.activeEvaluationSnapshots()).toHaveLength(0);
      await sampler.dispose();
    });

    it('snapshot() reports the instance-level aggregate as healthy with no active evaluations', async () => {
      const { bureau } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
        judges: [passingMatcher()],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });

      expect(sampler.snapshot().assessment).toBe('healthy');
      expect(sampler.snapshot().kind).toBe('background-evaluation');
      await sampler.dispose();
    });

    it('subscribeSnapshot() delivers the current aggregate immediately, then again as evaluations start and finish', async () => {
      const { bureau, emit } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
        judges: [passingMatcher()],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });

      const revisions: number[] = [];
      const subscription = sampler.subscribeSnapshot((snapshot) => {
        revisions.push(snapshot.revision);
      });
      expect(revisions).toEqual([0]);

      emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
      await sampler.flush();

      // One notification when the evaluation started tracking, one when it
      // finished — both delivered through the same subscription.
      expect(revisions.length).toBeGreaterThanOrEqual(3);
      expect(revisions).toEqual([...revisions].sort((a, b) => a - b));

      subscription.unsubscribe();
      await sampler.dispose();
    });

    it('subscribeSnapshot() stops delivering after unsubscribe()', async () => {
      const { bureau, emit } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
        judges: [passingMatcher()],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });

      let calls = 0;
      const subscription = sampler.subscribeSnapshot(() => {
        calls++;
      });
      expect(calls).toBe(1);
      subscription.unsubscribe();
      expect(subscription.closed).toBe(true);

      emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
      await sampler.flush();

      expect(calls).toBe(1);
      await sampler.dispose();
    });

    it('subscribeSnapshot() with an already-aborted signal delivers once, synchronously closed', async () => {
      const { bureau } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
        judges: [passingMatcher()],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });

      const controller = new AbortController();
      controller.abort();

      let calls = 0;
      const subscription = sampler.subscribeSnapshot(() => calls++, {
        signal: controller.signal,
      });

      expect(calls).toBe(1);
      expect(subscription.closed).toBe(true);
      await sampler.dispose();
    });

    it('the no-op sampler (no judges) reports a terminal aggregate snapshot and no active evaluations', async () => {
      const { bureau } = createStubBureau();
      const sampler = createOnlineEvalSampler(bureau, undefined, undefined, {
        judges: [],
        sampleRate: 1,
      });

      expect(sampler.activeEvaluationSnapshots()).toEqual([]);
      expect(sampler.snapshot().status).toBe('terminal');
      expect(sampler.snapshot().assessment).toBe('terminal');

      let observed: unknown;
      const subscription = sampler.subscribeSnapshot((snapshot) => {
        observed = snapshot;
      });
      expect(observed).toBe(sampler.snapshot());
      expect(subscription.closed).toBe(true);
      subscription.unsubscribe();

      await sampler.dispose();
    });
  });

  describe('the default production clock (AB-220)', () => {
    it('now() reads performance.now()', () => {
      expect(typeof realClock.now()).toBe('number');
    });

    it('setTimeout()/clearTimeout() delegate to the global timer functions', () => {
      const timeoutSpy = spyOn(globalThis, 'setTimeout');
      const clearSpy = spyOn(globalThis, 'clearTimeout');
      try {
        const callback = () => {};
        const handle = realClock.setTimeout(callback, 5);
        expect(timeoutSpy).toHaveBeenCalledWith(callback, 5);
        realClock.clearTimeout(handle);
        expect(clearSpy).toHaveBeenCalledWith(handle);
      } finally {
        timeoutSpy.mockRestore();
        clearSpy.mockRestore();
      }
    });
  });

  describe('worstAssessment/worstReachability/worstProgress (AB-220)', () => {
    it('worstAssessment returns "healthy" for an empty or all-healthy set', () => {
      expect(worstAssessment([])).toBe('healthy');
      expect(worstAssessment(['healthy', 'healthy'])).toBe('healthy');
    });

    it('worstAssessment picks the most severe non-terminal assessment, skipping terminal entries', () => {
      expect(worstAssessment(['healthy', 'alive-but-stalled', 'legitimately-waiting'])).toBe(
        'alive-but-stalled',
      );
      expect(worstAssessment(['terminal', 'unreachable', 'healthy'])).toBe('unreachable');
    });

    it('worstReachability returns "unknown" for an empty set, and folds to the most severe value present', () => {
      expect(worstReachability([])).toBe('unknown');
      expect(worstReachability(['reachable', 'unreachable', 'late'])).toBe('unreachable');
    });

    it('worstProgress returns "unknown" for an empty set, and folds to the most severe value present', () => {
      expect(worstProgress([])).toBe('unknown');
      expect(worstProgress(['progressing', 'stalled', 'idle'])).toBe('stalled');
    });
  });
});
