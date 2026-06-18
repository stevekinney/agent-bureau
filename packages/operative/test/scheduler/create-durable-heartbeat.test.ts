import * as weft from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createRunEngine } from '../../src/durable/create-run-engine';
import {
  DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE,
  type DurableHeartbeatTickResult,
} from '../../src/durable/durable-heartbeat-tick-workflow';
import { createDurableHeartbeat } from '../../src/scheduler/create-durable-heartbeat';
import type { Scheduler } from '../../src/scheduler/create-scheduler';
import type { SchedulerTask } from '../../src/scheduler/types';
import type { RunResult } from '../../src/types';

type RunEngineInstance = Awaited<ReturnType<typeof createRunEngine>>['engine'];

afterEach(async () => {
  await yieldToPortableEventLoop();
});

function createAgentRunProbeWorkflow() {
  return weft.workflow({ name: 'agentRun' }).execute(async function* (ctx, input: unknown) {
    return yield* ctx.memo('probe-result', () => input);
  });
}

function createRunResult(content = 'heartbeat tick'): RunResult {
  return {
    conversation: new Conversation(),
    steps: [],
    content,
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: 'stop-condition',
  };
}

function isDurableHeartbeatTickResult(value: unknown): value is DurableHeartbeatTickResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['workflowId'] === 'string' &&
    typeof candidate['scheduleId'] === 'string' &&
    (candidate['status'] === 'completed' ||
      candidate['status'] === 'failed' ||
      candidate['status'] === 'preempted')
  );
}

function createRecordingScheduler(result: RunResult | null = createRunResult()) {
  const submittedTasks: SchedulerTask[] = [];

  const scheduler: Scheduler = {
    submit: async (task) => {
      submittedTasks.push(task);
      await task.createRun();
      return result;
    },
    submitImmediate: async () => result,
    dispatch: () => {
      throw new Error('dispatch is not used by durable heartbeat tests');
    },
    getState: () => ({
      activeTask: undefined,
      queued: { immediate: [], scheduled: [], background: [], ambient: [] },
      completedCount: submittedTasks.length,
      preemptedCount: 0,
      idle: true,
    }),
    cancel: () => false,
    start: () => {},
    stop: async () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  return { scheduler, submittedTasks };
}

async function listStorageKeys(storage: MemoryStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storage.keys(prefix)) {
    keys.push(key);
  }
  return keys;
}

async function fireSchedule(engine: RunEngineInstance, scheduleId: string): Promise<void> {
  const schedule = await engine.getSchedule(scheduleId);
  if (!schedule || schedule.nextFireAt === null) {
    throw new Error(`schedule ${scheduleId} is not ready to fire`);
  }

  await engine.scheduler.tick(schedule.nextFireAt);
  for (let turn = 0; turn < 5; turn++) {
    await yieldToPortableEventLoop();
  }
}

describe('createDurableHeartbeat', () => {
  it('reuses an existing schedule with the same scheduleId', async () => {
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
      startScheduler: false,
    });
    const { scheduler } = createRecordingScheduler();
    let createRunCount = 0;

    try {
      const first = await createDurableHeartbeat(engine, {
        scheduler,
        scheduleId: 'heartbeat-reuse',
        spec: { every: '1h' },
        createHeartbeatRun: () => {
          createRunCount++;
          return { conversation: new Conversation() };
        },
      });
      const second = await createDurableHeartbeat(engine, {
        scheduler,
        scheduleId: 'heartbeat-reuse',
        spec: { every: '1h' },
        createHeartbeatRun: () => {
          createRunCount++;
          return { conversation: new Conversation() };
        },
      });

      expect(first.id).toBe('heartbeat-reuse');
      expect(second.id).toBe('heartbeat-reuse');
      expect(await engine.getSchedule('heartbeat-reuse')).toMatchObject({
        id: 'heartbeat-reuse',
        workflowType: DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE,
        overlap: 'skip',
        backfill: false,
      });
      expect(createRunCount).toBe(0);

      second[Symbol.dispose]();
      first[Symbol.dispose]();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('keeps an earlier same-schedule registration alive after a later handle is disposed', async () => {
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
      startScheduler: false,
    });
    const firstScheduler = createRecordingScheduler();
    const secondScheduler = createRecordingScheduler();

    try {
      const first = await createDurableHeartbeat(engine, {
        scheduler: firstScheduler.scheduler,
        scheduleId: 'heartbeat-registration-stack',
        spec: { every: '1h' },
        createHeartbeatRun: () => ({ conversation: new Conversation() }),
      });
      const second = await createDurableHeartbeat(engine, {
        scheduler: secondScheduler.scheduler,
        scheduleId: 'heartbeat-registration-stack',
        spec: { every: '1h' },
        createHeartbeatRun: () => ({ conversation: new Conversation() }),
      });

      second[Symbol.dispose]();

      await fireSchedule(engine, 'heartbeat-registration-stack');
      expect(firstScheduler.submittedTasks).toHaveLength(1);
      expect(secondScheduler.submittedTasks).toHaveLength(0);

      first[Symbol.dispose]();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('keeps an earlier same-schedule registration alive after a later handle is cancelled', async () => {
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
      startScheduler: false,
    });
    const firstScheduler = createRecordingScheduler();
    const secondScheduler = createRecordingScheduler();

    try {
      const first = await createDurableHeartbeat(engine, {
        scheduler: firstScheduler.scheduler,
        scheduleId: 'heartbeat-registration-cancel-stack',
        spec: { every: '1h' },
        createHeartbeatRun: () => ({ conversation: new Conversation() }),
      });
      const second = await createDurableHeartbeat(engine, {
        scheduler: secondScheduler.scheduler,
        scheduleId: 'heartbeat-registration-cancel-stack',
        spec: { every: '1h' },
        createHeartbeatRun: () => ({ conversation: new Conversation() }),
      });

      await second.cancel();

      expect(await engine.getSchedule('heartbeat-registration-cancel-stack')).toMatchObject({
        status: 'active',
      });
      await fireSchedule(engine, 'heartbeat-registration-cancel-stack');
      expect(firstScheduler.submittedTasks).toHaveLength(1);
      expect(secondScheduler.submittedTasks).toHaveLength(0);

      await first.cancel();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('uses the active same-schedule registration priority', async () => {
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
      startScheduler: false,
    });
    const firstScheduler = createRecordingScheduler();
    const secondScheduler = createRecordingScheduler();

    try {
      const first = await createDurableHeartbeat(engine, {
        scheduler: firstScheduler.scheduler,
        scheduleId: 'heartbeat-active-priority',
        spec: { every: '1h' },
        priority: 'ambient',
        createHeartbeatRun: () => ({ conversation: new Conversation() }),
      });
      const second = await createDurableHeartbeat(engine, {
        scheduler: secondScheduler.scheduler,
        scheduleId: 'heartbeat-active-priority',
        spec: { every: '1h' },
        priority: 'immediate',
        createHeartbeatRun: () => ({ conversation: new Conversation() }),
      });

      await fireSchedule(engine, 'heartbeat-active-priority');
      expect(firstScheduler.submittedTasks).toHaveLength(0);
      expect(secondScheduler.submittedTasks).toHaveLength(1);
      expect(secondScheduler.submittedTasks[0]!.priority).toBe('immediate');

      second[Symbol.dispose]();
      await fireSchedule(engine, 'heartbeat-active-priority');
      expect(firstScheduler.submittedTasks).toHaveLength(1);
      expect(firstScheduler.submittedTasks[0]!.priority).toBe('ambient');

      await first.cancel();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('rejects an existing schedule that belongs to a different workflow', async () => {
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
      startScheduler: false,
    });
    const { scheduler } = createRecordingScheduler();

    try {
      await engine.schedule(
        'agentRun',
        { ok: true },
        { every: '1h' },
        { id: 'heartbeat-collision', overlap: 'skip', backfill: false },
      );

      await expect(
        createDurableHeartbeat(engine, {
          scheduler,
          scheduleId: 'heartbeat-collision',
          spec: { every: '1h' },
          createHeartbeatRun: () => ({ conversation: new Conversation() }),
        }),
      ).rejects.toThrow(
        'Schedule heartbeat-collision already exists for workflow agentRun; expected durableHeartbeatTick.',
      );
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('rejects an existing cancelled durable heartbeat schedule', async () => {
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
      startScheduler: false,
    });
    const { scheduler } = createRecordingScheduler();

    try {
      const heartbeat = await createDurableHeartbeat(engine, {
        scheduler,
        scheduleId: 'heartbeat-cancelled-reuse',
        spec: { every: '1h' },
        createHeartbeatRun: () => ({ conversation: new Conversation() }),
      });
      await heartbeat.cancel();

      await expect(
        createDurableHeartbeat(engine, {
          scheduler,
          scheduleId: 'heartbeat-cancelled-reuse',
          spec: { every: '1h' },
          createHeartbeatRun: () => ({ conversation: new Conversation() }),
        }),
      ).rejects.toThrow('Schedule heartbeat-cancelled-reuse already exists but is cancelled.');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('unregisters tick services when cancelling the underlying schedule throws', async () => {
    const failedWorkflowMessages: string[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
      startScheduler: false,
    });
    const originalCancelSchedule = engine.cancelSchedule.bind(engine);
    const { scheduler, submittedTasks } = createRecordingScheduler();
    engine.addEventListener(weft.WorkflowFailedEvent.type, (event) => {
      failedWorkflowMessages.push((event as weft.WorkflowFailedEvent).error.message);
    });

    try {
      const heartbeat = await createDurableHeartbeat(engine, {
        scheduler,
        scheduleId: 'heartbeat-cancel-failure',
        spec: { every: '1h' },
        createHeartbeatRun: () => ({ conversation: new Conversation() }),
      });
      engine.cancelSchedule = async () => {
        throw new Error('cancel failed');
      };

      await expect(heartbeat.cancel()).rejects.toThrow('cancel failed');

      expect(await engine.getSchedule('heartbeat-cancel-failure')).toMatchObject({
        status: 'active',
      });
      await fireSchedule(engine, 'heartbeat-cancel-failure');
      expect(submittedTasks).toHaveLength(0);
      expect(failedWorkflowMessages).toHaveLength(1);
      expect(failedWorkflowMessages[0]).toContain(
        'no durable heartbeat services registered for schedule heartbeat-cancel-failure',
      );
    } finally {
      engine.cancelSchedule = originalCancelSchedule;
      await originalCancelSchedule('heartbeat-cancel-failure').catch(() => {});
      engine[Symbol.dispose]();
    }
  });

  it('rejects new registrations while the sole handle is cancelling', async () => {
    let finishCancel!: () => void;
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const cancelCanFinish = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
      startScheduler: false,
    });
    const originalCancelSchedule = engine.cancelSchedule.bind(engine);
    const firstScheduler = createRecordingScheduler();
    const secondScheduler = createRecordingScheduler();

    try {
      const first = await createDurableHeartbeat(engine, {
        scheduler: firstScheduler.scheduler,
        scheduleId: 'heartbeat-cancel-create-race',
        spec: { every: '1h' },
        createHeartbeatRun: () => ({ conversation: new Conversation() }),
      });
      engine.cancelSchedule = async (scheduleId) => {
        markCancelStarted();
        await cancelCanFinish;
        await originalCancelSchedule(scheduleId);
      };

      const cancelAttempt = first.cancel();
      await cancelStarted;

      const createAttempt = createDurableHeartbeat(engine, {
        scheduler: secondScheduler.scheduler,
        scheduleId: 'heartbeat-cancel-create-race',
        spec: { every: '1h' },
        createHeartbeatRun: () => ({ conversation: new Conversation() }),
      });
      let createSettled = false;
      void createAttempt
        .then(() => {
          createSettled = true;
        })
        .catch(() => {
          createSettled = true;
        });
      await yieldToPortableEventLoop();
      expect(createSettled).toBe(false);

      finishCancel();
      await expect(cancelAttempt).resolves.toBeUndefined();
      await expect(createAttempt).rejects.toThrow(
        'Schedule heartbeat-cancel-create-race already exists but is cancelled.',
      );
      expect(firstScheduler.submittedTasks).toHaveLength(0);
      expect(secondScheduler.submittedTasks).toHaveLength(0);
    } finally {
      finishCancel();
      engine.cancelSchedule = originalCancelSchedule;
      await originalCancelSchedule('heartbeat-cancel-create-race').catch(() => {});
      engine[Symbol.dispose]();
    }
  });

  it('enqueues one scheduler task when the durable tick workflow runs', async () => {
    let resolverDelegationCount = 0;
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
      startScheduler: false,
      resolveWorkflowServices: () => {
        resolverDelegationCount++;
        return { status: 'unavailable', reason: 'agentRun resolver should not handle ticks' };
      },
    });
    const { scheduler, submittedTasks } = createRecordingScheduler();
    let createRunCount = 0;
    const completedTicks: DurableHeartbeatTickResult[] = [];
    engine.addEventListener(weft.WorkflowCompletedEvent.type, (event) => {
      const result = (event as weft.WorkflowCompletedEvent).result;
      if (isDurableHeartbeatTickResult(result)) completedTicks.push(result);
    });

    const heartbeat = await createDurableHeartbeat(engine, {
      scheduler,
      scheduleId: 'heartbeat-fired',
      spec: { every: '1h' },
      createHeartbeatRun: () => {
        createRunCount++;
        return { conversation: new Conversation() };
      },
    });

    try {
      await fireSchedule(engine, 'heartbeat-fired');

      expect(completedTicks).toHaveLength(1);
      expect(completedTicks[0]).toMatchObject({
        scheduleId: 'heartbeat-fired',
        status: 'completed',
      });
      expect(createRunCount).toBe(1);
      expect(submittedTasks).toHaveLength(1);
      expect(submittedTasks[0]!.priority).toBe('scheduled');
      expect(submittedTasks[0]!.id).toBe(`durable-heartbeat-${completedTicks[0]!.workflowId}`);
      expect(resolverDelegationCount).toBe(0);
    } finally {
      await heartbeat.cancel();
      engine[Symbol.dispose]();
    }
  });

  it('does not write agent-run checkpoints under an undefined run id', async () => {
    const storage = new MemoryStorage();
    const { engine, checkpointStore } = await createRunEngine({
      storage,
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
    });
    const { scheduler, submittedTasks } = createRecordingScheduler();
    const completedTicks: DurableHeartbeatTickResult[] = [];
    engine.addEventListener(weft.WorkflowCompletedEvent.type, (event) => {
      const result = (event as weft.WorkflowCompletedEvent).result;
      if (isDurableHeartbeatTickResult(result)) completedTicks.push(result);
    });
    const heartbeat = await createDurableHeartbeat(engine, {
      scheduler,
      scheduleId: 'direct-tick',
      spec: { every: '1h' },
      createHeartbeatRun: () => ({ conversation: new Conversation() }),
    });

    try {
      await fireSchedule(engine, 'direct-tick');

      expect(completedTicks).toHaveLength(1);
      expect(completedTicks[0]).toMatchObject({
        scheduleId: 'direct-tick',
        status: 'completed',
      });
      expect(submittedTasks).toHaveLength(1);
      expect(await checkpointStore.loadCursor('undefined')).toBeNull();
      expect(await checkpointStore.loadSteps('undefined')).toEqual([]);
      expect(await checkpointStore.loadConversation('undefined')).toBeNull();
      expect(await checkpointStore.loadCursor('direct-tick')).toBeNull();
      expect(await checkpointStore.loadSteps('direct-tick')).toEqual([]);
      expect(await checkpointStore.loadConversation('direct-tick')).toBeNull();
      expect(await checkpointStore.loadCursor(completedTicks[0]!.workflowId)).toBeNull();
      expect(await checkpointStore.loadSteps(completedTicks[0]!.workflowId)).toEqual([]);
      expect(await checkpointStore.loadConversation(completedTicks[0]!.workflowId)).toBeNull();
      expect(await listStorageKeys(storage, 'durable-run:')).toEqual([]);
    } finally {
      await heartbeat.cancel();
      engine[Symbol.dispose]();
    }
  });

  it('keeps durable heartbeat resolution independent from agentRun recovery resolution', async () => {
    let agentRunResolverCalls = 0;
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
      startScheduler: false,
      resolveWorkflowServices: () => {
        agentRunResolverCalls++;
        return { status: 'unavailable', reason: 'agentRun unavailable' };
      },
    });
    const { scheduler, submittedTasks } = createRecordingScheduler();
    const firedScheduleIds: string[] = [];
    engine.addEventListener(weft.ScheduleFiredEvent.type, (event) => {
      firedScheduleIds.push((event as weft.ScheduleFiredEvent).scheduleId);
    });

    const heartbeat = await createDurableHeartbeat(engine, {
      scheduler,
      scheduleId: 'heartbeat-resolver-branch',
      spec: { every: '1h' },
      createHeartbeatRun: () => ({ conversation: new Conversation() }),
    });

    try {
      await fireSchedule(engine, 'heartbeat-resolver-branch');
      expect(submittedTasks).toHaveLength(1);
      expect(firedScheduleIds).toEqual(['heartbeat-resolver-branch']);
      expect(agentRunResolverCalls).toBe(0);
    } finally {
      await heartbeat.cancel();
      engine[Symbol.dispose]();
    }
  });

  it('reports a failed tick when onTick rejects and isolates onFailure errors', async () => {
    const onFailureErrors: unknown[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
      startScheduler: false,
    });
    const { scheduler, submittedTasks } = createRecordingScheduler();
    const completedTicks: DurableHeartbeatTickResult[] = [];
    engine.addEventListener(weft.WorkflowCompletedEvent.type, (event) => {
      const result = (event as weft.WorkflowCompletedEvent).result;
      if (isDurableHeartbeatTickResult(result)) completedTicks.push(result);
    });
    const heartbeat = await createDurableHeartbeat(engine, {
      scheduler,
      scheduleId: 'heartbeat-callback-failure',
      spec: { every: '1h' },
      createHeartbeatRun: () => ({ conversation: new Conversation() }),
      onTick: async () => {
        throw new Error('tick observer failed');
      },
      onFailure: (error) => {
        onFailureErrors.push(error);
        throw new Error('failure observer failed');
      },
    });

    try {
      await fireSchedule(engine, 'heartbeat-callback-failure');

      expect(completedTicks).toHaveLength(1);
      expect(completedTicks[0]).toMatchObject({
        scheduleId: 'heartbeat-callback-failure',
        status: 'failed',
      });
      expect(submittedTasks).toHaveLength(1);
      expect(onFailureErrors).toHaveLength(1);
      expect(onFailureErrors[0]).toBeInstanceOf(Error);
    } finally {
      await heartbeat.cancel();
      engine[Symbol.dispose]();
    }
  });

  it('fails only the tick workflow when a tick runs without registered services', async () => {
    const failedWorkflowIds: string[] = [];
    const failureMessages: string[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: createAgentRunProbeWorkflow(),
      recover: false,
      startScheduler: false,
    });
    engine.addEventListener(weft.WorkflowFailedEvent.type, (event) => {
      const failedEvent = event as weft.WorkflowFailedEvent;
      failedWorkflowIds.push(failedEvent.workflowId);
      failureMessages.push(failedEvent.error.message);
    });

    try {
      await engine.schedule(
        DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE,
        { scheduleId: 'missing-services' },
        { every: '1h' },
        { id: 'missing-services', overlap: 'skip', backfill: false },
      );

      await fireSchedule(engine, 'missing-services');
      expect(failedWorkflowIds).toHaveLength(1);
      expect(failureMessages).toHaveLength(1);
      expect(failureMessages[0]).toContain(
        'no durable heartbeat services registered for schedule missing-services',
      );

      const probe = await engine.start('agentRun', { ok: true });
      expect(await probe.result()).toEqual({ ok: true });
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
