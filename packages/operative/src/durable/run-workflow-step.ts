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
import type { PendingHumanWait, PendingWakeup, RunCursor, StepRecord } from './types';

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
  snapshot: ReturnType<Conversation['snapshot']>,
  stepIndex: number,
  carriedAccumulators: DurableStepMemoResult['nextAccumulators'],
  runId: string,
): WorkflowOperation<DurableStepMemoResult> {
  return ctx.memo(`step-${stepIndex}`, async () => {
    const deps = runDepsFrom(ctx.services);
    deps.pendingHumanWait = undefined;
    deps.pendingWakeup = undefined;
    const conversation = Conversation.from(snapshot, {
      runtime: deps.options.runtime ?? createDefaultRuntimeServices(),
    });
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
      conversationSnapshot: conversation.snapshot(),
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
