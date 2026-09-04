import { workflow } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { describe, expect, it } from 'bun:test';

import { createRunEngine } from './create-run-engine';

/**
 * AB-330: split out of `create-run-engine.test.ts`'s AB-178 ownership suite.
 * This crash-and-adopt scenario needs a genuine real-time wait: it lets a
 * `workflow-lease` claim's TTL lapse on Weft's OWN real wall clock (its
 * `getNow` is not injectable through the public `Engine.create` surface, and
 * `createRunEngine`'s options carry no clock passthrough — adding one is a
 * production API surface change out of this test-only issue's scope, no
 * changeset). Real-runtime-exempted in `scripts/determinism-manifest.json`,
 * owned by this issue (AB-330).
 */

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
    // A short claim TTL/renewal so the test does not wait out Weft's real 30s
    // default; `backgroundTasks: 'manual'` on both engines means the TTL only
    // lapses on the wall clock — nothing here silently arms a background
    // renewal loop that could mask the crash.
    const claimTtlMs = 30;
    const a = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(),
      recover: false,
      ownership: 'workflow-lease',
      workflowClaimTtlMs: claimTtlMs,
      workflowClaimRenewIntervalMs: 10,
      backgroundTasks: 'manual',
    });

    const handle = await a.engine.start('agentRun', { value: 5 });
    await pollUntil(() => isParkedRunning(handle));

    // Simulate a crash: A is never disposed and never renews its claim again
    // (backgroundTasks: 'manual' means nothing renews it automatically). The
    // claim's expiry is a genuine wall-clock quantity inside weft (its
    // `getNow` is not injectable through the public `Engine.create` surface),
    // so waiting it out needs a real timer — bounded to a small multiple of
    // the (already tiny) configured TTL, covering both the TTL itself and
    // weft's own takeover-eligibility grace window on top of it
    // (`WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER`), not a tuned guess.
    await new Promise((resolve) => setTimeout(resolve, claimTtlMs * 10));

    const b = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(),
      recover: false,
      ownership: 'workflow-lease',
      workflowClaimTtlMs: claimTtlMs,
      workflowClaimRenewIntervalMs: 10,
      backgroundTasks: 'manual',
    });

    try {
      // Driving B's maintenance once runs its claim-renewal task, which scans
      // for reclaimable (expired-claim) workflows and takes them over — the
      // same mechanism a real host's periodic maintenance call would trigger.
      // A real Date.now() read (not a fixed far-future constant) because it
      // must land AFTER the real wait above but need not exceed anything
      // else — the claim scan compares against actual elapsed wall time.
      await b.engine.runMaintenance(Date.now());

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
