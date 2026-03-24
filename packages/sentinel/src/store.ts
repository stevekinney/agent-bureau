import type { EmissionEvent } from 'event-emission';
import { createEventTarget } from 'event-emission';
import type { Observer, Subscription } from 'event-emission/types';
import type { RunResult, StepResult, TokenUsage } from 'operative';

import type {
  Action,
  RunState,
  Store,
  StoreEvents,
  StoreEventType,
  StoreListener,
  StoreOptions,
  StoreState,
  Unsubscribe,
} from './types';

function addUsage(accumulated: TokenUsage, incoming: TokenUsage | undefined): TokenUsage {
  if (!incoming) return accumulated;
  return {
    prompt: accumulated.prompt + incoming.prompt,
    completion: accumulated.completion + incoming.completion,
    total: accumulated.total + incoming.total,
  };
}

export function createStore(options: StoreOptions = {}): Store {
  const { maxActions, maxSnapshots } = options;
  const runs = new Map<string, RunState>();
  const actions: Action[] = [];
  const emitter = createEventTarget<StoreEvents>();
  const runSubscriptions = new Map<string, { unsubscribe: () => void }>();
  let sequenceCounter = 0;
  let idCounter = 0;

  function getState(): StoreState {
    return { runs, actions };
  }

  function getRun(id: string): RunState | undefined {
    return runs.get(id);
  }

  function appendAction(runId: string, type: string, detail: unknown, timestamp: number): Action {
    const action: Action = {
      sequence: sequenceCounter++,
      runId,
      type,
      detail,
      timestamp,
    };
    actions.push(action);
    if (maxActions !== undefined && actions.length > maxActions) {
      actions.splice(0, actions.length - maxActions);
    }

    const runState = runs.get(runId);
    if (runState) {
      const updatedActions = [...runState.actions, action];
      runs.set(runId, { ...runState, actions: updatedActions });
    }

    return action;
  }

  function register(activeRun: import('operative').ActiveRun, id?: string): string {
    const runId = id ?? `run-${++idCounter}`;

    const initialState: RunState = {
      id: runId,
      status: 'running',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason: undefined,
      error: undefined,
      snapshots: [],
      actions: [],
      activeRun,
    };

    runs.set(runId, initialState);

    const observable = activeRun.toObservable();
    const subscription = observable.subscribe({
      next(event) {
        const eventType = event.type as string;
        const eventDetail = event.detail;
        const timestamp = event.timeStamp;

        const action = appendAction(runId, eventType, eventDetail, timestamp);
        // Re-read after appendAction updated the run's actions list
        let updated = runs.get(runId);
        if (!updated) return;

        switch (eventType) {
          case 'step.generated': {
            const stepDetail = eventDetail as { usage?: TokenUsage };
            updated = {
              ...updated,
              usage: addUsage(updated.usage, stepDetail.usage),
            };
            break;
          }
          case 'step.completed': {
            const stepResult = eventDetail as StepResult;
            const snapshot = stepResult.conversation.snapshot();
            updated = {
              ...updated,
              steps: [...updated.steps, stepResult],
              snapshots: [...updated.snapshots, snapshot],
            };
            break;
          }
          case 'run.completed': {
            const runResult = eventDetail as RunResult;
            const snapshot = runResult.conversation.snapshot();
            updated = {
              ...updated,
              status: updated.status === 'error' ? 'error' : 'completed',
              finishReason: runResult.finishReason,
              error: updated.error ?? runResult.error,
              snapshots: [...updated.snapshots, snapshot],
            };
            break;
          }
          case 'run.error': {
            const errorDetail = eventDetail as { error: unknown };
            updated = {
              ...updated,
              status: 'error',
              error: errorDetail.error,
            };
            break;
          }
          case 'run.aborted': {
            updated = {
              ...updated,
              status: 'aborted',
            };
            break;
          }
        }

        if (maxSnapshots !== undefined && updated.snapshots.length > maxSnapshots) {
          updated = {
            ...updated,
            snapshots: updated.snapshots.slice(-maxSnapshots),
          };
        }

        runs.set(runId, updated);
        emitter.emit('action', action);
      },
    });

    runSubscriptions.set(runId, subscription);
    emitter.emit('run.registered', { runId });
    return runId;
  }

  type StoreEventObserverOrNext<K extends StoreEventType> =
    | Observer<EmissionEvent<StoreEvents[K], K>>
    | ((value: EmissionEvent<StoreEvents[K], K>) => void);

  function subscribe(listener: StoreListener): Unsubscribe;
  function subscribe<K extends StoreEventType>(
    type: K,
    observerOrNext?: StoreEventObserverOrNext<K>,
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;
  function subscribe(
    listenerOrType: StoreListener | StoreEventType,
    observerOrNext?: StoreEventObserverOrNext<StoreEventType>,
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Unsubscribe | Subscription {
    if (typeof listenerOrType === 'function') {
      const unsubscribe = emitter.addEventListener('action', (event) => {
        listenerOrType(getState(), event.detail);
      });
      return unsubscribe;
    }
    return emitter.subscribe(listenerOrType, observerOrNext, error, complete);
  }

  function removeRun(id: string): void {
    emitter.emit('run.removed', { runId: id });
    deregister(id);
    runs.delete(id);
  }

  function deregister(id: string): void {
    const subscription = runSubscriptions.get(id);
    if (subscription) {
      subscription.unsubscribe();
      runSubscriptions.delete(id);
    }
  }

  function dispose(): void {
    for (const [id] of runSubscriptions) {
      deregister(id);
    }
    emitter.complete();
  }

  return {
    register,
    getState,
    getRun,
    subscribe,
    addEventListener: emitter.addEventListener,
    on: emitter.on,
    once: emitter.once,
    toObservable: emitter.toObservable,
    events: emitter.events,
    complete: emitter.complete,
    get completed() {
      return emitter.completed;
    },
    removeRun,
    deregister,
    dispose,
  };
}
