import { executeLoop } from './loop';
import type { RunOptions, RunResult } from './types';

/**
 * Runs the agent loop to completion without event emission.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  return executeLoop(options);
}
