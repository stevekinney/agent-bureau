import {
  Scheduler,
  workflow,
  type WorkflowLogRecord,
  type WorkflowStatus,
} from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { createRunEngine, type RegistryAgnosticEngine } from './create-run-engine';

/**
 * AB-330: split out of `create-run-engine.test.ts` — these two tests
 * deliberately prove that Weft's durable-timer poller stays UNARMED
 * (`Scheduler.prototype.start` never called, and the run stays non-terminal
 * through a real detection window) when `createRunEngine` is configured with
 * `recover: false` or `startScheduler: false`. That is a real-time absence
 * proof — a manual/injected clock cannot substitute, since the point is
 * observing that NOTHING drives the timer over actual wall-clock time.
 * `createRunEngine`'s public options carry no `getNow`/clock passthrough to
 * Weft's `Engine.create` (unlike `run-workflow.test.ts`'s `buildEngine`
 * helper, which calls `Engine.create` directly); adding one is a production
 * API surface change out of this test-only issue's scope (no changeset).
 * Real-runtime-exempted in `scripts/determinism-manifest.json`, owned by this
 * issue (AB-330) — the same split-out pattern armorer's
 * `execution-lifecycle-default-runtime.test.ts` and
 * `with-idempotency-default-runtime.test.ts` use for AB-254.
 */

const TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

// Drain Weft's deferred inline-launch queue between tests — a pending setTimeout(0)
// inline-launch left by one durable run can starve a later one under full
// `bun test` concurrency (CI).
afterEach(async () => {
  await yieldToPortableEventLoop();
});

// Sleep duration used by these negative (unarmed-poller) tests: short enough that
// a real-time poller WOULD fire it within POLLER_DETECTION_WINDOW_MS, making the
// tests falsifiable — they fail if createRunEngine accidentally arms the scheduler.
const PARKED_SLEEP_MILLISECONDS = 50;
// Scheduler poll interval injected into these engines so that an accidentally
// armed poller fires expired timers within a few milliseconds, well inside
// POLLER_DETECTION_WINDOW_MS.
const DETECTION_SCHEDULER_POLL_INTERVAL_MS = 1;
// Window (ms) to wait after the run parks before asserting it is still
// non-terminal. Must be > PARKED_SLEEP_MILLISECONDS + several
// DETECTION_SCHEDULER_POLL_INTERVAL_MS cycles so a misfiring poller would have
// fired the now-expired timer before the assertion runs.
const POLLER_DETECTION_WINDOW_MS = PARKED_SLEEP_MILLISECONDS * 3 + 50;
// Fixed, arbitrarily far-future epoch millisecond value used to tick the
// scheduler unambiguously past a parked timer's deadline. Not derived from
// the real clock: the deadline itself is computed from Weft's real getNow()
// when ctx.sleep() ran (bounded by whenever the test executes, far short of
// this constant), so any sufficiently distant future instant works.
const FAR_FUTURE_EPOCH_MILLISECONDS = 4_102_444_800_000; // 2100-01-01T00:00:00.000Z

// Logged by makeSleepingWorkflow on the step BEFORE ctx.sleep. Observing it via
// the onLog sink is positive proof the generator actually reached the sleep —
// "non-terminal" alone would also hold if the run never started, which is not
// what the parked-timer tests mean to assert.
const REACHED_SLEEP_MARKER = 'reached sleep';

/**
 * A probe workflow that parks on a durable `ctx.sleep` before finishing. It logs
 * {@link REACHED_SLEEP_MARKER} on the step immediately before the sleep, so a test
 * can prove the generator reached the timer.
 */
function makeSleepingWorkflow(sleepMilliseconds: number) {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx, input: { value: number }) {
    ctx.log?.info(REACHED_SLEEP_MARKER);
    yield* ctx.sleep(sleepMilliseconds);
    return { doubled: input.value * 2 };
  });
}

// Generously-bounded poll: yield the portable event loop until `predicate` holds.
const POLL_UNTIL_MAX_ATTEMPTS = 1000;
async function pollUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < POLL_UNTIL_MAX_ATTEMPTS; attempt++) {
    if (await predicate()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('pollUntil exceeded its attempt bound before the condition held');
}

/**
 * Assert a run parks on its durable `ctx.sleep` because nothing drives the
 * scheduler, then fires the moment the scheduler is driven explicitly. See
 * `create-run-engine.test.ts`'s original JSDoc (AB-296) for the full
 * three-step rationale this mirrors.
 */
async function assertRunStaysParkedWhenPollerUnarmed(
  engine: RegistryAgnosticEngine,
  reachedSleepMarkers: readonly WorkflowLogRecord[],
) {
  const handle = await engine.start('agentRun', { value: 21 });
  await pollUntil(async () => {
    if (reachedSleepMarkers.length < 1) return false;
    const snapshot = await handle.snapshot();
    return snapshot !== null && !TERMINAL_STATUSES.has(snapshot.status);
  });
  expect(reachedSleepMarkers.length).toBe(1);
  // Give a real-time poller adequate opportunity to fire the due timer. This is
  // the one genuinely real-clock read in this file — proving the ABSENCE of
  // poller activity over actual wall-clock time.
  await new Promise<void>((resolve) => setTimeout(resolve, POLLER_DETECTION_WINDOW_MS));
  const parkedSnapshot = await handle.snapshot();
  expect(parkedSnapshot).not.toBeNull();
  expect(TERMINAL_STATUSES.has(parkedSnapshot!.status)).toBe(false);
  // Drive the scheduler directly past the timer's deadline.
  await engine.scheduler.tick(FAR_FUTURE_EPOCH_MILLISECONDS);
  await pollUntil(async () => {
    const snapshot = await handle.snapshot();
    return snapshot !== null && TERMINAL_STATUSES.has(snapshot.status);
  });
  const firedSnapshot = await handle.snapshot();
  expect(firedSnapshot).not.toBeNull();
  expect(firedSnapshot!.status).toBe('completed');
}

describe('createRunEngine — poller-unarmed proof (#590)', () => {
  it('leaves durable ctx.sleep timers parked under recover:false without startScheduler (#590)', async () => {
    const schedulerStartSpy = spyOn(Scheduler.prototype, 'start');
    const reachedSleep: WorkflowLogRecord[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeSleepingWorkflow(PARKED_SLEEP_MILLISECONDS),
      recover: false,
      schedulerPollIntervalMs: DETECTION_SCHEDULER_POLL_INTERVAL_MS,
      onLog: (record) => {
        if (record.message === REACHED_SLEEP_MARKER) reachedSleep.push(record);
      },
    });

    try {
      // Direct proof: recover:false with no startScheduler must never call
      // Scheduler.start(), so the real-time polling interval is never set up.
      expect(schedulerStartSpy).not.toHaveBeenCalled();
      await assertRunStaysParkedWhenPollerUnarmed(engine, reachedSleep);
    } finally {
      schedulerStartSpy.mockRestore();
      engine[Symbol.dispose]();
    }
  });

  it('does not arm the scheduler when startScheduler:false overrides recover:true (#590)', async () => {
    const schedulerStartSpy = spyOn(Scheduler.prototype, 'start');
    const reachedSleep: WorkflowLogRecord[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeSleepingWorkflow(PARKED_SLEEP_MILLISECONDS),
      recover: true,
      startScheduler: false,
      schedulerPollIntervalMs: DETECTION_SCHEDULER_POLL_INTERVAL_MS,
      onLog: (record) => {
        if (record.message === REACHED_SLEEP_MARKER) reachedSleep.push(record);
      },
    });

    try {
      // Direct proof: startScheduler:false must suppress the call even when
      // recover:true — Scheduler.start() must never be invoked.
      expect(schedulerStartSpy).not.toHaveBeenCalled();
      await assertRunStaysParkedWhenPollerUnarmed(engine, reachedSleep);
    } finally {
      schedulerStartSpy.mockRestore();
      engine[Symbol.dispose]();
    }
  });
});
