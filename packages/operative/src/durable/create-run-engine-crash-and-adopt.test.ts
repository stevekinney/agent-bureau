import { MemoryStorage, workflow, yieldToPortableEventLoop } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createRunEngine } from './create-run-engine';

/** A manually advanced clock for `createRunEngine({ getNow })`. */
function createManualClock(startTime = 1_000_000) {
  let now = startTime;
  return {
    getNow: () => now,
    /** Advances the clock and returns the new value, for `runMaintenance(now)`. */
    advance: (milliseconds: number) => {
      now += milliseconds;
      return now;
    },
  };
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
 * A workflow that commits one step (folding in its claim under
 * `ownership: 'workflow-lease'`) and then durably parks on
 * `ctx.waitForSignal('proceed')` until signaled.
 */
function makeParkingWorkflow() {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx, input: { value: number }) {
    yield* ctx.run(async () => 'started');
    yield* ctx.waitForSignal('proceed');
    return { doubled: input.value * 2 };
  });
}

/** True once `handle`'s workflow has left `pending` and is parked `running`. */
async function isParkedRunning(handle: { snapshot: () => Promise<{ status: string } | null> }) {
  const snapshot = await handle.snapshot();
  return snapshot !== null && snapshot.status === 'running';
}

describe('createRunEngine ownership (AB-178) — crash-and-adopt', () => {
  it("lets a surviving engine adopt a workflow after the crashed holder's claim lapses (crash-and-adopt)", async () => {
    const storage = new MemoryStorage();
    // Both engines share one manually advanced clock, so the claim TTL only
    // lapses when the test advances it; `backgroundTasks: 'manual'` on both
    // engines means nothing silently arms a background renewal loop that could
    // mask the crash.
    const claimTtlMs = 30;
    const claimRenewIntervalMs = 10;
    const clock = createManualClock();
    const a = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(),
      recover: false,
      ownership: 'workflow-lease',
      workflowClaimTtlMs: claimTtlMs,
      workflowClaimRenewIntervalMs: claimRenewIntervalMs,
      getNow: clock.getNow,
      backgroundTasks: 'manual',
    });

    const handle = await a.engine.start('agentRun', { value: 5 });
    await pollUntil(() => isParkedRunning(handle));

    // Simulate a crash: A is never disposed and never renews its claim again
    // (backgroundTasks: 'manual' means nothing renews it automatically). The
    // claim only lapses once the shared manual clock passes its TTL plus weft's
    // takeover-eligibility grace window on top of it
    // (`WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER` renewal intervals, currently
    // 2). Advance past both, with one extra millisecond so the boundary is
    // strictly exceeded.
    const takeoverGraceMs = 2 * claimRenewIntervalMs;
    const takeoverNow = clock.advance(claimTtlMs + takeoverGraceMs + 1);

    const b = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(),
      recover: false,
      ownership: 'workflow-lease',
      workflowClaimTtlMs: claimTtlMs,
      workflowClaimRenewIntervalMs: claimRenewIntervalMs,
      getNow: clock.getNow,
      backgroundTasks: 'manual',
    });

    try {
      // Driving B's maintenance once runs its claim-renewal task, which scans
      // for reclaimable (expired-claim) workflows and takes them over — the
      // same mechanism a real host's periodic maintenance call would trigger.
      await b.engine.runMaintenance(takeoverNow);

      const bHandle = await b.engine.resume(handle.id);
      expect(bHandle).toBeDefined();
      await b.engine.signal(handle.id, 'proceed');
      expect(await bHandle.result()).toEqual({ doubled: 10 });
    } finally {
      a.engine[Symbol.dispose]();
      b.engine[Symbol.dispose]();
    }
  });
});
