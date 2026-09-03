import type {
  ScheduleCancelledEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
} from '@lostgradient/operative';
import type { Action } from '@lostgradient/operative/store';
import type { EventMap } from 'lifecycle';

/**
 * Fired when the store records an action from a run.
 */
export class ActionEvent extends Event {
  static readonly type = 'action' as const;

  readonly action: Action;

  constructor(action: Action) {
    super(ActionEvent.type);
    this.action = action;
  }
}

/**
 * Fired when a new run is registered in the store.
 */
export class RunRegisteredEvent extends Event {
  static readonly type = 'run.registered' as const;

  readonly runId: string;

  constructor(runId: string) {
    super(RunRegisteredEvent.type);
    this.runId = runId;
  }
}

/**
 * Fired when a run is removed from the store.
 */
export class RunRemovedEvent extends Event {
  static readonly type = 'run.removed' as const;

  readonly runId: string;

  constructor(runId: string) {
    super(RunRemovedEvent.type);
    this.runId = runId;
  }
}

/**
 * Fired when the bureau is disposed.
 */
export class BureauDisposedEvent extends Event {
  static readonly type = 'bureau.disposed' as const;

  constructor() {
    super(BureauDisposedEvent.type);
  }
}

/**
 * Maps event type strings to their corresponding Event subclasses.
 *
 * `schedule.paused`/`resumed`/`cancelled`/`failed`/`completed` (AB-223) are
 * defined in `@lostgradient/operative` (alongside `schedule.created`/
 * `schedule.wakeup`) rather than here, but dispatched on THIS bureau-level
 * emitter — not a per-run operative emitter — because a schedule pause/
 * resume/cancel and a scheduled fire's terminal outcome are bureau-level
 * facts with no owning per-run surface (scheduled fires are headless; see
 * `runtime-composition.ts`'s `buildScheduledRunServices`).
 */
export interface BureauEventMap extends EventMap {
  [ActionEvent.type]: ActionEvent;
  [RunRegisteredEvent.type]: RunRegisteredEvent;
  [RunRemovedEvent.type]: RunRemovedEvent;
  [BureauDisposedEvent.type]: BureauDisposedEvent;
  'schedule.paused': SchedulePausedEvent;
  'schedule.resumed': ScheduleResumedEvent;
  'schedule.cancelled': ScheduleCancelledEvent;
  'schedule.failed': ScheduleFailedEvent;
  'schedule.completed': ScheduleCompletedEvent;
}
