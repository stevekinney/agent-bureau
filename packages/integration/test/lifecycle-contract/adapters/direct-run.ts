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
 */
import type { ActiveRun } from '@lostgradient/operative';
import { createActiveRun, stopWhen } from '@lostgradient/operative';
import { createEventRecorder, createManualRuntimeServices } from '@lostgradient/operative/test';
import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

import type { LifecycleCapability, LifecycleContractAdapter } from '../runner';
import {
  createBlockingGenerate,
  createFailingGenerate,
  createInstantGenerate,
  createUnsupportedOutcomeFactory,
  scopeForRun,
} from '../support';

const MODE = 'direct-run';
const UNSUPPORTED: Readonly<Partial<Record<LifecycleCapability, string>>> = {
  parentage: 'AB-50',
  'root-subtree-abort': 'AB-50',
  'sibling-isolation': 'AB-50',
  detachment: 'AB-269',
  'signal-delivery': 'AB-269',
  recovery: 'AB-269',
};
const unsupported = createUnsupportedOutcomeFactory(MODE, UNSUPPORTED);

function makeRun(
  runtime: ReturnType<typeof createManualRuntimeServices>,
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

    async stableIdentity() {
      const runtime = createManualRuntimeServices();
      const run = makeRun(runtime);
      const scope = scopeForRun('stableIdentity', runtime, run);
      const firstId = run.snapshot().id;
      await run.result;
      const secondId = run.snapshot().id;
      await scope.close();
      return { firstId, secondId };
    },

    parentage: () => Promise.resolve(unsupported('parentage')),

    async readyAndRunningState() {
      const runtime = createManualRuntimeServices();
      const blocking = createBlockingGenerate();
      const run = makeRun(runtime, blocking.generate);
      const scope = scopeForRun('readyAndRunningState', runtime, run);
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
      await scope.close();
      return {
        sawNonTerminalStatus: observed.some((status) => status !== 'terminal'),
        reachedTerminalStatus: observed.at(-1) === 'terminal',
      };
    },

    async terminalSuccess() {
      const runtime = createManualRuntimeServices();
      const run = makeRun(runtime);
      const recorder = createEventRecorder(runtime);
      recorder.attach(run, { kind: 'run', id: 'success' }, ['run.started', 'run.completed']);
      const scope = scopeForRun('terminalSuccess', runtime, run);
      const result = await run.result;
      await scope.close();
      return {
        finishReason: result.finishReason,
        hasError: result.error !== undefined,
        recorder,
        resourceKey: 'run:success',
        terminalEventType: 'run.completed',
      };
    },

    async terminalFailure() {
      const runtime = createManualRuntimeServices();
      const run = makeRun(runtime, createFailingGenerate());
      const recorder = createEventRecorder(runtime);
      recorder.attach(run, { kind: 'run', id: 'failure' }, ['run.started', 'run.completed']);
      const scope = scopeForRun('terminalFailure', runtime, run);
      const result = await run.result;
      await scope.close();
      return {
        finishReason: result.finishReason,
        hasError: result.error !== undefined,
        recorder,
        resourceKey: 'run:failure',
        terminalEventType: 'run.completed',
      };
    },

    async independentObservers() {
      const runtime = createManualRuntimeServices();
      const run = makeRun(runtime);
      const scope = scopeForRun('independentObservers', runtime, run);
      let countA = 0;
      let countB = 0;
      run.addEventListener('run.completed', () => (countA += 1));
      run.addEventListener('run.completed', () => (countB += 1));
      await run.result;
      await scope.close();
      return { counts: [countA, countB] };
    },

    async idempotentResult() {
      const runtime = createManualRuntimeServices();
      const run = makeRun(runtime);
      const scope = scopeForRun('idempotentResult', runtime, run);
      const first = await run.result;
      const second = await run.result;
      await scope.close();
      return { equal: first === second };
    },

    async targetedAbort() {
      const runtime = createManualRuntimeServices();
      const blocking = createBlockingGenerate();
      const run = makeRun(runtime, blocking.generate);
      const recorder = createEventRecorder(runtime);
      recorder.attach(run, { kind: 'run', id: 'abort' }, ['run.started', 'run.aborted']);
      const scope = scopeForRun('targetedAbort', runtime, run);
      run.abort('lifecycle-contract: targeted abort');
      const result = await run.result;
      await scope.close();
      return {
        finishReason: result.finishReason,
        hasError: result.error !== undefined,
        recorder,
        resourceKey: 'run:abort',
        terminalEventType: 'run.aborted',
      };
    },

    rootSubtreeAbort: () => Promise.resolve(unsupported('root-subtree-abort')),
    siblingIsolation: () => Promise.resolve(unsupported('sibling-isolation')),
    detachment: () => Promise.resolve(unsupported('detachment')),
    signalDelivery: () => Promise.resolve(unsupported('signal-delivery')),
    recovery: () => Promise.resolve(unsupported('recovery')),

    async awaitableCleanup() {
      const runtime = createManualRuntimeServices();
      const run = makeRun(runtime);
      const scope = scopeForRun('awaitableCleanup', runtime, run);
      await run.result;
      const acknowledgement = await run.closed();
      await scope.close();
      return { status: acknowledgement.status };
    },
  };
}
