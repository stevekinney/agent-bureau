import type { RunOptions } from '../types';
import type { CheckpointStore } from './checkpoint-store';
import type { AnyRunEngine } from './create-run-engine';
import { clearRunDeps, registerRunDeps } from './deps-registry';
import type { AgentRunWorkflowResult } from './run-workflow';

/** Options for {@link createDurableRun}. */
export interface DurableRunOptions {
  /** A stable id for the run; also the durable workflow id (resume key). */
  runId: string;
  /** The run behavior (generate fn, toolbox, conversation seed). */
  options: RunOptions;
  /** First user message to seed a brand-new run. Ignored when resuming. */
  prompt?: string;
  /** Step cap; defaults to `options.maximumSteps` then the workflow default. */
  maximumSteps?: number;
}

/** Dependencies a {@link createDurableRun} invocation needs from composition. */
export interface DurableRunContext {
  engine: AnyRunEngine;
  checkpointStore: CheckpointStore;
}

/**
 * Start (or resume) a durable agent run and await its result.
 *
 * This is the single opt-in entry that drives the `agentRun` workflow on a
 * real engine. It performs the in-process half of the recovery contract:
 * register the run's non-serializable behavior in the deps registry, start the
 * durable workflow, await completion, then clear the deps. Because the run is
 * driven start-to-finish in this process, the deps live for the whole run — so
 * no cross-process re-injection is needed here (that is the deferred seam #5,
 * which only applies to runs recovered by a *different* process via
 * `engine.recoverAll`).
 *
 * The default `run()` / `createRun()` surface is intentionally NOT routed
 * through this path: the durable workflow does not yet emit operative's event
 * stream (seam #7), so rerouting the default would silently break event
 * subscribers. This entry is for callers that opt into durability explicitly.
 *
 * @remarks
 * TODO(weft-integration): #7 surface the per-step operative event stream from
 *   the durable path so this can become the default `createRun` implementation
 *   without breaking `run.completed`/`step.completed` subscribers.
 */
export async function createDurableRun(
  context: DurableRunContext,
  durableRun: DurableRunOptions,
): Promise<AgentRunWorkflowResult> {
  const { runId } = durableRun;

  registerRunDeps(runId, {
    options: durableRun.options,
    toolbox: durableRun.options.toolbox,
  });

  try {
    const handle = await context.engine.start('agentRun', {
      runId,
      prompt: durableRun.prompt,
      maximumSteps: durableRun.maximumSteps ?? durableRun.options.maximumSteps,
    });
    return (await handle.result()) as AgentRunWorkflowResult;
  } finally {
    clearRunDeps(runId);
  }
}
