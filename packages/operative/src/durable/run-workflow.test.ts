import type { WorkflowServicesResolution, WorkflowServicesResolverInfo } from '@lostgradient/weft';
import { Engine } from '@lostgradient/weft';
import { MemoryStorage, type Storage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
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
});
