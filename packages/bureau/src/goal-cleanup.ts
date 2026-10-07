/**
 * COR-851 — applies the bureau's checkpoint retention to everything a goal ran,
 * shared by `close()` and the boot sweep that finishes a closure whose cleanup
 * was interrupted.
 */

import type { CleanupAcknowledgement } from '@lostgradient/operative';

import type { GoalControlDependencies } from './goal-controller';
import { goalAttemptRunId, type GoalState, goalWorkflowId } from './goal-state';

const CLEANUP_RANK: Record<CleanupAcknowledgement['status'], number> = {
  'not-required': 0,
  completed: 1,
  unresolved: 2,
  failed: 3,
};

/** The least favorable of the acknowledgements, so one part that could not be pruned is never reported as done. */
function worstCleanup(acknowledgements: readonly CleanupAcknowledgement[]): CleanupAcknowledgement {
  return acknowledgements.reduce<CleanupAcknowledgement>(
    (worst, next) => (CLEANUP_RANK[next.status] > CLEANUP_RANK[worst.status] ? next : worst),
    { status: 'not-required' },
  );
}

/** Whether every part was pruned or needed nothing, so nothing is owed any longer. */
export const isCleanupDone = (acknowledgement: CleanupAcknowledgement): boolean =>
  acknowledgement.status === 'completed' || acknowledgement.status === 'not-required';

type CleanupDependencies = Pick<
  GoalControlDependencies,
  'getEngine' | 'forwarder' | 'cleanupWorkflow'
>;

/** One workflow's history, pruned under the bureau's retention; `not-required` when there is no such workflow. */
async function cleanUpWorkflow(
  dependencies: CleanupDependencies,
  engine: NonNullable<ReturnType<CleanupDependencies['getEngine']>>,
  workflowId: string,
): Promise<CleanupAcknowledgement> {
  try {
    if ((await engine.get(workflowId)) === null) return { status: 'not-required' };
    return await dependencies.cleanupWorkflow(workflowId);
  } catch (error) {
    return { status: 'failed', error };
  }
}

/**
 * The checkpoint history of everything the goal ran, pruned under the bureau's
 * retention: the controller workflow and every attempt's run (at most
 * `maximumAttempts` of them). It happens at closing because a closed goal is
 * terminal, so its controller has consumed every attempt's ending, the
 * forwarder and validator have read what they needed, and the goal's session
 * holds the transcripts. Pruning keeps the newest checkpoints, which is all a
 * later read of a finished run uses.
 *
 * The acknowledgement is the worst of the parts, so a part that could not be
 * pruned is never reported as done and is retried by the next `close()` or the
 * next boot: `failed`, then `unresolved`, then `completed` when anything was
 * pruned, and `not-required` when nothing needed it. An attempt that never
 * started has no workflow, and one the goal does not own reads as absent.
 */
export async function cleanUpGoal(
  dependencies: CleanupDependencies,
  record: GoalState,
): Promise<CleanupAcknowledgement> {
  // No engine is not no workflow: they may exist and simply cannot be looked
  // for from here, so their history is not known to need nothing.
  const engine = dependencies.getEngine();
  if (engine === undefined) return { status: 'unresolved', reason: 'unreachable' };
  // Not while a send the forwarder already has under way could still read an
  // attempt's checkpoint.
  await dependencies.forwarder.drain();
  const workflowIds = [
    goalWorkflowId(record.goalRunId),
    ...Array.from({ length: record.bounds.maximumAttempts }, (_, attemptIndex) =>
      goalAttemptRunId(record.goalRunId, attemptIndex),
    ),
  ];
  const acknowledgements: CleanupAcknowledgement[] = [];
  for (const workflowId of workflowIds) {
    acknowledgements.push(await cleanUpWorkflow(dependencies, engine, workflowId));
  }
  return worstCleanup(acknowledgements);
}
