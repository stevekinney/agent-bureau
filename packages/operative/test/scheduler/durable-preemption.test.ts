import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createTestToolbox } from 'armorer/test';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { HookRegistry } from 'lifecycle';

import { createCheckpointStore } from '../../src/durable/checkpoint-store';
import { createRunEngine } from '../../src/durable/index';
import { createRunWorkflow } from '../../src/durable/run-workflow';
import type { OperativeHookMap } from '../../src/index';
import { stopWhen } from '../../src/index';
import { createScheduler } from '../../src/scheduler/create-scheduler';
import {
  createManualCheckpointStore,
  createManualDurableEngine,
  createMockGenerate,
  createStepwiseBlockingGenerate,
  spyEngine,
} from '../../src/test/index';
import type { GenerateFunction } from '../../src/types';

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

// Drain Weft's deferred inline-launch queue between tests — these durable
// preemption tests start several engine workflows, and a pending setTimeout(0)
// inline-launch left by one can starve a later durable run under full `bun test`
// concurrency (CI). 0.3.0's dispose-drain does not replace this between-test flush.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

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

  it('does not strand a durable task when its run settles before preemption can park it', async () => {
    // The preemption race (committee review, high severity): a higher-priority
    // task triggers preemption, but the durable run had ALREADY completed before
    // engine.suspend could park it (engine.get status !== 'suspended'). The task
    // must NOT be stranded in `running` — it falls through to its completion path,
    // resolves, and the scheduler proceeds. Force the race by making engine.get
    // report the run as completed (not suspended) for the suspend attempt.
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

    // Spy: engine.suspend succeeds, but engine.get reports a non-suspended status
    // — modelling the run having completed in the suspend→get window.
    const realGet = engine.get.bind(engine);
    let suspendAttempts = 0;
    engine.suspend = async () => {
      suspendAttempts++;
    };
    engine.get = async (id: string) => {
      const state = await realGet(id);
      // Report 'completed' so suspendAndDetach takes the "already settled" path.
      return state ? { ...state, status: 'completed' as const } : state;
    };

    const blocking = createStepwiseBlockingGenerate();

    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      durable: { engine, checkpointStore },
    });
    scheduler.start();

    try {
      const bgResult = scheduler.submit({
        id: 'bg-race',
        priority: 'background',
        requeue: true,
        createRun: () => ({
          generate: blocking.generate,
          toolbox: createNextToolbox(),
          conversation: new Conversation(),
          maximumSteps: 5,
          stopWhen: stopWhen.noToolCalls(),
        }),
      });

      await waitFor(() => blocking.steps.includes(1));

      // Preempt — suspend "succeeds" but the run reads back as completed, so
      // suspendAndDetach reports not-preempted and the dispatch finishes the task.
      const immResult = scheduler.submitImmediate(() => ({
        generate: createMockGenerateOnce('imm'),
        toolbox: createNextToolbox(),
        conversation: new Conversation(),
        maximumSteps: 1,
      }));

      // Let the bg run actually finish (release step 1 with no tool calls).
      blocking.releaseStep1({ content: 'bg final', toolCalls: [] });

      // The immediate task completes (the scheduler was NOT blocked by a stranded
      // bg task) AND the bg task resolves to a real result (not null, not a hang).
      const immRunResult = await immResult;
      expect(immRunResult).not.toBeNull();
      const bgRunResult = await bgResult;
      expect(bgRunResult).not.toBeNull();
      expect(suspendAttempts).toBe(1);
    } finally {
      await scheduler.stop();
      engine[Symbol.dispose]();
    }
  });

  it('cancel() on a running durable task engine-cancels it and resolves the submit promise', async () => {
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
      const bgResult = scheduler.submit({
        id: 'bg-cancel',
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

      // cancel() a RUNNING durable task → engine.cancel (NOT just abortController,
      // which a resumed run isn't wired to) terminalizes the run + settles its
      // result, so the submit() promise resolves rather than hanging.
      const cancelled = scheduler.cancel('bg-cancel');
      expect(cancelled).toBe(true);

      const bgRunResult = await bgResult;
      // engine.cancel was called for the running durable run.
      expect(spy.cancels).toHaveLength(1);
      // The submit promise RESOLVED null (did not hang, did not reject) — a
      // cancelled durable task matches the in-memory cancel contract.
      expect(bgRunResult).toBeNull();
    } finally {
      await scheduler.stop();
      engine[Symbol.dispose]();
    }
  });

  it('emits task.failed when cancelling a running durable task fails', async () => {
    const manual = createManualDurableEngine();
    const engine = manual.engine;
    const checkpointStore = createManualCheckpointStore();
    const failedTaskIds: string[] = [];
    engine.cancel = async () => {
      manual.rejectResult(new Error('Workflow cancelled'));
      throw new Error('cancel write failed');
    };

    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      durable: { engine, checkpointStore },
    });
    scheduler.addEventListener('task.failed', (event) => {
      failedTaskIds.push(event.taskId);
    });
    scheduler.start();

    try {
      const bgResult = scheduler.submit({
        id: 'bg-cancel-fails',
        priority: 'background',
        requeue: false,
        createRun: () => ({
          generate: createMockGenerateOnce('unused'),
          toolbox: createNextToolbox(),
          conversation: new Conversation(),
          maximumSteps: 1,
        }),
      });

      await waitFor(() => scheduler.getState().activeTask?.id === 'bg-cancel-fails');
      expect(scheduler.cancel('bg-cancel-fails')).toBe(true);
      await bgResult;
      await yieldToPortableEventLoop();

      expect(failedTaskIds).toContain('bg-cancel-fails');
    } finally {
      await scheduler.stop();
    }
  });

  it('emits task.failed and completes normally when durable suspend fails during preemption', async () => {
    const manual = createManualDurableEngine();
    const engine = manual.engine;
    const checkpointStore = createManualCheckpointStore();
    const failedTaskIds: string[] = [];
    engine.suspend = async () => {
      throw new Error('suspend failed');
    };

    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      durable: { engine, checkpointStore },
    });
    scheduler.addEventListener('task.failed', (event) => {
      failedTaskIds.push(event.taskId);
    });
    scheduler.start();

    try {
      const bgResult = scheduler.submit({
        id: 'bg-suspend-fails',
        priority: 'background',
        requeue: true,
        createRun: () => ({
          generate: createMockGenerateOnce('unused'),
          toolbox: createNextToolbox(),
          conversation: new Conversation(),
          maximumSteps: 1,
        }),
      });

      await waitFor(() => scheduler.getState().activeTask?.id === 'bg-suspend-fails');
      const immediate = scheduler.submitImmediate(() => ({
        generate: createMockGenerateOnce('imm'),
        toolbox: createNextToolbox(),
        conversation: new Conversation(),
        maximumSteps: 1,
      }));
      await yieldToPortableEventLoop();
      manual.resolveResult();

      await immediate;
      const result = await bgResult;

      expect(result).not.toBeNull();
      expect(failedTaskIds).toContain('bg-suspend-fails');
    } finally {
      await scheduler.stop();
    }
  });

  it('cancels a queued durable resume task through the engine', async () => {
    const manual = createManualDurableEngine();
    const engine = manual.engine;
    const checkpointStore = createManualCheckpointStore();
    const failedTaskIds: string[] = [];
    engine.cancel = async () => {
      throw new Error('queued cancel failed');
    };

    const immediateBlock = createStepwiseBlockingGenerate();
    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      durable: { engine, checkpointStore },
    });
    scheduler.addEventListener('task.failed', (event) => {
      failedTaskIds.push(event.taskId);
    });
    scheduler.start();

    try {
      const bgResult = scheduler.submit({
        id: 'bg-queued-resume-cancel',
        priority: 'background',
        requeue: true,
        maxRequeues: 1,
        createRun: () => ({
          generate: createMockGenerateOnce('unused'),
          toolbox: createNextToolbox(),
          conversation: new Conversation(),
          maximumSteps: 1,
        }),
      });

      await waitFor(() => scheduler.getState().activeTask?.id === 'bg-queued-resume-cancel');
      const immediate = scheduler.submitImmediate(() => ({
        generate: immediateBlock.generate,
        toolbox: createNextToolbox(),
        conversation: new Conversation(),
        maximumSteps: 5,
        stopWhen: stopWhen.noToolCalls(),
      }));
      await waitFor(() =>
        scheduler
          .getState()
          .queued.background.some((task) => task.id === 'bg-queued-resume-cancel'),
      );

      expect(scheduler.cancel('bg-queued-resume-cancel')).toBe(true);
      await yieldToPortableEventLoop();
      immediateBlock.releaseStep1({ content: 'immediate done', toolCalls: [] });
      manual.resolveResult();

      await immediate;
      expect(await bgResult).toBeNull();
      expect(failedTaskIds).toContain('bg-queued-resume-cancel');
    } finally {
      await scheduler.stop();
    }
  });

  it('emits task.failed when cancelling a suspended non-requeue durable task fails', async () => {
    const manual = createManualDurableEngine();
    const engine = manual.engine;
    const checkpointStore = createManualCheckpointStore();
    const failedTaskIds: string[] = [];
    engine.cancel = async () => {
      manual.resolveResult();
      throw new Error('suspended cancel failed');
    };

    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      durable: { engine, checkpointStore },
    });
    scheduler.addEventListener('task.failed', (event) => {
      failedTaskIds.push(event.taskId);
    });
    scheduler.start();

    try {
      const bgResult = scheduler.submit({
        id: 'bg-suspended-cancel-fails',
        priority: 'background',
        requeue: false,
        createRun: () => ({
          generate: createMockGenerateOnce('unused'),
          toolbox: createNextToolbox(),
          conversation: new Conversation(),
          maximumSteps: 1,
        }),
      });

      await waitFor(() => scheduler.getState().activeTask?.id === 'bg-suspended-cancel-fails');
      const immediate = scheduler.submitImmediate(() => ({
        generate: createMockGenerateOnce('imm'),
        toolbox: createNextToolbox(),
        conversation: new Conversation(),
        maximumSteps: 1,
      }));
      await yieldToPortableEventLoop();

      expect(await bgResult).toBeNull();
      await immediate;
      expect(failedTaskIds).toContain('bg-suspended-cancel-fails');
    } finally {
      await scheduler.stop();
    }
  });

  it('rejects a durable task when its createRun factory throws', async () => {
    const manual = createManualDurableEngine();
    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      durable: { engine: manual.engine, checkpointStore: createManualCheckpointStore() },
    });
    scheduler.start();

    try {
      await expect(
        scheduler.submit({
          id: 'durable-factory-fails',
          priority: 'background',
          createRun: () => {
            throw new Error('durable factory failed');
          },
        }),
      ).rejects.toThrow('durable factory failed');
    } finally {
      await scheduler.stop();
    }
  });

  it("does not fire a preempted-then-resumed run's onRunComplete hook more than once", async () => {
    // The structural bug (Bugbot: "suspended run duplicates lifecycle hooks"): the
    // original hook-firing durable driver kept awaiting the un-settled handle after
    // suspend, then fired onRunComplete a SECOND time when the run resumed and
    // completed. The fix drives preemptable runs with a HOOKS-FREE result-only
    // driver, so a run's onRunComplete hook fires AT MOST once across a full
    // preempt→resume cycle (zero, by design — the scheduler owns the lifecycle).
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
    const blocking = createStepwiseBlockingGenerate();

    let onRunCompleteCalls = 0;
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('onRunComplete', () => {
      onRunCompleteCalls++;
    });

    let taskCompleteCalls = 0;
    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      durable: { engine, checkpointStore },
    });
    scheduler.start();

    try {
      const bgResult = scheduler.submit({
        id: 'bg-hooks',
        priority: 'background',
        requeue: true,
        onComplete: () => {
          taskCompleteCalls++;
        },
        createRun: () => ({
          generate: blocking.generate,
          toolbox: createNextToolbox(),
          conversation: new Conversation(),
          maximumSteps: 5,
          stopWhen: stopWhen.noToolCalls(),
          hooks,
        }),
      });

      await waitFor(() => blocking.steps.includes(1));
      await scheduler.submitImmediate(() => ({
        generate: createMockGenerateOnce('imm'),
        toolbox: createNextToolbox(),
        conversation: new Conversation(),
        maximumSteps: 1,
      }));
      blocking.releaseStep1({ content: 'bg final', toolCalls: [] });

      await bgResult;
      // Give any abandoned driver a chance to (wrongly) re-fire the hook. An
      // abandoned driver re-fires through the same deferred-macrotask queue, so
      // draining several macrotask turns is the deterministic equivalent of the
      // prior fixed sleep — without a wall-clock wait that flakes under load.
      for (let i = 0; i < 5; i++) {
        await yieldToPortableEventLoop();
      }

      // The run's onRunComplete hook did NOT double-fire (preemptable runs are
      // hooks-free, so it fires ZERO times — the documented contract (durable
      // scheduler tasks use task.onComplete, NOT run-level hooks). The
      // load-bearing invariant is "never twice"; the exact value is 0 by design.
      expect(onRunCompleteCalls).toBe(0);
      // The SCHEDULER's own task completion fired exactly once — the single
      // lifecycle signal for a scheduled task on either backend.
      expect(taskCompleteCalls).toBe(1);
    } finally {
      await scheduler.stop();
      engine[Symbol.dispose]();
    }
  });

  it('does not emit a spurious task.failed when stop() cancels a running durable task', async () => {
    // Bugbot: stop() merged engine.cancel promises with running result promises in
    // one allSettled and emitted TaskFailedEvent for every rejection — but a
    // cancelled durable run's result() REJECTS with "Workflow cancelled", which is
    // the deliberate shutdown outcome, not a failure. stop() must surface ONLY a
    // failure of the cancel OPERATION, not the expected result rejection.
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
    const blocking = createStepwiseBlockingGenerate();

    const failedTaskIds: string[] = [];
    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      durable: { engine, checkpointStore },
    });
    scheduler.addEventListener('task.failed', (event) => {
      failedTaskIds.push(event.taskId);
    });
    scheduler.start();

    try {
      // A durable task that blocks at step 1 — still running when we stop().
      void scheduler.submit({
        id: 'bg-stop',
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

      // stop() engine.cancels the running durable run; its result() rejects with
      // "Workflow cancelled" — a normal shutdown, NOT a failure.
      await scheduler.stop();

      // No spurious scheduler-stop-cancel (or bg-stop) failure was emitted.
      expect(failedTaskIds).not.toContain('scheduler-stop-cancel');
      expect(failedTaskIds).not.toContain('bg-stop');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('emits scheduler-stop-cancel when stopping fails to cancel a durable run', async () => {
    const manual = createManualDurableEngine();
    const engine = manual.engine;
    const checkpointStore = createManualCheckpointStore();
    const failedTaskIds: string[] = [];
    engine.cancel = async () => {
      manual.rejectResult(new Error('Workflow cancelled'));
      throw new Error('cancel operation failed');
    };

    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      durable: { engine, checkpointStore },
    });
    scheduler.addEventListener('task.failed', (event) => {
      failedTaskIds.push(event.taskId);
    });
    scheduler.start();

    void scheduler.submit({
      id: 'bg-stop-cancel-fails',
      priority: 'background',
      requeue: false,
      createRun: () => ({
        generate: createMockGenerateOnce('unused'),
        toolbox: createNextToolbox(),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
    });

    await waitFor(() => scheduler.getState().activeTask?.id === 'bg-stop-cancel-fails');
    await scheduler.stop();

    expect(failedTaskIds).toContain('scheduler-stop-cancel');
  });

  it('cancels queued durable resume tasks during stop', async () => {
    const manual = createManualDurableEngine();
    const engine = manual.engine;
    const checkpointStore = createManualCheckpointStore();
    const failedTaskIds: string[] = [];
    engine.cancel = () => {
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('queued stop cancel failed')), 0);
      });
    };
    const immediateBlock = createStepwiseBlockingGenerate();

    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      durable: { engine, checkpointStore },
    });
    scheduler.addEventListener('task.failed', (event) => {
      failedTaskIds.push(event.taskId);
    });
    scheduler.start();

    const bgResult = scheduler.submit({
      id: 'bg-queued-stop',
      priority: 'background',
      requeue: true,
      maxRequeues: 1,
      createRun: () => ({
        generate: createMockGenerateOnce('unused'),
        toolbox: createNextToolbox(),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
    });

    await waitFor(() => scheduler.getState().activeTask?.id === 'bg-queued-stop');
    const immediate = scheduler.submitImmediate(() => ({
      generate: immediateBlock.generate,
      toolbox: createNextToolbox(),
      conversation: new Conversation(),
      maximumSteps: 5,
      stopWhen: stopWhen.noToolCalls(),
    }));
    await waitFor(() =>
      scheduler.getState().queued.background.some((task) => task.id === 'bg-queued-stop'),
    );

    const stopPromise = scheduler.stop();
    immediateBlock.releaseStep1({ content: 'immediate done', toolCalls: [] });
    manual.resolveResult();
    await stopPromise;

    await immediate;
    expect(await bgResult).toBeNull();
    expect(failedTaskIds).toContain('scheduler-stop-cancel');
  });

  it('stops immediately when started with an already-aborted external signal', async () => {
    const scheduler = createScheduler({
      generate: createMockGenerateFallback(),
      toolbox: createNextToolbox(),
      idleDelay: 1,
      signal: AbortSignal.abort('already stopped'),
    });

    scheduler.start();
    await yieldToPortableEventLoop();
    await scheduler.stop();

    expect(scheduler.getState().idle).toBe(true);
  });
});

function textResponse(content: string) {
  return { content, toolCalls: [] as never[] };
}

function createMockGenerateFallback(): GenerateFunction {
  return createMockGenerate([textResponse('fallback')]);
}

function createMockGenerateOnce(content: string): GenerateFunction {
  return createMockGenerate([textResponse(content)]);
}

async function waitFor(check: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (check()) return;
    // Yield a macrotask (MessageChannel via Weft's portable helper) rather than a
    // fixed wall-clock sleep: the durable engine schedules inline launches on
    // deferred macrotasks, so a condition-driven yield advances them without a
    // load-sensitive 5ms poll that flakes on a busy CI host.
    await yieldToPortableEventLoop();
  }
  throw new Error('waitFor: condition not met within attempts');
}
