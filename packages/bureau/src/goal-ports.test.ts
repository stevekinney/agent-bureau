/**
 * COR-851 — the goal workflow's ports: what Bureau answers when the controller
 * asks it to start an attempt, run the validator, or stop a run.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createActiveRun,
  createAgentSession,
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
  createSessionStore,
  type DurableActiveRunContext,
  type FreshAttemptSourceResolver,
  type GoalConversationPolicy,
  type GoalWorkflowPorts,
  isDeadlineElapsed,
  type RunOptions,
  startDurableRunResult,
  stopWhen,
  type Validator,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import {
  GoalAttemptInvalidCostEstimationError,
  GoalAttemptNotDurableCapableError,
  type GoalAttemptRun,
  type GoalAttemptStart,
  GoalAttemptTombstonedError,
} from './bureau-catalog-dispatch';
import { createGoalConversations } from './goal-conversation';
import type { AttemptForwarder, AttemptTarget } from './goal-forwarder';
import {
  createGoalPorts,
  createGoalWorkflowHost,
  goalIdentifiers,
  GoalPortsUnboundError,
} from './goal-ports';
import {
  createGoalState,
  goalAttemptId,
  goalAttemptRunId,
  goalDecisionId,
  goalTransitionId,
} from './goal-state';
import { createGoalStore, type GoalStore } from './goal-store';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import type { CatalogRunRecoveryRecord } from './runtime-composition';
import { isSessionAuthorityAuthorized } from './session-authority';
import { freshHandoff, pollUntil, transcriptOf } from './testing/goal-fixtures.test-support';
import { throwingRejectionOf } from './testing/promise-outcome.test-support.ts';

const NOW = '2026-10-02T12:00:00.000Z';
const CHECK = { name: 'check', version: '1' } as const;

describe('createGoalWorkflowHost', () => {
  const request = { goalRunId: 'g1' };

  it('fails every port loudly until the real ports are bound, then forwards to them', async () => {
    const host = createGoalWorkflowHost();
    const calls: string[] = [];
    const unbound = await Promise.allSettled([
      host.ports.loadGoalState('g1'),
      host.ports.commitTransition({} as never),
      host.ports.startAttempt({} as never),
      host.ports.runValidator({} as never),
      host.ports.abortAttempt({} as never),
    ]);
    for (const outcome of unbound) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(GoalPortsUnboundError);
    }

    host.bind({
      identifiers: goalIdentifiers,
      loadGoalState: (id) => {
        calls.push(`load:${id}`);
        return Promise.resolve({ record: undefined, nowMs: 1 });
      },
      commitTransition: () => Promise.resolve({ status: 'applied' }),
      startAttempt: () => Promise.resolve({ status: 'started', sessionId: 's' }),
      runValidator: () => Promise.reject(new Error('unused')),
      abortAttempt: () => Promise.resolve(),
    });

    expect(await host.ports.loadGoalState(request.goalRunId)).toEqual({
      record: undefined,
      nowMs: 1,
    });
    expect(await host.ports.commitTransition({} as never)).toEqual({ status: 'applied' });
    expect(calls).toEqual(['load:g1']);
  });

  it('names the deterministic ids the store keys its records by', () => {
    expect(goalIdentifiers.transitionId('g1', 4)).toBe(goalTransitionId('g1', 4));
    expect(goalIdentifiers.attemptId('g1', 2)).toBe('g1:a2');
    expect(goalIdentifiers.attemptRunId('g1', 2)).toBe('goal-g1-a2');
    expect(goalIdentifiers.decisionId('g1:a2')).toBe('g1:a2:decision');
  });
});

// ---------------------------------------------------------------------------
// The ports over a real engine and store
// ---------------------------------------------------------------------------

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function agentOptions(generate: RunOptions['generate']): RunOptions {
  return {
    generate,
    toolbox: createToolbox([]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
  };
}

interface WorldOptions {
  readonly validators?: readonly Validator[];
  readonly plan?: { durable: boolean; agentVersion: string } | undefined;
  readonly startAttemptRun?: Parameters<typeof createGoalPorts>[0]['startAttemptRun'];
  readonly cancelRun?: Parameters<typeof createGoalPorts>[0]['cancelRun'];
  readonly fenceAttempt?: Parameters<typeof createGoalPorts>[0]['fenceAttempt'];
  readonly policy?: GoalConversationPolicy;
  readonly resolveCostEstimation?: Parameters<typeof createGoalPorts>[0]['resolveCostEstimation'];
  readonly instructions?: string;
  /** The ports see no durable engine, as a bureau built without one would. */
  readonly withoutEngine?: boolean;
  readonly resolveFreshAttemptSource?: FreshAttemptSourceResolver;
  /**
   * Runs at the start of every read of a run's recovery record, with the number
   * of reads so far (1 for the first), so a test can change what the next read
   * finds at a precise point: after the start port verified the record and
   * before it adopted the run.
   */
  readonly onRunRecordRead?: (readNumber: number, runId: string) => void;
  /** A clock the test shares with the artifact it builds; a fresh manual one otherwise. */
  readonly runtime?: ReturnType<typeof createManualRuntimeServices>;
  readonly bounds?: {
    maximumAttempts: number;
    maximumTotalSteps?: number;
    maximumTotalCostUsd?: number;
    maximumTotalDurationMs?: number;
  };
}

async function world(options: WorldOptions = {}) {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const { engine } = await createRunEngine({
    storage,
    runWorkflow: createRunWorkflow(checkpointStore),
    recover: false,
  });
  disposers.push(() => engine[Symbol.dispose]());
  // A read that fails for as many calls as `checkpointReadFaults.remaining` says.
  const checkpointReadFaults = { remaining: 0 };
  const faultyCheckpointStore = new Proxy(checkpointStore, {
    get(target, property) {
      if (property === 'loadCheckpoint') {
        return (...loadArguments: Parameters<typeof target.loadCheckpoint>) => {
          if (checkpointReadFaults.remaining > 0) {
            checkpointReadFaults.remaining -= 1;
            return Promise.reject(new Error('storage hiccup'));
          }
          return target.loadCheckpoint(...loadArguments);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value.bind(target) as unknown) : value;
    },
  });
  const durable: DurableActiveRunContext = { engine, checkpointStore: faultyCheckpointStore };
  const store: GoalStore = createGoalStore(textValueStore(new MemoryStorage()));
  await store.create(
    createGoalState({
      goalRunId: 'g1',
      identity: { name: 'goal', version: '1' },
      objective: {
        agentName: 'worker',
        prompt: 'work',
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      },
      validator: CHECK,
      conversationPolicy: options.policy ?? { kind: 'continue' },
      retryPolicy: { retryOn: ['validator-fail-retryable'] },
      bounds: options.bounds ?? { maximumAttempts: 3, maximumTotalSteps: 10 },
      principal: 'alice',
      now: NOW,
    }),
  );
  const watched: Array<{ target: AttemptTarget; live: unknown }> = [];
  const fenced: string[] = [];
  const forwarder: AttemptForwarder = {
    watch: (target, live) => watched.push({ target, live }),
    reconcile: () => Promise.resolve('not-needed'),
    drain: () => Promise.resolve(),
  };
  // What the dispatcher records with each goal attempt's run: whose it is.
  const runRecords = new Map<string, CatalogRunRecoveryRecord>();
  const markRunAsGoals = (runId: string, attemptIndex = 0): void => {
    runRecords.set(runId, {
      schemaVersion: 1,
      agentName: 'worker',
      definitionRevision: 1,
      input: 'work',
      principal: 'alice',
      goalAttempt: { goalRunId: 'g1', attemptIndex },
    });
  };
  // A run-record read that fails for as many calls as `runRecordReadFaults.remaining` says.
  const runRecordReadFaults = { remaining: 0 };
  const corruptRunRecords = new Set<string>();
  let runRecordReads = 0;
  const runtime = options.runtime ?? createManualRuntimeServices();
  const sessions = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
  const conversations = createGoalConversations({
    sessionStore: sessions,
    runtime,
    getDurable: () => durable,
    resolveFreshAttemptSource: options.resolveFreshAttemptSource,
  });
  const ports: GoalWorkflowPorts = createGoalPorts({
    store,
    catalog: createGoalValidatorCatalog(options.validators ?? []),
    runtime,
    forwarder,
    conversations,
    getDurable: () => (options.withoutEngine === true ? undefined : durable),
    readRunRecord: (runId) => {
      runRecordReads += 1;
      options.onRunRecordRead?.(runRecordReads, runId);
      if (runRecordReadFaults.remaining > 0) {
        runRecordReadFaults.remaining -= 1;
        return Promise.resolve({ status: 'read-error', error: new Error('storage hiccup') });
      }
      if (corruptRunRecords.has(runId)) return Promise.resolve({ status: 'corrupt' });
      const record = runRecords.get(runId);
      return Promise.resolve(
        record === undefined ? { status: 'missing' } : { status: 'found', record },
      );
    },
    planAgent: () => ('plan' in options ? options.plan : { durable: true, agentVersion: '1' }),
    startAttemptRun:
      options.startAttemptRun ??
      (() => {
        throw new Error('no attempt run was expected');
      }),
    cancelRun: options.cancelRun ?? (() => Promise.resolve({ status: 'requested' })),
    fenceAttempt:
      options.fenceAttempt ??
      ((record, attemptIndex) => {
        const runId = goalAttemptRunId(record.goalRunId, attemptIndex);
        fenced.push(runId);
        // What the runtime composition does: the claim becomes (or is created as) a tombstone.
        const claimed = runRecords.get(runId);
        runRecords.set(runId, {
          schemaVersion: 1,
          agentName: 'worker',
          definitionRevision: 1,
          input: 'work',
          principal: 'alice',
          ...claimed,
          goalAttempt: { goalRunId: record.goalRunId, attemptIndex, tombstonedAt: NOW },
        });
        return Promise.resolve('fenced');
      }),
    resolveCostEstimation: options.resolveCostEstimation ?? (() => Promise.resolve(undefined)),
  });
  return {
    fenced,
    durable,
    engine,
    store,
    ports,
    watched,
    runtime,
    sessions,
    conversations,
    checkpointReadFaults,
    runRecordReadFaults,
    corruptRunRecords,
    runRecords,
    markRunAsGoals,
  };
}

const startRequest = (feedback?: string) => ({
  goalRunId: 'g1',
  attemptIndex: feedback === undefined ? 0 : 1,
  attemptId: goalAttemptId('g1', feedback === undefined ? 0 : 1),
  runId: goalAttemptRunId('g1', feedback === undefined ? 0 : 1),
  ...(feedback === undefined ? {} : { feedback }),
});

describe('startAttempt', () => {
  it("starts the run under the attempt's deterministic id, as the goal's principal, and watches it", async () => {
    const starts: unknown[] = [];
    const live = { marker: 'live run' };
    const { ports, watched, sessions } = await world({
      startAttemptRun: (start) => {
        starts.push(start);
        return { run: live as never, durablyStarted: Promise.resolve() };
      },
    });

    const outcome = await ports.startAttempt(startRequest());

    expect(outcome).toEqual({ status: 'started', sessionId: 'goal-g1-s0' });
    expect(starts).toEqual([
      {
        agentName: 'worker',
        input: 'work',
        runId: 'goal-g1-a0',
        goalRunId: 'g1',
        attemptIndex: 0,
        principal: 'alice',
      },
    ]);
    expect(watched).toEqual([
      { target: { goalRunId: 'g1', attemptIndex: 0, runId: 'goal-g1-a0' }, live },
    ]);
    // The run is recorded in the goal's session, owned by the goal's principal.
    const session = await sessions.load('goal-g1-s0');
    expect(session?.runs.map((ref) => [ref.runId, ref.status])).toEqual([
      ['goal-g1-a0', 'running'],
    ]);
    expect(session?.metadata['lastRequestAuthority']).toMatchObject({ principalId: 'alice' });
  });

  it("adopts a run that already exists under the attempt's id instead of starting another", async () => {
    const { ports, durable, watched, markRunAsGoals } = await world();
    markRunAsGoals('goal-g1-a0');
    await startDurableRunResult(durable, {
      runId: 'goal-g1-a0',
      sessionId: 'goal-g1-a0',
      options: agentOptions(() => Promise.resolve({ content: 'done', toolCalls: [] })),
      prompt: 'work',
    });

    const outcome = await ports.startAttempt(startRequest());

    expect(outcome).toEqual({ status: 'adopted', sessionId: 'goal-g1-s0' });
    expect(watched).toHaveLength(1);
    expect(watched[0]?.live).toBeUndefined();
  });

  describe('after a crash between the attempt workflow starting and the open-attempt commit', () => {
    const catalogs = [
      ['removed from the catalog', undefined],
      ['no longer durable', { durable: false, agentVersion: '2' }],
    ] as const;

    describe.each(catalogs)('and an agent that is %s on restart', (_label, plan) => {
      it('adopts a completed attempt, records its session ref, and settles its transcript', async () => {
        const w = await world({ plan });
        w.markRunAsGoals('goal-g1-a0');
        await startDurableRunResult(w.durable, {
          runId: 'goal-g1-a0',
          sessionId: 'goal-g1-a0',
          options: agentOptions(() => Promise.resolve({ content: 'done', toolCalls: [] })),
          prompt: 'work',
        });

        const outcome = await w.ports.startAttempt(startRequest());

        expect(outcome).toEqual({ status: 'adopted', sessionId: 'goal-g1-s0' });
        expect(w.watched.map((entry) => entry.target)).toEqual([
          { goalRunId: 'g1', attemptIndex: 0, runId: 'goal-g1-a0' },
        ]);
        expect(await runsOf(w, 'goal-g1-s0')).toEqual([['goal-g1-a0', 'running']]);
        // The transcript commits without ever consulting today's catalog.
        const record = await w.store.get('g1');
        if (record === undefined) throw new Error('the goal record is missing');
        await w.conversations.settle(record, 0, 'goal-g1-a0');
        expect(await runsOf(w, 'goal-g1-s0')).toEqual([['goal-g1-a0', 'completed']]);
      });

      it('adopts a still-running attempt and starts nothing', async () => {
        const w = await world({ plan });
        w.markRunAsGoals('goal-g1-a0');
        createActiveRun(
          agentOptions(() => new Promise(() => {})),
          { ...w.durable, runId: 'goal-g1-a0', prompt: 'work' },
        );
        await pollUntil(async () => (await w.engine.get('goal-g1-a0')) !== null);

        const outcome = await w.ports.startAttempt(startRequest());

        expect(outcome).toEqual({ status: 'adopted', sessionId: 'goal-g1-s0' });
        expect(w.watched).toHaveLength(1);
        expect(w.watched[0]?.live).toBeUndefined();
        expect(await runsOf(w, 'goal-g1-s0')).toEqual([['goal-g1-a0', 'running']]);
      });
    });
  });

  it("refuses to adopt a workflow that is not the attempt's run", async () => {
    const { ports, engine, markRunAsGoals } = await world();
    markRunAsGoals('goal-g1-a0');
    await engine.start('durableHeartbeatTick', {}, { id: 'goal-g1-a0' }).catch(() => undefined);
    // Any workflow holding the id that is not an agent run's will do.
    const taken = await engine.get('goal-g1-a0');
    if (taken === null) return;

    const outcome = await ports.startAttempt(startRequest());

    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { detail: string }).detail).toContain('names a different workflow');
  });

  it('adopts the run when a concurrent start created it first, and rethrows any other failure', async () => {
    let created = false;
    const raced = await world({
      startAttemptRun: () => {
        created = true;
        throw new Error('Run "goal-g1-a0" already exists');
      },
    });
    raced.markRunAsGoals('goal-g1-a0');
    createActiveRun(
      agentOptions(() => new Promise(() => {})),
      { ...raced.durable, runId: 'goal-g1-a0', prompt: 'work' },
    );
    const original = raced.engine.get.bind(raced.engine);
    await pollUntil(async () => (await original('goal-g1-a0')) !== null);
    // The racer's workflow was not there when this start first looked, and was by the time it failed.
    let reads = 0;
    raced.engine.get = (id: string) =>
      id === 'goal-g1-a0' && reads++ === 0 ? Promise.resolve(null) : original(id);

    expect(await raced.ports.startAttempt(startRequest())).toEqual({
      status: 'adopted',
      sessionId: 'goal-g1-s0',
    });
    expect(created).toBe(true);

    const broken = await world({
      startAttemptRun: () => {
        throw new Error('storage is down');
      },
    });
    expect(await throwingRejectionOf(broken.ports.startAttempt(startRequest()))).toThrow(
      'storage is down',
    );
  });

  it("does not answer until the attempt's workflow is durably started", async () => {
    const started = Promise.withResolvers<void>();
    const { ports, watched } = await world({
      startAttemptRun: () => ({
        run: { marker: 'live' } as never,
        durablyStarted: started.promise,
      }),
    });

    const answer = ports.startAttempt(startRequest());
    let answered = false;
    void answer.then(() => {
      answered = true;
    });
    // Drain every microtask the start could use to answer early.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(answered).toBe(false);
    expect(watched).toEqual([]);

    started.resolve();
    expect(await answer).toEqual({ status: 'started', sessionId: 'goal-g1-s0' });
    expect(watched).toHaveLength(1);
  });

  it('fails the activity when the workflow could not be started, instead of leaving the goal waiting for it', async () => {
    const { ports, watched } = await world({
      startAttemptRun: () => ({
        run: {} as never,
        durablyStarted: Promise.reject(new Error('recovery record write failed')),
      }),
    });

    expect(await throwingRejectionOf(ports.startAttempt(startRequest()))).toThrow(
      'recovery record write failed',
    );
    expect(watched).toEqual([]);
  });

  describe('adopting only a run whose record is read as the goal’s own at the point of adoption', () => {
    const runId = 'goal-g1-a0';
    // What replaces the goal's own claim after the start port verified it.
    const replacements: Array<
      [
        string,
        (w: {
          runRecords: Map<string, CatalogRunRecoveryRecord>;
          corruptRunRecords: Set<string>;
        }) => void,
        string,
      ]
    > = [
      [
        'a claim held by another agent',
        (w) => w.runRecords.set(runId, { ...w.runRecords.get(runId)!, agentName: 'intruder' }),
        'was not started for this goal attempt',
      ],
      [
        'a claim held by another principal',
        (w) => w.runRecords.set(runId, { ...w.runRecords.get(runId)!, principal: 'mallory' }),
        'was not started for this goal attempt',
      ],
      [
        'a claim marked for another goal',
        (w) =>
          w.runRecords.set(runId, {
            ...w.runRecords.get(runId)!,
            goalAttempt: { goalRunId: 'g2', attemptIndex: 0 },
          }),
        'was not started for this goal attempt',
      ],
      [
        'a claim that is not a valid record',
        (w) => w.corruptRunRecords.add(runId),
        'corrupt-ownership-record',
      ],
      ['no claim at all', (w) => w.runRecords.delete(runId), 'not started by a goal'],
    ];

    it.each(replacements)(
      'fails the attempt, adopting and watching nothing, when %s appears after verification',
      async (_label, replace, detail) => {
        const w: Awaited<ReturnType<typeof world>> = await world({
          onRunRecordRead: (readNumber) => {
            // The first read is the start port's verification; the next is adoption's.
            if (readNumber === 2) replace(w);
          },
        });
        w.markRunAsGoals(runId);
        await startDurableRunResult(w.durable, {
          runId,
          sessionId: runId,
          options: agentOptions(() => Promise.resolve({ content: 'done', toolCalls: [] })),
          prompt: 'work',
        });

        const outcome = await w.ports.startAttempt(startRequest());

        expect(outcome).toMatchObject({ status: 'failed' });
        expect((outcome as { detail: string }).detail).toContain(detail);
        expect(w.watched).toEqual([]);
      },
    );

    it.each(replacements)(
      'does not adopt the run a racing start created when %s appears after verification',
      async (_label, replace, detail) => {
        const raced: Awaited<ReturnType<typeof world>> = await world({
          startAttemptRun: () => {
            throw new Error('Run "goal-g1-a0" already exists');
          },
          onRunRecordRead: (readNumber) => {
            // Verification is read 1; adoption before the start finds no workflow and reads
            // nothing; the raced adoption after the failed start is read 2.
            if (readNumber === 2) replace(raced);
          },
        });
        raced.markRunAsGoals(runId);
        createActiveRun(
          agentOptions(() => new Promise(() => {})),
          { ...raced.durable, runId, prompt: 'work' },
        );
        const original = raced.engine.get.bind(raced.engine);
        await pollUntil(async () => (await original(runId)) !== null);
        let reads = 0;
        raced.engine.get = (id: string) =>
          id === runId && reads++ === 0 ? Promise.resolve(null) : original(id);

        const outcome = await raced.ports.startAttempt(startRequest());

        expect(outcome).toMatchObject({ status: 'failed' });
        expect((outcome as { detail: string }).detail).toContain(detail);
        expect(raced.watched).toEqual([]);
      },
    );
  });

  it('adopts the run when the deferred start failed because a concurrent start created it', async () => {
    const racer = await world({
      startAttemptRun: () => ({
        run: {} as never,
        durablyStarted: Promise.reject(new Error('Run "goal-g1-a0" already exists')),
      }),
    });
    // The racing start claimed the run's recovery record before it created the run.
    racer.markRunAsGoals('goal-g1-a0');
    createActiveRun(
      agentOptions(() => new Promise(() => {})),
      { ...racer.durable, runId: 'goal-g1-a0', prompt: 'work' },
    );
    const original = racer.engine.get.bind(racer.engine);
    await pollUntil(async () => (await original('goal-g1-a0')) !== null);
    let reads = 0;
    racer.engine.get = (id: string) =>
      id === 'goal-g1-a0' && reads++ === 0 ? Promise.resolve(null) : original(id);

    expect(await racer.ports.startAttempt(startRequest())).toEqual({
      status: 'adopted',
      sessionId: 'goal-g1-s0',
    });
  });

  it('starts nothing for a goal whose cancellation is already recorded', async () => {
    let starts = 0;
    const { ports, store, watched } = await world({
      startAttemptRun: () => {
        starts += 1;
        return { run: {} as never, durablyStarted: Promise.resolve() };
      },
    });
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);

    const outcome = await ports.startAttempt(startRequest());

    expect(outcome).toEqual({ status: 'stood-down' });
    expect(starts).toBe(0);
    expect(watched).toEqual([]);
  });

  it('stops the run it just created when a cancellation was recorded while it was starting', async () => {
    const started = Promise.withResolvers<void>();
    const stopped: string[] = [];
    const requested = Promise.withResolvers<void>();
    const { ports, store, watched } = await world({
      startAttemptRun: () => {
        requested.resolve();
        return { run: {} as never, durablyStarted: started.promise };
      },
      cancelRun: (runId) => {
        stopped.push(runId);
        return Promise.resolve({ status: 'requested' });
      },
    });

    const answer = ports.startAttempt(startRequest());
    // The canceller wrote its marker while the workflow was still being created.
    await requested.promise;
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    started.resolve();

    const outcome = await answer;
    expect(outcome).toEqual({ status: 'stood-down' });
    expect(stopped).toEqual(['goal-g1-a0']);
    expect(watched).toEqual([]);
  });

  it('fails the attempt, not the controller, when the agent is gone or cannot run durably', async () => {
    const gone = await world({ plan: undefined });
    expect(await gone.ports.startAttempt(startRequest())).toEqual({
      status: 'failed',
      detail: 'Starting the inner run failed: agent "worker" is no longer in the catalog',
    });

    const inProcess = await world({ plan: { durable: false, agentVersion: '1' } });
    expect(await inProcess.ports.startAttempt(startRequest())).toEqual({
      status: 'failed',
      detail:
        'Starting the inner run failed: agent "worker" cannot run durably (agent-not-durable-capable)',
    });
  });

  it('throws, rather than recording a verdict, when a durable agent finds no durable engine', async () => {
    const { ports } = await world({ withoutEngine: true });
    expect(await throwingRejectionOf(ports.startAttempt(startRequest()))).toThrow(
      'no durable engine',
    );
  });

  it.each([
    [
      'rejects the deferred start',
      () => ({
        run: {} as never,
        durablyStarted: Promise.reject(new GoalAttemptNotDurableCapableError('lazy agent')),
      }),
    ],
    [
      'throws while starting',
      () => {
        throw new GoalAttemptNotDurableCapableError('lazy agent');
      },
    ],
  ])(
    'ends the attempt with agent-not-durable-capable when the dispatcher %s',
    async (_label, startAttemptRun) => {
      const { ports, watched } = await world({ startAttemptRun });
      expect(await ports.startAttempt(startRequest())).toEqual({
        status: 'failed',
        detail: 'Starting the inner run failed: agent-not-durable-capable: lazy agent',
      });
      expect(watched).toEqual([]);
    },
  );

  it('ends the attempt with invalid-cost-estimation instead of retrying an estimator that cannot be persisted', async () => {
    const { ports, watched } = await world({
      startAttemptRun: () => ({
        run: {} as never,
        durablyStarted: Promise.reject(new GoalAttemptInvalidCostEstimationError('has a cycle')),
      }),
    });

    expect(await ports.startAttempt(startRequest())).toEqual({
      status: 'failed',
      detail: 'Starting the inner run failed: invalid-cost-estimation: has a cycle',
    });
    expect(watched).toEqual([]);
  });

  describe('a cancellation landing between the first read and each write', () => {
    // Requests the cancellation as the Nth read of the attempt's session begins.
    const cancelOnSessionRead = async (nth: number, options: Parameters<typeof world>[0] = {}) => {
      const w = await world(options);
      const original = w.sessions.load.bind(w.sessions);
      let reads = 0;
      w.sessions.load = async (id: string) => {
        reads += 1;
        if (reads === nth) await w.store.requestCancellation('g1', { requestedAt: NOW }, NOW);
        return original(id);
      };
      return { ...w, original };
    };

    it('writes no session and starts no run when it lands before the session is seated', async () => {
      let starts = 0;
      const w = await cancelOnSessionRead(1, {
        startAttemptRun: () => {
          starts += 1;
          return { run: {} as never, durablyStarted: Promise.resolve() };
        },
      });
      const outcome = await w.ports.startAttempt(startRequest());
      expect(outcome).toEqual({ status: 'stood-down' });
      expect(starts).toBe(0);
      expect(await w.original('goal-g1-s0')).toBeUndefined();
    });

    it('starts no run when it lands after the session is seated', async () => {
      let starts = 0;
      const w = await cancelOnSessionRead(2, {
        startAttemptRun: () => {
          starts += 1;
          return { run: {} as never, durablyStarted: Promise.resolve() };
        },
      });
      const outcome = await w.ports.startAttempt(startRequest());
      expect(outcome).toEqual({ status: 'stood-down' });
      expect(starts).toBe(0);
      expect(w.watched).toEqual([]);
    });

    it('does not write the session reference when it lands before an adopted run is recorded', async () => {
      const w = await cancelOnSessionRead(1);
      w.markRunAsGoals('goal-g1-a0');
      await startDurableRunResult(w.durable, {
        runId: 'goal-g1-a0',
        sessionId: 'goal-g1-a0',
        options: agentOptions(() => Promise.resolve({ content: 'done', toolCalls: [] })),
        prompt: 'work',
      });
      const outcome = await w.ports.startAttempt(startRequest());
      expect(outcome).toEqual({ status: 'stood-down' });
      expect(w.watched).toEqual([]);
      expect(await w.original('goal-g1-s0')).toBeUndefined();
    });
  });

  describe('a try Weft timed out, still running in the background', () => {
    const timedOutSignal = () => {
      const controller = new AbortController();
      return { controller, signal: controller.signal };
    };

    it('writes nothing and starts no run when its signal fired before the start', async () => {
      let starts = 0;
      const { controller, signal } = timedOutSignal();
      controller.abort();
      const w = await world({
        startAttemptRun: () => {
          starts += 1;
          return { run: {} as never, durablyStarted: Promise.resolve() };
        },
      });

      expect(await w.ports.startAttempt(startRequest(), signal)).toEqual({ status: 'stood-down' });

      expect(starts).toBe(0);
      expect(w.watched).toEqual([]);
      expect(await w.sessions.load('goal-g1-s0')).toBeUndefined();
    });

    it('starts no run when its signal fires after the session is seated, before the engine start', async () => {
      let starts = 0;
      const { controller, signal } = timedOutSignal();
      const w = await world({
        startAttemptRun: () => {
          starts += 1;
          return { run: {} as never, durablyStarted: Promise.resolve() };
        },
      });
      const original = w.sessions.load.bind(w.sessions);
      let reads = 0;
      w.sessions.load = async (id: string) => {
        reads += 1;
        if (reads === 2) controller.abort();
        return original(id);
      };

      expect(await w.ports.startAttempt(startRequest(), signal)).toEqual({ status: 'stood-down' });

      expect(starts).toBe(0);
    });

    it('leaves the run it created for the retry to adopt, writing no reference and attaching no forwarder, when the goal is still live', async () => {
      const { controller, signal } = timedOutSignal();
      const stopped: string[] = [];
      const w = await world({
        cancelRun: (runId) => {
          stopped.push(runId);
          return Promise.resolve({ status: 'requested' });
        },
        startAttemptRun: () => ({
          run: {} as never,
          // The try is timed out while the engine's start is in flight, and
          // the start completes anyway.
          durablyStarted: Promise.resolve().then(() => controller.abort()),
        }),
      });

      expect(await w.ports.startAttempt(startRequest(), signal)).toEqual({ status: 'stood-down' });

      // Not stopped: a retry adopts this run, and an aborted one would read as a failed attempt.
      expect(stopped).toEqual([]);
      expect(w.fenced).toEqual([]);
      expect(w.watched).toEqual([]);
      const session = await w.sessions.load('goal-g1-s0');
      expect(session?.runs ?? []).toEqual([]);
    });

    it('stops the run it created, fencing its claim first, when the goal ended meanwhile', async () => {
      const { controller, signal } = timedOutSignal();
      const order: string[] = [];
      const w: Awaited<ReturnType<typeof world>> = await world({
        cancelRun: (runId) => {
          order.push(`cancel:${runId}`);
          return Promise.resolve({ status: 'requested' });
        },
        startAttemptRun: () => ({
          run: {} as never,
          durablyStarted: w.store
            .requestCancellation('g1', { requestedAt: NOW }, NOW)
            .then(() => controller.abort()),
        }),
      });

      expect(await w.ports.startAttempt(startRequest(), signal)).toEqual({ status: 'stood-down' });

      expect(w.fenced).toEqual(['goal-g1-a0']);
      expect(order).toEqual(['cancel:goal-g1-a0']);
    });
  });

  describe('a claim the goal tombstoned', () => {
    it('stands down, creating nothing, when the start finds its claim tombstoned', async () => {
      const w = await world({
        startAttemptRun: () => ({
          run: {} as never,
          durablyStarted: Promise.reject(new GoalAttemptTombstonedError('goal-g1-a0')),
        }),
      });

      expect(await w.ports.startAttempt(startRequest())).toEqual({ status: 'stood-down' });

      expect(w.watched).toEqual([]);
    });
  });

  describe('the aggregate duration', () => {
    const BOUND_MS = 1_000;
    const bounds = { maximumAttempts: 3, maximumTotalDurationMs: BOUND_MS };
    const pastTheBound = (runtime: ReturnType<typeof createManualRuntimeServices>) =>
      runtime.setTime(Date.parse(NOW) + BOUND_MS + 1);

    function clockedWorld(options: Parameters<typeof world>[0] = {}) {
      const runtime = createManualRuntimeServices();
      runtime.setTime(Date.parse(NOW));
      return world({ ...options, runtime, bounds });
    }

    it('stands down before claiming, seating, or starting anything once it has elapsed', async () => {
      let starts = 0;
      const w = await clockedWorld({
        startAttemptRun: () => {
          starts += 1;
          return { run: {} as never, durablyStarted: Promise.resolve() };
        },
      });
      pastTheBound(w.runtime);

      const outcome = await w.ports.startAttempt(startRequest());

      expect(outcome).toEqual({ status: 'stood-down' });
      expect(starts).toBe(0);
      expect(w.watched).toEqual([]);
      expect(await w.sessions.load('goal-g1-s0')).toBeUndefined();
      expect(await w.engine.get('goal-g1-a0')).toBeNull();
    });

    it('measures the bound the way the controller does, from the record and the runtime clock', async () => {
      const w = await clockedWorld({
        startAttemptRun: () => ({ run: {} as never, durablyStarted: Promise.resolve() }),
      });
      const record = (await w.store.get('g1'))!;
      w.runtime.setTime(Date.parse(NOW) + BOUND_MS + 1);
      expect(isDeadlineElapsed(record, w.runtime.clock.now())).toBe(true);
      expect(await w.ports.startAttempt(startRequest())).toEqual({ status: 'stood-down' });
    });

    it.each([
      ['a millisecond', 1],
      ['a day', 86_400_000],
    ])(
      'stands down, creating nothing, for a record created %s later than the runtime clock',
      async (_name, ahead) => {
        let starts = 0;
        const w = await clockedWorld({
          startAttemptRun: () => {
            starts += 1;
            return { run: {} as never, durablyStarted: Promise.resolve() };
          },
        });
        // The record was stamped at `NOW`; the clock now reads earlier than that, so no
        // age can be read from it. It must not be granted a fresh window to run in.
        w.runtime.setTime(Date.parse(NOW) - ahead);

        expect(await w.ports.startAttempt(startRequest())).toEqual({ status: 'stood-down' });

        expect(starts).toBe(0);
        expect(w.watched).toEqual([]);
        expect(await w.sessions.load('goal-g1-s0')).toBeUndefined();
        expect(await w.engine.get('goal-g1-a0')).toBeNull();
      },
    );

    it('writes no session when it elapses before the session is seated', async () => {
      let starts = 0;
      const w = await clockedWorld({
        startAttemptRun: () => {
          starts += 1;
          return { run: {} as never, durablyStarted: Promise.resolve() };
        },
      });
      const original = w.sessions.load.bind(w.sessions);
      w.sessions.load = (id: string) => {
        pastTheBound(w.runtime);
        return original(id);
      };

      expect(await w.ports.startAttempt(startRequest())).toEqual({ status: 'stood-down' });
      expect(starts).toBe(0);
      expect(await original('goal-g1-s0')).toBeUndefined();
    });

    it('stops the run it just created and stands down when the bound elapsed while it was created', async () => {
      const created = Promise.withResolvers<void>();
      const stopped: string[] = [];
      const w: Awaited<ReturnType<typeof clockedWorld>> = await clockedWorld({
        startAttemptRun: () => {
          // The bound passes after every pre-write check, while the run is created.
          pastTheBound(w.runtime);
          return { run: {} as never, durablyStarted: created.promise };
        },
        cancelRun: (runId) => {
          stopped.push(runId);
          return Promise.resolve({ status: 'requested' });
        },
      });

      const answer = w.ports.startAttempt(startRequest());
      created.resolve();

      // A start the controller did not wait for (a timed-out background try, or
      // the host's own recovery start) is not one it will ever learn of, and the
      // record is not yet terminal for the check to see: the elapsed bound is
      // what tells this start its run has no owner.
      expect(await answer).toEqual({ status: 'stood-down' });
      expect(stopped).toEqual(['goal-g1-a0']);
      expect(w.watched).toEqual([]);
    });
  });
});

describe('committing an attempt transcript without a durable engine', () => {
  it('fails instead of returning as though the transcript were committed', async () => {
    const { store, sessions, runtime } = await world();
    const record = (await store.get('g1'))!;
    const request = { attemptIndex: 0, runId: goalAttemptRunId('g1', 0) };
    const engineless = createGoalConversations({
      sessionStore: sessions,
      runtime,
      getDurable: () => undefined,
      resolveFreshAttemptSource: undefined,
    });
    await engineless.recordStart(record, request);

    expect(await throwingRejectionOf(engineless.settle(record, 0, request.runId))).toThrow(
      'no durable engine',
    );
  });
});

describe('committing an attempt transcript from a session store that cannot read the run back', () => {
  it('fails instead of returning as though the transcript were committed', async () => {
    const { store, sessions, runtime } = await world();
    const record = (await store.get('g1'))!;
    const request = { attemptIndex: 0, runId: goalAttemptRunId('g1', 0) };
    const lagging = createGoalConversations({
      sessionStore: { ...sessions, load: () => Promise.resolve(undefined) },
      runtime,
      getDurable: () => undefined,
      resolveFreshAttemptSource: undefined,
    });
    await lagging.recordStart(record, request);

    expect(await throwingRejectionOf(lagging.settle(record, 0, request.runId))).toThrow(
      'cannot be read back',
    );
  });
});

describe('abortAttempt', () => {
  const request = { goalRunId: 'g1', attemptIndex: 0, attemptId: 'g1:a0', runId: 'goal-g1-a0' };

  it("stops the attempt's run, and treats a run that never existed or already ended as done", async () => {
    const stopped: string[] = [];
    for (const status of [
      'requested',
      'already-terminal',
      'not-found',
      'unsupported-capability',
    ] as const) {
      const { ports } = await world({
        cancelRun: (runId) => {
          stopped.push(runId);
          return Promise.resolve({ status });
        },
      });
      await ports.abortAttempt(request);
    }
    expect(stopped).toEqual(Array.from({ length: 4 }, () => 'goal-g1-a0'));
  });

  it("tombstones the attempt's claim before it looks for the run, so a start that has claimed but not created the run is fenced", async () => {
    const order: string[] = [];
    const { ports, fenced } = await world({
      cancelRun: (runId) => {
        order.push(`cancel:${runId}`);
        return Promise.resolve({ status: 'not-found' });
      },
    });

    await ports.abortAttempt(request);

    expect(fenced).toEqual(['goal-g1-a0']);
    expect(order).toEqual(['cancel:goal-g1-a0']);
  });

  it("names no claim and no run for the index at the goal's attempt bound, which no start can mint", async () => {
    const stopped: string[] = [];
    const { ports, fenced } = await world({
      cancelRun: (runId) => {
        stopped.push(runId);
        return Promise.resolve({ status: 'requested' });
      },
    });
    const atTheBound = 3;

    await ports.abortAttempt({
      ...request,
      attemptIndex: atTheBound,
      runId: `goal-g1-a${atTheBound}`,
    });

    expect(fenced).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it('fails the activity, so it is retried, when the claim could not be fenced', async () => {
    const { ports } = await world({
      fenceAttempt: () => Promise.reject(new Error('claim storage is down')),
    });

    expect(await throwingRejectionOf(ports.abortAttempt(request))).toThrow('claim storage is down');
  });

  it('fails the activity when the engine could not cancel the run, so the controller is retried', async () => {
    const { ports } = await world({
      cancelRun: () => Promise.resolve({ status: 'failed', error: new Error('engine busy') }),
    });

    expect(await throwingRejectionOf(ports.abortAttempt(request))).toThrow('engine busy');
  });
});

describe('runValidator', () => {
  const request = {
    goalRunId: 'g1',
    attemptId: 'g1:a0',
    attemptIndex: 0,
    validator: CHECK,
  };

  /** Records attempt 0 as evaluating, over a run that has really completed. */
  async function evaluating(options: WorldOptions = {}, content = 'done') {
    const context = await world(options);
    await startDurableRunResult(context.durable, {
      runId: 'goal-g1-a0',
      sessionId: 'goal-g1-a0',
      options: agentOptions(() => Promise.resolve({ content, toolCalls: [] })),
      prompt: 'work',
    });
    await context.store.applyTransition({
      goalRunId: 'g1',
      seq: 1,
      transitionId: goalTransitionId('g1', 1),
      to: 'running',
      at: NOW,
      cause: 'attempt 0 started',
      attempt: {
        attemptId: 'g1:a0',
        attemptIndex: 0,
        runId: 'goal-g1-a0',
        sessionId: 'goal-g1-s0',
        startedAt: NOW,
        usage: { steps: 0, tokens: 0 },
        status: 'running',
      },
      usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
      active: { kind: 'attempt', attemptId: 'g1:a0', runId: 'goal-g1-a0', startedAt: NOW },
    });
    return context;
  }

  it("runs the catalogued validator against the attempt's rebuilt result and projects its verdict", async () => {
    const seen: Array<{ content: string; history: number }> = [];
    const { ports } = await evaluating({
      validators: [
        {
          identity: CHECK,
          validate: ({ result, history }) => {
            seen.push({ content: result.content, history: history.length });
            return { kind: 'pass', evidence: [{ source: 'check', detail: { when: new Date(0) } }] };
          },
        },
      ],
    });

    const result = await ports.runValidator(request);

    expect(seen).toEqual([{ content: 'done', history: 0 }]);
    expect(result).toMatchObject({
      identity: CHECK,
      outcome: {
        kind: 'pass',
        evidence: [{ source: 'check', detail: { when: '1970-01-01T00:00:00.000Z' } }],
      },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("aborts the validator's own signal when the activity's signal aborts, so a cancelled goal's validator stops and the verdict reads as canceled", async () => {
    let validatorSignal: AbortSignal | undefined;
    const { ports } = await evaluating({
      validators: [
        {
          identity: CHECK,
          validate: (_input, signal) => {
            validatorSignal = signal;
            return new Promise(() => {});
          },
        },
      ],
    });
    const cancelled = new AbortController();

    const running = ports.runValidator(request, cancelled.signal);
    for (let turn = 0; turn < 200 && validatorSignal === undefined; turn += 1) {
      await Promise.resolve();
    }
    expect(validatorSignal?.aborted).toBe(false);
    cancelled.abort();

    expect(validatorSignal?.aborted).toBe(true);
    expect(await running).toMatchObject({ outcome: { kind: 'canceled' } });
  });

  it.each([
    ['a null entry', [null]],
    ['a string entry', ['unit']],
    ['an entry with no source', [{ detail: 'x' }]],
  ])(
    "records %s in a verdict's evidence as a malformed-output error, never a verdict",
    async (_label, evidence) => {
      const { ports } = await evaluating({
        validators: [{ identity: CHECK, validate: () => ({ kind: 'pass', evidence }) as never }],
      });

      expect(await ports.runValidator(request)).toMatchObject({
        outcome: { kind: 'error', error: { kind: 'output', code: 'MALFORMED_VALIDATOR_OUTPUT' } },
      });
    },
  );

  it('reads the result with the persisted estimator even when the goal has no cost bound', async () => {
    const seen: Array<number | undefined> = [];
    const { ports } = await evaluating({
      validators: [
        {
          identity: CHECK,
          validate: ({ result }) => {
            seen.push(result.costEstimate?.totalCost);
            return { kind: 'pass', evidence: [] };
          },
        },
      ],
      resolveCostEstimation: () => Promise.resolve({ model: 'gpt-4o' }),
    });

    await ports.runValidator(request);

    // The validator sees what the live run and the in-memory controller show it.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeDefined();
  });

  it('fails the activity, to be retried, when the cost estimator fails for a goal with a cost bound', async () => {
    let fail = true;
    const { ports } = await evaluating({
      bounds: { maximumAttempts: 3, maximumTotalCostUsd: 1 },
      validators: [{ identity: CHECK, validate: () => ({ kind: 'pass', evidence: [] }) }],
      resolveCostEstimation: () =>
        fail ? Promise.reject(new Error('pricing hiccup')) : Promise.resolve(undefined),
    });

    expect(await throwingRejectionOf(ports.runValidator(request))).toThrow('pricing hiccup');
    // It is not recorded as an attempt with no cost: the retry reads the result.
    fail = false;
    expect(await ports.runValidator(request)).toMatchObject({ outcome: { kind: 'pass' } });
  });

  it('fails the activity, to be retried, when reading the attempt result throws, rather than recording a permanent error outcome', async () => {
    const { ports, engine } = await evaluating({
      validators: [{ identity: CHECK, validate: () => ({ kind: 'pass', evidence: [] }) }],
    });
    const realGet = engine.get.bind(engine);
    let faults = 1;
    (engine as { get: typeof engine.get }).get = (workflowId) => {
      if (faults > 0 && workflowId === 'goal-g1-a0') {
        faults -= 1;
        return Promise.reject(new Error('storage hiccup'));
      }
      return realGet(workflowId);
    };

    expect(await throwingRejectionOf(ports.runValidator(request))).toThrow('storage hiccup');
    // The retry reads the result and judges it: one storage fault did not cost the goal.
    expect(await ports.runValidator(request)).toMatchObject({ outcome: { kind: 'pass' } });
  });

  it('fails the activity, to be retried, when the checkpoint cannot be read, rather than judging an empty conversation', async () => {
    const seen: number[] = [];
    const { ports, checkpointReadFaults } = await evaluating({
      validators: [
        {
          identity: CHECK,
          validate: ({ result }) => {
            seen.push(result.steps.length);
            return { kind: 'pass', evidence: [] };
          },
        },
      ],
    });
    checkpointReadFaults.remaining = 1;

    expect(await throwingRejectionOf(ports.runValidator(request))).toThrow('storage hiccup');
    expect(seen).toEqual([]);
    // The retry reads the real checkpoint, with the step the run took.
    expect(await ports.runValidator(request)).toMatchObject({ outcome: { kind: 'pass' } });
    expect(seen).toEqual([1]);
  });

  it('fails the activity, to be retried, when the bureau has no durable engine, rather than recording an error outcome', async () => {
    const { ports } = await evaluating({
      withoutEngine: true,
      validators: [{ identity: CHECK, validate: () => ({ kind: 'pass', evidence: [] }) }],
    });

    expect(await throwingRejectionOf(ports.runValidator(request))).toThrow('no durable engine');
  });

  it('fails the activity, to be retried, when the run reads as not yet ended, but answers an error for a run that is gone', async () => {
    const { ports, engine } = await evaluating({
      validators: [{ identity: CHECK, validate: () => ({ kind: 'pass', evidence: [] }) }],
    });
    const realGet = engine.get.bind(engine);
    let reading: 'running' | 'gone' | 'real' = 'running';
    (engine as { get: typeof engine.get }).get = async (workflowId) => {
      if (workflowId !== 'goal-g1-a0' || reading === 'real') return realGet(workflowId);
      if (reading === 'gone') return null;
      const real = await realGet(workflowId);
      return real === null ? null : { ...real, status: 'running' };
    };

    // The forwarder only signals a run it read as ended, so "running" now is a
    // lagging read: retry.
    expect(await throwingRejectionOf(ports.runValidator(request))).toThrow('not yet readable');
    // A run that no longer exists will not come back, so retrying would spin.
    reading = 'gone';
    expect(await ports.runValidator(request)).toMatchObject({
      outcome: { kind: 'error', error: { code: 'ATTEMPT_RESULT_UNAVAILABLE' } },
    });
    reading = 'real';
    expect(await ports.runValidator(request)).toMatchObject({ outcome: { kind: 'pass' } });
  });

  it('hands the validator the attempts before this one', async () => {
    const seen: Array<{ feedback: (string | undefined)[]; outcome: (string | undefined)[] }> = [];
    const { ports, store, durable } = await evaluating({
      validators: [
        {
          identity: CHECK,
          validate: (input) => {
            seen.push({
              feedback: input.history.map((attempt) => attempt.feedback),
              outcome: input.history.map((attempt) => attempt.validation?.outcome.kind),
            });
            return { kind: 'pass', evidence: [] };
          },
        },
      ],
    });
    // Attempt 0 failed with feedback, and attempt 1 is the one under evaluation.
    const attemptZero = {
      attemptId: 'g1:a0',
      attemptIndex: 0,
      runId: 'goal-g1-a0',
      sessionId: 'goal-g1-s0',
      startedAt: NOW,
      usage: { steps: 1, tokens: 0 },
    } as const;
    await store.applyTransition({
      goalRunId: 'g1',
      seq: 2,
      transitionId: goalTransitionId('g1', 2),
      to: 'evaluating',
      at: NOW,
      cause: 'attempt 0 reached stop-condition',
      usage: { attempts: 1, steps: 1, tokens: 0, durationMs: 0 },
      attempt: { ...attemptZero, finishReason: 'stop-condition', status: 'evaluating' },
      active: { kind: 'validation', attemptId: 'g1:a0', validator: CHECK, startedAt: NOW },
    });
    await store.applyTransition({
      goalRunId: 'g1',
      seq: 3,
      transitionId: goalTransitionId('g1', 3),
      to: 'retrying',
      at: NOW,
      cause: 'retrying',
      attempt: {
        ...attemptZero,
        completedAt: NOW,
        finishReason: 'stop-condition',
        feedback: 'say done',
        validation: {
          identity: CHECK,
          startedAt: NOW,
          completedAt: NOW,
          outcome: { kind: 'fail', feedback: 'say done', evidence: [], retryable: true },
          decisionId: goalDecisionId('g1:a0'),
        },
        status: 'failed',
      },
      active: null,
    });
    await startDurableRunResult(durable, {
      runId: 'goal-g1-a1',
      sessionId: 'goal-g1-a1',
      options: agentOptions(() => Promise.resolve({ content: 'second try', toolCalls: [] })),
      prompt: 'work',
    });
    await store.applyTransition({
      goalRunId: 'g1',
      seq: 4,
      transitionId: goalTransitionId('g1', 4),
      to: 'running',
      at: NOW,
      cause: 'attempt 1 started',
      usage: { attempts: 2, steps: 1, tokens: 0, durationMs: 0 },
      attempt: {
        attemptId: 'g1:a1',
        attemptIndex: 1,
        runId: 'goal-g1-a1',
        sessionId: 'goal-g1-s0',
        startedAt: NOW,
        usage: { steps: 0, tokens: 0 },
        status: 'running',
      },
      active: { kind: 'attempt', attemptId: 'g1:a1', runId: 'goal-g1-a1', startedAt: NOW },
    });

    await ports.runValidator({ ...request, attemptId: 'g1:a1', attemptIndex: 1 });

    expect(seen).toEqual([{ feedback: ['say done'], outcome: ['fail'] }]);
  });

  it.each([
    { label: 'is not registered', validators: [], code: 'VALIDATOR_MISSING' },
    {
      label: 'is registered at another version',
      validators: [
        {
          identity: { name: 'check', version: '2' },
          validate: () => ({ kind: 'canceled' as const }),
        },
      ],
      code: 'VALIDATOR_VERSION_MISMATCH',
    },
  ])('answers unavailable, naming it, when the validator $label', async ({ validators, code }) => {
    const { ports } = await evaluating({ validators });

    const result = await ports.runValidator(request);

    expect(result.outcome).toMatchObject({ kind: 'unavailable', error: { kind: 'load', code } });
    expect(result.identity).toEqual(CHECK);
  });

  it("answers an error, not a throw, when the attempt's result cannot be read", async () => {
    const { ports } = await world({
      validators: [{ identity: CHECK, validate: () => ({ kind: 'canceled' }) }],
    });
    await ports.commitTransition({
      goalRunId: 'g1',
      seq: 1,
      transitionId: goalTransitionId('g1', 1),
      to: 'running',
      at: NOW,
      cause: 'attempt 0 started',
      usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
      attempt: {
        attemptId: 'g1:a0',
        attemptIndex: 0,
        runId: 'goal-g1-a0',
        sessionId: 'goal-g1-s0',
        startedAt: NOW,
        usage: { steps: 0, tokens: 0 },
        status: 'running',
      },
      active: { kind: 'attempt', attemptId: 'g1:a0', runId: 'goal-g1-a0', startedAt: NOW },
    });

    const result = await ports.runValidator(request);

    expect(result.outcome).toMatchObject({
      kind: 'error',
      error: { code: 'ATTEMPT_RESULT_UNAVAILABLE' },
    });
  });

  it('turns a validator that throws into an error outcome with its cause projected', async () => {
    const { ports } = await evaluating({
      validators: [
        {
          identity: CHECK,
          validate: () => {
            throw new TypeError('the checker broke');
          },
        },
      ],
    });

    const result = await ports.runValidator(request);

    expect(result.outcome).toMatchObject({
      kind: 'error',
      error: { kind: 'execute', code: 'VALIDATOR_THREW', message: 'the checker broke' },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('ends a validator that outlives its timeout, on the runtime clock', async () => {
    const { ports, runtime } = await evaluating({
      validators: [{ identity: CHECK, validate: () => new Promise(() => {}) }],
    });

    const pending = ports.runValidator({ ...request, validatorTimeoutMs: 50 });
    await pollUntil(() => runtime.pendingTimers().length > 0);
    await runtime.advance(50);
    const result = await pending;

    expect(result.outcome).toMatchObject({
      kind: 'error',
      error: { kind: 'timeout', code: 'VALIDATOR_TIMEOUT' },
    });
  });

  it('brings an outcome over the inline cap under it without changing the verdict', async () => {
    const { ports } = await evaluating({
      validators: [
        {
          identity: CHECK,
          validate: () => ({
            kind: 'fail',
            feedback: 'too much',
            retryable: true,
            evidence: [{ source: 'big', detail: 'x'.repeat(200_000) }],
          }),
        },
      ],
    });

    const result = await ports.runValidator(request);

    expect(result.outcome).toMatchObject({
      kind: 'fail',
      feedback: 'too much',
      retryable: true,
      evidence: [{ source: 'big', detail: { truncated: true, originalByteLength: 200_002 } }],
    });
    expect(JSON.stringify(result.outcome).length).toBeLessThan(65_536);
  });
});

// ---------------------------------------------------------------------------
// The windows a crash can leave between a session write and a run start
// ---------------------------------------------------------------------------

type World = Awaited<ReturnType<typeof world>>;

/** Runs attempt 0 for real, and records it in the goal's session as the ports would have. */
async function finishAttemptZero(w: World, reply = 'nope') {
  await startDurableRunResult(w.durable, {
    runId: 'goal-g1-a0',
    sessionId: 'goal-g1-a0',
    options: agentOptions(() => Promise.resolve({ content: reply, toolCalls: [] })),
    prompt: 'work',
  });
  const record = await w.store.get('g1');
  if (record === undefined) throw new Error('the goal record is missing');
  await w.conversations.recordStart(record, { attemptIndex: 0, runId: 'goal-g1-a0' });
  await w.conversations.settle(record, 0, 'goal-g1-a0');
}

/** A start that fails the first time, as a process dying right after the session write would. */
function dyingStarter() {
  const state = { dies: true, starts: [] as GoalAttemptStart[] };
  const startAttemptRun = (start: GoalAttemptStart): GoalAttemptRun => {
    if (state.dies) throw new Error('process died');
    state.starts.push(start);
    return { run: {} as never, durablyStarted: Promise.resolve() };
  };
  return { state, startAttemptRun };
}

function seededTranscript(input: GoalAttemptStart['input']): string[] {
  if (typeof input === 'string') return [`string: ${input}`];
  const { conversation } = input;
  return conversation.ids.map((id) => {
    const message = conversation.messages[id]!;
    return `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`;
  });
}

async function sessionIds(w: World): Promise<string[]> {
  const summaries = await w.sessions.list();
  return summaries.map((summary) => summary.id).toSorted();
}

async function runsOf(w: World, sessionId: string) {
  const session = await w.sessions.load(sessionId);
  return session?.runs.map((run) => [run.runId, run.status]);
}

describe('startAttempt after a crash between a session write and the run start', () => {
  it('under continue, records the retry once and seeds it from the committed transcript', async () => {
    const { state, startAttemptRun } = dyingStarter();
    const w = await world({ startAttemptRun });
    await finishAttemptZero(w);

    expect(await throwingRejectionOf(w.ports.startAttempt(startRequest('say done')))).toThrow(
      'process died',
    );
    // The first try left nothing of the retry behind but the committed baseline.
    expect(await runsOf(w, 'goal-g1-s0')).toEqual([['goal-g1-a0', 'completed']]);

    state.dies = false;
    expect(await w.ports.startAttempt(startRequest('say done'))).toEqual({
      status: 'started',
      sessionId: 'goal-g1-s0',
    });

    expect(state.starts.map((start) => start.runId)).toEqual(['goal-g1-a1']);
    expect(seededTranscript(state.starts[0]!.input)).toEqual([
      'user: work',
      'assistant: nope',
      'user: say done',
    ]);
    const session = await w.sessions.load('goal-g1-s0');
    expect(session?.runs.map((run) => [run.runId, run.status])).toEqual([
      ['goal-g1-a0', 'completed'],
      ['goal-g1-a1', 'running'],
    ]);
    // The feedback turn is in the run's seed, not yet in the session.
    expect(
      transcriptOf({
        getMessages: () =>
          session!.conversationHistory.ids.map((id) => session!.conversationHistory.messages[id]!),
      }),
    ).toEqual(['user: work', 'assistant: nope']);
  });

  it('under fork-from-baseline, creates the fork once and reads it back on the second try', async () => {
    const { state, startAttemptRun } = dyingStarter();
    const w = await world({
      startAttemptRun,
      policy: { kind: 'fork-from-baseline', throughRun: 0 },
    });
    await finishAttemptZero(w);

    await throwingRejectionOf(w.ports.startAttempt(startRequest('say done')));
    const forkedOnce = await w.sessions.load('goal-g1-s1');
    expect(forkedOnce?.runs).toEqual([]);

    state.dies = false;
    expect(await w.ports.startAttempt(startRequest('say done'))).toEqual({
      status: 'started',
      sessionId: 'goal-g1-s1',
    });

    expect(await sessionIds(w)).toEqual(['goal-g1-s0', 'goal-g1-s1']);
    const forked = await w.sessions.load('goal-g1-s1');
    // The second try found the first try's session and did not write another.
    expect(forked?.conversationHistory).toEqual(forkedOnce?.conversationHistory);
    expect(forked?.runs.map((run) => [run.runId, run.status])).toEqual([['goal-g1-a1', 'running']]);
    expect(seededTranscript(state.starts[0]!.input)).toEqual([
      'user: work',
      'assistant: nope',
      'user: work\n\nsay done',
    ]);
  });

  it('under fork-from-baseline, retries rather than ending the goal when the fork could be neither written nor read back', async () => {
    const { state, startAttemptRun } = dyingStarter();
    state.dies = false;
    const w = await world({
      startAttemptRun,
      policy: { kind: 'fork-from-baseline', throughRun: 0 },
    });
    await finishAttemptZero(w);
    // A store that answers neither the write nor the read for a moment: that is a
    // fault to retry, not a conversation policy the goal failed.
    const realUpdate = w.sessions.update.bind(w.sessions);
    let lagging = true;
    (w.sessions as { update: typeof realUpdate }).update = (id, mutate) =>
      lagging && id === 'goal-g1-s1' ? Promise.resolve(undefined) : realUpdate(id, mutate);

    expect(await throwingRejectionOf(w.ports.startAttempt(startRequest('say done')))).toThrow(
      'could not be created',
    );

    lagging = false;
    expect(await w.ports.startAttempt(startRequest('say done'))).toEqual({
      status: 'started',
      sessionId: 'goal-g1-s1',
    });
  });

  it('under fresh-from-artifact, creates the fresh session once and reads it back on the second try', async () => {
    const runtime = createManualRuntimeServices();
    const { artifact, resolveSource } = await freshHandoff(
      'Make the check pass.',
      new Date(runtime.clock.now()),
    );
    const { state, startAttemptRun } = dyingStarter();
    const w = await world({
      runtime,
      startAttemptRun,
      policy: { kind: 'fresh-from-artifact', artifact },
      instructions: 'Be careful.',
      resolveFreshAttemptSource: resolveSource,
    });
    await finishAttemptZero(w);

    await throwingRejectionOf(w.ports.startAttempt(startRequest('say done')));
    const createdOnce = await w.sessions.load('goal-g1-s1');
    expect(createdOnce?.runs).toEqual([]);

    state.dies = false;
    expect(await w.ports.startAttempt(startRequest('say done'))).toEqual({
      status: 'started',
      sessionId: 'goal-g1-s1',
    });

    expect(await sessionIds(w)).toEqual(['goal-g1-s0', 'goal-g1-s1']);
    const fresh = await w.sessions.load('goal-g1-s1');
    expect(fresh?.conversationHistory).toEqual(createdOnce?.conversationHistory);
    const seeded = seededTranscript(state.starts[0]!.input);
    expect(seeded).toHaveLength(3);
    expect(seeded[0]).toBe('system: Be careful.');
    expect(seeded[2]).toBe('user: work');
    // The transcript of attempt 0 is nowhere in it.
    expect(seeded.join('\n')).not.toContain('nope');
  });

  it('ends the goal, rather than retrying the activity, when the artifact can no longer be vouched for', async () => {
    const runtime = createManualRuntimeServices();
    const { artifact, resolveSource } = await freshHandoff(
      undefined,
      new Date(runtime.clock.now()),
    );
    let vouching = true;
    const w = await world({
      runtime,
      startAttemptRun: () => {
        throw new Error('no run should start');
      },
      policy: { kind: 'fresh-from-artifact', artifact },
      instructions: 'Be careful.',
      resolveFreshAttemptSource: (source) => (vouching ? resolveSource(source) : undefined),
    });
    await finishAttemptZero(w);
    vouching = false;

    const outcome = await w.ports.startAttempt(startRequest('say done'));

    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { detail: string }).detail).toContain(
      'Applying the conversation policy failed',
    );
    expect(await sessionIds(w)).toEqual(['goal-g1-s0']);
  });
});

describe('startAttempt after a crash between the engine start and the session write', () => {
  it('records the adopted run in its session once, however often the start repeats', async () => {
    const w = await world();
    await finishAttemptZero(w);
    w.markRunAsGoals('goal-g1-a1', 1);
    // The previous process started attempt 1's workflow and died before recording it.
    createActiveRun(
      agentOptions(() => new Promise(() => {})),
      { ...w.durable, runId: 'goal-g1-a1', prompt: 'say done' },
    );
    await pollUntil(async () => (await w.engine.get('goal-g1-a1')) !== null);
    expect(await runsOf(w, 'goal-g1-s0')).toHaveLength(1);

    for (let repeat = 0; repeat < 3; repeat += 1) {
      expect(await w.ports.startAttempt(startRequest('say done'))).toEqual({
        status: 'adopted',
        sessionId: 'goal-g1-s0',
      });
    }

    expect(await runsOf(w, 'goal-g1-s0')).toEqual([
      ['goal-g1-a0', 'completed'],
      ['goal-g1-a1', 'running'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// A transcript that cannot be read is never recorded as absent
// ---------------------------------------------------------------------------

describe("startAttempt when the previous attempt's transcript cannot be read", () => {
  /** Attempt 0 has ended in the engine and is recorded in its session, but not yet settled. */
  async function endedButUnsettled(w: World) {
    await startDurableRunResult(w.durable, {
      runId: 'goal-g1-a0',
      sessionId: 'goal-g1-a0',
      options: agentOptions(() => Promise.resolve({ content: 'nope', toolCalls: [] })),
      prompt: 'work',
    });
    const record = await w.store.get('g1');
    if (record === undefined) throw new Error('the goal record is missing');
    await w.conversations.recordStart(record, { attemptIndex: 0, runId: 'goal-g1-a0' });
  }

  it('under continue, retries the read instead of seeding the retry without attempt 0', async () => {
    const { state, startAttemptRun } = dyingStarter();
    state.dies = false;
    const w = await world({ startAttemptRun });
    await endedButUnsettled(w);
    w.checkpointReadFaults.remaining = 1;

    expect(await throwingRejectionOf(w.ports.startAttempt(startRequest('say done')))).toThrow(
      'storage hiccup',
    );
    // Nothing was started, and the run is still open for the next try to settle.
    expect(state.starts).toEqual([]);
    expect(await runsOf(w, 'goal-g1-s0')).toEqual([['goal-g1-a0', 'running']]);

    expect(await w.ports.startAttempt(startRequest('say done'))).toEqual({
      status: 'started',
      sessionId: 'goal-g1-s0',
    });
    expect(seededTranscript(state.starts[0]!.input)).toEqual([
      'user: work',
      'assistant: nope',
      'user: say done',
    ]);
  });

  it('under continue, refuses a trunk whose completed run recorded no transcript', async () => {
    const { state, startAttemptRun } = dyingStarter();
    state.dies = false;
    const w = await world({ startAttemptRun });
    await finishAttemptZero(w);
    // The shape a swallowed read left behind before settle required the transcript.
    await w.sessions.update('goal-g1-s0', (session) =>
      session === undefined
        ? undefined
        : {
            ...session,
            runs: session.runs.map(({ conversationBoundary: _boundary, ...run }) => run),
          },
    );

    expect(await throwingRejectionOf(w.ports.startAttempt(startRequest('say done')))).toThrow(
      'has not committed its transcript',
    );
    expect(state.starts).toEqual([]);
  });

  it('under fork-from-baseline, retries the read rather than ending the goal over it', async () => {
    const { state, startAttemptRun } = dyingStarter();
    state.dies = false;
    const w = await world({
      startAttemptRun,
      policy: { kind: 'fork-from-baseline', throughRun: 0 },
    });
    await endedButUnsettled(w);
    w.checkpointReadFaults.remaining = 1;

    expect(await throwingRejectionOf(w.ports.startAttempt(startRequest('say done')))).toThrow(
      'storage hiccup',
    );
    expect(await w.ports.startAttempt(startRequest('say done'))).toMatchObject({
      status: 'started',
    });
  });
});

describe("startAttempt after the retry's session was written and its source went away", () => {
  it('under fresh-from-artifact, continues in the stored session rather than ending the goal', async () => {
    const runtime = createManualRuntimeServices();
    const { artifact, resolveSource } = await freshHandoff(
      'Make the check pass.',
      new Date(runtime.clock.now()),
    );
    const { state, startAttemptRun } = dyingStarter();
    let vouching = true;
    const w = await world({
      runtime,
      startAttemptRun,
      policy: { kind: 'fresh-from-artifact', artifact },
      instructions: 'Be careful.',
      resolveFreshAttemptSource: (source) => (vouching ? resolveSource(source) : undefined),
    });
    await finishAttemptZero(w);
    await throwingRejectionOf(w.ports.startAttempt(startRequest('say done')));
    const written = await w.sessions.load('goal-g1-s1');
    expect(written).toBeDefined();

    // Recovery finds the artifact's source gone, but the session it needs is stored.
    vouching = false;
    state.dies = false;
    expect(await w.ports.startAttempt(startRequest('say done'))).toEqual({
      status: 'started',
      sessionId: 'goal-g1-s1',
    });
    const seeded = seededTranscript(state.starts[0]!.input);
    expect(seeded[0]).toBe('system: Be careful.');
    expect(seeded.at(-1)).toBe('user: work');
  });
});

describe("the authority recorded on a goal's sessions", () => {
  it.each([
    ['continue', { kind: 'continue' }, 'goal-g1-s0'],
    ['fork-from-baseline', { kind: 'fork-from-baseline', throughRun: 0 }, 'goal-g1-s1'],
  ] as const)(
    "under %s, the retry session belongs to the goal's principal",
    async (_name, policy, sessionId) => {
      const { state, startAttemptRun } = dyingStarter();
      state.dies = false;
      const w = await world({ startAttemptRun, policy });
      await finishAttemptZero(w);
      await w.ports.startAttempt(startRequest('say done'));

      const session = await w.sessions.load(sessionId);
      expect(isSessionAuthorityAuthorized(session!.metadata, 'alice')).toBe(true);
      expect(isSessionAuthorityAuthorized(session!.metadata, 'bob')).toBe(false);
    },
  );

  it("under fresh-from-artifact, the fresh session belongs to the goal's principal", async () => {
    const runtime = createManualRuntimeServices();
    const { artifact, resolveSource } = await freshHandoff(
      'Make the check pass.',
      new Date(runtime.clock.now()),
    );
    const { state, startAttemptRun } = dyingStarter();
    state.dies = false;
    const w = await world({
      runtime,
      startAttemptRun,
      policy: { kind: 'fresh-from-artifact', artifact },
      instructions: 'Be careful.',
      resolveFreshAttemptSource: resolveSource,
    });
    await finishAttemptZero(w);
    await w.ports.startAttempt(startRequest('say done'));

    const session = await w.sessions.load('goal-g1-s1');
    expect(isSessionAuthorityAuthorized(session!.metadata, 'alice')).toBe(true);
    expect(isSessionAuthorityAuthorized(session!.metadata, 'bob')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// An id is not ownership
// ---------------------------------------------------------------------------

describe("startAttempt when something else already holds one of the goal's deterministic ids", () => {
  const refusingStarter = () => {
    const starts: GoalAttemptStart[] = [];
    return {
      starts,
      startAttemptRun: (start: GoalAttemptStart): GoalAttemptRun => {
        starts.push(start);
        return { run: {} as never, durablyStarted: Promise.resolve() };
      },
    };
  };

  const foreignRecord = (
    overrides: Partial<CatalogRunRecoveryRecord>,
  ): CatalogRunRecoveryRecord => ({
    schemaVersion: 1,
    agentName: 'worker',
    definitionRevision: 1,
    input: 'work',
    principal: 'alice',
    goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
    ...overrides,
  });

  it.each([
    ['an ordinary run with no goal marker', undefined],
    ["another goal's attempt", { goalAttempt: { goalRunId: 'g2', attemptIndex: 0 } }],
    ['another attempt of this goal', { goalAttempt: { goalRunId: 'g1', attemptIndex: 5 } }],
    ["another principal's run", { principal: 'mallory' }],
    ["another agent's run", { agentName: 'intruder' }],
  ] as const)(
    'refuses a live run that is %s, and touches nothing of it',
    async (_label, override) => {
      const { starts, startAttemptRun } = refusingStarter();
      const w = await world({ startAttemptRun });
      createActiveRun(
        agentOptions(() => new Promise(() => {})),
        { ...w.durable, runId: 'goal-g1-a0', prompt: "someone else's" },
      );
      await pollUntil(async () => (await w.engine.get('goal-g1-a0')) !== null);
      if (override !== undefined) {
        w.runRecords.set('goal-g1-a0', foreignRecord(override));
      }

      const outcome = await w.ports.startAttempt(startRequest());

      expect(outcome).toMatchObject({ status: 'failed' });
      expect((outcome as { detail: string }).detail).toContain('goal-g1-a0');
      // Nothing was adopted, started over it, watched, or written to a session.
      expect(starts).toEqual([]);
      expect(w.watched).toEqual([]);
      expect(await w.sessions.load('goal-g1-s0')).toBeUndefined();
      const stillThere = await w.engine.get('goal-g1-a0');
      expect(stillThere?.status).toBe('running');
    },
  );

  it('does not call an attempt run foreign or absent when its record cannot be read, and adopts it once the fault clears', async () => {
    const { starts, startAttemptRun } = refusingStarter();
    const w = await world({ startAttemptRun });
    createActiveRun(
      agentOptions(() => new Promise(() => {})),
      { ...w.durable, runId: 'goal-g1-a0', prompt: 'work' },
    );
    await pollUntil(async () => (await w.engine.get('goal-g1-a0')) !== null);
    w.markRunAsGoals('goal-g1-a0');

    // Every read of the record fails: the run is neither refused as foreign
    // nor started over as absent; the activity fails so recovery retries.
    w.runRecordReadFaults.remaining = 1;
    expect(await throwingRejectionOf(w.ports.startAttempt(startRequest()))).toThrow(
      'could not be read',
    );
    expect(starts).toEqual([]);
    expect(w.watched).toEqual([]);
    expect(await w.sessions.load('goal-g1-s0')).toBeUndefined();
    const stillRunning = await w.engine.get('goal-g1-a0');
    expect(stillRunning?.status).toBe('running');

    expect(await w.ports.startAttempt(startRequest())).toEqual({
      status: 'adopted',
      sessionId: 'goal-g1-s0',
    });
    expect(starts).toEqual([]);
  });

  it('does not treat a session it could not read as foreign or absent, and proceeds once the fault clears', async () => {
    const { starts, startAttemptRun } = refusingStarter();
    const w = await world({ startAttemptRun });
    w.markRunAsGoals('goal-g1-a0');
    const load = w.sessions.load.bind(w.sessions);
    let faults = 1;
    Object.defineProperty(w.sessions, 'load', {
      configurable: true,
      value: (...loadArguments: Parameters<typeof load>) => {
        if (faults > 0) {
          faults -= 1;
          return Promise.reject(new Error('session storage hiccup'));
        }
        return load(...loadArguments);
      },
    });

    expect(await throwingRejectionOf(w.ports.startAttempt(startRequest()))).toThrow(
      'session storage hiccup',
    );
    expect(starts).toEqual([]);

    expect(await w.ports.startAttempt(startRequest())).toEqual({
      status: 'started',
      sessionId: 'goal-g1-s0',
    });
    expect(starts).toHaveLength(1);
  });

  it.each([
    ['a live run', true],
    ['a claim with no workflow', false],
  ])(
    'fails the attempt with corrupt-ownership-record, and touches nothing, for %s whose record is present but invalid',
    async (_label, live) => {
      const { starts, startAttemptRun } = refusingStarter();
      const w = await world({ startAttemptRun });
      if (live) {
        createActiveRun(
          agentOptions(() => new Promise(() => {})),
          { ...w.durable, runId: 'goal-g1-a0', prompt: 'work' },
        );
        await pollUntil(async () => (await w.engine.get('goal-g1-a0')) !== null);
      }
      w.corruptRunRecords.add('goal-g1-a0');

      const outcome = await w.ports.startAttempt(startRequest());

      expect(outcome).toMatchObject({ status: 'failed' });
      expect((outcome as { detail: string }).detail).toContain('corrupt-ownership-record');
      expect(starts).toEqual([]);
      expect(w.watched).toEqual([]);
      expect(await w.sessions.load('goal-g1-s0')).toBeUndefined();
    },
  );

  it('refuses a claim another run holds, even though no workflow exists yet', async () => {
    const { starts, startAttemptRun } = refusingStarter();
    const w = await world({ startAttemptRun });
    w.runRecords.set('goal-g1-a0', {
      schemaVersion: 1,
      agentName: 'worker',
      definitionRevision: 1,
      input: 'work',
      principal: 'alice',
    });

    const outcome = await w.ports.startAttempt(startRequest());

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(starts).toEqual([]);
    expect(await w.sessions.load('goal-g1-s0')).toBeUndefined();
  });

  it('completes its own claim when the start died before the workflow existed', async () => {
    const { starts, startAttemptRun } = refusingStarter();
    const w = await world({ startAttemptRun });
    w.markRunAsGoals('goal-g1-a0');

    expect(await w.ports.startAttempt(startRequest())).toEqual({
      status: 'started',
      sessionId: 'goal-g1-s0',
    });
    expect(starts).toHaveLength(1);
  });

  const foreignSession = (w: World, id: string, metadata: Record<string, unknown>) =>
    w.sessions.update(id, () =>
      createAgentSession({
        agentName: 'worker',
        conversationHistory: createConversationHistory(),
        id,
        runs: [],
        metadata: metadata as never,
        runtime: w.runtime,
      }),
    );
  const strangerAuthority = {
    principalId: 'mallory',
    tenantId: 'bureau',
    ownerId: 'worker',
    capabilities: ['tools:execute'],
    authorizationRevision: 'bureau:1',
  };

  it.each([
    ['a session an ordinary caller created at the id', {}],
    ["another goal's session", { goalRunId: 'g2' }],
    [
      "another principal's session that names this goal",
      { goalRunId: 'g1', lastRequestAuthority: strangerAuthority },
    ],
  ])('refuses %s, and leaves its transcript as it was', async (_label, metadata) => {
    const { starts, startAttemptRun } = refusingStarter();
    const w = await world({ startAttemptRun });
    await foreignSession(w, 'goal-g1-s0', metadata);
    const before = await w.sessions.load('goal-g1-s0');

    const outcome = await w.ports.startAttempt(startRequest());

    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { detail: string }).detail).toContain('goal-g1-s0');
    expect(starts).toEqual([]);
    expect(await w.sessions.load('goal-g1-s0')).toEqual(before);
  });

  it("refuses a session that holds a run that is not one of the goal's attempts", async () => {
    const { starts, startAttemptRun } = refusingStarter();
    const w = await world({ startAttemptRun });
    await foreignSession(w, 'goal-g1-s0', {
      goalRunId: 'g1',
      lastRequestAuthority: { ...strangerAuthority, principalId: 'alice' },
    });
    await w.sessions.update('goal-g1-s0', (session) => ({
      ...session!,
      runs: [
        {
          runId: 'someone-elses-run',
          sequence: 0,
          status: 'completed',
          startedAt: NOW,
          agentName: 'worker',
        },
      ],
    }));

    expect(await w.ports.startAttempt(startRequest())).toMatchObject({ status: 'failed' });
    expect(starts).toEqual([]);
  });

  it('refuses to seed a retry from a foreign trunk, under continue and under fork-from-baseline', async () => {
    for (const policy of [
      { kind: 'continue' },
      { kind: 'fork-from-baseline', throughRun: 0 },
    ] as const) {
      const { starts, startAttemptRun } = refusingStarter();
      const w = await world({ startAttemptRun, policy });
      await finishAttemptZero(w);
      // The trunk is replaced by a foreign session after attempt 0 ran.
      await w.sessions.update('goal-g1-s0', (session) => ({
        ...session!,
        metadata: { ...session!.metadata, lastRequestAuthority: strangerAuthority },
      }));

      const outcome = await w.ports.startAttempt(startRequest('say done'));

      expect(outcome).toMatchObject({ status: 'failed' });
      expect(starts).toEqual([]);
      expect(await w.sessions.load('goal-g1-s1')).toBeUndefined();
    }
  });
});
