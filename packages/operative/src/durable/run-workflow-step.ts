import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { WorkflowContext, WorkflowOperation } from '@lostgradient/weft';
import { Conversation } from 'conversationalist';

import { toAgentRunError } from '../errors';
import { buildStepDeps, createRunState } from '../loop';
import { runStep } from '../run-step';
import type { FinishReason, StepResult } from '../types';
import { runDepsFrom } from './run-workflow-input';
import {
  classifyErrorFinishReason,
  serializeError,
  tripwireDetailFrom,
} from './run-workflow-result';
import type {
  DurableRunDeps,
  PendingHumanWait,
  PendingWakeup,
  RunCursor,
  StepRecord,
} from './types';

type ConversationSnapshot = ReturnType<Conversation['snapshot']>;

/**
 * The conversation each run's latest step left behind, keyed by that run's
 * in-process deps (`ctx.services`). The workflow carries only the snapshot
 * across steps, and restoring it rebuilds every history node, so a run that
 * restored on every step grew with the cube of its length. A step reuses the
 * previous step's conversation when the snapshot it is handed is the one that
 * conversation produced and nothing has changed it since; anything else, such
 * as a fresh process resuming from its checkpoint (which builds new deps), falls
 * back to a full restore. The non-durable loop likewise runs every step on one
 * conversation.
 */
const liveConversations = new WeakMap<
  DurableRunDeps,
  { readonly conversation: Conversation; readonly digest: string }
>();

function conversationForStep(deps: DurableRunDeps, snapshot: ConversationSnapshot): Conversation {
  const live = liveConversations.get(deps);
  if (
    live !== undefined &&
    live.digest === snapshot.integrity.digest &&
    live.conversation.revision === snapshot.controllerRevision
  ) {
    return live.conversation;
  }
  return Conversation.from(snapshot, {
    runtime: deps.options.runtime ?? createDefaultRuntimeServices(),
  });
}

function snapshotAfterStep(deps: DurableRunDeps, conversation: Conversation): ConversationSnapshot {
  const snapshot = conversation.snapshot();
  liveConversations.set(deps, { conversation, digest: snapshot.integrity.digest });
  return snapshot;
}

export interface DurableStepMemoResult {
  outcome: Pick<Awaited<ReturnType<typeof runStep>>, 'kind'>;
  errorMessage?: string | undefined;
  errorFinishReason?: FinishReason | undefined;
  errorKind?: ReturnType<typeof toAgentRunError>['kind'] | undefined;
  errorCode?: ReturnType<typeof toAgentRunError>['code'] | undefined;
  tripwire?: ReturnType<typeof tripwireDetailFrom> | undefined;
  abortReason?: string | undefined;
  stopFinishReason?: FinishReason | undefined;
  schemaValidation?: { success: boolean; error?: string } | undefined;
  output?: unknown;
  record: StepRecord | null;
  conversationSnapshot: ReturnType<Conversation['snapshot']>;
  nextAccumulators: Pick<
    RunCursor,
    'totalUsage' | 'lastContent' | 'schemaAttempts' | 'lastAppliedConfigVersion'
  >;
  pendingWakeup?: PendingWakeup | undefined;
  pendingHumanWait?: PendingHumanWait | undefined;
}

export function runStepMemo(
  ctx: Pick<WorkflowContext, 'services' | 'memo'>,
  snapshot: ConversationSnapshot,
  stepIndex: number,
  carriedAccumulators: DurableStepMemoResult['nextAccumulators'],
  runId: string,
): WorkflowOperation<DurableStepMemoResult> {
  return ctx.memo(`step-${stepIndex}`, async () => {
    const deps = runDepsFrom(ctx.services);
    deps.pendingHumanWait = undefined;
    deps.pendingWakeup = undefined;
    const conversation = conversationForStep(deps, snapshot);
    const stepDeps = {
      ...buildStepDeps(deps.options),
      toolbox: deps.toolbox,
      onStepToolbox: deps.onStepToolbox,
      runId,
      durableOperationKeys: true,
    };
    const runState = createRunState();
    runState.totalUsage = { ...carriedAccumulators.totalUsage };
    runState.lastContent = carriedAccumulators.lastContent;
    runState.schemaAttempts = carriedAccumulators.schemaAttempts;
    runState.lastAppliedConfigVersion = carriedAccumulators.lastAppliedConfigVersion;
    const outcome = await runStep(stepDeps, runState, conversation, stepIndex, deps.emitter);
    deps.onStepToolbox?.(deps.toolbox);
    const pushed: StepResult | undefined = runState.steps.at(-1);
    const stepMetadata = pushed ? { ...pushed.metadata, ...deps.getStepMetadata?.() } : undefined;
    const record: StepRecord | null = pushed
      ? {
          step: pushed.step,
          content: pushed.content,
          toolCalls: pushed.toolCalls,
          results: pushed.results,
          ...(pushed.usage ? { usage: pushed.usage } : {}),
          ...(stepMetadata && Object.keys(stepMetadata).length > 0
            ? { metadata: stepMetadata }
            : {}),
          final: pushed.final,
        }
      : null;
    const normalizedError =
      outcome.kind === 'error'
        ? toAgentRunError(outcome.error, { kind: outcome.errorKind })
        : undefined;
    return {
      outcome: { kind: outcome.kind },
      errorMessage: outcome.kind === 'error' ? serializeError(outcome.error) : undefined,
      errorFinishReason:
        outcome.kind === 'error' ? classifyErrorFinishReason(outcome.error) : undefined,
      errorKind: normalizedError?.kind,
      errorCode: normalizedError?.code,
      tripwire: outcome.kind === 'error' ? tripwireDetailFrom(outcome.error) : undefined,
      abortReason: outcome.kind === 'abort' ? outcome.reason : undefined,
      stopFinishReason: outcome.kind === 'stop' ? outcome.finishReason : undefined,
      schemaValidation:
        outcome.kind === 'stop' && outcome.schemaValidation
          ? {
              success: outcome.schemaValidation.success,
              ...(outcome.schemaValidation.error !== undefined
                ? { error: serializeError(outcome.schemaValidation.error) }
                : {}),
            }
          : undefined,
      output: outcome.kind === 'stop' ? outcome.output : undefined,
      record,
      conversationSnapshot: snapshotAfterStep(deps, conversation),
      nextAccumulators: {
        totalUsage: runState.totalUsage,
        lastContent: runState.lastContent,
        schemaAttempts: runState.schemaAttempts,
        lastAppliedConfigVersion: runState.lastAppliedConfigVersion,
      },
      pendingWakeup: deps.pendingWakeup,
      pendingHumanWait: deps.pendingHumanWait,
    };
  });
}
