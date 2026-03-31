import type { RunOptions, RunResult } from '../types';

/**
 * Priority levels for scheduler tasks, from highest (1) to lowest (4).
 */
export type SchedulerPriority = 'immediate' | 'scheduled' | 'background' | 'ambient';

/**
 * Numeric weights for priority comparison. Lower numbers are higher priority.
 */
export const PRIORITY_WEIGHT: Record<SchedulerPriority, number> = {
  immediate: 1,
  scheduled: 2,
  background: 3,
  ambient: 4,
};

/**
 * Returns true if priority `a` is strictly higher than priority `b`.
 */
export function isHigherPriority(a: SchedulerPriority, b: SchedulerPriority): boolean {
  return PRIORITY_WEIGHT[a] < PRIORITY_WEIGHT[b];
}

export type SchedulerRunOptions = Omit<RunOptions, 'generate' | 'toolbox'> &
  Partial<Pick<RunOptions, 'generate' | 'toolbox'>>;

/**
 * A task descriptor submitted to the scheduler.
 */
export interface SchedulerTask {
  /** Unique identifier for this task. */
  readonly id: string;
  /** Priority lane for scheduling. */
  readonly priority: SchedulerPriority;
  /** Factory that creates RunOptions when the task is dispatched. */
  readonly createRun: () => SchedulerRunOptions | Promise<SchedulerRunOptions>;
  /** Called when the task completes successfully. */
  readonly onComplete?: (result: RunResult) => void | Promise<void>;
  /** Called when the task is preempted before completion. */
  readonly onPreempted?: (reason: string) => void | Promise<void>;
  /** Whether this task should be re-queued after preemption. Default: true for background/ambient, false for immediate/scheduled. */
  readonly requeue?: boolean;
  /** Maximum number of times this task can be requeued. Default: 3. */
  readonly maxRequeues?: number;
  /** Optional metadata for logging and diagnostics. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Observable scheduler state snapshot.
 */
export interface SchedulerState {
  /** The currently executing task, if any. */
  readonly activeTask: SchedulerTaskSummary | undefined;
  /** Queued tasks grouped by priority lane. */
  readonly queued: Readonly<Record<SchedulerPriority, readonly SchedulerTaskSummary[]>>;
  /** Total number of tasks completed since scheduler start. */
  readonly completedCount: number;
  /** Total number of tasks preempted since scheduler start. */
  readonly preemptedCount: number;
  /** Whether the scheduler has no active or queued tasks. */
  readonly idle: boolean;
}

/**
 * A lightweight summary of a task for state inspection.
 */
export interface SchedulerTaskSummary {
  readonly id: string;
  readonly priority: SchedulerPriority;
  readonly metadata?: Record<string, unknown>;
}
