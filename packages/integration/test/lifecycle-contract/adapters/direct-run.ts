/**
 * The direct `ActiveRun` adapter (AB-268): drives `createActiveRun`
 * directly (`create-run.ts:93`), the one run-handle shape with
 * `addEventListener`/`on`/`once`/`subscribe`/`toObservable` —
 * `'independent-observers'`' surface, which `AgentRun`'s single-consumer
 * iterator cannot satisfy (see `agent-run.ts`). `ActiveRun` has no
 * child-dispatch surface (that is `AgentRun.children()`, backed by
 * `dispatchChildRun`, which takes a `RunnableAgent`), so `'parentage'`,
 * `'root-subtree-abort'`, `'sibling-isolation'` are unsupported (AB-50, the
 * capability `agent-run.ts`/`bureau-memory.ts` DO support);
 * `'detachment'`/`'signal-delivery'` need a durable owner this process-local
 * mode never has; `'recovery'` needs the excluded durable adapters (AB-269).
 * Every scenario runs through `withRun`, which registers `run` on a
 * `ResourceScope` and closes it in a `finally` — even a scenario whose own
 * assertion throws still releases the run.
 */
import type { ActiveRun, RuntimeServices } from '@lostgradient/operative';
import { createActiveRun, stopWhen } from '@lostgradient/operative';
import { createEventRecorder } from '@lostgradient/operative/test';
import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

import type { LifecycleCapability, LifecycleContractAdapter } from '../runner';
import {
  createBlockingGenerate,
  createFailingGenerate,
  createInstantGenerate,
  createUnsupportedOutcomeFactory,
  withRun,
} from '../support';

const MODE = 'direct-run';
const UNSUPPORTED: Readonly<Partial<Record<LifecycleCapability, string>>> = {
  parentage: 'AB-50',
  'root-subtree-abort': 'AB-50',
  'sibling-isolation': 'AB-50',
  detachment: 'AB-269',
  'signal-delivery': 'AB-269',
  recovery: 'AB-269',
  // No scenario exercises this yet — AB-269 owns it (see agent-run.ts).
  'durable-reconstruction': 'AB-269',
};
const unsupported = createUnsupportedOutcomeFactory(MODE, UNSUPPORTED);

function makeRun(
  runtime: RuntimeServices,
  generateOverride?: Parameters<typeof createActiveRun>[0]['generate'],
): ActiveRun {
  return createActiveRun({
    generate: generateOverride ?? createInstantGenerate(),
    toolbox: createToolbox([]),
    conversation: new Conversation(),
    stopWhen: stopWhen.noToolCalls(),
    runtime,
  });
}

export function createDirectRunAdapter(): LifecycleContractAdapter {
  return {
    mode: MODE,
    supports: (capability) => !(capability in UNSUPPORTED),

    stableIdentity: () =>
      withRun(
        'stableIdentity',
        (runtime) => makeRun(runtime),
        async (run) => {
          const firstId = run.snapshot().id;
          await run.result;
          return { firstId, secondId: run.snapshot().id };
        },
      ),

    parentage: () => Promise.resolve(unsupported('parentage')),

    readyAndRunningState: () => {
      const blocking = createBlockingGenerate();
      return withRun(
        'readyAndRunningState',
        (runtime) => makeRun(runtime, blocking.generate),
        async (run) => {
          const observed: string[] = [run.snapshot().status];
          const subscription = run.subscribeSnapshot((snapshot) => observed.push(snapshot.status));
          // Deterministic, no wall-clock sleep: yields until the run's own
          // microtask chain reaches the (blocked) generate call.
          for (let attempt = 0; attempt < 50 && run.snapshot().status !== 'running'; attempt++) {
            await Promise.resolve();
          }
          observed.push(run.snapshot().status);
          blocking.release();
          await run.result;
          observed.push(run.snapshot().status);
          subscription.unsubscribe();
          return {
            sawNonTerminalStatus: observed.includes('running'),
            reachedTerminalStatus: observed.at(-1) === 'terminal',
          };
        },
      );
    },

    terminalSuccess: () =>
      withRun(
        'terminalSuccess',
        (runtime) => makeRun(runtime),
        async (run, runtime) => {
          const recorder = createEventRecorder(runtime);
          recorder.attach(run, { kind: 'run', id: 'success' }, ['run.started', 'run.completed']);
          const result = await run.result;
          return {
            finishReason: result.finishReason,
            hasError: result.error !== undefined,
            recorder,
            resourceKey: 'run:success',
            terminalEventType: 'run.completed',
          };
        },
      ),

    terminalFailure: () =>
      withRun(
        'terminalFailure',
        (runtime) => makeRun(runtime, createFailingGenerate()),
        async (run, runtime) => {
          const recorder = createEventRecorder(runtime);
          recorder.attach(run, { kind: 'run', id: 'failure' }, ['run.started', 'run.completed']);
          const result = await run.result;
          return {
            finishReason: result.finishReason,
            hasError: result.error !== undefined,
            recorder,
            resourceKey: 'run:failure',
            terminalEventType: 'run.completed',
          };
        },
      ),

    independentObservers: () =>
      withRun(
        'independentObservers',
        (runtime) => makeRun(runtime),
        async (run) => {
          let countA = 0;
          let countB = 0;
          run.addEventListener('run.completed', () => (countA += 1));
          run.addEventListener('run.completed', () => (countB += 1));
          await run.result;
          return { counts: [countA, countB] };
        },
      ),

    idempotentResult: () =>
      withRun(
        'idempotentResult',
        (runtime) => makeRun(runtime),
        async (run) => ({ equal: (await run.result) === (await run.result) }),
      ),

    targetedAbort: () =>
      withRun(
        'targetedAbort',
        (runtime) => makeRun(runtime, createBlockingGenerate().generate),
        async (run, runtime) => {
          const recorder = createEventRecorder(runtime);
          recorder.attach(run, { kind: 'run', id: 'abort' }, ['run.started', 'run.aborted']);
          run.abort('lifecycle-contract: targeted abort');
          const result = await run.result;
          return {
            finishReason: result.finishReason,
            hasError: result.error !== undefined,
            recorder,
            resourceKey: 'run:abort',
            terminalEventType: 'run.aborted',
          };
        },
      ),

    rootSubtreeAbort: () => Promise.resolve(unsupported('root-subtree-abort')),
    siblingIsolation: () => Promise.resolve(unsupported('sibling-isolation')),
    detachment: () => Promise.resolve(unsupported('detachment')),
    signalDelivery: () => Promise.resolve(unsupported('signal-delivery')),
    recovery: () => Promise.resolve(unsupported('recovery')),

    awaitableCleanup: () =>
      withRun(
        'awaitableCleanup',
        (runtime) => makeRun(runtime),
        async (run) => {
          await run.result;
          const acknowledgement = await run.closed();
          return { status: acknowledgement.status };
        },
      ),
    durableReconstruction: () => Promise.resolve(unsupported('durable-reconstruction')),
  };
}
