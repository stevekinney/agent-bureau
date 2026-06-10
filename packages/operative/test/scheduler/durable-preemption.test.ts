import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createCheckpointStore } from '../../src/durable/checkpoint-store';
import type { AnyRunEngine } from '../../src/durable/index';
import { createRunEngine } from '../../src/durable/index';
import { createRunWorkflow } from '../../src/durable/run-workflow';
import { stopWhen } from '../../src/index';
import { createScheduler } from '../../src/scheduler/create-scheduler';
import { sleep } from '../../src/scheduler/sleep';
import { createMockGenerate } from '../../src/test/index';
import type { GenerateFunction, GenerateResponse } from '../../src/types';

/** Counts calls to the engine's suspend/resume/cancel so a test can prove the
 *  durable preemption path was actually exercised (not an accidental abort+rerun
 *  that happens to satisfy the higher-level assertions). */
interface EngineSpy {
  engine: AnyRunEngine;
  suspends: string[];
  resumes: string[];
  cancels: string[];
}

function spyEngine(engine: AnyRunEngine): EngineSpy {
  const spy: EngineSpy = { engine, suspends: [], resumes: [], cancels: [] };
  const realSuspend = engine.suspend.bind(engine);
  const realResume = engine.resume.bind(engine);
  const realCancel = engine.cancel.bind(engine);
  // Wrap in place — the scheduler holds this same engine object.
  engine.suspend = async (id: string) => {
    spy.suspends.push(id);
    return realSuspend(id);
  };
  engine.resume = async (id: string) => {
    spy.resumes.push(id);
    return realResume(id);
  };
  engine.cancel = async (id: string) => {
    spy.cancels.push(id);
    return realCancel(id);
  };
  return spy;
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

/**
 * A generate that, on its FIRST step, blocks until released (or aborts on signal);
 * on every later step it completes immediately with a step-numbered marker. This
 * lets a test park a durable run mid-flight (at step 1's generate) and then prove
 * a resume continues from step 1 rather than re-running step 0.
 */
function createStepwiseBlockingGenerate(): {
  generate: GenerateFunction;
  releaseStep1: (response: GenerateResponse) => void;
  steps: number[];
} {
  const steps: number[] = [];
  let step1Resolver: ((response: GenerateResponse) => void) | undefined;
  const step1Promise = new Promise<GenerateResponse>((resolve) => {
    step1Resolver = resolve;
  });

  const generate: GenerateFunction = async (context) => {
    steps.push(context.step);
    if (context.step === 0) {
      // Step 0 completes immediately with a tool call so the run takes a 2nd step.
      return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
    }
    if (context.step === 1) {
      // Block at step 1 until released, or abort if the signal fires — BUT under
      // suspend (not cancel) the signal does NOT fire, so this stays blocked and
      // the run parks at step 1.
      return Promise.race([
        step1Promise,
        new Promise<GenerateResponse>((resolve) => {
          context.signal?.addEventListener('abort', () => resolve(textResponse('aborted')), {
            once: true,
          });
        }),
      ]);
    }
    return textResponse(`step ${context.step}`);
  };

  return {
    generate,
    releaseStep1: (response) => step1Resolver?.(response),
    steps,
  };
}

function createNextToolbox() {
  return createTestToolbox([
    {
      name: 'next',
      description: 'advance',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ outcome: 'success' as const, content: 'ok', result: 'ok' }),
    },
  ]);
}

describe('durable scheduler preemption (suspend/resume)', () => {
  it('suspends a preempted durable task and resumes it from its checkpoint, not from step 0', async () => {
    const storage = new MemoryStorage();
    const checkpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    const runWorkflow = createRunWorkflow(checkpointStore);
    const { engine } = await createRunEngine({
      storage,
      runWorkflow,
      checkpointStore,
      recover: false,
    });

    const spy = spyEngine(engine);
    const blocking = createStepwiseBlockingGenerate();
    let createRunCount = 0;

    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      durable: { engine, checkpointStore },
    });

    // SINGLE-OWNER GUARD (Codex Q2): the original suspended dispatch's result
    // promise still settles when the SAME workflow completes via resume. Count
    // TaskCompletedEvents for the bg task to prove it is terminalized exactly
    // ONCE (the abandoned continuation must not double-fire).
    let bgCompletedCount = 0;
    scheduler.addEventListener('task.completed', (event) => {
      if (event.taskId === 'bg-durable') bgCompletedCount++;
    });

    scheduler.start();

    try {
      const bgResult = scheduler.submit({
        id: 'bg-durable',
        priority: 'background',
        requeue: true,
        maxRequeues: 3,
        createRun: () => {
          createRunCount++;
          return {
            generate: blocking.generate,
            toolbox: createNextToolbox(),
            conversation: new Conversation(),
            maximumSteps: 5,
            stopWhen: stopWhen.noToolCalls(),
          };
        },
      });

      // Let the durable run reach and block at step 1 (step 0 done + checkpointed).
      await waitFor(() => blocking.steps.includes(1));

      // Preempt with an immediate task → the durable bg run SUSPENDS (not aborts).
      const immResult = scheduler.submitImmediate(() => ({
        generate: createMockGenerateOnce('imm'),
        toolbox: createNextToolbox(),
        conversation: new Conversation(),
        maximumSteps: 1,
      }));
      await immResult;

      // Release step 1 so the RESUMED run can finish.
      blocking.releaseStep1({ content: 'step 1 final', toolCalls: [] });

      const bgRunResult = await bgResult;

      // The task completed via RESUME — createRun() was called exactly ONCE (no
      // fresh re-run), and the resumed run continued (it did not re-run step 0:
      // step 0 appears once in the stepwise generate's record).
      expect(bgRunResult).not.toBeNull();
      expect(createRunCount).toBe(1);
      // Step 0 ran exactly once across the whole lifecycle (suspend preserved it;
      // resume short-circuited it via the step memo) — proving resume-from-checkpoint.
      expect(blocking.steps.filter((s) => s === 0)).toEqual([0]);
      // The bg task terminalized EXACTLY ONCE — no split-brain double-completion
      // from the abandoned suspended dispatch's still-settling result promise.
      expect(bgCompletedCount).toBe(1);
      // PROVE the durable path was actually used: the bg run was SUSPENDED exactly
      // once and RESUMED exactly once with the same run id (not abort+re-run).
      expect(spy.suspends).toHaveLength(1);
      expect(spy.resumes).toEqual(spy.suspends);
    } finally {
      await scheduler.stop();
      engine[Symbol.dispose]();
    }
  });

  it('cancels a preempted non-requeue durable task and resolves null', async () => {
    const storage = new MemoryStorage();
    const checkpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    const runWorkflow = createRunWorkflow(checkpointStore);
    const { engine } = await createRunEngine({
      storage,
      runWorkflow,
      checkpointStore,
      recover: false,
    });
    const spy = spyEngine(engine);
    const blocking = createStepwiseBlockingGenerate();

    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      durable: { engine, checkpointStore },
    });
    scheduler.start();

    try {
      // requeue:false → a preempted durable task is suspended then CANCELLED (it
      // will never resume), and its submit() promise resolves null.
      const bgResult = scheduler.submit({
        id: 'bg-no-requeue',
        priority: 'background',
        requeue: false,
        createRun: () => ({
          generate: blocking.generate,
          toolbox: createNextToolbox(),
          conversation: new Conversation(),
          maximumSteps: 5,
          stopWhen: stopWhen.noToolCalls(),
        }),
      });

      await waitFor(() => blocking.steps.includes(1));
      await scheduler.submitImmediate(() => ({
        generate: createMockGenerateOnce('imm'),
        toolbox: createNextToolbox(),
        conversation: new Conversation(),
        maximumSteps: 1,
      }));

      const bgRunResult = await bgResult;
      expect(bgRunResult).toBeNull();
      // Suspended then cancelled — the cancel terminalizes the parked run so it
      // does not dangle as a `suspended` workflow.
      expect(spy.suspends).toHaveLength(1);
      expect(spy.cancels).toEqual(spy.suspends);
      expect(spy.resumes).toHaveLength(0);
    } finally {
      await scheduler.stop();
      engine[Symbol.dispose]();
    }
  });
});

function createMockGenerateFallback(): GenerateFunction {
  return createMockGenerate([textResponse('fallback')]);
}

function createMockGenerateOnce(content: string): GenerateFunction {
  return createMockGenerate([textResponse(content)]);
}

async function waitFor(check: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (check()) return;
    await sleep(5);
  }
  throw new Error('waitFor: condition not met within attempts');
}
