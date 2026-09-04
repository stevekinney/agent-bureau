import type { GenerateFunction } from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createToolbox } from 'armorer';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { ManualRuntimeServices } from 'lifecycle';
import { createManualRuntimeServices } from 'lifecycle';

import type { Bureau, RunSummary } from '../types';
import { type BureauTestHarness, createBureauTestHarness } from './harness';
import { createLmdbStorageFixture, createMemoryStorageFixture } from './storage-fixtures';

function mockGenerate(content = 'Done.'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

/**
 * Split out of `harness.test.ts` (AB-332) so `scripts/determinism-manifest.json`'s
 * `realRuntimeExemptions` entry for this one residual real wait covers only this file, not the
 * whole harness suite — every other `waitForRunCompletion` call site in `harness.test.ts` now
 * drives `waitForRunState` (event-driven, no real timer) instead.
 *
 * Same drain pattern `create-bureau.test.ts` uses for the durable inline-launch queue, plus a
 * real-delay poll for the terminal-status wait itself (`waitForCondition`'s own default, a
 * zero-delay `MessageChannel` macrotask loop, is NOT enough here — root-caused directly, not a
 * blind workaround: with the `lmdb` backend, spinning that macrotask loop measurably STARVES the
 * native library's own async completion — a 5,000-iteration zero-delay spin (~600ms of real
 * time) left two concurrent LMDB-backed runs still `'running'`, while the identical scenario
 * polled with real `setTimeout(5)` between checks completed both well within a couple hundred
 * milliseconds. `MessageChannel` macrotasks evidently get scheduled ahead of `lmdb`'s own
 * completion callbacks when nothing yields real time between posts, so a tight macrotask-only
 * loop can spin forever without ever letting the pending write land. A tiny real per-iteration
 * delay breaks that starvation while remaining a bounded, condition-checked POLL — this still
 * asserts the observed status each iteration and fails loudly past the cap, never a blind
 * "sleep N then assume it's done."
 *
 * WFT-138 (Backlog) tracks the actual fix — a test-mode `noSync`/`noMetaSync` option on
 * `LMDBStorage` so a write followed by a read in the same process observes the write without
 * waiting on fsync. Once it lands and the Bureau LMDB storage fixture
 * (`packages/bureau/src/test/storage-fixtures.ts`) passes the relaxed mode, this real wait can be
 * replaced with `waitForRunState` like every other backend, and this file can fold back into
 * `harness.test.ts`.
 */
async function waitForRunCompletion(bureau: Bureau, runId: string): Promise<void> {
  const maximumAttempts = 400;
  let status: string | undefined;
  let reachedTerminalStatus = false;
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    status = bureau.getRun(runId)?.status;
    // `undefined` (the run id is not yet, or never, known to this bureau) is
    // NOT a terminal status — keep polling for it exactly like `'running'`,
    // rather than treating "not found yet" as "already done" (a false
    // positive `undefined !== 'running'` would produce).
    if (status !== undefined && status !== 'running') {
      reachedTerminalStatus = true;
      break;
    }
    if (attempt < maximumAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (!reachedTerminalStatus) {
    throw new Error(
      status === undefined
        ? `Run ${runId} was never observed by bureau.getRun`
        : `Run ${runId} did not reach a terminal status`,
    );
  }
  for (let i = 0; i < 10; i++) {
    await yieldToPortableEventLoop();
  }
}

describe('waitForRunCompletion (this file’s own test helper)', () => {
  it('keeps polling — never treats "not found yet" as done — and fails with a distinct message when a run id is never observed', async () => {
    const storage = createMemoryStorageFixture();
    const harness = await createBureauTestHarness({
      agents: {},
      generate: mockGenerate(),
      toolbox: createToolbox([]),
      storage,
    });

    try {
      // Not awaited: bun:test types `expect(...).rejects.toThrow()` as
      // `void`, not `Promise<void>` — `await` here trips
      // `@typescript-eslint/await-thenable` — matching the repo's own
      // established pattern elsewhere (e.g. create-supervisor.test.ts). The
      // assertion's rejection lands asynchronously, after `finally` below
      // disposes the harness; that's fine here because a disposed bureau's
      // `getRun` keeps returning `undefined` forever, so the poll still
      // exhausts its attempts and rejects with the expected message
      // regardless of dispose timing.
      expect(waitForRunCompletion(harness.bureau, 'no-such-run')).rejects.toThrow(
        /never observed/i,
      );
    } finally {
      await harness.bureau.dispose();
      await storage.dispose();
    }
  });
});

describe('two concurrent harnesses are fully isolated', () => {
  describe('lmdb: independent storage paths, timers, identifiers, and events', () => {
    /**
     * AB-306: root-caused directly before restructuring anything. Timing the
     * two storage-fixture creations, the two `createBureauTestHarness` calls,
     * and the `waitForRunCompletion` polls separately under artificial load
     * (six concurrent `bun test` runs of another package) showed fixture
     * creation and Bureau construction together cost well under 200ms even
     * loaded — not construction cost, as initially suspected. The real cost
     * living inside the old single `it.each` body was three sequential
     * `waitForRunCompletion` calls: each one polls with a REAL
     * `setTimeout(5)` between checks (a documented, intentional fix for LMDB
     * completion-callback starvation under a zero-delay macrotask loop — see
     * that helper's own comment above), and real timer delivery is exactly
     * what degrades under host CPU contention, sometimes taking 100s of ms
     * per 5ms-nominal tick. Stacking three such polls inside ONE test's
     * 5000ms Bun default timeout is what actually timed out under load, not
     * the fixture/construction cost.
     *
     * The fix moves every real-time-consuming step (fixture creation, Bureau
     * construction, and — critically — each `waitForRunCompletion` poll) into
     * its own `beforeAll` hook. Bun (confirmed empirically) gives each
     * `beforeAll` call in a describe block its OWN default timeout budget
     * rather than sharing one budget across the whole sequence, so splitting
     * the three real waits into three separate hooks roughly triples the
     * real-time headroom available before any single step could time out —
     * without raising any timeout, retry, or resource cap. Every `it` body
     * below is now a synchronous (or synthetic-clock-only) assertion with no
     * real wall-clock dependency, so per-test budget pressure from load is
     * gone. The isolation assertions themselves (paths differ, timers
     * independent, identifiers independent, events not shared) are
     * unchanged in meaning — only when the underlying work happens moved.
     */
    let runtimeA: ManualRuntimeServices;
    let runtimeB: ManualRuntimeServices;
    let storageA: ReturnType<typeof createLmdbStorageFixture>;
    let storageB: ReturnType<typeof createLmdbStorageFixture>;
    let harnessA: BureauTestHarness;
    let harnessB: BureauTestHarness;
    let runA: RunSummary;
    let runB: RunSummary;
    let eventsSeenByA: string[];

    beforeAll(async () => {
      runtimeA = createManualRuntimeServices({ origin: '2024-01-01T00:00:00.000Z' });
      runtimeB = createManualRuntimeServices({ origin: '2025-06-15T00:00:00.000Z' });
      // Path allocation draws an identifier from its OWN fresh runtime, not
      // runtimeA/runtimeB — those are reserved for the harness's own run-id
      // minting, and the "mints identifiers independently" assertion below
      // depends on nothing else consuming from that counter first.
      storageA = createLmdbStorageFixture({ runtime: createManualRuntimeServices() });
      storageB = createLmdbStorageFixture({ runtime: createManualRuntimeServices() });

      harnessA = await createBureauTestHarness({
        agents: {},
        generate: mockGenerate('A'),
        toolbox: createToolbox([]),
        runtime: runtimeA,
        storage: storageA,
      });
      harnessB = await createBureauTestHarness({
        agents: {},
        generate: mockGenerate('B'),
        toolbox: createToolbox([]),
        runtime: runtimeB,
        storage: storageB,
      });
    });

    // Distinct identifier sequences: each harness's Bureau mints its runId
    // through its OWN composed runtime — both produce the same
    // first-of-kind counter value independently. Draining runA to
    // completion here (its own hook, its own timeout budget) matters
    // beyond the identifier check itself: it keeps runA's own completion
    // frame from firing later, during the event-isolation hook's
    // subscription window, and being mistaken for cross-harness leakage.
    beforeAll(async () => {
      runA = await harnessA.startSession({ message: 'on A' });
      runB = await harnessB.startSession({ message: 'on B' });
      await waitForRunCompletion(harnessA.bureau, runA.id);
    });

    // Drained in its own hook (rather than alongside runA's wait above) so
    // this real LMDB completion poll gets its own fresh timeout budget too.
    beforeAll(async () => {
      await waitForRunCompletion(harnessB.bureau, runB.id);
    });

    // Neither harness observes the other's events. Subscribing and
    // draining the B-only run happen here — its own hook, its own budget —
    // rather than inside the `it` below, for the same reason as the two
    // hooks above.
    beforeAll(async () => {
      eventsSeenByA = [];
      const unsubscribeA = harnessA.bureau.subscribeLiveFrames((frame) => {
        eventsSeenByA.push(frame.type);
      });
      // try/finally: if startSession or waitForRunCompletion throws, this
      // still unsubscribes rather than leaking a live subscription on
      // harnessA into afterAll's teardown, which could mask the real
      // failure behind an unrelated dispose-time symptom.
      try {
        const runOnBOnly = await harnessB.startSession({ message: 'B-only run' });
        await waitForRunCompletion(harnessB.bureau, runOnBOnly.id);
      } finally {
        unsubscribeA();
      }
    });

    afterAll(async () => {
      await harnessA.bureau.dispose();
      await harnessB.bureau.dispose();
      // Fixture dispose() already deletes only paths IT allocated
      // (`owned: true`) and leaves a caller-supplied path untouched — a
      // second, unconditional `rm` here would duplicate that ownership
      // check and could delete a real caller-supplied path if this test
      // ever passed one explicitly. Rely on the fixtures' own dispose().
      await storageA.dispose();
      await storageB.dispose();
    });

    it('has distinct storage paths and distinct clocks', () => {
      expect(storageA.path).not.toBe(storageB.path);
      expect(runtimeA.clock.now()).not.toBe(runtimeB.clock.now());
    });

    it('mints identifiers independently', () => {
      expect(runA.id).toBe(`${runtimeA.identifierPrefix}-run-1`);
      expect(runB.id).toBe(`${runtimeB.identifierPrefix}-run-1`);
    });

    it('never fires the other runtime when advancing timers', async () => {
      let firedOnA = 0;
      let firedOnB = 0;
      runtimeA.timers.setTimeout(() => {
        firedOnA += 1;
      }, 1000);
      runtimeB.timers.setTimeout(() => {
        firedOnB += 1;
      }, 1000);
      await runtimeA.advance(1000);
      expect(firedOnA).toBe(1);
      expect(firedOnB).toBe(0);
      await runtimeB.advance(1000);
      expect(firedOnB).toBe(1);
    });

    it('never lets A observe B-only events', () => {
      expect(eventsSeenByA).toEqual([]);
    });
  });
});
