import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createHeartbeat } from '../../src/scheduler/create-heartbeat';
import type { Scheduler } from '../../src/scheduler/create-scheduler';
import { createScheduler } from '../../src/scheduler/create-scheduler';
import { sleep } from '../../src/scheduler/sleep';
import { createMockGenerate } from '../../src/test/index';
import type { GenerateResponse } from '../../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function createTestScheduler() {
  return createScheduler({
    generate: createMockGenerate([textResponse('default')]),
    toolbox: createTestToolbox([]),
    idleDelay: 1,
  });
}

describe('createHeartbeat', () => {
  it('fires ticks at the configured interval', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    let tickCount = 0;

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 10,
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
    await sleep(45);
    heartbeat.stop();

    expect(tickCount).toBeGreaterThanOrEqual(2);
    expect(heartbeat.tickCount).toBe(tickCount);

    await scheduler.stop();
  });

  it('runImmediately triggers a tick before the first sleep', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    let firstTickAt = 0;

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 1000, // Long interval — only the immediate tick should fire
      runImmediately: true,
      createHeartbeatRun: () => ({
        generate: createMockGenerate([textResponse('immediate-tick')]),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
      onTick: () => {
        if (firstTickAt === 0) firstTickAt = performance.now();
      },
    });

    const startTime = performance.now();
    heartbeat.start();
    await sleep(30);
    heartbeat.stop();

    expect(heartbeat.tickCount).toBeGreaterThanOrEqual(1);
    // The first tick should have fired almost immediately
    expect(firstTickAt - startTime).toBeLessThan(100);

    await scheduler.stop();
  });

  it('maxConsecutiveFailures stops the heartbeat', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    let failureError: unknown;

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 5,
      maxConsecutiveFailures: 2,
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

    // Drive ticks manually so the assertion does not depend on wall-clock
    // throughput. The loop-based variant flaked (even without CPU starvation)
    // because a fixed sleep budget could not guarantee both failing ticks fired
    // before the assertion ran.
    // First failing tick → consecutiveFailures = 1, budget not yet exhausted.
    await heartbeat.tick();
    expect(heartbeat.consecutiveFailures).toBe(1);
    expect(failureError).toBeUndefined();

    // Second failing tick → budget exhausted → stop() + onFailure fire.
    // onFailure fires only inside the same branch that calls stop(), so a
    // defined failureError proves the stop path ran.
    await heartbeat.tick();
    expect(heartbeat.consecutiveFailures).toBe(2);
    expect(failureError).toBeDefined();

    await scheduler.stop();
  });

  it('a successful tick resets consecutiveFailures', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    let callCount = 0;

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 5,
      maxConsecutiveFailures: 3,
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

    // Drive ticks manually so the assertion does not depend on wall-clock
    // throughput (the loop-based variant flaked under CPU starvation when the
    // second, succeeding tick could not complete inside a fixed sleep budget).
    // First tick fails → consecutiveFailures = 1
    await heartbeat.tick();
    expect(heartbeat.consecutiveFailures).toBe(1);

    // Second tick succeeds → counter resets to 0
    await heartbeat.tick();
    expect(heartbeat.consecutiveFailures).toBe(0);

    await scheduler.stop();
  });

  it('stop() prevents further ticks', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    let tickCount = 0;

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 5,
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
    await sleep(15);
    heartbeat.stop();

    const countAtStop = tickCount;
    await sleep(30);

    // No more ticks should have fired after stop
    expect(tickCount).toBe(countAtStop);
    expect(heartbeat.isRunning).toBe(false);

    await scheduler.stop();
  });

  it('tick() manually triggers a heartbeat', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 60_000, // Long interval — won't fire naturally
      createHeartbeatRun: () => ({
        generate: createMockGenerate([textResponse('manual-tick')]),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
    });

    // Don't start the loop — just call tick() manually
    const result = await heartbeat.tick();

    expect(result).not.toBeNull();
    expect(result!.content).toBe('manual-tick');
    expect(heartbeat.tickCount).toBe(1);

    await scheduler.stop();
  });

  it('responds to abort signal', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    const controller = new AbortController();

    const heartbeat = createHeartbeat({
      scheduler,
      interval: 5,
      signal: controller.signal,
      createHeartbeatRun: () => ({
        generate: createMockGenerate([textResponse('tick')]),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }),
    });

    heartbeat.start();
    await sleep(15);
    controller.abort();
    await sleep(20);

    expect(heartbeat.isRunning).toBe(true); // isRunning reflects the flag, not the loop
    // But no more ticks should fire because the signal is aborted

    heartbeat.stop();
    await scheduler.stop();
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
