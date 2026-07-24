import {
  type AnyWorkflowDefinition,
  WorkflowHandle,
  WorkflowStartedEvent,
  type WorkflowStatus,
} from '@lostgradient/weft';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';

import { createCheckpointStore } from '../durable/checkpoint-store';
import { createRunEngine, type RunEngine } from '../durable/create-run-engine';
import { createRunWorkflow } from '../durable/run-workflow';

/**
 * The maximum number of event-loop yields before a `waitForCondition` or
 * `waitForSuspend` call gives up. Matches the cap used across other test helpers
 * in this monorepo so tests fail with a clear assertion rather than an infinite hang.
 */
const MAX_WAIT_ATTEMPTS = 50;

/**
 * Statuses that indicate the workflow has reached a terminal state —
 * it will not progress further and should not be awaited.
 */
const TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

/**
 * The `'pending'` status indicates the workflow is still in the inline launch
 * queue (not yet executing). `waitForSuspend` must yield past this status.
 */
const PENDING_STATUS: WorkflowStatus = 'pending';

/**
 * A tracked child-run handle registered when a workflow starts.
 *
 * The `runId` is the durable workflow id (= the agent run id). `handle` is the
 * Weft `WorkflowHandle` for the child run — tests use it to signal, await, or
 * snapshot the run without going through the engine directly.
 */
export interface ChildRunHandle {
  /** The durable workflow id, which equals the agent run id. */
  runId: string;
  /** The Weft workflow type name, typically `'agentRun'`. */
  workflowType: string;
  /** The raw Weft `WorkflowHandle` for the child run. */
  handle: WorkflowHandle;
}

/**
 * The harness returned by {@link createDurableMultiAgentHarness}.
 *
 * The harness wraps a durable Weft engine (backed by `MemoryStorage`) and
 * provides deterministic, real-timer-free primitives for testing durable
 * multi-agent patterns: HITL parking, scatter-gather delegation, signal
 * delivery, and child-run observation.
 */
export interface DurableMultiAgentHarness {
  /**
   * The `RunEngine` (Weft engine + checkpoint store) for advanced assertions.
   * Access the raw engine via `harness.engine.engine`.
   */
  engine: RunEngine;

  /**
   * All workflow handles started on the engine, in start order.
   *
   * A new entry is appended synchronously when the engine fires
   * `WorkflowStartedEvent`. Use this list to observe child-run starts in
   * multi-agent trees without polling the engine.
   */
  childRunHandles: ChildRunHandle[];

  /**
   * Send a signal to a parked workflow.
   *
   * Thin wrapper over `engine.signal(runId, name, payload)`. The signal
   * releases a workflow parked on `ctx.waitForSignal(name)`.
   *
   * @param runId - The durable workflow id (= agent run id) to signal.
   * @param signalName - The signal name the workflow is waiting on.
   * @param payload - Optional payload delivered to `ctx.waitForSignal`.
   */
  signal(runId: string, signalName: string, payload?: unknown): Promise<void>;

  /**
   * Drain the portable event-loop until the named workflow has left the
   * `'pending'` state (i.e., the inline launch queue has flushed and the
   * generator has executed its first turn), which for HITL workflows means
   * it is now parked on `ctx.waitForSignal`.
   *
   * **Weft semantics note**: `ctx.waitForSignal` parks a workflow
   * in-process but leaves its durable status as `'running'`, NOT
   * `'suspended'`. The `'suspended'` status is set only by an explicit
   * `engine.suspend(id)` call. This helper polls for the transition away
   * from `'pending'` (queued-but-not-yet-executing), which confirms the
   * generator has advanced to the signal-wait point.
   *
   * Uses `handle.snapshot()` and `yieldToPortableEventLoop` — no real
   * timers — so the test stays deterministic even on a busy CI host.
   * Throws after {@link MAX_WAIT_ATTEMPTS} yields if the workflow does not
   * leave the `'pending'` state, or if it terminates without ever parking.
   *
   * @param runId - The durable workflow id to poll.
   */
  waitForSuspend(runId: string): Promise<void>;

  /**
   * Drain the portable event-loop until `condition()` returns `true`.
   *
   * A general-purpose polling primitive used when you need a richer
   * condition than "workflow is suspended" — for example, waiting until a
   * specific number of child runs have started, or until a shared counter
   * reaches a value.
   *
   * Throws after {@link MAX_WAIT_ATTEMPTS} yields if the condition is
   * never satisfied.
   *
   * @param condition - Synchronous or async predicate to poll.
   * @param failureMessage - Message to include in the thrown error.
   * @param maximumAttempts - Override the default attempt cap.
   */
  waitForCondition(
    condition: () => boolean | Promise<boolean>,
    failureMessage: string,
    maximumAttempts?: number,
  ): Promise<void>;

  /**
   * Drain one portable event-loop turn.
   *
   * Re-exported from Weft so tests can advance the inline-launch queue
   * without importing from `@lostgradient/weft/testing` directly.
   */
  yield(): Promise<void>;

  /** Release all engine resources. Must be called in `afterEach`/`finally`. */
  dispose(): void;
}

/**
 * Options accepted by {@link createDurableMultiAgentHarness}.
 */
export interface CreateDurableMultiAgentHarnessOptions {
  /**
   * Override the `agentRun` workflow definition registered on the engine.
   *
   * When omitted, the production {@link createRunWorkflow} is registered —
   * the full agent-run workflow that drives the real loop. When provided,
   * the injected workflow is used instead, letting tests substitute a
   * lightweight probe workflow (e.g. one that parks on a signal to model
   * HITL, or one that completes immediately to model a no-op run) without
   * touching the real loop code.
   *
   * The injected workflow MUST use the name `'agentRun'` — that is what the
   * engine dispatches on `engine.start('agentRun', ...)`.
   */
  runWorkflow?: AnyWorkflowDefinition;

  /**
   * Arm Weft's durable-timer polling loop. Defaults to `false` (most
   * multi-agent tests use `ctx.waitForSignal`, not timers).
   */
  startScheduler?: boolean;
}

/**
 * Build a {@link DurableMultiAgentHarness} for testing durable multi-agent
 * patterns without real timers.
 *
 * The harness creates a `MemoryStorage`-backed durable run engine and wraps it
 * with tracking and control primitives needed to test:
 *
 * - **HITL parking** — verify a run suspends, then release it via `signal()`.
 * - **Scatter-gather** — observe child runs starting via `childRunHandles`.
 * - **Signal delivery** — deliver typed payloads to `ctx.waitForSignal` consumers.
 * - **Deterministic polling** — `waitForSuspend` / `waitForCondition` use
 *   `yieldToPortableEventLoop`, not `setTimeout`.
 *
 * The `runWorkflow` option lets tests swap in a probe workflow rather than the
 * full production loop. This is the key seam that makes HITL, scatter-gather,
 * and child-workflow tests tractable: register a minimal workflow that parks on
 * `ctx.waitForSignal` instead of running the entire agent loop.
 *
 * @example
 * ```ts
 * import { workflow } from '@lostgradient/weft';
 * import { createDurableMultiAgentHarness } from '@lostgradient/operative/test';
 *
 * // A minimal HITL probe: parks until a 'human-response' signal arrives.
 * const hitlWorkflow = workflow({ name: 'agentRun' })
 *   .execute(async function* (ctx, input: { requestId: string }) {
 *     const result = yield* ctx.waitForSignal<{ approved: boolean }>('human-response');
 *     return { requestId: input.requestId, approved: result.approved };
 *   });
 *
 * const harness = await createDurableMultiAgentHarness({ runWorkflow: hitlWorkflow });
 *
 * try {
 *   const handle = await harness.engine.engine.start('agentRun', { requestId: 'r1' });
 *   await harness.waitForSuspend(handle.id);
 *   await harness.signal(handle.id, 'human-response', { approved: true });
 *   const result = await handle.result();   // { requestId: 'r1', approved: true }
 * } finally {
 *   harness.dispose();
 * }
 * ```
 *
 * @remarks
 * `recover: false` keeps the harness isolated: no recovery from prior runs (there
 * are none in a fresh `MemoryStorage`). `startScheduler` defaults to `false`
 * because HITL / signal tests don't need durable timers. Set it to `true` when
 * the workflow uses `ctx.sleep`.
 */
export async function createDurableMultiAgentHarness(
  options?: CreateDurableMultiAgentHarnessOptions,
): Promise<DurableMultiAgentHarness> {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    // Non-owning view: the engine owns the storage lifecycle.
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const runWorkflow = options?.runWorkflow ?? createRunWorkflow(checkpointStore);

  const runEngine = await createRunEngine({
    storage,
    runWorkflow,
    checkpointStore,
    recover: false,
    startScheduler: options?.startScheduler ?? false,
  });

  const { engine } = runEngine;

  // ------------------------------------------------------------------
  // Child-run tracking: listen to WorkflowStartedEvent and accumulate
  // handles so tests can observe the multi-agent tree without polling.
  // ------------------------------------------------------------------
  const childRunHandles: ChildRunHandle[] = [];

  engine.addEventListener(WorkflowStartedEvent.type, (event: Event) => {
    // The engine fires WorkflowStartedEvent; we need the workflowId to
    // retrieve the handle. WorkflowStartedEvent carries .workflowId and
    // .workflowType. We build a WorkflowHandle from the engine directly.
    const started = event as WorkflowStartedEvent;
    // WorkflowHandle is publicly constructible; the engine is its backing
    // target. Engine<any,any> does not directly satisfy WorkflowHandleEngine
    // (which carries a symbol-keyed method), so widen via `as any`.
    const handle = new WorkflowHandle(started.workflowId, engine as any);
    childRunHandles.push({
      runId: started.workflowId,
      workflowType: started.workflowType,
      handle,
    });
  });

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  async function signal(runId: string, signalName: string, payload?: unknown): Promise<void> {
    await engine.signal(runId, signalName, payload);
  }

  async function waitForCondition(
    condition: () => boolean | Promise<boolean>,
    failureMessage: string,
    maximumAttempts = MAX_WAIT_ATTEMPTS,
  ): Promise<void> {
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      if (await condition()) return;
      await yieldToPortableEventLoop();
    }
    throw new Error(
      `createDurableMultiAgentHarness.waitForCondition: ${failureMessage} (gave up after ${maximumAttempts} yields)`,
    );
  }

  async function waitForSuspend(runId: string): Promise<void> {
    // Find the tracked handle for this run id, or fall back to constructing
    // one. The tracked handle list is populated by WorkflowStartedEvent which
    // fires asynchronously (deferred via the inline launch queue's setTimeout(0)),
    // so it may not be populated yet. Construct a handle directly for reliability.
    const tracked = childRunHandles.find((h) => h.runId === runId);
    // See the WorkflowStartedEvent listener above for cast rationale.
    const handle = tracked?.handle ?? new WorkflowHandle(runId, engine as any);

    // Poll until the workflow leaves 'pending' status, which means the inline
    // launch queue has flushed and the generator has executed at least its
    // first turn. For a HITL workflow, that means it has parked on
    // ctx.waitForSignal. Weft does NOT change status to 'suspended' when a
    // workflow parks on waitForSignal — it stays 'running' in storage.
    await waitForCondition(async () => {
      const snapshot = await handle.snapshot();
      if (snapshot === null) return false;
      // If the workflow terminated before parking, surface it.
      if (TERMINAL_STATUSES.has(snapshot.status)) {
        throw new Error(
          `waitForSuspend: run '${runId}' reached terminal status '${snapshot.status}' without parking on a signal`,
        );
      }
      // 'pending' = still in the inline launch queue; 'running' = executing
      // or parked. We wait until status leaves 'pending'.
      return snapshot.status !== PENDING_STATUS;
    }, `run '${runId}' did not leave 'pending' status (inline launch queue did not flush)`);
  }

  function dispose(): void {
    engine[Symbol.dispose]();
  }

  return {
    engine: runEngine,
    childRunHandles,
    signal,
    waitForSuspend,
    waitForCondition,
    yield: yieldToPortableEventLoop,
    dispose,
  };
}
