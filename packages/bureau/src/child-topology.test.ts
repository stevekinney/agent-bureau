/**
 * COR-772 — unit tests for Bureau's parent-child topology controller, driven
 * through a real in-memory record store and fakes for the durable engine and
 * the catalog dispatch. The cross-process crash-and-recovery proof over a
 * real engine lives in `bureau-children.test.ts`.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  type AgentRun,
  type ChildSignalPort,
  defineChildSignals,
  type DelegationGrant,
  revokeDelegationGrant,
  verifyDelegationGrant,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore, type WorkflowState } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  type BureauChildDelegationOptions,
  type ChildAuditEntry,
  type ChildTopologyParent,
  type ChildTopologyStart,
  createChildTopology,
} from './child-topology';
import {
  type BureauChildRecord,
  type ChildTopologyStore,
  createChildTopologyStore,
} from './child-topology-store';
import { throwingRejectionOf } from './testing/promise-outcome.test-support.ts';
import type { BureauDiagnostic, CancelDurableRunOutcome } from './types';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeRun {
  readonly run: AgentRun<unknown, boolean>;
  readonly abortReasons: (string | undefined)[];
  complete(content?: string): void;
  finish(finishReason: string, error?: unknown): void;
  reject(error: unknown): void;
}

/**
 * A run that settles as soon as it is aborted — or, when `slowToAbort`, one
 * that only records the abort and keeps running until the test honours it
 * with `finish('aborted')`, as a run with a tool mid-flight does.
 */
function createFakeRun(slowToAbort = false): FakeRun {
  let resolveResult!: (value: unknown) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const abortReasons: (string | undefined)[] = [];
  const run = {
    result: () => result,
    abort(reason?: string) {
      abortReasons.push(reason);
      if (!slowToAbort) resolveResult({ finishReason: 'aborted', content: '' });
    },
  } as unknown as AgentRun<unknown, boolean>;
  return {
    run,
    abortReasons,
    complete: (content = 'done') => resolveResult({ finishReason: 'stop-condition', content }),
    finish: (finishReason, error) =>
      resolveResult({ finishReason, content: '', ...(error === undefined ? {} : { error }) }),
    reject: (error) => rejectResult(error),
  };
}

interface Deferred {
  readonly promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

function createDeferred(): Deferred {
  let settle!: (value: unknown) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // A workflow handle nobody is watching may reject; that is not a test failure.
  promise.catch(() => {});
  return { promise, resolve: settle, reject: fail };
}

function workflowState(
  id: string,
  status: WorkflowState['status'],
  extra: Partial<WorkflowState> = {},
): WorkflowState {
  return { id, type: 'agentRun', status, input: {}, ...extra } as WorkflowState;
}

function createFakeEngine() {
  const states = new Map<string, WorkflowState>();
  const handles = new Map<string, Deferred>();
  const handleFor = (id: string): Deferred => {
    let handle = handles.get(id);
    if (!handle) {
      handle = createDeferred();
      handles.set(id, handle);
    }
    return handle;
  };
  return {
    states,
    handleFor,
    get: async (id: string) => states.get(id) ?? null,
    getHandle: (id: string) => ({ result: () => handleFor(id).promise }),
  };
}

type FakeEngine = ReturnType<typeof createFakeEngine>;

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed-out']);

function engineCancel(engine: FakeEngine) {
  return async (workflowId: string): Promise<CancelDurableRunOutcome> => {
    const state = engine.states.get(workflowId);
    if (!state) return { status: 'not-found' };
    if (TERMINAL.has(state.status)) return { status: 'already-terminal' };
    engine.states.set(workflowId, { ...state, status: 'cancelled' });
    engine.handleFor(workflowId).reject(new Error('cancelled'));
    return { status: 'requested' };
  };
}

/** `engineCancel`, except that the first cancellation of `workflowId` fails. */
function wedgedOnce(engine: FakeEngine, workflowId: string) {
  const cancel = engineCancel(engine);
  let wedged = true;
  return async (id: string): Promise<CancelDurableRunOutcome> => {
    if (id !== workflowId || !wedged) return cancel(id);
    wedged = false;
    return { status: 'failed', error: new Error('engine wedged') };
  };
}

const SECRET = 'topology-secret';
const signals = defineChildSignals({
  signals: { proceed: z.object({ step: z.number() }) },
  events: {},
});

interface FixtureOptions {
  readonly parents?: Record<string, ChildTopologyParent>;
  readonly plans?: Record<string, { durable: boolean; agentVersion: string }>;
  readonly delegation?: BureauChildDelegationOptions;
  readonly engine?: FakeEngine | null;
  readonly cancelDurable?: (workflowId: string) => Promise<CancelDurableRunOutcome>;
  readonly store?: ChildTopologyStore;
  readonly startChild?: (start: ChildTopologyStart) => AgentRun<unknown, boolean>;
  readonly recordAudit?: (entry: ChildAuditEntry) => Promise<void>;
  readonly isKnownRun?: (runId: string) => Promise<boolean>;
  /** Children whose runs take a while to honour an abort. */
  readonly slowToAbort?: readonly string[];
}

function createFixture(options: FixtureOptions = {}) {
  const runtime = createManualRuntimeServices();
  const kv = textValueStore(new MemoryStorage());
  const store = options.store ?? createChildTopologyStore(kv);
  const audits: ChildAuditEntry[] = [];
  const diagnostics: BureauDiagnostic[] = [];
  const starts: ChildTopologyStart[] = [];
  const runs = new Map<string, FakeRun>();
  const engine = options.engine === null ? undefined : (options.engine ?? createFakeEngine());
  const parents: Record<string, ChildTopologyParent> = options.parents ?? {
    'parent-1': { agentName: 'planner', live: true },
  };
  const plans = options.plans ?? {
    worker: { durable: true, agentVersion: '3' },
    local: { durable: false, agentVersion: '1' },
  };
  const topology = createChildTopology({
    store,
    runtime,
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
    recordAudit:
      options.recordAudit ??
      (async (entry) => {
        audits.push(entry);
      }),
    resolveParent: async (parentRunId) => parents[parentRunId],
    isKnownRun: options.isKnownRun ?? (async () => false),
    planChild: (agentName) => plans[agentName],
    startChild:
      options.startChild ??
      ((start) => {
        starts.push(start);
        const fake = createFakeRun(options.slowToAbort?.includes(start.childRunId));
        runs.set(start.childRunId, fake);
        return fake.run;
      }),
    getEngine: () => engine,
    cancelDurable:
      options.cancelDurable ??
      (engine ? engineCancel(engine) : async () => ({ status: 'unsupported-capability' })),
    validateInput: (input) => {
      if (input === 42) throw new Error('bad input');
    },
    createBadRequest: (message) => new Error(`BAD_REQUEST: ${message}`),
    signalContracts: { worker: signals },
    ...(options.delegation === undefined ? {} : { delegation: options.delegation }),
  });
  return { topology, store, kv, runtime, audits, diagnostics, starts, runs, engine, parents };
}

async function statusOf(
  store: ChildTopologyStore,
  childRunId: string,
): Promise<BureauChildRecord['status'] | undefined> {
  const record = await store.get(childRunId);
  return record?.status;
}

/** Resolves once `childRunId`'s settlement — including its audit entry and ledger release — has landed. */
async function settledChild(
  fixture: ReturnType<typeof createFixture>,
  childRunId: string,
  parentRunId = 'parent-1',
): Promise<void> {
  await fixture.topology.children.wait({ parentRunId, childRunId });
}

function auditTypes(audits: readonly ChildAuditEntry[]): string[] {
  return audits.map((entry) => entry.type);
}

async function startedChild(
  fixture: ReturnType<typeof createFixture>,
  request: Partial<
    Parameters<ReturnType<typeof createFixture>['topology']['children']['dispatch']>[0]
  > = {},
): Promise<BureauChildRecord> {
  const outcome = await fixture.topology.children.dispatch({
    parentRunId: 'parent-1',
    agentName: 'worker',
    input: 'do the work',
    ...request,
  });
  if (outcome.outcome !== 'started') throw new Error(`expected started, got ${outcome.outcome}`);
  return outcome.child;
}

function runningRecord(overrides: Partial<BureauChildRecord> = {}): BureauChildRecord {
  return {
    schemaVersion: 1,
    parentRunId: 'parent-1',
    childRunId: 'child-a',
    parentAgentName: 'planner',
    childAgentName: 'worker',
    status: 'running',
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    recoveries: 0,
    workflow: {
      kind: 'durable',
      workflowType: 'agentRun',
      workflowId: overrides.childRunId ?? 'child-a',
    },
    parentCancellation: 'cascade',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe('children.dispatch', () => {
  it('records the durable relationship before starting the child, with no shared abort signal', async () => {
    const fixture = createFixture({
      parents: { 'parent-1': { agentName: 'planner', principal: 'owner', live: true } },
    });

    const outcome = await fixture.topology.children.dispatch({
      parentRunId: 'parent-1',
      agentName: 'worker',
      input: 'do the work',
      childRunId: 'child-a',
    });

    expect(outcome).toEqual({
      outcome: 'started',
      child: {
        schemaVersion: 1,
        parentRunId: 'parent-1',
        childRunId: 'child-a',
        parentAgentName: 'planner',
        childAgentName: 'worker',
        status: 'running',
        revision: 1,
        createdAt: fixture.runtime.clock.now(),
        updatedAt: fixture.runtime.clock.now(),
        recoveries: 0,
        workflow: { kind: 'durable', workflowType: 'agentRun', workflowId: 'child-a' },
        parentCancellation: 'cascade',
        principal: 'owner',
      },
    });
    expect(await fixture.store.get('child-a')).toEqual(
      outcome.outcome === 'started' ? outcome.child : undefined,
    );
    const [start] = fixture.starts;
    expect(start?.context.childCorrelation).toEqual({
      parentAgentName: 'planner',
      parentRunId: 'parent-1',
      childAgentName: 'worker',
      childRunId: 'child-a',
    });
    expect(start?.context.parentSignals?.childRunId).toBe('child-a');
    expect(start?.principal).toBe('owner');
    expect(start && 'signal' in start.context).toBe(false);
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        runId: 'child-a',
        type: 'child.started',
        principal: 'owner',
        dedupeKey: 'child.started:child-a',
      }),
    ]);
  });

  it('records a process-local child with no workflow to reattach and no signal port', async () => {
    const fixture = createFixture();

    const child = await startedChild(fixture, { agentName: 'local', parentCancellation: 'detach' });

    expect(child.workflow).toEqual({ kind: 'process-local' });
    expect(child.parentCancellation).toBe('detach');
    expect(child.childRunId).toMatch(/child-run/);
    expect(fixture.starts[0]?.context.parentSignals).toBeUndefined();
  });

  it('ignores authority without delegation: nothing is validated, granted, or bounded', async () => {
    const fixture = createFixture({
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'child-a': { agentName: 'worker', live: true },
      },
    });

    // With delegation this asks for no descendants at all, and its time to
    // live would be a BAD_REQUEST. Without it, the request is dropped silently.
    const bounded = await fixture.topology.children.dispatch({
      parentRunId: 'parent-1',
      agentName: 'worker',
      input: 'x',
      childRunId: 'child-a',
      authority: { depth: 0, budget: { concurrentChildren: 0 }, timeToLiveMilliseconds: -1 },
    });

    const record = await fixture.store.get('child-a');
    if (!record) throw new Error('child-a was not recorded');
    expect(bounded).toEqual({ outcome: 'started', child: record });
    expect(record.grantId).toBeUndefined();
    // So the child's own dispatches are limited by nothing it was dispatched with.
    for (const childRunId of ['grandchild-a', 'grandchild-b']) {
      expect(
        await fixture.topology.children.dispatch({
          parentRunId: 'child-a',
          agentName: 'worker',
          input: 'y',
          childRunId,
        }),
      ).toMatchObject({ outcome: 'started', child: { parentRunId: 'child-a' } });
    }
    expect(auditTypes(fixture.audits)).toEqual(['child.started', 'child.started', 'child.started']);
  });

  it('rejects an unknown agent, and hides an unknown or unauthorized parent as not-found', async () => {
    const fixture = createFixture({
      parents: { 'parent-1': { agentName: 'planner', principal: 'owner', live: true } },
    });
    const { dispatch } = fixture.topology.children;

    expect(
      await dispatch({ parentRunId: 'parent-1', agentName: 'nobody', input: 'x' }),
    ).toMatchObject({ outcome: 'rejected', code: 'unknown-agent' });
    expect(await dispatch({ parentRunId: 'ghost', agentName: 'worker', input: 'x' })).toEqual({
      outcome: 'not-found',
    });
    expect(
      await dispatch({
        parentRunId: 'parent-1',
        agentName: 'worker',
        input: 'x',
        principal: 'mallory',
      }),
    ).toEqual({ outcome: 'not-found' });
    expect(fixture.starts).toHaveLength(0);
  });

  it('refuses a child for a parent that is no longer running', async () => {
    const fixture = createFixture({ parents: { done: { agentName: 'planner', live: false } } });

    expect(
      await fixture.topology.children.dispatch({
        parentRunId: 'done',
        agentName: 'worker',
        input: 'x',
      }),
    ).toMatchObject({ outcome: 'rejected', code: 'parent-terminal' });
  });

  it('treats a repeated registration as a duplicate and never starts a second child', async () => {
    const fixture = createFixture();
    const first = await startedChild(fixture, { childRunId: 'child-a' });

    const second = await fixture.topology.children.dispatch({
      parentRunId: 'parent-1',
      agentName: 'worker',
      input: 'do the work again',
      childRunId: 'child-a',
    });

    expect(second).toEqual({ outcome: 'duplicate', child: first });
    expect(fixture.starts).toHaveLength(1);
  });

  it('refuses a child identifier another parent already owns without revealing its record', async () => {
    const fixture = createFixture({
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'parent-2': { agentName: 'planner', live: true },
      },
    });
    await startedChild(fixture, { childRunId: 'child-a' });

    const outcome = await fixture.topology.children.dispatch({
      parentRunId: 'parent-2',
      agentName: 'worker',
      input: 'x',
      childRunId: 'child-a',
    });

    expect(outcome).toMatchObject({ outcome: 'rejected', code: 'child-run-id-conflict' });
    expect('child' in outcome).toBe(false);
  });

  it.each(['goal:g1', 'goal-g1-a0', 'bureau-goal-audit:g1'])(
    'refuses the identifier %s, which durable goals own, before anything is reserved or recorded',
    async (childRunId) => {
      const fixture = createFixture({ delegation: { secret: SECRET } });

      const outcome = await fixture.topology.children.dispatch({
        parentRunId: 'parent-1',
        agentName: 'worker',
        input: 'x',
        childRunId,
        principal: 'mallory',
      });

      expect(outcome).toMatchObject({ outcome: 'rejected', code: 'reserved-child-run-id' });
      expect((outcome as { reason: string }).reason).toContain('reserved-identifier');
      expect(await fixture.store.get(childRunId)).toBeUndefined();
      expect(await fixture.store.listAll()).toEqual([]);
      expect(fixture.starts).toEqual([]);
      expect(fixture.audits).toEqual([]);
    },
  );

  it('leaves an identifier that only resembles a goal prefix free', async () => {
    const fixture = createFixture();

    const outcome = await startedChild(fixture, { childRunId: 'goalpost' });

    expect(outcome.childRunId).toBe('goalpost');
  });

  it('refuses a child identifier that already names another run, before anything is reserved or recorded', async () => {
    const fixture = createFixture({
      delegation: { secret: SECRET },
      isKnownRun: async (runId) => runId === 'someone-elses-run',
    });

    const outcome = await fixture.topology.children.dispatch({
      parentRunId: 'parent-1',
      agentName: 'worker',
      input: 'x',
      childRunId: 'someone-elses-run',
      principal: 'mallory',
    });

    expect(outcome).toEqual({
      outcome: 'rejected',
      code: 'child-run-id-conflict',
      reason: 'Child run identifier "someone-elses-run" is already in use',
    });
    expect(await fixture.store.get('someone-elses-run')).toBeUndefined();
    expect(await fixture.store.listAll()).toEqual([]);
    expect(fixture.starts).toEqual([]);
    expect(fixture.audits).toEqual([]);
  });

  it('reads a run another process registered as this child meanwhile as a duplicate', async () => {
    const store = createChildTopologyStore(textValueStore(new MemoryStorage()));
    const theirs = runningRecord({ childRunId: 'child-a' });
    const fixture = createFixture({
      store,
      // The other process registered and started the child after this one looked.
      isKnownRun: async (runId) => {
        await store.register(theirs);
        return runId === 'child-a';
      },
    });

    expect(
      await fixture.topology.children.dispatch({
        parentRunId: 'parent-1',
        agentName: 'worker',
        input: 'x',
        childRunId: 'child-a',
      }),
    ).toEqual({ outcome: 'duplicate', child: theirs });
    expect(fixture.starts).toEqual([]);
  });

  it('reports a registration race as a duplicate, or as a conflict when the winner is unreadable', async () => {
    for (const winnerReadable of [true, false]) {
      const store = createChildTopologyStore(textValueStore(new MemoryStorage()));
      const racing: ChildTopologyStore = {
        ...store,
        async register(record) {
          await store.register(record);
          const registration = await store.register(record);
          return winnerReadable || registration.status !== 'duplicate'
            ? registration
            : { status: 'duplicate' };
        },
      };
      const fixture = createFixture({ store: racing });

      const outcome = await fixture.topology.children.dispatch({
        parentRunId: 'parent-1',
        agentName: 'worker',
        input: 'x',
        childRunId: 'child-a',
      });

      expect(outcome.outcome).toBe(winnerReadable ? 'duplicate' : 'rejected');
      expect(fixture.starts).toHaveLength(0);
    }
  });

  it('records a child whose start throws as failed', async () => {
    const fixture = createFixture({
      startChild: () => {
        throw new Error('bureau is disposed');
      },
    });

    const outcome = await fixture.topology.children.dispatch({
      parentRunId: 'parent-1',
      agentName: 'worker',
      input: 'x',
      childRunId: 'child-a',
    });

    expect(outcome).toEqual({
      outcome: 'rejected',
      code: 'start-failed',
      reason: 'bureau is disposed',
    });
    expect(await fixture.store.get('child-a')).toMatchObject({
      status: 'failed',
      outcome: { reason: 'bureau is disposed' },
    });
    expect(auditTypes(fixture.audits)).toEqual(['child.started', 'child.failed']);

    // The failed record keeps its identifier, so a retry reads as a duplicate.
    const retry = await fixture.topology.children.dispatch({
      parentRunId: 'parent-1',
      agentName: 'worker',
      input: 'x',
      childRunId: 'child-a',
    });

    expect(retry).toMatchObject({
      outcome: 'duplicate',
      child: { childRunId: 'child-a', status: 'failed' },
    });
    expect(auditTypes(fixture.audits)).toEqual(['child.started', 'child.failed']);
  });

  it.each([
    ['an empty parent', { parentRunId: '' }],
    ['an empty agent', { agentName: '' }],
    ['an empty child identifier', { childRunId: '' }],
    ['an empty principal', { principal: '' }],
    ['an unknown cancellation policy', { parentCancellation: 'ignore' }],
    ['malformed input', { input: 42 }],
  ])('rejects %s as a bad request', async (_label, patch) => {
    const fixture = createFixture();

    expect(
      await throwingRejectionOf(
        fixture.topology.children.dispatch({
          parentRunId: 'parent-1',
          agentName: 'worker',
          input: 'x',
          ...(patch as object),
        }),
      ),
    ).toThrow(/BAD_REQUEST|bad input/);
  });
});

// ---------------------------------------------------------------------------
// Settlement, wait, and the audit trail
// ---------------------------------------------------------------------------

describe('child settlement', () => {
  it('records completion with its outcome, audits it, and wakes waiters', async () => {
    const fixture = createFixture();
    const child = await startedChild(fixture);
    const waiting = fixture.topology.children.wait({
      parentRunId: 'parent-1',
      childRunId: child.childRunId,
    });

    fixture.runs.get(child.childRunId)?.complete('the answer');
    const outcome = await waiting;

    expect(outcome).toEqual({
      outcome: 'settled',
      child: expect.objectContaining({
        status: 'completed',
        revision: 2,
        settledAt: fixture.runtime.clock.now(),
        outcome: { finishReason: 'stop-condition', content: 'the answer' },
      }),
    });
    expect(auditTypes(fixture.audits)).toEqual(['child.started', 'child.completed']);
    expect(fixture.audits[1]?.dedupeKey).toBe(`child.completed:${child.childRunId}`);
  });

  it('records a run that finished with an error, or whose result rejected, as failed', async () => {
    const fixture = createFixture();
    const errored = await startedChild(fixture, { childRunId: 'errored' });
    const rejected = await startedChild(fixture, { childRunId: 'rejected' });
    const exhausted = await startedChild(fixture, { childRunId: 'exhausted' });

    fixture.runs.get(errored.childRunId)?.finish('error', new Error('provider down'));
    fixture.runs.get(rejected.childRunId)?.reject('storage gone');
    fixture.runs.get(exhausted.childRunId)?.finish('maximum-steps');
    for (const id of ['errored', 'rejected', 'exhausted']) await settledChild(fixture, id);

    expect(await fixture.store.get('errored')).toMatchObject({
      status: 'failed',
      outcome: { finishReason: 'error', reason: 'provider down' },
    });
    expect(await fixture.store.get('rejected')).toMatchObject({
      status: 'failed',
      outcome: { reason: 'storage gone' },
    });
    const exhaustedRecord = await fixture.store.get('exhausted');
    expect(exhaustedRecord?.outcome).toEqual({
      finishReason: 'maximum-steps',
      content: '',
    });
  });

  it('drops a stale terminal update instead of overwriting a newer transition', async () => {
    const fixture = createFixture();
    const child = await startedChild(fixture);
    const stored = await fixture.store.get(child.childRunId);
    await fixture.store.update(stored!, {
      ...stored!,
      status: 'aborted',
      outcome: { reason: 'elsewhere' },
    });

    fixture.runs.get(child.childRunId)?.complete('late');
    const outcome = await fixture.topology.children.wait({
      parentRunId: 'parent-1',
      childRunId: child.childRunId,
    });

    expect(outcome).toMatchObject({
      outcome: 'settled',
      child: { status: 'aborted', revision: 2 },
    });
    expect(auditTypes(fixture.audits)).toEqual(['child.started']);
  });

  it('reports a child it could not record as unobservable and diagnoses the failure', async () => {
    const store = createChildTopologyStore(textValueStore(new MemoryStorage()));
    let failUpdates = false;
    const failing: ChildTopologyStore = {
      ...store,
      update: (expected, next) =>
        failUpdates ? Promise.reject(new Error('disk full')) : store.update(expected, next),
    };
    const fixture = createFixture({ store: failing });
    const child = await startedChild(fixture);
    const waiting = fixture.topology.children.wait({
      parentRunId: 'parent-1',
      childRunId: child.childRunId,
    });

    failUpdates = true;
    fixture.runs.get(child.childRunId)?.complete();

    expect(await waiting).toMatchObject({ outcome: 'unobservable', child: { status: 'running' } });
    expect(fixture.diagnostics.map((entry) => entry.message).join('\n')).toContain('disk full');
  });

  it('retries a terminal write that lost a race to a non-terminal update', async () => {
    const store = createChildTopologyStore(textValueStore(new MemoryStorage()));
    let interleave = true;
    const racing: ChildTopologyStore = {
      ...store,
      async update(expected, next) {
        if (interleave && next.status !== 'running') {
          interleave = false;
          await store.update(expected, { ...expected, updatedAt: expected.updatedAt + 1 });
        }
        return store.update(expected, next);
      },
    };
    const fixture = createFixture({ store: racing });
    const child = await startedChild(fixture);

    fixture.runs.get(child.childRunId)?.complete();

    expect(
      await fixture.topology.children.wait({
        parentRunId: 'parent-1',
        childRunId: child.childRunId,
      }),
    ).toMatchObject({ outcome: 'settled', child: { status: 'completed', revision: 3 } });
  });

  it('drains a settlement write that is still in flight', async () => {
    const store = createChildTopologyStore(textValueStore(new MemoryStorage()));
    const gate = createDeferred();
    const entered = createDeferred();
    const gated: ChildTopologyStore = {
      ...store,
      async update(expected, next) {
        entered.resolve(undefined);
        await gate.promise;
        return store.update(expected, next);
      },
    };
    const fixture = createFixture({ store: gated });
    const child = await startedChild(fixture);
    fixture.runs.get(child.childRunId)?.complete();
    await entered.promise;

    let drained = false;
    const draining = fixture.topology.drain().then(() => {
      drained = true;
      return undefined;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve(undefined);
    await draining;

    expect(await statusOf(store, child.childRunId)).toBe('completed');
  });

  it('diagnoses an audit write that fails without failing the transition', async () => {
    const fixture = createFixture({
      recordAudit: () => Promise.reject(new Error('audit offline')),
    });

    const child = await startedChild(fixture);

    expect(child.status).toBe('running');
    expect(fixture.diagnostics[0]?.message).toContain('audit offline');
  });
});

// ---------------------------------------------------------------------------
// Addressing and authorization
// ---------------------------------------------------------------------------

describe('children.list / get / wait authorization', () => {
  it('shows a child only through its own parent and to its own principal', async () => {
    const fixture = createFixture({
      parents: {
        'parent-1': { agentName: 'planner', principal: 'owner', live: true },
        'parent-2': { agentName: 'planner', live: true },
      },
    });
    const child = await startedChild(fixture, { childRunId: 'child-a' });
    const { get, list } = fixture.topology.children;

    expect(await get({ parentRunId: 'parent-1', childRunId: 'child-a' })).toEqual(child);
    expect(
      await get({ parentRunId: 'parent-1', childRunId: 'child-a', principal: 'owner' }),
    ).toEqual(child);
    expect(await get({ parentRunId: 'parent-2', childRunId: 'child-a' })).toBeUndefined();
    expect(
      await get({ parentRunId: 'parent-1', childRunId: 'child-a', principal: 'mallory' }),
    ).toBeUndefined();
    expect(await get({ parentRunId: 'parent-1', childRunId: 'nobody' })).toBeUndefined();
    expect(await list('parent-1')).toEqual([child]);
    expect(await list('parent-1', { principal: 'mallory' })).toEqual([]);
    expect(await list('parent-2')).toEqual([]);
    expect(await throwingRejectionOf(list(''))).toThrow('BAD_REQUEST');
    expect(await throwingRejectionOf(get({ parentRunId: 'parent-1', childRunId: '' }))).toThrow(
      'BAD_REQUEST',
    );
    expect(
      await throwingRejectionOf(
        get({ parentRunId: 'parent-1', childRunId: 'child-a', principal: '' }),
      ),
    ).toThrow('BAD_REQUEST');
  });

  it('gives a child of a parent without a principal to the principal that dispatched it', async () => {
    // `parent-1` has no principal, like a `createRun` or `bureau.run` run started without one.
    const fixture = createFixture();
    const alices = await startedChild(fixture, { childRunId: 'child-a', principal: 'alice' });
    const bobs = await startedChild(fixture, { childRunId: 'child-b', principal: 'bob' });
    const unowned = await startedChild(fixture, { childRunId: 'child-c' });
    const { get, list, wait, signal, cancel } = fixture.topology.children;
    const alicesAsBob = { parentRunId: 'parent-1', childRunId: 'child-a', principal: 'bob' };
    const ids = (records: readonly BureauChildRecord[]) => records.map((r) => r.childRunId);

    expect([alices.principal, bobs.principal, unowned.principal]).toEqual([
      'alice',
      'bob',
      undefined,
    ]);
    expect(fixture.starts.map((start) => start.principal)).toEqual(['alice', 'bob', undefined]);

    // Every read and write checks the child record's principal, not the parent's.
    expect(await get(alicesAsBob)).toBeUndefined();
    expect(await wait(alicesAsBob)).toEqual({ outcome: 'not-found' });
    expect(await signal({ ...alicesAsBob, name: 'proceed', payload: { step: 1 } })).toEqual({
      outcome: 'not-found',
    });
    expect(await cancel(alicesAsBob)).toEqual({ outcome: 'not-found' });
    expect(await statusOf(fixture.store, 'child-a')).toBe('running');
    expect(ids(await list('parent-1', { principal: 'bob' }))).toEqual(['child-b', 'child-c']);
    expect(ids(await list('parent-1', { principal: 'alice' }))).toEqual(['child-a', 'child-c']);

    // The dispatching principal, and a trusted call without one, find it.
    expect(
      await get({ parentRunId: 'parent-1', childRunId: 'child-a', principal: 'alice' }),
    ).toEqual(alices);
    expect(await get({ parentRunId: 'parent-1', childRunId: 'child-a' })).toEqual(alices);
    expect(ids(await list('parent-1'))).toEqual(['child-a', 'child-b', 'child-c']);

    // A child that no principal owns is visible to every principal.
    expect(await get({ parentRunId: 'parent-1', childRunId: 'child-c', principal: 'bob' })).toEqual(
      unowned,
    );
  });

  it('gives a child of a parent with a principal to that principal, whoever dispatched it', async () => {
    const fixture = createFixture({
      parents: { 'parent-1': { agentName: 'planner', principal: 'owner', live: true } },
    });
    const { dispatch, get } = fixture.topology.children;

    const asOwner = await startedChild(fixture, { childRunId: 'child-a', principal: 'owner' });
    const trusted = await startedChild(fixture, { childRunId: 'child-b' });
    const asAlice = await dispatch({
      parentRunId: 'parent-1',
      agentName: 'worker',
      input: 'x',
      childRunId: 'child-c',
      principal: 'alice',
    });

    // Dispatch checks the caller's principal against the parent's.
    expect(asAlice).toEqual({ outcome: 'not-found' });
    expect([asOwner.principal, trusted.principal]).toEqual(['owner', 'owner']);
    expect(
      await get({ parentRunId: 'parent-1', childRunId: 'child-b', principal: 'owner' }),
    ).toEqual(trusted);
    expect(
      await get({ parentRunId: 'parent-1', childRunId: 'child-b', principal: 'alice' }),
    ).toBeUndefined();
  });

  it('answers wait for an unknown, settled, unobserved, or abandoned wait', async () => {
    const fixture = createFixture();
    const child = await startedChild(fixture, { childRunId: 'child-a' });
    const reference = { parentRunId: 'parent-1', childRunId: 'child-a' };
    const { wait } = fixture.topology.children;

    expect(await wait({ parentRunId: 'parent-2', childRunId: 'child-a' })).toEqual({
      outcome: 'not-found',
    });
    const preAborted = AbortSignal.abort();
    expect(await wait(reference, { signal: preAborted })).toEqual({
      outcome: 'wait-aborted',
      child,
    });
    const controller = new AbortController();
    const abandoned = wait(reference, { signal: controller.signal });
    controller.abort();
    expect(await abandoned).toEqual({ outcome: 'wait-aborted', child });

    const midWait = new AbortController();
    const interrupted = wait(reference, { signal: midWait.signal });
    // Let the wait finish its record read and start listening before aborting it.
    await new Promise((resolve) => setImmediate(resolve));
    midWait.abort();
    expect(await interrupted).toEqual({ outcome: 'wait-aborted', child });

    fixture.runs.get('child-a')?.complete();
    expect(await wait(reference)).toMatchObject({ outcome: 'settled' });
    expect(await wait(reference)).toMatchObject({
      outcome: 'settled',
      child: { status: 'completed' },
    });

    await fixture.store.register(runningRecord({ childRunId: 'orphan' }));
    expect(await wait({ parentRunId: 'parent-1', childRunId: 'orphan' })).toMatchObject({
      outcome: 'unobservable',
    });
  });
});

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

describe('children.signal', () => {
  function handle(start: ChildTopologyStart | undefined): ChildSignalPort<typeof signals> {
    return start?.context.parentSignals as unknown as ChildSignalPort<typeof signals>;
  }

  it('delivers a typed signal to exactly the addressed child and returns its acknowledgement', async () => {
    const fixture = createFixture();
    await startedChild(fixture, { childRunId: 'child-a' });
    await startedChild(fixture, { childRunId: 'child-b' });
    const received: { child: string; step: number }[] = [];
    for (const start of fixture.starts) {
      handle(start).onSignal('proceed', (message) => {
        received.push({ child: message.childRunId, step: message.payload.step });
      });
    }

    const outcome = await fixture.topology.children.signal({
      parentRunId: 'parent-1',
      childRunId: 'child-b',
      name: 'proceed',
      payload: { step: 2 },
    });

    expect(outcome).toEqual({ outcome: 'acknowledged', signalId: 'child-b:signal:1', sequence: 1 });
    expect(received).toEqual([{ child: 'child-b', step: 2 }]);
  });

  it('returns the channel’s typed rejection for a signal the contract does not allow', async () => {
    const fixture = createFixture();
    await startedChild(fixture, { childRunId: 'child-a' });

    expect(
      await fixture.topology.children.signal({
        parentRunId: 'parent-1',
        childRunId: 'child-a',
        name: 'proceed',
        payload: { step: 'two' },
      }),
    ).toMatchObject({ outcome: 'rejected', code: 'invalid-payload', delivered: false });
  });

  it('refuses a signal to an unknown, unrelated, finished, or unreachable child', async () => {
    const fixture = createFixture();
    await startedChild(fixture, { childRunId: 'child-a' });
    await startedChild(fixture, { childRunId: 'local-a', agentName: 'local' });
    await fixture.store.register(runningRecord({ childRunId: 'unwired' }));
    const { signal } = fixture.topology.children;
    const request = { name: 'proceed', payload: { step: 1 } };

    expect(await signal({ parentRunId: 'other', childRunId: 'child-a', ...request })).toEqual({
      outcome: 'not-found',
    });
    expect(await signal({ parentRunId: 'parent-1', childRunId: 'local-a', ...request })).toEqual({
      outcome: 'unsupported',
      reason: 'no-signal-contract',
    });
    expect(await signal({ parentRunId: 'parent-1', childRunId: 'unwired', ...request })).toEqual({
      outcome: 'unsupported',
      reason: 'child-not-live',
    });
    fixture.runs.get('child-a')?.complete();
    await settledChild(fixture, 'child-a');
    expect(
      await signal({ parentRunId: 'parent-1', childRunId: 'child-a', ...request }),
    ).toMatchObject({
      outcome: 'child-terminal',
    });
    expect(
      await throwingRejectionOf(
        signal({ parentRunId: 'parent-1', childRunId: 'child-a', name: '' }),
      ),
    ).toThrow('BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// Cancellation and the parent-cancellation policy
// ---------------------------------------------------------------------------

describe('children.cancel', () => {
  it('aborts a live child and records the cancellation reason', async () => {
    const fixture = createFixture();
    const child = await startedChild(fixture, { childRunId: 'child-a' });

    const outcome = await fixture.topology.children.cancel({
      parentRunId: 'parent-1',
      childRunId: 'child-a',
      reason: 'no longer needed',
    });
    await settledChild(fixture, 'child-a');

    expect(outcome).toEqual({ outcome: 'requested', child });
    expect(fixture.runs.get('child-a')?.abortReasons).toEqual(['no longer needed']);
    expect(await fixture.store.get('child-a')).toMatchObject({
      status: 'aborted',
      outcome: { finishReason: 'aborted', reason: 'no longer needed' },
    });
    expect(auditTypes(fixture.audits)).toEqual(['child.started', 'child.aborted']);
    expect(
      await fixture.topology.children.cancel({ parentRunId: 'parent-1', childRunId: 'child-a' }),
    ).toMatchObject({ outcome: 'already-terminal' });
    expect(
      await fixture.topology.children.cancel({ parentRunId: 'nope', childRunId: 'child-a' }),
    ).toEqual({ outcome: 'not-found' });
  });

  it('cancels a durable child with no live handle through the engine', async () => {
    const engine = createFakeEngine();
    const fixture = createFixture({ engine });
    await fixture.store.register(runningRecord({ childRunId: 'durable-a' }));
    engine.states.set('durable-a', workflowState('durable-a', 'running'));

    const outcome = await fixture.topology.children.cancel({
      parentRunId: 'parent-1',
      childRunId: 'durable-a',
    });

    expect(outcome).toMatchObject({
      outcome: 'requested',
      child: { status: 'aborted', outcome: { reason: 'Cancelled via Bureau' } },
    });
  });

  it('records the real outcome when a durable child finished before the cancel landed', async () => {
    const engine = createFakeEngine();
    const fixture = createFixture({ engine });
    await fixture.store.register(runningRecord({ childRunId: 'raced' }));
    engine.states.set(
      'raced',
      workflowState('raced', 'completed', {
        result: { finishReason: 'stop-condition', content: 'won the race' },
      }),
    );
    await fixture.store.register(runningRecord({ childRunId: 'vanished' }));
    await fixture.store.register(runningRecord({ childRunId: 'blind' }));
    const blindFixture = createFixture({
      engine: null,
      store: fixture.store,
      cancelDurable: async () => ({ status: 'already-terminal' }),
    });

    expect(
      await fixture.topology.children.cancel({ parentRunId: 'parent-1', childRunId: 'raced' }),
    ).toMatchObject({
      outcome: 'already-terminal',
      child: { status: 'completed', outcome: { content: 'won the race' } },
    });
    expect(
      await fixture.topology.children.cancel({ parentRunId: 'parent-1', childRunId: 'vanished' }),
    ).toMatchObject({ outcome: 'already-terminal', child: { status: 'failed' } });
    expect(
      await blindFixture.topology.children.cancel({ parentRunId: 'parent-1', childRunId: 'blind' }),
    ).toMatchObject({
      outcome: 'already-terminal',
      child: { status: 'failed', outcome: { reason: 'workflow state unavailable' } },
    });
  });

  it('reports a cancellation the engine could not perform without changing the record', async () => {
    for (const outcome of [
      { status: 'failed', error: new Error('engine wedged') },
      { status: 'unsupported-capability' },
    ] as const) {
      const fixture = createFixture({ cancelDurable: async () => outcome });
      await fixture.store.register(runningRecord({ childRunId: 'stuck' }));

      const result = await fixture.topology.children.cancel({
        parentRunId: 'parent-1',
        childRunId: 'stuck',
      });

      expect(result).toMatchObject({ outcome: 'failed', child: { status: 'running' } });
    }
  });

  it('leaves a child’s subtree running when its cancellation fails, and cascades it once a retry lands', async () => {
    const engine = createFakeEngine();
    const fixture = createFixture({
      engine,
      cancelDurable: wedgedOnce(engine, 'child-c'),
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'child-c': { agentName: 'worker', live: true },
      },
    });
    await fixture.store.register(runningRecord({ childRunId: 'child-c' }));
    await fixture.store.register(
      runningRecord({ parentRunId: 'child-c', childRunId: 'grandchild-g' }),
    );
    engine.states.set('child-c', workflowState('child-c', 'running'));
    engine.states.set('grandchild-g', workflowState('grandchild-g', 'running'));
    const reference = { parentRunId: 'parent-1', childRunId: 'child-c' };

    expect(await fixture.topology.children.cancel(reference)).toMatchObject({
      outcome: 'failed',
      child: { status: 'running' },
    });
    expect(await statusOf(fixture.store, 'grandchild-g')).toBe('running');
    expect(engine.states.get('grandchild-g')?.status).toBe('running');
    // Still running, so it may still delegate.
    await startedChild(fixture, { parentRunId: 'child-c', childRunId: 'grandchild-2' });

    expect(await fixture.topology.children.cancel(reference)).toMatchObject({
      outcome: 'requested',
      child: { status: 'aborted' },
    });
    await settledChild(fixture, 'grandchild-2', 'child-c');
    expect(await statusOf(fixture.store, 'grandchild-g')).toBe('aborted');
    expect(await statusOf(fixture.store, 'grandchild-2')).toBe('aborted');
  });

  it('cascades nothing from a child that finished before the cancel landed, as recovery would not', async () => {
    const engine = createFakeEngine();
    const fixture = createFixture({ engine });
    await fixture.store.register(runningRecord({ childRunId: 'raced' }));
    await fixture.store.register(runningRecord({ parentRunId: 'raced', childRunId: 'grandchild' }));
    engine.states.set(
      'raced',
      workflowState('raced', 'completed', {
        result: { finishReason: 'stop-condition', content: 'won the race' },
      }),
    );
    engine.states.set('grandchild', workflowState('grandchild', 'running'));

    expect(
      await fixture.topology.children.cancel({ parentRunId: 'parent-1', childRunId: 'raced' }),
    ).toMatchObject({ outcome: 'already-terminal', child: { status: 'completed' } });
    expect(await statusOf(fixture.store, 'grandchild')).toBe('running');
    expect(engine.states.get('grandchild')?.status).toBe('running');

    // A restart reads the finished parent the same way and reattaches its child.
    const restarted = createFixture({ engine, store: fixture.store });
    await restarted.topology.prepareRecovery();
    await restarted.topology.reconcileRecovery();
    expect(await fixture.store.get('grandchild')).toMatchObject({
      status: 'running',
      recoveries: 1,
    });
  });

  it('settles a process-local child no process is running any more as aborted', async () => {
    const fixture = createFixture();
    await fixture.store.register(
      runningRecord({ childRunId: 'lost', workflow: { kind: 'process-local' } }),
    );

    expect(
      await fixture.topology.children.cancel({ parentRunId: 'parent-1', childRunId: 'lost' }),
    ).toMatchObject({ outcome: 'requested', child: { status: 'aborted' } });
  });
});

describe('parent cancellation policy', () => {
  it('cascades to cascade children, down the tree, and leaves detached children running', async () => {
    const fixture = createFixture({
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'child-cascade': { agentName: 'worker', live: true },
      },
    });
    await startedChild(fixture, { childRunId: 'child-cascade' });
    await startedChild(fixture, { childRunId: 'child-detach', parentCancellation: 'detach' });
    await startedChild(fixture, { parentRunId: 'child-cascade', childRunId: 'grandchild' });

    await fixture.topology.parentCancelled('parent-1', 'Aborted via API');
    await settledChild(fixture, 'child-cascade');
    await settledChild(fixture, 'grandchild', 'child-cascade');

    expect(await statusOf(fixture.store, 'child-cascade')).toBe('aborted');
    expect(await statusOf(fixture.store, 'grandchild')).toBe('aborted');
    expect(await statusOf(fixture.store, 'child-detach')).toBe('running');
    expect(fixture.runs.get('child-detach')?.abortReasons).toEqual([]);

    fixture.runs.get('child-detach')?.complete('finished on its own');
    await settledChild(fixture, 'child-detach');
    expect(await statusOf(fixture.store, 'child-detach')).toBe('completed');
  });

  it('diagnoses a policy it cannot read each time it is applied', async () => {
    const store = createChildTopologyStore(textValueStore(new MemoryStorage()));
    const fixture = createFixture({
      store: { ...store, listByParent: () => Promise.reject(new Error('index offline')) },
    });

    await fixture.topology.parentCancelled('parent-1', 'first');
    await fixture.topology.parentCancelled('parent-1', 'second');

    expect(fixture.diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('index offline'),
      }),
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('index offline'),
      }),
    ]);
  });

  it('refuses a child under a parent whose cancellation was requested but has not landed', async () => {
    const fixture = createFixture({
      parents: {
        // Each still reads as running — a `createRun` run after `abortRun`,
        // or a child record — until its run honours the abort.
        'parent-1': { agentName: 'planner', live: true },
        'child-c': { agentName: 'worker', live: true },
      },
      slowToAbort: ['child-c'],
    });
    await startedChild(fixture, { childRunId: 'child-c' });
    const reference = { parentRunId: 'parent-1', childRunId: 'child-c' };
    const dispatchUnder = (parentRunId: string, childRunId: string) =>
      fixture.topology.children.dispatch({
        parentRunId,
        agentName: 'worker',
        input: 'x',
        childRunId,
      });

    expect(await fixture.topology.children.cancel(reference)).toMatchObject({
      outcome: 'requested',
      child: { status: 'running' },
    });
    expect(await dispatchUnder('child-c', 'late')).toMatchObject({
      outcome: 'rejected',
      code: 'parent-terminal',
      reason: expect.stringContaining('child-c'),
    });

    fixture.runs.get('child-c')?.finish('aborted');
    await settledChild(fixture, 'child-c');
    expect(await statusOf(fixture.store, 'child-c')).toBe('aborted');
    expect(await fixture.topology.children.list('child-c')).toEqual([]);

    await fixture.topology.parentCancelled('parent-1', 'Aborted via API');
    expect(await dispatchUnder('parent-1', 'too-late')).toMatchObject({
      outcome: 'rejected',
      code: 'parent-terminal',
    });
    expect(fixture.starts.map((start) => start.childRunId)).toEqual(['child-c']);
  });

  it('cascades a child whose dispatch was already under way when its parent was cancelled', async () => {
    const checking = Promise.withResolvers<void>();
    const admit = Promise.withResolvers<boolean>();
    const fixture = createFixture({
      isKnownRun: async () => {
        checking.resolve();
        return admit.promise;
      },
    });

    const dispatching = fixture.topology.children.dispatch({
      parentRunId: 'parent-1',
      agentName: 'worker',
      input: 'x',
      childRunId: 'in-flight',
    });
    await checking.promise;
    const cancelling = fixture.topology.parentCancelled('parent-1', 'stop');
    admit.resolve(false);

    expect(await dispatching).toMatchObject({ outcome: 'started' });
    await cancelling;
    expect(fixture.runs.get('in-flight')?.abortReasons).toEqual([
      'parent parent-1 cancelled: stop',
    ]);
    await settledChild(fixture, 'in-flight');
    expect(await statusOf(fixture.store, 'in-flight')).toBe('aborted');
  });

  it('diagnoses a cascade the engine could not perform, and retries it when the parent settles', async () => {
    const engine = createFakeEngine();
    const fixture = createFixture({
      engine,
      cancelDurable: wedgedOnce(engine, 'child-c'),
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'child-p': { agentName: 'worker', live: true },
      },
      slowToAbort: ['child-p'],
    });
    await startedChild(fixture, { childRunId: 'child-p' });
    await fixture.store.register(runningRecord({ parentRunId: 'child-p', childRunId: 'child-c' }));
    await fixture.store.register(
      runningRecord({ parentRunId: 'child-c', childRunId: 'grandchild' }),
    );
    engine.states.set('child-c', workflowState('child-c', 'running'));
    engine.states.set('grandchild', workflowState('grandchild', 'running'));

    expect(
      await fixture.topology.children.cancel({ parentRunId: 'parent-1', childRunId: 'child-p' }),
    ).toMatchObject({ outcome: 'requested' });
    expect(fixture.diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        scope: 'child-topology',
        message: expect.stringContaining('engine wedged'),
      }),
    ]);
    // `child-c` is still running, so its own children are left to it.
    expect(await statusOf(fixture.store, 'child-c')).toBe('running');
    expect(await statusOf(fixture.store, 'grandchild')).toBe('running');

    fixture.runs.get('child-p')?.finish('aborted');
    await settledChild(fixture, 'child-p');

    expect(await statusOf(fixture.store, 'child-c')).toBe('aborted');
    expect(await statusOf(fixture.store, 'grandchild')).toBe('aborted');
    expect(engine.states.get('grandchild')?.status).toBe('cancelled');
  });

  it('never aborts a child twice while it winds down from an earlier cascade', async () => {
    const fixture = createFixture({ slowToAbort: ['child-a'] });
    await startedChild(fixture, { childRunId: 'child-a' });

    await fixture.topology.parentCancelled('parent-1', 'first');
    await fixture.topology.parentCancelled('parent-1', 'second');
    fixture.runs.get('child-a')?.finish('aborted');
    await settledChild(fixture, 'child-a');

    expect(fixture.runs.get('child-a')?.abortReasons).toEqual(['parent parent-1 cancelled: first']);
    expect(await fixture.store.get('child-a')).toMatchObject({
      status: 'aborted',
      outcome: { reason: 'parent parent-1 cancelled: first' },
    });
  });
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

describe('recovery', () => {
  async function recover(fixture: ReturnType<typeof createFixture>): Promise<void> {
    await fixture.topology.prepareRecovery();
    await fixture.topology.reconcileRecovery();
    await fixture.topology.drain();
  }

  it('records children that cannot come back — process-local, no engine, or no workflow — as failed', async () => {
    const engine = createFakeEngine();
    const fixture = createFixture({ engine });
    await fixture.store.register(
      runningRecord({ childRunId: 'local', workflow: { kind: 'process-local' } }),
    );
    await fixture.store.register(runningRecord({ childRunId: 'missing' }));
    const noEngine = createFixture({ engine: null });
    await noEngine.store.register(runningRecord({ childRunId: 'orphaned' }));

    await recover(fixture);
    await recover(noEngine);

    expect(await fixture.store.get('local')).toMatchObject({
      status: 'failed',
      outcome: { reason: 'process lost before recovery' },
    });
    expect(await fixture.store.get('missing')).toMatchObject({
      status: 'failed',
      outcome: { reason: 'workflow missing on recovery' },
    });
    expect(await noEngine.store.get('orphaned')).toMatchObject({
      status: 'failed',
      outcome: { reason: 'no durable engine on recovery' },
    });
  });

  it('records a child that finished while its parent was unavailable with its real outcome', async () => {
    const engine = createFakeEngine();
    const fixture = createFixture({ engine });
    for (const id of ['completed', 'cancelled', 'crashed', 'timed-out', 'opaque']) {
      await fixture.store.register(runningRecord({ childRunId: id }));
    }
    engine.states.set(
      'completed',
      workflowState('completed', 'completed', {
        result: { finishReason: 'stop-condition', content: 'finished alone' },
      }),
    );
    engine.states.set('cancelled', workflowState('cancelled', 'cancelled'));
    engine.states.set('crashed', workflowState('crashed', 'failed', { error: 'boom' }));
    engine.states.set('timed-out', workflowState('timed-out', 'timed-out'));
    engine.states.set(
      'opaque',
      workflowState('opaque', 'completed', { result: 'not a run result' }),
    );

    await recover(fixture);

    expect(await fixture.store.get('completed')).toMatchObject({
      status: 'completed',
      outcome: { finishReason: 'stop-condition', content: 'finished alone' },
    });
    expect(await statusOf(fixture.store, 'cancelled')).toBe('aborted');
    expect(await fixture.store.get('crashed')).toMatchObject({
      status: 'failed',
      outcome: { reason: 'boom' },
    });
    expect(await fixture.store.get('timed-out')).toMatchObject({
      status: 'failed',
      outcome: { reason: 'workflow timed-out' },
    });
    expect(await fixture.store.get('opaque')).toMatchObject({ status: 'completed', outcome: {} });
    expect(auditTypes(fixture.audits).filter((type) => type === 'child.reattached')).toEqual([]);
  });

  it('reattaches a still-running child without starting it, and reopens its signal channel first', async () => {
    const engine = createFakeEngine();
    const fixture = createFixture({ engine });
    engine.states.set('parent-1', workflowState('parent-1', 'running'));
    await fixture.store.register(runningRecord({ childRunId: 'child-a' }));
    engine.states.set('child-a', workflowState('child-a', 'running'));

    await fixture.topology.prepareRecovery();
    const context = fixture.topology.recoveredRunContext('child-a');
    expect(fixture.topology.recoveredRunContext('someone-else')).toBeUndefined();
    await fixture.topology.reconcileRecovery();

    expect(context?.childCorrelation).toEqual({
      parentAgentName: 'planner',
      parentRunId: 'parent-1',
      childAgentName: 'worker',
      childRunId: 'child-a',
    });
    const port = context?.parentSignals as unknown as ChildSignalPort<typeof signals>;
    const steps: number[] = [];
    port.onSignal('proceed', (message) => {
      steps.push(message.payload.step);
    });
    expect(
      await fixture.topology.children.signal({
        parentRunId: 'parent-1',
        childRunId: 'child-a',
        name: 'proceed',
        payload: { step: 7 },
      }),
    ).toMatchObject({ outcome: 'acknowledged' });
    expect(steps).toEqual([7]);
    expect(fixture.starts).toHaveLength(0);
    expect(await fixture.store.get('child-a')).toMatchObject({
      status: 'running',
      revision: 2,
      recoveries: 1,
      reattachedAt: fixture.runtime.clock.now(),
    });
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        type: 'child.reattached',
        dedupeKey: 'child.reattached:child-a:2',
      }),
    ]);

    const waiting = fixture.topology.children.wait({
      parentRunId: 'parent-1',
      childRunId: 'child-a',
    });
    engine.handleFor('child-a').resolve({ finishReason: 'stop-condition', content: 'resumed' });
    expect(await waiting).toMatchObject({
      outcome: 'settled',
      child: { status: 'completed', outcome: { content: 'resumed' } },
    });
  });

  it('classifies a reattached child whose workflow ends without a run result', async () => {
    const engine = createFakeEngine();
    const fixture = createFixture({ engine });
    engine.states.set('parent-1', workflowState('parent-1', 'running'));
    for (const id of ['plain', 'cancelled-later', 'lost-later']) {
      await fixture.store.register(runningRecord({ childRunId: id }));
      engine.states.set(id, workflowState(id, 'running'));
    }

    await fixture.topology.prepareRecovery();
    await fixture.topology.reconcileRecovery();
    engine.handleFor('plain').resolve(undefined);
    engine.states.set('cancelled-later', workflowState('cancelled-later', 'cancelled'));
    engine.handleFor('cancelled-later').reject(new Error('cancelled'));
    engine.handleFor('lost-later').reject(new Error('connection reset'));
    for (const id of ['plain', 'cancelled-later', 'lost-later']) await settledChild(fixture, id);

    expect(await statusOf(fixture.store, 'plain')).toBe('completed');
    expect(await statusOf(fixture.store, 'cancelled-later')).toBe('aborted');
    expect(await fixture.store.get('lost-later')).toMatchObject({
      status: 'failed',
      outcome: { reason: 'connection reset' },
    });
  });

  it('falls back to the handle’s own error when the workflow state cannot be read either', async () => {
    const engine = createFakeEngine();
    let failReads = false;
    const fixture = createFixture({
      engine: {
        ...engine,
        get: async (id: string) => {
          if (failReads) throw new Error('state unreadable');
          return engine.get(id);
        },
      },
    });
    engine.states.set('parent-1', workflowState('parent-1', 'running'));
    await fixture.store.register(runningRecord({ childRunId: 'child-a' }));
    engine.states.set('child-a', workflowState('child-a', 'running'));
    await fixture.topology.prepareRecovery();
    await fixture.topology.reconcileRecovery();

    failReads = true;
    engine.handleFor('child-a').reject(new Error('handle lost'));
    await settledChild(fixture, 'child-a');

    expect(await fixture.store.get('child-a')).toMatchObject({
      status: 'failed',
      outcome: { reason: 'handle lost' },
    });
  });

  it('applies the cancellation policy for a parent that was cancelled or cannot be recovered', async () => {
    const engine = createFakeEngine();
    const fixture = createFixture({ engine });
    engine.states.set('cancelled-parent', workflowState('cancelled-parent', 'cancelled'));
    engine.states.set('finished-parent', workflowState('finished-parent', 'completed'));
    const cases = [
      ['cascade-of-cancelled', 'cancelled-parent', 'cascade'],
      ['detach-of-cancelled', 'cancelled-parent', 'detach'],
      ['cascade-of-lost', 'lost-parent', 'cascade'],
      ['detach-of-lost', 'lost-parent', 'detach'],
      ['cascade-of-finished', 'finished-parent', 'cascade'],
    ] as const;
    for (const [childRunId, parentRunId, parentCancellation] of cases) {
      await fixture.store.register(runningRecord({ childRunId, parentRunId, parentCancellation }));
      engine.states.set(childRunId, workflowState(childRunId, 'running'));
    }

    await recover(fixture);

    expect(await statusOf(fixture.store, 'cascade-of-cancelled')).toBe('aborted');
    expect(await statusOf(fixture.store, 'cascade-of-lost')).toBe('aborted');
    expect(await fixture.store.get('detach-of-cancelled')).toMatchObject({ recoveries: 1 });
    expect(await fixture.store.get('detach-of-lost')).toMatchObject({ recoveries: 1 });
    expect(await fixture.store.get('cascade-of-finished')).toMatchObject({ recoveries: 1 });
  });

  it('recovers parents before their children, so a cascade reaches the whole subtree', async () => {
    const engine = createFakeEngine();
    const fixture = createFixture({ engine });
    // Registered child-first so ordering cannot come from storage order.
    await fixture.store.register(
      runningRecord({ childRunId: 'grandchild', parentRunId: 'child', parentAgentName: 'worker' }),
    );
    await fixture.store.register(runningRecord({ childRunId: 'child', parentRunId: 'gone' }));
    await fixture.store.register(
      runningRecord({ childRunId: 'finished-child', parentRunId: 'gone', status: 'completed' }),
    );
    await fixture.store.register(
      runningRecord({
        childRunId: 'under-finished',
        parentRunId: 'finished-child',
        parentAgentName: 'worker',
      }),
    );
    for (const id of ['grandchild', 'child', 'under-finished']) {
      engine.states.set(id, workflowState(id, 'running'));
    }

    await recover(fixture);

    expect(await statusOf(fixture.store, 'child')).toBe('aborted');
    expect(await statusOf(fixture.store, 'grandchild')).toBe('aborted');
    expect(await fixture.store.get('under-finished')).toMatchObject({
      status: 'running',
      recoveries: 1,
    });
  });

  it('skips a record that settled between loading and reconciling, and survives one that throws', async () => {
    const engine = createFakeEngine();
    const store = createChildTopologyStore(textValueStore(new MemoryStorage()));
    const fixture = createFixture({
      engine: {
        ...engine,
        get: async (id: string) => {
          if (id === 'explodes') throw new Error('engine offline');
          return engine.get(id);
        },
      },
      store,
    });
    await store.register(runningRecord({ childRunId: 'settles' }));
    await store.register(runningRecord({ childRunId: 'explodes' }));
    await fixture.topology.prepareRecovery();
    const settles = await store.get('settles');
    await store.update(settles!, { ...settles!, status: 'completed' });

    await fixture.topology.reconcileRecovery();

    expect(await store.get('settles')).toMatchObject({ status: 'completed', revision: 2 });
    expect(fixture.diagnostics.map((entry) => entry.message).join('\n')).toContain(
      'engine offline',
    );
    expect(
      await fixture.topology.children.wait({ parentRunId: 'parent-1', childRunId: 'explodes' }),
    ).toMatchObject({ outcome: 'unobservable' });
  });

  it('leaves a child another process reattached first to that process', async () => {
    const engine = createFakeEngine();
    const store = createChildTopologyStore(textValueStore(new MemoryStorage()));
    let interleaved = false;
    const racing: ChildTopologyStore = {
      ...store,
      async update(expected, next) {
        if (!interleaved && next.recoveries === 1) {
          interleaved = true;
          await store.update(expected, { ...expected, recoveries: 1 });
        }
        return store.update(expected, next);
      },
    };
    const fixture = createFixture({ engine, store: racing });
    engine.states.set('parent-1', workflowState('parent-1', 'running'));
    await store.register(runningRecord({ childRunId: 'child-a' }));
    engine.states.set('child-a', workflowState('child-a', 'running'));

    await recover(fixture);

    expect(auditTypes(fixture.audits)).toEqual([]);
    expect(await store.get('child-a')).toMatchObject({ revision: 2, recoveries: 1 });
  });
});

// ---------------------------------------------------------------------------
// Delegation grants
// ---------------------------------------------------------------------------

describe('delegation grants', () => {
  const delegation = {
    secret: SECRET,
    policyVersion: 'policy-7',
    defaultTimeToLiveMilliseconds: 1_000,
  };

  async function grantOf(
    fixture: ReturnType<typeof createFixture>,
    childRunId: string,
  ): Promise<DelegationGrant> {
    const record = await fixture.store.get(childRunId);
    const load = await fixture.store.loadGrant(record!.grantId!);
    if (load.status !== 'found') throw new Error('grant missing');
    return load.grant;
  }

  it('issues a signed grant for a top-level dispatch and discloses only what its policy allows', async () => {
    const fixture = createFixture({ delegation });
    const now = fixture.runtime.clock.now();

    const redacted = await fixture.topology.children.dispatch({
      parentRunId: 'parent-1',
      agentName: 'worker',
      input: 'summarize',
      childRunId: 'child-a',
      authority: { budget: { concurrentChildren: 2 }, capabilities: { tools: ['read'] } },
    });
    const full = await fixture.topology.children.dispatch({
      parentRunId: 'parent-1',
      agentName: 'worker',
      input: { conversation: { id: 'c', messages: [] } } as never,
      childRunId: 'child-b',
      authority: { budget: { steps: 3 }, disclosurePolicy: 'full', depth: 2 },
    });

    expect(redacted).toMatchObject({
      outcome: 'started',
      grant: { policyVersion: 'policy-7', depth: 0, expiresAt: now + 1_000 },
    });
    expect(redacted.outcome === 'started' && redacted.grant && 'budget' in redacted.grant).toBe(
      false,
    );
    expect(full).toMatchObject({ grant: { depth: 2, budget: { steps: 3 } } });
    const grant = await grantOf(fixture, 'child-a');
    expect(grant).toMatchObject({
      parentRunId: 'parent-1',
      childRunId: 'child-a',
      agentName: 'worker',
      agentVersion: '3',
      objective: 'summarize',
      recipientId: 'child-a',
      effectiveCapabilities: { tools: ['read'] },
      delegatedAuthority: { policyVersion: 'policy-7' },
    });
    expect(verifyDelegationGrant(grant, SECRET, now)).toEqual({ valid: true });
    const conversationGrant = await grantOf(fixture, 'child-b');
    expect(conversationGrant.objective).toBe('conversation');
    expect(conversationGrant.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('attenuates a nested grant from its parent’s and reserves its budget in the ledger', async () => {
    const fixture = createFixture({
      delegation,
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'child-a': { agentName: 'worker', live: true },
      },
    });
    await startedChild(fixture, {
      childRunId: 'child-a',
      authority: {
        depth: 1,
        budget: { concurrentChildren: 1, totalDescendants: 5, tokens: 100 },
        capabilities: { tools: ['read', 'write'], network: ['a.com', 'b.com'] },
        delegatedAuthority: { grantedModels: ['m1', 'm2'], policyVersion: 'models-1' },
        timeToLiveMilliseconds: 500,
      },
    });

    await startedChild(fixture, {
      parentRunId: 'child-a',
      childRunId: 'grandchild',
      authority: {
        capabilities: { tools: ['write'] },
        budget: { tokens: 10 },
        delegatedAuthority: { grantedModels: ['m2', 'm3'], policyVersion: 'models-2' },
        timeToLiveMilliseconds: 5_000,
      },
    });

    const parentGrant = await grantOf(fixture, 'child-a');
    const grandchild = await fixture.store.get('grandchild');
    const grant = await grantOf(fixture, 'grandchild');
    expect(grandchild?.parentGrantId).toBe(parentGrant.id);
    expect(grant).toMatchObject({
      depth: 0,
      expiresAt: parentGrant.expiresAt,
      budget: { concurrentChildren: 1, totalDescendants: 5, tokens: 10 },
      effectiveCapabilities: { tools: ['write'], network: ['a.com', 'b.com'] },
      delegatedAuthority: { grantedModels: ['m2'], policyVersion: 'models-2' },
    });
    expect(await fixture.store.listLedger(parentGrant.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childRunId: 'grandchild',
          kind: 'reserve',
          dimension: 'concurrentChildren',
        }),
        expect.objectContaining({
          childRunId: 'grandchild',
          kind: 'reserve',
          dimension: 'totalDescendants',
        }),
      ]),
    );

    // A nested child without its own delegated authority inherits its parent's.
    const again = createFixture({
      delegation,
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'child-a': { agentName: 'w', live: true },
      },
    });
    await startedChild(again, {
      childRunId: 'child-a',
      authority: {
        depth: 1,
        delegatedAuthority: { maximumEffort: 'low', policyVersion: 'effort-1' },
      },
    });
    await startedChild(again, { parentRunId: 'child-a', childRunId: 'grandchild' });
    const inherited = await grantOf(again, 'grandchild');
    expect(inherited.delegatedAuthority).toEqual({
      maximumEffort: 'low',
      policyVersion: 'effort-1',
    });
  });

  it('rejects a nested dispatch that asks for more than its parent’s grant allows', async () => {
    const fixture = createFixture({
      delegation,
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'child-a': { agentName: 'worker', live: true },
        'child-z': { agentName: 'worker', live: true },
      },
    });
    await startedChild(fixture, {
      childRunId: 'child-a',
      authority: {
        depth: 1,
        budget: { steps: 5 },
        capabilities: { tools: ['read'], network: false, admin: ['issue'] },
      },
    });
    await startedChild(fixture, { childRunId: 'child-z' });
    const nested = (authority: object) =>
      fixture.topology.children.dispatch({
        parentRunId: 'child-a',
        agentName: 'worker',
        input: 'x',
        authority,
      });

    expect(await nested({ depth: 1 })).toMatchObject({
      code: 'authority-exceeded',
      reason: expect.stringContaining('depth'),
    });
    expect(await nested({ budget: { steps: 6 } })).toMatchObject({
      reason: expect.stringContaining('budget.steps'),
    });
    expect(await nested({ capabilities: { tools: ['write'] } })).toMatchObject({
      reason: expect.stringContaining('capabilities.tools'),
    });
    expect(await nested({ capabilities: { network: true } })).toMatchObject({
      reason: expect.stringContaining('capabilities.network'),
    });
    expect(await nested({ capabilities: { admin: true } })).toMatchObject({
      reason: expect.stringContaining('capabilities.admin'),
    });
    expect(await nested({ capabilities: { admin: ['revoke'] } })).toMatchObject({
      reason: expect.stringContaining('capabilities.admin'),
    });
    expect(
      await nested({ budget: { tokens: 9 }, capabilities: { admin: ['issue'], network: false } }),
    ).toMatchObject({ outcome: 'started' });
    expect(
      await fixture.topology.children.dispatch({
        parentRunId: 'child-z',
        agentName: 'worker',
        input: 'x',
      }),
    ).toMatchObject({ outcome: 'rejected', code: 'depth-exhausted' });
    // A rejection decided before registration leaves no audit entry.
    expect(auditTypes(fixture.audits)).toEqual(['child.started', 'child.started', 'child.started']);
  });

  it('checks and budgets nothing against a top-level parent, which holds no grant', async () => {
    const fixture = createFixture({ delegation });

    // The requested authority becomes the child's ceilings as given; nothing narrows it.
    const lead = await fixture.topology.children.dispatch({
      parentRunId: 'parent-1',
      agentName: 'worker',
      input: 'x',
      childRunId: 'lead',
      authority: {
        depth: 5,
        budget: { concurrentChildren: 1 },
        capabilities: { admin: true },
        disclosurePolicy: 'full',
      },
    });
    expect(lead).toMatchObject({
      outcome: 'started',
      grant: { depth: 5, budget: { concurrentChildren: 1 } },
    });
    const leadGrant = await grantOf(fixture, 'lead');
    expect(leadGrant.effectiveCapabilities).toEqual({ admin: true });

    // No grant sits above the top-level parent, so its own fan-out is unbounded,
    // and a child dispatched without `authority.depth` gets `depth: 0`.
    for (const childRunId of ['child-b', 'child-c', 'child-d']) {
      expect(
        await fixture.topology.children.dispatch({
          parentRunId: 'parent-1',
          agentName: 'worker',
          input: 'x',
          childRunId,
        }),
      ).toMatchObject({ outcome: 'started', grant: { depth: 0 } });
    }
    fixture.parents['child-b'] = { agentName: 'worker', live: true };
    expect(
      await fixture.topology.children.dispatch({
        parentRunId: 'child-b',
        agentName: 'worker',
        input: 'x',
      }),
    ).toMatchObject({ outcome: 'rejected', code: 'depth-exhausted' });
  });

  it('serializes sibling reservations and releases a slot when a child settles', async () => {
    const fixture = createFixture({
      delegation,
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'child-a': { agentName: 'worker', live: true },
      },
    });
    await startedChild(fixture, {
      childRunId: 'child-a',
      authority: { depth: 2, budget: { concurrentChildren: 1, totalDescendants: 2 } },
    });
    const sibling = (childRunId: string) =>
      fixture.topology.children.dispatch({
        parentRunId: 'child-a',
        agentName: 'worker',
        input: 'x',
        childRunId,
      });

    const [first, second] = await Promise.all([sibling('sibling-1'), sibling('sibling-2')]);
    expect([first.outcome, second.outcome].toSorted()).toEqual(['rejected', 'started']);
    const winner = first.outcome === 'started' ? 'sibling-1' : 'sibling-2';

    fixture.runs.get(winner)?.complete();
    await settledChild(fixture, winner, 'child-a');
    const third = await sibling('sibling-3');
    expect(third.outcome).toBe('started');
    fixture.runs.get('sibling-3')?.complete();
    await settledChild(fixture, 'sibling-3', 'child-a');
    expect(await sibling('sibling-4')).toMatchObject({
      outcome: 'rejected',
      code: 'budget-exhausted',
      reason: expect.stringContaining('totalDescendants'),
    });
  });

  it('answers a racing retry of the same child as a duplicate without freeing the child’s slot', async () => {
    for (const concurrentChildren of [1, 2]) {
      const fixture = createFixture({
        delegation,
        parents: {
          'parent-1': { agentName: 'planner', live: true },
          'child-a': { agentName: 'worker', live: true },
        },
      });
      await startedChild(fixture, {
        childRunId: 'child-a',
        authority: { depth: 1, budget: { concurrentChildren } },
      });
      const nested = (childRunId: string) =>
        fixture.topology.children.dispatch({
          parentRunId: 'child-a',
          agentName: 'worker',
          input: 'x',
          childRunId,
        });

      const outcomes = await Promise.all([nested('retried'), nested('retried')]);

      expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['started', 'duplicate']);
      expect(fixture.starts.filter((start) => start.childRunId === 'retried')).toHaveLength(1);
      const parentGrantId = (await fixture.store.get('child-a'))!.grantId!;
      const ledger = await fixture.store.listLedger(parentGrantId);
      expect(
        ledger
          .filter((entry) => entry.childRunId === 'retried')
          .map((entry) => `${entry.kind}:${entry.dimension}`)
          .toSorted(),
      ).toEqual(['reserve:concurrentChildren', 'reserve:totalDescendants']);
      // `retried` still holds its slot, so the ceiling admits exactly the rest.
      for (let sibling = 1; sibling < concurrentChildren; sibling++) {
        expect(await nested(`sibling-${sibling}`)).toMatchObject({ outcome: 'started' });
      }
      expect(await nested('one-too-many')).toMatchObject({
        outcome: 'rejected',
        code: 'budget-exhausted',
      });
    }
  });

  it('releases only its own reservation when another process registers the same child first', async () => {
    const base = createChildTopologyStore(textValueStore(new MemoryStorage()));
    let winner: BureauChildRecord | undefined;
    const racing: ChildTopologyStore = {
      ...base,
      async register(record) {
        if (record.childRunId === 'contested' && winner === undefined) {
          // The other process's attempt: its own grant, its own reservation, registered first.
          winner = { ...record, grantId: 'delegation:winner' };
          await base.appendLedgerEntry({
            grantId: record.parentGrantId!,
            childRunId: 'contested',
            childGrantId: 'delegation:winner',
            kind: 'reserve',
            dimension: 'concurrentChildren',
            amount: 1,
            at: 0,
          });
          await base.register(winner);
        }
        return base.register(record);
      },
    };
    const parents = {
      'parent-1': { agentName: 'planner', live: true },
      'child-a': { agentName: 'worker', live: true },
    };
    const fixture = createFixture({ delegation, store: racing, parents });
    await startedChild(fixture, {
      childRunId: 'child-a',
      authority: { depth: 1, budget: { concurrentChildren: 1 } },
    });

    const lost = await fixture.topology.children.dispatch({
      parentRunId: 'child-a',
      agentName: 'worker',
      input: 'x',
      childRunId: 'contested',
    });

    expect(lost).toEqual({ outcome: 'duplicate', child: winner! });
    expect(fixture.starts.filter((start) => start.childRunId === 'contested')).toEqual([]);
    // A process that reads the ledger afresh still sees the winner's slot taken.
    const restarted = createFixture({ delegation, store: base, parents });
    expect(
      await restarted.topology.children.dispatch({
        parentRunId: 'child-a',
        agentName: 'worker',
        input: 'x',
        childRunId: 'late-sibling',
      }),
    ).toMatchObject({ outcome: 'rejected', code: 'budget-exhausted' });
  });

  it('counts a grandchild against every ancestor’s totalDescendants', async () => {
    const fixture = createFixture({
      delegation,
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'child-a': { agentName: 'worker', live: true },
        'grandchild-a': { agentName: 'worker', live: true },
      },
    });
    await startedChild(fixture, {
      childRunId: 'child-a',
      authority: { depth: 3, budget: { totalDescendants: 1 } },
    });
    await startedChild(fixture, { parentRunId: 'child-a', childRunId: 'grandchild-a' });

    expect(
      await fixture.topology.children.dispatch({
        parentRunId: 'grandchild-a',
        agentName: 'worker',
        input: 'x',
      }),
    ).toMatchObject({ outcome: 'rejected', code: 'budget-exhausted' });
  });

  it('denies a dispatch under a revoked, expired, missing, or unverifiable parent grant', async () => {
    const setup = async () => {
      const fixture = createFixture({
        delegation,
        parents: {
          'parent-1': { agentName: 'planner', live: true },
          'child-a': { agentName: 'worker', live: true },
        },
      });
      await startedChild(fixture, { childRunId: 'child-a', authority: { depth: 1 } });
      const record = (await fixture.store.get('child-a'))!;
      const load = await fixture.store.loadGrant(record.grantId!);
      const grant = load.status === 'found' ? load.grant : undefined;
      const nested = (target = fixture) =>
        target.topology.children.dispatch({
          parentRunId: 'child-a',
          agentName: 'worker',
          input: 'x',
        });
      return { fixture, record, grant: grant!, nested };
    };

    const expired = await setup();
    await expired.fixture.runtime.advance(1_000);
    expect(await expired.nested()).toMatchObject({
      outcome: 'rejected',
      code: 'delegation-invalid',
      reason: expect.stringContaining('expired'),
    });

    const revoked = await setup();
    await revoked.fixture.store.replaceGrant(
      revoked.grant,
      revokeDelegationGrant(revoked.grant, SECRET),
    );
    expect(await revoked.nested()).toMatchObject({ reason: expect.stringContaining('revoked') });

    const missing = await setup();
    await missing.fixture.store.update(missing.record, {
      ...missing.record,
      grantId: 'delegation:missing',
    });
    expect(await missing.nested()).toMatchObject({ reason: expect.stringContaining('missing') });

    const withoutSecret = await setup();
    const restarted = createFixture({
      store: withoutSecret.fixture.store,
      parents: { 'child-a': { agentName: 'worker', live: true } },
    });
    expect(await withoutSecret.nested(restarted)).toMatchObject({
      outcome: 'rejected',
      code: 'delegation-invalid',
      reason: expect.stringContaining('without a delegation secret'),
    });
    expect(restarted.starts).toHaveLength(0);
  });

  it.each([
    ['a non-positive lifetime', { timeToLiveMilliseconds: 0 }],
    ['a negative budget', { budget: { steps: -1 } }],
    ['a malformed capability', { capabilities: { tools: 'read' } }],
    ['an unknown disclosure policy', { disclosurePolicy: 'loud' }],
  ])('rejects %s as a bad request', async (_label, authority) => {
    const fixture = createFixture({ delegation });

    expect(
      await throwingRejectionOf(
        fixture.topology.children.dispatch({
          parentRunId: 'parent-1',
          agentName: 'worker',
          input: 'x',
          authority: authority as never,
        }),
      ),
    ).toThrow('BAD_REQUEST');
  });

  it('rolls a reservation back when its ledger write fails', async () => {
    const store = createChildTopologyStore(textValueStore(new MemoryStorage()));
    let failLedger = false;
    const fixture = createFixture({
      delegation,
      store: {
        ...store,
        appendLedgerEntry: (entry) =>
          failLedger ? Promise.reject(new Error('ledger offline')) : store.appendLedgerEntry(entry),
      },
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'child-a': { agentName: 'worker', live: true },
      },
    });
    await startedChild(fixture, {
      childRunId: 'child-a',
      authority: { depth: 1, budget: { concurrentChildren: 1 } },
    });

    failLedger = true;
    expect(
      await throwingRejectionOf(
        fixture.topology.children.dispatch({
          parentRunId: 'child-a',
          agentName: 'worker',
          input: 'x',
        }),
      ),
    ).toThrow('ledger offline');
    failLedger = false;
    expect(
      await fixture.topology.children.dispatch({
        parentRunId: 'child-a',
        agentName: 'worker',
        input: 'x',
      }),
    ).toMatchObject({ outcome: 'started' });
  });

  it('lets a retry that waited on a failed dispatch of the same child go ahead on its own', async () => {
    const store = createChildTopologyStore(textValueStore(new MemoryStorage()));
    let ledgerFailures = 0;
    const fixture = createFixture({
      delegation,
      store: {
        ...store,
        appendLedgerEntry: (entry) =>
          entry.childRunId === 'retried' && ledgerFailures++ === 0
            ? Promise.reject(new Error('ledger offline'))
            : store.appendLedgerEntry(entry),
      },
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'child-a': { agentName: 'worker', live: true },
      },
    });
    await startedChild(fixture, {
      childRunId: 'child-a',
      authority: { depth: 1, budget: { concurrentChildren: 1 } },
    });
    const nested = () =>
      fixture.topology.children.dispatch({
        parentRunId: 'child-a',
        agentName: 'worker',
        input: 'x',
        childRunId: 'retried',
      });

    const [first, retry] = await Promise.allSettled([nested(), nested()]);

    expect(first).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'ledger offline' }),
    });
    expect(retry).toMatchObject({ status: 'fulfilled', value: { outcome: 'started' } });
    expect(fixture.starts.filter((start) => start.childRunId === 'retried')).toHaveLength(1);
  });

  it('retries a counter load after a failed ledger read, and diagnoses a failed release', async () => {
    const store = createChildTopologyStore(textValueStore(new MemoryStorage()));
    let failList = false;
    let failAppend = false;
    const fixture = createFixture({
      delegation,
      store: {
        ...store,
        listLedger: (grantId) =>
          failList ? Promise.reject(new Error('ledger unreadable')) : store.listLedger(grantId),
        appendLedgerEntry: (entry) =>
          failAppend && entry.kind === 'release'
            ? Promise.reject(new Error('release lost'))
            : store.appendLedgerEntry(entry),
      },
      parents: {
        'parent-1': { agentName: 'planner', live: true },
        'child-a': { agentName: 'worker', live: true },
      },
    });
    await startedChild(fixture, { childRunId: 'child-a', authority: { depth: 1 } });
    const nested = (childRunId: string) =>
      fixture.topology.children.dispatch({
        parentRunId: 'child-a',
        agentName: 'worker',
        input: 'x',
        childRunId,
      });

    failList = true;
    expect(await throwingRejectionOf(nested('first'))).toThrow('ledger unreadable');
    failList = false;
    const second = await nested('second');
    expect(second.outcome).toBe('started');

    failAppend = true;
    fixture.runs.get('second')?.complete();
    await settledChild(fixture, 'second', 'child-a');
    expect(fixture.diagnostics.map((entry) => entry.message).join('\n')).toContain('release lost');
  });

  describe('on recovery', () => {
    async function recoverWith(
      options: {
        tamper?: (grant: DelegationGrant) => DelegationGrant;
        parentState?: 'running' | null;
        delegationAtRestart?: typeof delegation | undefined;
        dropGrant?: boolean;
        parentCancellation?: 'cascade' | 'detach';
      } = {},
    ) {
      const engine = createFakeEngine();
      const first = createFixture({
        delegation,
        engine,
        parents: {
          'parent-1': { agentName: 'planner', live: true },
          'child-a': { agentName: 'worker', live: true },
        },
      });
      await startedChild(first, {
        childRunId: 'child-a',
        authority: { depth: 1, budget: { concurrentChildren: 2 } },
        parentCancellation: options.parentCancellation ?? 'cascade',
      });
      // One grandchild settled cleanly before the crash, so its release is already recorded.
      await startedChild(first, { parentRunId: 'child-a', childRunId: 'released-grandchild' });
      first.runs.get('released-grandchild')?.complete();
      await settledChild(first, 'released-grandchild', 'child-a');
      await startedChild(first, { parentRunId: 'child-a', childRunId: 'finished-grandchild' });
      await startedChild(first, { parentRunId: 'child-a', childRunId: 'running-grandchild' });
      // The crash lands after the grandchild finished but before its release was written.
      const finished = await first.store.get('finished-grandchild');
      await first.store.update(finished!, { ...finished!, status: 'completed' });
      const record = await first.store.get('child-a');
      const load = await first.store.loadGrant(record!.grantId!);
      const grant = load.status === 'found' ? load.grant : undefined;
      // …and another process's attempt at the running grandchild reserved a slot,
      // lost the registration race, and died before giving the slot back.
      await first.store.appendLedgerEntry({
        grantId: grant!.id,
        childRunId: 'running-grandchild',
        childGrantId: 'delegation:lost-attempt',
        kind: 'reserve',
        dimension: 'concurrentChildren',
        amount: 1,
        at: 0,
      });
      if (options.tamper && grant) await first.store.replaceGrant(grant, options.tamper(grant));
      if (options.dropGrant)
        await first.kv.delete(`bureau-delegation:grant:${encodeURIComponent(grant!.id)}`);
      if (options.parentState !== null) {
        engine.states.set('parent-1', workflowState('parent-1', options.parentState ?? 'running'));
      }
      for (const id of ['child-a', 'running-grandchild']) {
        engine.states.set(id, workflowState(id, 'running'));
      }

      const second = createFixture({
        store: first.store,
        engine,
        ...(options.delegationAtRestart === undefined && 'delegationAtRestart' in options
          ? {}
          : { delegation: options.delegationAtRestart ?? delegation }),
      });
      await second.topology.prepareRecovery();
      await second.topology.reconcileRecovery();
      await second.topology.drain();
      return { second, grant: grant!, engine };
    }

    it('re-verifies the grant, reconciles its ledger, and only then reattaches', async () => {
      const { second, grant } = await recoverWith();

      expect(await second.store.get('child-a')).toMatchObject({ status: 'running', recoveries: 1 });
      const ledger = await second.store.listLedger(grant.id);
      expect(ledger).toContainEqual(
        expect.objectContaining({ childRunId: 'finished-grandchild', kind: 'release' }),
      );
      const runningGrandchild = await second.store.get('running-grandchild');
      expect(ledger).not.toContainEqual(
        expect.objectContaining({
          childRunId: 'running-grandchild',
          childGrantId: runningGrandchild!.grantId,
          kind: 'release',
        }),
      );
      expect(ledger).toContainEqual(
        expect.objectContaining({
          childRunId: 'running-grandchild',
          childGrantId: 'delegation:lost-attempt',
          kind: 'release',
        }),
      );
      // One live grandchild holds one of two slots after reconciliation.
      const parents = { 'child-a': { agentName: 'worker', live: true } };
      Object.assign(second.parents, parents);
      const third = await second.topology.children.dispatch({
        parentRunId: 'child-a',
        agentName: 'worker',
        input: 'x',
        childRunId: 'third',
      });
      expect(third.outcome).toBe('started');
      expect(
        await second.topology.children.dispatch({
          parentRunId: 'child-a',
          agentName: 'worker',
          input: 'x',
        }),
      ).toMatchObject({ code: 'budget-exhausted' });
    });

    it.each([
      [
        'tampered',
        { tamper: (grant: DelegationGrant) => ({ ...grant, budget: { concurrentChildren: 50 } }) },
        'invalid-signature',
      ],
      ['missing', { dropGrant: true }, 'missing'],
      ['unverifiable', { delegationAtRestart: undefined }, 'delegation-unavailable'],
    ] as const)('denies and cancels a child whose grant is %s', async (_label, options, code) => {
      const { second } = await recoverWith(options);

      expect(await second.store.get('child-a')).toMatchObject({ status: 'aborted' });
      expect(second.audits).toContainEqual(
        expect.objectContaining({
          type: 'delegation.rejected',
          runId: 'child-a',
          detail: expect.objectContaining({ code }),
        }),
      );
    });

    it('denies a child whose grant expired while the process was down', async () => {
      const engine = createFakeEngine();
      const first = createFixture({ delegation, engine });
      await startedChild(first, { childRunId: 'child-a' });
      engine.states.set('parent-1', workflowState('parent-1', 'running'));
      engine.states.set('child-a', workflowState('child-a', 'running'));
      const second = createFixture({ store: first.store, engine, delegation });
      await second.runtime.advance(5_000);

      await second.topology.prepareRecovery();
      await second.topology.reconcileRecovery();

      expect(await statusOf(second.store, 'child-a')).toBe('aborted');
      expect(second.audits).toContainEqual(
        expect.objectContaining({
          type: 'delegation.rejected',
          detail: expect.objectContaining({ code: 'expired' }),
        }),
      );
    });

    it.each(['cascade', 'detach'] as const)(
      'fences the grant of a %s child whose parent cannot be recovered, and cancels it',
      async (parentCancellation) => {
        const { second, grant } = await recoverWith({ parentState: null, parentCancellation });

        expect(await second.store.get('child-a')).toMatchObject({
          status: 'aborted',
          parentCancellation,
          outcome: { reason: expect.stringContaining('revoked on recovery') },
        });
        const load = await second.store.loadGrant(grant.id);
        expect(
          load.status === 'found' && verifyDelegationGrant(load.grant, SECRET, 0),
        ).toMatchObject({
          valid: false,
          code: 'revoked',
        });
        expect(second.audits).toContainEqual(
          expect.objectContaining({
            type: 'delegation.revoked',
            detail: expect.objectContaining({ reason: 'revoked-on-recovery' }),
          }),
        );
        // The fenced child's own children follow its cascade.
        expect(await statusOf(second.store, 'running-grandchild')).toBe('aborted');
      },
    );
  });
});
