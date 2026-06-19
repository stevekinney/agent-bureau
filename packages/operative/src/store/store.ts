import { CompletableEventTarget, type Observer, type Subscription } from 'lifecycle';

import type { ActiveRun } from '../create-run';
import type { RunResult, StepResult, TokenUsage } from '../types';
import {
  RunRegisteredEvent,
  RunRemovedEvent,
  StoreActionEvent,
  type StoreEventMap,
} from './events';
import type {
  Action,
  RunState,
  Store,
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
  const emitter = new CompletableEventTarget<StoreEventMap>();
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

  function register(activeRun: ActiveRun, id?: string): string {
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
        const eventType = event.type;
        const timestamp = Date.now();
        // Extract custom properties from native Event subclasses (skip inherited Event props)
        const eventProps: Record<string, unknown> = {};
        for (const key of Object.keys(event)) {
          const value = (event as unknown as Record<string, unknown>)[key];
          if (key === 'originalEvent') {
            // Avoid retaining large/non-serializable originalEvent graphs in the action log.
            // Flatten to a shallow, serializable summary instead.
            if (value && typeof value === 'object') {
              const original = value as { type?: unknown; [prop: string]: unknown };
              const flattened: Record<string, unknown> = {};
              if (original['type'] !== undefined) {
                flattened['type'] = original['type'];
              }
              for (const prop of Object.keys(original)) {
                if (prop === 'type') continue;
                const propValue = original[prop];
                if (
                  propValue === null ||
                  typeof propValue === 'string' ||
                  typeof propValue === 'number' ||
                  typeof propValue === 'boolean'
                ) {
                  flattened[prop] = propValue;
                }
              }
              eventProps[key] = flattened;
            } else {
              eventProps[key] = value;
            }
          } else {
            eventProps[key] = value;
          }
        }

        const action = appendAction(runId, eventType, eventProps, timestamp);
        // Re-read after appendAction updated the run's actions list
        let updated = runs.get(runId);
        if (!updated) return;

        switch (eventType) {
          case 'step.generated': {
            const stepEvent = event as Event & { usage?: TokenUsage };
            updated = {
              ...updated,
              usage: addUsage(updated.usage, stepEvent.usage),
            };
            break;
          }
          case 'step.completed': {
            const stepEvent = event as Event & StepResult;
            const snapshot = stepEvent.conversation.snapshot();
            updated = {
              ...updated,
              steps: [...updated.steps, stepEvent as unknown as StepResult],
              snapshots: [...updated.snapshots, snapshot],
            };
            break;
          }
          case 'run.completed': {
            const runEvent = event as Event & RunResult;
            const snapshot = runEvent.conversation.snapshot();
            updated = {
              ...updated,
              status: updated.status === 'error' ? 'error' : 'completed',
              finishReason: runEvent.finishReason,
              error: updated.error ?? runEvent.error,
              snapshots: [...updated.snapshots, snapshot],
            };
            break;
          }
          case 'run.error': {
            const errorEvent = event as Event & { error: unknown };
            updated = {
              ...updated,
              status: 'error',
              error: errorEvent.error,
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
        emitter.dispatch(new StoreActionEvent(action));
      },
    });

    runSubscriptions.set(runId, subscription);
    emitter.dispatch(new RunRegisteredEvent(runId));
    return runId;
  }

  type StoreEventObserverOrNext<K extends StoreEventType> =
    | Observer<StoreEventMap[K]>
    | ((value: StoreEventMap[K]) => void);

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
      const listener = listenerOrType;
      const handler = (event: StoreActionEvent) => {
        listener(getState(), event.action);
      };
      emitter.addEventListener('action', handler, { signal: emitter.signal });
      return () => {
        emitter.removeEventListener('action', handler);
      };
    }
    return emitter.subscribe(listenerOrType, observerOrNext, error, complete);
  }

  function removeRun(id: string): void {
    if (!runs.has(id)) return;
    emitter.dispatch(new RunRemovedEvent(id));
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
    addEventListener: emitter.addEventListener.bind(emitter),
    removeEventListener: emitter.removeEventListener.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    toObservable: emitter.toObservable.bind(emitter),
    events: emitter.events.bind(emitter),
    complete: emitter.complete.bind(emitter),
    get completed() {
      return emitter.completed;
    },
    removeRun,
    deregister,
    dispose,
  };
}
