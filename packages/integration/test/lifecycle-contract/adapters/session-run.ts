/**
 * The session adapter (AB-268): a process-local `SessionHandle` (no
 * `engine`). Its `run()` returns an `AgentRun`, so `'independent-observers'`
 * is unsupported (AB-87, same as `agent-run.ts`). `parentage`/`root-subtree-abort`/
 * `sibling-isolation` reuse `dispatchChildRun`, wired through the session's
 * constant `runOptions.childRegistry`/`signal`. `'detachment'`/`'signal-delivery'`/
 * `'recovery'` need a durable engine this session never has (AB-269).
 */
import {
  createAgent,
  createChildRunRegistry,
  createSessionHandle,
  createSessionStore,
  type GenerateFunction,
  type MutableChildRunRegistry,
  type RuntimeServices,
  type SessionHandle,
  stopWhen,
} from '@lostgradient/operative';
import { createManualRuntimeServices } from '@lostgradient/operative/test';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { createToolbox } from 'armorer';

import type { LifecycleCapability, LifecycleContractAdapter } from '../runner';
import {
  ABORT_EVENTS,
  createBlockingGenerate,
  createFailingGenerate,
  createInstantGenerate,
  createUnsupportedOutcomeFactory,
  dispatchTestChild,
  driveRootSubtreeAbortPair,
  driveSequential,
  driveSiblingIsolationPair,
  observeReadyAndRunning,
  scopeForRun,
  stableRunId,
  SUCCESS_EVENTS,
  withRun,
} from '../support';

const MODE = 'session-run';
const UNSUPPORTED: Readonly<Partial<Record<LifecycleCapability, string>>> = {
  'independent-observers': 'AB-87',
  detachment: 'AB-269',
  'signal-delivery': 'AB-269',
  recovery: 'AB-269',
};
const unsupported = createUnsupportedOutcomeFactory(MODE, UNSUPPORTED);

/** A fresh process-local `SessionHandle` — no `engine`, matching `session-handle.test.ts`'s own baseline fixture. */
function makeSession(
  runtime: RuntimeServices,
  name: string,
  generate: GenerateFunction = createInstantGenerate(),
  extra: { childRegistry?: MutableChildRunRegistry; signal?: AbortSignal } = {},
): SessionHandle {
  const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
  return createSessionHandle(runtime.identifiers.next('session'), {
    store,
    agentName: name,
    runtime,
    runOptions: {
      generate,
      toolbox: createToolbox([]),
      stopWhen: stopWhen.noToolCalls(),
      ...extra,
    },
  });
}
/** A parent-role session run, sharing `registry` and (when supplied) `signal` — every scenario that dispatches children under a session's root run builds it this way. */
function parentSession(
  runtime: RuntimeServices,
  registry: MutableChildRunRegistry,
  generate?: GenerateFunction,
  signal?: AbortSignal,
) {
  return makeSession(runtime, 'parent', generate, {
    childRegistry: registry,
    ...(signal ? { signal } : {}),
  }).run('go');
}
/** A child agent dispatched under the session's root run — a session's children are ordinary in-process agent runs, not nested sessions. */
function child(
  runtime: RuntimeServices,
  registry: MutableChildRunRegistry,
  parentId: string,
  name: string,
  generate?: GenerateFunction,
  signal?: AbortSignal,
) {
  return dispatchTestChild(createAgent, runtime, registry, parentId, name, generate, signal);
}

export function createSessionRunAdapter(): LifecycleContractAdapter {
  return {
    mode: MODE,
    supports: (capability) => !(capability in UNSUPPORTED),
    stableIdentity: () =>
      withRun(
        'stableIdentity',
        (runtime) => makeSession(runtime, 'p').run('go'),
        async (run) => {
          const firstId = await stableRunId(run);
          await run.result();
          return { firstId, secondId: run.snapshot().id };
        },
      ),
    async parentage() {
      const runtime = createManualRuntimeServices();
      const registry = createChildRunRegistry();
      const parentRun = parentSession(runtime, registry);
      const scope = scopeForRun('parentage', runtime, parentRun);
      const parentId = await stableRunId(parentRun);
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
        (runtime) => makeSession(runtime, 'p', blocking.generate).run('go'),
        (run) => observeReadyAndRunning(run, blocking.release),
      );
    },
    terminalSuccess: () =>
      driveSequential(
        (runtime) => makeSession(runtime, 'p').run('go'),
        SUCCESS_EVENTS,
        'success',
        'run.completed',
      ),
    terminalFailure: () =>
      driveSequential(
        (runtime) => makeSession(runtime, 'p', createFailingGenerate()).run('go'),
        SUCCESS_EVENTS,
        'failure',
        'run.completed',
      ),
    independentObservers: () => Promise.resolve(unsupported('independent-observers')),
    idempotentResult: () =>
      withRun(
        'idempotentResult',
        (runtime) => makeSession(runtime, 'p').run('go'),
        async (run) => ({ equal: (await run.result()) === (await run.result()) }),
      ),
    targetedAbort: () =>
      driveSequential(
        (runtime) => makeSession(runtime, 'p', createBlockingGenerate().generate).run('go'),
        ABORT_EVENTS,
        'abort',
        'run.aborted',
        true,
      ),
    async rootSubtreeAbort() {
      const runtime = createManualRuntimeServices();
      const registry = createChildRunRegistry();
      const rootController = new AbortController();
      const blocking = createBlockingGenerate().generate;
      const parentRun = parentSession(runtime, registry, blocking, rootController.signal);
      return driveRootSubtreeAbortPair(
        runtime,
        parentRun,
        () => stableRunId(parentRun),
        (parentId, signal) =>
          child(runtime, registry, parentId, 'child', createBlockingGenerate().generate, signal),
        rootController,
      );
    },
    async siblingIsolation() {
      const runtime = createManualRuntimeServices();
      const registry = createChildRunRegistry();
      const parentRun = parentSession(runtime, registry);
      return driveSiblingIsolationPair(
        runtime,
        parentRun,
        () => stableRunId(parentRun),
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
        (runtime) => makeSession(runtime, 'p').run('go'),
        async (run) => {
          await run.result();
          const acknowledgement = await run.closed();
          return { status: acknowledgement.status };
        },
      ),
  };
}
