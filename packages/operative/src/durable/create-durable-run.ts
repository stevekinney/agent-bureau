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
 * Start (or resume) a durable agent run and await only its thin summary.
 *
 * This is the minimal headless entry: it drives the `agentRun` workflow on a
 * real engine and returns the {@link AgentRunWorkflowResult} summary, without
 * building an `ActiveRun` event surface. It registers the run's non-serializable
 * behavior in the deps registry, starts the workflow, awaits completion, then
 * clears the deps. Because the run is driven start-to-finish in this process,
 * the deps live for the whole run — so no cross-process re-injection is needed
 * here (that is seam #5, which only applies to runs recovered by a *different*
 * process via `engine.recoverAll`).
 *
 * For the full event surface (the path the default `createRun` now routes
 * through when an engine is present), use {@link createDurableActiveRun} via
 * `createRun(options, durable)` — it emits the complete operative event stream,
 * including the run-level lifecycle, so gateway's `run.completed` /
 * `step.completed` subscribers see a durable run exactly as an in-memory one.
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
