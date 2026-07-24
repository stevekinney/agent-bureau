/**
 * Tests for `createOnlineEvalSampler` (AB-53).
 *
 * Uses a hand-crafted `Bureau` stub — same pattern as `webhook-notifier.test.ts`
 * — and a fake `WebhookNotifier` so alert delivery is observed without a real
 * durable pipeline. Sampling is driven by an injected RNG so `sampleRate` is
 * exercised deterministically: no test depends on `Math.random`.
 */
import type { RunResult } from '@lostgradient/operative';
import type { Action } from '@lostgradient/operative/store';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import type { AuditTrail } from './audit-trail';
import { ActionEvent } from './events';
import { createOnlineEvalSampler, type EvalScore, type OnlineEvalJudge } from './online-evals';
import type { Bureau } from './types';
import type { WebhookNotifier } from './webhook-notifier';

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
      records.push(entry as Record<string, unknown>);
    },
    async query() {
      return [];
    },
    dispose() {},
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
  const webhookNotifier: WebhookNotifier = {
    async listDeliveries() {
      return [];
    },
    async flush() {},
    notify(input) {
      notifications.push(input);
    },
    dispose() {},
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
    sampler.dispose();
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
    sampler.dispose();
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
    sampler.dispose();
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

    sampler.dispose();
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
    sampler.dispose();
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
    sampler.dispose();
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

    sampler.dispose();
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

    sampler.dispose();
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

    sampler.dispose();
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

    sampler.dispose();
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
    sampler.dispose();
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

    sampler.dispose();
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
    sampler.dispose();
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
    sampler.dispose();
  });

  it('stops observing actions after dispose', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createOnlineEvalSampler(bureau, auditTrail, undefined, {
      judges: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    sampler.dispose();
    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(0);
  });
});
