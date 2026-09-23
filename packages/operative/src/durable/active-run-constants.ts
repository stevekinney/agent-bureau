/**
 * Tag stamped on every durable run launched by the operative scheduler (via
 * {@link startDurableRunResult}). Weft 0.7 recovery reads it from
 * `WorkflowServicesResolverInfo.launchOptions.tags` to discriminate
 * scheduler-origin runs from genuine session runs — a scheduler run is a
 * live-process concern with no bureau session behind it, so on a crash it is
 * cancelled, never reattached as a session run. Direct handle metadata carries
 * the same tag; the boot sweep still uses the stable id prefix so legacy untagged
 * suspended residue remains cleanupable. Exported from the `@lostgradient/operative` root entry point
 * so the gateway recovery path can import it.
 */
export const SCHEDULER_ORIGIN_TAG = 'bureau:scheduler-origin' as const;

/**
 * Id prefix for durable scheduler runs (`scheduler-run-<taskId>-<n>`). A scheduler
 * run uses a synthetic id as BOTH its runId and its phantom sessionId. New
 * recovery resolver calls use {@link SCHEDULER_ORIGIN_TAG}; the prefix remains
 * for suspended-residue cleanup and for legacy persisted runs whose launch
 * metadata predates the tag-aware resolver context.
 */
export const SCHEDULER_RUN_ID_PREFIX = 'scheduler-run-' as const;

/**
 * Terminal `WorkflowStatus` values (Weft `identity.ts`) — everything that is
 * NOT one of `'pending' | 'running' | 'suspended'`. Used by `closed()`'s
 * post-cancel re-read (AC7 / a code-review finding on the AB-204 pull
 * request): `engine.cancel` resolving is not proof the cancellation record
 * committed, and a re-read that still reports a NONTERMINAL status means
 * the workflow has not actually stopped yet — reporting `completed` there
 * would let a caller proceed while the workflow is still active.
 */
const TERMINAL_WORKFLOW_STATUSES = new Set<string>([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

export function isTerminalWorkflowStatus(status: string): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}
