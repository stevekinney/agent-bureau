/**
 * The Bureau durable adapter (AB-269): a real `Bureau` over
 * `createSqliteStorageFixture` with durable execution on (the default for a
 * persistent backend), one fresh instance per scenario, torn down through
 * `close()` (`assertBureauQuiescent`). Unlike `bureau-memory.ts` (AB-268),
 * this mode's checkpoints survive the `Bureau` instance itself — so it adds
 * `'detachment'`, `'signal-delivery'`, and `'durable-reconstruction'` on top
 * of everything `bureau-memory` already supports, all provable within ONE
 * process (no restart). `'independent-observers'` stays unsupported for the
 * identical reason as `bureau-memory` (AB-87 — `harness.startRun` returns
 * the same single-consumer `AgentRun`). `'recovery'` is left to
 * `bureau-recovered.ts`: proving a workflow's serialization/reattachment
 * logic needs a SECOND, independently-constructed `Bureau` reading the same
 * storage after the first is gone — object reconstruction this adapter,
 * with only one `Bureau` instance ever alive, cannot exercise (AB-96 names
 * `bureau-recovered.ts` as the deliverable that does).
 *
 * `'durable-reconstruction'` reads back a just-completed run's persisted
 * state through `bureau.getDurableRun` after dropping the `AgentRun` handle
 * that drove it — proving the read-back path works even without a restart,
 * the half `bureau-recovered.ts` cannot cheaply isolate from its own
 * restart machinery.
 */
import {
  createAgent,
  type GenerateFunction,
  type RunEvent,
  type RunnableAgent,
  type RuntimeServices,
  stopWhen,
} from '@lostgradient/operative';
import {
  createEventRecorder,
  createManualRuntimeServices,
  waitForCondition,
} from '@lostgradient/operative/test';
import { createToolbox } from 'armorer';
import type { AgentDefinitions, BureauOptions } from 'bureau';
import {
  type BureauTestHarness,
  createBureauTestHarness,
  createSqliteStorageFixture,
} from 'bureau/test';

import type { LifecycleCapability, LifecycleContractAdapter } from '../runner';
import {
  ABORT_EVENTS,
  attachLeg,
  createBlockingGenerate,
  createFailingGenerate,
  createInstantGenerate,
  createUnsupportedOutcomeFactory,
  driveRootSubtreeAbortPair,
  driveSiblingIsolationPair,
  observeReadyAndRunning,
  stableRunId,
  SUCCESS_EVENTS,
} from '../support';

const MODE = 'bureau-durable';
const UNSUPPORTED: Readonly<Partial<Record<LifecycleCapability, string>>> = {
  'independent-observers': 'AB-87',
  recovery: 'AB-96',
};
const unsupported = createUnsupportedOutcomeFactory(MODE, UNSUPPORTED);

function agent(
  runtime: RuntimeServices,
  name: string,
  generate: GenerateFunction = createInstantGenerate(),
): RunnableAgent {
  return createAgent({ generate, name, runtime });
}

/**
 * Builds one fresh `Bureau` over an OWNED `createSqliteStorageFixture` (its
 * own uniquely allocated temp path, disposed at teardown — no two scenarios
 * in this file ever share a path, so two durable adapters can run
 * concurrently in one file without interfering, per this issue's own
 * acceptance criterion). Extra `BureauOptions` fields (e.g. `humanInput`)
 * pass straight through, mirroring `support.ts`'s `withHarness` shape but
 * over a persistent backend instead of memory.
 */
async function withDurableHarness<D extends AgentDefinitions, TResult>(
  build: (runtime: RuntimeServices) => D,
  use: (harness: BureauTestHarness<D>) => Promise<TResult>,
  extra: Partial<Omit<BureauOptions<D>, 'agents' | 'runtime' | 'storage'>> = {},
): Promise<TResult> {
  const runtime = createManualRuntimeServices();
  const storage = createSqliteStorageFixture({ runtime });
  const harness = await createBureauTestHarness({
    agents: build(runtime),
    generate: createInstantGenerate(),
    toolbox: createToolbox([]),
    runtime,
    storage,
    durableExecution: true,
    ...extra,
  });
  try {
    return await use(harness);
  } finally {
    await harness.close();
  }
}

/** Drives `harness.startRun('p', ...)` to a terminal state (optionally aborting it while blocked) and captures its filtered event trace under `id` — `support.ts`'s `driveBureauSequential`, over a durable (sqlite) harness instead of memory. */
async function driveDurableSequential(
  build: (runtime: RuntimeServices) => AgentDefinitions,
  events: ReadonlySet<RunEvent['type']>,
  id: string,
  terminalEventType: RunEvent['type'],
  abort = false,
) {
  return withDurableHarness(build, async (harness) => {
    const run = harness.startRun('p', 'go');
    const recorder = createEventRecorder(harness.runtime);
    attachLeg(recorder, run, id, events);
    if (abort) run.abort('lifecycle-contract: targeted abort');
    const result = await run.result();
    // Await this scenario's OWN cleanup acknowledgment before returning —
    // required for a durable run specifically (verified: without it, the
    // harness-level `close()` that runs afterward reads the same run's
    // `closed()` too early and reports a false `activeRoots` leak). The
    // in-memory adapter's identical `driveBureauSequential` never needed
    // this extra call — that helper is unmodified and still passes — but
    // this file did not isolate WHY the durable path differs; treat the
    // extra `closed()` call here as a verified fix, not an explained one.
    await run.closed();
    return {
      finishReason: result.finishReason,
      hasError: result.error !== undefined,
      recorder,
      resourceKey: `run:${id}`,
      terminalEventType,
    };
  });
}

export function createBureauDurableAdapter(): LifecycleContractAdapter {
  return {
    mode: MODE,
    supports: (capability) => !(capability in UNSUPPORTED),
    stableIdentity: () =>
      withDurableHarness(
        (runtime) => ({ p: agent(runtime, 'p') }),
        async (harness) => {
          const run = harness.startRun('p', 'go');
          const firstId = await stableRunId(run);
          await run.result();
          return { firstId, secondId: run.snapshot().id };
        },
      ),
    async parentage() {
      return withDurableHarness(
        (runtime) => ({ p: agent(runtime, 'p'), c: agent(runtime, 'c') }),
        async (harness) => {
          const parentRun = harness.startRun('p', 'go');
          const parentId = await stableRunId(parentRun);
          const child = harness.startChild(parentId, 'c', 'go');
          await Promise.all([child.result(), parentRun.result()]);
          const [descriptor] = harness.childRegistry.children();
          return { parentId, childParentId: descriptor?.parentId ?? '' };
        },
      );
    },
    readyAndRunningState: () => {
      const blocking = createBlockingGenerate();
      return withDurableHarness(
        (runtime) => ({ p: agent(runtime, 'p', blocking.generate) }),
        (harness) => observeReadyAndRunning(harness.startRun('p', 'go'), blocking.release),
      );
    },
    terminalSuccess: () =>
      driveDurableSequential(
        (runtime) => ({ p: agent(runtime, 'p') }),
        SUCCESS_EVENTS,
        'success',
        'run.completed',
      ),
    terminalFailure: () =>
      driveDurableSequential(
        (runtime) => ({ p: agent(runtime, 'p', createFailingGenerate()) }),
        SUCCESS_EVENTS,
        'failure',
        'run.completed',
      ),
    independentObservers: () => Promise.resolve(unsupported('independent-observers')),
    idempotentResult: () =>
      withDurableHarness(
        (runtime) => ({ p: agent(runtime, 'p') }),
        async (harness) => {
          const run = harness.startRun('p', 'go');
          return { equal: (await run.result()) === (await run.result()) };
        },
      ),
    targetedAbort: () =>
      driveDurableSequential(
        (runtime) => ({ p: agent(runtime, 'p', createBlockingGenerate().generate) }),
        ABORT_EVENTS,
        'abort',
        'run.aborted',
        true,
      ),
    async rootSubtreeAbort() {
      return withDurableHarness(
        (runtime) => ({
          p: agent(runtime, 'p', createBlockingGenerate().generate),
          c: agent(runtime, 'c', createBlockingGenerate().generate),
        }),
        (harness) => {
          const rootController = new AbortController();
          const parentRun = harness.startRun('p', 'go', { signal: rootController.signal });
          return driveRootSubtreeAbortPair(
            harness.runtime,
            parentRun,
            () => stableRunId(parentRun),
            (parentId, signal) => harness.startChild(parentId, 'c', 'go', { signal }),
            rootController,
          );
        },
      );
    },
    async siblingIsolation() {
      return withDurableHarness(
        (runtime) => ({
          p: agent(runtime, 'p'),
          a: agent(runtime, 'a', createBlockingGenerate().generate),
          b: agent(runtime, 'b'),
        }),
        (harness) => {
          const parentRun = harness.startRun('p', 'go');
          return driveSiblingIsolationPair(
            harness.runtime,
            parentRun,
            () => stableRunId(parentRun),
            (parentId) => harness.startChild(parentId, 'a', 'go'),
            (parentId) => harness.startChild(parentId, 'b', 'go'),
          );
        },
      );
    },
    async detachment() {
      const blocking = createBlockingGenerate();
      return withDurableHarness(
        (runtime) => ({ p: agent(runtime, 'p', blocking.generate) }),
        async (harness) => {
          const run = harness.bureau.run('p', 'go');
          const runId = await stableRunId(run);
          // Detach: register on the harness's own scope as `detached: true`
          // (never auto-registered by `startRun`) instead of awaiting
          // `result()` — the deliberate abandonment AB-34's vocabulary
          // names, not a leak `assertBureauQuiescent` should flag.
          harness.scope.register({ kind: 'run', identifier: runId, run, detached: true });
          // The durable checkpoint for a just-dispatched workflow can lag
          // its in-process `AgentRun` handle settling by a macrotask or
          // two — poll (bounded, no wall-clock sleep) rather than assert
          // on the very first read.
          await waitForCondition(
            async () => (await harness.reattachDurable(runId)) != null,
            'bureau-durable: detachment never became discoverable through getDurableRun',
          );
          const discoverableAfterDetach = (await harness.reattachDurable(runId)) != null;
          // Cancel explicitly before the fixture closes, as the acceptance
          // criteria require, through the durable locator (never
          // `abortRun`, whose contract this scenario is not exercising).
          const outcome = await harness.bureau.cancelDurableRun(runId);
          const cleanedUpExplicitly = outcome.status === 'requested';
          return { discoverableAfterDetach, cleanedUpExplicitly };
        },
      );
    },
    async signalDelivery() {
      let callIndex = 0;
      const generate: GenerateFunction = async () => {
        const index = callIndex++;
        if (index === 0) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'requestHumanInput',
                arguments: { signalName: 'lifecycle-signal' },
              },
            ],
          };
        }
        return { content: 'signal delivered', toolCalls: [] };
      };
      return withDurableHarness(
        () => ({}),
        async (harness) => {
          const run = await harness.startSession({ message: 'go' });
          await waitForCondition(
            () =>
              harness.bureau
                .listPendingReviews()
                .some((review) => review.kind === 'human-wait' && review.runId === run.id),
            'bureau-durable: signalDelivery never parked on a human-wait',
          );
          await harness.deliverSignal(run.sessionId, 'lifecycle-signal', { ok: true });
          await waitForCondition(async () => {
            const session = await harness.bureau.getSession(run.sessionId);
            return session?.metadata['lastRunStatus'] !== 'running';
          }, 'bureau-durable: signalDelivery never resumed after signal delivery');
          const session = await harness.bureau.getSession(run.sessionId);
          return { delivered: session?.metadata['lastRunStatus'] === 'completed' };
        },
        {
          humanInput: true,
          generate,
          toolbox: createToolbox([]),
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        },
      );
    },
    recovery: () => Promise.resolve(unsupported('recovery')),
    awaitableCleanup: () =>
      withDurableHarness(
        (runtime) => ({ p: agent(runtime, 'p') }),
        async (harness) => {
          const run = harness.startRun('p', 'go');
          await run.result();
          const acknowledgement = await run.closed();
          return { status: acknowledgement.status };
        },
      ),
    async durableReconstruction() {
      return withDurableHarness(
        (runtime) => ({ p: agent(runtime, 'p') }),
        async (harness) => {
          const run = harness.startRun('p', 'go');
          const runId = await stableRunId(run);
          const result = await run.result();
          // The owning `AgentRun` handle is dropped here (never referenced
          // again below) — the reconstructed half reads back through the
          // public `bureau.getDurableRun` surface only.
          const reconstructed = await harness.reattachDurable(runId);
          return {
            runId,
            immediateStatus: result.finishReason,
            reconstructedStatus: reconstructed?.status ?? 'missing',
          };
        },
      );
    },
  };
}
