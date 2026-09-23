import type { RuntimeServices } from '@lostgradient/lifecycle';
import { isWeftErrorLike } from '@lostgradient/weft';
import { Conversation } from 'conversationalist';

import { AgentRunError } from '../errors';
import type { OperativeEventEmitter } from '../events';
import { UnsupportedRunResultVersionError } from '../run-envelope';
import { makeAbortResult } from '../run-lifecycle';
import { type RunResult } from '../types';
import type { DurableActiveRunContext } from './active-run-adapter';
import type { RecoveredRunHandle } from './active-run-event-surface';
import {
  classifyTimeoutMessage,
  finalizeRunResult,
  loadRunStateFromCheckpoint,
  makeInterruptedRunResult,
  reconstructRunResult,
  reconstructTerminalRunError,
} from './active-run-result-reconstruction';
import {
  type AgentRunWorkflowResult,
  normalizeAgentRunWorkflowResult,
} from './run-workflow-result';

export async function driveReattachedRun(
  context: DurableActiveRunContext,
  runId: string,
  handle: RecoveredRunHandle,
  emitter: OperativeEventEmitter,
  abortOutcome: () => Promise<boolean> | undefined,
  reachability: { unreachable: boolean },
  runtime: RuntimeServices,
): Promise<RunResult> {
  const runStartTime = runtime.monotonic.now();

  let summary: AgentRunWorkflowResult;
  try {
    summary = normalizeAgentRunWorkflowResult(await handle.result());
  } catch (error) {
    if (error instanceof UnsupportedRunResultVersionError) {
      throw error;
    }
    // An ADAPTER-INITIATED abort (bureau.abortRun → engine.cancel) that ACTUALLY
    // terminalized this run is a real terminal: fire `run.aborted` so the gateway
    // listener persists `aborted`, rather than leaving the session looking
    // `running` (committee round-2 finding 2). Classify as aborted ONLY when the
    // cancel succeeded (committee round-3 finding 1): if the cancel rejected, this
    // rejection came from a resolver/teardown failure that merely raced abort(),
    // and that owner's status must not be clobbered.
    const cancelSucceeded = await (abortOutcome() ?? Promise.resolve(false));
    if (cancelSucceeded) {
      // Reconstruct the checkpointed usage + steps (not a zeroed
      // `createRunState()`), so an abort that raced a run with prior checkpointed
      // steps reports the SAME accumulated usage the eventual terminal
      // `RunResult` would have — `loadRunStateFromCheckpoint` already tolerates a
      // failed/absent checkpoint by falling back to an empty run state +
      // conversation, satisfying the "must NOT suppress the abort lifecycle"
      // requirement (committee round-3 finding 2).
      const { runState, conversation } = await loadRunStateFromCheckpoint(context, runId, runtime);
      const lastStep = runState.steps[runState.steps.length - 1];
      return makeAbortResult(
        runState,
        conversation,
        undefined,
        emitter,
        lastStep ? lastStep.step + 1 : 0,
        'aborted',
        undefined,
        reconstructTerminalRunError({
          finishReason: 'aborted',
          steps: runState.steps.length,
          abortReason: 'aborted',
        }),
      );
    }
    // A `history.maxEvents` circuit-breaker (or a genuine execution-deadline
    // timeout) rejects `handle.result()` with a `WorkflowTimeoutError`. On a
    // RECOVERED run this is an ENGINE-policy terminal that fired AFTER recovery —
    // nothing else owns reconciling it (unlike a pre-replay resolver failure,
    // which the resolver already reconciled to `error`, or an EngineDisposedError
    // teardown). So, symmetric with `driveDurableRun`, classify it as `error` and
    // fire the terminal lifecycle here; otherwise the session is left stuck
    // `running` for a run that is actually terminal (Bugbot #38). `hooks: undefined`
    // per the reattach contract; the conversation comes from the checkpoint.
    if (isWeftErrorLike(error) && error.code === 'WorkflowTimeoutError') {
      const message = await classifyTimeoutMessage(context, runId, error);
      // Same checkpointed-usage reconstruction as the abort branch above — a
      // circuit-breaker/deadline timeout after prior checkpointed steps must not
      // under-report the run's accumulated usage.
      const { runState, conversation } = await loadRunStateFromCheckpoint(context, runId, runtime);
      return finalizeRunResult({
        finishReason: 'error',
        runState,
        conversation,
        hooks: undefined,
        emitter,
        runStartTime,
        runtime,
        errorMessage: message,
      });
    }
    // Otherwise write-free. EngineDisposedError = bureau teardown mid-resume
    // (leave running for a later boot). Any other rejection = the engine
    // terminally failed this run pre-replay because the resolver returned
    // services-unavailable, and the resolver ALREADY reconciled that session to
    // `error`. Firing a terminal lifecycle here would clobber what the
    // resolver/teardown owns, so we only log and resolve quiet.
    if (isWeftErrorLike(error) && error.code === 'EngineDisposedError') {
      // AB-204 AC8: closed() classifies this as unresolved/unreachable,
      // never failed — see `reachability`'s doc comment above.
      reachability.unreachable = true;
    } else {
      console.error(
        `[operative] Reattached durable run "${runId}" did not settle cleanly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return makeInterruptedRunResult(new Conversation(undefined, { runtime }));
  }

  const {
    result,
    runState,
    conversation: durableConversation,
  } = await reconstructRunResult(context, runId, summary, runtime);

  // `hooks: undefined` — the recovered run's `onRunComplete`/etc. hooks are
  // non-serializable run behavior; they were rebuilt by the resolver into
  // `ctx.services`, which the bureau never gets back. So reattach fires the
  // terminal EVENTS (which gateway's session-persistence listeners need) but not
  // the run HOOKS — matching the old `settleRecoveredRun`, which persisted the
  // session directly and never fired operative run hooks for a recovered run.
  return finalizeRunResult({
    finishReason: result.finishReason,
    runState,
    conversation: durableConversation,
    hooks: undefined,
    emitter,
    runStartTime,
    runtime,
    errorMessage: summary.errorMessage,
    abortReason: summary.abortReason,
    schemaValidation: summary.schemaValidation,
    output: summary.output,
    tripwire: summary.tripwire,
    terminalError: result.error instanceof AgentRunError ? result.error : undefined,
  });
}

/**
 * Drive one durable run: fire the start lifecycle, start (or resume) the
 * workflow, await it, reconstruct the `RunResult`, and fire the completion
 * lifecycle — all via the shared `run-lifecycle.ts` so events/hooks match the
 * in-memory loop exactly.
 */
