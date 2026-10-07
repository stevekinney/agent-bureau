/**
 * COR-772 — the catalog dispatcher's child-start guards. The child path is
 * otherwise exercised end to end through `bureau.children` in
 * `bureau-children.test.ts`; these are the refusals the topology never
 * reaches in normal operation, because it plans the child first and refuses
 * an identifier another run already holds before it starts anything.
 */
import {
  createDefaultRuntimeServices,
  createManualRuntimeServices,
  HookRegistry,
} from '@lostgradient/lifecycle';
import {
  AgentContractError,
  createAgent,
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type OperativeHookMap,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  createCatalogDispatcher,
  GoalAttemptInvalidCostEstimationError,
  GoalAttemptNotDurableCapableError,
  GoalAttemptTombstonedError,
} from './bureau-catalog-dispatch';
import { registerGoalAttemptFence } from './goal-attempt-fence';
import type { RuntimeComposition } from './runtime-composition';
import type { RunAttribution } from './serialization';
import { lastPromptOf } from './testing/goal-fixtures.test-support';

function createDispatcher(
  shuttingDown: boolean,
  options: {
    readonly runtime?: RuntimeComposition;
    readonly runAttribution?: Map<string, RunAttribution>;
  } = {},
) {
  const worker = createAgent({
    name: 'worker',
    generate: async () => ({ content: 'done', toolCalls: [] }),
    stopWhen: stopWhen.noToolCalls(),
  });
  return createCatalogDispatcher({
    agentCatalog: { find: (name: string) => (name === 'worker' ? worker : undefined) },
    // The first two refusals never reach the runtime composition.
    runtime: options.runtime ?? ({} as RuntimeComposition),
    runtimeServices: createManualRuntimeServices(),
    getShutdownPromise: () => (shuttingDown ? Promise.resolve() : undefined),
    catalogRuns: new Set(),
    runAttribution: options.runAttribution ?? new Map(),
    detachBestEffortPromise: () => {},
    createBureauError: (message, code) => Object.assign(new Error(message), { code }),
    validateAgentRunInput: () => {},
    validateBureauRunOptions: () => {},
    onDurableRunAborted: () => {},
  });
}

/** Just enough of a durable composition to reach the recovery-record write. */
function durableRuntime(claimed: boolean): RuntimeComposition {
  return {
    durable: { engine: {}, checkpointStore: {} },
    createBureauInvariantHooks: () => undefined,
    claimCatalogRunRecoveryRecord: async () => claimed,
    persistCatalogRunRecoveryRecord: () => {
      throw new Error('a child never overwrites a recovery record');
    },
  } as unknown as RuntimeComposition;
}

const start = {
  input: 'work',
  childRunId: 'child-1',
  context: {
    childCorrelation: {
      parentAgentName: 'planner',
      parentRunId: 'parent-1',
      childAgentName: 'worker',
      childRunId: 'child-1',
    },
  },
};

describe('createCatalogDispatcher — startChildRun', () => {
  it('refuses to start a child once the bureau is shutting down', () => {
    expect(() => createDispatcher(true).startChildRun({ ...start, agentName: 'worker' })).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });

  it('refuses a run identifier another run is already attributed under, and leaves it attributed', () => {
    const runAttribution = new Map([['child-1', { agentName: 'worker', principal: 'alice' }]]);
    const dispatcher = createDispatcher(false, { runtime: durableRuntime(true), runAttribution });

    expect(() =>
      dispatcher.startChildRun({ ...start, agentName: 'worker', principal: 'mallory' }),
    ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(runAttribution.get('child-1')).toEqual({ agentName: 'worker', principal: 'alice' });
  });

  it('fails a child whose recovery record another run already holds, and drops its own attribution', async () => {
    const runAttribution = new Map<string, RunAttribution>();
    const dispatcher = createDispatcher(false, { runtime: durableRuntime(false), runAttribution });

    const run = dispatcher.startChildRun({ ...start, agentName: 'worker', principal: 'mallory' });
    const result = await run.result();

    expect(result.finishReason).toBe('error');
    expect(String(result.error)).toContain('Run "child-1" already exists');
    expect(runAttribution.has('child-1')).toBe(false);
  });

  it('refuses to start a child for an agent the catalog does not have', () => {
    const dispatcher = createDispatcher(false);

    expect(dispatcher.planChildRun('nobody')).toBeUndefined();
    expect(() => dispatcher.startChildRun({ ...start, agentName: 'nobody' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});

const realRuntime = createDefaultRuntimeServices();

const settle = (started: { durablyStarted: Promise<void> }) =>
  started.durablyStarted.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('createCatalogDispatcher — startGoalAttemptRun', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });
  const attempt = {
    agentName: 'worker',
    input: 'work',
    runId: 'goal-g1-a0',
    goalRunId: 'g1',
    attemptIndex: 0,
  };

  it("settles durablyStarted only once the attempt's workflow is in the engine", async () => {
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
    const runtime = {
      durable: { engine, checkpointStore },
      createBureauInvariantHooks: () => undefined,
      claimCatalogRunRecoveryRecord: async () => true,
      persistCatalogRunRecoveryRecord: async () => {},
    } as unknown as RuntimeComposition;

    const started = createDispatcher(false, { runtime }).startGoalAttemptRun(attempt);
    // The handle is deferred: the workflow does not exist when it is returned.
    expect(await engine.get(attempt.runId)).toBeNull();

    await started.durablyStarted;

    expect(await engine.get(attempt.runId)).not.toBeNull();
    await started.run.result();
  });

  it('rejects durablyStarted with what stopped the start, so no goal waits on a run that never existed', async () => {
    const runtime = {
      ...durableRuntime(true),
      claimCatalogRunRecoveryRecord: async () => {
        throw new Error('recovery record write failed');
      },
    } as unknown as RuntimeComposition;

    const started = createDispatcher(false, { runtime }).startGoalAttemptRun(attempt);

    expect(
      await started.durablyStarted.then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toEqual(expect.objectContaining({ message: 'recovery record write failed' }));
  });

  it('never runs the agent directly when a lazy agent turns out not to resolve durably', async () => {
    // A lazy-wrapped agent only discovers, once invoked, that its module cannot
    // resolve run options. An ordinary run falls back to the agent's own `run()`;
    // a goal attempt must not, since that run is untracked and a retry would
    // launch a second one.
    let ranDirectly = 0;
    const lazy = {
      name: 'worker',
      hasOutput: false,
      run: () => {
        ranDirectly += 1;
        throw new Error('a goal attempt must never run the agent directly');
      },
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: () => {
        throw new AgentContractError('This agent does not support durable resolution.');
      },
    };
    const runtime = {
      durable: { engine: {}, checkpointStore: {} },
      createBureauInvariantHooks: () => undefined,
      claimCatalogRunRecoveryRecord: async () => true,
      persistCatalogRunRecoveryRecord: async () => {},
    } as unknown as RuntimeComposition;
    const runAttribution = new Map<string, RunAttribution>();
    const dispatcher = createCatalogDispatcher({
      agentCatalog: { find: () => lazy as never },
      runtime,
      runtimeServices: createManualRuntimeServices(),
      getShutdownPromise: () => undefined,
      catalogRuns: new Set(),
      runAttribution,
      detachBestEffortPromise: () => {},
      createBureauError: (message, code) => Object.assign(new Error(message), { code }),
      validateAgentRunInput: () => {},
      validateBureauRunOptions: () => {},
      onDurableRunAborted: () => {},
    });

    const started = dispatcher.startGoalAttemptRun(attempt);
    const reason = await started.durablyStarted.then(
      () => undefined,
      (error: unknown) => error,
    );
    const result = await started.run.result();

    expect(reason).toBeInstanceOf(GoalAttemptNotDurableCapableError);
    expect(ranDirectly).toBe(0);
    expect(result.finishReason).toBe('error');
  });

  describe('a start whose first execution outlived its start timeout', () => {
    /** A resolver that never answers on its first call, as a hung one does, and resolves normally after. */
    async function hungFirstResolver(runtimeOverrides: Record<string, unknown> = {}) {
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
      const worker = createAgent({
        name: 'worker',
        generate: async () => ({ content: 'done', toolCalls: [] }),
        stopWhen: stopWhen.noToolCalls(),
      });
      let calls = 0;
      let failFirst: (error: unknown) => void = () => {};
      const firstResolver = new Promise<never>((_resolve, reject) => {
        failFirst = reject;
      });
      const agent = new Proxy(worker, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property !== OPERATIVE_RESOLVE_RUN_OPTIONS || typeof value !== 'function') {
            return value;
          }
          return (...resolverArguments: unknown[]) => {
            calls += 1;
            return calls === 1
              ? firstResolver
              : (Reflect.apply(value, target, resolverArguments) as unknown);
          };
        },
      });
      const runtime = {
        durable: { engine, checkpointStore },
        createBureauInvariantHooks: () => undefined,
        claimCatalogRunRecoveryRecord: async () => true,
        persistCatalogRunRecoveryRecord: async () => {},
        ...runtimeOverrides,
      } as unknown as RuntimeComposition;
      const runAttribution = new Map<string, RunAttribution>();
      const dispatcher = createCatalogDispatcher({
        agentCatalog: { find: () => agent as never },
        runtime,
        runtimeServices: createManualRuntimeServices(),
        getShutdownPromise: () => undefined,
        catalogRuns: new Set(),
        runAttribution,
        detachBestEffortPromise: () => {},
        createBureauError: (message, code) => Object.assign(new Error(message), { code }),
        validateAgentRunInput: () => {},
        validateBureauRunOptions: () => {},
        onDurableRunAborted: () => {},
      });
      return { dispatcher, engine, runAttribution, failFirst };
    }

    it('lets the retry of the same attempt, agent, and principal reach the claim and start the workflow', async () => {
      const { dispatcher, engine, runAttribution } = await hungFirstResolver();

      // The first execution recorded its attribution and never got past its resolver.
      void dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      expect(runAttribution.get(attempt.runId)).toEqual({
        agentName: 'worker',
        principal: 'alice',
      });

      const retry = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      await retry.durablyStarted;

      expect(await engine.get(attempt.runId)).not.toBeNull();
      await retry.run.result();
    });

    it('keeps the retry’s attribution when the older execution fails after the retry took over', async () => {
      const { dispatcher, runAttribution, failFirst } = await hungFirstResolver();
      const older = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      const retry = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      await retry.durablyStarted;
      const held = runAttribution.get(attempt.runId);

      failFirst(new Error('the older resolver failed late'));
      expect(await settle(older)).toEqual(expect.objectContaining({ message: expect.any(String) }));

      // The retry's workflow is live: its owner's attribution is still held, by the
      // very object the retry holds, so a foreign principal is still refused.
      expect(runAttribution.get(attempt.runId)).toBe(held);
      expect(held).toEqual({ agentName: 'worker', principal: 'alice' });
      await retry.run.result();
    });

    it('drops the attribution once every execution holding it has failed', async () => {
      const { dispatcher, runAttribution, failFirst } = await hungFirstResolver({
        claimCatalogRunRecoveryRecord: async () => {
          throw new Error('claim write failed');
        },
      });
      const older = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      const retry = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      expect(await settle(retry)).toBeInstanceOf(Error);
      // The retry's failure leaves the older execution's hold in place.
      expect(runAttribution.has(attempt.runId)).toBe(true);

      failFirst(new Error('the older resolver failed late'));
      await settle(older);

      expect(runAttribution.has(attempt.runId)).toBe(false);
    });

    it.each([
      ['another principal', { ...attempt, principal: 'mallory' }],
      ['another attempt of the goal', { ...attempt, principal: 'alice', attemptIndex: 1 }],
      ['another goal', { ...attempt, principal: 'alice', goalRunId: 'g2' }],
    ])('still refuses %s under the attempt’s run id', async (_label, other) => {
      const { dispatcher, runAttribution } = await hungFirstResolver();
      void dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });

      expect(() => dispatcher.startGoalAttemptRun(other)).toThrow(
        expect.objectContaining({ code: 'CONFLICT' }),
      );
      expect(runAttribution.get(attempt.runId)).toEqual({
        agentName: 'worker',
        principal: 'alice',
      });
    });

    it('still refuses an attribution an ordinary run holds, whatever agent and principal it names', async () => {
      const { dispatcher, runAttribution } = await hungFirstResolver();
      runAttribution.set(attempt.runId, { agentName: 'worker', principal: 'alice' });

      expect(() => dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' })).toThrow(
        expect.objectContaining({ code: 'CONFLICT' }),
      );
    });
  });

  describe('a claim already holding the attempt id', () => {
    const conflicting = (record: Record<string, unknown> | undefined) => {
      const persisted: unknown[] = [];
      const runtime = {
        durable: { engine: {}, checkpointStore: {} },
        createBureauInvariantHooks: () => undefined,
        claimCatalogRunRecoveryRecord: async () => false,
        loadCatalogRunRecoveryRecord: async () =>
          record === undefined
            ? { status: 'missing' }
            : {
                status: 'found',
                record: { schemaVersion: 1, definitionRevision: 1, input: 'work', ...record },
              },
        persistCatalogRunRecoveryRecord: async (_runId: string, written: unknown) => {
          persisted.push(written);
        },
      } as unknown as RuntimeComposition;
      return { runtime, persisted };
    };
    it.each([
      [
        'a claim another goal holds',
        { agentName: 'worker', goalAttempt: { goalRunId: 'g2', attemptIndex: 0 } },
      ],
      [
        'a claim for another attempt',
        { agentName: 'worker', goalAttempt: { goalRunId: 'g1', attemptIndex: 4 } },
      ],
      ["an ordinary run's record", { agentName: 'worker' }],
      [
        "another principal's claim",
        {
          agentName: 'worker',
          principal: 'mallory',
          goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
        },
      ],
      ['no record at all', undefined],
    ])('refuses to overwrite %s', async (_label, record) => {
      const { runtime, persisted } = conflicting(record);

      const error = await settle(createDispatcher(false, { runtime }).startGoalAttemptRun(attempt));

      expect(error).toEqual(expect.objectContaining({ code: 'CONFLICT' }));
      expect(persisted).toEqual([]);
    });

    it('starts nothing from its own claim once the goal has tombstoned it', async () => {
      const { runtime, persisted } = conflicting({
        agentName: 'worker',
        goalAttempt: { goalRunId: 'g1', attemptIndex: 0, tombstonedAt: '2026-10-02T12:00:00.000Z' },
      });
      const runAttribution = new Map<string, RunAttribution>();

      const error = await settle(
        createDispatcher(false, { runtime, runAttribution }).startGoalAttemptRun(attempt),
      );

      // Refused before the engine is asked for a workflow (the engine here has no `start`).
      expect(error).toBeInstanceOf(GoalAttemptTombstonedError);
      expect(persisted).toEqual([]);
      expect(runAttribution.has(attempt.runId)).toBe(false);
    });

    it('adopts its own claim as it stands and never rewrites it', async () => {
      const { runtime, persisted } = conflicting({
        agentName: 'worker',
        goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
      });

      await settle(createDispatcher(false, { runtime }).startGoalAttemptRun(attempt));

      // The winning claim is immutable: a loser of the claim race adopts it, so
      // the record can only ever describe the execution that wins the workflow.
      expect(persisted).toEqual([]);
    });
  });

  describe('a start the goal ended over after it claimed the run and before the engine created it', () => {
    /**
     * The claim is written, then the goal's ending tombstones it, then the
     * engine creates the workflow: the window no check from outside can close.
     * The run it creates must refuse its first step.
     */
    async function overtakenStart() {
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
      let tombstoned = false;
      let generates = 0;
      const worker = createAgent({
        name: 'worker',
        generate: async () => {
          generates += 1;
          return { content: 'done', toolCalls: [] };
        },
        stopWhen: stopWhen.noToolCalls(),
      });
      const fenceTargets: unknown[] = [];
      const runtime = {
        durable: { engine, checkpointStore },
        // What the runtime composition does for a goal attempt's run.
        createBureauInvariantHooks: (goalAttempt?: { goalRunId: string }) => {
          const hooks = new HookRegistry<OperativeHookMap>({ source: 'bureau' });
          if (goalAttempt !== undefined) {
            fenceTargets.push(goalAttempt);
            registerGoalAttemptFence(
              hooks,
              { mayRun: () => Promise.resolve({ status: tombstoned ? 'refuse' : 'run' }) },
              goalAttempt as never,
            );
          }
          return hooks;
        },
        claimCatalogRunRecoveryRecord: async () => {
          // The claim lands, and the goal's ending tombstones it before the engine starts.
          tombstoned = true;
          return true;
        },
        persistCatalogRunRecoveryRecord: async () => {},
      } as unknown as RuntimeComposition;
      const dispatcher = createCatalogDispatcher({
        agentCatalog: { find: () => worker },
        runtime,
        runtimeServices: createManualRuntimeServices(),
        getShutdownPromise: () => undefined,
        catalogRuns: new Set(),
        runAttribution: new Map(),
        detachBestEffortPromise: () => {},
        createBureauError: (message, code) => Object.assign(new Error(message), { code }),
        validateAgentRunInput: () => {},
        validateBureauRunOptions: () => {},
        onDurableRunAborted: () => {},
      });
      return { dispatcher, engine, generates: () => generates, fenceTargets };
    }

    it('creates the run, which takes zero agent steps and ends', async () => {
      const { dispatcher, engine, generates, fenceTargets } = await overtakenStart();

      const started = dispatcher.startGoalAttemptRun(attempt);
      await started.durablyStarted;
      const result = await started.run.result();

      // The run exists, as a start no one can atomically withhold must be allowed to:
      expect(await engine.get(attempt.runId)).not.toBeNull();
      // and it took no step, and ended.
      expect(generates()).toBe(0);
      expect(result.steps).toHaveLength(0);
      expect(result.finishReason).toBe('tripwire');
      const ended = await engine.get(attempt.runId);
      expect(ended?.status).toBe('completed');
      // The fence was built for this attempt's own identity.
      expect(fenceTargets).toEqual([{ goalRunId: 'g1', attemptIndex: 0, runId: attempt.runId }]);
    });
  });

  describe('overlapping executions of one attempt', () => {
    const PRICING = (rate: number) => ({
      customPricing: {
        m: { promptCostPerMillionTokens: rate, completionCostPerMillionTokens: rate },
      },
    });

    /** A worker whose resolver always declares the given estimator, and which records what it ran. */
    function priced(costEstimation: unknown, ran: string[]) {
      const base = createAgent({
        name: 'worker',
        generate: async ({ conversation }) => {
          ran.push(lastPromptOf(conversation));
          return {
            content: 'done',
            toolCalls: [],
            usage: { prompt: 1_000_000, completion: 1_000_000, total: 2_000_000 },
          };
        },
        stopWhen: stopWhen.noToolCalls(),
      });
      const resolve = (
        base as unknown as Record<
          symbol,
          (input: unknown, context: unknown) => Promise<Record<string, unknown>>
        >
      )[OPERATIVE_RESOLVE_RUN_OPTIONS];
      if (resolve === undefined) throw new Error('the worker has no run-option resolver');
      return Object.create(base, {
        [OPERATIVE_RESOLVE_RUN_OPTIONS]: {
          value: (input: unknown, context: unknown) =>
            resolve.call(base, input, context).then((options) => ({ ...options, costEstimation })),
        },
      });
    }

    async function world(agent: unknown, seeded?: Record<string, unknown>) {
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
      const records = new Map<string, Record<string, unknown>>();
      if (seeded !== undefined) records.set(attempt.runId, seeded);
      const writes: unknown[] = [];
      const runtime = {
        durable: { engine, checkpointStore },
        createBureauInvariantHooks: () => undefined,
        claimCatalogRunRecoveryRecord: async (runId: string, record: Record<string, unknown>) => {
          if (records.has(runId)) return false;
          records.set(runId, { schemaVersion: 1, ...record });
          return true;
        },
        loadCatalogRunRecoveryRecord: async (runId: string) => {
          const record = records.get(runId);
          return record === undefined ? { status: 'missing' } : { status: 'found', record };
        },
        persistCatalogRunRecoveryRecord: async (runId: string, record: Record<string, unknown>) => {
          writes.push(record);
          records.set(runId, { schemaVersion: 1, ...record });
        },
      } as unknown as RuntimeComposition;
      const runAttribution = new Map<string, RunAttribution>();
      const dispatcher = createCatalogDispatcher({
        agentCatalog: { find: () => agent as never },
        runtime,
        runtimeServices: createManualRuntimeServices(),
        getShutdownPromise: () => undefined,
        catalogRuns: new Set(),
        runAttribution,
        detachBestEffortPromise: () => {},
        createBureauError: (message, code) => Object.assign(new Error(message), { code }),
        validateAgentRunInput: () => {},
        validateBureauRunOptions: () => {},
        onDurableRunAborted: () => {},
      });
      return { dispatcher, records, writes, engine, runAttribution };
    }

    const firstClaim = {
      schemaVersion: 1,
      agentName: 'worker',
      definitionRevision: 1,
      input: 'first input',
      goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
      costEstimation: { model: 'm', pricing: PRICING(1) },
    };

    it('starts a workflow from the winning claim, never from what it resolves itself', async () => {
      const ran: string[] = [];
      const { dispatcher, records, writes } = await world(
        priced({ model: 'm', pricing: PRICING(10) }, ran),
        firstClaim,
      );

      const started = dispatcher.startGoalAttemptRun({ ...attempt, input: 'second input' });
      await started.durablyStarted;
      const result = await started.run.result();

      // The claim is exactly what the first execution wrote.
      expect(writes).toEqual([]);
      expect(records.get(attempt.runId)).toEqual(firstClaim);
      // And the workflow ran its input at its rate, not the second execution's.
      expect(ran).toHaveLength(1);
      expect(ran[0]).toContain('first input');
      expect(ran[0]).not.toContain('second input');
      expect(result.costEstimate?.totalCost).toBeCloseTo(2, 5);
    });

    it('releases an execution’s share when its own durable start rejects, so the retry’s later failure deletes the entry', async () => {
      const { dispatcher, engine, runAttribution } = await world(
        priced({ model: 'm', pricing: PRICING(1) }, []),
      );
      let startCalls = 0;
      let openSecond: () => void = () => {};
      const secondMayFail = new Promise<void>((resolve) => {
        openSecond = resolve;
      });
      engine.start = async () => {
        startCalls += 1;
        if (startCalls === 2) await secondMayFail;
        throw new Error(`durable start ${startCalls} rejected`);
      };

      const first = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      const second = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      expect(await settle(first)).toEqual(
        expect.objectContaining({ message: 'durable start 1 rejected' }),
      );
      // The second execution still holds the entry.
      expect(runAttribution.has(attempt.runId)).toBe(true);

      openSecond();
      expect(await settle(second)).toEqual(
        expect.objectContaining({ message: 'durable start 2 rejected' }),
      );
      expect(runAttribution.has(attempt.runId)).toBe(false);
    });

    it('settles durablyStarted with the engine’s refusal and drops the attribution, leaving no rejection unhandled (COR-1418)', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const { dispatcher, engine, runAttribution } = await world(
          priced({ model: 'm', pricing: PRICING(1) }, []),
        );
        engine.start = async () => {
          throw new Error('the engine refused the workflow');
        };

        const started = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });

        expect(await settle(started)).toEqual(
          expect.objectContaining({ message: 'the engine refused the workflow' }),
        );
        expect(runAttribution.has(attempt.runId)).toBe(false);
        const result = await started.run.result();
        expect(result.finishReason).toBe('error');
        // A rejection nothing handled is reported once the microtask queue drains and a timer turn
        // has passed, so the observation waits one turn on a real timer.
        await new Promise<void>((resolve) => realRuntime.timers.setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('adopts the claim of an execution whose workflow already exists', async () => {
      const ran: string[] = [];
      const { dispatcher, records, writes, engine } = await world(
        priced({ model: 'm', pricing: PRICING(1) }, ran),
      );
      const winner = dispatcher.startGoalAttemptRun({ ...attempt, input: 'first input' });
      await winner.durablyStarted;
      const claimed = structuredClone(records.get(attempt.runId));

      const loser = createCatalogDispatcher({
        agentCatalog: { find: () => priced({ model: 'm', pricing: PRICING(10) }, ran) as never },
        runtime: {
          durable: { engine, checkpointStore: {} },
          createBureauInvariantHooks: () => undefined,
          claimCatalogRunRecoveryRecord: async () => false,
          loadCatalogRunRecoveryRecord: async () => ({ status: 'found', record: claimed }),
          persistCatalogRunRecoveryRecord: async (_id: string, record: unknown) => {
            writes.push(record);
          },
        } as unknown as RuntimeComposition,
        runtimeServices: createManualRuntimeServices(),
        getShutdownPromise: () => undefined,
        catalogRuns: new Set(),
        runAttribution: new Map(),
        detachBestEffortPromise: () => {},
        createBureauError: (message, code) => Object.assign(new Error(message), { code }),
        validateAgentRunInput: () => {},
        validateBureauRunOptions: () => {},
        onDurableRunAborted: () => {},
      });
      const refusal = await settle(
        loser.startGoalAttemptRun({ ...attempt, input: 'second input' }),
      );

      // The workflow is the winner's, so the loser's start is refused by the
      // engine (the goal port adopts it), and the claim is left alone.
      expect(refusal).toEqual(expect.objectContaining({ code: 'WorkflowAlreadyExistsError' }));
      expect(writes).toEqual([]);
      expect(records.get(attempt.runId)).toEqual(claimed);
      await winner.run.result();
    });
  });

  describe('a resolver that declares an estimator that cannot be persisted', () => {
    const cyclic: Record<string, unknown> = { model: 'm' };
    cyclic['self'] = cyclic;
    const throwingToJson = {
      model: 'm',
      toJSON: () => {
        throw new Error('toJSON failed');
      },
    };
    const price = (value: number) => ({
      model: 'm',
      pricing: {
        customPricing: {
          m: { promptCostPerMillionTokens: value, completionCostPerMillionTokens: 1 },
        },
      },
    });

    it.each([
      ['a cycle', cyclic],
      ['a bigint', { model: 'm', pricing: { customPricing: { m: { x: 1n } } } }],
      ['a throwing toJSON', throwingToJson],
      ['extra fields', { model: 'm', extra: true }],
      ['a negative price', price(-1)],
      ['a non-finite price', price(Number.NaN)],
      ['an empty model', { model: '' }],
    ])('ends the attempt permanently for %s, writing no claim', async (_label, costEstimation) => {
      const base = createAgent({
        name: 'worker',
        generate: async () => ({ content: 'done', toolCalls: [] }),
        stopWhen: stopWhen.noToolCalls(),
      });
      const resolve = (
        base as unknown as Record<
          symbol,
          (input: unknown, context: unknown) => Promise<Record<string, unknown>>
        >
      )[OPERATIVE_RESOLVE_RUN_OPTIONS];
      if (resolve === undefined) throw new Error('the worker has no run-option resolver');
      const agent = Object.create(base, {
        [OPERATIVE_RESOLVE_RUN_OPTIONS]: {
          value: (input: unknown, context: unknown) =>
            resolve.call(base, input, context).then((options) => ({ ...options, costEstimation })),
        },
      });
      const claims: unknown[] = [];
      const runtime = {
        durable: { engine: {}, checkpointStore: {} },
        createBureauInvariantHooks: () => undefined,
        claimCatalogRunRecoveryRecord: async (_id: string, record: unknown) => {
          claims.push(record);
          return true;
        },
        persistCatalogRunRecoveryRecord: async () => {},
      } as unknown as RuntimeComposition;
      const dispatcher = createCatalogDispatcher({
        agentCatalog: { find: () => agent as never },
        runtime,
        runtimeServices: createManualRuntimeServices(),
        getShutdownPromise: () => undefined,
        catalogRuns: new Set(),
        runAttribution: new Map(),
        detachBestEffortPromise: () => {},
        createBureauError: (message, code) => Object.assign(new Error(message), { code }),
        validateAgentRunInput: () => {},
        validateBureauRunOptions: () => {},
        onDurableRunAborted: () => {},
      });

      const error = await dispatcher.startGoalAttemptRun(attempt).durablyStarted.then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(GoalAttemptInvalidCostEstimationError);
      expect((error as GoalAttemptInvalidCostEstimationError).reason).toBe(
        'invalid-cost-estimation',
      );
      expect(claims).toEqual([]);
    });
  });
});
