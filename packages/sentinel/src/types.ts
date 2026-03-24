import type { ConversationSnapshot } from 'conversationalist';
import type {
  AddEventListenerOptionsLike,
  AsyncIteratorOptions,
  EmissionEvent,
} from 'event-emission';
import type { ObservableLike, Observer, Subscription } from 'event-emission/types';
import type { ActiveRun, FinishReason, StepResult, TokenUsage } from 'operative';

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

export interface StoreEvents {
  action: Action;
  'run.registered': { runId: string };
  'run.removed': { runId: string };
}

export type StoreEventType = keyof StoreEvents;

export interface Store {
  register(activeRun: ActiveRun, id?: string): string;
  getState(): StoreState;
  getRun(id: string): RunState | undefined;

  // Legacy subscribe overload
  subscribe(listener: StoreListener): Unsubscribe;
  // Event-emission subscribe overload
  subscribe<K extends StoreEventType>(
    type: K,
    observerOrNext?:
      | Observer<EmissionEvent<StoreEvents[K], K>>
      | ((value: EmissionEvent<StoreEvents[K], K>) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;

  addEventListener<K extends StoreEventType>(
    type: K,
    listener: (event: EmissionEvent<StoreEvents[K], K>) => void | Promise<void>,
    options?: AddEventListenerOptionsLike,
  ): () => void;

  on<K extends StoreEventType>(
    type: K,
    options?: AddEventListenerOptionsLike | boolean,
  ): ObservableLike<EmissionEvent<StoreEvents[K], K>>;

  once<K extends StoreEventType>(
    type: K,
    listener: (event: EmissionEvent<StoreEvents[K], K>) => void | Promise<void>,
    options?: Omit<AddEventListenerOptionsLike, 'once'>,
  ): () => void;

  toObservable(): ObservableLike<EmissionEvent<StoreEvents[keyof StoreEvents]>>;

  events<K extends StoreEventType>(
    type: K,
    options?: AsyncIteratorOptions,
  ): AsyncIterableIterator<EmissionEvent<StoreEvents[K], K>>;

  complete(): void;
  readonly completed: boolean;

  removeRun(id: string): void;
  deregister(id: string): void;
  dispose(): void;
}
