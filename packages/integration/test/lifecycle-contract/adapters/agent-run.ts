/**
 * The thin `AgentRun` adapter (AB-268): drives `createAgent(...).run(...)`,
 * a SINGLE-consumer iterable that throws `CompletedRunIterationError` on a
 * second iteration — `'independent-observers'` is unsupported (AB-87, its
 * recorded gap). `parentage`/`root-subtree-abort`/`sibling-isolation` ARE
 * supported via `children()`/`abortChild()` (`dispatchChildRun` + a
 * `ChildRunRegistry`, AB-50); a root-subtree abort composes one external
 * `AbortSignal` shared by the parent's `run()` and the child's
 * `dispatchChildRun`, since `AgentRun` exposes no getter for its own signal.
 * `'detachment'`/`'signal-delivery'`/`'recovery'` need a durable owner this
 * process-local mode never has (AB-269).
 */
import type {
  GenerateFunction,
  MutableChildRunRegistry,
  RuntimeServices,
} from '@lostgradient/operative';
import { createAgent, createChildRunRegistry } from '@lostgradient/operative';
import { createManualRuntimeServices } from '@lostgradient/operative/test';

import type { LifecycleCapability, LifecycleContractAdapter } from '../runner';
import {
  ABORT_EVENTS,
  createBlockingGenerate,
  createFailingGenerate,
  createTestAgent,
  createUnsupportedOutcomeFactory,
  dispatchTestChild,
  driveRootSubtreeAbortPair,
  driveSequential,
  driveSiblingIsolationPair,
  observeReadyAndRunning,
  scopeForRun,
  SUCCESS_EVENTS,
  withRun,
} from '../support';

const MODE = 'agent-run';
const UNSUPPORTED: Readonly<Partial<Record<LifecycleCapability, string>>> = {
  'independent-observers': 'AB-87',
  detachment: 'AB-269',
  'signal-delivery': 'AB-269',
  recovery: 'AB-269',
};
const unsupported = createUnsupportedOutcomeFactory(MODE, UNSUPPORTED);

const agent = (runtime: RuntimeServices, name: string, generate?: GenerateFunction) =>
  createTestAgent(createAgent, runtime, name, generate);
const child = (
  runtime: RuntimeServices,
  registry: MutableChildRunRegistry,
  parentId: string,
  name: string,
  generate?: GenerateFunction,
  signal?: AbortSignal,
) => dispatchTestChild(createAgent, runtime, registry, parentId, name, generate, signal);

export function createAgentRunAdapter(): LifecycleContractAdapter {
  return {
    mode: MODE,
    supports: (capability) => !(capability in UNSUPPORTED),

    stableIdentity: () =>
      withRun(
        'stableIdentity',
        (runtime) => agent(runtime, 'p').run('go'),
        async (run) => {
          const firstId = run.snapshot().id;
          await run.result();
          return { firstId, secondId: run.snapshot().id };
        },
      ),

    async parentage() {
      const runtime = createManualRuntimeServices();
      const registry = createChildRunRegistry();
      const parentRun = agent(runtime, 'parent').run('go', { childRegistry: registry });
      const scope = scopeForRun('parentage', runtime, parentRun);
      const parentId = parentRun.snapshot().id;
      const childRun = child(runtime, registry, parentId, 'child');
      await Promise.all([childRun.result(), parentRun.result()]);
      await scope.close();
      const [descriptor] = registry.children();
      return { parentId, childParentId: descriptor?.parentId ?? '' };
    },

    readyAndRunningState: () => {
      const blocking = createBlockingGenerate();
      return withRun(
        'readyAndRunningState',
        (runtime) => agent(runtime, 'p', blocking.generate).run('go'),
        (run) => observeReadyAndRunning(run, blocking.release),
      );
    },

    terminalSuccess: () =>
      driveSequential(
        (runtime) => agent(runtime, 'p').run('go'),
        SUCCESS_EVENTS,
        'success',
        'run.completed',
      ),
    terminalFailure: () =>
      driveSequential(
        (runtime) => agent(runtime, 'p', createFailingGenerate()).run('go'),
        SUCCESS_EVENTS,
        'failure',
        'run.completed',
      ),
    independentObservers: () => Promise.resolve(unsupported('independent-observers')),

    idempotentResult: () =>
      withRun(
        'idempotentResult',
        (runtime) => agent(runtime, 'p').run('go'),
        async (run) => ({ equal: (await run.result()) === (await run.result()) }),
      ),

    targetedAbort: () =>
      driveSequential(
        (runtime) => agent(runtime, 'p', createBlockingGenerate().generate).run('go'),
        ABORT_EVENTS,
        'abort',
        'run.aborted',
        true,
      ),

    async rootSubtreeAbort() {
      const runtime = createManualRuntimeServices();
      const registry = createChildRunRegistry();
      const rootController = new AbortController();
      const parentRun = agent(runtime, 'parent', createBlockingGenerate().generate).run('go', {
        childRegistry: registry,
        signal: rootController.signal,
      });
      return driveRootSubtreeAbortPair(
        runtime,
        parentRun,
        () => parentRun.snapshot().id,
        (parentId, signal) =>
          child(runtime, registry, parentId, 'child', createBlockingGenerate().generate, signal),
        rootController,
      );
    },

    async siblingIsolation() {
      const runtime = createManualRuntimeServices();
      const registry = createChildRunRegistry();
      const parentRun = agent(runtime, 'parent').run('go', { childRegistry: registry });
      return driveSiblingIsolationPair(
        runtime,
        parentRun,
        () => parentRun.snapshot().id,
        (parentId) => child(runtime, registry, parentId, 'a', createBlockingGenerate().generate),
        (parentId) => child(runtime, registry, parentId, 'b'),
      );
    },

    detachment: () => Promise.resolve(unsupported('detachment')),
    signalDelivery: () => Promise.resolve(unsupported('signal-delivery')),
    recovery: () => Promise.resolve(unsupported('recovery')),

    awaitableCleanup: () =>
      withRun(
        'awaitableCleanup',
        (runtime) => agent(runtime, 'p').run('go'),
        async (run) => {
          await run.result();
          const acknowledgement = await run.closed();
          return { status: acknowledgement.status };
        },
      ),
  };
}
