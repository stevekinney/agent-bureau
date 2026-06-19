import type { EventMap } from 'lifecycle';
import type { Action } from 'operative/store';

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
 */
export interface BureauEventMap extends EventMap {
  [ActionEvent.type]: ActionEvent;
  [RunRegisteredEvent.type]: RunRegisteredEvent;
  [RunRemovedEvent.type]: RunRemovedEvent;
  [BureauDisposedEvent.type]: BureauDisposedEvent;
}
