import type { RunResult, StepResult, TokenUsage } from 'operative';

import type { Action, RunState, Store, StoreListener, StoreState, Unsubscribe } from './types';

function addUsage(accumulated: TokenUsage, incoming: TokenUsage | undefined): TokenUsage {
  if (!incoming) return accumulated;
  return {
    prompt: accumulated.prompt + incoming.prompt,
    completion: accumulated.completion + incoming.completion,
    total: accumulated.total + incoming.total,
  };
}

export function createStore(): Store {
  const runs = new Map<string, RunState>();
  const actions: Action[] = [];
  const listeners = new Set<StoreListener>();
  const subscriptions = new Map<string, { unsubscribe: () => void }>();
  let sequenceCounter = 0;
  let idCounter = 0;

  function getState(): StoreState {
    return { runs, actions };
  }

  function getRun(id: string): RunState | undefined {
    return runs.get(id);
  }

  function notify(action: Action): void {
    const state = getState();
    for (const listener of listeners) {
      listener(state, action);
    }
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
              status: 'completed',
              finishReason: runResult.finishReason,
              error: runResult.error,
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

        runs.set(runId, updated);
        notify(action);
      },
    });

    subscriptions.set(runId, subscription);
    return runId;
  }

  function subscribe(listener: StoreListener): Unsubscribe {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function deregister(id: string): void {
    const subscription = subscriptions.get(id);
    if (subscription) {
      subscription.unsubscribe();
      subscriptions.delete(id);
    }
  }

  function dispose(): void {
    for (const [id] of subscriptions) {
      deregister(id);
    }
    listeners.clear();
  }

  return {
    register,
    getState,
    getRun,
    subscribe,
    deregister,
    dispose,
  };
}
