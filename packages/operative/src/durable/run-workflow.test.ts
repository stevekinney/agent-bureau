import type { WorkflowServicesResolution, WorkflowServicesResolverInfo } from '@lostgradient/weft';
import { Engine } from '@lostgradient/weft';
import { MemoryStorage, type Storage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { HookRegistry } from 'lifecycle';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import type { OperativeHookMap } from '../hooks';
import type { GenerateFunction } from '../types';
import { createCheckpointStore } from './checkpoint-store';
import { createRunWorkflow, isAgentRunWorkflowInput } from './run-workflow';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps } from './types';

type RegistryToolbox = DurableRunDeps['toolbox'];
type ServicesResolver = (
  info: WorkflowServicesResolverInfo,
) => WorkflowServicesResolution | Promise<WorkflowServicesResolution>;

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

/** A toolbox with one no-op `next` tool that lets a run take multiple steps. */
function continuingToolbox(): RegistryToolbox {
  return createToolbox([nextTool]) as RegistryToolbox;
}

/**
 * Build an engine + checkpoint store over a given backend. Pass
 * `resolveWorkflowServices` to re-provide a recovered run's services on a fresh
 * engine (the cross-process recovery path).
 */
async function buildEngine(
  storage: Storage,
  recover: boolean,
  resolveWorkflowServices?: ServicesResolver,
) {
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const runWorkflow = createRunWorkflow(checkpointStore);
  const activities = createStorageActivities(checkpointStore);
  const engine = await Engine.create({
    storage,
    recover,
    ...(resolveWorkflowServices ? { resolveWorkflowServices } : {}),
    workflows: { agentRun: runWorkflow },
    activities: {
      saveCursor: activities.saveCursor,
      saveConversation: activities.saveConversation,
      recordStep: activities.recordStep,
    },
  });
  return { engine, checkpointStore };
}

/**
 * Build the per-run {@link DurableRunDeps} the workflow reads as `ctx.services`.
 * One shared toolbox instance backs both `toolbox` and `options.toolbox` (the
 * memo overrides `options.toolbox` with the top-level one anyway).
 */
function makeServices(generate: GenerateFunction): DurableRunDeps {
  const toolbox = continuingToolbox();
  return {
    toolbox,
    options: {
      generate,
      toolbox,
      conversation: createConversationHistory(),
      // The durable driver inherits executeLoop's stop semantics: a run halts
      // only when a configured stopWhen fires. `noToolCalls` is the standard
      // "agent settled" condition a real caller supplies.
      stopWhen: noToolCalls(),
    },
  };
}

/**
 * Same as {@link makeServices} but with an `afterToolExecution` hook wired in
 * (seam #11 — hook replay policy). The hook is `replay: 'effectful'`: it
 * performs an external side effect (`onEffect`) that a real hook would need to
 * be idempotent for, exactly like `createMemoryPersistHook`.
 */
function makeServicesWithEffectfulHook(
  generate: GenerateFunction,
  onEffect: () => void,
): DurableRunDeps {
  const toolbox = continuingToolbox();
  const hooks = new HookRegistry<OperativeHookMap>();
  hooks.on(
    'afterToolExecution',
    async () => {
      onEffect();
    },
    { replay: 'effectful' },
  );
  return {
    toolbox,
    options: {
      generate,
      toolbox,
      conversation: createConversationHistory(),
      stopWhen: noToolCalls(),
      hooks,
    },
  };
}

/** Start a run and await its result, keeping the handle off the await chain. */
async function runToCompletion(
  engine: Awaited<ReturnType<typeof buildEngine>>['engine'],
  input: {
    runId: string;
    sessionId?: string;
    agentName?: string;
    prompt?: string;
    maximumSteps?: number;
  },
  services: DurableRunDeps,
) {
  const handle = await engine.start(
    'agentRun',
    {
      ...input,
      sessionId: input.sessionId ?? input.runId,
      // F2: agentName in durable workflow input — defaults to '' in tests
      // where no specific agent name is relevant.
      agentName: input.agentName ?? '',
    },
    { id: input.runId, services },
  );
  return handle.result();
}

// Drain Weft's deferred inline-launch queue between tests. A pending setTimeout(0)
// inline-launch macrotask left by one durable run can be starved under full
// `bun test` concurrency (CI), making a later run that normally finishes in ~100ms
// blow past the 5s timeout. 0.3.0's drain-on-dispose only fires when an engine is
// disposed; it does NOT replace this BETWEEN-TEST flush, so the drain is restored.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('durable agentRun workflow', () => {
  it('treats malformed checkpoint JSON as absent data', async () => {
    const checkpointStore = createCheckpointStore({
      get: async () => '{',
      has: async () => true,
      set: async () => {},
      list: async () => [],
      delete: async () => {},
      deletePrefix: async () => 0,
      close: async () => {},
    });

    expect(await checkpointStore.loadCursor('bad-json')).toBeNull();
  });

  it('validates durable workflow input at the trust boundary', () => {
    expect(isAgentRunWorkflowInput(null)).toBe(false);
    expect(isAgentRunWorkflowInput({})).toBe(false);
    // F2: agentName is now required alongside runId and sessionId. A run
    // checkpointed before F2 (without agentName) fails this guard and is treated
    // as not-reconstructable — no compatibility-bridge fallback (cross-upgrade
    // in-flight runs are explicitly out of scope per architecture.md).
    expect(isAgentRunWorkflowInput({ runId: 'run', sessionId: 'session' })).toBe(false);
    expect(
      isAgentRunWorkflowInput({ runId: 'run', sessionId: 'session', agentName: 'researcher' }),
    ).toBe(true);
    expect(
      isAgentRunWorkflowInput({
        runId: 'run',
        sessionId: 'session',
        agentName: 'researcher',
        prompt: 'Hello',
      }),
    ).toBe(true);
    expect(
      isAgentRunWorkflowInput({
        runId: 'run',
        sessionId: 'session',
        agentName: 'researcher',
        prompt: 1,
      }),
    ).toBe(false);
    expect(
      isAgentRunWorkflowInput({
        runId: 'run',
        sessionId: 'session',
        agentName: 'researcher',
        maximumSteps: 2,
      }),
    ).toBe(true);
    expect(
      isAgentRunWorkflowInput({
        runId: 'run',
        sessionId: 'session',
        agentName: 'researcher',
        maximumSteps: '2',
      }),
    ).toBe(false);
    expect(isAgentRunWorkflowInput({ runId: 'run', sessionId: 'session', agentName: 42 })).toBe(
      false,
    );
  });

  it('runs a single-step agent to completion when generate emits no tool calls', async () => {
    const { engine, checkpointStore } = await buildEngine(new MemoryStorage(), false);
    let calls = 0;
    const services = makeServices(async () => {
      calls++;
      return { content: 'done', toolCalls: [] };
    });

    try {
      const handle = await engine.start(
        'agentRun',
        { runId: 'run-1', sessionId: 'run-1', agentName: '', prompt: 'Hi' },
        { id: 'run-1', services },
      );
      const result = await handle.result();

      expect(result.finishReason).toBe('stop-condition');
      expect(result.steps).toBe(1);
      expect(result.content).toBe('done');
      expect(calls).toBe(1);

      const checkpoint = await checkpointStore.loadCheckpoint('run-1');
      expect(checkpoint.cursor.step).toBe(1);
      expect(checkpoint.steps).toHaveLength(1);
      expect(checkpoint.conversation).not.toBeNull();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('takes multiple steps while generate keeps emitting tool calls', async () => {
    const { engine, checkpointStore } = await buildEngine(new MemoryStorage(), false);
    const services = makeServices(async ({ step }) => {
      if (step < 3) {
        return { content: `step ${step}`, toolCalls: [{ name: 'next', arguments: {} }] };
      }
      return { content: 'final', toolCalls: [] };
    });

    try {
      const result = await runToCompletion(engine, { runId: 'run-multi', prompt: 'Go' }, services);

      expect(result.steps).toBe(4); // steps 0,1,2 with tools + step 3 final
      expect(result.finishReason).toBe('stop-condition');

      const checkpoint = await checkpointStore.loadCheckpoint('run-multi');
      expect(checkpoint.steps).toHaveLength(4);
      // The transcript carries the assistant turns and tool results.
      const conversation = Conversation.from(checkpoint.conversation!);
      expect(conversation.getMessages().length).toBeGreaterThan(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('stops at maximumSteps when the agent never settles', async () => {
    const { engine } = await buildEngine(new MemoryStorage(), false);
    const services = makeServices(async ({ step }) => ({
      content: `step ${step}`,
      toolCalls: [{ name: 'next', arguments: {} }],
    }));

    try {
      const result = await runToCompletion(
        engine,
        {
          runId: 'run-cap',
          prompt: 'Loop',
          maximumSteps: 3,
        },
        services,
      );
      expect(result.steps).toBe(3);
      expect(result.finishReason).toBe('maximum-steps');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('serializes non-Error terminal failures across the durable workflow boundary', async () => {
    const stringRun = await buildEngine(new MemoryStorage(), false);
    try {
      const stringResult = await runToCompletion(
        stringRun.engine,
        { runId: 'run-string-error', prompt: 'Go' },
        makeServices(async () => {
          // This regression intentionally verifies non-Error terminal rejection serialization.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject('string failure');
        }),
      );

      expect(stringResult.finishReason).toBe('error');
      expect(stringResult.errorMessage).toBe('string failure');
    } finally {
      stringRun.engine[Symbol.dispose]();
    }

    const circularRun = await buildEngine(new MemoryStorage(), false);
    try {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      const circularResult = await runToCompletion(
        circularRun.engine,
        { runId: 'run-circular-error', prompt: 'Go' },
        makeServices(async () => {
          // This regression intentionally verifies non-Error terminal rejection serialization.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject(circular);
        }),
      );

      expect(circularResult.finishReason).toBe('error');
      expect(circularResult.errorMessage).toBe('[object Object]');
    } finally {
      circularRun.engine[Symbol.dispose]();
    }
  });

  describe('THE PROOF: cross-process resume-from-step-N via Weft recoverAll', () => {
    // The durability mechanism under test is Weft NATIVE recovery: engine A
    // suspends a workflow mid-run (a hanging generate), is disposed (a "crashed
    // process"), and engine B on the SAME backend calls `recoverAll()` to resume
    // it. Weft restarts the generator from the top and short-circuits each
    // `ctx.memo` to its checkpointed value, so every COMPLETED step's generate is
    // skipped and only the in-flight step re-runs — proving generate does not
    // re-execute from step 0 on recovery. Behavior for the remaining steps comes
    // from engine B's `resolveWorkflowServices` resolver (the bureau's role on a
    // fresh process), nothing hand-injected.

    /** Start a run but do NOT await — used when the run hangs mid-step. */
    function startRun(
      engine: Awaited<ReturnType<typeof buildEngine>>['engine'],
      input: { runId: string; sessionId?: string; agentName?: string; prompt?: string },
      services: DurableRunDeps,
    ) {
      return engine.start(
        'agentRun',
        {
          ...input,
          sessionId: input.sessionId ?? input.runId,
          agentName: input.agentName ?? '',
        },
        { id: input.runId, services },
      );
    }

    it('resumes a suspended run via the services RESOLVER, skipping completed steps (no re-run)', async () => {
      // One shared MemoryStorage instance both engines see, the way two processes
      // share a persistent backend.
      const storage = new MemoryStorage();

      // === Engine A: step 0 emits a tool call (commits), step 1's generate HANGS.
      // Disposing while suspended leaves the Weft workflow non-terminal. ===
      const aRunId = 'aaaaaaaa-0000-4000-8000-000000000001';
      const servicesA = makeServices(async ({ step }) =>
        step === 0
          ? { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] }
          : new Promise<never>(() => {}),
      );

      const a = await buildEngine(storage, false);
      const handle = await startRun(a.engine, { runId: aRunId, prompt: 'Start' }, servicesA);
      void handle.result().catch(() => {}); // never settles; keep it off the chain
      // Let step 0 commit and step 1 reach its hanging generate.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const afterCrash = await a.checkpointStore.loadCheckpoint(aRunId);
      expect(afterCrash.steps).toHaveLength(1);
      expect(afterCrash.steps[0]!.content).toBe('A step 0');
      a.engine[Symbol.dispose]();

      // === FRESH PROCESS: a brand-new engine whose ONLY source of this run's
      // behavior is its `resolveWorkflowServices` resolver — proving deps come
      // from the resolver, not any in-process registry. recoverAll resumes the
      // suspended workflow, and the resolver re-provides a settling generate. ===
      const recoveredSteps: number[] = [];
      const b = await buildEngine(storage, false, async (info) => {
        expect(info.workflowId).toBe(aRunId);
        return {
          status: 'available',
          services: makeServices(async ({ step }) => {
            recoveredSteps.push(step);
            return { content: `recovered step ${step}`, toolCalls: [] };
          }),
        };
      });
      try {
        const handles = await b.engine.recoverAll();
        expect(handles.length).toBe(1);
        const result = (await handles[0]!.result()) as { steps: number; finishReason: string };

        // ctx.memo short-circuited step 0 — generate ran ONLY for step 1.
        expect(recoveredSteps).toEqual([1]);
        expect(result.steps).toBe(2);
        expect(result.finishReason).toBe('stop-condition');

        // The recovered transcript carries step 0 from engine A plus step 1.
        const checkpoint = await b.checkpointStore.loadCheckpoint(aRunId);
        expect(checkpoint.steps.map((s) => s.content)).toEqual(['A step 0', 'recovered step 1']);
      } finally {
        b.engine[Symbol.dispose]();
      }
    });

    it('fires an effectful step-level hook exactly once across a crash/recover cycle (seam #11)', async () => {
      // Whole-step memoization (`ctx.memo` in run-workflow.ts) is what keeps a
      // hook's replay policy sound WITHOUT gating on it: `runStep` — and every
      // hook it invokes — runs entirely inside the step's memo, so a checkpointed
      // step's hooks are never re-invoked on recovery; only the in-flight
      // (un-memoized) step's hooks fire again. This proves that contract for an
      // `afterToolExecution` hook marked `replay: 'effectful'`.
      const storage = new MemoryStorage();
      const runId = 'cccccccc-0000-4000-8000-000000000003';

      // A side effect shared across both "processes" — modelling an external
      // store an effectful hook writes to (e.g. `createMemoryPersistHook`).
      let effectCount = 0;

      // Step 0 emits a tool call (the hook fires — effectCount -> 1), then step 1
      // hangs mid-generate so we can "crash" before it commits.
      const servicesA = makeServicesWithEffectfulHook(
        async ({ step }) =>
          step === 0
            ? { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] }
            : new Promise<never>(() => {}),
        () => {
          effectCount += 1;
        },
      );

      const a = await buildEngine(storage, false);
      const handle = await startRun(a.engine, { runId, prompt: 'Start' }, servicesA);
      void handle.result().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(effectCount).toBe(1);
      a.engine[Symbol.dispose]();

      // FRESH PROCESS: a new engine + a new HookRegistry closure, but the SAME
      // external effect target — recovery re-provides services via the resolver,
      // never any in-process registry. Step 1 is the FINAL step (no tool call),
      // so its own `afterToolExecution` never fires — isolating the assertion to
      // whether step 0's already-checkpointed hook re-fires.
      const b = await buildEngine(storage, false, async () => ({
        status: 'available',
        services: makeServicesWithEffectfulHook(
          async () => ({ content: 'recovered', toolCalls: [] }),
          () => {
            effectCount += 1;
          },
        ),
      }));
      try {
        const handles = await b.engine.recoverAll();
        expect(handles.length).toBe(1);
        const result = (await handles[0]!.result()) as { steps: number; finishReason: string };

        expect(result.steps).toBe(2);
        expect(result.finishReason).toBe('stop-condition');

        // The step-0 hook did NOT re-fire on recovery — ctx.memo short-circuited
        // the whole step (generate + tools + hooks) to its checkpointed result.
        // Step 1 never called the tool, so its hook never fired either.
        expect(effectCount).toBe(1);
      } finally {
        b.engine[Symbol.dispose]();
      }
    });

    it('fails just the unrecoverable resumed run (resolver unavailable) without bricking the engine', async () => {
      const storage = new MemoryStorage();
      const runId = 'bbbbbbbb-0000-4000-8000-000000000002';

      const servicesA = makeServices(async ({ step }) =>
        step === 0
          ? { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] }
          : new Promise<never>(() => {}),
      );

      const a = await buildEngine(storage, false);
      const handle = await startRun(a.engine, { runId, prompt: 'Start' }, servicesA);
      void handle.result().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      a.engine[Symbol.dispose]();

      // Fresh process whose resolver reports the run's services unavailable: Weft
      // fails THIS run terminally (pre-replay) without aborting recoverAll or the
      // engine. recoverAll resolves; the run is left `failed`, not running.
      const b = await buildEngine(storage, false, () => ({
        status: 'unavailable',
        reason: 'no config for this run on the fresh process',
      }));
      try {
        // recoverAll itself must not throw — the engine survives.
        const recoveredHandles = await b.engine.recoverAll();
        expect(recoveredHandles).toBeDefined();
        await yieldToPortableEventLoop();

        // The single unresolvable run is now terminally `failed` (not left
        // `running`, which a later boot would re-attempt forever).
        const state = (await b.engine.get(runId)) as { status?: string } | null;
        expect(state?.status).toBe('failed');
      } finally {
        b.engine[Symbol.dispose]();
      }
    });

    it('never checkpoints a Conversation instance (raw bytes are plain JSON)', async () => {
      const storage = new MemoryStorage();
      const services = makeServices(async ({ step }) => {
        if (step < 2) return { content: `s${step}`, toolCalls: [{ name: 'next', arguments: {} }] };
        return { content: 'final', toolCalls: [] };
      });

      const { engine } = await buildEngine(storage, false);
      try {
        await runToCompletion(engine, { runId: 'json-run', prompt: 'Hi' }, services);

        // Read the raw persisted transcript and assert it is plain JSON with no
        // function/prototype-bearing shape — i.e. no Conversation instance was
        // checkpointed. A `ConversationSnapshot` is a structuredClone-safe tree.
        const view = textValueStore(storage, { disposeUnderlyingStorage: false });
        const raw = await view.get('durable-run:json-run:transcript');
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw!) as Record<string, unknown>;
        expect(parsed).toHaveProperty('root');
        expect(parsed).toHaveProperty('currentPath');
        // structuredClone proves no functions/class-instances leaked into it.
        expect(() => structuredClone(parsed)).not.toThrow();
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('keeps per-step checkpoint size O(1) — step records do not embed the growing transcript', async () => {
      const storage = new MemoryStorage();
      const services = makeServices(async ({ step }) => {
        if (step < 5) return { content: `s${step}`, toolCalls: [{ name: 'next', arguments: {} }] };
        return { content: 'final', toolCalls: [] };
      });

      const { engine, checkpointStore } = await buildEngine(storage, false);
      try {
        await runToCompletion(engine, { runId: 'size-run', prompt: 'Hi' }, services);

        const checkpoint = await checkpointStore.loadCheckpoint('size-run');
        const view = textValueStore(storage, { disposeUnderlyingStorage: false });

        // Each StepRecord is bounded by its own step's content/tools — it must
        // NOT embed the full conversation (which grows with step count). Assert
        // no step record carries a transcript-shaped field.
        for (let step = 0; step < checkpoint.steps.length; step++) {
          const raw = await view.get(`durable-run:size-run:step:${String(step).padStart(10, '0')}`);
          const record = JSON.parse(raw!) as Record<string, unknown>;
          expect(record).not.toHaveProperty('conversation');
          expect(record).not.toHaveProperty('root');
        }
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  describe('Durable recovery: park requests survive crash-after-memo-commit', () => {
    /**
     * REGRESSION TEST for the pendingWakeup/pendingHumanWait recovery bug.
     *
     * Bug: `scheduleWakeup` (D6) and `requestHumanInput` (F3) mutate
     * `deps.pendingWakeup`/`deps.pendingHumanWait` inside `ctx.memo`. The memo
     * return value did NOT include those fields, so they were NOT checkpointed. On
     * crash recovery, Weft rebuilds fresh services (both fields unset), short-
     * circuits the memos (tools never re-run), and the post-loop read of
     * `ctx.services` saw `undefined` — causing the recovered run to COMPLETE
     * instead of re-parking.
     *
     * Fix: embed `deps.pendingWakeup`/`deps.pendingHumanWait` in the memo return
     * value, accumulate them into hoisted locals across steps, and use those locals
     * (not `ctx.services`) for the post-loop park. The checkpointed memo result
     * carries the park request, so recovery replays correctly.
     *
     * The crash is simulated by running engine A until the step memo commits, then
     * disposing it (mid-flight, before the post-loop `yield* ctx.waitForSignal`
     * executes). Engine B recovers via `recoverAll()` with FRESH services (no
     * in-process mutation on B's side) — exactly the real cross-process scenario.
     */
    it('re-parks via ctx.waitForSignal after crash-after-memo-commit on recovery (pendingHumanWait)', async () => {
      const storage = new MemoryStorage();

      // The run ID for this test; use a UUID-shaped string matching the pattern.
      const runId = 'cccccccc-0000-4000-8000-000000000003';
      const signalName = 'human-response';

      // Build the HITL tool + toolbox for engine A. The tool sets pendingHumanWait
      // on the deps object it closes over. Engine A's services carry the live dep ref.
      const depsA: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsA.ref) {
            depsA.ref.pendingHumanWait = {
              signalName: (params as { signalName: string }).signalName,
            };
          }
          return 'parked';
        },
      });
      const hitlToolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;

      // Engine A: maximumSteps=1 (workflow input), so after step 0 commits the loop
      // exits and the workflow reaches `yield* ctx.waitForSignal(signalName)`. We
      // poll until engine A is parked there (status 'running', step committed), then
      // dispose it — simulating a process crash while parked on the signal.
      //
      // THE CRASH WINDOW: after the step-0 memo commits (pendingHumanWait is in the
      // checkpointed result), the loop exits and the workflow parks. On recovery,
      // Weft replays the generator. With the BUG: the post-loop code reads
      // `ctx.services.pendingHumanWait` which is UNSET on B's fresh services →
      // `waitForSignal` is skipped → run completes. With the FIX: the post-loop code
      // reads the hoisted local fed from the checkpointed memo result → `waitForSignal`
      // is called → run parks again.
      const servicesA: DurableRunDeps = {
        options: {
          // Step 0: generate returns the HITL tool call. The tool sets pendingHumanWait.
          // Outcome is `next` (tool was called), so the loop continues — but maximumSteps=1
          // is passed in the workflow INPUT (not options), so the while-condition exits
          // after step 0 completes.
          generate: async () => ({
            content: '',
            toolCalls: [{ name: 'requestHumanInput', arguments: { signalName } }],
          }),
          toolbox: hitlToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox: hitlToolbox,
      };
      depsA.ref = servicesA;

      const a = await buildEngine(storage, false);
      const handleA = await a.engine.start(
        'agentRun',
        // Pass maximumSteps=1 via the WORKFLOW INPUT so the loop exits after step 0.
        // maximumSteps in RunOptions (servicesA.options) is ignored by the durable
        // workflow; the durable driver reads it from AgentRunWorkflowInput instead.
        { runId, sessionId: runId, agentName: 'hitl-agent', prompt: 'start', maximumSteps: 1 },
        { id: runId, services: servicesA },
      );
      void handleA.result().catch(() => {}); // parks on waitForSignal; never settles

      // Poll until engine A is parked on ctx.waitForSignal: step 0 committed AND
      // the workflow is 'running' (parked, not yet completed).
      let parkedOnA = false;
      for (let i = 0; i < 100; i++) {
        await yieldToPortableEventLoop();
        const snap = await handleA.snapshot();
        if (snap?.status === 'running') {
          const cp = await a.checkpointStore.loadCheckpoint(runId);
          if (cp.steps.length >= 1) {
            parkedOnA = true;
            break;
          }
        }
      }
      expect(parkedOnA).toBe(true);

      // "Crash" engine A: dispose while parked on waitForSignal. This simulates
      // the crash window where the memo committed but the process died before the
      // run completed (or, equivalently, between saveCursor and waitForSignal).
      a.engine[Symbol.dispose]();

      // === FRESH PROCESS: Engine B recovers with brand-new services — the critical
      // invariant is that pendingHumanWait is NOT set on B's services (fresh deps,
      // no in-process tool mutation). Without the fix, the generator replays and the
      // post-loop code reads `ctx.services.pendingHumanWait` === undefined → skips
      // waitForSignal → run completes. With the fix, it reads the hoisted local fed
      // from the checkpointed step-0 memo result → waitForSignal → parks.
      const b = await buildEngine(storage, false, (_info) => ({
        status: 'available',
        // Fresh services: pendingHumanWait not set, generate won't be called (memos
        // short-circuit), toolbox has the hitlTool so Weft's schema resolution doesn't
        // error on replay.
        services: (() => {
          const freshToolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;
          const freshServices: DurableRunDeps = {
            options: {
              generate: async () => ({ content: 'done after signal', toolCalls: [] }),
              toolbox: freshToolbox,
              conversation: createConversationHistory(),
              stopWhen: noToolCalls(),
            },
            toolbox: freshToolbox,
          };
          return freshServices;
        })(),
      }));

      try {
        const handles = await b.engine.recoverAll();
        expect(handles.length).toBe(1);
        const recoveredHandle = handles[0]!;

        // Poll for the recovered workflow's status. With the FIX, it should be
        // 'running' (parked on waitForSignal). With the BUG, it should be
        // 'completed' — the run finished because waitForSignal was skipped.
        let reParked = false;
        for (let i = 0; i < 100; i++) {
          await yieldToPortableEventLoop();
          const snap = await recoveredHandle.snapshot();
          if (snap?.status === 'running') {
            reParked = true;
            break;
          }
          // If it already completed or failed, the bug is present — break and let
          // the assertion below report it as a failure.
          if (snap?.status === 'completed' || snap?.status === 'failed') break;
        }

        // === THE KEY ASSERTION: the recovered run must be parked (still running),
        // not completed. On the UNFIXED code this assertion FAILS — the run completes
        // because pendingHumanWait is unset on the fresh services and the post-loop
        // code skips waitForSignal.
        expect(reParked).toBe(true);

        // Double-check: status is still running (not racing to complete).
        const parkSnap = await recoveredHandle.snapshot();
        expect(parkSnap?.status).toBe('running');
      } finally {
        b.engine[Symbol.dispose]();
      }
    });

    it('re-parks via ctx.sleep after crash-after-memo-commit on recovery (pendingWakeup)', async () => {
      // Same crash scenario but for the D6 scheduleWakeup / ctx.sleep path.
      const storage = new MemoryStorage();
      const runId = 'dddddddd-0000-4000-8000-000000000004';

      // A tool that sets deps.pendingWakeup (mimics createScheduleWakeupTool).
      const depsA: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup after a duration',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsA.ref) {
            depsA.ref.pendingWakeup = {
              duration: (params as { duration: number }).duration,
              note: 'wakeup note',
            };
          }
          return 'scheduled';
        },
      });
      const wakeupToolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;

      const servicesA: DurableRunDeps = {
        options: {
          generate: async () => ({
            content: '',
            // A very long sleep duration so the workflow stays parked indefinitely
            // in tests (the scheduler doesn't fire within a test run).
            toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 999_999_999 } }],
          }),
          toolbox: wakeupToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox: wakeupToolbox,
      };
      depsA.ref = servicesA;

      const a = await buildEngine(storage, false);
      const handleA = await a.engine.start(
        'agentRun',
        { runId, sessionId: runId, agentName: 'wakeup-agent', prompt: 'start', maximumSteps: 1 },
        { id: runId, services: servicesA },
      );
      void handleA.result().catch(() => {});

      // Poll until engine A parks on ctx.sleep (step 0 committed, status=running).
      let parkedOnA = false;
      for (let i = 0; i < 100; i++) {
        await yieldToPortableEventLoop();
        const snap = await handleA.snapshot();
        if (snap?.status === 'running') {
          const cp = await a.checkpointStore.loadCheckpoint(runId);
          if (cp.steps.length >= 1) {
            parkedOnA = true;
            break;
          }
        }
      }
      expect(parkedOnA).toBe(true);

      // Simulate crash.
      a.engine[Symbol.dispose]();

      // Engine B with FRESH services (pendingWakeup NOT set).
      const b = await buildEngine(storage, false, (_info) => ({
        status: 'available',
        services: (() => {
          const freshToolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;
          const freshServices: DurableRunDeps = {
            options: {
              generate: async () => ({ content: 'done', toolCalls: [] }),
              toolbox: freshToolbox,
              conversation: createConversationHistory(),
              stopWhen: noToolCalls(),
            },
            toolbox: freshToolbox,
          };
          return freshServices;
        })(),
      }));

      try {
        const handles = await b.engine.recoverAll();
        expect(handles.length).toBe(1);
        const recoveredHandle = handles[0]!;

        // Poll: the recovered run should be 'running' (parked on ctx.sleep).
        // On the UNFIXED code: 'completed' (sleep was skipped because pendingWakeup
        // was unset on fresh services).
        let reParked = false;
        for (let i = 0; i < 100; i++) {
          await yieldToPortableEventLoop();
          const snap = await recoveredHandle.snapshot();
          if (snap?.status === 'running') {
            reParked = true;
            break;
          }
          if (snap?.status === 'completed' || snap?.status === 'failed') break;
        }

        // === THE KEY ASSERTION: must be parked (sleeping), not completed. ===
        expect(reParked).toBe(true);
      } finally {
        b.engine[Symbol.dispose]();
      }
    });
  });

  describe('F3 — HITL via requestHumanInput tool (pendingHumanWait + ctx.waitForSignal)', () => {
    /**
     * Proves that setting `deps.pendingHumanWait` in a tool causes the run
     * workflow to park via `yield* ctx.waitForSignal(signalName)` after the
     * step loop exits, and that a subsequent `engine.signal(runId, signalName,
     * payload)` releases the parked run so it reaches 'completed'.
     *
     * This tests the F3 seam: the tool writes `pendingHumanWait`, the workflow
     * reads it outside `ctx.memo`, and parks until the signal arrives.
     */
    it('parks via ctx.waitForSignal when pendingHumanWait is set, then resumes on signal', async () => {
      const storage = new MemoryStorage();
      const { engine } = await buildEngine(storage, false);

      // A tool that sets deps.pendingHumanWait (mimics createRequestHumanInputTool).
      // Use a container object so the closure captures the reference before
      // `services` is constructed, avoiding a `prefer-const` lint violation.
      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = {
              signalName: (params as { signalName: string }).signalName,
            };
          }
          return 'parked';
        },
      });

      const hitlToolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;

      // Step counter so the generate function knows which step it is on. The
      // durable run calls the hitlTool on step 0, then finishes on step 1.
      let stepCallCount = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const callIndex = stepCallCount++;
            if (callIndex === 0) {
              // First generate call: emit a hitl tool call to set pendingHumanWait.
              return {
                content: '',
                toolCalls: [
                  { name: 'requestHumanInput', arguments: { signalName: 'human-response' } },
                ],
              };
            }
            // Subsequent call (after signal): finish.
            return { content: 'done after human input', toolCalls: [] };
          },
          toolbox: hitlToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          maximumSteps: 5,
        },
        toolbox: hitlToolbox,
      };
      // Capture the deps ref so the tool can set pendingHumanWait.
      depsContainer.ref = services;

      try {
        const handle = await engine.start(
          'agentRun',
          { runId: 'hitl-run', sessionId: 'hitl-run', agentName: 'hitl-agent', prompt: 'start' },
          { id: 'hitl-run', services },
        );

        // Let the workflow run the first step and reach ctx.waitForSignal.
        // Weft inline-launch is async: we need to give the queue several ticks.
        let parked = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          // The run stays 'running' while parked on waitForSignal.
          if (snap?.status === 'running' && depsContainer.ref?.pendingHumanWait !== undefined) {
            parked = true;
            break;
          }
        }

        expect(parked).toBe(true);

        // Deliver the human signal to release the parked run.
        await engine.signal('hitl-run', 'human-response', { approved: true });

        // Wait for the run to complete. The step loop exited via noToolCalls()
        // (stop-condition) before parking, so the finish reason is 'stop-condition'.
        const result = await handle.result();
        expect(result.finishReason).toBe('stop-condition');
        // F3: humanWaitSignal carries the signal name the run parked on.
        expect(result.humanWaitSignal).toBe('human-response');

        const finalSnap = await handle.snapshot();
        expect(finalSnap?.status).toBe('completed');
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  describe('Park request mutual exclusivity (PRRT_kwDORvupsc6MZ-vk)', () => {
    /**
     * REGRESSION TESTS for the "pick only one durable park request" finding.
     *
     * Bug: when a durable run accumulated BOTH `pendingWakeup` (from a
     * `scheduleWakeup` tool call in one step) AND `pendingHumanWait` (from a
     * `requestHumanInput` tool call in a later step), the post-loop park code had
     * two INDEPENDENT `if` branches — so the workflow would `ctx.sleep(duration)`
     * AND THEN `ctx.waitForSignal(signalName)` in sequence.  That violates the
     * `DurableRunDeps` contract: the two park types are mutually exclusive and only
     * the last-set one governs parking.
     *
     * Fix: the accumulation loop now clears the OTHER local whenever one is updated
     * (last-write-wins, cross-step mutual exclusivity).  The post-loop parking
     * section uses `else if` as defense-in-depth so the two primitives can never
     * both execute.
     */

    it('only parks on ctx.waitForSignal when requestHumanInput overrides an earlier scheduleWakeup (cross-step)', async () => {
      // Step 0: emit a scheduleWakeup tool call (sets deps.pendingWakeup).
      // Step 1 (same run, maximumSteps=2): emit a requestHumanInput tool call
      //   (sets deps.pendingHumanWait).
      //
      // After the loop, pendingHumanWait was set LAST → it must be the governing
      // park.  The workflow should park on ctx.waitForSignal, NOT ctx.sleep.
      //
      // Without the fix: both locals are non-undefined, the two independent `if`
      // branches fire, the workflow sleeps (very long) and then waits for signal —
      // observable as a crash or extremely long test timeout.
      // With the fix: the wakeup local is cleared when humanWait is accumulated,
      // so only waitForSignal fires, the run parks (status='running'), and a
      // subsequent engine.signal releases it to 'completed'.

      const storage = new MemoryStorage();
      const runId = 'eeeeeeee-0000-4000-8000-000000000005';
      const signalName = 'human-approval';

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };

      // Tool that sets pendingWakeup — mimics createScheduleWakeupTool.
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = {
              duration: (params as { duration: number }).duration,
            };
          }
          return 'scheduled';
        },
      });

      // Tool that sets pendingHumanWait — mimics createRequestHumanInputTool.
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Request human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = {
              signalName: (params as { signalName: string }).signalName,
            };
          }
          return 'parked';
        },
      });

      const toolbox = createToolbox([wakeupTool, hitlTool]) as unknown as RegistryToolbox;

      let stepCallCount = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const call = stepCallCount++;
            if (call === 0) {
              // Step 0: schedule a very long wakeup (so if ctx.sleep fires, the test hangs).
              return {
                content: '',
                toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 999_999_999 } }],
              };
            }
            // Step 1: override with human-input request.
            return {
              content: '',
              toolCalls: [{ name: 'requestHumanInput', arguments: { signalName } }],
            };
          },
          toolbox,
          conversation: createConversationHistory(),
          // noToolCalls() would stop the run after the first tool-free step; both
          // steps here emit tool calls, so the run exits via maximumSteps (=2).
          stopWhen: noToolCalls(),
          maximumSteps: 5,
        },
        toolbox,
      };
      depsContainer.ref = services;

      const { engine } = await buildEngine(storage, false);
      try {
        const handle = await engine.start(
          'agentRun',
          // maximumSteps=2 in workflow input: step 0 (wakeup) + step 1 (hitl) exit the loop.
          { runId, sessionId: runId, agentName: 'test-agent', prompt: 'start', maximumSteps: 2 },
          { id: runId, services },
        );

        // Poll for the run to park on ctx.waitForSignal (status='running').
        // With the BUG: the run would sleep for 999_999_999 units before reaching
        // waitForSignal — observable as the test hanging or timing out.
        // With the FIX: only ctx.waitForSignal fires; the run parks immediately.
        let parked = false;
        for (let i = 0; i < 100; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (snap?.status === 'running') {
            parked = true;
            break;
          }
          if (snap?.status === 'completed' || snap?.status === 'failed') break;
        }

        // The run must be parked on the signal, not sleeping.
        expect(parked).toBe(true);

        // Send the human signal to release the parked run.
        await engine.signal(runId, signalName, { approved: true });

        // The released run re-enters the step loop (maximumSteps not exhausted yet
        // relative to where we are — the run should complete via maximum-steps or
        // stop-condition depending on the next generate).  Either way it should reach
        // 'completed' without hanging on ctx.sleep.
        const result = await handle.result();
        expect(['stop-condition', 'maximum-steps']).toContain(result.finishReason);

        // Crucially: humanWaitSignal is present and wakeupNote is absent — only the
        // human-wait path fired.
        expect(result.humanWaitSignal).toBe(signalName);
        expect(result.wakeupNote).toBeUndefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('only parks on ctx.sleep when scheduleWakeup is the only park request set', async () => {
      // Sanity check: a run that only calls scheduleWakeup (no requestHumanInput)
      // still parks on ctx.sleep — the fix must not break the single-park-type case.
      const storage = new MemoryStorage();
      const runId = 'ffffffff-0000-4000-8000-000000000006';

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = {
              duration: (params as { duration: number }).duration,
              note: 'check later',
            };
          }
          return 'scheduled';
        },
      });

      const toolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;

      const services: DurableRunDeps = {
        options: {
          generate: async () => ({
            content: '',
            toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 999_999_999 } }],
          }),
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox,
      };
      depsContainer.ref = services;

      const { engine } = await buildEngine(storage, false);
      try {
        const handle = await engine.start(
          'agentRun',
          { runId, sessionId: runId, agentName: 'wakeup-agent', prompt: 'start', maximumSteps: 1 },
          { id: runId, services },
        );
        void handle.result().catch(() => {});

        // Poll until parked on ctx.sleep (status='running', step committed).
        let parked = false;
        for (let i = 0; i < 100; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (snap?.status === 'running') {
            const cp = await engine.get(runId);
            if (cp) {
              parked = true;
              break;
            }
          }
        }
        expect(parked).toBe(true);
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  describe('Skip durable parking after terminal failures (PRRT_kwDORvupsc6MbhP0)', () => {
    /**
     * REGRESSION TESTS for the unconditional durable park after error/abort.
     *
     * Bug: the post-loop park block (`if (pendingWakeup !== undefined) {
     * yield* ctx.sleep(...) }` / `else if (pendingHumanWait !== undefined) {
     * yield* ctx.waitForSignal(...) }`) ran unconditionally. If a step called
     * `scheduleWakeup` or `requestHumanInput` and a SUBSEQUENT step (or the same
     * step, via another failing tool) terminated with `error` or `aborted`, the
     * loop broke early setting `stoppedEarly = true` and the failure finish reason —
     * but `pendingWakeup`/`pendingHumanWait` were never cleared. The park block
     * then fired anyway, leaving an errored/aborted session parked as `running`
     * until the timer/signal arrived, hiding the real outcome from callers.
     *
     * Fix: gate the park block (and the result park-metadata fields) on
     * `!isFailureOutcome`, where `isFailureOutcome` checks `finishReason` against
     * the failure set (`error`, `aborted`, `elicitation-denied`, `budget-exceeded`).
     * This covers both failing steps and a failing `onMaximumSteps` handler,
     * because both update `finishReason` before reaching the park section.
     */

    it('returns the error result immediately without parking when a step errors after scheduleWakeup', async () => {
      // Step 0: call scheduleWakeup (very long duration so if the park fires the
      //         test hangs). `pendingWakeup` is set in deps.
      // Step 1: generate throws → outcome.kind === 'error', finishReason = 'error'.
      // Expected: run completes with finishReason: 'error', no wakeupNote, no park.
      const { engine } = await buildEngine(new MemoryStorage(), false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = {
              duration: (params as { duration: number }).duration,
              note: 'check later',
            };
          }
          return 'scheduled';
        },
      });
      const toolbox = createToolbox([wakeupTool, nextTool]) as unknown as RegistryToolbox;

      let call = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const c = call++;
            if (c === 0) {
              return {
                content: '',
                toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 999_999_999 } }],
              };
            }
            throw new Error('generate failed after wakeup');
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'park-skip-error', prompt: 'Go', maximumSteps: 5 },
          services,
        );

        // Must complete immediately as an error — NOT park on ctx.sleep.
        expect(result.finishReason).toBe('error');
        expect(result.errorMessage).toBe('generate failed after wakeup');
        // Park metadata must be absent — the run did not park.
        expect(result.wakeupNote).toBeUndefined();
        expect(result.humanWaitSignal).toBeUndefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('returns the abort result immediately without parking when a step aborts after scheduleWakeup', async () => {
      // Step 0: call scheduleWakeup (very long duration). `pendingWakeup` is set.
      // Then abort the run via the AbortController signal.
      // Expected: run completes with finishReason: 'aborted', no park.
      const { engine } = await buildEngine(new MemoryStorage(), false);

      const controller = new AbortController();
      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = {
              duration: (params as { duration: number }).duration,
              note: 'check later',
            };
          }
          // Trigger the abort signal after the wakeup tool runs.
          controller.abort('manual-abort');
          return 'scheduled';
        },
      });
      const toolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;

      const services: DurableRunDeps = {
        options: {
          generate: async () => ({
            content: '',
            toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 999_999_999 } }],
          }),
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          signal: controller.signal,
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'park-skip-abort', prompt: 'Go', maximumSteps: 5 },
          services,
        );

        // Must complete as aborted — NOT park on ctx.sleep.
        expect(result.finishReason).toBe('aborted');
        // Park metadata must be absent — the run did not park.
        expect(result.wakeupNote).toBeUndefined();
        expect(result.humanWaitSignal).toBeUndefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('returns the error result immediately without parking when requestHumanInput was called but a later step errors', async () => {
      // Step 0: call requestHumanInput → pendingHumanWait is set.
      // Step 1: generate throws → outcome.kind === 'error'.
      // Expected: run completes with finishReason: 'error', no humanWaitSignal, no park.
      const { engine } = await buildEngine(new MemoryStorage(), false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = {
              signalName: (params as { signalName: string }).signalName,
            };
          }
          return 'parked';
        },
      });
      const toolbox = createToolbox([hitlTool, nextTool]) as unknown as RegistryToolbox;

      let call = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const c = call++;
            if (c === 0) {
              return {
                content: '',
                toolCalls: [{ name: 'requestHumanInput', arguments: { signalName: 'approval' } }],
              };
            }
            throw new Error('step 1 failed after hitl request');
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'park-skip-hitl-error', prompt: 'Go', maximumSteps: 5 },
          services,
        );

        // Must complete immediately as an error — NOT park on ctx.waitForSignal.
        expect(result.finishReason).toBe('error');
        expect(result.errorMessage).toBe('step 1 failed after hitl request');
        // Park metadata must be absent — the run did not park.
        expect(result.humanWaitSignal).toBeUndefined();
        expect(result.wakeupNote).toBeUndefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('returns the error result immediately without parking when onMaximumSteps handler errors after scheduleWakeup', async () => {
      // The loop exhausts maximumSteps (no early exit), so stoppedEarly stays false.
      // Step 0: scheduleWakeup sets pendingWakeup.
      // onMaximumSteps handler throws → finishReason = 'error'.
      // Expected: run completes with finishReason: 'error', no park, no wakeupNote.
      const { engine } = await buildEngine(new MemoryStorage(), false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = {
              duration: (params as { duration: number }).duration,
              note: 'wake me later',
            };
          }
          return 'scheduled';
        },
      });
      const toolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;

      const services: DurableRunDeps = {
        options: {
          generate: async () => ({
            content: '',
            toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 999_999_999 } }],
          }),
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          onMaximumSteps: async () => {
            throw new Error('handler exploded after wakeup scheduled');
          },
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'park-skip-oms-error', prompt: 'Go', maximumSteps: 1 },
          services,
        );

        // Must complete as an error — NOT park on ctx.sleep despite pendingWakeup being set.
        expect(result.finishReason).toBe('error');
        expect(result.errorMessage).toBe('handler exploded after wakeup scheduled');
        // Park metadata must be absent.
        expect(result.wakeupNote).toBeUndefined();
        expect(result.humanWaitSignal).toBeUndefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  describe('onMaximumSteps handler (PRRT_kwDORvupsc6MZErk)', () => {
    /**
     * REGRESSION TESTS for the missing `onMaximumSteps` invocation on the durable
     * path. Bug: when the step loop exhausted `maximumSteps`, the durable workflow
     * returned immediately with `finishReason: 'maximum-steps'` and never called
     * `options.onMaximumSteps`. The in-memory `executeLoop` calls the handler to let
     * agents synthesize a final answer (e.g. via `createEarlyStoppingHandler`).
     *
     * Fix: after the while loop, if no terminal outcome broke early (`!stoppedEarly`),
     * the handler runs inside `ctx.memo('on-maximum-steps')` so crash-recovery never
     * re-charges the handler's LLM call. `cursor.lastContent` and the transcript are
     * updated and persisted when the handler returns a string.
     */

    /** Build services with an agent that always emits a tool call (never settles). */
    function makeNeverSettlingServices(
      options?: Partial<DurableRunDeps['options']>,
    ): DurableRunDeps {
      const toolbox = continuingToolbox();
      return {
        toolbox,
        options: {
          generate: async ({ step }) => ({
            content: `step ${step}`,
            toolCalls: [{ name: 'next', arguments: {} }],
          }),
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          ...options,
        },
      };
    }

    it('invokes the handler and propagates its content to the result when the cap is reached', async () => {
      const { engine } = await buildEngine(new MemoryStorage(), false);
      let handlerCalled = false;

      const services = makeNeverSettlingServices({
        onMaximumSteps: async () => {
          handlerCalled = true;
          return 'Forced final answer';
        },
      });

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'oms-happy', prompt: 'Go', maximumSteps: 2 },
          services,
        );

        expect(handlerCalled).toBe(true);
        expect(result.finishReason).toBe('maximum-steps');
        expect(result.content).toBe('Forced final answer');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('does not invoke the handler when the loop exits via a stop condition', async () => {
      const { engine } = await buildEngine(new MemoryStorage(), false);
      let handlerCalled = false;

      const services = makeNeverSettlingServices({
        // Override generate to return no tool calls on step 0 → triggers noToolCalls() stop
        generate: async () => ({ content: 'done', toolCalls: [] }),
        onMaximumSteps: async () => {
          handlerCalled = true;
          return 'Should not appear';
        },
      });

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'oms-no-call', prompt: 'Hi', maximumSteps: 10 },
          services,
        );

        expect(handlerCalled).toBe(false);
        expect(result.finishReason).toBe('stop-condition');
        expect(result.content).toBe('done');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('converts a handler error to finishReason error and propagates its message', async () => {
      const { engine } = await buildEngine(new MemoryStorage(), false);

      const services = makeNeverSettlingServices({
        onMaximumSteps: async () => {
          throw new Error('handler exploded');
        },
      });

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'oms-error', prompt: 'Go', maximumSteps: 1 },
          services,
        );

        expect(result.finishReason).toBe('error');
        expect(result.errorMessage).toBe('handler exploded');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('memo short-circuits the handler on recovery — it is not re-invoked', async () => {
      // Verifies that `ctx.memo('on-maximum-steps')` makes the handler idempotent:
      // after engine A completes the handler and then crashes (simulated by dispose),
      // engine B recovering via recoverAll() replays the memo from the checkpoint
      // instead of re-running the handler. Handler invocation count must be 1.
      const storage = new MemoryStorage();
      const runId = 'oms-recovery-memo';

      let handlerCallCount = 0;

      // Engine A: reaches maximumSteps, calls the handler, then is disposed.
      const a = await buildEngine(storage, false);
      try {
        const servicesA: DurableRunDeps = makeNeverSettlingServices({
          onMaximumSteps: async () => {
            handlerCallCount++;
            return 'final answer from A';
          },
        });

        await runToCompletion(a.engine, { runId, prompt: 'Go', maximumSteps: 2 }, servicesA);
      } finally {
        a.engine[Symbol.dispose]();
      }

      // The handler ran exactly once during engine A.
      expect(handlerCallCount).toBe(1);

      // Engine B: recovers the run. The run is already completed (terminal), so
      // recoverAll finds no non-terminal runs to resume. Confirm the final content
      // is the one the handler produced (proving it was checkpointed by the memo).
      const b = await buildEngine(storage, false, async () => ({
        status: 'available',
        services: makeNeverSettlingServices({
          onMaximumSteps: async () => {
            handlerCallCount++;
            return 'should not be called on B';
          },
        }),
      }));
      try {
        const handles = await b.engine.recoverAll();
        // The run completed on A, so it is terminal — recoverAll should find
        // nothing to resume. The handler count stays at 1.
        expect(handles.length).toBe(0);
        expect(handlerCallCount).toBe(1);

        // The checkpoint cursor reflects the final content written by engine A.
        const checkpoint = await b.checkpointStore.loadCheckpoint(runId);
        expect(checkpoint.cursor.lastContent).toBe('final answer from A');
      } finally {
        b.engine[Symbol.dispose]();
      }
    });
  });
});
