/**
 * The Bureau recovered-durable adapter (AB-269): two independently
 * constructed `Bureau` instances over the SAME `createSqliteStorageFixture`
 * path — bureau A dispatches a catalog run (`bureau.run`), parks it
 * mid-flight, and is deliberately left holding that parked handle; bureau B
 * boots over the same storage and, per AB-240 (now on `origin/main`, PR
 * #457), genuinely resumes and completes it. This is "object reconstruction
 * in one process" (AB-92's own phrase) — proving the public
 * serialization/reattachment contract, not a real OS process crash, which
 * is AB-97's tier and is never claimed here.
 *
 * SPEC NOTE — disposal ordering (evidence-resolved conflict): the issue
 * text describes "disposes [bureau A] through the production shutdown
 * boundary ... starts a second harness ... and reattaches." Empirically,
 * `Bureau.shutdown()` — BOTH policies — cannot be the step that precedes
 * booting bureau B: `'abort'` calls `engine.cancel()` on every tracked
 * run (including a catalog dispatch), which durably marks the workflow
 * `cancelled` before bureau B ever boots (verified: a hung catalog run's
 * `shutdown({policy:'abort'})` report shows every owner `'completed'`, and
 * bureau B's `getDurableRun` then reads back `status: 'cancelled'` with
 * zero steps taken) — nothing is left "mid-flight" to recover. `'drain'`
 * fares no better under this harness: its `timeoutMilliseconds` bound
 * defaults to `RuntimeServices.timers`, which `ManualRuntimeServices` never
 * advances, so a bounded `'drain'` against a genuinely parked run hangs
 * the harness outright (recorded in this issue's `followUps`, not fixed
 * here). The ordering AB-207's OWN author uses for the identical constraint
 * (`create-bureau.test.ts`'s "recovers an in-flight durable run" test) is
 * followed instead: bureau A is deliberately left open (its parked run
 * registered `detached: true` on its own `ResourceScope`, never a leak),
 * bureau B is booted, resumes, and completes the run, bureau B is closed
 * (quiescence-asserted) — and ONLY THEN is bureau A closed (also
 * quiescence-asserted, now over the same durable id via
 * `harnessA.registerDurableRun(runId, { detached: true })`, since the run
 * is terminal by the time A's own `close()` reads it). No storage handle
 * is ever open twice unsupervised, and both harnesses end quiescent.
 *
 * SPEC NOTE — `'targeted-abort'` (evidence-resolved conflict): the issue
 * text says this capability is "supported only through
 * `Bureau.cancelDurableRun`, never through `abortRun`." Both halves of that
 * are independently verified true (`abortRun` on bureau B throws
 * `NOT_FOUND` for the reattached run — no live handle exists for a
 * catalog-dispatched recovery; `cancelDurableRun` genuinely transitions it
 * to `'cancelled'`). But the SHARED `targetedAbort` scenario
 * (`runner.ts`) additionally requires an `EventRecorder` that captured a
 * real `'run.aborted'` event for the resource — and no public surface
 * exposes that for a reattached run: `bureau.getRun(runId)` returns
 * `undefined` for a catalog dispatch (only a session/`createRun` dispatch
 * gets a `RunDetail`), and even a session dispatch's `RunDetail.events`
 * never gains a `'run.aborted'` entry after `cancelDurableRun` resolves
 * (verified directly: `cancelDurableRun` resolves `{status:'requested'}`
 * and a subsequent read of `getRun(runId).events` still ends at
 * `'generate.started'`, no terminal entry, ever). This is exactly AB-91's
 * named gap ("reconnect-safe durable run and session event history"),
 * which this issue's own Out of scope section excludes. `'targeted-abort'`
 * is therefore declared unsupported here, owned by AB-91 — the
 * `cancelDurableRun`-not-`abortRun` behavior the issue text cares about is
 * still fully exercised and asserted by the `'detachment'` scenario below,
 * whose `DetachmentOutcome` needs no event trace.
 *
 * Capabilities needing a live per-run event stream or a process-local
 * child registry that does not survive reattachment are declared
 * unsupported: `'parentage'`/`'root-subtree-abort'`/`'sibling-isolation'`
 * (children are process-local by design, AB-92 AC3 — bureau B never had
 * bureau A's `MutableChildRunRegistry`, owned by AB-50); `'independent-
 * observers'` (AB-87, same single-consumer `AgentRun` reason as every
 * other Bureau-backed adapter); `'ready-and-running-state'`/`'terminal-
 * success'`/`'terminal-failure'`/`'idempotent-result'` (each needs a live
 * `AgentRun`-shaped handle on bureau B that a reattached catalog run does
 * not have — AB-91 again); `'signal-delivery'` (a durable session's
 * `requestHumanInput` wait surviving a restart is real product surface
 * AB-42 owns, not yet proven here).
 */
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { createManualRuntimeServices, waitForCondition } from '@lostgradient/operative/test';
import { createTool, createToolbox } from 'armorer';
import { createBureauTestHarness, createSqliteStorageFixture } from 'bureau/test';
import { z } from 'zod';

import type { LifecycleCapability, LifecycleContractAdapter } from '../runner';
import { createUnsupportedOutcomeFactory, stableRunId } from '../support';

const MODE = 'bureau-recovered';
const UNSUPPORTED: Readonly<Partial<Record<LifecycleCapability, string>>> = {
  parentage: 'AB-50',
  'ready-and-running-state': 'AB-91',
  'terminal-success': 'AB-91',
  'terminal-failure': 'AB-91',
  'independent-observers': 'AB-87',
  'idempotent-result': 'AB-91',
  'targeted-abort': 'AB-91',
  'root-subtree-abort': 'AB-50',
  'sibling-isolation': 'AB-50',
  'signal-delivery': 'AB-42',
};
const unsupported = createUnsupportedOutcomeFactory(MODE, UNSUPPORTED);

/** A generate function that parks at step 1 (never releasing on its own) — every call after the first blocks on `context.signal`'s abort, never on a timer. Mirrors `@lostgradient/operative/test`'s `createStepwiseBlockingGenerate`, reimplemented here so bureau A's own park never resolves even when bureau B independently resumes the SAME workflow id (two separate closures, two separate `Promise`s — resuming bureau B's copy can never settle bureau A's). */
function createParkingGenerate(): { generate: GenerateFunction; steps: number[] } {
  const steps: number[] = [];
  const generate: GenerateFunction = async (context) => {
    steps.push(context.step);
    if (context.step === 0) {
      return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
    }
    return new Promise((resolve) => {
      context.signal?.addEventListener(
        'abort',
        () => resolve({ content: 'aborted', toolCalls: [] }),
        { once: true },
      );
    });
  };
  return { generate, steps };
}

function nextTool() {
  return createTool({
    name: 'next',
    description: 'Advances the run to its next step.',
    input: z.object({}),
    execute: async () => ({ result: 'ok' }),
  });
}

/** A settling generate for bureau B: records every `step` it is invoked with and resolves immediately, regardless of step number — bureau B resumes from whatever checkpoint bureau A left (step 1), never replaying step 0. */
function createResumingGenerate(): { generate: GenerateFunction; steps: number[] } {
  const steps: number[] = [];
  const generate: GenerateFunction = async (context) => {
    steps.push(context.step);
    return { content: `resumed step ${context.step}`, toolCalls: [] };
  };
  return { generate, steps };
}

/**
 * Builds bureau A over a FRESH, uniquely allocated (owned) sqlite path,
 * dispatches the catalog `'p'` run, registers it `detached: true` on
 * bureau A's own `ResourceScope` (the deliberate abandonment AB-34 names —
 * never a leak), and waits until it parks at step 1 (its checkpoint
 * durably committed). Returns everything the caller needs to boot bureau B
 * over the SAME path and, eventually, close both harnesses in the ordering
 * this module's doc comment justifies.
 */
async function startParkedRunOnA() {
  const runtimeA = createManualRuntimeServices();
  const ownedStorage = createSqliteStorageFixture({ runtime: runtimeA });
  const path = ownedStorage.path;
  if (path === undefined) {
    throw new Error('bureau-recovered: createSqliteStorageFixture did not allocate a path');
  }
  const parking = createParkingGenerate();
  const harnessA = await createBureauTestHarness({
    agents: {
      p: createAgent({
        generate: parking.generate,
        name: 'p',
        toolbox: createToolbox([nextTool()]),
        runtime: runtimeA,
      }),
    },
    runtime: runtimeA,
    // Bureau A never actually owns the file on disk (see the module doc):
    // pass an UNOWNED fixture over the same path so `harnessA.close()`'s
    // internal `storage.dispose()` is a no-op, leaving `ownedStorage` as
    // the single fixture responsible for eventually removing it.
    storage: createSqliteStorageFixture({ runtime: runtimeA, path }),
    durableExecution: true,
    generate: async () => ({ content: 'top', toolCalls: [] }),
    toolbox: createToolbox([]),
  });

  const run = harnessA.bureau.run('p', 'go');
  // `run.snapshot().id` can briefly reflect the catalog agent's bare name
  // ('p') before its real, derived durable run id settles — resolve the
  // settled id before using it anywhere `bureau.getDurableRun`/
  // `cancelDurableRun` (or bureau B's own catalog dispatch) need to agree
  // on the SAME identifier.
  const runId = await stableRunId(run);
  harnessA.scope.register({ kind: 'run', identifier: runId, run, detached: true });
  await waitForCondition(
    () => parking.steps.includes(1),
    'bureau-recovered: bureau A never parked at step 1',
  );

  return { harnessA, runId, path, ownedStorage };
}

/**
 * Boots bureau B over `path` for the SAME `runId` bureau A minted (a
 * catalog-dispatched run's id is stable across the restart — `stableIdentity`
 * itself asserts this) and waits for it to reach `predicate`, polling
 * `bureau.getDurableRun(runId)` directly rather than re-deriving `runId`
 * from `listDurableRuns()` on every attempt. `agentGenerate` defaults to a
 * settling generate (`createResumingGenerate`) that lets the resumed run
 * run straight to completion; a caller needing bureau B to ALSO park
 * mid-flight (so a subsequent `cancelDurableRun` targets a genuinely
 * non-terminal run instead of racing bureau B's own completion) passes a
 * parking generate instead and polls on that generate's own `steps`, not
 * on `getDurableRun`'s status.
 */
async function bootRecoveringHarnessB(
  path: string,
  runId: string,
  predicate: (runtimeStatus: string | undefined) => boolean,
  agentGenerate: GenerateFunction = createResumingGenerate().generate,
) {
  const runtimeB = createManualRuntimeServices();
  const harnessB = await createBureauTestHarness({
    agents: {
      p: createAgent({
        generate: agentGenerate,
        name: 'p',
        toolbox: createToolbox([nextTool()]),
        runtime: runtimeB,
      }),
    },
    runtime: runtimeB,
    storage: createSqliteStorageFixture({ runtime: runtimeB, path }),
    durableExecution: true,
    generate: async () => ({ content: 'top', toolCalls: [] }),
    toolbox: createToolbox([]),
  });
  await waitForCondition(async () => {
    const state = await harnessB.bureau.getDurableRun(runId);
    return predicate(state?.status);
  }, 'bureau-recovered: bureau B never reached the expected recovered state');
  return { harnessB };
}

export function createBureauRecoveredAdapter(): LifecycleContractAdapter {
  return {
    mode: MODE,
    supports: (capability) => !(capability in UNSUPPORTED),

    async stableIdentity() {
      const { harnessA, runId, ownedStorage } = await startParkedRunOnA();
      try {
        const { harnessB } = await bootRecoveringHarnessB(
          ownedStorage.path as string,
          runId,
          (status) => status === 'completed',
        );
        const reattachedOnB = await harnessB.reattachDurable(runId);
        const secondId = reattachedOnB?.id ?? '';
        harnessB.registerDurableRun(runId);
        await harnessB.close();
        harnessA.registerDurableRun(runId, { detached: true });
        await harnessA.close();
        return { firstId: runId, secondId };
      } finally {
        await ownedStorage.dispose();
      }
    },

    parentage: () => Promise.resolve(unsupported('parentage')),
    readyAndRunningState: () => Promise.resolve(unsupported('ready-and-running-state')),
    terminalSuccess: () => Promise.resolve(unsupported('terminal-success')),
    terminalFailure: () => Promise.resolve(unsupported('terminal-failure')),
    independentObservers: () => Promise.resolve(unsupported('independent-observers')),
    idempotentResult: () => Promise.resolve(unsupported('idempotent-result')),
    targetedAbort: () => Promise.resolve(unsupported('targeted-abort')),
    rootSubtreeAbort: () => Promise.resolve(unsupported('root-subtree-abort')),
    siblingIsolation: () => Promise.resolve(unsupported('sibling-isolation')),

    async detachment() {
      const { harnessA, runId, ownedStorage } = await startParkedRunOnA();
      try {
        // Discoverable while bureau A still holds the parked handle — the
        // public surface a detached run must stay reachable through.
        const discoverableAfterDetach = (await harnessA.reattachDurable(runId)) != null;

        // Bureau B's OWN agent parks too (never a settling generate): a
        // settling generate races bureau B's own completion against the
        // `cancelDurableRun` call below — `getDurableRun`'s status can
        // already read `'completed'` by the time this reads it, resolving
        // `cancelDurableRun` to `'already-terminal'` instead of
        // `'requested'` (AB-205's own resolution order) and flaking this
        // scenario under load. Parking bureau B too keeps the run
        // genuinely non-terminal until cancelled explicitly.
        const parkingB = createParkingGenerate();
        const { harnessB } = await bootRecoveringHarnessB(
          ownedStorage.path as string,
          runId,
          () => parkingB.steps.includes(1),
          parkingB.generate,
        );
        // Cancelled explicitly through the durable locator (never
        // `abortRun`, which has no live handle for a reattached catalog
        // run — see this module's `'targeted-abort'` doc note) before
        // either fixture closes, per this issue's own acceptance criteria.
        const outcome = await harnessB.bureau.cancelDurableRun(runId);
        const cleanedUpExplicitly = outcome.status === 'requested';

        harnessB.registerDurableRun(runId);
        await harnessB.close();
        harnessA.registerDurableRun(runId, { detached: true });
        await harnessA.close();
        return { discoverableAfterDetach, cleanedUpExplicitly };
      } finally {
        await ownedStorage.dispose();
      }
    },

    signalDelivery: () => Promise.resolve(unsupported('signal-delivery')),

    async recovery() {
      const { harnessA, runId, ownedStorage } = await startParkedRunOnA();
      try {
        const resuming = createResumingGenerate();
        const { harnessB } = await bootRecoveringHarnessB(
          ownedStorage.path as string,
          runId,
          (status) => status === 'completed',
          resuming.generate,
        );
        // Genuine resumption, not a from-scratch replay: step 0 was already
        // checkpointed by bureau A, so bureau B's OWN generate must never
        // be invoked with step 0.
        const recovered = !resuming.steps.includes(0) && resuming.steps.includes(1);

        harnessB.registerDurableRun(runId);
        await harnessB.close();
        harnessA.registerDurableRun(runId, { detached: true });
        await harnessA.close();
        return { recovered };
      } finally {
        await ownedStorage.dispose();
      }
    },

    async awaitableCleanup() {
      const { harnessA, runId, ownedStorage } = await startParkedRunOnA();
      try {
        const { harnessB } = await bootRecoveringHarnessB(
          ownedStorage.path as string,
          runId,
          (status) => status === 'completed',
        );
        harnessB.registerDurableRun(runId);
        const reportB = await harnessB.close();
        harnessA.registerDurableRun(runId, { detached: true });
        await harnessA.close();
        return { status: reportB.quiescent ? 'completed' : 'not-required' };
      } finally {
        await ownedStorage.dispose();
      }
    },

    async durableReconstruction() {
      const { harnessA, runId, ownedStorage } = await startParkedRunOnA();
      try {
        // Immediate half: bureau A's own public read of the workflow it is
        // still parked on, before bureau B ever boots.
        const immediate = await harnessA.reattachDurable(runId);
        const immediateStatus = immediate?.status ?? 'missing';

        const { harnessB } = await bootRecoveringHarnessB(
          ownedStorage.path as string,
          runId,
          (status) => status === 'completed',
        );
        // Reconstructed half: read back through `bureau.getDurableRun` on
        // an INDEPENDENTLY constructed Bureau — bureau A's own in-process
        // handle never advances this run past step 1 on its own.
        const reconstructed = await harnessB.reattachDurable(runId);
        const reconstructedStatus = reconstructed?.status ?? 'missing';

        harnessB.registerDurableRun(runId);
        await harnessB.close();
        harnessA.registerDurableRun(runId, { detached: true });
        await harnessA.close();
        return { runId, immediateStatus, reconstructedStatus };
      } finally {
        await ownedStorage.dispose();
      }
    },
  };
}
