import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createScheduler } from '../../src/scheduler/create-scheduler';
import type { SchedulerEventType } from '../../src/scheduler/events';
import { sleep } from '../../src/scheduler/sleep';
import type { SchedulerPriority, SchedulerTask } from '../../src/scheduler/types';
import { createMockGenerate } from '../../src/test/index';
import type { GenerateFunction, GenerateResponse } from '../../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

/** A generate function that blocks until a deferred is resolved, but
 *  exits early if the abort signal fires. */
function createBlockingGenerate(): {
  generate: GenerateFunction;
  resolve: (response: GenerateResponse) => void;
} {
  let resolver: ((response: GenerateResponse) => void) | undefined;
  const promise = new Promise<GenerateResponse>((resolve) => {
    resolver = resolve;
  });

  const generate: GenerateFunction = async (context) => {
    if (context.signal?.aborted) return textResponse('aborted');

    // Race: wait for either the deferred to resolve or the signal to abort
    return Promise.race([
      promise,
      new Promise<GenerateResponse>((resolve) => {
        context.signal?.addEventListener('abort', () => resolve(textResponse('aborted')), {
          once: true,
        });
      }),
    ]);
  };

  return { generate, resolve: resolver! };
}

function makeTask(
  overrides: Partial<SchedulerTask> & { priority: SchedulerPriority },
): SchedulerTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    createRun: () => ({
      generate: createMockGenerate([textResponse('done')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }),
    ...overrides,
  };
}

function createMinimalScheduler(overrides: Partial<Parameters<typeof createScheduler>[0]> = {}) {
  return createScheduler({
    generate: createMockGenerate([textResponse('default')]),
    toolbox: createTestToolbox([]),
    idleDelay: 1,
    ...overrides,
  });
}

describe('createScheduler', () => {
  it('starts and stops without errors', async () => {
    const scheduler = createMinimalScheduler();
    scheduler.start();
    await scheduler.stop();
  });

  it('submits and completes an immediate task', async () => {
    const scheduler = createMinimalScheduler();
    scheduler.start();

    const result = await scheduler.submitImmediate(() => ({
      generate: createMockGenerate([textResponse('hello')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));

    expect(result.content).toBe('hello');
    expect(result.finishReason).toBe('maximum-steps');

    await scheduler.stop();
  });

  it('submits and completes a background task', async () => {
    const scheduler = createMinimalScheduler();
    scheduler.start();

    const task = makeTask({ priority: 'background' });
    const result = await scheduler.submit(task);

    expect(result).not.toBeNull();
    expect(result!.content).toBe('done');

    await scheduler.stop();
  });

  it('an immediate task preempts a running background task', async () => {
    const { generate: slowGenerate, resolve: resolveGenerate } = createBlockingGenerate();

    const scheduler = createMinimalScheduler({ idleDelay: 1 });
    scheduler.start();

    const bgResult = scheduler.submit(
      makeTask({
        priority: 'background',
        id: 'bg-task',
        requeue: false,
        createRun: () => ({
          generate: slowGenerate,
          toolbox: createTestToolbox([]),
          conversation: new Conversation(),
          maximumSteps: 5,
        }),
      }),
    );

    // Give the scheduler time to dispatch the background task
    await sleep(10);

    // Submit immediate — should preempt the background task
    const immResult = scheduler.submitImmediate(() => ({
      generate: createMockGenerate([textResponse('immediate-done')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));

    // Resolve the blocking generate so the step can complete
    resolveGenerate(textResponse('bg-step-done'));

    const immRunResult = await immResult;
    expect(immRunResult.content).toBe('immediate-done');

    const bgRunResult = await bgResult;
    expect(bgRunResult).toBeNull();

    await scheduler.stop();
  });

  it('re-queues a preempted background task when requeue is true', async () => {
    let generateCallCount = 0;
    const blocking1 = createBlockingGenerate();

    const scheduler = createMinimalScheduler({ idleDelay: 1 });
    scheduler.start();

    const bgResult = scheduler.submit(
      makeTask({
        priority: 'background',
        id: 'bg-requeue',
        requeue: true,
        maxRequeues: 3,
        createRun: () => {
          generateCallCount++;
          if (generateCallCount === 1) {
            return {
              generate: blocking1.generate,
              toolbox: createTestToolbox([]),
              conversation: new Conversation(),
              maximumSteps: 1,
            };
          }
          // Second call after requeue: complete immediately
          return {
            generate: createMockGenerate([textResponse('requeued-done')]),
            toolbox: createTestToolbox([]),
            conversation: new Conversation(),
            maximumSteps: 1,
          };
        },
      }),
    );

    await sleep(10);

    // Preempt with immediate task
    const immResult = scheduler.submitImmediate(() => ({
      generate: createMockGenerate([textResponse('imm')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));

    blocking1.resolve(textResponse('bg-step'));

    await immResult;

    // The background task should be requeued and complete on second attempt
    const bgRunResult = await bgResult;
    expect(bgRunResult).not.toBeNull();
    expect(bgRunResult!.content).toBe('requeued-done');

    await scheduler.stop();
  });

  it('respects maxRequeues limit', async () => {
    let createRunCount = 0;

    const scheduler = createMinimalScheduler({ idleDelay: 1 });
    scheduler.start();

    // Create blocking generates for each dispatch
    const blockingGenerates: ReturnType<typeof createBlockingGenerate>[] = [];

    const bgResult = scheduler.submit(
      makeTask({
        priority: 'background',
        id: 'bg-max-requeue',
        requeue: true,
        maxRequeues: 1, // Only 1 requeue allowed
        createRun: () => {
          createRunCount++;
          const bg = createBlockingGenerate();
          blockingGenerates.push(bg);
          return {
            generate: bg.generate,
            toolbox: createTestToolbox([]),
            conversation: new Conversation(),
            maximumSteps: 1,
          };
        },
      }),
    );

    // First dispatch
    await sleep(10);

    // First preemption (requeue count 0 → 1)
    const imm1 = scheduler.submitImmediate(() => ({
      generate: createMockGenerate([textResponse('imm1')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));
    blockingGenerates[0]!.resolve(textResponse('step'));
    await imm1;

    // Wait for requeued task to be dispatched
    await sleep(10);

    // Second preemption (requeue count 1 — at max, so task is dropped)
    const imm2 = scheduler.submitImmediate(() => ({
      generate: createMockGenerate([textResponse('imm2')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));
    blockingGenerates[1]!.resolve(textResponse('step'));
    await imm2;

    const result = await bgResult;
    expect(result).toBeNull(); // Exceeded maxRequeues
    expect(createRunCount).toBe(2); // Created once initially, once after requeue

    await scheduler.stop();
  });

  it('same-priority tasks execute in FIFO order', async () => {
    const order: string[] = [];

    const scheduler = createMinimalScheduler({ idleDelay: 1 });

    const results: Promise<unknown>[] = [];

    for (const name of ['first', 'second', 'third']) {
      results.push(
        scheduler.submit(
          makeTask({
            priority: 'background',
            id: name,
            createRun: () => {
              order.push(name);
              return {
                generate: createMockGenerate([textResponse(name)]),
                toolbox: createTestToolbox([]),
                conversation: new Conversation(),
                maximumSteps: 1,
              };
            },
          }),
        ),
      );
    }

    scheduler.start();
    await Promise.all(results);

    expect(order).toEqual(['first', 'second', 'third']);

    await scheduler.stop();
  });

  it('stop() aborts active background tasks', async () => {
    const { generate: slowGenerate, resolve: resolveGen } = createBlockingGenerate();

    const scheduler = createMinimalScheduler({ idleDelay: 1 });
    scheduler.start();

    const bgResult = scheduler.submit(
      makeTask({
        priority: 'background',
        id: 'bg-stop',
        requeue: false,
        createRun: () => ({
          generate: slowGenerate,
          toolbox: createTestToolbox([]),
          conversation: new Conversation(),
          maximumSteps: 1,
        }),
      }),
    );

    await sleep(10);

    // Stop should abort the background task
    const stopPromise = scheduler.stop();
    // The abort signal will cause the blocking generate to return 'aborted'
    // No need to explicitly resolve — the signal handler does it

    await stopPromise;

    const result = await bgResult;
    expect(result).toBeNull();

    // Clean up
    resolveGen(textResponse('unused'));
  });

  it('events fire at the correct lifecycle points', async () => {
    const events: string[] = [];

    const scheduler = createMinimalScheduler({ idleDelay: 1 });

    const eventTypes: SchedulerEventType[] = [
      'task.queued',
      'task.dispatched',
      'task.completed',
      'scheduler.started',
      'scheduler.stopped',
      'scheduler.idle',
    ];

    for (const type of eventTypes) {
      scheduler.addEventListener(type, () => {
        events.push(type);
      });
    }

    scheduler.start();

    await scheduler.submitImmediate(() => ({
      generate: createMockGenerate([textResponse('test')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));

    await scheduler.stop();

    expect(events).toContain('scheduler.started');
    expect(events).toContain('task.queued');
    expect(events).toContain('task.dispatched');
    expect(events).toContain('task.completed');
    expect(events).toContain('scheduler.stopped');
  });

  it('handles task factory errors gracefully', async () => {
    const events: string[] = [];
    const scheduler = createMinimalScheduler({ idleDelay: 1 });

    scheduler.addEventListener('task.failed', () => {
      events.push('task.failed');
    });

    scheduler.start();

    const task = makeTask({
      priority: 'immediate',
      id: 'failing-factory',
      createRun: () => {
        throw new Error('factory error');
      },
    });

    const resultPromise = scheduler.submit(task);

    await expect(resultPromise).rejects.toThrow('factory error');
    expect(events).toContain('task.failed');

    await scheduler.stop();
  });

  it('getState() reflects current scheduler state', async () => {
    const scheduler = createMinimalScheduler({ idleDelay: 1 });

    let state = scheduler.getState();
    expect(state.idle).toBe(true);
    expect(state.completedCount).toBe(0);

    scheduler.start();

    await scheduler.submitImmediate(() => ({
      generate: createMockGenerate([textResponse('test')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));

    state = scheduler.getState();
    expect(state.completedCount).toBe(1);

    await scheduler.stop();
  });

  it('getState() reports active and queued tasks while work is in flight', async () => {
    const blocking = createBlockingGenerate();
    const scheduler = createMinimalScheduler({ idleDelay: 1 });

    scheduler.start();

    const firstResult = scheduler.submit(
      makeTask({
        priority: 'background',
        id: 'active-task',
        createRun: () => ({
          generate: blocking.generate,
          toolbox: createTestToolbox([]),
          conversation: new Conversation(),
          maximumSteps: 1,
        }),
      }),
    );

    await sleep(10);

    const secondResult = scheduler.submit(
      makeTask({
        priority: 'background',
        id: 'queued-task',
      }),
    );

    await sleep(10);

    const state = scheduler.getState();
    expect(state.activeTask?.id).toBe('active-task');
    expect(state.queued.background.map((task) => task.id)).toContain('queued-task');

    blocking.resolve(textResponse('released'));
    await firstResult;
    await secondResult;
    await scheduler.stop();
  });

  it('waits for an active dispatched immediate run before starting lower-priority queued work', async () => {
    const blocking = createBlockingGenerate();
    const scheduler = createMinimalScheduler({ idleDelay: 1 });
    const executionOrder: string[] = [];

    scheduler.start();

    const { result: immediateResult } = scheduler.dispatch(() => ({
      generate: blocking.generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));

    await sleep(10);

    const backgroundResult = scheduler.submit(
      makeTask({
        priority: 'background',
        id: 'queued-behind-dispatch',
        createRun: () => {
          executionOrder.push('background');
          return {
            generate: createMockGenerate([textResponse('background-done')]),
            toolbox: createTestToolbox([]),
            conversation: new Conversation(),
            maximumSteps: 1,
          };
        },
      }),
    );

    await sleep(10);
    expect(executionOrder).toEqual([]);

    blocking.resolve(textResponse('immediate-done'));

    const immediateRunResult = await immediateResult;
    const backgroundRunResult = await backgroundResult;

    expect(immediateRunResult.content).toBe('immediate-done');
    expect(backgroundRunResult?.content).toBe('background-done');
    expect(executionOrder).toEqual(['background']);

    await scheduler.stop();
  });

  it('returns null when submitting after the scheduler has stopped', async () => {
    const scheduler = createMinimalScheduler({ idleDelay: 1 });
    scheduler.start();
    await scheduler.stop();

    const result = await scheduler.submit(makeTask({ priority: 'background', id: 'late-task' }));

    expect(result).toBeNull();
  });

  it('dispatch() returns an ActiveRun for immediate tasks', async () => {
    const scheduler = createMinimalScheduler({ idleDelay: 1 });

    const { activeRun, result } = scheduler.dispatch(() => ({
      generate: createMockGenerate([textResponse('dispatched')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));

    expect(activeRun).toBeDefined();
    expect(activeRun.result).toBeDefined();
    expect(typeof activeRun.abort).toBe('function');

    const runResult = await result;
    expect(runResult.content).toBe('dispatched');
  });

  it('dispatch() propagates rejected immediate runs and emits task.failed', async () => {
    const scheduler = createMinimalScheduler({ idleDelay: 1 });
    const failedTaskIds: string[] = [];

    scheduler.addEventListener('task.failed', (event) => {
      failedTaskIds.push(event.taskId);
    });

    const { result } = scheduler.dispatch(() => ({
      generate: createMockGenerate([textResponse('unused')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
      responseSchema: {} as never,
    }));

    await expect(result).rejects.toThrow();
    expect(failedTaskIds).toHaveLength(1);
  });

  it('resolves submitted tasks with null when the scheduler signal aborts the run', async () => {
    const controller = new AbortController();
    const blocking = createBlockingGenerate();
    const scheduler = createMinimalScheduler({
      idleDelay: 1,
      signal: controller.signal,
    });

    scheduler.start();

    const resultPromise = scheduler.submit(
      makeTask({
        priority: 'background',
        id: 'aborted-task',
        createRun: () => ({
          generate: blocking.generate,
          toolbox: createTestToolbox([]),
          conversation: new Conversation(),
          maximumSteps: 1,
        }),
      }),
    );

    await sleep(10);
    controller.abort('task-aborted');

    const result = await resultPromise;
    expect(result).toBeNull();
    blocking.resolve(textResponse('unused'));
    await scheduler.stop();
  });

  it('rejects submitted tasks when executeLoop rejects before producing a result', async () => {
    const scheduler = createMinimalScheduler({ idleDelay: 1 });
    const failures: string[] = [];

    scheduler.addEventListener('task.failed', (event) => {
      failures.push(event.taskId);
    });

    scheduler.start();

    const resultPromise = scheduler.submit(
      makeTask({
        priority: 'background',
        id: 'rejecting-task',
        createRun: () => ({
          generate: createMockGenerate([textResponse('never')]),
          toolbox: createTestToolbox([]),
          conversation: { ids: 42 } as never,
          maximumSteps: 1,
        }),
      }),
    );

    await expect(resultPromise).rejects.toThrow();
    expect(failures).toContain('rejecting-task');
    await scheduler.stop();
  });

  it('idleDelay is respected between task completions', async () => {
    const dispatchTimes: number[] = [];

    const scheduler = createMinimalScheduler({ idleDelay: 30 });

    const results: Promise<unknown>[] = [];

    for (const name of ['first', 'second']) {
      results.push(
        scheduler.submit(
          makeTask({
            priority: 'background',
            id: name,
            createRun: () => {
              dispatchTimes.push(performance.now());
              return {
                generate: createMockGenerate([textResponse(name)]),
                toolbox: createTestToolbox([]),
                conversation: new Conversation(),
                maximumSteps: 1,
              };
            },
          }),
        ),
      );
    }

    scheduler.start();
    await Promise.all(results);

    expect(dispatchTimes).toHaveLength(2);
    const gap = dispatchTimes[1]! - dispatchTimes[0]!;
    // The idle delay should enforce a gap of at least ~30ms between dispatches
    expect(gap).toBeGreaterThanOrEqual(20);

    await scheduler.stop();
  });

  it('stop() resolves queued tasks with null before they are started', async () => {
    const blocking = createBlockingGenerate();
    const scheduler = createMinimalScheduler({ idleDelay: 1 });

    scheduler.start();

    const activeResult = scheduler.submit(
      makeTask({
        priority: 'background',
        id: 'active-stop-task',
        createRun: () => ({
          generate: blocking.generate,
          toolbox: createTestToolbox([]),
          conversation: new Conversation(),
          maximumSteps: 1,
        }),
      }),
    );

    await sleep(10);

    const queuedResult = scheduler.submit(
      makeTask({
        priority: 'background',
        id: 'queued-stop-task',
      }),
    );

    await sleep(10);
    await scheduler.stop();

    expect(await queuedResult).toBeNull();
    expect(await activeResult).toBeNull();
    blocking.resolve(textResponse('unused'));
  });

  it('removeEventListener stops delivering events to that listener', async () => {
    const scheduler = createMinimalScheduler({ idleDelay: 1 });
    const taskQueuedListener = () => {
      throw new Error('removed listener should not fire');
    };

    scheduler.addEventListener('task.queued', taskQueuedListener);
    scheduler.removeEventListener('task.queued', taskQueuedListener);

    scheduler.start();
    await scheduler.submitImmediate(() => ({
      generate: createMockGenerate([textResponse('safe')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }));
    await scheduler.stop();
  });
});
