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
    prompt?: string;
    maximumSteps?: number;
  },
  services: DurableRunDeps,
) {
  const handle = await engine.start(
    'agentRun',
    { ...input, sessionId: input.sessionId ?? input.runId },
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
    expect(isAgentRunWorkflowInput({ runId: 'run', sessionId: 'session' })).toBe(true);
    expect(isAgentRunWorkflowInput({ runId: 'run', sessionId: 'session', prompt: 'Hello' })).toBe(
      true,
    );
    expect(isAgentRunWorkflowInput({ runId: 'run', sessionId: 'session', prompt: 1 })).toBe(false);
    expect(isAgentRunWorkflowInput({ runId: 'run', sessionId: 'session', maximumSteps: 2 })).toBe(
      true,
    );
    expect(isAgentRunWorkflowInput({ runId: 'run', sessionId: 'session', maximumSteps: '2' })).toBe(
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
        { runId: 'run-1', sessionId: 'run-1', prompt: 'Hi' },
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
      input: { runId: string; sessionId?: string; prompt?: string },
      services: DurableRunDeps,
    ) {
      return engine.start(
        'agentRun',
        { ...input, sessionId: input.sessionId ?? input.runId },
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
});
