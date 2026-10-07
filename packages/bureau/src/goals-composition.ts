/**
 * COR-851 — assembles `bureau.goals` from the pieces `createBureau` already has.
 *
 * Kept out of `createBureau` so that function gains one call rather than the
 * goal control plane's wiring: the store over Bureau's key-value store, the
 * validator catalog, the attempt forwarder, the workflow ports (bound into the
 * workflow the engine registered before any of this existed), and the control
 * plane over all of them.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type CleanupAcknowledgement,
  createSessionStore,
  type DurableActiveRunContext,
  type FreshAttemptSourceResolver,
  type RunOptions,
  type SessionStore,
} from '@lostgradient/operative';
import { type ConditionalTextValueStore, MemoryStorage, textValueStore } from '@lostgradient/weft';

import type { GoalAttemptRun, GoalAttemptStart } from './bureau-catalog-dispatch';
import type { DurableEventHistory } from './durable-event-history';
import { createGoalAttemptFence, type GoalAttemptFenceHost } from './goal-attempt-fence';
import { createGoalConversations } from './goal-conversation';
import { createGoalEventRecorder, projectGoalHistory } from './goal-event-projection';
import { createAttemptForwarder } from './goal-forwarder';
import {
  createOwnedGoalEngine,
  createOwnedRunCanceller,
  GoalCorruptOwnershipRecordError,
  type GoalOwnerResolver,
  GoalOwnershipUnknownError,
  type RunRecordReader,
} from './goal-ownership';
import { createGoalPorts, type GoalWorkflowHost } from './goal-ports';
import { recoverGoalsAtBoot } from './goal-recovery';
import { goalAttemptRunId, type GoalState, goalWorkflowId } from './goal-state';
import { createGoalStore } from './goal-store';
import type { BureauGoalRecoveryReport, BureauGoals, GoalEngine } from './goal-types';
import type { GoalValidatorCatalog } from './goal-validator-catalog';
import { type BureauGoalsDependencies, createBureauGoals } from './goals';
import type { GoalAttemptClaimFence, GoalAttemptClaimOwner } from './runtime-composition';
import type { CancelDurableRunOutcome, DiagnosticSink } from './types';

export interface GoalsCompositionDependencies {
  /** Built by the caller before the durable engine, so a bad registration fails startup first. */
  readonly catalog: GoalValidatorCatalog;
  readonly kv: ConditionalTextValueStore | undefined;
  /** Where goal conversations live; absent when the bureau has no persistent store, as with `kv`. */
  readonly sessionStore: SessionStore | undefined;
  /** See `BureauOptions.resolveFreshAttemptSource`. */
  readonly resolveFreshAttemptSource: FreshAttemptSourceResolver | undefined;
  readonly runtimeServices: RuntimeServices;
  readonly host: GoalWorkflowHost;
  readonly getDurable: () => (DurableActiveRunContext & { engine: GoalEngine }) | undefined;
  readonly planAgent: (
    agentName: string,
  ) => { readonly durable: boolean; readonly agentVersion: string } | undefined;
  readonly startAttemptRun: (start: GoalAttemptStart) => GoalAttemptRun;
  readonly cancelRun: (runId: string) => Promise<CancelDurableRunOutcome>;
  /** Reads the recovery record that marks which goal attempt a run was started for. */
  readonly readRunRecord: RunRecordReader;
  /** Tombstones a goal attempt's claim; see `RuntimeComposition.fenceGoalAttemptRecoveryRecord`. */
  readonly fenceClaim: (
    runId: string,
    owner: GoalAttemptClaimOwner,
    tombstonedAt: string,
  ) => Promise<GoalAttemptClaimFence>;
  /** Where the self-fence the attempts' runs are registered with is bound, once the store and the reader exist. */
  readonly fenceHost: GoalAttemptFenceHost;
  /** Applies checkpoint retention to a terminal controller or attempt workflow; see `BureauGoalsDependencies`. */
  readonly cleanupWorkflow: (workflowId: string) => Promise<CleanupAcknowledgement>;
  readonly isClosing: () => boolean;
  readonly diagnose: DiagnosticSink;
  /** Where a goal's audit events are recorded; absent when the bureau has no persistent history. */
  readonly eventHistory?: Pick<DurableEventHistory, 'record'> | undefined;
}

export interface GoalsComposition {
  readonly goals: BureauGoals;
  /** Whether `workflowId` is the controller of a goal this bureau stores. */
  ownsWorkflow(workflowId: string): Promise<boolean>;
  /** The boot sweep. Never rejects. */
  recoverAtBoot(): Promise<BureauGoalRecoveryReport>;
  /**
   * Aborts the starts of recoveries still running past the boot sweep's budget,
   * and resolves once they have settled and every forwarded signal already being
   * sent has been delivered.
   */
  drain(): Promise<void>;
}

/**
 * How long shutdown waits for a boot sweep that outlived its own budget: it
 * aborts the starts it can reach, and does not wait past this for the rest.
 */
export const GOAL_DRAIN_BUDGET_MS = 5_000;

export function composeBureauGoals(dependencies: GoalsCompositionDependencies): GoalsComposition {
  const { runtimeServices, host, diagnose, readRunRecord } = dependencies;
  const fenceAttempt = (record: GoalState, attemptIndex: number): Promise<GoalAttemptClaimFence> =>
    dependencies.fenceClaim(
      goalAttemptRunId(record.goalRunId, attemptIndex),
      {
        goalRunId: record.goalRunId,
        attemptIndex,
        agentName: record.objective.agentName,
        principal: record.principal,
      },
      runtimeServices.clock.nowISO(),
    );
  const recordEvents =
    dependencies.eventHistory === undefined
      ? undefined
      : createGoalEventRecorder(dependencies.eventHistory, diagnose);
  const store = createGoalStore(dependencies.kv ?? textValueStore(new MemoryStorage()), {
    ...(recordEvents === undefined ? {} : { observe: recordEvents }),
    onObserverError: (error) =>
      diagnose({
        level: 'error',
        scope: 'goals',
        message: '[bureau] A goal event projection failed.',
        cause: error,
      }),
    onCorrupt: (key) =>
      diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Ignoring an unreadable goal record at "${key}".`,
      }),
  });
  const { catalog } = dependencies;

  // Everything but the start-attempt port, which must tell an absent id from a
  // foreign one, sees the engine through the goal's ownership checks: a
  // workflow or run the goal does not own does not exist to it.
  // Who owns a goal is what its own record says, so a run that merely carries
  // a marker naming the goal is the goal's only if it was started as the goal's
  // agent and principal. A goal that cannot be read owns nothing.
  const resolveGoalOwner: GoalOwnerResolver = async (goalRunId) => {
    const record = await store.get(goalRunId);
    return record === undefined
      ? undefined
      : {
          agentName: record.objective.agentName,
          principal: record.principal,
          maximumAttempts: record.bounds.maximumAttempts,
        };
  };
  const getDurable = (): ReturnType<typeof dependencies.getDurable> => {
    const durable = dependencies.getDurable();
    return durable === undefined
      ? undefined
      : {
          ...durable,
          engine: createOwnedGoalEngine(durable.engine, readRunRecord, resolveGoalOwner),
        };
  };
  const cancelRun = createOwnedRunCanceller(
    dependencies.cancelRun,
    readRunRecord,
    resolveGoalOwner,
  );

  /**
   * The cost estimation an attempt's run was started with, for a goal with a
   * cost bound. It is read from the selection persisted with the run's recovery
   * record (see `goal-cost-estimation.ts`) and never resolved from the catalog,
   * which may by now hold another revision of the agent or none: pricing a run
   * that already ran with a different definition would record a cost it never
   * had. `undefined` means the run declared no estimator (or no run was started
   * under this id). A record that cannot be read, is not a valid record, or
   * carries no selection rejects, so the caller retries or reports it.
   */
  async function resolveCostEstimation(runId: string): Promise<RunOptions['costEstimation']> {
    const load = await readRunRecord(runId);
    // No record means no run was started under this id, so there is nothing to price.
    if (load.status === 'missing') return undefined;
    if (load.status === 'read-error') throw new GoalOwnershipUnknownError(runId, load.error);
    if (load.status === 'corrupt') throw new GoalCorruptOwnershipRecordError(runId);
    // The decoder requires the selection on every goal attempt's record, so a
    // record without one is not a goal attempt's: it has no estimator to read.
    if (load.record.goalAttempt === undefined || load.record.costEstimation === undefined) {
      throw new GoalCorruptOwnershipRecordError(runId);
    }
    return load.record.costEstimation ?? undefined;
  }

  const conversations = createGoalConversations({
    sessionStore:
      dependencies.sessionStore ??
      createSessionStore(textValueStore(new MemoryStorage()), { runtime: runtimeServices }),
    runtime: runtimeServices,
    getDurable,
    resolveFreshAttemptSource: dependencies.resolveFreshAttemptSource,
  });
  const forwarder = createAttemptForwarder({
    store,
    runtime: runtimeServices,
    getDurable,
    resolveCostEstimation,
    conversations,
    isClosing: dependencies.isClosing,
    diagnose,
  });
  const ports = createGoalPorts({
    store,
    catalog,
    runtime: runtimeServices,
    forwarder,
    conversations,
    // The raw engine: adopting a run needs to know whether the id is held at
    // all, which the owned view hides when the holder is foreign.
    getDurable: dependencies.getDurable,
    readRunRecord,
    planAgent: dependencies.planAgent,
    startAttemptRun: dependencies.startAttemptRun,
    cancelRun,
    fenceAttempt,
    resolveCostEstimation,
  });
  host.bind(ports);
  // Every attempt's run reads the goal and its own claim before each step.
  dependencies.fenceHost.bind(
    createGoalAttemptFence({ store, readRunRecord, clock: runtimeServices.clock }),
  );

  const shutdown = new AbortController();
  let backgroundSweep: Promise<void> | undefined;

  const goalDependencies = {
    store,
    catalog,
    runtime: runtimeServices,
    clock: runtimeServices.clock,
    diagnose,
    getEngine: () => getDurable()?.engine,
    cancelRun,
    fenceAttempt,
    cleanupWorkflow: dependencies.cleanupWorkflow,
    forwarder,
    resolveFreshAttemptSource: dependencies.resolveFreshAttemptSource,
    startAttempt: (request, signal) => ports.startAttempt(request, signal),
    timers: runtimeServices.timers,
    isClosing: dependencies.isClosing,
    shutdownSignal: shutdown.signal,
    planAgent: dependencies.planAgent,
  } satisfies BureauGoalsDependencies;
  const goals = createBureauGoals(goalDependencies);

  return {
    goals,
    async ownsWorkflow(workflowId) {
      if (!workflowId.startsWith('goal:')) return false;
      const record = await store.get(workflowId.slice('goal:'.length));
      return record !== undefined && goalWorkflowId(record.goalRunId) === workflowId;
    },
    async recoverAtBoot() {
      // Replay every record's audit log into the event history. Each commit
      // stored its audit events in the record, so a projection that failed at
      // any point, at any depth in the log, is repaired here; the dedupe keys
      // make a replay of what is already recorded a no-op.
      if (recordEvents !== undefined) {
        // Listing and projecting are one failure domain: a store that cannot be
        // listed must not keep the recovery sweep below from running.
        try {
          await projectGoalHistory(await store.list(), recordEvents);
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'goals',
            message: '[bureau] Could not re-project goal events at boot.',
            cause: error,
          });
        }
      }
      return recoverGoalsAtBoot(goalDependencies, {
        onBackground: (settled) => {
          backgroundSweep = settled;
        },
      });
    },
    async drain() {
      // Recoveries that outlived the boot sweep's budget carry on in the
      // background: abort their starts and wait for them to settle, so none
      // touches the engine or storage once the bureau disposes them.
      shutdown.abort();
      // Only the attempt start honours the signal; a recovery blocked in a read
      // of the engine or the store does not. Waiting for it forever would hang
      // `close()` before storage is disposed, so the wait is bounded: past the
      // budget the sweep is diagnosed and left, as a recovery that outlived it.
      // No timer is armed when no sweep outlived its budget, which is the
      // ordinary case.
      if (backgroundSweep !== undefined) {
        const { timers } = runtimeServices;
        let handle: ReturnType<typeof timers.setTimeout>;
        const expired = new Promise<'expired'>((resolve) => {
          handle = timers.setTimeout(() => resolve('expired'), GOAL_DRAIN_BUDGET_MS);
        });
        try {
          const sweep = await Promise.race([
            backgroundSweep.then(() => 'settled' as const),
            expired,
          ]);
          if (sweep === 'expired') {
            diagnose({
              level: 'warn',
              scope: 'goals',
              message: `[bureau] The goal recovery sweep did not settle within ${GOAL_DRAIN_BUDGET_MS} ms of shutdown and was left running.`,
            });
          }
        } finally {
          timers.clearTimeout(handle);
        }
      }
      await forwarder.drain();
    },
  };
}
