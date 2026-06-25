import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';

/**
 * Polls `condition` up to `maximumAttempts` times, yielding one macrotask
 * between tries. Each yield also drains Weft's deferred inline-launch queue
 * (its `setTimeout(0)` starts) so durable runs can advance — bounded, not a
 * fixed wall-clock sleep that flakes on loaded hosts.
 *
 * Throws with `failureMessage` when the condition is not met within the limit.
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  failureMessage: string,
  maximumAttempts = 50,
  yieldTurn: () => Promise<void> = yieldToPortableEventLoop,
): Promise<void> {
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    if (await condition()) {
      return;
    }
    await yieldTurn();
  }

  throw new Error(failureMessage);
}

/**
 * A minimal interface for any run-store-like object that can look up a run by
 * id. Works with both the operative `Store` and the gateway `Bureau`.
 */
export interface RunLookup {
  getRun(id: string): { status: string } | undefined;
}

/**
 * Waits until `store.getRun(runId)` satisfies `predicate`, defaulting to
 * waiting for any non-`running` status. Returns the settled run state.
 *
 * Works with any object that exposes `getRun(id): { status: string } | undefined`
 * — operative's `Store` and gateway's `Bureau` both qualify structurally.
 */
export async function waitForRunState<R extends { status: string }>(
  store: { getRun(id: string): R | undefined },
  runId: string,
  predicate: (run: R) => boolean = (run) => run.status !== 'running',
): Promise<R> {
  let matchingRun: R | undefined;
  await waitForCondition(() => {
    const run = store.getRun(runId);
    if (run && predicate(run)) {
      matchingRun = run;
      return true;
    }
    return false;
  }, `Run ${runId} did not reach the expected state`);

  return matchingRun!;
}
