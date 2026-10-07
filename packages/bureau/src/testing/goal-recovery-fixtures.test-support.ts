/**
 * COR-851 — fixtures for the goal restart tests: booting bureaus over one
 * SQLite file, and writing a goal record into it the way a process that died
 * at a precise point would have left it.
 */

import {
  createAgentSession,
  createSessionStore,
  type FreshAttemptSourceResolver,
  startDurableRunResult,
  stopWhen,
  type Validator,
} from '@lostgradient/operative';
import {
  decode,
  encode,
  KEYS,
  resolveStorage,
  type Storage,
  textValueStore,
} from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import { goalSessionMetadata } from '../goal-conversation';
import {
  createGoalState,
  type DurableGoalAttempt,
  goalAttemptId,
  goalAttemptRunId,
  goalDecisionId,
  goalRecordKey,
  goalSessionId,
  type GoalState,
  goalTransitionId,
} from '../goal-state';
import { createGoalStore, type GoalStore } from '../goal-store';
import type { BureauGoalRequest } from '../goal-types';
import { CATALOG_RUN_RECOVERY_KEY_PREFIX, createRuntimeComposition } from '../runtime-composition';
import type { Bureau } from '../types';
import { createDiagnostics, goalRequest } from './goal-fixtures.test-support';

export interface BootOptions<D extends AgentDefinitions> {
  readonly path: string;
  readonly agents: D;
  readonly validators?: readonly Validator[];
  readonly resolveFreshAttemptSource?: FreshAttemptSourceResolver;
  readonly diagnostics?: ReturnType<typeof createDiagnostics>;
  readonly checkpointRetention?: { readonly keepLast: number };
}

/** A bureau over `path` that recovers whatever an earlier process left behind. */
export async function bootOver<D extends AgentDefinitions>(options: BootOptions<D>) {
  const diagnostics = options.diagnostics ?? createDiagnostics();
  const bureau = await createBureau({
    agents: options.agents,
    ...(options.validators === undefined ? {} : { validators: options.validators }),
    ...(options.resolveFreshAttemptSource === undefined
      ? {}
      : { resolveFreshAttemptSource: options.resolveFreshAttemptSource }),
    ...(options.checkpointRetention === undefined
      ? {}
      : { checkpointRetention: options.checkpointRetention }),
    storage: { type: 'sqlite', path: options.path },
    durableExecution: true,
    durableOwnership: { ownership: 'none' },
    onDiagnostic: diagnostics.onDiagnostic,
  });
  return { bureau: bureau as unknown as Bureau, diagnostics };
}

/** A direct view of the SQLite file: the goal store, and the raw keys beside it. */
export async function inspect(path: string) {
  const storage: Storage = await resolveStorage({ type: 'sqlite', path });
  const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
  const store: GoalStore = createGoalStore(kv);
  return {
    storage,
    kv,
    store,
    dispose: () => storage[Symbol.dispose](),
    /** Overwrites a goal record's text, as an operator repairing it would. */
    async overwrite(record: GoalState) {
      await kv.set(goalRecordKey(record.goalRunId), JSON.stringify(record));
    },
    /** A catalog-run recovery claim, as a start that died before its workflow existed left it. */
    async claimRun(
      runId: string,
      record: {
        agentName: string;
        definitionRevision: number;
        input: string;
        goalAttempt?: { goalRunId: string; attemptIndex: number };
        /** The persisted estimator selection; a goal attempt's claim carries `null` unless one is given. */
        costEstimation?: unknown;
      },
    ) {
      const selection =
        record.goalAttempt === undefined ? {} : { costEstimation: record.costEstimation ?? null };
      await storage.put(
        `${CATALOG_RUN_RECOVERY_KEY_PREFIX}${runId}`,
        encode({ schemaVersion: 1, ...record, ...selection }),
      );
    },
    /** A value at a run's recovery key that decodes but is not a recovery record. */
    async corruptRunRecord(runId: string) {
      await storage.put(
        `${CATALOG_RUN_RECOVERY_KEY_PREFIX}${runId}`,
        encode({ schemaVersion: 1, agentName: 7 }),
      );
    },
    /** Marks a run that already exists as the goal's own attempt, as the goal's own start would have. */
    async markRunAsGoalAttempt(runId: string, goalRunId: string, attemptIndex: number) {
      const key = `${CATALOG_RUN_RECOVERY_KEY_PREFIX}${runId}`;
      const stored = await storage.get(key);
      if (stored === null || stored === undefined)
        throw new Error(`no recovery record for ${runId}`);
      await storage.put(
        key,
        encode({
          ...(decode(stored) as Record<string, unknown>),
          goalAttempt: { goalRunId, attemptIndex },
        }),
      );
    },
  };
}

type Inspection = Awaited<ReturnType<typeof inspect>>;

const NOW = '2026-10-02T12:00:00.000Z';

function attemptAt(goalRunId: string, index: number, overrides: Partial<DurableGoalAttempt> = {}) {
  return {
    attemptId: goalAttemptId(goalRunId, index),
    attemptIndex: index,
    runId: goalAttemptRunId(goalRunId, index),
    sessionId: goalSessionId(goalRunId, 0),
    startedAt: NOW,
    usage: { steps: 0, tokens: 0 },
    status: 'running',
    ...overrides,
  } satisfies DurableGoalAttempt;
}

/** A fresh `pending` record for the standard test goal. */
export function pendingGoal(overrides: Partial<BureauGoalRequest<'worker'>> = {}): GoalState {
  const request = goalRequest(overrides);
  return createGoalState({
    goalRunId: request.goalRunId ?? 'g1',
    identity: request.identity,
    objective: { agentName: request.agentName, prompt: request.prompt },
    validator: request.validator,
    conversationPolicy: request.conversationPolicy ?? { kind: 'continue' },
    retryPolicy: request.retryPolicy,
    bounds: request.bounds,
    principal: request.principal,
    now: NOW,
  });
}

/** Creates the record and walks it to `running` with attempt 0 recorded, as a controller would. */
export async function seedRunning(inspection: Inspection, goal = pendingGoal()) {
  const { goalRunId } = goal;
  await inspection.store.create(goal);
  const attempt = attemptAt(goalRunId, 0);
  await inspection.store.applyTransition({
    goalRunId,
    seq: 1,
    transitionId: goalTransitionId(goalRunId, 1),
    to: 'running',
    at: NOW,
    cause: 'attempt 0 started',
    attempt,
    usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
    active: {
      kind: 'attempt',
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      startedAt: NOW,
    },
  });
  return attempt;
}

/**
 * The goal's session as the forwarder leaves it once attempt 0 has ended: one
 * completed run, and the transcript that run committed. A goal that died in
 * `retrying` has this, because the controller is told an attempt ended only
 * after its transcript is committed.
 */
export async function seedTrunk(inspection: Inspection, goal = pendingGoal()) {
  const conversation = new Conversation();
  conversation.appendUserMessage(goal.objective.prompt);
  conversation.appendAssistantMessage('nope');
  const sessions = createSessionStore(inspection.kv);
  // A committed run carries its transcript as a boundary; this one is
  // self-contained, as the first run's always is.
  const { ids, messages, ...rest } = conversation.current;
  await sessions.save(
    createAgentSession({
      agentName: goal.objective.agentName,
      conversationHistory: conversation.current,
      id: goalSessionId(goal.goalRunId, 0),
      metadata: goalSessionMetadata(goal),
      runs: [
        {
          runId: goalAttemptRunId(goal.goalRunId, 0),
          sequence: 0,
          status: 'completed',
          startedAt: NOW,
          agentName: goal.objective.agentName,
          outcome: { finishReason: 'stop-condition' },
          conversationBoundary: { conversation: rest, ids: [...ids], messages: { ...messages } },
        },
      ],
    }),
  );
}

/** Walks a seeded `running` goal on to `retrying`: attempt 0 failed retryably with feedback. */
export async function seedRetrying(inspection: Inspection, goal = pendingGoal()) {
  const { goalRunId } = goal;
  const attempt = await seedRunning(inspection, goal);
  await seedTrunk(inspection, goal);
  await inspection.store.applyTransition({
    goalRunId,
    seq: 2,
    transitionId: goalTransitionId(goalRunId, 2),
    to: 'evaluating',
    at: NOW,
    cause: 'attempt 0 reached stop-condition',
    attempt: { ...attempt, status: 'evaluating', finishReason: 'stop-condition' },
    active: {
      kind: 'validation',
      attemptId: attempt.attemptId,
      validator: goal.validator,
      startedAt: NOW,
    },
  });
  await inspection.store.applyTransition({
    goalRunId,
    seq: 3,
    transitionId: goalTransitionId(goalRunId, 3),
    to: 'retrying',
    at: NOW,
    cause: 'retrying after a non-passing attempt',
    attempt: {
      ...attempt,
      status: 'failed',
      finishReason: 'stop-condition',
      completedAt: NOW,
      feedback: 'say done',
      validation: {
        identity: goal.validator,
        startedAt: NOW,
        completedAt: NOW,
        outcome: { kind: 'fail', feedback: 'say done', evidence: [], retryable: true },
        decisionId: goalDecisionId(attempt.attemptId),
      },
    },
    active: null,
  });
}

/**
 * A pending goal whose first attempt's run id holds bytes the engine cannot
 * decode, so starting that attempt throws and the controller ends abnormally.
 * The record itself is legal (a record that contradicts itself no longer
 * decodes), so this is how a test makes a controller fail from a goal the bureau
 * accepts.
 */
export async function seedPoisoned(inspection: Inspection, goal = pendingGoal()) {
  await inspection.store.create(goal);
  await inspection.storage.put(
    KEYS.workflow(goalAttemptRunId(goal.goalRunId, 0)),
    new Uint8Array([1, 2, 3]),
  );
}

/** Removes what {@link seedPoisoned} left, so the goal's first attempt can start. */
export async function repairPoisoned(inspection: Inspection, goal = pendingGoal()) {
  await inspection.storage.delete(KEYS.workflow(goalAttemptRunId(goal.goalRunId, 0)));
}

/**
 * A durable run that has already completed under `runId`, written straight to
 * the store. It stands for a run something other than Bureau's public surface
 * put at a deterministic goal id, which admission itself now refuses to create.
 */
export async function seedFinishedRun(path: string, runId: string, content = 'done') {
  const generate = () => Promise.resolve({ content, toolCalls: [] });
  const toolbox = createToolbox([]);
  const composition = await createRuntimeComposition({
    generate,
    toolbox,
    storage: { type: 'sqlite', path },
    durableExecution: true,
  });
  const { engine, checkpointStore } = composition.durable!;
  try {
    await startDurableRunResult(
      { engine, checkpointStore },
      {
        runId,
        sessionId: runId,
        options: {
          generate,
          toolbox,
          conversation: new Conversation(),
          stopWhen: stopWhen.noToolCalls(),
        },
      },
    );
  } finally {
    engine[Symbol.dispose]?.();
    composition.disposeStorage?.();
  }
}
