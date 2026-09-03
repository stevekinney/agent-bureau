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
 * Out of scope here (AB-261's stated boundary): the quiescence report and
 * `harness.close()`'s shutdown delegation (AB-262/tst-03c), the
 * reproduction-artifact assembler and Bureau-scoped fault selectors
 * (AB-263/tst-03d), and the packed-consumer extension (AB-264/tst-03e).
 * Drivers for product surfaces that do not exist yet on this baseline
 * (managed goals — AB-101/AB-102 — and settled scheduler-task retrieval —
 * AB-180) are named as unsupported through `supports()` and a typed throw,
 * never silently stubbed out.
 */
import type { AgentInput, ChildRunHandle, DispatchChildRunOptions } from '@lostgradient/operative';
import { dispatchChildRun } from '@lostgradient/operative';
import { waitForCondition } from '@lostgradient/operative/test';
import type { ScheduleSummary, WorkflowState } from '@lostgradient/weft';
import type { ManualRuntimeServices } from 'lifecycle';
import { createManualRuntimeServices } from 'lifecycle';

import type { AgentDefinitions, AgentNames, AgentRunForName } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import type {
  Bureau,
  BureauOptions,
  BureauRunOptions,
  CreateRunRequest,
  DurableScheduleDefinition,
  ResolveReviewInput,
  ResolveReviewResult,
  RunSummary,
  SubmitSchedulerTaskRequest,
  SubmitSchedulerTaskResponse,
} from '../types';
import type { BureauStorageFixture } from './storage-fixtures';

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
 * Constructs a real `Bureau` over deterministic runtime services and an
 * owned storage fixture, resolving only after `bureau.ready` is `true` and
 * boot recovery has completed.
 */
export async function createBureauTestHarness<D extends AgentDefinitions = AgentDefinitions>(
  options: BureauTestHarnessOptions<D>,
): Promise<BureauTestHarness<D>> {
  const { runtime: providedRuntime, storage, ...rest } = options;
  const runtime = providedRuntime ?? createManualRuntimeServices();

  const bureau = await createBureau<D>({
    ...(rest as BureauOptions<D>),
    runtime,
    storage: storage.configuration,
  });

  await waitForBureauReady(bureau as unknown as Bureau<AgentDefinitions>);

  const harness: BureauTestHarness<D> = {
    bureau,
    runtime,
    storage,

    startRun(name, input, runOptions) {
      return bureau.run(name, input, runOptions);
    },

    startSession(request) {
      return bureau.createRun(request);
    },

    startChild(parentRunId, agentName, input, dispatchOptions) {
      const agent = bureau.agents.find(agentName);
      if (!agent) {
        throw new Error(`Bureau test harness: unknown agent "${agentName}" for startChild`);
      }
      return dispatchChildRun(agent, input, {
        ...dispatchOptions,
        agentName,
        parentRunId,
      });
    },

    submitSchedulerTask(request) {
      return bureau.submitSchedulerTask(request);
    },

    createRecurringSchedule(definition) {
      return bureau.createSchedule(definition);
    },

    resolveReview(input) {
      return bureau.resolveReview(input);
    },

    deliverSignal(sessionId, name, payload) {
      return bureau.signalSession(sessionId, name, payload);
    },

    reattachDurable(runId) {
      return bureau.getDurableRun(runId);
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
