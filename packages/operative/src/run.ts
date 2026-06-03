import type { DurableRunRouting } from './create-run';
import { createDurableActiveRun } from './durable/active-run-adapter';
import { executeLoop } from './loop';
import type { RunOptions, RunResult } from './types';

/**
 * Runs the agent loop to completion without event emission.
 *
 * When `durable` is provided, the run is driven through the Weft durable engine
 * (checkpointed + resumable) and its result is awaited; otherwise the in-memory
 * loop runs. The durable path still builds an `ActiveRun` internally — `run()`
 * simply awaits its `result` and discards the event surface.
 */
export async function run(options: RunOptions, durable?: DurableRunRouting): Promise<RunResult> {
  if (durable) {
    return createDurableActiveRun(
      { engine: durable.engine, checkpointStore: durable.checkpointStore },
      { runId: durable.runId, options, prompt: durable.prompt },
    ).result;
  }
  return executeLoop(options);
}
