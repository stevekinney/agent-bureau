/**
 * COR-851 — read a durable run's terminal result without driving it.
 *
 * `resumeDurableRunResult` resumes the workflow; a goal controller only wants to
 * know how an attempt's run ended, and the attempt may have ended in another
 * process, so this reads the engine's stored state and rebuilds the full
 * `RunResult` from the checkpoint the same way every other durable entry point
 * does.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';

import { computeCostEstimate } from '../run-lifecycle';
import type { FinishReason, RunOptions, RunResult } from '../types';
import type { DurableActiveRunContext } from './active-run-adapter';
import {
  readRunStateFromCheckpoint,
  reconstructRunResult,
} from './active-run-result-reconstruction';
import { normalizeAgentRunWorkflowResult } from './run-workflow-result';

export type DurableRunReading =
  /** The workflow completed: the full result, rebuilt from its summary and checkpoint. */
  | { readonly status: 'completed'; readonly result: RunResult }
  /**
   * The workflow ended without a summary (cancelled, failed, or timed out). The
   * partial result is rebuilt from whatever the checkpoint holds, and
   * `finishReason` says how the run is to be read.
   */
  | {
      readonly status: 'ended';
      readonly workflowStatus: 'cancelled' | 'failed' | 'timed-out';
      readonly finishReason: FinishReason;
      readonly detail: string | undefined;
      readonly result: RunResult;
    }
  /** The workflow is still running, parked, or suspended. */
  | { readonly status: 'not-terminal' }
  /** No such workflow. */
  | { readonly status: 'missing' };

export interface ReadDurableRunResultOptions {
  readonly runtime: RuntimeServices;
  /** Folded into the rebuilt result's `costEstimate`, as the live run would have. */
  readonly costEstimation?: RunOptions['costEstimation'] | undefined;
}

function withCost(result: RunResult, options: ReadDurableRunResultOptions): RunResult {
  if (result.costEstimate !== undefined) return result;
  const costEstimate = computeCostEstimate(result.usage, options.costEstimation);
  return costEstimate === undefined ? result : { ...result, costEstimate };
}

/**
 * Reads how `runId`'s workflow ended. Never starts, resumes, or cancels anything.
 * Rejects when the engine or the checkpoint cannot be read: the callers account a
 * goal's budget and validate its transcript from this, so a read failure must
 * retry rather than read as an empty run.
 */
export async function readDurableRunResult(
  context: DurableActiveRunContext,
  runId: string,
  options: ReadDurableRunResultOptions,
): Promise<DurableRunReading> {
  const state = await context.engine.get(runId);
  if (state === null) return { status: 'missing' };
  if (state.status === 'completed') {
    const summary = normalizeAgentRunWorkflowResult(state.result);
    const { result } = await reconstructRunResult(context, runId, summary, options.runtime, {
      strictCheckpointRead: true,
    });
    return { status: 'completed', result: withCost(result, options) };
  }
  if (state.status !== 'cancelled' && state.status !== 'failed' && state.status !== 'timed-out') {
    return { status: 'not-terminal' };
  }
  const { runState, conversation } = await readRunStateFromCheckpoint(
    context,
    runId,
    options.runtime,
  );
  const finishReason: FinishReason = state.status === 'cancelled' ? 'aborted' : 'error';
  const result: RunResult = {
    conversation,
    steps: runState.steps,
    content: runState.lastContent,
    usage: runState.totalUsage,
    finishReason,
  };
  return {
    status: 'ended',
    workflowStatus: state.status,
    finishReason,
    detail: state.error,
    result: withCost(result, options),
  };
}
