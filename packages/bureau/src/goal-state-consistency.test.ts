/**
 * COR-851 — the goal record decoder refuses a record whose status, attempts, and
 * active work contradict each other, and the store can never write one.
 */
import type { GoalRunTerminalReason } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  createGoalState,
  type DurableGoalAttempt,
  goalAttemptId,
  goalAttemptRunId,
  goalDecisionId,
  goalSessionId,
  type GoalState,
  goalTransitionId,
  isGoalState,
} from './goal-state';
import { createGoalStore, type GoalStore, type GoalTransitionRequest } from './goal-store';

const GOAL = 'goal-consistency';
const VALIDATOR = { name: 'tests@bureau', version: '1.0.0' };
const STARTED = '2026-10-02T00:00:05.000Z';
let tick = 0;
const at = (): string => new Date(Date.UTC(2026, 9, 2, 0, 1, 10 + tick++)).toISOString();

function attempt(index: number, overrides: Partial<DurableGoalAttempt> = {}): DurableGoalAttempt {
  return {
    attemptId: goalAttemptId(GOAL, index),
    attemptIndex: index,
    runId: goalAttemptRunId(GOAL, index),
    sessionId: goalSessionId(GOAL, 0),
    startedAt: STARTED,
    usage: { steps: 0, tokens: 0 },
    status: 'running',
    ...overrides,
  };
}

/** The aggregate a record carries once `count` attempts have started and nothing was spent. */
const usageAfter = (count: number) => ({ attempts: count, steps: 0, tokens: 0, durationMs: 0 });

const attemptWork = (index: number) =>
  ({
    kind: 'attempt',
    attemptId: goalAttemptId(GOAL, index),
    runId: goalAttemptRunId(GOAL, index),
    startedAt: STARTED,
  }) as const;

const validationWork = (index: number) =>
  ({
    kind: 'validation',
    attemptId: goalAttemptId(GOAL, index),
    validator: VALIDATOR,
    startedAt: STARTED,
  }) as const;

let sequence = 0;
async function send(
  store: GoalStore,
  to: GoalTransitionRequest['to'],
  extra: Partial<GoalTransitionRequest> = {},
): Promise<GoalState> {
  sequence += 1;
  const result = await store.applyTransition({
    goalRunId: GOAL,
    seq: sequence,
    transitionId: goalTransitionId(GOAL, sequence),
    to,
    at: at(),
    cause: `to-${to}`,
    ...extra,
  });
  if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
  return result.record;
}

const pendingGoal = (): GoalState =>
  createGoalState({
    goalRunId: GOAL,
    identity: { name: 'goal', version: '1' },
    objective: { agentName: 'builder', prompt: 'Make the tests pass.' },
    validator: VALIDATOR,
    conversationPolicy: { kind: 'continue' },
    bounds: { maximumAttempts: 3, maximumTotalTokens: 1000 },
    now: '2026-10-02T00:00:00.000Z',
  });

/** One real record of every status, each built through the store. */
async function records(): Promise<Record<string, GoalState>> {
  sequence = 0;
  const store = createGoalStore(textValueStore(new MemoryStorage()));
  const pending = pendingGoal();
  await store.create(pending);
  const running = await send(store, 'running', {
    attempt: attempt(0),
    usage: usageAfter(1),
    active: attemptWork(0),
  });
  const evaluating = await send(store, 'evaluating', {
    attempt: attempt(0, { status: 'evaluating', finishReason: 'stop-condition' }),
    active: validationWork(0),
  });
  const retrying = await send(store, 'retrying', {
    attempt: attempt(0, { status: 'failed', finishReason: 'stop-condition' }),
    active: null,
  });
  await send(store, 'running', {
    attempt: attempt(1),
    usage: usageAfter(2),
    active: attemptWork(1),
  });
  await send(store, 'evaluating', {
    attempt: attempt(1, { status: 'evaluating', finishReason: 'stop-condition' }),
    active: validationWork(1),
  });
  const succeeded = await send(store, 'succeeded', {
    attempt: attempt(1, {
      status: 'passed',
      finishReason: 'stop-condition',
      validation: {
        identity: VALIDATOR,
        startedAt: STARTED,
        completedAt: STARTED,
        outcome: { kind: 'pass', evidence: [] },
        decisionId: goalDecisionId(goalAttemptId(GOAL, 1)),
      },
    }),
    active: null,
    terminalReason: 'validator-passed',
  });
  return { pending, running, evaluating, retrying, succeeded };
}

/**
 * A record whose first attempt ended on a recorded failing verdict and retried:
 * the retry's audit entry (seq 3) is an earlier, non-latest entry that genuinely
 * holds the `goal.attempt.validated` event that verdict implies.
 */
async function recordWithValidatedRetry(): Promise<GoalState> {
  sequence = 0;
  const store = createGoalStore(textValueStore(new MemoryStorage()));
  await store.create(pendingGoal());
  await send(store, 'running', {
    attempt: attempt(0),
    usage: usageAfter(1),
    active: attemptWork(0),
  });
  await send(store, 'evaluating', {
    attempt: attempt(0, { status: 'evaluating', finishReason: 'stop-condition' }),
    active: validationWork(0),
  });
  await send(store, 'retrying', {
    attempt: attempt(0, {
      status: 'failed',
      finishReason: 'stop-condition',
      validation: {
        identity: VALIDATOR,
        startedAt: STARTED,
        completedAt: STARTED,
        outcome: { kind: 'fail', feedback: 'Try again.', evidence: [], retryable: true },
        decisionId: goalDecisionId(goalAttemptId(GOAL, 0)),
      },
    }),
    active: null,
  });
  return await send(store, 'running', {
    attempt: attempt(1),
    usage: usageAfter(2),
    active: attemptWork(1),
  });
}

type Mutation = (record: Record<string, unknown>) => void;

/**
 * Keeps the aggregate attempt count in step with a mutated attempts array, so a
 * contradiction is refused for the contradiction it is and not because the
 * aggregate no longer sums the attempts (`goal-store.test.ts` covers that).
 */
function syncAttemptCount(record: Record<string, unknown>): void {
  const usage = record['usage'] as Record<string, unknown>;
  usage['attempts'] = (record['attempts'] as unknown[]).length;
}

const attemptsOf = (record: Record<string, unknown>) =>
  record['attempts'] as Array<Record<string, unknown>>;

const contradictions: Array<[string, string, Mutation]> = [
  ['pending', 'active work', (r) => (r['active'] = attemptWork(0))],
  ['pending', 'an attempt', (r) => (r['attempts'] = [attempt(0, { status: 'failed' })])],
  ['running', 'no attempts and no active work', (r) => (r['attempts'] = [])],
  ['running', 'no active work', (r) => delete r['active']],
  ['running', 'validation work', (r) => (r['active'] = validationWork(0))],
  ['running', 'work for another attempt', (r) => (r['active'] = attemptWork(1))],
  [
    'running',
    'work for another run',
    (r) => (r['active'] = { ...attemptWork(0), runId: 'goal-other-a0' }),
  ],
  [
    'running',
    'a last attempt that is not running',
    (r) => ((attemptsOf(r)[0] as Record<string, unknown>)['status'] = 'failed'),
  ],
  ['evaluating', 'no active work', (r) => delete r['active']],
  ['evaluating', 'attempt work', (r) => (r['active'] = attemptWork(0))],
  ['evaluating', 'work for another attempt', (r) => (r['active'] = validationWork(1))],
  [
    'evaluating',
    'a last attempt that is still running',
    (r) => ((attemptsOf(r)[0] as Record<string, unknown>)['status'] = 'running'),
  ],
  ['evaluating', 'no attempts', (r) => (r['attempts'] = [])],
  ['retrying', 'active work', (r) => (r['active'] = attemptWork(0))],
  ['retrying', 'no attempts', (r) => (r['attempts'] = [])],
  [
    'retrying',
    'no attempt headroom left (as many attempts as the bound allows)',
    (r) => ((r['bounds'] as Record<string, unknown>)['maximumAttempts'] = 1),
  ],
  [
    'retrying',
    'a last attempt still in flight',
    (r) => ((attemptsOf(r)[0] as Record<string, unknown>)['status'] = 'running'),
  ],
  ['succeeded', 'active work', (r) => (r['active'] = validationWork(1))],
  [
    'succeeded',
    'a last attempt still in flight',
    (r) => ((attemptsOf(r)[1] as Record<string, unknown>)['status'] = 'evaluating'),
  ],
  [
    'succeeded',
    'an earlier attempt still in flight',
    (r) => ((attemptsOf(r)[0] as Record<string, unknown>)['status'] = 'running'),
  ],
];

describe('the goal record decoder', () => {
  it('decodes the record of every status the store writes', async () => {
    for (const record of Object.values(await records())) {
      expect(isGoalState(JSON.parse(JSON.stringify(record)))).toBe(true);
    }
  });

  it.each(contradictions)('treats a %s goal with %s as corrupt', async (status, _name, mutate) => {
    const every = await records();
    const base = every[status] as GoalState;
    const record = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    mutate(record);
    syncAttemptCount(record);
    expect(isGoalState(record)).toBe(false);
  });

  describe('the audit log must be what the transitions and restarts that wrote it imply', () => {
    type Entries = Array<{ events: Array<Record<string, any>>; transitionId: string }>;
    const entriesOf = (record: Record<string, unknown>) => record['auditLog'] as Entries;
    const eventOfKind = (record: Record<string, unknown>, kind: string) => {
      for (const entry of entriesOf(record)) {
        const found = entry.events.find((event) => event['kind'] === kind);
        if (found !== undefined) return found;
      }
      throw new Error(`no ${kind} event`);
    };

    const passedValidationEvent = (record: Record<string, unknown>) => {
      for (const entry of entriesOf(record)) {
        const found = entry.events.find(
          (event) =>
            event['kind'] === 'goal.attempt.validated' &&
            event['payload']['outcomeKind'] === 'pass',
        );
        if (found !== undefined) return found;
      }
      throw new Error('no passing validated event');
    };

    const entryAt = (record: Record<string, unknown>, seq: number) => {
      const entry = entriesOf(record).find(
        (found) => found.transitionId === goalTransitionId(GOAL, seq),
      );
      if (entry === undefined) throw new Error(`no entry for transition ${seq}`);
      return entry;
    };

    /**
     * A syntactically perfect `goal.attempt.validated` event for attempt 0, which
     * in the `succeeded` record was never validated: the retry that ended it
     * (transition 3) recorded no verdict, so nothing it could report exists.
     */
    const verdictNeverRecorded = (outcomeKind: string) => ({
      kind: 'goal.attempt.validated',
      payload: {
        goalRunId: GOAL,
        attemptId: goalAttemptId(GOAL, 0),
        validatorIdentity: VALIDATOR,
        outcomeKind,
        ...(outcomeKind === 'fail' ? { feedbackDigest: 'a'.repeat(64) } : {}),
      },
      dedupeKey: `${GOAL}:3`,
      at: STARTED,
    });

    const corruptions: Array<[string, string, Mutation]> = [
      [
        'succeeded',
        'a kind no goal event has',
        (r) => (eventOfKind(r, 'goal.succeeded')['kind'] = 'goal.bogus'),
      ],
      [
        'succeeded',
        'a terminal event of another status (a failed event on a succeeded goal)',
        (r) => (eventOfKind(r, 'goal.succeeded')['kind'] = 'goal.failed'),
      ],
      [
        'succeeded',
        'a succeeded event on an earlier, non-terminal transition',
        (r) => {
          const terminal = eventOfKind(r, 'goal.succeeded');
          entriesOf(r)[0]?.events.push({ ...terminal, dedupeKey: `${GOAL}:1` });
        },
      ],
      [
        'running',
        'a succeeded event on a running transition',
        (r) => {
          const last = entriesOf(r).at(-1);
          last?.events.push({
            kind: 'goal.succeeded',
            payload: { goalRunId: GOAL, terminalReason: 'validator-passed' },
            dedupeKey: `${GOAL}:1`,
            at: STARTED,
          });
        },
      ],
      [
        'succeeded',
        'an event naming another goal',
        (r) => (eventOfKind(r, 'goal.succeeded')['payload']['goalRunId'] = 'goal-other'),
      ],
      [
        'succeeded',
        'a forged dedupe key',
        (r) => (eventOfKind(r, 'goal.succeeded')['dedupeKey'] = `${GOAL}:0`),
      ],
      [
        'succeeded',
        'a terminal reason the record does not hold',
        (r) =>
          (eventOfKind(r, 'goal.succeeded')['payload']['terminalReason'] = 'attempt-limit-reached'),
      ],
      [
        'succeeded',
        'a payload with a field the event never carries',
        (r) => (eventOfKind(r, 'goal.succeeded')['payload']['extra'] = 1),
      ],
      [
        'succeeded',
        'a terminal event missing from the final transition',
        (r) => (entriesOf(r).at(-1)!.events = []),
      ],
      [
        'running',
        'a started event for an attempt the record does not hold',
        (r) => (eventOfKind(r, 'goal.attempt.started')['payload']['attemptIndex'] = 7),
      ],
      [
        'running',
        'a started event naming another run',
        (r) => (eventOfKind(r, 'goal.attempt.started')['payload']['runId'] = 'goal-other-a0'),
      ],
      [
        'retrying',
        'a validated event with a feedback digest that is not a digest',
        (r) => {
          const validated = {
            kind: 'goal.attempt.validated',
            payload: {
              goalRunId: GOAL,
              attemptId: goalAttemptId(GOAL, 0),
              validatorIdentity: VALIDATOR,
              outcomeKind: 'fail',
              feedbackDigest: 'not-a-digest',
            },
            dedupeKey: `${GOAL}:3`,
            at: STARTED,
          };
          entriesOf(r)
            .find((entry) => entry.transitionId === goalTransitionId(GOAL, 3))
            ?.events.push(validated);
        },
      ],
      [
        'succeeded',
        'a validated event whose outcome kind differs from the recorded verdict',
        (r) => (passedValidationEvent(r)['payload']['outcomeKind'] = 'error'),
      ],
      [
        'succeeded',
        'a validated event naming another validator than the recorded one',
        (r) =>
          (passedValidationEvent(r)['payload']['validatorIdentity'] = {
            name: 'forged@bureau',
            version: '9.9.9',
          }),
      ],
      [
        'succeeded',
        'a passing validated event for an attempt that was never validated',
        (r) => entryAt(r, 3).events.push(verdictNeverRecorded('pass')),
      ],
      [
        'succeeded',
        'a failing validated event for an attempt that was never validated',
        (r) => entryAt(r, 3).events.push(verdictNeverRecorded('fail')),
      ],
      [
        'succeeded',
        'an error validated event for an attempt that was never validated',
        (r) => entryAt(r, 3).events.push(verdictNeverRecorded('error')),
      ],
      [
        'running',
        'a restart event for another restart count',
        (r) => {
          r['controllerRestarts'] = 1;
          entriesOf(r).push({
            seq: 1,
            transitionId: `${GOAL}:restart-1`,
            events: [
              {
                kind: 'goal.recovered',
                payload: {
                  goalRunId: GOAL,
                  controllerRestarts: 2,
                  status: 'running',
                  transitionSeq: 1,
                },
                dedupeKey: `${GOAL}:1:restart-1`,
                at: STARTED,
              },
            ],
          } as never);
        },
      ],
    ];

    it.each(corruptions)('treats a %s goal with %s as corrupt', async (status, _name, mutate) => {
      const every = await records();
      const base = every[status] as GoalState;
      const record = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      mutate(record);
      expect(isGoalState(record)).toBe(false);
    });

    it('still decodes a goal whose earlier retry entry holds the validated event its recorded verdict implies', async () => {
      const base = await recordWithValidatedRetry();
      const record = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      const validated = entryAt(record, 3).events.map((event) => event['kind']);
      expect(validated).toEqual(['goal.attempt.validated']);
      expect(record['transitionSeq']).toBe(4);
      expect(isGoalState(record)).toBe(true);
    });

    it('still decodes a goal whose log holds a genuine restart entry', async () => {
      const every = await records();
      const base = every['running'] as GoalState;
      const record = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      record['controllerRestarts'] = 1;
      entriesOf(record).push({
        seq: 1,
        transitionId: `${GOAL}:restart-1`,
        events: [
          {
            kind: 'goal.recovered',
            payload: {
              goalRunId: GOAL,
              controllerRestarts: 1,
              status: 'running',
              transitionSeq: 1,
            },
            dedupeKey: `${GOAL}:1:restart-1`,
            at: STARTED,
          },
        ],
      } as never);
      expect(isGoalState(record)).toBe(true);
    });
  });

  describe("the ids derived from the record's own goal", () => {
    const OTHER = 'goal-other';
    const rewrite = (record: Record<string, unknown>, index: number, change: object) => {
      attemptsOf(record)[index] = { ...attemptsOf(record)[index], ...change };
    };
    // Each mutation moves one derived id to the id another goal's builder produces
    // (or to an id no builder produces), keeping the record otherwise consistent.
    const mismatches: Array<[string, string, Mutation]> = [
      [
        'running',
        'an attempt id built for another goal',
        (r) => {
          rewrite(r, 0, { attemptId: goalAttemptId(OTHER, 0) });
          r['active'] = { ...attemptWork(0), attemptId: goalAttemptId(OTHER, 0) };
        },
      ],
      [
        'running',
        'an attempt run id built for another goal, which the active work agrees with',
        (r) => {
          rewrite(r, 0, { runId: goalAttemptRunId(OTHER, 0) });
          r['active'] = { ...attemptWork(0), runId: goalAttemptRunId(OTHER, 0) };
        },
      ],
      [
        'running',
        'a session id built for another goal',
        (r) => rewrite(r, 0, { sessionId: goalSessionId(OTHER, 0) }),
      ],
      [
        'running',
        'a session id no builder produces',
        (r) => rewrite(r, 0, { sessionId: 'session-0' }),
      ],
      [
        'succeeded',
        'a later attempt in a session the continue policy never gives it',
        (r) => rewrite(r, 1, { sessionId: goalSessionId(GOAL, 1) }),
      ],
      [
        'retrying',
        'a validation decision id built for another attempt',
        (r) =>
          rewrite(r, 0, {
            validation: {
              identity: VALIDATOR,
              startedAt: STARTED,
              completedAt: STARTED,
              outcome: { kind: 'fail', feedback: 'no', evidence: [], retryable: true },
              decisionId: goalDecisionId(goalAttemptId(OTHER, 0)),
            },
          }),
      ],
    ];

    it.each(mismatches)('treats a %s goal with %s as corrupt', async (status, _name, mutate) => {
      const every = await records();
      const base = every[status] as GoalState;
      const record = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      mutate(record);
      syncAttemptCount(record);
      expect(isGoalState(record)).toBe(false);
    });

    it('accepts the session a fork policy gives a later attempt, and refuses the trunk for it', async () => {
      const every = await records();
      const base = every['succeeded'] as GoalState;
      const forked = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      forked['conversationPolicy'] = {
        kind: 'fork-from-baseline',
        throughRun: 0,
      };
      rewrite(forked, 1, { sessionId: goalSessionId(GOAL, 1) });
      const trunk = JSON.parse(JSON.stringify(forked)) as Record<string, unknown>;
      rewrite(trunk, 1, { sessionId: goalSessionId(GOAL, 0) });
      expect(isGoalState(forked)).toBe(true);
      expect(isGoalState(trunk)).toBe(false);
    });

    it('refuses to write a transition that carries them', async () => {
      sequence = 0;
      const store = createGoalStore(textValueStore(new MemoryStorage()));
      await store.create(
        createGoalState({
          goalRunId: GOAL,
          identity: { name: 'goal', version: '1' },
          objective: { agentName: 'builder', prompt: 'p' },
          validator: VALIDATOR,
          conversationPolicy: { kind: 'continue' },
          bounds: { maximumAttempts: 3, maximumTotalTokens: 1000 },
          now: '2026-10-02T00:00:00.000Z',
        }),
      );
      const foreign = {
        ...attempt(0),
        runId: goalAttemptRunId(OTHER, 0),
      };
      const result = await store.applyTransition({
        goalRunId: GOAL,
        seq: 1,
        transitionId: goalTransitionId(GOAL, 1),
        to: 'running',
        at: at(),
        cause: 'foreign run',
        attempt: foreign,
        active: { ...attemptWork(0), runId: foreign.runId },
      });
      expect(result.status).toBe('rejected');
      const stored = await store.get(GOAL);
      expect(stored?.status).toBe('pending');
    });
  });

  it('refuses a transition that would leave the record contradicting itself', async () => {
    sequence = 0;
    const store = createGoalStore(textValueStore(new MemoryStorage()));
    await store.create(
      createGoalState({
        goalRunId: GOAL,
        identity: { name: 'goal', version: '1' },
        objective: { agentName: 'builder', prompt: 'p' },
        validator: VALIDATOR,
        conversationPolicy: { kind: 'continue' },
        bounds: { maximumAttempts: 3, maximumTotalTokens: 1000 },
        now: '2026-10-02T00:00:00.000Z',
      }),
    );
    // Running with no attempt and no active work.
    const result = await store.applyTransition({
      goalRunId: GOAL,
      seq: 1,
      transitionId: goalTransitionId(GOAL, 1),
      to: 'running',
      at: at(),
      cause: 'bad',
    });
    expect(result.status).toBe('rejected');
    const stored = await store.get(GOAL);
    expect(stored?.status).toBe('pending');
  });
});

describe('a terminal goal and what its last attempt shows', () => {
  const validated = (outcome: Record<string, unknown>) =>
    ({
      identity: VALIDATOR,
      startedAt: STARTED,
      completedAt: STARTED,
      outcome,
      decisionId: goalDecisionId(goalAttemptId(GOAL, 0)),
    }) as never;
  const failing = { kind: 'fail', feedback: 'no', evidence: [], retryable: true };
  const erroring = {
    kind: 'error',
    error: { kind: 'execute', code: 'DOWN', message: 'down', cause: undefined },
  };
  const status = (reason: GoalRunTerminalReason) =>
    reason === 'validator-passed'
      ? 'succeeded'
      : reason === 'attempt-limit-reached' || reason === 'aggregate-budget-exceeded'
        ? 'exhausted'
        : reason === 'goal-canceled'
          ? 'canceled'
          : 'failed';

  /** What each reason's last attempt legally shows, one attempt allowed by the bound. */
  const legal: Array<[GoalRunTerminalReason, string, Partial<DurableGoalAttempt>]> = [
    [
      'validator-passed',
      'a passed attempt',
      { status: 'passed', validation: validated({ kind: 'pass', evidence: [] }) },
    ],
    [
      'attempt-limit-reached',
      'a failed attempt',
      { status: 'failed', validation: validated(failing) },
    ],
    ['attempt-limit-reached', 'an aborted attempt', { status: 'aborted' }],
    [
      'aggregate-budget-exceeded',
      'a failed attempt',
      { status: 'failed', validation: validated(failing) },
    ],
    ['aggregate-budget-exceeded', 'an aborted attempt', { status: 'aborted' }],
    [
      'validator-fail-non-retryable',
      'a failing verdict',
      { status: 'failed', validation: validated({ ...failing, retryable: false }) },
    ],
    [
      'validator-infrastructure-error',
      'an error',
      { status: 'failed', validation: validated(erroring) },
    ],
    [
      'validator-infrastructure-error',
      'an unavailable validator',
      {
        status: 'failed',
        validation: validated({ kind: 'unavailable', error: erroring.error, reason: 'down' }),
      },
    ],
    [
      'validator-infrastructure-error',
      'an indeterminate verdict',
      { status: 'failed', validation: validated({ kind: 'indeterminate', reason: 'unclear' }) },
    ],
    [
      'validator-infrastructure-error',
      'a canceled validator',
      { status: 'aborted', validation: validated({ kind: 'canceled' }) },
    ],
    ['attempt-run-failed', 'a failed run', { status: 'failed' }],
    ['attempt-run-failed', 'an aborted run', { status: 'aborted' }],
    ['unsupported-validation', 'an aborted attempt', { status: 'aborted' }],
    ['goal-canceled', 'an aborted attempt', { status: 'aborted' }],
  ];

  /** A goal ends canceled only after a cancellation was asked for, as the control plane does. */
  async function markCancellation(store: GoalStore, reason: GoalRunTerminalReason): Promise<void> {
    if (reason !== 'goal-canceled') return;
    const marked = await store.requestCancellation(GOAL, { requestedAt: at() }, at());
    expect(marked.status).toBe('updated');
  }

  async function terminal(
    reason: GoalRunTerminalReason,
    overrides: Partial<DurableGoalAttempt>,
  ): Promise<Record<string, unknown>> {
    sequence = 0;
    const store = createGoalStore(textValueStore(new MemoryStorage()));
    await store.create(
      createGoalState({
        goalRunId: GOAL,
        identity: { name: 'goal', version: '1' },
        objective: { agentName: 'builder', prompt: 'Make the tests pass.' },
        validator: VALIDATOR,
        conversationPolicy: { kind: 'continue' },
        bounds: { maximumAttempts: 1, maximumTotalTokens: 1000 },
        now: '2026-10-02T00:00:00.000Z',
      }),
    );
    await send(store, 'running', {
      attempt: attempt(0),
      usage: usageAfter(1),
      active: attemptWork(0),
    });
    await send(store, 'evaluating', {
      attempt: attempt(0, { status: 'evaluating', finishReason: 'stop-condition' }),
      active: validationWork(0),
    });
    await markCancellation(store, reason);
    const record = await send(store, status(reason), {
      attempt: attempt(0, { finishReason: 'stop-condition', ...overrides }),
      active: null,
      terminalReason: reason,
    });
    return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  }

  it.each(legal)(
    'decodes a goal that ended %s with %s on its last attempt',
    async (reason, _label, overrides) => {
      expect(isGoalState(await terminal(reason, overrides))).toBe(true);
    },
  );

  it.each(['unsupported-validation', 'goal-canceled', 'aggregate-budget-exceeded'] as const)(
    'decodes a goal that ended %s before any attempt opened',
    async (reason) => {
      sequence = 0;
      const store = createGoalStore(textValueStore(new MemoryStorage()));
      await store.create(
        createGoalState({
          goalRunId: GOAL,
          identity: { name: 'goal', version: '1' },
          objective: { agentName: 'builder', prompt: 'p' },
          validator: VALIDATOR,
          conversationPolicy: { kind: 'continue' },
          bounds: { maximumAttempts: 2, maximumTotalTokens: 1000 },
          now: '2026-10-02T00:00:00.000Z',
        }),
      );
      await markCancellation(store, reason);
      const record = await send(store, status(reason), { terminalReason: reason });
      expect(isGoalState(JSON.parse(JSON.stringify(record)))).toBe(true);
    },
  );

  const set = (index: number, change: Record<string, unknown>) => (r: Record<string, unknown>) => {
    attemptsOf(r)[index] = { ...attemptsOf(r)[index], ...change };
  };
  const contradictory: Array<
    [GoalRunTerminalReason, string, Partial<DurableGoalAttempt>, Mutation]
  > = [
    [
      'validator-passed',
      'a failed last attempt with a failing validation',
      { status: 'passed', validation: validated({ kind: 'pass', evidence: [] }) },
      set(0, { status: 'failed', validation: validated(failing) }),
    ],
    [
      'validator-passed',
      'a passed last attempt that was never validated',
      { status: 'passed', validation: validated({ kind: 'pass', evidence: [] }) },
      (r) => delete attemptsOf(r)[0]!['validation'],
    ],
    [
      'validator-passed',
      'a passing validation on an attempt that did not pass',
      { status: 'passed', validation: validated({ kind: 'pass', evidence: [] }) },
      set(0, { status: 'failed' }),
    ],
    [
      'validator-passed',
      'a failing validation on an attempt marked passed',
      { status: 'passed', validation: validated({ kind: 'pass', evidence: [] }) },
      set(0, { validation: validated(failing) }),
    ],
    [
      'validator-passed',
      'no attempts',
      { status: 'passed', validation: validated({ kind: 'pass', evidence: [] }) },
      (r) => (r['attempts'] = []),
    ],
    [
      'validator-fail-non-retryable',
      'a last attempt that was never validated',
      { status: 'failed', validation: validated({ ...failing, retryable: false }) },
      (r) => delete attemptsOf(r)[0]!['validation'],
    ],
    [
      'validator-fail-non-retryable',
      'an error where a failing verdict belongs',
      { status: 'failed', validation: validated({ ...failing, retryable: false }) },
      set(0, { validation: validated(erroring) }),
    ],
    [
      'validator-fail-non-retryable',
      'a passed attempt',
      { status: 'failed', validation: validated({ ...failing, retryable: false }) },
      set(0, { status: 'passed', validation: validated({ kind: 'pass', evidence: [] }) }),
    ],
    [
      'validator-infrastructure-error',
      'a failing verdict where an error belongs',
      { status: 'failed', validation: validated(erroring) },
      set(0, { validation: validated(failing) }),
    ],
    [
      'validator-infrastructure-error',
      'a last attempt that was never validated',
      { status: 'failed', validation: validated(erroring) },
      (r) => delete attemptsOf(r)[0]!['validation'],
    ],
    [
      'validator-infrastructure-error',
      'a canceled outcome on an attempt that failed',
      { status: 'aborted', validation: validated({ kind: 'canceled' }) },
      set(0, { status: 'failed' }),
    ],
    [
      'attempt-limit-reached',
      'fewer attempts than the bound allows',
      { status: 'failed', validation: validated(failing) },
      (r) => ((r['bounds'] as Record<string, unknown>)['maximumAttempts'] = 2),
    ],
    [
      'aggregate-budget-exceeded',
      'an attempt that passed',
      { status: 'failed', validation: validated(failing) },
      set(0, { status: 'passed', validation: validated({ kind: 'pass', evidence: [] }) }),
    ],
    [
      'attempt-run-failed',
      'an attempt that passed',
      { status: 'failed' },
      set(0, { status: 'passed', validation: validated({ kind: 'pass', evidence: [] }) }),
    ],
    [
      'goal-canceled',
      'a passed attempt',
      { status: 'aborted' },
      set(0, { status: 'passed', validation: validated({ kind: 'pass', evidence: [] }) }),
    ],
    [
      'goal-canceled',
      'an attempt marked passed that was never validated',
      { status: 'aborted' },
      set(0, { status: 'passed' }),
    ],
  ];

  it.each(contradictory)(
    'refuses a goal that ended %s with %s',
    async (reason, _label, overrides, mutate) => {
      const record = await terminal(reason, overrides);
      mutate(record);
      syncAttemptCount(record);
      expect(isGoalState(record)).toBe(false);
    },
  );

  it('refuses an attempt whose status contradicts its validation, even before the goal has ended', async () => {
    const every = await records();
    for (const change of [
      { status: 'failed', validation: validated({ kind: 'pass', evidence: [] }) },
      { status: 'aborted', validation: validated(failing) },
      { status: 'failed', validation: validated({ kind: 'canceled' }) },
    ]) {
      const record = JSON.parse(JSON.stringify(every['retrying'])) as Record<string, unknown>;
      set(0, change)(record);
      expect(isGoalState(record)).toBe(false);
    }
  });
});

describe('a terminal goal and its cancellation marker', () => {
  async function canceled(): Promise<Record<string, unknown>> {
    sequence = 0;
    const store = createGoalStore(textValueStore(new MemoryStorage()));
    await store.create(
      createGoalState({
        goalRunId: GOAL,
        identity: { name: 'goal', version: '1' },
        objective: { agentName: 'builder', prompt: 'p' },
        validator: VALIDATOR,
        conversationPolicy: { kind: 'continue' },
        bounds: { maximumAttempts: 2, maximumTotalTokens: 1000 },
        now: '2026-10-02T00:00:00.000Z',
      }),
    );
    const marked = await store.requestCancellation(GOAL, { requestedAt: at() }, at());
    expect(marked.status).toBe('updated');
    const record = await send(store, 'canceled', { terminalReason: 'goal-canceled' });
    return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  }

  it('decodes a goal canceled after a cancellation was requested', async () => {
    expect(isGoalState(await canceled())).toBe(true);
  });

  it('refuses a canceled goal that carries no cancellation marker', async () => {
    const record = await canceled();
    delete record['cancellation'];
    expect(isGoalState(record)).toBe(false);
  });

  it.each(['succeeded', 'retrying', 'running'] as const)(
    'accepts only a terminal goal that is canceled to carry a marker (%s)',
    async (name) => {
      const every = await records();
      const record = JSON.parse(JSON.stringify(every[name])) as Record<string, unknown>;
      record['cancellation'] = { requestedAt: at() };
      // A marker on a goal that has not ended is a request the controller has not acted on yet.
      expect(isGoalState(record)).toBe(name !== 'succeeded');
    },
  );
});
