import type { EventMap } from 'lifecycle';

import type { Action } from './types';

/**
 * Dispatched every time an operative event is recorded as an Action
 * in the store's action log.
 */
export class StoreActionEvent extends Event {
  static readonly type = 'action' as const;
  readonly action: Action;

  constructor(action: Action) {
    super(StoreActionEvent.type);
    this.action = action;
  }
}

/**
 * Dispatched when an ActiveRun is registered with the store.
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
 * Dispatched when a run is removed from the store via removeRun().
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
 * Maps event type strings to their corresponding Event subclasses
 * for the store's CompletableEventTarget.
 */
export interface StoreEventMap extends EventMap {
  [StoreActionEvent.type]: StoreActionEvent;
  [RunRegisteredEvent.type]: RunRegisteredEvent;
  [RunRemovedEvent.type]: RunRemovedEvent;
}
