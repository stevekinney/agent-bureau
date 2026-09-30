/**
 * Thrown (as a rejection) by `Scheduler.awaitTask` when the id has no retained
 * outcome and no in-flight task: it either aged out of the retention window
 * (`'expired'`) or was never tracked (`'not-found'`).
 */
export class SchedulerTaskLookupError extends Error {
  override readonly name = 'SchedulerTaskLookupError';

  constructor(
    readonly taskId: string,
    readonly reason: 'expired' | 'not-found',
  ) {
    super(
      reason === 'expired'
        ? `Scheduler task "${taskId}" has expired from retention`
        : `Scheduler task "${taskId}" was not found`,
    );
  }
}
