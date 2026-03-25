import type { ConversationSnapshot } from 'conversationalist';
import type { ObservableLike, Subscription } from 'lifecycle';
import type { ActiveRun, FinishReason, StepResult, TokenUsage } from 'operative';

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
