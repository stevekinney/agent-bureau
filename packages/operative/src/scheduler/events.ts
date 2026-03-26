import type { RunResult } from '../types';
import type { SchedulerPriority, SchedulerTaskSummary } from './types';

/**
 * Emitted when a task is added to the scheduler queue.
 */
export class TaskQueuedEvent extends Event {
  static readonly type = 'task.queued' as const;

  constructor(
    readonly taskId: string,
    readonly priority: SchedulerPriority,
    readonly metadata?: Record<string, unknown>,
  ) {
    super(TaskQueuedEvent.type);
  }
}

/**
 * Emitted when a task starts executing.
 */
export class TaskDispatchedEvent extends Event {
  static readonly type = 'task.dispatched' as const;

  constructor(
    readonly taskId: string,
    readonly priority: SchedulerPriority,
  ) {
    super(TaskDispatchedEvent.type);
  }
}

/**
 * Emitted when a task finishes successfully.
 */
export class TaskCompletedEvent extends Event {
  static readonly type = 'task.completed' as const;

  constructor(
    readonly taskId: string,
    readonly result: RunResult,
  ) {
    super(TaskCompletedEvent.type);
  }
}

/**
 * Emitted when a task is aborted due to higher-priority work.
 */
export class TaskPreemptedEvent extends Event {
  static readonly type = 'task.preempted' as const;

  constructor(
    readonly taskId: string,
    readonly reason: string,
    readonly requeued: boolean,
  ) {
    super(TaskPreemptedEvent.type);
  }
}

/**
 * Emitted when a task throws an error.
 */
export class TaskFailedEvent extends Event {
  static readonly type = 'task.failed' as const;

  constructor(
    readonly taskId: string,
    readonly error: unknown,
  ) {
    super(TaskFailedEvent.type);
  }
}

/**
 * Emitted when no tasks are pending or active.
 */
export class SchedulerIdleEvent extends Event {
  static readonly type = 'scheduler.idle' as const;

  constructor() {
    super(SchedulerIdleEvent.type);
  }
}

/**
 * Emitted when the scheduler starts.
 */
export class SchedulerStartedEvent extends Event {
  static readonly type = 'scheduler.started' as const;

  constructor() {
    super(SchedulerStartedEvent.type);
  }
}

/**
 * Emitted when the scheduler stops.
 */
export class SchedulerStoppedEvent extends Event {
  static readonly type = 'scheduler.stopped' as const;

  constructor() {
    super(SchedulerStoppedEvent.type);
  }
}

/**
 * Map of scheduler event types to their event classes.
 */
export interface SchedulerEventMap {
  [TaskQueuedEvent.type]: TaskQueuedEvent;
  [TaskDispatchedEvent.type]: TaskDispatchedEvent;
  [TaskCompletedEvent.type]: TaskCompletedEvent;
  [TaskPreemptedEvent.type]: TaskPreemptedEvent;
  [TaskFailedEvent.type]: TaskFailedEvent;
  [SchedulerIdleEvent.type]: SchedulerIdleEvent;
  [SchedulerStartedEvent.type]: SchedulerStartedEvent;
  [SchedulerStoppedEvent.type]: SchedulerStoppedEvent;
}

/**
 * Union of all scheduler event type strings.
 */
export type SchedulerEventType = keyof SchedulerEventMap;

/**
 * Union of all scheduler task summary types used in state.
 */
export type { SchedulerTaskSummary };
