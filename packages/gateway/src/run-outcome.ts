/**
 * Shared run-outcome classification, used by every door surface that needs
 * to know whether a settled run counts as a success or a failure —
 * OpenAI-compat chat completions (`routes/openai-compat.ts`) and the A2A
 * JSON-RPC facade (`routes/a2a.ts`).
 *
 * A run that fails with `'budget-exceeded'` or `'elicitation-denied'` (or
 * trips a guardrail with `'tripwire'`) arrives via `run.completed` and lands
 * in the store as status `'completed'` — the store only marks `'error'` when
 * status was already error — so a status-only check would misreport a
 * failed run as a success. Discriminate by `finishReason` instead.
 */

/** Finish reasons that indicate the run did not succeed. */
const FAILURE_FINISH_REASONS = new Set([
  'error',
  'budget-exceeded',
  'elicitation-denied',
  'tripwire',
]);

/**
 * Returns `true` when a settled run (`status` is no longer `'running'`)
 * counts as a failure — either the store already marked it `'error'`, or it
 * settled `'completed'` with a failure `finishReason`.
 */
export function isRunFailure(detail: {
  status: string;
  finishReason: string | undefined;
}): boolean {
  return (
    detail.status === 'error' ||
    (detail.finishReason !== undefined && FAILURE_FINISH_REASONS.has(detail.finishReason))
  );
}
