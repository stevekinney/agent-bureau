/**
 * Self-test for `runner.ts` (AB-268), following `reactive-source-suite.test.ts`'s
 * pattern: a conforming in-memory fixture proves the suite passes for real,
 * then one deliberately broken variant per capability (plus two proving the
 * typed-unsupported-outcome contract itself, in both directions) proves the
 * suite actually catches its own violations — through a capturing
 * `LifecycleContractTestRunner` so an intentional failure never fails this
 * file itself.
 *
 * Test-driven per this issue's testing plan: written and passing against
 * this fixture BEFORE any of the four real adapters exist.
 */

import { createEventRecorder, createManualRuntimeServices } from '@lostgradient/operative/test';
import { describe, expect, it } from 'bun:test';

import type {
  ClosedOutcome,
  ConcurrentScenarioOutcome,
  DeliveryOutcome,
  DetachmentOutcome,
  DurableReconstructionOutcome,
  EqualityOutcome,
  LifecycleCapability,
  LifecycleContractAdapter,
  LifecycleContractTestRunner,
  ObservationOutcome,
  ObserverCountsOutcome,
  ParentageOutcome,
  RecoveryOutcome,
  SequencedTerminalOutcome,
  StableIdentityOutcome,
  UnsupportedCapabilityOutcome,
} from './runner';
import { runLifecycleContractSuite } from './runner';

// ---------------------------------------------------------------------------
// A minimal fake event source `EventRecorder.attach` can subscribe to.
// ---------------------------------------------------------------------------

interface FakeRunEventMap {
  'run.started': Event;
  'run.completed': Event;
  'run.aborted': Event;
}

function createFakeEventSource(): {
  addEventListener<K extends keyof FakeRunEventMap>(
    type: K,
    listener: (event: FakeRunEventMap[K]) => void,
  ): void;
  emit(type: keyof FakeRunEventMap): void;
} {
  const target = new EventTarget();
  return {
    addEventListener: (type, listener) => {
      target.addEventListener(type, listener as EventListener);
    },
    emit: (type) => {
      target.dispatchEvent(new Event(type));
    },
  };
}

let nextId = 0;
function freshId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

// ---------------------------------------------------------------------------
// The conforming baseline fixture — every method behaves correctly.
// ---------------------------------------------------------------------------

const MODE = 'fake';

function unsupported(capability: LifecycleCapability): UnsupportedCapabilityOutcome {
  return { capability, mode: MODE, owningIssue: 'AB-000' };
}

function createBaselineAdapter(
  overrides: Partial<LifecycleContractAdapter> = {},
): LifecycleContractAdapter {
  const baseline: LifecycleContractAdapter = {
    mode: MODE,
    supports: () => true,

    async stableIdentity(): Promise<StableIdentityOutcome> {
      const id = freshId('run');
      return { firstId: id, secondId: id };
    },

    async parentage(): Promise<ParentageOutcome> {
      const parentId = freshId('parent');
      return { parentId, childParentId: parentId };
    },

    async readyAndRunningState(): Promise<ObservationOutcome> {
      return { sawNonTerminalStatus: true, reachedTerminalStatus: true };
    },

    async terminalSuccess(): Promise<SequencedTerminalOutcome> {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const source = createFakeEventSource();
      const resourceKey = 'run:success';
      recorder.attach(source, { kind: 'run', id: 'success' }, ['run.started', 'run.completed']);
      source.emit('run.started');
      source.emit('run.completed');
      return {
        finishReason: 'stop-condition',
        hasError: false,
        recorder,
        resourceKey,
        terminalEventType: 'run.completed',
      };
    },

    async terminalFailure(): Promise<SequencedTerminalOutcome> {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const source = createFakeEventSource();
      const resourceKey = 'run:failure';
      recorder.attach(source, { kind: 'run', id: 'failure' }, ['run.started', 'run.completed']);
      source.emit('run.started');
      source.emit('run.completed');
      return {
        finishReason: 'error',
        hasError: true,
        recorder,
        resourceKey,
        terminalEventType: 'run.completed',
      };
    },

    async independentObservers(): Promise<ObserverCountsOutcome> {
      return { counts: [1, 1] };
    },

    async idempotentResult(): Promise<EqualityOutcome> {
      return { equal: true };
    },

    async targetedAbort(): Promise<SequencedTerminalOutcome> {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const source = createFakeEventSource();
      const resourceKey = 'run:abort';
      recorder.attach(source, { kind: 'run', id: 'abort' }, ['run.started', 'run.aborted']);
      source.emit('run.started');
      source.emit('run.aborted');
      return {
        finishReason: 'aborted',
        hasError: true,
        recorder,
        resourceKey,
        terminalEventType: 'run.aborted',
      };
    },

    async rootSubtreeAbort(): Promise<ConcurrentScenarioOutcome> {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const parentSource = createFakeEventSource();
      const childSource = createFakeEventSource();
      recorder.attach(parentSource, { kind: 'run', id: 'root-parent' }, [
        'run.started',
        'run.aborted',
      ]);
      recorder.attach(childSource, { kind: 'run', id: 'root-child' }, [
        'run.started',
        'run.aborted',
      ]);
      parentSource.emit('run.started');
      childSource.emit('run.started');
      parentSource.emit('run.aborted');
      childSource.emit('run.aborted');
      const entriesBeforeCleanup = recorder.normalize().length;
      const entriesAfterCleanup = recorder.normalize().length;
      return {
        recorder,
        parentResourceKey: 'run:root-parent',
        childResourceKey: 'run:root-child',
        parentTerminalEventType: 'run.aborted',
        childTerminalEventType: 'run.aborted',
        parentFinishReason: 'aborted',
        childFinishReason: 'aborted',
        entriesBeforeCleanup,
        entriesAfterCleanup,
      };
    },

    async siblingIsolation(): Promise<ConcurrentScenarioOutcome> {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const parentSource = createFakeEventSource();
      const siblingSource = createFakeEventSource();
      recorder.attach(parentSource, { kind: 'run', id: 'sib-parent' }, [
        'run.started',
        'run.aborted',
      ]);
      recorder.attach(siblingSource, { kind: 'run', id: 'sib-child' }, [
        'run.started',
        'run.completed',
      ]);
      parentSource.emit('run.started');
      siblingSource.emit('run.started');
      parentSource.emit('run.aborted');
      siblingSource.emit('run.completed');
      const entriesBeforeCleanup = recorder.normalize().length;
      const entriesAfterCleanup = recorder.normalize().length;
      return {
        recorder,
        parentResourceKey: 'run:sib-parent',
        childResourceKey: 'run:sib-child',
        parentTerminalEventType: 'run.aborted',
        childTerminalEventType: 'run.completed',
        parentFinishReason: 'aborted',
        childFinishReason: 'stop-condition',
        entriesBeforeCleanup,
        entriesAfterCleanup,
      };
    },

    async detachment(): Promise<DetachmentOutcome> {
      return { discoverableAfterDetach: true, cleanedUpExplicitly: true };
    },

    async signalDelivery(): Promise<DeliveryOutcome> {
      return { delivered: true };
    },

    async recovery(): Promise<RecoveryOutcome> {
      return { recovered: true };
    },

    async awaitableCleanup(): Promise<ClosedOutcome> {
      return { status: 'completed' };
    },

    async durableReconstruction(): Promise<DurableReconstructionOutcome> {
      const runId = freshId('run');
      return { runId, immediateStatus: 'running', reconstructedStatus: 'completed' };
    },
  };

  return { ...baseline, ...overrides };
}

// ---------------------------------------------------------------------------
// Positive self-test — the real describe/it, must pass for real.
// ---------------------------------------------------------------------------

describe('runLifecycleContractSuite: positive self-test', () => {
  runLifecycleContractSuite(createBaselineAdapter());
});

// ---------------------------------------------------------------------------
// Negative fixtures — a capturing test runner, one violation per capability.
// ---------------------------------------------------------------------------

interface CapturedCase {
  readonly name: string;
  readonly error: unknown;
}

function createCapturingTestRunner(): {
  readonly runner: LifecycleContractTestRunner;
  run(): Promise<CapturedCase[]>;
} {
  const registered: { name: string; fn: () => void | Promise<void> }[] = [];
  const runner: LifecycleContractTestRunner = {
    describe(_label, fn) {
      fn();
    },
    it(name, fn) {
      registered.push({ name, fn });
    },
  };
  return {
    runner,
    async run() {
      const results: CapturedCase[] = [];
      for (const { name, fn } of registered) {
        try {
          await fn();
          results.push({ name, error: undefined });
        } catch (error) {
          results.push({ name, error });
        }
      }
      return results;
    },
  };
}

async function runCapturingly(adapter: LifecycleContractAdapter): Promise<CapturedCase[]> {
  const { runner, run } = createCapturingTestRunner();
  runLifecycleContractSuite(adapter, runner);
  return run();
}

/** Asserts that exactly `failingCase` failed and every other case passed. */
function expectOnlyCaseFailed(results: CapturedCase[], failingCase: string): void {
  expect(results.some((result) => result.name === failingCase)).toBe(true);
  for (const result of results) {
    if (result.name === failingCase) {
      expect(result.error).toBeDefined();
    } else {
      expect(result.error).toBeUndefined();
    }
  }
}

it('fails only stableIdentity when the second id diverges', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      stableIdentity: async () => ({ firstId: 'a', secondId: 'b' }),
    }),
  );
  expectOnlyCaseFailed(results, 'stableIdentity');
});

it('fails only parentage when the child reports the wrong parent id', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      parentage: async () => ({ parentId: 'parent-x', childParentId: 'someone-else' }),
    }),
  );
  expectOnlyCaseFailed(results, 'parentage');
});

it('fails only readyAndRunningState when the running state is never observed', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      readyAndRunningState: async () => ({
        sawNonTerminalStatus: false,
        reachedTerminalStatus: true,
      }),
    }),
  );
  expectOnlyCaseFailed(results, 'readyAndRunningState');
});

it('fails only terminalSuccess when a completed run reports hasError', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      terminalSuccess: async () => {
        const runtime = createManualRuntimeServices();
        const recorder = createEventRecorder(runtime);
        const source = createFakeEventSource();
        recorder.attach(source, { kind: 'run', id: 'success' }, ['run.started', 'run.completed']);
        source.emit('run.started');
        source.emit('run.completed');
        return {
          finishReason: 'stop-condition',
          hasError: true,
          recorder,
          resourceKey: 'run:success',
          terminalEventType: 'run.completed',
        };
      },
    }),
  );
  expectOnlyCaseFailed(results, 'terminalSuccess');
});

it('fails only terminalFailure when the failed run never reports an error', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      terminalFailure: async () => {
        const runtime = createManualRuntimeServices();
        const recorder = createEventRecorder(runtime);
        const source = createFakeEventSource();
        recorder.attach(source, { kind: 'run', id: 'failure' }, ['run.started', 'run.completed']);
        source.emit('run.started');
        source.emit('run.completed');
        return {
          finishReason: 'error',
          hasError: false,
          recorder,
          resourceKey: 'run:failure',
          terminalEventType: 'run.completed',
        };
      },
    }),
  );
  expectOnlyCaseFailed(results, 'terminalFailure');
});

it('fails only independentObservers when only one observer is ever notified', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      independentObservers: async () => ({ counts: [1, 0] }),
    }),
  );
  expectOnlyCaseFailed(results, 'independentObservers');
});

it('fails only idempotentResult when repeated calls disagree', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      idempotentResult: async () => ({ equal: false }),
    }),
  );
  expectOnlyCaseFailed(results, 'idempotentResult');
});

it('fails only targetedAbort when the aborted run reports a non-aborted finish reason', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      targetedAbort: async () => {
        const runtime = createManualRuntimeServices();
        const recorder = createEventRecorder(runtime);
        const source = createFakeEventSource();
        recorder.attach(source, { kind: 'run', id: 'abort' }, ['run.started', 'run.aborted']);
        source.emit('run.started');
        source.emit('run.aborted');
        return {
          finishReason: 'stop-condition',
          hasError: false,
          recorder,
          resourceKey: 'run:abort',
          terminalEventType: 'run.aborted',
        };
      },
    }),
  );
  expectOnlyCaseFailed(results, 'targetedAbort');
});

it('fails only rootSubtreeAbort when the child survives the parent-subtree abort', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      rootSubtreeAbort: async () => {
        const runtime = createManualRuntimeServices();
        const recorder = createEventRecorder(runtime);
        const parentSource = createFakeEventSource();
        const childSource = createFakeEventSource();
        recorder.attach(parentSource, { kind: 'run', id: 'root-parent' }, [
          'run.started',
          'run.aborted',
        ]);
        recorder.attach(childSource, { kind: 'run', id: 'root-child' }, [
          'run.started',
          'run.completed',
        ]);
        parentSource.emit('run.started');
        childSource.emit('run.started');
        parentSource.emit('run.aborted');
        // BUG: the child keeps running instead of being aborted with its parent.
        childSource.emit('run.completed');
        const entries = recorder.normalize().length;
        return {
          recorder,
          parentResourceKey: 'run:root-parent',
          childResourceKey: 'run:root-child',
          parentTerminalEventType: 'run.aborted',
          childTerminalEventType: 'run.completed',
          parentFinishReason: 'aborted',
          childFinishReason: 'stop-condition',
          entriesBeforeCleanup: entries,
          entriesAfterCleanup: entries,
        };
      },
    }),
  );
  expectOnlyCaseFailed(results, 'rootSubtreeAbort');
});

it('fails only rootSubtreeAbort when an event is captured after the acknowledged cleanup', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      rootSubtreeAbort: async () => {
        const runtime = createManualRuntimeServices();
        const recorder = createEventRecorder(runtime);
        const parentSource = createFakeEventSource();
        const childSource = createFakeEventSource();
        recorder.attach(parentSource, { kind: 'run', id: 'root-parent' }, [
          'run.started',
          'run.aborted',
        ]);
        recorder.attach(childSource, { kind: 'run', id: 'root-child' }, [
          'run.started',
          'run.aborted',
        ]);
        parentSource.emit('run.started');
        childSource.emit('run.started');
        parentSource.emit('run.aborted');
        childSource.emit('run.aborted');
        const entriesBeforeCleanup = recorder.normalize().length;
        // BUG: something fires again after cleanup was supposedly acknowledged.
        parentSource.emit('run.aborted');
        const entriesAfterCleanup = recorder.normalize().length;
        return {
          recorder,
          parentResourceKey: 'run:root-parent',
          childResourceKey: 'run:root-child',
          parentTerminalEventType: 'run.aborted',
          childTerminalEventType: 'run.aborted',
          parentFinishReason: 'aborted',
          childFinishReason: 'aborted',
          entriesBeforeCleanup,
          entriesAfterCleanup,
        };
      },
    }),
  );
  expectOnlyCaseFailed(results, 'rootSubtreeAbort');
});

it('fails only siblingIsolation when the untouched sibling is aborted too', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      siblingIsolation: async () => {
        const runtime = createManualRuntimeServices();
        const recorder = createEventRecorder(runtime);
        const parentSource = createFakeEventSource();
        const siblingSource = createFakeEventSource();
        recorder.attach(parentSource, { kind: 'run', id: 'sib-parent' }, [
          'run.started',
          'run.aborted',
        ]);
        recorder.attach(siblingSource, { kind: 'run', id: 'sib-child' }, [
          'run.started',
          'run.aborted',
        ]);
        parentSource.emit('run.started');
        siblingSource.emit('run.started');
        parentSource.emit('run.aborted');
        // BUG: the sibling is aborted too, instead of being isolated from its sibling's abort.
        siblingSource.emit('run.aborted');
        const entries = recorder.normalize().length;
        return {
          recorder,
          parentResourceKey: 'run:sib-parent',
          childResourceKey: 'run:sib-child',
          parentTerminalEventType: 'run.aborted',
          childTerminalEventType: 'run.aborted',
          parentFinishReason: 'aborted',
          childFinishReason: 'aborted',
          entriesBeforeCleanup: entries,
          entriesAfterCleanup: entries,
        };
      },
    }),
  );
  expectOnlyCaseFailed(results, 'siblingIsolation');
});

it('fails only detachment when the detached run is not discoverable afterward', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      detachment: async () => ({ discoverableAfterDetach: false, cleanedUpExplicitly: true }),
    }),
  );
  expectOnlyCaseFailed(results, 'detachment');
});

it('fails only signalDelivery when the signal never reaches the run', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      signalDelivery: async () => ({ delivered: false }),
    }),
  );
  expectOnlyCaseFailed(results, 'signalDelivery');
});

it('fails only recovery when the recovered run is not observed', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      recovery: async () => ({ recovered: false }),
    }),
  );
  expectOnlyCaseFailed(results, 'recovery');
});

it('fails only awaitableCleanup when closed() never settles to a terminal status', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      awaitableCleanup: async () => ({ status: 'unresolved' }),
    }),
  );
  expectOnlyCaseFailed(results, 'awaitableCleanup');
});

it('fails only durableReconstruction when the run id is empty', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      durableReconstruction: async () => ({
        runId: '',
        immediateStatus: 'running',
        reconstructedStatus: 'completed',
      }),
    }),
  );
  expectOnlyCaseFailed(results, 'durableReconstruction');
});

// ---------------------------------------------------------------------------
// The typed-unsupported-outcome contract itself, both directions.
// ---------------------------------------------------------------------------

it('fails only parentage when supports() claims unsupported but the method returns a real outcome anyway', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      supports: (capability) => capability !== 'parentage',
      // BUG: still returns a real ParentageOutcome instead of the typed unsupported outcome.
      parentage: async () => ({ parentId: 'p', childParentId: 'p' }),
    }),
  );
  expectOnlyCaseFailed(results, 'parentage');
});

it('fails only terminalSuccess when supports() claims supported but the method returns the unsupported outcome anyway', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      // BUG: supports() says yes, but the method opts out anyway.
      terminalSuccess: async () => unsupported('terminal-success'),
    }),
  );
  expectOnlyCaseFailed(results, 'terminalSuccess');
});

it('passes every scenario when a capability is genuinely unsupported and the method returns the matching typed outcome', async () => {
  const results = await runCapturingly(
    createBaselineAdapter({
      supports: (capability) => capability !== 'recovery',
      recovery: async () => unsupported('recovery'),
    }),
  );
  for (const result of results) {
    expect(result.error).toBeUndefined();
  }
});
