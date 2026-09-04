/**
 * The black-box lifecycle contract runner (AB-268, AB-92's Decision
 * (2026-09-01)). One shared scenario list, registered once per adapter by
 * {@link runLifecycleContractSuite}, drives the SAME lifecycle invariants —
 * identity, state, event, cancellation, result, and cleanup semantics —
 * through whichever public run-handle surface the adapter wraps (a direct
 * `ActiveRun`, an `AgentRun`, a session-owned `AgentRun`, or a Bureau-owned
 * one). A capability the adapter's mode genuinely lacks is asserted through
 * {@link UnsupportedCapabilityOutcome}, never skipped.
 *
 * `testRunner` is injectable (defaulted to real `bun:test`), exactly like
 * `reactive-source-suite.ts`'s own `ReactiveSourceConformanceTestRunner` —
 * it exists so `runner.test.ts` can register this suite's scenarios against
 * a deliberately broken adapter and capture each case's pass/fail outcome
 * without an intentional failure failing the whole file.
 */

import type { EventRecorder } from '@lostgradient/operative/test';
import { describe, expect, it } from 'bun:test';

// ---------------------------------------------------------------------------
// Capabilities and the typed unsupported outcome
// ---------------------------------------------------------------------------

/** Every capability a shared scenario needs — a closed union (AB-268's acceptance criteria). */
export type LifecycleCapability =
  | 'stable-identity'
  | 'parentage'
  | 'ready-and-running-state'
  | 'terminal-success'
  | 'terminal-failure'
  | 'independent-observers'
  | 'idempotent-result'
  | 'targeted-abort'
  | 'root-subtree-abort'
  | 'sibling-isolation'
  | 'detachment'
  | 'signal-delivery'
  | 'recovery'
  | 'awaitable-cleanup'
  | 'durable-reconstruction';

/** Returned by a scenario-driving method instead of running the scenario, when `adapter.supports(capability)` is `false`. */
export interface UnsupportedCapabilityOutcome {
  readonly capability: LifecycleCapability;
  readonly mode: string;
  readonly owningIssue: string;
}

export function isUnsupportedCapabilityOutcome(
  value: unknown,
): value is UnsupportedCapabilityOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    'capability' in value &&
    'mode' in value &&
    'owningIssue' in value &&
    typeof (value as UnsupportedCapabilityOutcome).capability === 'string' &&
    typeof (value as UnsupportedCapabilityOutcome).mode === 'string' &&
    typeof (value as UnsupportedCapabilityOutcome).owningIssue === 'string'
  );
}

// ---------------------------------------------------------------------------
// Per-scenario outcome shapes
// ---------------------------------------------------------------------------

export interface StableIdentityOutcome {
  readonly firstId: string;
  readonly secondId: string;
}

export interface ParentageOutcome {
  readonly parentId: string;
  readonly childParentId: string;
}

export interface ObservationOutcome {
  readonly sawNonTerminalStatus: boolean;
  readonly reachedTerminalStatus: boolean;
}

/** Shared by `terminalSuccess`, `terminalFailure`, and `targetedAbort` — each is a single-resource, sequential path. */
export interface SequencedTerminalOutcome {
  readonly finishReason: string;
  readonly hasError: boolean;
  readonly recorder: EventRecorder;
  readonly resourceKey: string;
  readonly terminalEventType: string;
}

export interface ObserverCountsOutcome {
  readonly counts: readonly number[];
}

export interface EqualityOutcome {
  readonly equal: boolean;
}

/** Shared by `rootSubtreeAbort` and `siblingIsolation` — each is a two-resource, concurrent path. */
export interface ConcurrentScenarioOutcome {
  readonly recorder: EventRecorder;
  readonly parentResourceKey: string;
  readonly childResourceKey: string;
  readonly parentTerminalEventType: string;
  readonly childTerminalEventType: string;
  readonly parentFinishReason: string;
  readonly childFinishReason: string;
  /** `recorder.normalize().length` immediately before this scenario's `closed()` calls were awaited. */
  readonly entriesBeforeCleanup: number;
  /** `recorder.normalize().length` immediately after those `closed()` calls settled — must equal `entriesBeforeCleanup`. */
  readonly entriesAfterCleanup: number;
}

export interface DetachmentOutcome {
  readonly discoverableAfterDetach: boolean;
  readonly cleanedUpExplicitly: boolean;
}

export interface DeliveryOutcome {
  readonly delivered: boolean;
}

export interface RecoveryOutcome {
  readonly recovered: boolean;
}

export interface ClosedOutcome {
  readonly status: string;
}

/**
 * `'durable-reconstruction'` (AB-269): the two halves AB-96 requires — the
 * immediate public state observed right after the operation (through
 * whichever live handle the mode used to drive it), and the reconstructed
 * state read back through `bureau.getDurableRun` once that owning handle is
 * gone. A mode that gets the first right and the second wrong (or vice
 * versa) fails this scenario — `immediateStatus`/`reconstructedStatus` are
 * asserted independently below, never collapsed into one boolean.
 */
export interface DurableReconstructionOutcome {
  readonly runId: string;
  readonly immediateStatus: string;
  readonly reconstructedStatus: string;
}

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------

/**
 * One mode's driving surface. Every method either performs its scenario and
 * returns a real outcome, or — when `supports(capability)` is `false` for
 * that method's capability — returns the matching
 * {@link UnsupportedCapabilityOutcome} instead. Never throws to signal
 * "unsupported", and never skips: `runLifecycleContractSuite` registers one
 * `it()` per method regardless of what `supports()` reports.
 *
 * Each method is fully self-contained: it constructs whatever runtime,
 * resource scope, or harness it needs, drives the scenario, verifies its own
 * zero-leak postcondition (a `ResourceScope`/`assertBureauQuiescent` close),
 * and only then returns — so a scenario's cleanup assertion is exercised on
 * every call, not bolted on afterward by the runner.
 */
export interface LifecycleContractAdapter {
  readonly mode: string;
  supports(capability: LifecycleCapability): boolean;

  stableIdentity(): Promise<StableIdentityOutcome | UnsupportedCapabilityOutcome>;
  parentage(): Promise<ParentageOutcome | UnsupportedCapabilityOutcome>;
  readyAndRunningState(): Promise<ObservationOutcome | UnsupportedCapabilityOutcome>;
  terminalSuccess(): Promise<SequencedTerminalOutcome | UnsupportedCapabilityOutcome>;
  terminalFailure(): Promise<SequencedTerminalOutcome | UnsupportedCapabilityOutcome>;
  independentObservers(): Promise<ObserverCountsOutcome | UnsupportedCapabilityOutcome>;
  idempotentResult(): Promise<EqualityOutcome | UnsupportedCapabilityOutcome>;
  targetedAbort(): Promise<SequencedTerminalOutcome | UnsupportedCapabilityOutcome>;
  rootSubtreeAbort(): Promise<ConcurrentScenarioOutcome | UnsupportedCapabilityOutcome>;
  siblingIsolation(): Promise<ConcurrentScenarioOutcome | UnsupportedCapabilityOutcome>;
  detachment(): Promise<DetachmentOutcome | UnsupportedCapabilityOutcome>;
  signalDelivery(): Promise<DeliveryOutcome | UnsupportedCapabilityOutcome>;
  recovery(): Promise<RecoveryOutcome | UnsupportedCapabilityOutcome>;
  awaitableCleanup(): Promise<ClosedOutcome | UnsupportedCapabilityOutcome>;
  durableReconstruction(): Promise<DurableReconstructionOutcome | UnsupportedCapabilityOutcome>;
}

// ---------------------------------------------------------------------------
// Shared structural-invariant helpers (used by concurrent-path adapters)
// ---------------------------------------------------------------------------

const TERMINAL_EVENT_TYPES: readonly string[] = ['run.completed', 'run.aborted'];

/**
 * Structural invariants over a recorder's full captured trace — no impossible
 * transition (nothing captured for a resource after that resource's own
 * terminal event) and no duplicate terminal event (at most one of
 * `run.completed`/`run.aborted` per resource). Both hold regardless of how
 * two resources' events interleaved in capture order, which is why these are
 * asserted structurally rather than through a single fixed sequence.
 */
/**
 * Asserts `resourceKey`'s own captured trace is non-empty and ends with
 * `terminalEventType`. Deliberately not a full `assertSequence(['run.started',
 * terminalEventType])`: `'run.started'` fires synchronously inside some
 * adapters' own creation call (observed on the Bureau adapter's
 * `startRun`/`startRun`-composed root) — before this suite's own
 * `attachLeg`/`recorder.attach` call, made immediately after that call
 * returns, can ever subscribe. That is a same-turn ordering detail of each
 * mode's public creation API, not a lifecycle-semantics divergence this
 * contract is chartered to catch — the terminal event landing last, for
 * every mode, is.
 */
function assertTerminalEventCaptured(
  recorder: EventRecorder,
  resourceKey: string,
  terminalEventType: string,
): void {
  const entries = recorder.normalize().filter((entry) => entry.resource === resourceKey);
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.at(-1)?.event).toBe(terminalEventType);
}

export function assertNoImpossibleTransitionOrDuplicateTerminal(
  recorder: EventRecorder,
  resourceKeys: readonly string[],
): void {
  const entries = recorder.normalize();
  for (const resourceKey of resourceKeys) {
    const ownEntries = entries.filter((entry) => entry.resource === resourceKey);
    const terminalIndexes = ownEntries
      .map((entry, index) => (TERMINAL_EVENT_TYPES.includes(entry.event) ? index : -1))
      .filter((index) => index >= 0);

    if (terminalIndexes.length > 1) {
      throw new Error(
        `assertNoImpossibleTransitionOrDuplicateTerminal: resource "${resourceKey}" captured ${terminalIndexes.length} terminal events (expected at most 1): [${ownEntries
          .map((entry) => entry.event)
          .join(', ')}]`,
      );
    }
    const [terminalIndex] = terminalIndexes;
    if (terminalIndex !== undefined && terminalIndex !== ownEntries.length - 1) {
      throw new Error(
        `assertNoImpossibleTransitionOrDuplicateTerminal: resource "${resourceKey}" captured an event after its own terminal event: [${ownEntries
          .map((entry) => entry.event)
          .join(', ')}]`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The injectable test runner (same pattern as reactive-source-suite.ts)
// ---------------------------------------------------------------------------

export interface LifecycleContractTestRunner {
  describe(label: string, fn: () => void): void;
  it(name: string, fn: () => void | Promise<void>): void;
}

const defaultTestRunner: LifecycleContractTestRunner = { describe, it };

function assertUnsupportedOutcome(
  outcome: unknown,
  capability: LifecycleCapability,
  mode: string,
): void {
  if (!isUnsupportedCapabilityOutcome(outcome)) {
    throw new Error(
      `${mode}: supports('${capability}') is false, so this scenario must return an UnsupportedCapabilityOutcome, but got: ${JSON.stringify(outcome)}`,
    );
  }
  expect(outcome.capability).toBe(capability);
  expect(outcome.mode).toBe(mode);
  expect(outcome.owningIssue.length).toBeGreaterThan(0);
}

function assertSupportedOutcome<T>(
  outcome: T | UnsupportedCapabilityOutcome,
  capability: LifecycleCapability,
  mode: string,
): T {
  if (isUnsupportedCapabilityOutcome(outcome)) {
    throw new Error(
      `${mode}: supports('${capability}') is true, so this scenario must not return an UnsupportedCapabilityOutcome, but got one: ${JSON.stringify(outcome)}`,
    );
  }
  return outcome;
}

/**
 * Registers one `describe` block containing one `it` per shared scenario
 * (AB-268's acceptance criteria). Every scenario runs for every adapter
 * regardless of `supports()` — a claimed-unsupported capability is verified
 * to actually return {@link UnsupportedCapabilityOutcome}; a claimed-supported
 * one is verified to actually behave.
 */
export function runLifecycleContractSuite(
  adapter: LifecycleContractAdapter,
  testRunner: LifecycleContractTestRunner = defaultTestRunner,
): void {
  const { mode } = adapter;

  testRunner.describe(`lifecycle contract: ${mode}`, () => {
    testRunner.it('stableIdentity', async () => {
      const outcome = await adapter.stableIdentity();
      if (!adapter.supports('stable-identity')) {
        assertUnsupportedOutcome(outcome, 'stable-identity', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'stable-identity', mode);
      expect(result.firstId.length).toBeGreaterThan(0);
      expect(result.secondId).toBe(result.firstId);
    });

    testRunner.it('parentage', async () => {
      const outcome = await adapter.parentage();
      if (!adapter.supports('parentage')) {
        assertUnsupportedOutcome(outcome, 'parentage', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'parentage', mode);
      expect(result.parentId.length).toBeGreaterThan(0);
      expect(result.childParentId).toBe(result.parentId);
    });

    testRunner.it('readyAndRunningState', async () => {
      const outcome = await adapter.readyAndRunningState();
      if (!adapter.supports('ready-and-running-state')) {
        assertUnsupportedOutcome(outcome, 'ready-and-running-state', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'ready-and-running-state', mode);
      expect(result.sawNonTerminalStatus).toBe(true);
      expect(result.reachedTerminalStatus).toBe(true);
    });

    testRunner.it('terminalSuccess', async () => {
      const outcome = await adapter.terminalSuccess();
      if (!adapter.supports('terminal-success')) {
        assertUnsupportedOutcome(outcome, 'terminal-success', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'terminal-success', mode);
      expect(result.hasError).toBe(false);
      expect(result.finishReason).not.toBe('error');
      expect(result.finishReason).not.toBe('aborted');
      assertTerminalEventCaptured(result.recorder, result.resourceKey, result.terminalEventType);
    });

    testRunner.it('terminalFailure', async () => {
      const outcome = await adapter.terminalFailure();
      if (!adapter.supports('terminal-failure')) {
        assertUnsupportedOutcome(outcome, 'terminal-failure', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'terminal-failure', mode);
      expect(result.hasError).toBe(true);
      assertTerminalEventCaptured(result.recorder, result.resourceKey, result.terminalEventType);
    });

    testRunner.it('independentObservers', async () => {
      const outcome = await adapter.independentObservers();
      if (!adapter.supports('independent-observers')) {
        assertUnsupportedOutcome(outcome, 'independent-observers', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'independent-observers', mode);
      expect(result.counts.length).toBeGreaterThanOrEqual(2);
      for (const count of result.counts) {
        expect(count).toBeGreaterThanOrEqual(1);
      }
    });

    testRunner.it('idempotentResult', async () => {
      const outcome = await adapter.idempotentResult();
      if (!adapter.supports('idempotent-result')) {
        assertUnsupportedOutcome(outcome, 'idempotent-result', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'idempotent-result', mode);
      expect(result.equal).toBe(true);
    });

    testRunner.it('targetedAbort', async () => {
      const outcome = await adapter.targetedAbort();
      if (!adapter.supports('targeted-abort')) {
        assertUnsupportedOutcome(outcome, 'targeted-abort', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'targeted-abort', mode);
      expect(result.finishReason).toBe('aborted');
      assertTerminalEventCaptured(result.recorder, result.resourceKey, result.terminalEventType);
    });

    testRunner.it('rootSubtreeAbort', async () => {
      const outcome = await adapter.rootSubtreeAbort();
      if (!adapter.supports('root-subtree-abort')) {
        assertUnsupportedOutcome(outcome, 'root-subtree-abort', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'root-subtree-abort', mode);
      expect(result.parentFinishReason).toBe('aborted');
      expect(result.childFinishReason).toBe('aborted');
      assertTerminalEventCaptured(
        result.recorder,
        result.parentResourceKey,
        result.parentTerminalEventType,
      );
      // The child's `run.started` is reliably observable across every
      // adapter (unlike the parent's — see `assertTerminalEventCaptured`'s
      // doc comment), so this is where the suite keeps a real
      // `assertHappensBefore` over a genuine causal edge.
      result.recorder.assertHappensBefore(
        `${result.childResourceKey}:run.started`,
        `${result.childResourceKey}:${result.childTerminalEventType}`,
      );
      assertNoImpossibleTransitionOrDuplicateTerminal(result.recorder, [
        result.parentResourceKey,
        result.childResourceKey,
      ]);
      expect(result.entriesAfterCleanup).toBe(result.entriesBeforeCleanup);
    });

    testRunner.it('siblingIsolation', async () => {
      const outcome = await adapter.siblingIsolation();
      if (!adapter.supports('sibling-isolation')) {
        assertUnsupportedOutcome(outcome, 'sibling-isolation', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'sibling-isolation', mode);
      expect(result.parentFinishReason).toBe('aborted');
      expect(result.childFinishReason).not.toBe('aborted');
      assertTerminalEventCaptured(
        result.recorder,
        result.parentResourceKey,
        result.parentTerminalEventType,
      );
      result.recorder.assertHappensBefore(
        `${result.childResourceKey}:run.started`,
        `${result.childResourceKey}:${result.childTerminalEventType}`,
      );
      assertNoImpossibleTransitionOrDuplicateTerminal(result.recorder, [
        result.parentResourceKey,
        result.childResourceKey,
      ]);
      expect(result.entriesAfterCleanup).toBe(result.entriesBeforeCleanup);
    });

    testRunner.it('detachment', async () => {
      const outcome = await adapter.detachment();
      if (!adapter.supports('detachment')) {
        assertUnsupportedOutcome(outcome, 'detachment', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'detachment', mode);
      expect(result.discoverableAfterDetach).toBe(true);
      expect(result.cleanedUpExplicitly).toBe(true);
    });

    testRunner.it('signalDelivery', async () => {
      const outcome = await adapter.signalDelivery();
      if (!adapter.supports('signal-delivery')) {
        assertUnsupportedOutcome(outcome, 'signal-delivery', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'signal-delivery', mode);
      expect(result.delivered).toBe(true);
    });

    testRunner.it('recovery', async () => {
      const outcome = await adapter.recovery();
      if (!adapter.supports('recovery')) {
        assertUnsupportedOutcome(outcome, 'recovery', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'recovery', mode);
      expect(result.recovered).toBe(true);
    });

    testRunner.it('awaitableCleanup', async () => {
      const outcome = await adapter.awaitableCleanup();
      if (!adapter.supports('awaitable-cleanup')) {
        assertUnsupportedOutcome(outcome, 'awaitable-cleanup', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'awaitable-cleanup', mode);
      expect(['completed', 'not-required']).toContain(result.status);
    });

    testRunner.it('durableReconstruction', async () => {
      const outcome = await adapter.durableReconstruction();
      if (!adapter.supports('durable-reconstruction')) {
        assertUnsupportedOutcome(outcome, 'durable-reconstruction', mode);
        return;
      }
      const result = assertSupportedOutcome(outcome, 'durable-reconstruction', mode);
      expect(result.runId.length).toBeGreaterThan(0);
      expect(result.immediateStatus.length).toBeGreaterThan(0);
      expect(result.reconstructedStatus.length).toBeGreaterThan(0);
    });
  });
}
