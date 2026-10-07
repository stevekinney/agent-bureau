/**
 * COR-851 — the durable goal store: revision-CAS writes, create-if-absent,
 * idempotent transitions, rejection of stale, late, and illegal ones, and
 * fail-closed decoding of corrupt records.
 */
import {
  GoalConfigurationError,
  type GoalRunStatus,
  type GoalRunTerminalReason,
  type ProjectedValidatorOutcome,
  TERMINAL_STATUS_BY_REASON,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore, WEFT_RESERVED_KEY_PREFIXES } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  attemptSignalId,
  boundValidationOutcome,
  cancelSignalId,
  createGoalState,
  type CreateGoalStateInput,
  type DurableGoalAttempt,
  GOAL_AUDIT_LOG_MAXIMUM_ENTRIES,
  GOAL_MAXIMUM_ATTEMPTS,
  GOAL_OBJECTIVE_MAXIMUM_BYTES,
  GOAL_RECORD_KEY_PREFIX,
  GOAL_VALIDATION_MAXIMUM_BYTES,
  goalAttemptId,
  goalAttemptRunId,
  goalDecisionId,
  GoalObjectiveTooLargeError,
  goalRecordKey,
  GoalRunIdError,
  goalSessionId,
  type GoalState,
  goalTransitionId,
  goalWorkflowId,
  InvalidGoalStateError,
  isGoalState,
} from './goal-state';
import {
  createGoalStore,
  type GoalStore,
  type GoalTransitionRequest,
  type GoalTransitionResult,
} from './goal-store';
import { throwingRejectionOf } from './testing/promise-outcome.test-support.ts';

const GOAL = 'goal-1';

function createKv() {
  return textValueStore(new MemoryStorage());
}

function input(overrides: Partial<CreateGoalStateInput> = {}): CreateGoalStateInput {
  return {
    goalRunId: GOAL,
    identity: { name: 'ship-feature', version: '1' },
    objective: { agentName: 'builder', prompt: 'Make the tests pass.' },
    validator: { name: 'tests@bureau', version: '1.0.0' },
    conversationPolicy: { kind: 'continue' },
    bounds: { maximumAttempts: 3, maximumTotalTokens: 1000 },
    principal: 'user-1',
    now: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

function setup(corrupt: string[] = []) {
  const kv = createKv();
  const store = createGoalStore(kv, { onCorrupt: (key) => corrupt.push(key) });
  return { kv, store };
}

let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 2, 0, 0, 10 + clock++)).toISOString();

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

/** The in-flight attempt work a `running` record must carry. */
/** The aggregate a record carries once its first attempt has started and reported nothing yet. */
const FIRST_ATTEMPT_USAGE = { attempts: 1, steps: 0, tokens: 0, durationMs: 0 } as const;

const attemptWork = (index: number) =>
  ({
    kind: 'attempt',
    attemptId: goalAttemptId(GOAL, index),
    runId: goalAttemptRunId(GOAL, index),
    startedAt: '2026-10-02T00:00:05.000Z',
  }) as const;

function transition(
  seq: number,
  to: GoalRunStatus,
  overrides: Partial<GoalTransitionRequest> = {},
): GoalTransitionRequest {
  return {
    goalRunId: GOAL,
    seq,
    transitionId: goalTransitionId(GOAL, seq),
    to,
    at: at(),
    cause: `to-${to}`,
    ...overrides,
  };
}

async function created(store: GoalStore, overrides: Partial<CreateGoalStateInput> = {}) {
  const state = createGoalState(input(overrides));
  expect(await store.create(state)).toEqual({ status: 'created', record: state });
  return state;
}

function applied(result: GoalTransitionResult): GoalState {
  if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
  return result.record;
}

/** pending -> running (attempt 0) -> evaluating, seqs 1 and 2. */
async function toEvaluating(store: GoalStore): Promise<GoalState> {
  applied(
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
    ),
  );
  return applied(
    await store.applyTransition(
      transition(2, 'evaluating', {
        attempt: attempt(0, { status: 'evaluating', finishReason: 'stop-condition' }),
        active: {
          kind: 'validation',
          attemptId: goalAttemptId(GOAL, 0),
          validator: { name: 'tests@bureau', version: '1.0.0' },
          startedAt: '2026-10-02T00:00:06.000Z',
        },
      }),
    ),
  );
}

const passed = {
  identity: { name: 'tests@bureau', version: '1.0.0' },
  startedAt: '2026-10-02T00:00:06.000Z',
  completedAt: '2026-10-02T00:00:07.000Z',
  outcome: { kind: 'pass', evidence: [{ source: 'bun-test', detail: { passed: 12 } }] },
  decisionId: goalDecisionId(goalAttemptId(GOAL, 0)),
} as const;

describe('goal record keys', () => {
  it('never match, or are matched by, a Weft-reserved prefix', () => {
    const keys = [GOAL_RECORD_KEY_PREFIX, goalRecordKey('goal-1'), goalRecordKey('wf:order')];

    for (const key of keys) {
      for (const reserved of WEFT_RESERVED_KEY_PREFIXES) {
        expect(key.startsWith(reserved)).toBe(false);
        expect(reserved.startsWith(key)).toBe(false);
      }
    }
  });

  it('keeps identifiers containing separators distinct', async () => {
    const { store } = setup();
    await store.create(createGoalState(input({ goalRunId: 'a:b' })));
    await store.create(createGoalState(input({ goalRunId: 'a' })));

    const colon = await store.get('a:b');
    const plain = await store.get('a');
    expect(colon?.goalRunId).toBe('a:b');
    expect(plain?.goalRunId).toBe('a');
    expect(await store.list()).toHaveLength(2);
  });

  it('derives deterministic identifiers from the goal run id', () => {
    expect(goalWorkflowId('g')).toBe('goal:g');
    expect(goalTransitionId('g', 3)).toBe('g:t3');
    expect(goalAttemptId('g', 1)).toBe('g:a1');
    expect(goalAttemptRunId('g', 1)).toBe('goal-g-a1');
    expect(goalDecisionId('g:a1')).toBe('g:a1:decision');
  });
});

describe('createGoalState', () => {
  it('builds a pending record at revision 1, transition 0 that decodes', () => {
    const state = createGoalState(input());

    expect(state).toMatchObject({
      schemaVersion: 2,
      goalRunId: GOAL,
      workflowId: 'goal:goal-1',
      revision: 1,
      transitionSeq: 0,
      status: 'pending',
      attempts: [],
      controllerRestarts: 0,
      requireDeterministicValidation: false,
      usage: { attempts: 0, steps: 0, tokens: 0, durationMs: 0 },
      currentTransition: { seq: 0, transitionId: 'goal-1:t0', from: 'pending', to: 'pending' },
    });
    expect(isGoalState(JSON.parse(JSON.stringify(state)))).toBe(true);
  });

  it('rejects what startGoal rejects: a budget with no aggregate bound', () => {
    expect(() => createGoalState(input({ bounds: { maximumAttempts: 2 } }))).toThrow(
      'at least one aggregate bound',
    );
  });

  it('rejects a fork-from-baseline without a valid throughRun', () => {
    expect(() =>
      createGoalState(
        input({
          conversationPolicy: { kind: 'fork-from-baseline', throughRun: -1 },
        }),
      ),
    ).toThrow('throughRun');
  });

  it('rejects an objective above the inline cap with a typed error', () => {
    const prompt = 'x'.repeat(GOAL_OBJECTIVE_MAXIMUM_BYTES + 1);

    expect(() => createGoalState(input({ objective: { agentName: 'builder', prompt } }))).toThrow(
      GoalObjectiveTooLargeError,
    );
  });

  it('counts the cap in UTF-8 bytes across prompt and instructions', () => {
    const half = 'é'.repeat(GOAL_OBJECTIVE_MAXIMUM_BYTES / 4 + 1);

    expect(() =>
      createGoalState(
        input({ objective: { agentName: 'builder', prompt: half, instructions: half } }),
      ),
    ).toThrow(GoalObjectiveTooLargeError);
    expect(() =>
      createGoalState(
        input({
          objective: {
            agentName: 'builder',
            prompt: 'a'.repeat(GOAL_OBJECTIVE_MAXIMUM_BYTES - 4),
            instructions: 'abcd',
          },
        }),
      ),
    ).not.toThrow();
  });

  describe('the goal id', () => {
    const encoder = new TextEncoder();
    /** Weft refuses a signal id over 128 bytes and a workflow id over 128 characters. */
    const derivedIdentifiers = (goalRunId: string, maximumAttempts: number): string[] => {
      const last = maximumAttempts - 1;
      return [
        attemptSignalId(goalRunId, last),
        cancelSignalId(goalRunId),
        goalWorkflowId(goalRunId),
        goalAttemptRunId(goalRunId, last),
      ];
    };

    it('accepts the longest id whose every derived signal and workflow id still fits', () => {
      for (const maximumAttempts of [1, 3, 10, 256]) {
        let longest = '';
        for (let length = 1; length <= 200; length += 1) {
          const candidate = 'g'.repeat(length);
          try {
            createGoalState(
              input({ goalRunId: candidate, bounds: { maximumAttempts, maximumTotalTokens: 1 } }),
            );
          } catch (error) {
            expect(error).toBeInstanceOf(GoalRunIdError);
            break;
          }
          longest = candidate;
        }
        expect(longest.length).toBeGreaterThan(80);
        for (const identifier of derivedIdentifiers(longest, maximumAttempts)) {
          expect(encoder.encode(identifier).byteLength).toBeLessThanOrEqual(128);
        }
        // One byte more would push a derived identifier past Weft's limit.
        const over = `${longest}g`;
        expect(
          derivedIdentifiers(over, maximumAttempts).some(
            (identifier) => encoder.encode(identifier).byteLength > 128,
          ),
        ).toBe(true);
      }
    });

    it('rejects an id with a control character, which Weft refuses in a workflow id', () => {
      expect(() => createGoalState(input({ goalRunId: 'a\nb' }))).toThrow(GoalRunIdError);
    });

    it('counts bytes, not characters', () => {
      expect(() => createGoalState(input({ goalRunId: 'é'.repeat(60) }))).toThrow(GoalRunIdError);
      expect(() => createGoalState(input({ goalRunId: 'é'.repeat(20) }))).not.toThrow();
    });
  });

  it('omits unset optional fields from the stored JSON', () => {
    const json = JSON.parse(JSON.stringify(createGoalState(input({ principal: undefined }))));

    expect('principal' in json).toBe(false);
    expect('retryPolicy' in json).toBe(false);
    expect('validatorTimeoutMs' in json).toBe(false);
  });
});

describe('createGoalStore create, get, and list', () => {
  it('creates once and refuses a duplicate, handing back the record already there', async () => {
    const { store } = setup();
    const original = await created(store);

    const duplicate = await store.create(
      createGoalState(input({ objective: { agentName: 'impostor', prompt: 'other' } })),
    );

    expect(duplicate).toEqual({ status: 'duplicate', existing: original });
    expect(await store.get(GOAL)).toEqual(original);
  });

  it('reports a duplicate without a record when the existing one is unreadable', async () => {
    const corrupt: string[] = [];
    const { kv, store } = setup(corrupt);
    await kv.set(goalRecordKey(GOAL), 'not json');

    expect(await store.create(createGoalState(input()))).toEqual({ status: 'duplicate' });
    expect(corrupt).toContain(goalRecordKey(GOAL));
  });

  it('names the goals whose stored record is unreadable, which list() leaves out', async () => {
    const { kv, store } = setup();
    await store.create(createGoalState(input()));
    await kv.set(goalRecordKey('bad:id'), 'not json');

    const listed = await store.list();
    expect(listed.map((record) => record.goalRunId)).toEqual([GOAL]);
    expect(await store.listUnreadable()).toEqual(['bad:id']);
    expect(await store.isUnreadable('bad:id')).toBe(true);
    expect(await store.isUnreadable(GOAL)).toBe(false);
    expect(await store.isUnreadable('never-stored')).toBe(false);
  });

  // The boot sweep runs while recovered runs are already executing, so each
  // extra pass it makes over the store lets those runs get further ahead of the
  // boot that recovered them (the AB-15 and human-wait recovery tests, among
  // others, subscribe once `createBureau()` returns). It reads the store once.
  it('finds readable and unreadable records in a single pass over the keys', async () => {
    const kv = createKv();
    let listings = 0;
    const counted: typeof kv = {
      ...kv,
      get: (key) => kv.get(key),
      set: (key, value) => kv.set(key, value),
      delete: (key) => kv.delete(key),
      list: (prefix) => {
        listings += 1;
        return kv.list(prefix);
      },
    };
    const store = createGoalStore(counted);
    await store.create(createGoalState(input()));
    await kv.set(goalRecordKey('bad:id'), 'not json');
    listings = 0;

    const scanned = await store.scan();

    expect(scanned.records.map((record) => record.goalRunId)).toEqual([GOAL]);
    expect(scanned.unreadable).toEqual(['bad:id']);
    expect(listings).toBe(1);
  });

  it('refuses to create a record that is not a fresh pending one', async () => {
    const { store } = setup();
    const state = createGoalState(input());

    expect(await throwingRejectionOf(store.create({ ...state, revision: 2 }))).toThrow(
      InvalidGoalStateError,
    );
    expect(await throwingRejectionOf(store.create({ ...state, status: 'running' }))).toThrow(
      InvalidGoalStateError,
    );
    expect(
      await throwingRejectionOf(store.create({ ...state, schemaVersion: 1 } as never)),
    ).toThrow(InvalidGoalStateError);
    expect(await store.list()).toEqual([]);
  });

  it('returns undefined for an unknown goal and lists every readable one', async () => {
    const { store } = setup();
    await created(store, { goalRunId: 'a' });
    await created(store, { goalRunId: 'b' });

    expect(await store.get('missing')).toBeUndefined();
    const listed = await store.list();
    expect(listed.map((record) => record.goalRunId)).toEqual(['a', 'b']);
  });
});

describe('fail-closed decoding', () => {
  const key = goalRecordKey(GOAL);

  function mutated(change: (record: Record<string, unknown>) => void): string {
    const record = JSON.parse(JSON.stringify(createGoalState(input()))) as Record<string, unknown>;
    change(record);
    return JSON.stringify(record);
  }

  const corruptions: Array<[string, () => string]> = [
    ['text that is not JSON', () => 'not json'],
    ['a JSON array', () => '[]'],
    ['JSON null', () => 'null'],
    ['the pre-audit-log schema version', () => mutated((r) => (r['schemaVersion'] = 1))],
    ['a missing audit log', () => mutated((r) => delete r['auditLog'])],
    [
      'an audit log that omits a committed transition',
      () =>
        mutated(
          (r) => (
            (r['transitionSeq'] = 1),
            (r['currentTransition'] = {
              seq: 1,
              transitionId: 'goal-1:t1',
              from: 'pending',
              to: 'pending',
              at: 'x',
              cause: 'c',
            })
          ),
        ),
    ],
    [
      'an audit entry with an unknown extra field',
      () =>
        mutated((r) => {
          r['transitionSeq'] = 0;
          r['auditLog'] = [{ seq: 0, transitionId: 'goal-1:restart-1', events: [], extra: 1 }];
        }),
    ],
    ['a missing identity', () => mutated((r) => delete r['identity'])],
    ['an unknown extra field', () => mutated((r) => (r['extra'] = 1))],
    ['a revision of zero', () => mutated((r) => (r['revision'] = 0))],
    ['a fractional revision', () => mutated((r) => (r['revision'] = 1.5))],
    ['an unknown status', () => mutated((r) => (r['status'] = 'paused'))],
    [
      'a terminal status with no terminal reason',
      () =>
        mutated((r) => {
          r['status'] = 'succeeded';
          (r['currentTransition'] as Record<string, unknown>)['to'] = 'succeeded';
        }),
    ],
    [
      'a non-terminal status carrying a terminal reason',
      () => mutated((r) => (r['terminalReason'] = 'validator-passed')),
    ],
    [
      'a terminal reason that belongs to a different status',
      () =>
        mutated((r) => {
          r['status'] = 'failed';
          r['terminalReason'] = 'validator-passed';
          (r['currentTransition'] as Record<string, unknown>)['to'] = 'failed';
        }),
    ],
    [
      'a workflow id that does not belong to the goal',
      () => mutated((r) => (r['workflowId'] = 'goal:other')),
    ],
    [
      'a transition sequence that disagrees with the current transition',
      () => mutated((r) => (r['transitionSeq'] = 4)),
    ],
    [
      'a current transition whose target is not the status',
      () => mutated((r) => ((r['currentTransition'] as Record<string, unknown>)['to'] = 'running')),
    ],
    [
      'a closedAt on a goal that is not terminal',
      () => mutated((r) => (r['closedAt'] = '2026-10-02T00:00:00.000Z')),
    ],
    ['attempts that are not an array', () => mutated((r) => (r['attempts'] = {}))],
    [
      'an attempt whose index does not match its position',
      () => mutated((r) => (r['attempts'] = [{ ...attempt(1) }])),
    ],
    [
      'an attempt with an unknown finish reason',
      () => mutated((r) => (r['attempts'] = [{ ...attempt(0), finishReason: 'sleepy' }])),
    ],
    [
      'a validation outcome of an unknown kind',
      () =>
        mutated(
          (r) =>
            (r['attempts'] = [
              { ...attempt(0), validation: { ...passed, outcome: { kind: 'maybe' } } },
            ]),
        ),
    ],
    [
      'a validation outcome with an extra field',
      () =>
        mutated(
          (r) =>
            (r['attempts'] = [
              { ...attempt(0), validation: { ...passed, outcome: { kind: 'canceled', extra: 1 } } },
            ]),
        ),
    ],
    [
      'negative usage',
      () => mutated((r) => ((r['usage'] as Record<string, unknown>)['tokens'] = -1)),
    ],
    [
      'a budget with no aggregate bound',
      () => mutated((r) => (r['bounds'] = { maximumAttempts: 1 })),
    ],
    [
      'a retry policy naming an unknown reason',
      () => mutated((r) => (r['retryPolicy'] = { retryOn: ['whenever'] })),
    ],
    [
      'an unknown conversation policy',
      () => mutated((r) => (r['conversationPolicy'] = { kind: 'telepathy' })),
    ],
    [
      'a fresh-from-artifact policy with a malformed artifact',
      () =>
        mutated((r) => {
          (r['objective'] as Record<string, unknown>)['instructions'] = 'go';
          r['conversationPolicy'] = { kind: 'fresh-from-artifact', artifact: {} };
        }),
    ],
    ['a non-positive validator timeout', () => mutated((r) => (r['validatorTimeoutMs'] = 0))],
    [
      'an objective above the inline cap',
      () =>
        mutated(
          (r) =>
            ((r['objective'] as Record<string, unknown>)['prompt'] = 'x'.repeat(
              GOAL_OBJECTIVE_MAXIMUM_BYTES + 1,
            )),
        ),
    ],
    [
      'an active-work record of an unknown kind',
      () => mutated((r) => (r['active'] = { kind: 'nap' })),
    ],
    ['a cancellation marker without a timestamp', () => mutated((r) => (r['cancellation'] = {}))],
    ['a negative controller restart count', () => mutated((r) => (r['controllerRestarts'] = -1))],
  ];

  for (const [name, build] of corruptions) {
    it(`treats ${name} as absent and reports it`, async () => {
      const corrupt: string[] = [];
      const { kv, store } = setup(corrupt);
      await kv.set(key, build());

      expect(await store.get(GOAL)).toBeUndefined();
      expect(await store.list()).toEqual([]);
      expect(corrupt).toEqual([key, key]);
    });
  }

  it('refuses every write against a corrupt record instead of repairing it', async () => {
    const { kv, store } = setup();
    await kv.set(key, 'not json');

    expect(await store.applyTransition(transition(1, 'running'))).toEqual({ status: 'corrupt' });
    expect(await store.requestCancellation(GOAL, { requestedAt: at() }, at())).toEqual({
      status: 'corrupt',
    });
    expect(await store.recordControllerRestart(GOAL, at())).toEqual({ status: 'corrupt' });
    expect(await store.close(GOAL, at())).toEqual({ status: 'corrupt' });
    expect(await kv.get(key)).toBe('not json');
  });

  it('accepts a record with a persisted fork-from-baseline policy and a retry policy', async () => {
    const { store } = setup();
    const state = createGoalState(
      input({
        conversationPolicy: { kind: 'fork-from-baseline', throughRun: 0 },
        retryPolicy: { retryOn: ['validator-fail-retryable'] },
        validatorTimeoutMs: 500,
        requireDeterministicValidation: true,
      }),
    );
    await store.create(state);

    expect(await store.get(GOAL)).toEqual(state);
  });
});

describe('createGoalStore applyTransition', () => {
  it('advances status, sequence, revision, attempts, usage, and active work', async () => {
    const { store } = setup();
    await created(store);

    const running = applied(
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
      ),
    );

    expect(running).toMatchObject({
      status: 'running',
      transitionSeq: 1,
      revision: 2,
      usage: { attempts: 1 },
      active: { kind: 'attempt' },
      currentTransition: { seq: 1, transitionId: 'goal-1:t1', from: 'pending', to: 'running' },
    });
    expect(running.attempts).toEqual([attempt(0)]);
    expect(await store.get(GOAL)).toEqual(running);
  });

  it('drives a goal to success and clears the active work', async () => {
    const { store } = setup();
    await created(store);
    const evaluating = await toEvaluating(store);
    expect(evaluating.revision).toBe(3);

    const done = applied(
      await store.applyTransition(
        transition(3, 'succeeded', {
          terminalReason: 'validator-passed',
          attempt: attempt(0, {
            status: 'passed',
            validation: passed,
            finishReason: 'stop-condition',
            usage: { steps: 4, tokens: 90, costUsd: 0.01 },
          }),
          usage: { attempts: 1, steps: 4, tokens: 90, costUsd: 0.01, durationMs: 1000 },
          active: null,
        }),
      ),
    );

    expect(done).toMatchObject({
      status: 'succeeded',
      terminalReason: 'validator-passed',
      usage: { attempts: 1, steps: 4, tokens: 90, costUsd: 0.01, durationMs: 1000 },
    });
    expect(done.active).toBeUndefined();
    expect(done.attempts[0]?.validation?.outcome).toEqual(passed.outcome);
  });

  it('records a retry and the next attempt in one transition', async () => {
    const { store } = setup();
    await created(store);
    await toEvaluating(store);

    const retrying = applied(
      await store.applyTransition(
        transition(3, 'retrying', {
          attempt: attempt(0, { status: 'failed', feedback: 'two tests fail' }),
          active: null,
        }),
      ),
    );
    const second = applied(
      await store.applyTransition(
        transition(4, 'running', {
          attempt: attempt(1),
          usage: { attempts: 2, steps: 0, tokens: 0, durationMs: 0 },
          active: attemptWork(1),
        }),
      ),
    );

    expect(retrying.attempts[0]?.feedback).toBe('two tests fail');
    expect(second.attempts.map((item) => item.attemptIndex)).toEqual([0, 1]);
    expect(second.transitionSeq).toBe(4);
  });

  it('accepts a legal terminal transition for every terminal reason', async () => {
    // What each reason's last attempt legally shows: the status its validation
    // outcome produces, and a verdict where the reason is one.
    const validated = (outcome: Record<string, unknown>) => ({ ...passed, outcome }) as never;
    const failing = { kind: 'fail', feedback: 'no', evidence: [], retryable: true };
    const legal: Record<GoalRunTerminalReason, Partial<DurableGoalAttempt>> = {
      'validator-passed': { status: 'passed', validation: passed },
      'attempt-limit-reached': { status: 'failed', validation: validated(failing) },
      'aggregate-budget-exceeded': { status: 'failed', validation: validated(failing) },
      'validator-fail-non-retryable': {
        status: 'failed',
        validation: validated({ ...failing, retryable: false }),
      },
      'validator-infrastructure-error': {
        status: 'failed',
        validation: validated({
          kind: 'error',
          error: { kind: 'execute', code: 'DOWN', message: 'down' },
        }),
      },
      'unsupported-validation': { status: 'aborted' },
      'attempt-run-failed': { status: 'failed' },
      'goal-canceled': { status: 'aborted' },
    };
    const reasons = Object.keys(TERMINAL_STATUS_BY_REASON) as GoalRunTerminalReason[];

    for (const reason of reasons) {
      const { store } = setup();
      await created(store, { bounds: { maximumAttempts: 1, maximumTotalTokens: 1000 } });
      await toEvaluating(store);

      if (reason === 'goal-canceled') {
        // A goal is canceled only after a cancellation was asked for.
        await store.requestCancellation(GOAL, { requestedAt: at() }, at());
      }
      const result = await store.applyTransition(
        transition(3, TERMINAL_STATUS_BY_REASON[reason], {
          terminalReason: reason,
          attempt: attempt(0, { ...legal[reason], finishReason: 'stop-condition' }),
          active: null,
        }),
      );

      expect(applied(result)).toMatchObject({
        status: TERMINAL_STATUS_BY_REASON[reason],
        terminalReason: reason,
      });
    }
  });

  it('keeps a failure detail on the record', async () => {
    const { store } = setup();
    await created(store);

    const failed = applied(
      await store.applyTransition(
        transition(1, 'failed', {
          terminalReason: 'unsupported-validation',
          failureDetail: 'The validator cannot supply deterministic evidence.',
        }),
      ),
    );

    expect(failed.failureDetail).toBe('The validator cannot supply deterministic evidence.');
  });

  describe('idempotency', () => {
    it('answers a replay of the current transition as a duplicate with no write', async () => {
      const { kv, store } = setup();
      await created(store);
      const request = transition(1, 'running', {
        attempt: attempt(0),
        usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
        active: attemptWork(0),
      });
      const first = applied(await store.applyTransition(request));
      const stored = await kv.get(goalRecordKey(GOAL));

      const replay = await store.applyTransition(request);

      expect(replay).toEqual({ status: 'duplicate', record: first });
      expect(await kv.get(goalRecordKey(GOAL))).toBe(stored);
    });

    it('does not double count usage when a terminal commit is delivered twice', async () => {
      const { store } = setup();
      await created(store);
      await toEvaluating(store);
      const request = transition(3, 'succeeded', {
        terminalReason: 'validator-passed',
        attempt: attempt(0, {
          status: 'passed',
          validation: passed,
          finishReason: 'stop-condition',
          usage: { steps: 4, tokens: 90 },
        }),
        usage: { attempts: 1, steps: 4, tokens: 90, durationMs: 1000 },
        active: null,
      });

      const first = applied(await store.applyTransition(request));
      const replay = await store.applyTransition(request);

      expect(replay).toEqual({ status: 'duplicate', record: first });
      expect(first.usage.tokens).toBe(90);
    });

    it('lets exactly one of two concurrent identical commits apply', async () => {
      const { store } = setup();
      await created(store);
      const request = transition(1, 'running', {
        attempt: attempt(0),
        usage: FIRST_ATTEMPT_USAGE,
        active: attemptWork(0),
      });

      const results = await Promise.all([
        store.applyTransition(request),
        store.applyTransition(request),
      ]);

      expect(results.map((result) => result.status).toSorted()).toEqual(['applied', 'duplicate']);
      const stored = await store.get(GOAL);
      expect(stored?.revision).toBe(2);
    });

    it('treats the same transition id at a different target as a conflicting writer', async () => {
      const { store } = setup();
      await created(store);
      const first = applied(
        await store.applyTransition(
          transition(1, 'running', {
            attempt: attempt(0),
            usage: FIRST_ATTEMPT_USAGE,
            active: attemptWork(0),
          }),
        ),
      );

      const conflicting = await store.applyTransition({
        ...transition(1, 'failed', { terminalReason: 'attempt-run-failed' }),
        transitionId: first.currentTransition.transitionId,
      });

      expect(conflicting).toEqual({ status: 'stale', record: first });
    });
  });

  describe('stale and late transitions', () => {
    it('reports a transition that skips ahead as stale, with no write', async () => {
      const { store } = setup();
      const original = await created(store);

      expect(await store.applyTransition(transition(2, 'running'))).toEqual({
        status: 'stale',
        record: original,
      });
    });

    it('reports a replay of an older transition as stale with the authoritative record', async () => {
      const { store } = setup();
      await created(store);
      const first = transition(1, 'running', {
        attempt: attempt(0),
        usage: FIRST_ATTEMPT_USAGE,
        active: attemptWork(0),
      });
      applied(await store.applyTransition(first));
      const current = applied(
        await store.applyTransition(
          transition(2, 'evaluating', {
            attempt: attempt(0, { status: 'evaluating' }),
            active: {
              kind: 'validation',
              attemptId: goalAttemptId(GOAL, 0),
              validator: { name: 'tests@bureau', version: '1.0.0' },
              startedAt: '2026-10-02T00:00:06.000Z',
            },
          }),
        ),
      );

      expect(await store.applyTransition(first)).toEqual({ status: 'stale', record: current });
    });

    it('rejects a late attempt completion after cancellation without touching usage', async () => {
      const { store } = setup();
      await created(store);
      await toEvaluating(store);
      await store.requestCancellation(GOAL, { requestedAt: at() }, at());
      const canceled = applied(
        await store.applyTransition(
          transition(3, 'canceled', {
            terminalReason: 'goal-canceled',
            attempt: attempt(0, { status: 'aborted' }),
            active: null,
          }),
        ),
      );

      const late = await store.applyTransition(
        transition(4, 'succeeded', {
          terminalReason: 'validator-passed',
          usage: { attempts: 1, steps: 9, tokens: 999, durationMs: 9 },
        }),
      );

      expect(late).toEqual({ status: 'rejected', reason: 'terminal', record: canceled });
      const stored = await store.get(GOAL);
      expect(stored?.usage.tokens).toBe(0);
    });

    it('never resurrects a terminal goal, whatever the target', async () => {
      const { store } = setup();
      await created(store);
      applied(
        await store.applyTransition(
          transition(1, 'failed', { terminalReason: 'unsupported-validation' }),
        ),
      );

      for (const to of ['pending', 'running', 'evaluating', 'retrying'] as const) {
        const result = await store.applyTransition(transition(2, to));
        expect(result).toMatchObject({ status: 'rejected', reason: 'terminal' });
      }
    });
  });

  describe('rejections', () => {
    it('rejects an edge COR-638 does not allow', async () => {
      const { store } = setup();
      const original = await created(store);

      expect(await store.applyTransition(transition(1, 'evaluating'))).toEqual({
        status: 'rejected',
        reason: 'illegal-transition',
        record: original,
      });
      expect(
        await store.applyTransition(
          transition(1, 'succeeded', { terminalReason: 'validator-passed' }),
        ),
      ).toMatchObject({
        reason: 'illegal-transition',
      });
    });

    it('rejects a terminal transition without a matching reason, and a reason on a live one', async () => {
      const { store } = setup();
      await created(store);

      expect(await store.applyTransition(transition(1, 'failed'))).toMatchObject({
        status: 'rejected',
        reason: 'invalid-terminal-reason',
      });
      expect(
        await store.applyTransition(
          transition(1, 'failed', { terminalReason: 'validator-passed' }),
        ),
      ).toMatchObject({ reason: 'invalid-terminal-reason' });
      expect(
        await store.applyTransition(transition(1, 'running', { terminalReason: 'goal-canceled' })),
      ).toMatchObject({ reason: 'invalid-terminal-reason' });
    });

    it('rejects an attempt that leaves a gap or carries another goal’s id', async () => {
      const { store } = setup();
      await created(store);

      expect(
        await store.applyTransition(transition(1, 'running', { attempt: attempt(1) })),
      ).toMatchObject({
        reason: 'invalid-attempt',
      });
      expect(
        await store.applyTransition(
          transition(1, 'running', { attempt: { ...attempt(0), attemptId: 'someone-else:a0' } }),
        ),
      ).toMatchObject({ reason: 'invalid-attempt' });
    });

    it('keeps the first committed validation decision for an attempt', async () => {
      const { store } = setup();
      await created(store);
      await toEvaluating(store);
      const first = applied(
        await store.applyTransition(
          transition(3, 'retrying', {
            attempt: attempt(0, {
              status: 'aborted',
              validation: { ...passed, outcome: { kind: 'canceled' } },
            }),
            active: null,
          }),
        ),
      );

      const second = await store.applyTransition(
        transition(4, 'running', {
          attempt: attempt(0, {
            status: 'passed',
            validation: { ...passed, decisionId: 'another-decision' },
          }),
        }),
      );

      expect(second).toEqual({
        status: 'rejected',
        reason: 'decision-already-recorded',
        record: first,
      });
    });

    it('rejects a validation outcome above the inline cap', async () => {
      const { store } = setup();
      await created(store);
      await toEvaluating(store);
      const huge = {
        ...passed,
        outcome: {
          kind: 'pass',
          evidence: [{ source: 'log', detail: 'x'.repeat(GOAL_VALIDATION_MAXIMUM_BYTES) }],
        },
      } as const;

      const result = await store.applyTransition(
        transition(3, 'succeeded', {
          terminalReason: 'validator-passed',
          attempt: attempt(0, { status: 'passed', validation: huge }),
        }),
      );

      expect(result).toMatchObject({ status: 'rejected', reason: 'oversized' });
    });

    it('reports a goal that does not exist', async () => {
      const { store } = setup();

      expect(await store.applyTransition(transition(1, 'running'))).toEqual({ status: 'missing' });
    });
  });

  describe('compare-and-swap', () => {
    it('re-evaluates after a control-plane write interleaves, and keeps both', async () => {
      const kv = createKv();
      const store = createGoalStore(kv);
      await created(store);
      let interleaved = false;
      const racing = {
        ...kv,
        get: kv.get.bind(kv),
        list: kv.list.bind(kv),
        set: kv.set.bind(kv),
        conditionalBatch: async (...args: Parameters<typeof kv.conditionalBatch>) => {
          if (!interleaved) {
            interleaved = true;
            await store.recordControllerRestart(GOAL, at());
          }
          return kv.conditionalBatch(...args);
        },
      };
      const racingStore = createGoalStore(racing);

      const result = applied(
        await racingStore.applyTransition(
          transition(1, 'running', {
            attempt: attempt(0),
            usage: FIRST_ATTEMPT_USAGE,
            active: attemptWork(0),
          }),
        ),
      );

      expect(result).toMatchObject({ status: 'running', controllerRestarts: 1, revision: 3 });
    });

    it('reports stale, never throws, when it keeps losing the race', async () => {
      const kv = createKv();
      const store = createGoalStore(kv);
      const original = await created(store);
      let attempts = 0;
      const losing = {
        ...kv,
        get: kv.get.bind(kv),
        list: kv.list.bind(kv),
        conditionalBatch: async () => {
          attempts += 1;
          return false;
        },
      } as unknown as typeof kv;

      const result = await createGoalStore(losing).applyTransition(
        transition(1, 'running', {
          attempt: attempt(0),
          usage: FIRST_ATTEMPT_USAGE,
          active: attemptWork(0),
        }),
      );

      expect(result).toEqual({ status: 'stale', record: original });
      expect(attempts).toBe(16);
      expect(await store.get(GOAL)).toEqual(original);
    });
  });

  it('lets a cancellation request win over every transition but the one to canceled', async () => {
    const { store } = setup();
    await created(store);
    await toEvaluating(store);
    const marked = await store.requestCancellation(
      GOAL,
      { requestedAt: at(), principal: 'user-1' },
      at(),
    );
    if (marked.status !== 'updated') throw new Error('expected updated');

    const blocked = await store.applyTransition(
      transition(3, 'succeeded', { terminalReason: 'validator-passed' }),
    );
    const retry = await store.applyTransition(transition(3, 'retrying'));
    const canceled = applied(
      await store.applyTransition(
        transition(3, 'canceled', {
          terminalReason: 'goal-canceled',
          attempt: attempt(0, { status: 'aborted' }),
          active: null,
        }),
      ),
    );

    expect(blocked).toEqual({
      status: 'rejected',
      reason: 'cancellation-requested',
      record: marked.record,
    });
    expect(retry).toMatchObject({ reason: 'cancellation-requested' });
    expect(canceled.status).toBe('canceled');
    expect(canceled.cancellation?.principal).toBe('user-1');
  });
});

describe('createGoalStore control-plane writes', () => {
  it('records a cancellation once: the first marker wins', async () => {
    const { store } = setup();
    await created(store);

    const first = await store.requestCancellation(
      GOAL,
      { requestedAt: '2026-10-02T01:00:01.000Z', reason: 'stop' },
      at(),
    );
    const second = await store.requestCancellation(
      GOAL,
      { requestedAt: '2026-10-02T01:00:02.000Z' },
      at(),
    );

    expect(first).toMatchObject({ status: 'updated', record: { revision: 2, transitionSeq: 0 } });
    expect(second).toMatchObject({ status: 'unchanged' });
    const stored = await store.get(GOAL);
    expect(stored?.cancellation).toEqual({
      requestedAt: '2026-10-02T01:00:01.000Z',
      reason: 'stop',
    });
  });

  it('does not touch the transition sequence, so a controller transition still lines up', async () => {
    const { store } = setup();
    await created(store);
    await store.recordControllerRestart(GOAL, at());
    await store.requestCancellation(GOAL, { requestedAt: at() }, at());

    const result = await store.applyTransition(
      transition(1, 'canceled', { terminalReason: 'goal-canceled' }),
    );

    expect(applied(result)).toMatchObject({ status: 'canceled', transitionSeq: 1, revision: 4 });
  });

  it('refuses to cancel or restart a terminal goal and reports a missing one', async () => {
    const { store } = setup();
    await created(store);
    const done = applied(
      await store.applyTransition(
        transition(1, 'failed', { terminalReason: 'unsupported-validation' }),
      ),
    );

    expect(await store.requestCancellation(GOAL, { requestedAt: at() }, at())).toEqual({
      status: 'rejected',
      reason: 'terminal',
      record: done,
    });
    expect(await store.recordControllerRestart(GOAL, at())).toMatchObject({ reason: 'terminal' });
    expect(await store.requestCancellation('nope', { requestedAt: at() }, at())).toEqual({
      status: 'missing',
    });
  });

  it('refuses to count a controller restart for a goal whose cancellation is recorded', async () => {
    const { store } = setup();
    await created(store);
    await store.requestCancellation(GOAL, { requestedAt: at() }, at());

    const refused = await store.recordControllerRestart(GOAL, at(), 0);

    expect(refused).toMatchObject({
      status: 'rejected',
      reason: 'cancellation-requested',
      record: { controllerRestarts: 0 },
    });
    const stored = await store.get(GOAL);
    expect(stored?.controllerRestarts).toBe(0);
  });

  it('counts controller restarts', async () => {
    const { store } = setup();
    await created(store);

    await store.recordControllerRestart(GOAL, at());
    const second = await store.recordControllerRestart(GOAL, at());

    expect(second).toMatchObject({
      status: 'updated',
      record: { controllerRestarts: 2, revision: 3 },
    });
  });

  it('counts a restart against an expected count, so only one of two racing recoveries is counted', async () => {
    const { store } = setup();
    await created(store);

    const first = await store.recordControllerRestart(GOAL, at(), 0);
    const second = await store.recordControllerRestart(GOAL, at(), 0);

    expect(first).toMatchObject({ status: 'updated', record: { controllerRestarts: 1 } });
    expect(second).toMatchObject({ status: 'stale', record: { controllerRestarts: 1 } });
    const stored = await store.get(GOAL);
    expect(stored?.controllerRestarts).toBe(1);
  });

  it('closes a terminal goal once and refuses to close a live one', async () => {
    const { store } = setup();
    await created(store);

    expect(await store.close(GOAL, at())).toMatchObject({
      status: 'rejected',
      reason: 'not-terminal',
    });

    applied(
      await store.applyTransition(
        transition(1, 'failed', { terminalReason: 'unsupported-validation' }),
      ),
    );
    const closed = await store.close(GOAL, '2026-10-02T01:00:03.000Z');
    const again = await store.close(GOAL, '2026-10-02T01:00:05.000Z');

    expect(closed).toMatchObject({
      status: 'updated',
      record: { closedAt: '2026-10-02T01:00:03.000Z' },
    });
    expect(again).toMatchObject({
      status: 'unchanged',
      record: { closedAt: '2026-10-02T01:00:03.000Z' },
    });
  });

  it('records the cleanup a closure owes once, and only for a goal that was closed', async () => {
    const { store } = setup();
    await created(store);
    applied(
      await store.applyTransition(
        transition(1, 'failed', { terminalReason: 'unsupported-validation' }),
      ),
    );

    expect(await store.markCleanedUp(GOAL, at())).toMatchObject({
      status: 'rejected',
      reason: 'not-closed',
    });
    await store.close(GOAL, '2026-10-02T01:00:03.000Z');
    const cleaned = await store.markCleanedUp(GOAL, '2026-10-02T01:00:04.000Z');
    const again = await store.markCleanedUp(GOAL, '2026-10-02T01:00:06.000Z');

    expect(cleaned).toMatchObject({
      status: 'updated',
      record: { closedAt: '2026-10-02T01:00:03.000Z', cleanedUpAt: '2026-10-02T01:00:04.000Z' },
    });
    expect(again).toMatchObject({
      status: 'unchanged',
      record: { cleanedUpAt: '2026-10-02T01:00:04.000Z' },
    });
    expect(await store.markCleanedUp('missing', at())).toEqual({ status: 'missing' });
  });

  it('is not affected by a transition request racing a cancellation request', async () => {
    const { store } = setup();
    await created(store);

    const [transitioned, marked] = await Promise.all([
      store.applyTransition(transition(1, 'running')),
      store.requestCancellation(GOAL, { requestedAt: at() }, at()),
    ]);

    expect(['applied', 'rejected']).toContain(transitioned.status);
    expect(marked.status).toBe('updated');
    const record = await store.get(GOAL);
    expect(record?.cancellation).toBeDefined();
    expect(record?.revision).toBe(transitioned.status === 'applied' ? 3 : 2);
  });
});

describe('boundValidationOutcome', () => {
  it('returns an outcome under the cap untouched', () => {
    const outcome = passed.outcome;

    expect(boundValidationOutcome(outcome)).toBe(outcome);
  });

  it('replaces evidence and error causes with markers and keeps the verdict', () => {
    const big = 'x'.repeat(2000);
    const fail = {
      kind: 'fail',
      feedback: 'nope',
      evidence: [{ source: 'log', detail: { text: big } }],
      retryable: true,
    } as const;
    const error = {
      kind: 'error',
      error: { kind: 'execute', code: 'boom', message: 'bad', cause: { trace: big } },
    } as const;

    const boundedFail = boundValidationOutcome(fail, 600);
    const boundedError = boundValidationOutcome(error, 600);

    expect(boundedFail).toMatchObject({ kind: 'fail', retryable: true, feedback: 'nope' });
    expect(boundedFail.kind === 'fail' && boundedFail.evidence[0]).toEqual({
      source: 'log',
      detail: { truncated: true, originalByteLength: JSON.stringify({ text: big }).length },
    });
    expect(boundedError).toMatchObject({
      kind: 'error',
      error: { code: 'boom', cause: { truncated: true } },
    });
  });

  it('truncates long free text only once the outcome is over the cap', () => {
    const reason = 'r'.repeat(10_000);

    const bounded = boundValidationOutcome({ kind: 'indeterminate', reason }, 2000);

    expect(bounded.kind === 'indeterminate' && bounded.reason.length).toBeLessThan(5000);
    expect(boundValidationOutcome({ kind: 'canceled' }, 1)).toEqual({ kind: 'canceled' });
  });
});

describe('boundValidationOutcome guarantees the cap', () => {
  /** A small deterministic generator, so a failing case is reproducible from its seed. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const ALPHABETS = ['a', 'é', '\u20ac', '\u{1F600}'] as const;

  function adversarialOutcome(next: () => number): ProjectedValidatorOutcome {
    const text = (): string => {
      const magnitude = [0, 3, 40, 900, 5_000, 70_000, 400_000][Math.floor(next() * 7)]!;
      return ALPHABETS[Math.floor(next() * ALPHABETS.length)]!.repeat(magnitude);
    };
    const json = (): never =>
      (next() < 0.5
        ? { text: text() }
        : {
            rows: Array.from({ length: Math.floor(next() * 300) }, () => 'r'.repeat(50)),
          }) as never;
    const evidence = () => {
      const count = [0, 1, 5, 200, 3_000, 40_000][Math.floor(next() * 6)]!;
      // Many entries or long ones, never both at once: the whole must stay a few megabytes.
      const share = Math.max(1, Math.floor(2_000_000 / Math.max(1, count)));
      const entryText = (): string =>
        ALPHABETS[Math.floor(next() * ALPHABETS.length)]!.repeat(
          Math.min(share, [0, 3, 40, 900, 5_000, 70_000][Math.floor(next() * 6)]!),
        );
      return Array.from({ length: count }, () => ({
        source: entryText(),
        detail: { text: entryText() } as never,
      }));
    };
    const error = () => ({
      kind: (['load', 'contract', 'execute', 'timeout', 'output'] as const)[
        Math.floor(next() * 5)
      ]!,
      code: text(),
      message: text(),
      ...(next() < 0.5 ? { cause: json() } : {}),
    });
    switch (Math.floor(next() * 6)) {
      case 0:
        return { kind: 'pass', evidence: evidence() };
      case 1:
        return { kind: 'fail', feedback: text(), evidence: evidence(), retryable: next() < 0.5 };
      case 2:
        return { kind: 'error', error: error() };
      case 3:
        return { kind: 'unavailable', error: error(), reason: text() };
      case 4:
        return { kind: 'indeterminate', reason: text() };
      default:
        return { kind: 'canceled' };
    }
  }

  it.each([GOAL_VALIDATION_MAXIMUM_BYTES, 4096, 1024])(
    'never returns an outcome over %d bytes, whatever the sizes of its parts',
    (maximumBytes) => {
      for (let seed = 1; seed <= 150; seed += 1) {
        const original = adversarialOutcome(random(seed));
        const bounded = boundValidationOutcome(original, maximumBytes);

        const bytes = new TextEncoder().encode(JSON.stringify(bounded)).byteLength;
        expect({ seed, bytes: bytes <= maximumBytes }).toEqual({ seed, bytes: true });
        // The verdict survives unless the outcome could not be bounded at all, in
        // which case it is a validator infrastructure error and says so.
        if (bounded.kind !== original.kind) {
          expect({ seed, kind: bounded.kind }).toEqual({ seed, kind: 'error' });
          expect(bounded.kind === 'error' && bounded.error.code).toBe('OUTCOME_TOO_LARGE');
        } else if (original.kind === 'fail' && bounded.kind === 'fail') {
          expect(bounded.retryable).toBe(original.retryable);
        }
      }
    },
  );

  it('keeps the verdict of an outcome whose evidence is merely long, by dropping entries, not changing it', () => {
    const evidence = Array.from({ length: 5_000 }, (_, index) => ({
      source: `check-${index}`,
      detail: { index },
    }));

    const bounded = boundValidationOutcome({ kind: 'pass', evidence });

    expect(bounded.kind).toBe('pass');
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(
      GOAL_VALIDATION_MAXIMUM_BYTES,
    );
    expect(bounded.kind === 'pass' && bounded.evidence.length).toBeGreaterThan(10);
  });
});

describe('the audit transition log', () => {
  const key = goalRecordKey(GOAL);
  const runningRequest = () =>
    transition(1, 'running', {
      attempt: attempt(0),
      usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
      active: {
        kind: 'attempt',
        attemptId: goalAttemptId(GOAL, 0),
        runId: goalAttemptRunId(GOAL, 0),
        startedAt: '2026-10-02T00:00:05.000Z',
      },
    });

  it('appends one entry per transition in the same commit as the transition', async () => {
    const { kv, store } = setup();
    await created(store);

    const running = applied(await store.applyTransition(runningRequest()));

    expect(running.auditLog).toEqual([
      {
        seq: 1,
        transitionId: 'goal-1:t1',
        events: [expect.objectContaining({ kind: 'goal.attempt.started', dedupeKey: 'goal-1:1' })],
      },
    ]);
    // The stored text is the committed record: the log is inside it, not beside it.
    const stored = JSON.parse((await kv.get(key)) ?? 'null') as GoalState;
    const read = await store.get(GOAL);
    expect(read).toEqual(stored);
  });

  it('keeps an entry for a transition that implies no event, and never rewrites earlier ones', async () => {
    const { store } = setup();
    await created(store);
    const first = applied(await store.applyTransition(runningRequest()));
    const second = applied(
      await store.applyTransition(
        transition(2, 'evaluating', {
          attempt: attempt(0, { status: 'evaluating', finishReason: 'stop-condition' }),
          active: {
            kind: 'validation',
            attemptId: goalAttemptId(GOAL, 0),
            validator: { name: 'tests@bureau', version: '1.0.0' },
            startedAt: '2026-10-02T00:01:00.000Z',
          },
        }),
      ),
    );

    expect(second.auditLog.map((entry) => [entry.seq, entry.events.length])).toEqual([
      [1, 1],
      [2, 0],
    ]);
    expect(second.auditLog[0]).toEqual(first.auditLog[0]);
  });

  it('does not append for a duplicate, stale, or rejected transition', async () => {
    const { store } = setup();
    await created(store);
    const running = applied(await store.applyTransition(runningRequest()));

    const duplicate = await store.applyTransition(runningRequest());
    const stale = await store.applyTransition(transition(5, 'evaluating'));
    const rejected = await store.applyTransition(transition(2, 'pending'));

    expect([duplicate.status, stale.status, rejected.status]).toEqual([
      'duplicate',
      'stale',
      'rejected',
    ]);
    const after = await store.get(GOAL);
    expect(after?.auditLog).toEqual(running.auditLog);
  });

  it('appends a restart entry in the same commit as the restart count', async () => {
    const { store } = setup();
    await created(store);
    applied(await store.applyTransition(runningRequest()));

    const restarted = await store.recordControllerRestart(GOAL, '2026-10-02T00:05:00.000Z');
    const stale = await store.recordControllerRestart(GOAL, at(), 0);

    if (restarted.status !== 'updated') throw new Error('expected an updated record');
    expect(restarted.record.auditLog.map((entry) => [entry.seq, entry.transitionId])).toEqual([
      [1, 'goal-1:t1'],
      [1, 'goal-1:restart-1'],
    ]);
    expect(restarted.record.auditLog[1]?.events[0]).toMatchObject({
      kind: 'goal.recovered',
      dedupeKey: 'goal-1:1:restart-1',
      at: '2026-10-02T00:05:00.000Z',
    });
    expect(stale.status).toBe('stale');
    const after = await store.get(GOAL);
    expect(after?.auditLog).toHaveLength(2);
  });

  it('still decodes a transition that follows a restart', async () => {
    const { store } = setup();
    await created(store);
    applied(await store.applyTransition(runningRequest()));
    await store.recordControllerRestart(GOAL, at());

    const next = applied(
      await store.applyTransition(
        transition(2, 'evaluating', {
          attempt: attempt(0, { status: 'evaluating', finishReason: 'stop-condition' }),
          active: {
            kind: 'validation',
            attemptId: goalAttemptId(GOAL, 0),
            validator: { name: 'tests@bureau', version: '1.0.0' },
            startedAt: '2026-10-02T00:00:06.000Z',
          },
        }),
      ),
    );

    expect(next.auditLog.map((entry) => entry.transitionId)).toEqual([
      'goal-1:t1',
      'goal-1:restart-1',
      'goal-1:t2',
    ]);
    expect(await store.get(GOAL)).toEqual(next);
  });

  it('refuses a goal bounded to more attempts than the log can hold', () => {
    expect(() =>
      createGoalState(
        input({ bounds: { maximumAttempts: GOAL_MAXIMUM_ATTEMPTS + 1, maximumTotalTokens: 1 } }),
      ),
    ).toThrow(GoalConfigurationError);
    expect(GOAL_AUDIT_LOG_MAXIMUM_ENTRIES).toBeGreaterThan(3 * GOAL_MAXIMUM_ATTEMPTS + 1);
  });

  it('refuses to grow a full log rather than drop an entry', async () => {
    const { kv, store } = setup();
    const base = createGoalState(input());
    const entries = Array.from({ length: GOAL_AUDIT_LOG_MAXIMUM_ENTRIES }, (_, index) => ({
      seq: 0,
      transitionId: `goal-1:restart-${index + 1}`,
      // What a counted restart really writes, so the log decodes as genuine.
      events: [
        {
          kind: 'goal.recovered',
          payload: {
            goalRunId: GOAL,
            controllerRestarts: index + 1,
            status: 'pending',
            transitionSeq: 0,
          },
          dedupeKey: `${GOAL}:0:restart-${index + 1}`,
          at: base.updatedAt,
        },
      ],
    }));
    await kv.set(
      key,
      JSON.stringify({ ...base, controllerRestarts: entries.length, auditLog: entries }),
    );

    const transitioned = await store.applyTransition(transition(1, 'running'));
    const restarted = await store.recordControllerRestart(GOAL, at());

    expect(transitioned).toMatchObject({ status: 'rejected', reason: 'oversized' });
    expect(restarted).toMatchObject({ status: 'rejected', reason: 'audit-log-full' });
    const after = await store.get(GOAL);
    expect(after?.auditLog).toHaveLength(GOAL_AUDIT_LOG_MAXIMUM_ENTRIES);
  });
});

describe('a record is believed only when its parts agree with each other (COR-851)', () => {
  const key = goalRecordKey(GOAL);

  /** Rewrites the stored text of `record` after `change` edits its parsed form. */
  async function overwrite(
    kv: ReturnType<typeof createKv>,
    record: GoalState,
    change: (parsed: Record<string, any>) => void,
    at = key,
  ): Promise<void> {
    const parsed = JSON.parse(JSON.stringify(record)) as Record<string, any>;
    change(parsed);
    await kv.set(at, JSON.stringify(parsed));
  }

  /** A retrying record whose one completed attempt reported `usage`, with the aggregate written to match. */
  async function retryingAfter(
    store: GoalStore,
    usage: { steps: number; tokens: number; costUsd?: number },
  ): Promise<GoalState> {
    await created(store);
    await toEvaluating(store);
    return applied(
      await store.applyTransition(
        transition(3, 'retrying', {
          attempt: attempt(0, { status: 'failed', usage }),
          usage: { attempts: 1, ...usage, durationMs: 0 },
          active: null,
        }),
      ),
    );
  }

  describe('aggregate usage', () => {
    it('refuses to store an aggregate that disagrees with the attempts it sums', async () => {
      const { kv, store } = setup();
      await created(store);
      const evaluating = await toEvaluating(store);

      // The attempt used 50 steps but the aggregate stays at zero.
      const result = await store.applyTransition(
        transition(3, 'retrying', {
          attempt: attempt(0, { status: 'failed', usage: { steps: 50, tokens: 0 } }),
          active: null,
        }),
      );

      expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-record' });
      expect(JSON.parse((await kv.get(key)) ?? 'null')).toEqual(evaluating);
    });

    const disagreements: Array<[string, (parsed: Record<string, any>) => void]> = [
      ['steps', (parsed) => (parsed['usage'].steps = 0)],
      ['tokens', (parsed) => (parsed['usage'].tokens = 0)],
      ['cost', (parsed) => delete parsed['usage'].costUsd],
      ['attempt count', (parsed) => (parsed['usage'].attempts = 2)],
      ['an inflated step total', (parsed) => (parsed['usage'].steps = 9999)],
    ];

    for (const [name, change] of disagreements) {
      it(`reads a record as corrupt when the aggregate ${name} disagrees with its attempts`, async () => {
        const corrupt: string[] = [];
        const { kv, store } = setup(corrupt);
        const record = await retryingAfter(store, { steps: 50, tokens: 7, costUsd: 0.5 });
        expect(await store.get(GOAL)).toEqual(record);

        await overwrite(kv, record, change);

        expect(await store.get(GOAL)).toBeUndefined();
        expect(corrupt).toEqual([key]);
      });
    }

    it('accepts an aggregate that sums every attempt, in order', async () => {
      const { store } = setup();
      await retryingAfter(store, { steps: 50, tokens: 7, costUsd: 0.1 });
      const second = applied(
        await store.applyTransition(
          transition(4, 'running', {
            attempt: attempt(1),
            usage: { attempts: 2, steps: 50, tokens: 7, costUsd: 0.1, durationMs: 0 },
            active: attemptWork(1),
          }),
        ),
      );
      expect(second.usage).toMatchObject({ attempts: 2, steps: 50, tokens: 7, costUsd: 0.1 });
    });
  });

  describe('timestamps', () => {
    it('refuses to create a record whose creation time is not a timestamp', () => {
      for (const now of ['corrupt', '2026-13-45T99:00:00.000Z', '2026-10-02', ' ']) {
        expect(() => createGoalState(input({ now }))).toThrow(InvalidGoalStateError);
      }
    });

    const timestampPaths: Array<[string, (parsed: Record<string, any>) => void]> = [
      ['createdAt', (parsed) => (parsed['createdAt'] = 'corrupt')],
      ['updatedAt', (parsed) => (parsed['updatedAt'] = 'corrupt')],
      ['the current transition', (parsed) => (parsed['currentTransition'].at = 'corrupt')],
      ['an attempt start', (parsed) => (parsed['attempts'][0].startedAt = 'corrupt')],
      ['an attempt completion', (parsed) => (parsed['attempts'][0].completedAt = 'corrupt')],
      ['a validation start', (parsed) => (parsed['attempts'][0].validation.startedAt = 'corrupt')],
      [
        'a validation completion',
        (parsed) => (parsed['attempts'][0].validation.completedAt = 'corrupt'),
      ],
      ['an audit event', (parsed) => (parsed['auditLog'][0].events[0].at = 'corrupt')],
      ['closedAt', (parsed) => (parsed['closedAt'] = 'corrupt')],
      ['cleanedUpAt', (parsed) => (parsed['cleanedUpAt'] = 'corrupt')],
      [
        'a calendar date that does not exist',
        (parsed) => (parsed['createdAt'] = '2026-02-31T00:00:00.000Z'),
      ],
      ['a bare date', (parsed) => (parsed['createdAt'] = '2026-10-02')],
    ];

    async function finishedRecord(store: GoalStore): Promise<GoalState> {
      await created(store);
      await toEvaluating(store);
      applied(
        await store.applyTransition(
          transition(3, 'succeeded', {
            terminalReason: 'validator-passed',
            attempt: attempt(0, {
              status: 'passed',
              validation: passed,
              finishReason: 'stop-condition',
              completedAt: '2026-10-02T00:00:07.000Z',
            }),
            active: null,
          }),
        ),
      );
      await store.close(GOAL, '2026-10-02T00:00:08.000Z');
      await store.markCleanedUp(GOAL, '2026-10-02T00:00:09.000Z');
      const record = await store.get(GOAL);
      if (record === undefined) throw new Error('expected the finished record');
      return record;
    }

    for (const [name, change] of timestampPaths) {
      it(`reads a record as corrupt when ${name} is not a timestamp`, async () => {
        const corrupt: string[] = [];
        const { kv, store } = setup(corrupt);
        const record = await finishedRecord(store);
        // Pin that the unmodified record, with every timestamp field present, is believed.
        expect(record.auditLog.some((entry) => entry.events.length > 0)).toBe(true);
        expect(record.cleanedUpAt).toBeDefined();
        expect(record.attempts[0]?.completedAt).toBeDefined();

        await overwrite(kv, record, change);

        expect(await store.get(GOAL)).toBeUndefined();
        expect(corrupt).toEqual([key]);
      });
    }

    it('reads a record as corrupt when the cancellation time is not a timestamp', async () => {
      const { kv, store } = setup();
      const record = await created(store);
      const marked = await store.requestCancellation(GOAL, { requestedAt: at() }, at());
      expect(marked.status).toBe('updated');

      await overwrite(
        kv,
        record,
        (parsed) => (parsed['cancellation'] = { requestedAt: 'corrupt' }),
      );

      expect(await store.get(GOAL)).toBeUndefined();
    });

    it('reads a record whose in-flight work start is not a timestamp as corrupt', async () => {
      const { kv, store } = setup();
      await created(store);
      const running = applied(
        await store.applyTransition(
          transition(1, 'running', {
            attempt: attempt(0),
            usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
            active: attemptWork(0),
          }),
        ),
      );

      await overwrite(kv, running, (parsed) => {
        parsed['attempts'][0].startedAt = 'corrupt';
        parsed['active'].startedAt = 'corrupt';
      });

      expect(await store.get(GOAL)).toBeUndefined();
    });
  });

  describe('storage key', () => {
    it("never returns another goal's record stored under this goal's key", async () => {
      const corrupt: string[] = [];
      const { kv, store } = setup(corrupt);
      const other = createGoalState(input({ goalRunId: 'goal-b' }));
      const foreignKey = goalRecordKey('goal-a');
      await kv.set(foreignKey, JSON.stringify(other));

      expect(await store.get('goal-a')).toBeUndefined();
      expect(await store.list()).toEqual([]);
      const scanned = await store.scan();
      expect(scanned.unreadable).toEqual(['goal-a']);
      expect(await store.listUnreadable()).toEqual(['goal-a']);
      expect(await store.isUnreadable('goal-a')).toBe(true);
      expect(corrupt).toContain(foreignKey);
    });

    it('writes nothing through a key whose record belongs to another goal', async () => {
      const { kv, store } = setup();
      const other = createGoalState(input({ goalRunId: 'goal-b' }));
      const foreignKey = goalRecordKey('goal-a');
      const raw = JSON.stringify(other);
      await kv.set(foreignKey, raw);

      expect(await store.requestCancellation('goal-a', { requestedAt: at() }, at())).toEqual({
        status: 'corrupt',
      });
      expect(await store.recordControllerRestart('goal-a', at())).toEqual({ status: 'corrupt' });
      expect(await store.close('goal-a', at())).toEqual({ status: 'corrupt' });
      expect(await kv.get(foreignKey)).toBe(raw);
      expect(await store.get('goal-b')).toBeUndefined();
    });

    it('still reads a record stored under its own key, however the id is encoded', async () => {
      const { store } = setup();
      await store.create(createGoalState(input({ goalRunId: 'a:b/c d' })));
      const found = await store.get('a:b/c d');
      expect(found?.goalRunId).toBe('a:b/c d');
      expect(await store.list()).toHaveLength(1);
    });
  });
});
