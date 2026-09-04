/**
 * The deterministic Bureau test harness (AB-261 / AB-94's tst-03b child).
 *
 * `createBureauTestHarness` composes a real `Bureau` over an injected
 * `ManualRuntimeServices` and an owned `BureauStorageFixture`, resolving
 * only once `bureau.ready` is `true` and boot recovery has completed. It
 * exposes a small set of PUBLIC lifecycle drivers, each a thin wrapper over
 * the corresponding public `Bureau` method (or, for `startChild`, over
 * `Bureau.agents` plus operative's own public `dispatchChildRun` primitive —
 * AB-92's decision record notes child runs have "no standalone locator by
 * design" and that `dispatchChildRun` is deliberately not
 * `bureau.*`-namespaced, so the harness reaches the same guarantee through
 * Bureau's public catalog and operative's public started-work handle,
 * never through a private map or a raw Weft workflow handle).
 *
 * This module deliberately does NOT reimplement
 * `packages/operative/src/test/durable-multi-agent-harness.ts`. AB-92
 * labels that file an adapter suite that stays available for Weft adapter
 * tests; this harness reaches the same guarantees through `Bureau` and
 * started-work handles only.
 *
 * `close()` (AB-262) delegates to `Bureau.shutdown()` (AB-207) via
 * `assertBureauQuiescent` (`./quiescence.ts`) rather than reimplementing
 * shutdown-awaiting or leak detection here: this module's only quiescence
 * responsibility is exposing the PUBLIC bookkeeping `assertBureauQuiescent`
 * reads from — the `scope` every `startRun` root registers onto, and the
 * `childRegistry` every `startChild` dispatch registers into by default.
 *
 * Out of scope here (AB-261's original boundary, now narrowed by AB-262
 * landing the quiescence report): the reproduction-artifact assembler and
 * Bureau-scoped fault selectors (AB-263/tst-03d), and the packed-consumer
 * extension (AB-264/tst-03e). Drivers for product surfaces that do not
 * exist yet on this baseline (managed goals — AB-101/AB-102 — and settled
 * scheduler-task retrieval — AB-180) are named as unsupported through
 * `supports()` and a typed throw, never silently stubbed out.
 */
import type {
  AgentInput,
  ChildRunHandle,
  DispatchChildRunOptions,
  MutableChildRunRegistry,
} from '@lostgradient/operative';
import { createChildRunRegistry, dispatchChildRun } from '@lostgradient/operative';
import {
  createResourceScope,
  type ResourceScope,
  waitForCondition,
} from '@lostgradient/operative/test';
import type { ScheduleSummary, WorkflowState } from '@lostgradient/weft';
import type { ManualRuntimeServices } from 'lifecycle';
import { createManualRuntimeServices } from 'lifecycle';

import type { AgentDefinitions, AgentNames, AgentRunForName } from '../agent-catalog';
import { createBureau, detachBestEffortPromise } from '../create-bureau';
import type {
  Bureau,
  BureauOptions,
  BureauRunOptions,
  BureauShutdownOptions,
  CreateRunRequest,
  DurableScheduleDefinition,
  ResolveReviewInput,
  ResolveReviewResult,
  RunSummary,
  SubmitSchedulerTaskRequest,
  SubmitSchedulerTaskResponse,
} from '../types';
import type { BureauQuiescenceReport } from './quiescence';
import { assertBureauQuiescent, BureauQuiescenceError } from './quiescence';
import type { BureauStorageFixture } from './storage-fixtures';

/**
 * A durable run this harness was told to track for quiescence purposes
 * (AB-262), keyed by `bureau.getDurableRun`'s own `runId` — never a
 * process-local handle. `detached: true` means the test deliberately
 * abandoned this run's cleanup (per AB-34's detachment vocabulary): a real,
 * recorded outcome `assertBureauQuiescent` reports under `detached` rather
 * than a leak, NOT a way to hide one — the run must still resolve through
 * `bureau.getDurableRun` after the harness closes for the record to count.
 */
export interface DurableRunRegistration {
  readonly runId: string;
  readonly detached: boolean;
}

/**
 * Product surfaces this harness cannot drive because Bureau has no shipped
 * capability for them yet. Deliberately just these two — a driver for
 * anything else on the eight-driver list above is expected to work, never
 * to be silently skipped.
 */
export type BureauHarnessCapability = 'managed-goal' | 'scheduler-task-result';

const UNSUPPORTED_CAPABILITY_OWNERS: Readonly<Record<BureauHarnessCapability, readonly string[]>> =
  {
    'managed-goal': ['AB-101', 'AB-102'],
    'scheduler-task-result': ['AB-180'],
  };

/**
 * Thrown by a harness driver for a {@link BureauHarnessCapability} that
 * `supports()` reports `false` for. Never thrown for a capability this
 * harness actually drives — those either succeed or propagate Bureau's own
 * error.
 */
export class BureauHarnessUnsupportedError extends Error {
  readonly capability: BureauHarnessCapability;
  readonly owningIssues: readonly string[];

  constructor(capability: BureauHarnessCapability) {
    const owningIssues = UNSUPPORTED_CAPABILITY_OWNERS[capability];
    super(
      `Bureau test harness driver for "${capability}" is not supported: this product surface ` +
        `does not exist on the current baseline yet (see ${owningIssues.join(', ')}).`,
    );
    this.name = 'BureauHarnessUnsupportedError';
    this.capability = capability;
    this.owningIssues = owningIssues;
  }
}

/**
 * Options for {@link createBureauTestHarness}. Every `BureauOptions` field
 * other than `runtime`/`storage` is forwarded verbatim — `agents` remains
 * required, matching `BureauOptions` itself.
 */
export interface BureauTestHarnessOptions<
  D extends AgentDefinitions = AgentDefinitions,
> extends Omit<BureauOptions<D>, 'runtime' | 'storage'> {
  /**
   * Defaults to a freshly constructed, fully independent
   * `createManualRuntimeServices()` instance when omitted — never a shared
   * default, so two harnesses constructed without an explicit `runtime`
   * still get independent clocks, timers, and identifier sequences.
   */
  runtime?: ManualRuntimeServices;
  /** The owned storage fixture backing this harness's Bureau. */
  storage: BureauStorageFixture;
}

/**
 * A real `Bureau`, its composed `ManualRuntimeServices`, its owned
 * `BureauStorageFixture`, and a thin set of public lifecycle drivers.
 */
export interface BureauTestHarness<D extends AgentDefinitions = AgentDefinitions> {
  readonly bureau: Bureau<D>;
  readonly runtime: ManualRuntimeServices;
  readonly storage: BureauStorageFixture;

  /**
   * The `ResourceScope` (operative's test kit, AB-256) every `startRun`
   * root registers onto as it is dispatched. Exposed PUBLICLY so a test can
   * also register a timer or listener directly (`scope.register({kind:
   * 'timer', ... })`) to exercise a deliberate leak — `assertBureauQuiescent`
   * reads this scope, never a private registration list.
   */
  readonly scope: ResourceScope;

  /**
   * The `MutableChildRunRegistry` (AB-50) every `startChild` dispatch
   * registers into by default (a caller-supplied `options.registry`
   * overrides this per call). `assertBureauQuiescent`'s `activeDescendants`
   * row reads this registry's own public `children()` listing.
   */
  readonly childRegistry: MutableChildRunRegistry;

  /**
   * Durable runs this harness has been told to track for quiescence
   * (AB-262) — see `registerDurableRun`. A public, read-only snapshot;
   * never a private `Map`.
   */
  readonly durableRegistrations: readonly DurableRunRegistration[];

  /**
   * Records a durable run id for `assertBureauQuiescent`'s `durableAttempts`
   * row to check via `bureau.getDurableRun` once the harness closes. Pass
   * `detached: true` to record this run as a deliberate detachment (AB-34)
   * rather than a leak — `assertBureauQuiescent` never abandons tracking it
   * silently either way; a detached run must still resolve through
   * `bureau.getDurableRun` after `close()` for the detachment to count as a
   * real, recorded outcome.
   */
  registerDurableRun(runId: string, options?: { readonly detached?: boolean }): void;

  /**
   * Delegates to `bureau.shutdown(shutdownOptions)` (AB-207) via
   * `assertBureauQuiescent`, then disposes the storage fixture, then
   * resolves with the report — or rejects with a {@link
   * BureauQuiescenceError} carrying it when anything Bureau owns was not
   * quiescent. Never calls `bureau.dispose()` as a substitute for
   * `shutdown()`, and never resolves before the shutdown report does.
   * Idempotent: a second call returns (or rethrows) the exact same outcome
   * without shutting down twice (a second call's own `shutdownOptions`
   * argument, if any, is ignored — matching `Bureau.shutdown()`'s own
   * idempotency contract, where the FIRST call's options are what actually
   * ran).
   *
   * When `shutdownOptions.timeoutMilliseconds` is set (a bounded policy),
   * this ALSO owns advancing this harness's `ManualRuntimeServices` by
   * exactly that many milliseconds (Coordinator ruling on AB-338):
   * `BureauOptions.shutdownTimeoutSleep` stays driven by the resolved
   * runtime — the deterministic contract AB-260 established — but a
   * `ManualRuntimeServices` never advances on its own, so nothing would
   * ever fire that sleep's timer, and a bounded `shutdown()` would hang
   * forever, unless something here does. A caller never needs to advance
   * the clock itself to observe a bounded drain resolve.
   */
  close(shutdownOptions?: BureauShutdownOptions): Promise<BureauQuiescenceReport>;

  /** Thin wrapper over `Bureau.run` — catalog-agent dispatch. */
  startRun<TName extends AgentNames<D>>(
    name: TName,
    input: AgentInput,
    options?: BureauRunOptions,
  ): AgentRunForName<D, TName>;

  /** Thin wrapper over `Bureau.createRun` — the session/durable-execution entry point. */
  startSession(request: CreateRunRequest): Promise<RunSummary>;

  /**
   * Dispatches a child run correlated to `parentRunId` through Bureau's own
   * agent catalog (`bureau.agents.find`) and operative's public
   * `dispatchChildRun` primitive — the same primitive `createSubagentTool`
   * itself is built on. Throws synchronously when `agentName` names no
   * catalog entry.
   */
  startChild(
    parentRunId: string,
    agentName: string,
    input: AgentInput,
    options?: Omit<DispatchChildRunOptions, 'parentRunId' | 'agentName'>,
  ): ChildRunHandle<unknown, boolean>;

  /** Thin wrapper over `Bureau.submitSchedulerTask`. */
  submitSchedulerTask(request: SubmitSchedulerTaskRequest): Promise<SubmitSchedulerTaskResponse>;

  /** Thin wrapper over `Bureau.createSchedule`. */
  createRecurringSchedule(
    definition: DurableScheduleDefinition,
  ): Promise<ScheduleSummary | undefined>;

  /** Thin wrapper over `Bureau.resolveReview`. */
  resolveReview(input: ResolveReviewInput): Promise<ResolveReviewResult>;

  /** Thin wrapper over `Bureau.signalSession` — the signal-wait lifecycle surface. */
  deliverSignal(sessionId: string, name: string, payload?: unknown): Promise<void>;

  /** Thin wrapper over `Bureau.getDurableRun`. */
  reattachDurable(runId: string): Promise<WorkflowState | null | undefined>;

  /** `false` for every {@link BureauHarnessCapability} — see the module doc. */
  supports(capability: BureauHarnessCapability): boolean;

  /**
   * Throws {@link BureauHarnessUnsupportedError} for `'managed-goal'` —
   * managed goals do not exist on this baseline (AB-101/AB-102).
   */
  startManagedGoal(...args: unknown[]): never;

  /**
   * Throws {@link BureauHarnessUnsupportedError} for
   * `'scheduler-task-result'` — settled scheduler-task results have no
   * resolvable locator on this baseline (AB-180).
   */
  getSchedulerTaskResult(taskId: string): never;
}

/**
 * Bounded, event-driven wait for `bureau.ready` — `createBureau` already
 * awaits its own recovery barrier before resolving on the common path
 * (no deferred gateway-authority recovery pending), so this settles on the
 * very first check in that case. It exists so the harness's own contract
 * ("resolves only after `bureau.ready` is `true` and boot recovery has
 * completed") holds even on the less common deferred-recovery path,
 * without asserting anything about `createBureau`'s internals. Bounded via
 * `waitForCondition`'s own macrotask-yield loop — never a real timer, never
 * a fixed wall-clock sleep.
 */
async function waitForBureauReady(bureau: Bureau<AgentDefinitions>): Promise<void> {
  await waitForCondition(
    () => bureau.ready,
    'Bureau test harness: bureau.ready never became true after boot recovery',
  );
}

function throwUnsupported(capability: BureauHarnessCapability): never {
  throw new BureauHarnessUnsupportedError(capability);
}

/**
 * Best-effort cleanup for {@link createBureauTestHarness}'s failure path:
 * disposes `disposable` (a no-op when `undefined` — `bureau` is only ever
 * assigned once `createBureau` has actually succeeded) and swallows a
 * disposal failure rather than replacing the ORIGINAL construction error
 * the caller is about to rethrow.
 */
async function disposeQuietly(disposable: { dispose(): Promise<void> } | undefined): Promise<void> {
  try {
    await disposable?.dispose();
  } catch {
    // Best-effort: the caller rethrows the original construction failure,
    // not whatever went wrong while cleaning up after it.
  }
}

/**
 * Constructs a real `Bureau` over deterministic runtime services and an
 * owned storage fixture, resolving only after `bureau.ready` is `true` and
 * boot recovery has completed.
 *
 * On failure — `createBureau` itself rejects, or `bureau.ready` never
 * settles true — this cleans up whatever it already constructed before
 * rethrowing: the storage fixture is disposed (releasing an
 * allocated-but-never-returned sqlite/lmdb path so it can't accumulate
 * under repeated failing test runs) and, if `createBureau` DID produce a
 * `Bureau` before the readiness wait failed, that bureau is disposed too.
 * A caller never receives a partially-constructed harness to clean up
 * itself.
 */
export async function createBureauTestHarness<D extends AgentDefinitions = AgentDefinitions>(
  options: BureauTestHarnessOptions<D>,
): Promise<BureauTestHarness<D>> {
  const { runtime: providedRuntime, storage, ...rest } = options;
  const runtime = providedRuntime ?? createManualRuntimeServices();

  let bureau: Bureau<D> | undefined;
  try {
    bureau = await createBureau<D>({
      ...(rest as BureauOptions<D>),
      runtime,
      storage: storage.configuration,
    });

    await waitForBureauReady(bureau as unknown as Bureau<AgentDefinitions>);
  } catch (error) {
    await disposeQuietly(bureau);
    await disposeQuietly(storage);
    throw error;
  }
  // `bureau` is definitely assigned here — the try block above either
  // assigns it before any throw, or the catch block rethrows first.
  const readyBureau = bureau;

  const scope = createResourceScope('bureau-harness', runtime);
  const childRegistry = createChildRunRegistry();
  const durableRegistrations: DurableRunRegistration[] = [];
  let closePromise: Promise<BureauQuiescenceReport> | undefined;

  const harness: BureauTestHarness<D> = {
    bureau: readyBureau,
    runtime,
    storage,
    scope,
    childRegistry,

    get durableRegistrations() {
      return durableRegistrations;
    },

    registerDurableRun(runId, registerOptions) {
      durableRegistrations.push({ runId, detached: registerOptions?.detached ?? false });
    },

    close(shutdownOptions) {
      if (!closePromise) {
        closePromise = (async () => {
          // Snapshotted BEFORE `assertBureauQuiescent` starts, so a timer
          // some OTHER composed subsystem already had armed (e.g. an
          // `idleDelay` that happens to equal `timeoutMilliseconds`) can
          // never be mistaken below for the timeout timer `shutdown()` is
          // about to arm.
          const preexistingTimerHandles = new Set(
            runtime.pendingTimers().map((timer) => timer.handle),
          );
          const reportPromise = assertBureauQuiescent(harness, shutdownOptions);

          const timeoutMilliseconds = shutdownOptions?.timeoutMilliseconds;
          if (timeoutMilliseconds !== undefined) {
            // AB-338: `bureau.shutdown()` arms its bounded-wait timer
            // synchronously, on THIS SAME runtime, the moment
            // `assertBureauQuiescent` calls it — but only after its own
            // pre-shutdown reads (webhook deliveries, durable
            // registrations) resolve, so the timer is not necessarily
            // armed yet on the very next tick. `pendingTimers()` never
            // drifts on its own under a `ManualRuntimeServices` (time only
            // moves via `advance()`/`setTime()`), so the exact `dueAt`
            // that timer will be armed with is computable up front —
            // waiting for a NEW timer at that PRECISE deadline (rather
            // than merely "any new timer") avoids a false match against an
            // unrelated timer some other composed subsystem arms in the
            // same window. `waitForCondition` yields via a real
            // `setTimeout(0)` macrotask between polls, never a wall-clock
            // wait tied to `timeoutMilliseconds` itself.
            //
            // A shutdown that never actually hangs settles this same
            // `reportPromise` entirely on microtasks, well within that
            // gap — and `shutdown()`'s own `chain.finally()` clears its
            // timeout timer the instant `chain` wins the race, so the
            // timer this loop is waiting for may never appear at all.
            // `reportSettled` is the other way out: once the report has
            // already resolved, there is nothing left to advance the
            // clock for, so this stops waiting for a timer that was
            // legitimately cleared rather than mistaking that for one
            // that was simply slow to arm.
            let reportSettled = false;
            // `detachBestEffortPromise` over a bare `void ... .finally(...)`
            // (same rationale as `create-bureau.ts`'s own uses of it): the
            // `.finally()` callback marks the flag on either outcome, and
            // wrapping the derived promise this way means a rejection
            // (`assertBureauQuiescent` is documented never to produce one,
            // but nothing here should rely on that to avoid an unhandled
            // rejection) is swallowed rather than surfaced twice — the
            // `await reportPromise` below is what actually re-observes it.
            detachBestEffortPromise(
              reportPromise.finally(() => {
                reportSettled = true;
              }),
            );
            const expectedDueAt = runtime.monotonic.now() + timeoutMilliseconds;
            await waitForCondition(
              () =>
                reportSettled ||
                runtime
                  .pendingTimers()
                  .some(
                    (timer) =>
                      timer.dueAt === expectedDueAt && !preexistingTimerHandles.has(timer.handle),
                  ),
              'BureauTestHarness.close(): the bounded shutdown timeout was never armed on the manual runtime',
            );
            if (!reportSettled) {
              await runtime.advance(timeoutMilliseconds);
            }
          }

          const report = await reportPromise;
          await storage.dispose();
          if (!report.quiescent) {
            throw new BureauQuiescenceError(report);
          }
          return report;
        })();
      }
      return closePromise;
    },

    startRun(name, input, runOptions) {
      const run = readyBureau.run(name, input, runOptions);
      scope.register({ kind: 'run', identifier: run.snapshot().id, run });
      return run;
    },

    startSession(request) {
      return readyBureau.createRun(request);
    },

    startChild(parentRunId, agentName, input, dispatchOptions) {
      const agent = readyBureau.agents.find(agentName);
      if (!agent) {
        throw new Error(`Bureau test harness: unknown agent "${agentName}" for startChild`);
      }
      return dispatchChildRun(agent, input, {
        registry: childRegistry,
        ...dispatchOptions,
        agentName,
        parentRunId,
      });
    },

    submitSchedulerTask(request) {
      return readyBureau.submitSchedulerTask(request);
    },

    createRecurringSchedule(definition) {
      return readyBureau.createSchedule(definition);
    },

    resolveReview(input) {
      return readyBureau.resolveReview(input);
    },

    deliverSignal(sessionId, name, payload) {
      return readyBureau.signalSession(sessionId, name, payload);
    },

    reattachDurable(runId) {
      return readyBureau.getDurableRun(runId);
    },

    supports() {
      return false;
    },

    startManagedGoal() {
      return throwUnsupported('managed-goal');
    },

    getSchedulerTaskResult() {
      return throwUnsupported('scheduler-task-result');
    },
  };

  return harness;
}
