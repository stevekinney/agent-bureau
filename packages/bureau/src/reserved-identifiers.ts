/**
 * COR-851 — the workflow-id prefixes durable event history records its owners
 * under, which an ordinary caller may not choose for a workflow either. The
 * prefixes durable goals own live in `@lostgradient/operative`
 * (`goal-reserved-identifiers.ts`).
 */
import { reservedIdentifierReason } from '@lostgradient/operative';

/**
 * Event history records a run, a session, and a schedule under a workflow-shaped
 * id (`run:<id>`, `session:<id>`, `schedule:<id>`; see `encodeOwner`). A child
 * run's workflow id is its run id, and Weft deletes every event carrying a
 * workflow's id when it purges that workflow, so a child named `run:<victim>`
 * would erase the victim's history when it is purged (and fabricate a retained
 * run owner while it lives). These prefixes are therefore refused for an id that
 * names a workflow.
 */
export const EVENT_OWNER_WORKFLOW_ID_PREFIXES: readonly string[] = [
  'run:',
  'session:',
  'schedule:',
];

/**
 * Why `id` may not be chosen by an ordinary caller as the id of a workflow
 * (`kind`); `undefined` when it may. Covers the goal prefixes and the
 * event-history owner prefixes.
 */
export function reservedWorkflowIdentifierReason(kind: string, id: string): string | undefined {
  const goalReason = reservedIdentifierReason(kind, id);
  if (goalReason !== undefined) return goalReason;
  const prefix = EVENT_OWNER_WORKFLOW_ID_PREFIXES.find((candidate) => id.startsWith(candidate));
  return prefix === undefined
    ? undefined
    : `reserved-identifier: ${kind} "${id}" begins with "${prefix}", a prefix durable event history records its owners under; choose another.`;
}
