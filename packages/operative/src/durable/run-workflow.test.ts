import { Engine } from '@lostgradient/weft';
import { MemoryStorage, type Storage, textValueStore } from '@lostgradient/weft/storage';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import type { GenerateFunction } from '../types';
import { createCheckpointStore } from './checkpoint-store';
import type { DurableRunDeps } from './deps-registry';
import { registerRunDeps, resetRunDepsRegistry, setRunDepsReconstructor } from './deps-registry';
import { createRunWorkflow } from './run-workflow';
import { createStorageActivities } from './storage-activities';

type RegistryToolbox = DurableRunDeps['toolbox'];

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

/** Build an engine + checkpoint store over a given backend. */
async function buildEngine(storage: Storage, recover: boolean) {
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const runWorkflow = createRunWorkflow(checkpointStore);
  const activities = createStorageActivities(checkpointStore);
  const engine = await Engine.create({
    storage,
    recover,
    workflows: { agentRun: runWorkflow },
    activities: {
      saveCursor: activities.saveCursor,
      saveConversation: activities.saveConversation,
      recordStep: activities.recordStep,
    },
  });
  return { engine, checkpointStore };
}

function registerDeps(runId: string, generate: GenerateFunction) {
  registerRunDeps(runId, {
    toolbox: continuingToolbox(),
    options: {
      generate,
      toolbox: continuingToolbox(),
      conversation: createConversationHistory(),
      // The durable driver inherits executeLoop's stop semantics: a run halts
      // only when a configured stopWhen fires. `noToolCalls` is the standard
      // "agent settled" condition a real caller supplies.
      stopWhen: noToolCalls(),
    },
  });
}

/** Start a run and await its result, keeping the handle off the await chain. */
async function runToCompletion(
  engine: Awaited<ReturnType<typeof buildEngine>>['engine'],
  input: {
    runId: string;
    prompt?: string;
    maximumSteps?: number;
  },
) {
  const handle = await engine.start('agentRun', input);
  return handle.result();
}

afterEach(async () => {
  resetRunDepsRegistry();
  // Drain Weft's deferred inline launch (see runtime-composition.test.ts).
  // Without this, a `setTimeout(0)` inline-launch macrotask left pending by one
  // durable run can be starved under full `bun test` concurrency, making a later
  // run that normally finishes in ~100ms blow past the 5s test timeout. Matches
  // the drain in active-run-adapter.test.ts and create-bureau.test.ts.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('durable agentRun workflow', () => {
  it('runs a single-step agent to completion when generate emits no tool calls', async () => {
    const { engine, checkpointStore } = await buildEngine(new MemoryStorage(), false);
    let calls = 0;
    registerDeps('run-1', async () => {
      calls++;
      return { content: 'done', toolCalls: [] };
    });

    try {
      const handle = await engine.start('agentRun', { runId: 'run-1', prompt: 'Hi' });
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
    registerDeps('run-multi', async ({ step }) => {
      if (step < 3) {
        return { content: `step ${step}`, toolCalls: [{ name: 'next', arguments: {} }] };
      }
      return { content: 'final', toolCalls: [] };
    });

    try {
      const result = await runToCompletion(engine, { runId: 'run-multi', prompt: 'Go' });

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
    registerDeps('run-cap', async ({ step }) => ({
      content: `step ${step}`,
      toolCalls: [{ name: 'next', arguments: {} }],
    }));

    try {
      const result = await runToCompletion(engine, {
        runId: 'run-cap',
        prompt: 'Loop',
        maximumSteps: 3,
      });
      expect(result.steps).toBe(3);
      expect(result.finishReason).toBe('maximum-steps');
    } finally {
      engine[Symbol.dispose]();
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
    // from a reconstructor (the bureau's role), nothing hand-injected.

    /** Start a run but do NOT await — used when the run hangs mid-step. */
    function startRun(
      engine: Awaited<ReturnType<typeof buildEngine>>['engine'],
      input: { runId: string; prompt?: string },
    ) {
      return engine.start('agentRun', input);
    }

    it('resumes a suspended run via a RECONSTRUCTOR, skipping completed steps (no re-run)', async () => {
      // One shared MemoryStorage instance both engines see, the way two processes
      // share a persistent backend.
      const storage = new MemoryStorage();

      // === Engine A: step 0 emits a tool call (commits), step 1's generate HANGS.
      // Disposing while suspended leaves the Weft workflow non-terminal. ===
      const aRunId = 'aaaaaaaa-0000-4000-8000-000000000001';
      registerRunDeps(aRunId, {
        toolbox: continuingToolbox(),
        options: {
          generate: async ({ step }: { step: number }) =>
            step === 0
              ? { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] }
              : new Promise<never>(() => {}),
          toolbox: continuingToolbox(),
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
      });

      const a = await buildEngine(storage, false);
      const handle = await startRun(a.engine, { runId: aRunId, prompt: 'Start' });
      void handle.result().catch(() => {}); // never settles; keep it off the chain
      // Let step 0 commit and step 1 reach its hanging generate.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const afterCrash = await a.checkpointStore.loadCheckpoint(aRunId);
      expect(afterCrash.steps).toHaveLength(1);
      expect(afterCrash.steps[0]!.content).toBe('A step 0');
      a.engine[Symbol.dispose]();

      // === FRESH PROCESS: empty registry + a reconstructor that supplies a
      // settling generate. recoverAll resumes the suspended workflow. ===
      resetRunDepsRegistry();
      const recoveredSteps: number[] = [];
      setRunDepsReconstructor(async () => ({
        toolbox: continuingToolbox(),
        options: {
          generate: async ({ step }: { step: number }) => {
            recoveredSteps.push(step);
            return { content: `recovered step ${step}`, toolCalls: [] };
          },
          toolbox: continuingToolbox(),
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
      }));

      const b = await buildEngine(storage, false);
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

    it('terminates an unrecoverable resumed run safely (no reconstructor) instead of bricking', async () => {
      const storage = new MemoryStorage();
      const runId = 'bbbbbbbb-0000-4000-8000-000000000002';

      registerRunDeps(runId, {
        toolbox: continuingToolbox(),
        options: {
          generate: async ({ step }: { step: number }) =>
            step === 0
              ? { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] }
              : new Promise<never>(() => {}),
          toolbox: continuingToolbox(),
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
      });

      const a = await buildEngine(storage, false);
      const handle = await startRun(a.engine, { runId, prompt: 'Start' });
      void handle.result().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      a.engine[Symbol.dispose]();

      // Fresh process, empty registry, NO reconstructor: the run cannot rebuild
      // its behavior, so the workflow terminates with a safe error result rather
      // than the engine bricking.
      resetRunDepsRegistry();
      const b = await buildEngine(storage, false);
      try {
        const handles = await b.engine.recoverAll();
        expect(handles.length).toBe(1);
        const result = (await handles[0]!.result()) as {
          finishReason: string;
          errorMessage?: string;
        };
        expect(result.finishReason).toBe('error');
        expect(result.errorMessage).toMatch(/could not be recovered/);
      } finally {
        b.engine[Symbol.dispose]();
      }
    });

    it('never checkpoints a Conversation instance (raw bytes are plain JSON)', async () => {
      const storage = new MemoryStorage();
      registerDeps('json-run', async ({ step }) => {
        if (step < 2) return { content: `s${step}`, toolCalls: [{ name: 'next', arguments: {} }] };
        return { content: 'final', toolCalls: [] };
      });

      const { engine } = await buildEngine(storage, false);
      try {
        await runToCompletion(engine, { runId: 'json-run', prompt: 'Hi' });

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
      registerDeps('size-run', async ({ step }) => {
        if (step < 5) return { content: `s${step}`, toolCalls: [{ name: 'next', arguments: {} }] };
        return { content: 'final', toolCalls: [] };
      });

      const { engine, checkpointStore } = await buildEngine(storage, false);
      try {
        await runToCompletion(engine, { runId: 'size-run', prompt: 'Hi' });

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
