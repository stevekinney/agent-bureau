import type { NormalizeActivities, WorkflowContext, WorkflowOperation } from '@lostgradient/weft';
import { Conversation } from 'conversationalist';
import { createDefaultRuntimeServices } from 'lifecycle';

import type { FinishReason } from '../types';
import {
  buildSignalContinuationInput,
  buildWakeupContinuationInput,
  renderSignalContinuation,
  renderWakeupContinuation,
} from './continuation-input';
import { runDepsFrom } from './run-workflow-input';
import type { createStorageActivities } from './storage-activities';
import type { PendingHumanWait, PendingWakeup, RunCursor } from './types';

export type WorkflowParkContext = Pick<
  WorkflowContext<NormalizeActivities<ReturnType<typeof createStorageActivities>>>,
  'services' | 'sleep' | 'waitForSignal' | 'memo' | 'run'
>;

export interface WorkflowParkState {
  snapshot: ReturnType<Conversation['snapshot']>;
  cursor: RunCursor;
  finishReason: FinishReason;
  errorMessage?: string;
  abortReason?: string;
  schemaValidation?: { success: boolean; error?: string };
  output?: unknown;
  tripwire?: {
    guardrailName: string;
    category: string;
    phase: 'input' | 'output';
    confidence: number;
    detail?: string;
  };
  stoppedEarly: boolean;
  pendingWakeup?: PendingWakeup;
  pendingHumanWait?: PendingHumanWait;
  lastWakeupNote?: string;
  lastHumanWaitSignal?: string;
  runId: string;
}

export function* runWorkflowPark(
  ctx: WorkflowParkContext,
  state: WorkflowParkState,
): WorkflowOperation<boolean> {
  const isFailureOutcome =
    state.finishReason === 'error' ||
    state.finishReason === 'aborted' ||
    state.finishReason === 'elicitation-denied' ||
    state.finishReason === 'budget-exceeded' ||
    state.finishReason === 'tripwire';

  if (!isFailureOutcome && state.pendingWakeup !== undefined) {
    const requestedDuration = state.pendingWakeup.duration;
    const note = state.pendingWakeup.note;
    yield* ctx.sleep(requestedDuration);
    state.pendingWakeup = undefined;
    state.lastWakeupNote = note;
    const firedAt = yield* ctx.memo(`wakeup-fired-at-${state.cursor.step}`, () =>
      Promise.resolve(
        (
          runDepsFrom(ctx.services).options.runtime ?? createDefaultRuntimeServices()
        ).clock.nowISO(),
      ),
    );
    const renderedMessage = renderWakeupContinuation(
      buildWakeupContinuationInput(requestedDuration, note, firedAt),
    );
    state.snapshot = (() => {
      const resumedConversation = Conversation.from(state.snapshot, {
        runtime: runDepsFrom(ctx.services).options.runtime ?? createDefaultRuntimeServices(),
      });
      resumedConversation.appendUserMessage(renderedMessage);
      return resumedConversation.snapshot();
    })();
    yield* ctx.run('saveConversation', { runId: state.runId, snapshot: state.snapshot });
    resetTerminalState(state);
    return true;
  }

  if (!isFailureOutcome && state.pendingHumanWait !== undefined) {
    const signalName = state.pendingHumanWait.signalName;
    const payload = yield* ctx.waitForSignal(signalName);
    state.pendingHumanWait = undefined;
    state.lastHumanWaitSignal = signalName;
    const deliveredAt = yield* ctx.memo(`signal-delivered-at-${state.cursor.step}`, () =>
      Promise.resolve(
        (
          runDepsFrom(ctx.services).options.runtime ?? createDefaultRuntimeServices()
        ).clock.nowISO(),
      ),
    );
    const renderedMessage = renderSignalContinuation(
      buildSignalContinuationInput(signalName, payload, deliveredAt),
    );
    state.snapshot = (() => {
      const resumedConversation = Conversation.from(state.snapshot, {
        runtime: runDepsFrom(ctx.services).options.runtime ?? createDefaultRuntimeServices(),
      });
      resumedConversation.appendUserMessage(renderedMessage);
      return resumedConversation.snapshot();
    })();
    yield* ctx.run('saveConversation', { runId: state.runId, snapshot: state.snapshot });
    resetTerminalState(state);
    return true;
  }

  return false;
}

function resetTerminalState(state: WorkflowParkState): void {
  state.finishReason = 'maximum-steps';
  state.errorMessage = undefined;
  state.abortReason = undefined;
  state.schemaValidation = undefined;
  state.output = undefined;
  state.tripwire = undefined;
  state.stoppedEarly = false;
}
