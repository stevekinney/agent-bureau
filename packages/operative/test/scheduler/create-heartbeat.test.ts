import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createHeartbeat } from '../../src/scheduler/create-heartbeat';
import type { Scheduler } from '../../src/scheduler/create-scheduler';
import { createMockGenerate } from '../../src/test/index';
import type { GenerateResponse, RunResult, StepResult } from '../../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function createTestScheduler() {
  return {
    submit: async (task) => {
      const runOptions = await task.createRun();
      const conversation = runOptions.conversation;
      const toolbox = runOptions.toolbox ?? createTestToolbox([]);
      const generate = runOptions.generate;

      if (!generate) {
        throw new Error('Heartbeat test runs must provide a generate function.');
      }

      try {
        const response = await generate({
          conversation,
          step: 0,
          signal: runOptions.signal,
          toolbox,
          toolChoice: runOptions.toolChoice,
          responseFormat: runOptions.responseFormat,
        });
        const stepResult: StepResult = {
          step: 0,
          conversation,
          content: response.content,
          toolCalls: [],
          results: [],
          usage: response.usage,
          metadata: response.metadata,
          final: true,
        };
        return {
          conversation,
          steps: [stepResult],
          content: response.content,
          usage: response.usage ?? { prompt: 0, completion: 0, total: 0 },
          finishReason: 'stop-condition',
        } satisfies RunResult;
      } catch (error) {
        return {
          conversation,
          steps: [],
          content: '',
          usage: { prompt: 0, completion: 0, total: 0 },
          finishReason: 'error',
          error,
        } satisfies RunResult;
      }
    },
  } as Scheduler;
}

async function flushAsyncWork(): Promise<void> {
  for (let iteration = 0; iteration < 5; iteration++) {
    await Promise.resolve();
  }
}

function createManualSleep() {
  const resolvers: Array<() => void> = [];
  const requestedIntervals: number[] = [];

  return {
    requestedIntervals,
    sleepFunction: (milliseconds: number) =>
      new Promise<void>((resolve) => {
        requestedIntervals.push(milliseconds);
        resolvers.push(resolve);
      }),
    get pendingCount() {
      return resolvers.length;
    },
    async advanceOne(): Promise<void> {
      const resolver = resolvers.shift();
      if (!resolver) {
        throw new Error('No pending heartbeat sleep to advance.');
      }
      resolver();
      await flushAsyncWork();
    },
    async advanceAll(): Promise<void> {
      while (resolvers.length > 0) {
        resolvers.shift()!();
      }
      await flushAsyncWork();
    },
  };
}

describe('createHeartbeat', () => {
  it('fires ticks at the configured interval', async () => {
    const scheduler = createTestScheduler();
    const manualSleep = createManualSleep();

    let tickCount = 0;

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 10,
      sleepFunction: manualSleep.sleepFunction,
      createHeartbeatRun: () => ({
        generate: createMockGenerate([textResponse('tick')]),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
      onTick: () => {
        tickCount++;
      },
    });

    heartbeat.start();
    await flushAsyncWork();
    await manualSleep.advanceOne();
    await manualSleep.advanceOne();
    heartbeat.stop();

    expect(tickCount).toBe(2);
    expect(heartbeat.tickCount).toBe(tickCount);
  });

  it('runImmediately triggers a tick before the first sleep', async () => {
    const scheduler = createTestScheduler();
    const manualSleep = createManualSleep();

    let tickCount = 0;

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 1000,
      runImmediately: true,
      sleepFunction: manualSleep.sleepFunction,
      createHeartbeatRun: () => ({
        generate: createMockGenerate([textResponse('immediate-tick')]),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
      onTick: () => {
        tickCount++;
      },
    });

    heartbeat.start();
    await flushAsyncWork();
    heartbeat.stop();

    expect(tickCount).toBe(1);
    expect(heartbeat.tickCount).toBe(1);
    expect(manualSleep.requestedIntervals).toEqual([1000]);
  });

  it('maxConsecutiveFailures stops the heartbeat', async () => {
    const scheduler = createTestScheduler();
    const manualSleep = createManualSleep();

    let failureError: unknown;

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 5,
      maxConsecutiveFailures: 2,
      sleepFunction: manualSleep.sleepFunction,
      createHeartbeatRun: () => ({
        generate: async () => {
          throw new Error('tick-error');
        },
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
      onFailure: (error) => {
        failureError = error;
      },
    });

    heartbeat.start();
    await flushAsyncWork();
    await manualSleep.advanceOne();
    await manualSleep.advanceOne();

    expect(heartbeat.isRunning).toBe(false);
    expect(heartbeat.consecutiveFailures).toBe(2);
    expect(failureError).toBeDefined();
  });

  it('a successful tick resets consecutiveFailures', async () => {
    const scheduler = createTestScheduler();
    const manualSleep = createManualSleep();

    let callCount = 0;

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 5,
      maxConsecutiveFailures: 3,
      sleepFunction: manualSleep.sleepFunction,
      createHeartbeatRun: () => {
        callCount++;
        if (callCount === 1) {
          // First tick fails
          return {
            generate: async () => {
              throw new Error('fail-once');
            },
            toolbox: createTestToolbox([]),
            conversation: new Conversation(),
            maximumSteps: 1,
          };
        }
        // Subsequent ticks succeed
        return {
          generate: createMockGenerate([textResponse('ok')]),
          toolbox: createTestToolbox([]),
          conversation: new Conversation(),
          maximumSteps: 1,
        };
      },
    });

    heartbeat.start();
    await flushAsyncWork();
    await manualSleep.advanceOne();
    expect(heartbeat.consecutiveFailures).toBe(1);
    await manualSleep.advanceOne();
    heartbeat.stop();

    expect(heartbeat.consecutiveFailures).toBe(0);
    expect(heartbeat.isRunning).toBe(false);
  });

  it('stop() prevents further ticks', async () => {
    const scheduler = createTestScheduler();
    const manualSleep = createManualSleep();

    let tickCount = 0;

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 5,
      sleepFunction: manualSleep.sleepFunction,
      createHeartbeatRun: () => ({
        generate: createMockGenerate([textResponse('tick')]),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
      onTick: () => {
        tickCount++;
      },
    });

    heartbeat.start();
    await flushAsyncWork();
    await manualSleep.advanceOne();
    heartbeat.stop();
    await flushAsyncWork();

    const countAtStop = tickCount;
    await manualSleep.advanceAll();

    expect(tickCount).toBe(countAtStop);
    expect(heartbeat.isRunning).toBe(false);
  });

  it('tick() manually triggers a heartbeat', async () => {
    const scheduler = createTestScheduler();

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 60_000,
      createHeartbeatRun: () => ({
        generate: createMockGenerate([textResponse('manual-tick')]),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
    });

    const result = await heartbeat.tick();

    expect(result).not.toBeNull();
    expect(result!.content).toBe('manual-tick');
    expect(heartbeat.tickCount).toBe(1);
  });

  it('responds to abort signal', async () => {
    const scheduler = createTestScheduler();
    const manualSleep = createManualSleep();

    const controller = new AbortController();
    let tickCount = 0;

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 5,
      signal: controller.signal,
      sleepFunction: manualSleep.sleepFunction,
      createHeartbeatRun: () => ({
        generate: createMockGenerate([textResponse('tick')]),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
      onTick: () => {
        tickCount++;
      },
    });

    heartbeat.start();
    await flushAsyncWork();
    await manualSleep.advanceOne();
    controller.abort();
    await manualSleep.advanceOne();

    expect(heartbeat.isRunning).toBe(true);
    expect(tickCount).toBe(1);

    heartbeat.stop();
  });

  it('treats a preempted heartbeat tick as a non-failure and forwards null to onTick', async () => {
    const ticks: Array<GenerateResponse | null> = [];
    const scheduler = {
      submit: async () => null,
    } as Scheduler;

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 10,
      createHeartbeatRun: async () => ({
        generate: createMockGenerate([textResponse('ignored')]),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
      onTick: (result) => {
        ticks.push(
          result ? ({ content: result.content, toolCalls: [] } as GenerateResponse) : null,
        );
      },
    });

    const result = await heartbeat.tick();

    expect(result).toBeNull();
    expect(heartbeat.consecutiveFailures).toBe(0);
    expect(ticks).toEqual([null]);
  });

  it('calls onFailure when scheduler submission throws and the failure budget is exhausted', async () => {
    const failures: unknown[] = [];
    const scheduler = {
      submit: async () => {
        throw new Error('submit failed');
      },
    } as Scheduler;

    const heartbeat = createHeartbeat({
      scheduler,
      maxConsecutiveFailures: 1,
      createHeartbeatRun: async () => ({
        generate: createMockGenerate([textResponse('ignored')]),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
      onFailure: (error) => {
        failures.push(error);
      },
    });

    const result = await heartbeat.tick();

    expect(result).toBeNull();
    expect(heartbeat.consecutiveFailures).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(Error);
  });
});
