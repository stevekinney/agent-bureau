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
import { registerRunDeps, resetRunDepsRegistry } from './deps-registry';
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
      loadCursor: activities.loadCursor,
      loadConversation: activities.loadConversation,
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

afterEach(() => {
  resetRunDepsRegistry();
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

  describe('THE PROOF: cross-process resume-from-step-N', () => {
    // The durability mechanism under test is the application-level checkpoint
    // store: the workflow body's loadCursor/loadConversation activities read the
    // persisted step position on (re)start, so a fresh engine on the same backend
    // continues from the last committed step. This is deliberately independent of
    // Weft's native workflow-instance recovery — it survives a workflow that
    // terminated (here, via a crash) and needs no deps re-injection trickery to
    // resume the *position*, only to supply behavior for the remaining steps.
    it('resumes from the last completed step on a fresh engine without re-running completed steps', async () => {
      // A shared backend both "process" engines see; recovery uses a fresh
      // engine on the SAME storage, the way a restarted process would.
      const storage = new MemoryStorage();
      const runId = 'crash-run';

      // === Engine A: run two steps, then "crash" by throwing inside generate
      // on step 2. Steps 0 and 1 are durably committed before the throw. ===
      let aCalls = 0;
      registerDeps(runId, async ({ step }) => {
        aCalls++;
        if (step >= 2) {
          throw new Error('SIMULATED CRASH at step 2');
        }
        return { content: `A step ${step}`, toolCalls: [{ name: 'next', arguments: {} }] };
      });

      const a = await buildEngine(storage, false);
      try {
        await runToCompletion(a.engine, { runId, prompt: 'Start' });
      } catch {
        // expected: the crash propagates as a workflow failure
      }

      const afterCrash = await a.checkpointStore.loadCheckpoint(runId);
      // Steps 0 and 1 survived the crash.
      expect(afterCrash.cursor.step).toBe(2);
      expect(afterCrash.steps).toHaveLength(2);
      expect(afterCrash.steps.map((s) => s.content)).toEqual(['A step 0', 'A step 1']);
      a.engine[Symbol.dispose]();

      // === FRESH PROCESS BOUNDARY ===
      // Clear the deps registry so the recovered run cannot advance on stale,
      // in-process closures. This is what makes the test prove real recovery
      // rather than false-greening on a warm registry.
      resetRunDepsRegistry();

      // Prove the boundary is real: with an empty registry, a resumed run that
      // reaches the generate region throws the descriptive deps-missing error.
      // (Behavior must be re-injected before the run can advance — seam #5.)
      const bareEngine = await buildEngine(storage, false);
      let depsMissing: unknown;
      try {
        await runToCompletion(bareEngine.engine, { runId, prompt: 'Start' });
      } catch (error) {
        depsMissing = error;
      }
      expect((depsMissing as Error | undefined)?.message).toMatch(/No durable run deps registered/);
      bareEngine.engine[Symbol.dispose]();

      // === Engine B: re-inject deps with a generate that settles (no tool
      // calls). A fresh run from step 0 would call generate at step 0; a
      // correctly-resumed run continues at step 2. ===
      let bCalls = 0;
      const bSteps: number[] = [];
      registerDeps(runId, async ({ step }) => {
        bCalls++;
        bSteps.push(step);
        return { content: `B recovered step ${step}`, toolCalls: [] };
      });

      // Re-start the run on the fresh engine using the persisted cursor: the
      // workflow's loadCursor/loadConversation activities rehydrate step 2.
      const b = await buildEngine(storage, false);
      try {
        const result = await runToCompletion(b.engine, { runId, prompt: 'Start' });

        // Resumed at step 2, did NOT restart at 0.
        expect(bSteps).toEqual([2]);
        expect(bCalls).toBe(1);
        expect(result.steps).toBe(3);
        expect(result.finishReason).toBe('stop-condition');

        // The recovered transcript still contains the steps A produced.
        const checkpoint = await b.checkpointStore.loadCheckpoint(runId);
        expect(checkpoint.steps).toHaveLength(3);
        expect(checkpoint.steps.map((s) => s.content)).toEqual([
          'A step 0',
          'A step 1',
          'B recovered step 2',
        ]);
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
