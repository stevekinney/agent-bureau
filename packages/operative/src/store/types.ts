import type { ConversationSnapshot } from 'conversationalist';
import type { ObservableLike, Subscription } from 'lifecycle';

import type { ActiveRun } from '../create-run';
import type { FinishReason, StepResult, TokenUsage } from '../types';
import type { StoreEventMap } from './events';

export type RunStatus = 'running' | 'completed' | 'error' | 'aborted';

export interface Action {
  readonly sequence: number;
  readonly runId: string;
  readonly type: string;
  readonly detail: unknown;
  readonly timestamp: number;
}

export interface RunState {
  readonly id: string;
  readonly status: RunStatus;
  readonly steps: readonly StepResult[];
  readonly usage: TokenUsage;
  readonly finishReason: FinishReason | undefined;
  readonly error: unknown;
  readonly snapshots: readonly ConversationSnapshot[];
  readonly actions: readonly Action[];
  readonly activeRun: ActiveRun;
}

export interface StoreState {
  readonly runs: ReadonlyMap<string, RunState>;
  readonly actions: readonly Action[];
}

export interface StoreOptions {
  maxActions?: number;
  maxSnapshots?: number;
}

export type StoreListener = (state: StoreState, action: Action) => void;
export type Unsubscribe = () => void;

export type StoreEventType = keyof StoreEventMap & string;

export interface Store {
  register(activeRun: ActiveRun, id?: string): string;
  getState(): StoreState;
  getRun(id: string): RunState | undefined;

  /**
   * Appends a synthetic {@link Action} to `runId`'s action log outside the
   * normal `activeRun.toObservable()` flow (AB-12 run-inspector timeline).
   *
   * Some journal-worthy transitions never pass through a run's own event
   * emitter — most notably durable-recovery reattachment, which fires
   * before `register`'s subscription exists to observe it, and workflow
   * version-mismatch detection, which is reported via a plain callback (see
   * `WorkflowVersionMismatchEvent`'s JSDoc) rather than the per-run
   * `CombinedOperativeEventMap`. `recordAction` gives callers a supported
   * way to stamp those transitions into the same sequenced action log the
   * observable-driven path uses, so timeline consumers see one ordered
   * stream regardless of origin.
   *
   * A no-op when `runId` is not registered (there is no `RunState` to append
   * to) — mirrors `getRun`'s "no throw on unknown id" convention.
   */
  recordAction(runId: string, type: string, detail: unknown): void;

  /** Convenience subscribe overload: listener receives (state, action) on every action. */
  subscribe(listener: StoreListener): Unsubscribe;
  /** EventTarget-style subscribe for a single event type. */
  subscribe<K extends keyof StoreEventMap & string>(
    type: K,
    observerOrNext?:
      | {
          next?: (value: StoreEventMap[K]) => void;
          error?: (err: unknown) => void;
          complete?: () => void;
        }
      | ((value: StoreEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;

  addEventListener<K extends keyof StoreEventMap & string>(
    type: K,
    listener: ((event: StoreEventMap[K]) => void) | null,
    options?: boolean | AddEventListenerOptions,
  ): void;

  removeEventListener<K extends keyof StoreEventMap & string>(
    type: K,
    listener: ((event: StoreEventMap[K]) => void) | null,
    options?: boolean | EventListenerOptions,
  ): void;

  on<K extends keyof StoreEventMap & string>(type: K): ObservableLike<StoreEventMap[K]>;

  once<K extends keyof StoreEventMap & string>(
    type: K,
    listener: (event: StoreEventMap[K]) => void,
  ): void;

  toObservable(): ObservableLike<StoreEventMap[keyof StoreEventMap & string]>;

  events<K extends keyof StoreEventMap & string>(type: K): AsyncIterableIterator<StoreEventMap[K]>;

  complete(): void;
  readonly completed: boolean;

  removeRun(id: string): void;
  deregister(id: string): void;
  dispose(): void;
}
