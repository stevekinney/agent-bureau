/**
 * The Bureau in-memory adapter (AB-268): a real `Bureau` over
 * `createMemoryStorageFixture`, one fresh instance per scenario via
 * `createBureauTestHarness` (AB-262), torn down through `close()`
 * (`assertBureauQuiescent`, AB-262/tst-03c — the zero-leak check the other
 * three adapters get from `ResourceScope` instead). `harness.startRun`
 * returns the same single-consumer `AgentRun` as `agent-run.ts`, so
 * `'independent-observers'` is unsupported (AB-87). `parentage`/
 * `root-subtree-abort`/`sibling-isolation` use `harness.startChild` and its
 * own `childRegistry`. `'detachment'` needs a genuinely detached durable run
 * and `'signal-delivery'` a real session wired to a durable engine — neither
 * built here; both, with `'recovery'`, are left to AB-269. Every catalog
 * agent shares the SAME `ManualRuntimeServices` later handed to
 * `createBureauTestHarness` as `runtime`, keeping the suite deterministic.
 */
import {
  createAgent,
  type GenerateFunction,
  type RunnableAgent,
  type RuntimeServices,
} from '@lostgradient/operative';

import type { LifecycleCapability, LifecycleContractAdapter } from '../runner';
import {
  ABORT_EVENTS,
  createBlockingGenerate,
  createFailingGenerate,
  createInstantGenerate,
  createUnsupportedOutcomeFactory,
  driveBureauSequential,
  driveRootSubtreeAbortPair,
  driveSiblingIsolationPair,
  observeReadyAndRunning,
  stableRunId,
  SUCCESS_EVENTS,
  withHarness,
} from '../support';

const MODE = 'bureau-memory';
const UNSUPPORTED: Readonly<Partial<Record<LifecycleCapability, string>>> = {
  'independent-observers': 'AB-87',
  detachment: 'AB-269',
  'signal-delivery': 'AB-269',
  recovery: 'AB-269',
  // No scenario exercises this yet — AB-269 owns it (see agent-run.ts).
  'durable-reconstruction': 'AB-269',
};
const unsupported = createUnsupportedOutcomeFactory(MODE, UNSUPPORTED);

function agent(
  runtime: RuntimeServices,
  name: string,
  generate: GenerateFunction = createInstantGenerate(),
): RunnableAgent {
  return createAgent({ generate, name, runtime });
}

export function createBureauMemoryAdapter(): LifecycleContractAdapter {
  return {
    mode: MODE,
    supports: (capability) => !(capability in UNSUPPORTED),
    stableIdentity: () =>
      withHarness(
        (runtime) => ({ p: agent(runtime, 'p') }),
        async (harness) => {
          const run = harness.startRun('p', 'go');
          const firstId = await stableRunId(run);
          await run.result();
          return { firstId, secondId: run.snapshot().id };
        },
      ),
    async parentage() {
      return withHarness(
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
      return withHarness(
        (runtime) => ({ p: agent(runtime, 'p', blocking.generate) }),
        (harness) => observeReadyAndRunning(harness.startRun('p', 'go'), blocking.release),
      );
    },
    terminalSuccess: () =>
      driveBureauSequential(
        (runtime) => ({ p: agent(runtime, 'p') }),
        SUCCESS_EVENTS,
        'success',
        'run.completed',
      ),
    terminalFailure: () =>
      driveBureauSequential(
        (runtime) => ({ p: agent(runtime, 'p', createFailingGenerate()) }),
        SUCCESS_EVENTS,
        'failure',
        'run.completed',
      ),
    independentObservers: () => Promise.resolve(unsupported('independent-observers')),
    idempotentResult: () =>
      withHarness(
        (runtime) => ({ p: agent(runtime, 'p') }),
        async (harness) => {
          const run = harness.startRun('p', 'go');
          return { equal: (await run.result()) === (await run.result()) };
        },
      ),
    targetedAbort: () =>
      driveBureauSequential(
        (runtime) => ({ p: agent(runtime, 'p', createBlockingGenerate().generate) }),
        ABORT_EVENTS,
        'abort',
        'run.aborted',
        true,
      ),
    async rootSubtreeAbort() {
      return withHarness(
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
      return withHarness(
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
    detachment: () => Promise.resolve(unsupported('detachment')),
    signalDelivery: () => Promise.resolve(unsupported('signal-delivery')),
    recovery: () => Promise.resolve(unsupported('recovery')),
    awaitableCleanup: () =>
      withHarness(
        (runtime) => ({ p: agent(runtime, 'p') }),
        async (harness) => {
          const run = harness.startRun('p', 'go');
          await run.result();
          const acknowledgement = await run.closed();
          return { status: acknowledgement.status };
        },
      ),
    durableReconstruction: () => Promise.resolve(unsupported('durable-reconstruction')),
  };
}
