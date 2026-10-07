/**
 * COR-851 — a goal id that is not well-formed Unicode text names no goal.
 *
 * The record key is percent-encoded, and `encodeURIComponent` throws a
 * `URIError` for a lone surrogate. Every lookup by id has to answer the
 * documented absent outcome for such an id instead of rejecting. An id that is
 * not text at all (an untyped caller's number, `null`, or object) names no goal
 * either, and no outcome may carry it as though it were an id.
 */
import { createMockGenerate, stopWhen } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { createGoalState, goalTransitionId, InvalidGoalStateError } from './goal-state';
import { createGoalStore } from './goal-store';
import {
  createCheckValidator,
  createDiagnostics,
  goalRequest,
  hangUntilAborted,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import type { Bureau } from './types';

const open: Bureau[] = [];

afterEach(async () => {
  for (const bureau of open.splice(0)) await bureau.dispose();
});

async function boot(): Promise<Bureau> {
  const bureau = await createBureau({
    agents: { worker: workerAgent(hangUntilAborted) },
    validators: [createCheckValidator()],
    generate: createMockGenerate([{ content: 'ok', toolCalls: [] }]),
    toolbox: createToolbox([]),
    stopWhen: stopWhen.noToolCalls(),
    storage: { type: 'memory' },
    durableExecution: true,
    onDiagnostic: createDiagnostics().onDiagnostic,
  });
  const typed = bureau as unknown as Bureau;
  open.push(typed);
  return typed;
}

const MALFORMED = [
  ['a lone high surrogate', '\ud800'],
  ['a lone low surrogate', 'goal-\udc00'],
  ['a high surrogate before text', 'g\ud83dx'],
] as const;

const OPERATIONS: ReadonlyArray<
  readonly [
    string,
    (bureau: Bureau, goalRunId: string) => Promise<unknown>,
    (id: string) => unknown,
  ]
> = [
  ['get', (bureau, id) => bureau.goals.get(id), () => undefined],
  ['active', (bureau, id) => bureau.goals.active(id), () => undefined],
  ['cancel', (bureau, id) => bureau.goals.cancel(id), () => ({ outcome: 'not-found' })],
  ['close', (bureau, id) => bureau.goals.close(id), () => ({ outcome: 'not-found' })],
  [
    'recover',
    (bureau, id) => bureau.goals.recover(id),
    (id) => ({ goals: [{ goalRunId: id, outcome: 'not-found' }], failures: [] }),
  ],
];

describe('a goal id with a lone surrogate', () => {
  for (const [operation, run, expected] of OPERATIONS) {
    it.each(MALFORMED)(`is not found by ${operation}: %s`, async (_name, goalRunId) => {
      const bureau = await boot();
      expect(await run(bureau, goalRunId)).toEqual(expected(goalRunId));
    });
  }

  it.each(MALFORMED)(
    'is not found when the caller is scoped to a principal: %s',
    async (_n, id) => {
      const bureau = await boot();
      expect(await bureau.goals.get(id, { principal: 'alice' })).toBeUndefined();
      expect(await bureau.goals.cancel(id, { principal: 'alice' })).toEqual({
        outcome: 'not-found',
      });
    },
  );
});

const NOT_TEXT = [
  ['a number', 7],
  ['null', null],
  ['false', false],
  ['an object', { goalRunId: 'g1' }],
  ['an array', ['g1']],
] as const;

describe('a goal id that is not text', () => {
  it.each(NOT_TEXT)('is absent to get, active, cancel, and close: %s', async (_name, id) => {
    const bureau = await boot();
    expect(await bureau.goals.get(id as never)).toBeUndefined();
    expect(await bureau.goals.active(id as never)).toBeUndefined();
    expect(await bureau.goals.cancel(id as never)).toEqual({ outcome: 'not-found' });
    expect(await bureau.goals.close(id as never)).toEqual({ outcome: 'not-found' });
  });

  it.each(NOT_TEXT)(
    'is answered by recover with a report that keeps its public type: %s',
    async (_name, id) => {
      const bureau = await boot();
      const report = await bureau.goals.recover(id as never);
      expect(report).toEqual({
        goals: [],
        failures: [{ goalRunId: '*', reason: 'The goal id must be text.' }],
      });
      for (const named of [...report.goals, ...report.failures]) {
        expect(typeof named.goalRunId).toBe('string');
      }
    },
  );

  it.each(NOT_TEXT)(
    'never widens recover into the sweep over every goal: %s',
    async (_name, id) => {
      const bureau = await boot();
      expect(await bureau.goals.create(goalRequest())).toMatchObject({ outcome: 'created' });
      // The control: with no id, recovery does sweep and name the goal.
      const sweep = await bureau.goals.recover();
      expect(sweep.goals.map((entry) => entry.goalRunId)).toEqual(['g1']);
      const report = await bureau.goals.recover(id as never);
      expect(report.goals).toEqual([]);
    },
  );
});

describe('the goal store given a goal id with a lone surrogate', () => {
  const NOW = '2026-10-02T12:00:00.000Z';

  it.each(MALFORMED)('answers absent from every verb, never a URIError: %s', async (_name, id) => {
    const store = createGoalStore(textValueStore(new MemoryStorage()));
    expect(await store.get(id)).toBeUndefined();
    expect(await store.isUnreadable(id)).toBe(false);
    expect(await store.requestCancellation(id, { requestedAt: NOW }, NOW)).toEqual({
      status: 'missing',
    });
    expect(await store.close(id, NOW)).toEqual({ status: 'missing' });
    expect(await store.markCleanedUp(id, NOW)).toEqual({ status: 'missing' });
    expect(await store.recordControllerRestart(id, NOW, 0)).toEqual({ status: 'missing' });
    expect(
      await store.applyTransition({
        goalRunId: id,
        seq: 1,
        transitionId: goalTransitionId(id, 1),
        to: 'canceled',
        at: NOW,
        cause: 'x',
      }),
    ).toEqual({ status: 'missing' });
  });

  it.each(MALFORMED)(
    'refuses to create a record under it with the store error: %s',
    async (_n, id) => {
      const store = createGoalStore(textValueStore(new MemoryStorage()));
      const state = createGoalState({
        goalRunId: 'valid',
        identity: { name: 'goal', version: '1' },
        objective: { agentName: 'worker', prompt: 'work' },
        validator: { name: 'check', version: '1' },
        conversationPolicy: { kind: 'continue' },
        bounds: { maximumAttempts: 2, maximumTotalSteps: 10 },
        now: NOW,
      });
      let error: unknown;
      try {
        await store.create({ ...state, goalRunId: id, workflowId: `goal:${id}` });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(InvalidGoalStateError);
    },
  );
});
