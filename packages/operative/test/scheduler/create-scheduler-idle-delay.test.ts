import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createManualRuntimeServices } from 'lifecycle';

import { createScheduler } from '../../src/scheduler/create-scheduler';
import type { SchedulerPriority, SchedulerTask } from '../../src/scheduler/types';
import { createMockGenerate } from '../../src/test/index';
import type { GenerateResponse } from '../../src/types';

/**
 * AB-348: split out of `create-scheduler.test.ts` (originally AB-330). The
 * original form measured a real inter-dispatch gap in milliseconds
 * (`performance.now()` before/after two task dispatches), asserting the
 * scheduler's `idleDelay` actually elapsed between them — reasoned as
 * necessary because "a manual clock only advances when told to, so it
 * cannot prove a real gap emerged from real waiting."
 *
 * `createScheduler` already routes `idleDelay` entirely through the
 * injected `RuntimeServices` seam (AB-92/AB-252/AB-253) —
 * `create-scheduler.ts`'s scheduling loop reads `runtime.monotonic.now()`
 * and calls `runtime.timers.setTimeout` via `waitForWake`, never the real
 * globals directly — so the property under test (idleDelay gates the second
 * dispatch until it elapses) can be proven by driving a manual clock's
 * `advance()` explicitly instead of by measuring how much real time passed.
 * This waits (via `yieldToPortableEventLoop` — an event-loop-turn yield, not
 * a real timer delay) for the idle-gate timer the scheduler arms after the
 * first task completes, confirms its due time is exactly `idleDelay` after
 * the first completion, advances the manual clock to one millisecond short
 * of it and confirms the second dispatch is still gated, then advances the
 * remaining millisecond and confirms it releases.
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

// Bounded, event-loop-turn poll — never a real timer delay.
const EVENT_LOOP_POLL_MAX_ATTEMPTS = 200;
async function waitForEventLoop(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < EVENT_LOOP_POLL_MAX_ATTEMPTS; attempt++) {
    if (predicate()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('waitForEventLoop exceeded its attempt bound before the condition held');
}

describe('createScheduler — idleDelay against a manual runtime', () => {
  it('gates the second dispatch until idleDelay elapses on the manual clock, not before', async () => {
    const runtime = createManualRuntimeServices();
    const dispatchOrder: string[] = [];
    const idleDelay = 30;

    const scheduler = createScheduler({
      generate: createMockGenerate([textResponse('default')]),
      toolbox: createTestToolbox([]),
      idleDelay,
      runtime,
    });

    // A manual runtime's monotonic clock starts at exactly 0
    // (`packages/lifecycle/src/manual-runtime-services.ts`'s
    // `monotonicMilliseconds` is always 0 at construction, independent of
    // `origin`). `create-scheduler.ts`'s idle-delay gate is conditioned on
    // `lastTaskCompletedAt > 0` — a strictly-positive check, meant to
    // distinguish "no task has completed yet" from a genuine completion
    // timestamp, which is never ambiguous against a real (always-huge) wall
    // clock. Against a manual clock starting at 0, though, a task
    // completing before any `advance()` call stamps `lastTaskCompletedAt`
    // at exactly 0 too, which reads as "never completed" and skips the
    // gate. Advancing past 0 once, before dispatch begins, keeps this test
    // in the regime every real clock is always already in.
    await runtime.advance(1);

    const results: Promise<unknown>[] = [];
    for (const name of ['first', 'second']) {
      results.push(
        scheduler.submit(
          makeTask({
            priority: 'background',
            id: name,
            createRun: () => {
              dispatchOrder.push(name);
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

    // The first task has no prior completion to gate against, so it
    // dispatches immediately.
    await waitForEventLoop(() => dispatchOrder.length >= 1);
    expect(dispatchOrder).toEqual(['first']);

    // Once the first task's run fully settles, the scheduling loop arms the
    // idle-gate timer for the second (still-queued) task — its presence in
    // `pendingTimers()` is itself the deterministic signal that the first
    // task has completed and `lastTaskCompletedAt` was stamped.
    await waitForEventLoop(() => runtime.pendingTimers().length > 0);
    const [gateTimer] = runtime.pendingTimers();
    if (!gateTimer) throw new Error('expected an idle-gate timer to be armed');
    const completedAt = runtime.monotonic.now();
    expect(gateTimer.dueAt).toBe(completedAt + idleDelay);

    // Advancing to just short of the gate's due time must NOT release the
    // second dispatch — this is the direct proof the original wall-clock
    // measurement stood in for.
    await runtime.advance(idleDelay - 1);
    expect(dispatchOrder).toEqual(['first']);
    expect(runtime.monotonic.now()).toBeLessThan(gateTimer.dueAt);

    // The remaining millisecond crosses the gate's due time and releases it.
    await runtime.advance(1);
    expect(runtime.monotonic.now()).toBe(gateTimer.dueAt);
    await waitForEventLoop(() => dispatchOrder.length >= 2);
    expect(dispatchOrder).toEqual(['first', 'second']);

    await Promise.all(results);
    await scheduler.stop();
  });
});
