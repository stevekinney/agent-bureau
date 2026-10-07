/**
 * COR-851 — the durable audit projection of a goal: which events a record's
 * transitions produce, that replays and recovery never double-record, and that
 * nothing sensitive reaches an event.
 *
 * Runs the real goal store and the real durable event history over memory
 * storage, so what is asserted is what a reader of `{ kind: 'goal' }` history
 * would see.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import type { DurableEventEnvelope } from '@lostgradient/operative';
import { MemoryStorage, resolveStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createDurableEventHistory } from './durable-event-history';
import {
  createGoalEventRecorder,
  type GoalObservation,
  projectGoalHistory,
  projectGoalObservation,
} from './goal-event-projection';
import {
  createGoalState,
  type DurableGoalAttempt,
  type DurableGoalValidation,
  goalAttemptId,
  goalAttemptRunId,
  goalDecisionId,
  goalSessionId,
  type GoalState,
  goalTransitionId,
  goalWorkflowId,
} from './goal-state';
import { createGoalStore, type GoalTransitionRequest } from './goal-store';
import type { BureauDiagnostic } from './types';

const GOAL = 'goal-1';
const SECRET_FEEDBACK = 'FEEDBACK-the-secret-instructions';
const SECRET_EVIDENCE = 'EVIDENCE-the-secret-detail';
const SECRET_CAUSE = 'CAUSE-the-secret-internals';
const VALIDATOR = { name: 'tests', version: '1' } as const;

async function setup(options: { failRecording?: boolean } = {}) {
  const storage = await resolveStorage({ type: 'memory' });
  const runtime = createManualRuntimeServices();
  const history = createDurableEventHistory(storage, runtime);
  const diagnostics: BureauDiagnostic[] = [];
  const recorder = createGoalEventRecorder(
    options.failRecording === true
      ? {
          record: () => Promise.reject(new Error('the history is unavailable')),
        }
      : history,
    (diagnostic) => diagnostics.push(diagnostic),
  );
  const observed: GoalObservation[] = [];
  const store = createGoalStore(textValueStore(new MemoryStorage()), {
    observe: async (observation) => {
      observed.push(observation);
      await recorder(observation);
    },
  });
  async function events(id = GOAL): Promise<DurableEventEnvelope[]> {
    const page = await history.page({ kind: 'goal', id });
    if ('outcome' in page) throw new Error('unexpected gap');
    return [...page.events];
  }
  return { store, history, recorder, observed, diagnostics, events };
}

function attempt(index: number, overrides: Partial<DurableGoalAttempt> = {}): DurableGoalAttempt {
  return {
    attemptId: goalAttemptId(GOAL, index),
    attemptIndex: index,
    runId: goalAttemptRunId(GOAL, index),
    sessionId: goalSessionId(GOAL, 0),
    startedAt: '2026-10-02T00:00:05.000Z',
    usage: { steps: 0, tokens: 0 },
    status: 'running',
    ...overrides,
  };
}

function validation(outcome: DurableGoalValidation['outcome'], index = 0): DurableGoalValidation {
  return {
    identity: VALIDATOR,
    startedAt: '2026-10-02T00:01:00.000Z',
    completedAt: '2026-10-02T00:01:30.000Z',
    outcome,
    decisionId: goalDecisionId(goalAttemptId(GOAL, index)),
  };
}

let tick = 0;
function transition(
  seq: number,
  to: GoalTransitionRequest['to'],
  overrides: Partial<GoalTransitionRequest> = {},
): GoalTransitionRequest {
  return {
    goalRunId: GOAL,
    seq,
    transitionId: goalTransitionId(GOAL, seq),
    to,
    at: new Date(Date.UTC(2026, 9, 2, 0, 2, 10 + tick++)).toISOString(),
    cause: `to-${to}`,
    ...overrides,
  };
}

function newGoal(principal?: string): GoalState {
  return createGoalState({
    goalRunId: GOAL,
    identity: { name: 'ship-feature', version: '1' },
    objective: { agentName: 'builder', prompt: 'SECRET-prompt: make the tests pass.' },
    validator: VALIDATOR,
    conversationPolicy: { kind: 'continue' },
    bounds: { maximumAttempts: 3, maximumTotalTokens: 1000 },
    ...(principal === undefined ? {} : { principal }),
    now: '2026-10-02T00:00:00.000Z',
  });
}

type Store = Awaited<ReturnType<typeof setup>>['store'];

async function toEvaluating(store: Store, index = 0, firstSeq = 1) {
  await store.applyTransition(
    transition(firstSeq, 'running', {
      attempt: attempt(index),
      usage: { attempts: index + 1, steps: 0, tokens: 0, durationMs: 0 },
      active: {
        kind: 'attempt',
        attemptId: goalAttemptId(GOAL, index),
        runId: goalAttemptRunId(GOAL, index),
        startedAt: '2026-10-02T00:00:05.000Z',
      },
    }),
  );
  await store.applyTransition(
    transition(firstSeq + 1, 'evaluating', {
      attempt: attempt(index, { status: 'evaluating', finishReason: 'stop-condition' }),
      active: {
        kind: 'validation',
        attemptId: goalAttemptId(GOAL, index),
        validator: VALIDATOR,
        startedAt: '2026-10-02T00:01:00.000Z',
      },
    }),
  );
}

const summary = (events: readonly DurableEventEnvelope[]) => events.map((event) => event.kind);

describe('the goal event projection', () => {
  it('records the audit events of a goal that retries and then passes, and no live-only event', async () => {
    const { store, events } = await setup();
    await store.create(newGoal());
    await toEvaluating(store);
    await store.applyTransition(
      transition(3, 'retrying', {
        attempt: attempt(0, {
          status: 'failed',
          feedback: SECRET_FEEDBACK,
          validation: validation({
            kind: 'fail',
            feedback: SECRET_FEEDBACK,
            evidence: [{ source: 'unit', detail: SECRET_EVIDENCE }],
            retryable: true,
          }),
        }),
        active: null,
      }),
    );
    await toEvaluating(store, 1, 4);
    await store.applyTransition(
      transition(6, 'succeeded', {
        terminalReason: 'validator-passed',
        attempt: attempt(1, {
          status: 'passed',
          validation: validation({ kind: 'pass', evidence: [] }, 1),
        }),
        active: null,
      }),
    );

    const recorded = await events();

    // `goal.feedback.recorded`, `goal.retrying`, and `goal.cancellation-requested` are live-only.
    expect(summary(recorded)).toEqual([
      'goal.started',
      'goal.attempt.started',
      'goal.attempt.validated',
      'goal.attempt.started',
      'goal.attempt.validated',
      'goal.succeeded',
    ]);
    expect(recorded.map((event) => event.owner)).toEqual(
      recorded.map(() => ({ kind: 'goal', id: GOAL })),
    );
    expect(recorded[0]?.payload).toMatchObject({
      goalRunId: GOAL,
      goalIdentity: { name: 'ship-feature', version: '1' },
    });
    expect(recorded[1]?.payload).toMatchObject({
      goalRunId: GOAL,
      attemptId: goalAttemptId(GOAL, 0),
      attemptIndex: 0,
      runId: goalAttemptRunId(GOAL, 0),
    });
    expect(recorded[2]?.payload).toMatchObject({
      attemptId: goalAttemptId(GOAL, 0),
      validatorIdentity: VALIDATOR,
      outcomeKind: 'fail',
    });
    expect(recorded[4]?.payload).toMatchObject({ outcomeKind: 'pass' });
    expect(recorded[5]?.payload).toMatchObject({
      goalRunId: GOAL,
      terminalReason: 'validator-passed',
    });
  });

  it('carries only a digest of feedback, and nothing of the objective, evidence, or feedback text', async () => {
    const { store, events } = await setup();
    await store.create(newGoal());
    await toEvaluating(store);
    await store.applyTransition(
      transition(3, 'retrying', {
        attempt: attempt(0, {
          status: 'failed',
          feedback: SECRET_FEEDBACK,
          validation: validation({
            kind: 'fail',
            feedback: SECRET_FEEDBACK,
            evidence: [{ source: 'unit', detail: SECRET_EVIDENCE }],
            retryable: true,
          }),
        }),
        active: null,
      }),
    );

    const text = JSON.stringify(await events());

    expect(text).not.toContain(SECRET_FEEDBACK);
    expect(text).not.toContain(SECRET_EVIDENCE);
    expect(text).not.toContain('SECRET-prompt');
    const history = await events();
    const validated = history.find((event) => event.kind === 'goal.attempt.validated');
    expect(validated?.payload).toMatchObject({
      feedbackDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('names a failing validator error by kind, code, and message, with its cause stripped', async () => {
    const { store, events } = await setup();
    await store.create(newGoal());
    await toEvaluating(store);
    await store.applyTransition(
      transition(3, 'failed', {
        terminalReason: 'validator-infrastructure-error',
        failureDetail: 'DETAIL-the-secret-failure-detail',
        attempt: attempt(0, {
          status: 'failed',
          validation: validation({
            kind: 'error',
            error: {
              kind: 'execute',
              code: 'VALIDATOR_THREW',
              message: 'the validator threw',
              cause: { secret: SECRET_CAUSE },
            },
          }),
        }),
        active: null,
      }),
    );

    const recorded = await events();
    const failed = recorded.at(-1);

    expect(summary(recorded)).toEqual([
      'goal.started',
      'goal.attempt.started',
      'goal.attempt.validated',
      'goal.failed',
    ]);
    expect(failed?.payload).toEqual({
      goalRunId: GOAL,
      terminalReason: 'validator-infrastructure-error',
      validatorError: { kind: 'execute', code: 'VALIDATOR_THREW', message: 'the validator threw' },
    });
    expect(JSON.stringify(recorded)).not.toContain(SECRET_CAUSE);
    expect(JSON.stringify(recorded)).not.toContain('DETAIL-the-secret');
  });

  it('records a failure that names no validator error without one', async () => {
    const { store, events } = await setup();
    await store.create(newGoal());
    await toEvaluating(store);
    await store.applyTransition(
      transition(3, 'failed', {
        terminalReason: 'attempt-run-failed',
        attempt: attempt(0, { status: 'failed' }),
        active: null,
      }),
    );

    const history = await events();
    expect(history.at(-1)).toMatchObject({
      kind: 'goal.failed',
      payload: { goalRunId: GOAL, terminalReason: 'attempt-run-failed' },
    });
    expect(history.at(-1)?.payload).not.toHaveProperty('validatorError');
  });

  it.each([
    ['exhausted', 'aggregate-budget-exceeded', 'goal.exhausted'],
    ['canceled', 'goal-canceled', 'goal.canceled'],
  ] as const)(
    'records %s as %s with no validation event when nothing was validated',
    async (to, reason, kind) => {
      const { store, events } = await setup();
      await store.create(newGoal());
      await store.applyTransition(
        transition(1, 'running', {
          attempt: attempt(0),
          usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
          active: {
            kind: 'attempt',
            attemptId: goalAttemptId(GOAL, 0),
            runId: goalAttemptRunId(GOAL, 0),
            startedAt: '2026-10-02T00:00:05.000Z',
          },
        }),
      );
      if (to === 'canceled') {
        // A goal is canceled only after a cancellation was asked for.
        const at = '2026-10-02T00:00:06.000Z';
        await store.requestCancellation(GOAL, { requestedAt: at }, at);
      }
      await store.applyTransition(
        transition(2, to, {
          terminalReason: reason,
          attempt: attempt(0, { status: 'aborted' }),
          active: null,
        }),
      );

      const recorded = await events();

      expect(summary(recorded)).toEqual(['goal.started', 'goal.attempt.started', kind]);
      expect(recorded.at(-1)?.payload).toEqual({ goalRunId: GOAL, terminalReason: reason });
    },
  );

  it('records a goal that ends before any attempt as started then terminal', async () => {
    const { store, events } = await setup();
    await store.create(newGoal());
    await store.applyTransition(
      transition(1, 'failed', { terminalReason: 'unsupported-validation' }),
    );

    expect(summary(await events())).toEqual(['goal.started', 'goal.failed']);
  });

  it('stamps each event with its commit time, not the time of a replay', async () => {
    const { store, events } = await setup();
    await store.create(newGoal());
    const request = transition(1, 'failed', { terminalReason: 'unsupported-validation' });
    await store.applyTransition(request);

    const recorded = await events();

    expect(recorded.map((event) => event.emittedAtMs)).toEqual([
      Date.parse('2026-10-02T00:00:00.000Z'),
      Date.parse(request.at),
    ]);
  });

  it('stores a goal history under a workflow id that is not its controller workflow', async () => {
    // Weft deletes every fleet event carrying a workflow's id when it purges that
    // workflow, so `goal:<id>` (the controller's id) would lose the history on a restart.
    const storage = await resolveStorage({ type: 'memory' });
    const history = createDurableEventHistory(storage, createManualRuntimeServices());

    await history.record({ kind: 'goal', id: GOAL }, 'goal.started', {});

    const keys: string[] = [];
    for await (const [key] of storage.scan('fleet-event-by-workflow:')) keys.push(key);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(encodeURIComponent(goalWorkflowId(GOAL)));
  });

  describe('idempotence', () => {
    it('does not record a transition twice when its commit is replayed', async () => {
      const { store, events, observed } = await setup();
      await store.create(newGoal());
      const request = transition(1, 'failed', { terminalReason: 'unsupported-validation' });

      const first = await store.applyTransition(request);
      const replay = await store.applyTransition(request);

      expect([first.status, replay.status]).toEqual(['applied', 'duplicate']);
      // The replay really did reach the observer: the dedupe is the history's, not the store's.
      expect(observed.map((observation) => observation.kind)).toEqual([
        'created',
        'transitioned',
        'transitioned',
      ]);
      expect(summary(await events())).toEqual(['goal.started', 'goal.failed']);
    });

    it('repairs a projection that failed once, when the commit is replayed', async () => {
      const failing = await setup({ failRecording: true });
      await failing.store.create(newGoal());
      const request = transition(1, 'failed', { terminalReason: 'unsupported-validation' });
      const result = await failing.store.applyTransition(request);

      // The commit stands; only the audit write was lost, and it was diagnosed.
      expect(result.status).toBe('applied');
      expect(failing.diagnostics.map((diagnostic) => diagnostic.scope)).toEqual(['goals', 'goals']);
      expect(failing.diagnostics[1]?.message).toContain('goal.failed');
      expect(await failing.events()).toEqual([]);

      // The same observations, replayed against a working history, record exactly once each.
      const working = await setup();
      for (const observation of failing.observed) await working.recorder(observation);
      for (const observation of failing.observed) await working.recorder(observation);
      expect(summary(await working.events())).toEqual(['goal.started', 'goal.failed']);
    });

    it('projects every record at boot without duplicating what is already there', async () => {
      const { store, events, recorder } = await setup();
      await store.create(newGoal());
      await toEvaluating(store);
      await store.applyTransition(
        transition(3, 'succeeded', {
          terminalReason: 'validator-passed',
          attempt: attempt(0, {
            status: 'passed',
            validation: validation({ kind: 'pass', evidence: [] }),
          }),
          active: null,
        }),
      );
      const before = await events();

      await projectGoalHistory(await store.list(), recorder);
      await projectGoalHistory(await store.list(), recorder);

      expect(await events()).toEqual(before);
    });

    it('fills in a transition whose projection was lost, from the record at boot', async () => {
      const { store, events, recorder } = await setup();
      await store.create(newGoal());
      await store.applyTransition(
        transition(1, 'failed', { terminalReason: 'unsupported-validation' }),
      );
      // Simulate the crash window: nothing was ever recorded for this goal.
      const empty = await setup();

      await projectGoalHistory(await store.list(), empty.recorder);

      expect(summary(await empty.events())).toEqual(['goal.started', 'goal.failed']);
      // And the original history, which did record both, is unchanged by the same pass.
      const before = await events();
      await projectGoalHistory(await store.list(), recorder);
      expect(await events()).toEqual(before);
    });

    it('repairs a failed projection of an earlier transition after later transitions commit', async () => {
      // The first transitions' audit writes fail; every later one succeeds.
      const storage = await resolveStorage({ type: 'memory' });
      const history = createDurableEventHistory(storage, createManualRuntimeServices());
      let failing = true;
      const diagnostics: BureauDiagnostic[] = [];
      const recorder = createGoalEventRecorder(
        {
          record: (...recordArguments) =>
            failing
              ? Promise.reject(new Error('the history is unavailable'))
              : history.record(...recordArguments),
        },
        (diagnostic) => diagnostics.push(diagnostic),
      );
      const store = createGoalStore(textValueStore(new MemoryStorage()), { observe: recorder });
      await store.create(newGoal());
      await toEvaluating(store);
      failing = false;
      await store.applyTransition(
        transition(3, 'succeeded', {
          terminalReason: 'validator-passed',
          attempt: attempt(0, {
            status: 'passed',
            validation: validation({ kind: 'pass', evidence: [] }),
          }),
          active: null,
        }),
      );
      const page = async () => {
        const result = await history.page({ kind: 'goal', id: GOAL });
        if ('outcome' in result) throw new Error('unexpected gap');
        return summary(result.events);
      };
      // Only the transitions committed after the outage were recorded.
      expect(await page()).toEqual(['goal.attempt.validated', 'goal.succeeded']);

      await projectGoalHistory(await store.list(), recorder);

      expect(await page()).toEqual([
        'goal.attempt.validated',
        'goal.succeeded',
        'goal.started',
        'goal.attempt.started',
      ]);
      // Replaying the same boot pass changes nothing.
      await projectGoalHistory(await store.list(), recorder);
      expect(await page()).toHaveLength(4);
    });

    it('re-projects a restart whose event was lost, after a later restart', async () => {
      const plain = createGoalStore(textValueStore(new MemoryStorage()));
      await plain.create(newGoal());
      await plain.recordControllerRestart(GOAL, '2026-10-02T00:05:00.000Z');
      await plain.recordControllerRestart(GOAL, '2026-10-02T00:06:00.000Z');
      const fresh = await setup();

      await projectGoalHistory(await plain.list(), fresh.recorder);

      const history = await fresh.events();
      expect(
        history
          .filter((event) => event.kind === 'goal.recovered')
          .map((event) => (event.payload as { controllerRestarts: number }).controllerRestarts),
      ).toEqual([1, 2]);
    });

    it('does not change a commit when the observer throws', async () => {
      const diagnostics: unknown[] = [];
      const store = createGoalStore(textValueStore(new MemoryStorage()), {
        observe: () => {
          throw new Error('observer failed');
        },
        onObserverError: (error) => diagnostics.push(error),
      });

      const created = await store.create(newGoal());
      const result = await store.applyTransition(
        transition(1, 'failed', { terminalReason: 'unsupported-validation' }),
      );

      expect(created.status).toBe('created');
      expect(result.status).toBe('applied');
      expect(diagnostics).toHaveLength(2);
    });
  });

  describe('goal.recovered', () => {
    it('records one event per controller restart, none for a repeated observation', async () => {
      const { store, events, recorder } = await setup();
      await store.create(newGoal());
      await toEvaluating(store);

      const first = await store.recordControllerRestart(GOAL, '2026-10-02T00:05:00.000Z');
      const second = await store.recordControllerRestart(GOAL, '2026-10-02T00:06:00.000Z');
      if (first.status !== 'updated') throw new Error('expected an updated record');
      await recorder({ kind: 'controller-restarted', record: first.record });

      const history = await events();
      const recovered = history.filter((event) => event.kind === 'goal.recovered');

      expect(second.status).toBe('updated');
      expect(recovered.map((event) => event.payload)).toEqual([
        { goalRunId: GOAL, controllerRestarts: 1, status: 'evaluating', transitionSeq: 2 },
        { goalRunId: GOAL, controllerRestarts: 2, status: 'evaluating', transitionSeq: 2 },
      ]);
      expect(recovered.map((event) => event.emittedAtMs)).toEqual([
        Date.parse('2026-10-02T00:05:00.000Z'),
        Date.parse('2026-10-02T00:06:00.000Z'),
      ]);
    });

    it('records nothing for a restart the store refused', async () => {
      const { store, events } = await setup();
      await store.create(newGoal());
      await store.applyTransition(
        transition(1, 'failed', { terminalReason: 'unsupported-validation' }),
      );

      const result = await store.recordControllerRestart(GOAL, '2026-10-02T00:05:00.000Z');

      expect(result.status).toBe('rejected');
      expect(summary(await events())).toEqual(['goal.started', 'goal.failed']);
    });
  });

  describe('projectGoalObservation', () => {
    it('projects nothing for a transition that only moves the goal along', async () => {
      const { store, observed } = await setup();
      await store.create(newGoal());
      await toEvaluating(store);

      const evaluating = observed.at(-1);
      if (evaluating === undefined) throw new Error('no observation');

      expect(evaluating.record.status).toBe('evaluating');
      expect(projectGoalObservation(evaluating)).toEqual([]);
    });

    it('keys a transition on the goal and its sequence number', async () => {
      const { store, observed } = await setup();
      await store.create(newGoal());
      await store.applyTransition(
        transition(1, 'failed', { terminalReason: 'unsupported-validation' }),
      );

      const keys = observed.flatMap((observation) =>
        projectGoalObservation(observation).map((draft) => [draft.kind, draft.dedupeKey]),
      );

      expect(keys).toEqual([
        ['goal.started', `${GOAL}:0`],
        ['goal.failed', `${GOAL}:1`],
      ]);
    });
  });
});
