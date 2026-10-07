/**
 * COR-851 — a goal never adopts, stops, signals, or replaces what it does not own.
 *
 * Every id a goal uses is a function of a caller-chosen goal id, so something
 * else can already hold one. These tests put a foreign workflow or run on each
 * deterministic id and show the goal's view of the world does not contain it.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { GOAL_WORKFLOW_TYPE } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createGoalAttemptFenceHost } from './goal-attempt-fence';
import {
  createOwnedGoalEngine,
  createOwnedRunCanceller,
  GoalCorruptOwnershipRecordError,
  GoalOwnershipError,
  GoalOwnershipUnknownError,
  isGoalOwnedRunRecord,
  verifyAttemptRun,
} from './goal-ownership';
import { createGoalWorkflowHost } from './goal-ports';
import { goalAttemptRunId } from './goal-state';
import type { GoalEngine } from './goal-types';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import { composeBureauGoals } from './goals-composition';
import type { CatalogRunRecoveryLoad } from './runtime-composition';
import { CHECK, goalRequest } from './testing/goal-fixtures.test-support';

interface FakeWorkflow {
  readonly type: string;
  readonly input: unknown;
  readonly status: string;
}

/** An engine over a table of workflows, recording every call that would change one. */
function fakeEngine(workflows: Record<string, FakeWorkflow>) {
  const calls: string[] = [];
  const engine = {
    get: (id: string) => {
      const workflow = workflows[id];
      return Promise.resolve(workflow === undefined ? null : { id, ...workflow });
    },
    start: (_type: string, _input: unknown, options?: { id?: string }) => {
      calls.push(`start:${options?.id}`);
      return Promise.resolve({});
    },
    signal: (id: string) => {
      calls.push(`signal:${id}`);
      return Promise.resolve();
    },
    cancel: (id: string) => {
      calls.push(`cancel:${id}`);
      return Promise.resolve();
    },
    resume: (id: string) => {
      calls.push(`resume:${id}`);
      return Promise.resolve();
    },
    getFinalizerStatus: () => Promise.resolve({ status: 'succeeded' }),
    getHandle: () => ({}),
  } as unknown as GoalEngine;
  return { engine, calls };
}

const marked = (goalRunId: string, attemptIndex: number): CatalogRunRecoveryLoad => ({
  status: 'found',
  record: {
    schemaVersion: 1,
    agentName: 'worker',
    definitionRevision: 1,
    input: 'work',
    goalAttempt: { goalRunId, attemptIndex },
  },
});
const unmarked: CatalogRunRecoveryLoad = {
  status: 'found',
  record: { schemaVersion: 1, agentName: 'worker', definitionRevision: 1, input: 'work' },
};
const missing: CatalogRunRecoveryLoad = { status: 'missing' };

/** The goal's own agent and principal, as the goal record names them. */
const goalOwner = () =>
  Promise.resolve({ agentName: 'worker', principal: undefined, maximumAttempts: 10 });

const ownController: FakeWorkflow = {
  type: GOAL_WORKFLOW_TYPE,
  input: { goalRunId: 'g1' },
  status: 'running',
};
const foreignControllers: Record<string, FakeWorkflow> = {
  'an agent run': { type: 'agentRun', input: { runId: 'goal:g1' }, status: 'running' },
  "another goal's controller": {
    type: GOAL_WORKFLOW_TYPE,
    input: { goalRunId: 'g2' },
    status: 'running',
  },
  'a goal workflow with no input': { type: GOAL_WORKFLOW_TYPE, input: null, status: 'running' },
};

describe('createOwnedGoalEngine', () => {
  it("passes the goal's own controller through untouched", async () => {
    const { engine, calls } = fakeEngine({ 'goal:g1': ownController });
    const owned = createOwnedGoalEngine(engine, () => Promise.resolve(missing), goalOwner);

    const own = await owned.get('goal:g1');
    expect(own?.status).toBe('running');
    await owned.signal('goal:g1', 'cancel', {});
    await owned.cancel('goal:g1');
    await owned.resume('goal:g1');
    expect(calls).toEqual(['signal:goal:g1', 'cancel:goal:g1', 'resume:goal:g1']);
  });

  it.each(Object.entries(foreignControllers))(
    'hides %s at the controller id, and refuses to signal, resume, cancel, or replace it',
    async (_label, workflow) => {
      const { engine, calls } = fakeEngine({ 'goal:g1': workflow });
      const owned = createOwnedGoalEngine(engine, () => Promise.resolve(missing), goalOwner);

      expect(await owned.get('goal:g1')).toBeNull();
      expect(await owned.getFinalizerStatus('goal:g1')).toBeNull();
      for (const act of [
        () => owned.signal('goal:g1', 'cancel', {}),
        () => owned.cancel('goal:g1'),
        () => owned.resume('goal:g1'),
        () =>
          owned.start(GOAL_WORKFLOW_TYPE, { goalRunId: 'g1' }, {
            id: 'goal:g1',
            onTerminalConflict: 'start-new',
          } as never),
      ]) {
        expect(
          await act().then(
            () => undefined,
            (error: unknown) => error,
          ),
        ).toBeInstanceOf(GoalOwnershipError);
      }
      expect(calls).toEqual([]);
    },
  );

  it('starts a controller where nothing holds the id', async () => {
    const { engine, calls } = fakeEngine({});
    const owned = createOwnedGoalEngine(engine, () => Promise.resolve(missing), goalOwner);
    await owned.start(GOAL_WORKFLOW_TYPE, { goalRunId: 'g1' }, { id: 'goal:g1' });
    expect(calls).toEqual(['start:goal:g1']);
  });

  it('shows a goal-named run only when a goal marked it as its own', async () => {
    const id = goalAttemptRunId('g1', 0);
    const { engine } = fakeEngine({
      [id]: { type: 'agentRun', input: {}, status: 'running' },
      'ordinary-run': { type: 'agentRun', input: {}, status: 'running' },
    });
    const records: Record<string, CatalogRunRecoveryLoad> = {};
    const owned = createOwnedGoalEngine(
      engine,
      (runId) => Promise.resolve(records[runId] ?? missing),
      goalOwner,
    );

    expect(await owned.get(id)).toBeNull();
    records[id] = unmarked;
    expect(await owned.get(id)).toBeNull();
    // A marker for another attempt does not reproduce this id.
    records[id] = marked('g1', 3);
    expect(await owned.get(id)).toBeNull();
    records[id] = marked('g1', 0);
    const visible = await owned.get(id);
    expect(visible?.status).toBe('running');
    // Ids outside the goal namespaces are none of the goal's business.
    const ordinary = await owned.get('ordinary-run');
    expect(ordinary?.status).toBe('running');
  });
});

describe('an unreadable run record is unknown, never foreign or absent', () => {
  it('makes the owned engine fail the read, then show the run once the fault clears', async () => {
    const id = goalAttemptRunId('g1', 0);
    const { engine } = fakeEngine({ [id]: { type: 'agentRun', input: {}, status: 'running' } });
    let faults = 1;
    const owned = createOwnedGoalEngine(
      engine,
      () => {
        if (faults > 0) {
          faults -= 1;
          return Promise.resolve({ status: 'read-error', error: new Error('storage is down') });
        }
        return Promise.resolve(marked('g1', 0));
      },
      goalOwner,
    );

    const failure = await owned.get(id).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GoalOwnershipUnknownError);
    const visible = await owned.get(id);
    expect(visible?.status).toBe('running');
  });

  it('makes the canceller report a failure without cancelling, then cancel once the fault clears', async () => {
    const stopped: string[] = [];
    let faults = 1;
    const cancel = createOwnedRunCanceller(
      (runId) => {
        stopped.push(runId);
        return Promise.resolve({ status: 'requested' });
      },
      () => {
        if (faults > 0) {
          faults -= 1;
          return Promise.resolve({ status: 'read-error', error: new Error('storage is down') });
        }
        return Promise.resolve(marked('g1', 0));
      },
      goalOwner,
    );
    const id = goalAttemptRunId('g1', 0);

    const first = await cancel(id);
    expect(first).toMatchObject({ status: 'failed' });
    expect((first as { error: unknown }).error).toBeInstanceOf(GoalOwnershipUnknownError);
    expect(stopped).toEqual([]);
    expect(await cancel(id)).toEqual({ status: 'requested' });
    expect(stopped).toEqual([id]);
  });

  it('makes verifyAttemptRun throw instead of answering absent or foreign', async () => {
    const { engine } = fakeEngine({});
    const expected = {
      goalRunId: 'g1',
      attemptIndex: 0,
      agentName: 'worker',
      principal: undefined,
      maximumAttempts: 10,
    };
    const unreadable = (): Promise<CatalogRunRecoveryLoad> =>
      Promise.resolve({ status: 'read-error', error: new Error('storage is down') });
    const failure = await verifyAttemptRun(
      { engine, readRunRecord: unreadable },
      expected,
      'goal-g1-a0',
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GoalOwnershipUnknownError);
  });
});

describe('a present but invalid run record is corrupt, never absent', () => {
  const corrupt = (): Promise<CatalogRunRecoveryLoad> => Promise.resolve({ status: 'corrupt' });
  const id = goalAttemptRunId('g1', 0);

  it('makes the owned engine throw a typed, non-retryable error instead of hiding the run', async () => {
    const { engine } = fakeEngine({ [id]: { type: 'agentRun', input: {}, status: 'running' } });
    const owned = createOwnedGoalEngine(engine, corrupt, goalOwner);
    const failure = await owned.get(id).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GoalCorruptOwnershipRecordError);
    expect(failure).toBeInstanceOf(GoalOwnershipError);
    expect((failure as Error).message).toContain('corrupt-ownership-record');
  });

  it('makes the canceller fail with the typed error and cancel nothing', async () => {
    const stopped: string[] = [];
    const cancel = createOwnedRunCanceller(
      (runId) => {
        stopped.push(runId);
        return Promise.resolve({ status: 'requested' });
      },
      corrupt,
      goalOwner,
    );
    const outcome = await cancel(id);
    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { error: unknown }).error).toBeInstanceOf(GoalCorruptOwnershipRecordError);
    expect(stopped).toEqual([]);
  });

  it('makes verifyAttemptRun answer corrupt, even when no workflow exists to contradict it', async () => {
    const { engine } = fakeEngine({});
    const expected = {
      goalRunId: 'g1',
      attemptIndex: 0,
      agentName: 'worker',
      principal: undefined,
      maximumAttempts: 10,
    };
    const outcome = await verifyAttemptRun({ engine, readRunRecord: corrupt }, expected, id);
    expect(outcome.status).toBe('corrupt');
    expect((outcome as { detail: string }).detail).toContain('corrupt-ownership-record');
  });
});

describe('createOwnedRunCanceller', () => {
  it('stops a run the goal marked as its own, and leaves any other alone', async () => {
    const stopped: string[] = [];
    const id = goalAttemptRunId('g1', 0);
    const records: Record<string, CatalogRunRecoveryLoad> = { [id]: marked('g1', 0) };
    const cancel = createOwnedRunCanceller(
      (runId) => {
        stopped.push(runId);
        return Promise.resolve({ status: 'requested' });
      },
      (runId) => Promise.resolve(records[runId] ?? missing),
      goalOwner,
    );

    expect(await cancel(id)).toEqual({ status: 'requested' });
    for (const foreign of [unmarked, marked('g2', 0), marked('g1', 1), missing]) {
      records[id] = foreign;
      expect(await cancel(id)).toEqual({ status: 'not-found' });
    }
    expect(stopped).toEqual([id]);
  });

  it('reports a record it could not read as a failure rather than guessing', async () => {
    const cancel = createOwnedRunCanceller(
      () => Promise.reject(new Error('unreachable')),
      () => Promise.resolve({ status: 'read-error', error: new Error('storage is down') }),
      goalOwner,
    );
    expect(await cancel('goal-g1-a0')).toMatchObject({ status: 'failed' });
  });
});

describe("a run is the goal's only when its recovery record names the goal's own agent and principal", () => {
  const id = goalAttemptRunId('g1', 0);
  const recordFor = (overrides: {
    agentName?: string;
    principal?: string;
  }): CatalogRunRecoveryLoad => ({
    status: 'found',
    record: {
      schemaVersion: 1,
      agentName: overrides.agentName ?? 'worker',
      definitionRevision: 1,
      input: 'work',
      ...(overrides.principal === undefined ? {} : { principal: overrides.principal }),
      goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
    },
  });
  const ownedBy = (agentName: string, principal: string | undefined) => () =>
    Promise.resolve({ agentName, principal, maximumAttempts: 10 });
  const impostors: Array<[string, CatalogRunRecoveryLoad]> = [
    ['another agent', recordFor({ agentName: 'intruder' })],
    ['another principal', recordFor({ principal: 'mallory' })],
    ['a principal where the goal has none', recordFor({ principal: 'alice' })],
  ];

  for (const [name, load] of impostors) {
    it(`hides a goal-named run started by ${name} from the owned engine`, async () => {
      const { engine } = fakeEngine({ [id]: { type: 'agentRun', input: {}, status: 'running' } });
      const owned = createOwnedGoalEngine(engine, () => Promise.resolve(load), goalOwner);
      expect(await owned.get(id)).toBeNull();
    });

    it(`does not cancel a goal-named run started by ${name}`, async () => {
      const stopped: string[] = [];
      const cancel = createOwnedRunCanceller(
        (runId) => {
          stopped.push(runId);
          return Promise.resolve({ status: 'requested' });
        },
        () => Promise.resolve(load),
        goalOwner,
      );
      expect(await cancel(id)).toEqual({ status: 'not-found' });
      expect(stopped).toEqual([]);
    });
  }

  it("shows and cancels the run when agent and principal both match the goal's", async () => {
    const stopped: string[] = [];
    const load = recordFor({ principal: 'alice' });
    const { engine } = fakeEngine({ [id]: { type: 'agentRun', input: {}, status: 'running' } });
    const owner = ownedBy('worker', 'alice');
    const owned = createOwnedGoalEngine(engine, () => Promise.resolve(load), owner);
    const cancel = createOwnedRunCanceller(
      (runId) => {
        stopped.push(runId);
        return Promise.resolve({ status: 'requested' });
      },
      () => Promise.resolve(load),
      owner,
    );
    const visible = await owned.get(id);
    expect(visible?.status).toBe('running');
    expect(await cancel(id)).toEqual({ status: 'requested' });
    expect(stopped).toEqual([id]);
  });

  it('treats a run as foreign when the goal that marked it cannot be found', async () => {
    const { engine } = fakeEngine({ [id]: { type: 'agentRun', input: {}, status: 'running' } });
    const unknownGoal = () => Promise.resolve(undefined);
    const owned = createOwnedGoalEngine(engine, () => Promise.resolve(recordFor({})), unknownGoal);
    expect(await owned.get(id)).toBeNull();
    const cancel = createOwnedRunCanceller(
      () => Promise.reject(new Error('unreachable')),
      () => Promise.resolve(recordFor({})),
      unknownGoal,
    );
    expect(await cancel(id)).toEqual({ status: 'not-found' });
  });

  it('reports a goal record that cannot be read as a failure, not as foreign', async () => {
    const { engine } = fakeEngine({ [id]: { type: 'agentRun', input: {}, status: 'running' } });
    const broken = () => Promise.reject(new Error('storage is down'));
    const owned = createOwnedGoalEngine(engine, () => Promise.resolve(recordFor({})), broken);
    const failure = await owned.get(id).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failure as Error).message).toBe('storage is down');
    const cancel = createOwnedRunCanceller(
      () => Promise.reject(new Error('unreachable')),
      () => Promise.resolve(recordFor({})),
      broken,
    );
    expect(await cancel(id)).toMatchObject({ status: 'failed' });
  });
});

describe('the goal control plane over a foreign controller workflow', () => {
  function compose(workflows: Record<string, FakeWorkflow>) {
    const { engine, calls } = fakeEngine(workflows);
    const stopped: string[] = [];
    const composition = composeBureauGoals({
      catalog: createGoalValidatorCatalog([
        {
          identity: CHECK,
          determinism: 'deterministic',
          validate: () => Promise.resolve({ kind: 'pass', evidence: [] }),
        } as never,
      ]),
      kv: undefined,
      sessionStore: undefined,
      resolveFreshAttemptSource: undefined,
      runtimeServices: createManualRuntimeServices(),
      host: createGoalWorkflowHost(),
      fenceClaim: () => Promise.resolve('fenced'),
      fenceHost: createGoalAttemptFenceHost(),
      getDurable: () => ({ engine: engine as never, checkpointStore: {} as never }),
      planAgent: () => ({ durable: true, agentVersion: '1' }),
      startAttemptRun: () => {
        throw new Error('no attempt run was expected');
      },
      cancelRun: (runId) => {
        stopped.push(runId);
        return Promise.resolve({ status: 'requested' });
      },
      readRunRecord: () => Promise.resolve(missing),
      cleanupWorkflow: () => Promise.resolve({ status: 'not-required' }),
      isClosing: () => false,
      diagnose: () => {},
    });
    return { composition, calls, stopped };
  }

  it.each(Object.entries(foreignControllers))(
    'create() starts no controller over %s, and cancel() and recover() never act on it',
    async (_label, workflow) => {
      const { composition, calls } = compose({ 'goal:g1': workflow });

      const created = await composition.goals.create(goalRequest({ goalRunId: 'g1' }));
      expect(created).toMatchObject({
        outcome: 'created',
        controller: { status: 'start-failed' },
      });
      expect(calls).toEqual([]);

      const recovered = await composition.goals.recover('g1');
      expect(recovered.failures).toEqual([]);
      expect(recovered.goals).toHaveLength(1);
      expect(recovered.goals[0]).toMatchObject({ goalRunId: 'g1', outcome: 'unrecoverable' });
      expect(recovered.goals[0]?.detail).toContain('goal:g1');

      await composition.goals.cancel('g1');
      expect(calls).toEqual([]);
    },
  );
});

describe("a run is the goal's only when its attempt index is below the goal's attempt bound", () => {
  const MAXIMUM_ATTEMPTS = 3;
  const owner = () =>
    Promise.resolve({
      agentName: 'worker',
      principal: undefined,
      maximumAttempts: MAXIMUM_ATTEMPTS,
    });

  it.each([
    ['the last index the goal can open', MAXIMUM_ATTEMPTS - 1, true],
    ['an index at the bound', MAXIMUM_ATTEMPTS, false],
    ['an index far past the bound', MAXIMUM_ATTEMPTS + 7, false],
  ])('treats a self-reproducing marker for %s accordingly', async (_name, attemptIndex, owned) => {
    const id = goalAttemptRunId('g1', attemptIndex);
    const { engine } = fakeEngine({ [id]: { type: 'agentRun', input: {}, status: 'running' } });
    const stopped: string[] = [];
    const ownedEngine = createOwnedGoalEngine(
      engine,
      () => Promise.resolve(marked('g1', attemptIndex)),
      owner,
    );
    const cancel = createOwnedRunCanceller(
      (runId) => {
        stopped.push(runId);
        return Promise.resolve({ status: 'requested' });
      },
      () => Promise.resolve(marked('g1', attemptIndex)),
      owner,
    );
    expect((await ownedEngine.get(id)) !== null).toBe(owned);
    expect(await cancel(id)).toEqual(owned ? { status: 'requested' } : { status: 'not-found' });
    expect(stopped).toEqual(owned ? [id] : []);
  });

  it("refuses to verify an attempt run at an index past the bound as the goal's own", async () => {
    const { engine } = fakeEngine({});
    const id = goalAttemptRunId('g1', MAXIMUM_ATTEMPTS);
    const outcome = await verifyAttemptRun(
      { engine, readRunRecord: () => Promise.resolve(marked('g1', MAXIMUM_ATTEMPTS)) },
      {
        goalRunId: 'g1',
        attemptIndex: MAXIMUM_ATTEMPTS,
        agentName: 'worker',
        principal: undefined,
        maximumAttempts: MAXIMUM_ATTEMPTS,
      },
      id,
    );
    expect(outcome.status).toBe('foreign');
  });
});

describe("a run is the goal's only when its attempt index is a non-negative safe integer", () => {
  const owner = { agentName: 'worker', principal: undefined, maximumAttempts: 3 };
  const record = (attemptIndex: number) => {
    const load = marked('g1', attemptIndex);
    if (load.status !== 'found') throw new Error('unreachable');
    return load.record;
  };

  it.each([
    ['a negative integer', -1],
    ['a fraction', 0.5],
    ['NaN', Number.NaN],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('does not own a run whose marker names %s below the bound', (_name, attemptIndex) => {
    const id = goalAttemptRunId('g1', attemptIndex);
    expect(isGoalOwnedRunRecord(record(attemptIndex), id, owner)).toBe(false);
  });

  it('still owns a run at index zero', () => {
    expect(isGoalOwnedRunRecord(record(0), goalAttemptRunId('g1', 0), owner)).toBe(true);
  });
});
