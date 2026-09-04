import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createScheduler } from '../../src/scheduler/create-scheduler';
import type { SchedulerPriority, SchedulerTask } from '../../src/scheduler/types';
import { createMockGenerate } from '../../src/test/index';
import type { GenerateResponse } from '../../src/types';

/**
 * AB-330: split out of `create-scheduler.test.ts` — this test measures a
 * real inter-dispatch gap in milliseconds (`performance.now()` before/after
 * two task dispatches), asserting the scheduler's `idleDelay` actually
 * elapses between them. That is a genuine real-clock latency property of
 * the scheduler's actual async processing loop; a manual clock only advances
 * when told to, so it cannot prove a real gap emerged from real waiting.
 * Real-runtime-exempted in `scripts/determinism-manifest.json`, owned by
 * this issue (AB-330).
 */

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

// A plain per-process counter instead of Math.random() — these ids only
// need to be distinct within a test run, not unpredictable.
let nextTaskId = 0;

function makeTask(
  overrides: Partial<SchedulerTask> & { priority: SchedulerPriority },
): SchedulerTask {
  return {
    id: `task-${(nextTaskId++).toString(36)}`,
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

describe('createScheduler — idleDelay real-time proof', () => {
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
});
