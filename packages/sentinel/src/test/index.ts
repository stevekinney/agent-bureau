import { createStore } from '../store';
import type { Action, RunState, Store, StoreOptions } from '../types';

export function createTestStore(options?: StoreOptions): {
  store: Store;
  getActions(runId?: string): readonly Action[];
  getActionTypes(runId?: string): string[];
  waitForRun(runId: string): Promise<RunState>;
} {
  const store = createStore(options);

  function getActions(runId?: string): readonly Action[] {
    if (runId) {
      const run = store.getRun(runId);
      return run?.actions ?? [];
    }
    return store.getState().actions;
  }

  function getActionTypes(runId?: string): string[] {
    return getActions(runId).map((action) => action.type);
  }

  function waitForRun(runId: string): Promise<RunState> {
    return new Promise((resolve) => {
      const run = store.getRun(runId);
      if (run && run.status !== 'running') {
        resolve(run);
        return;
      }

      const unsubscribe = store.subscribe((_state, action) => {
        if (action.runId !== runId) return;
        if (
          action.type === 'run.completed' ||
          action.type === 'run.error' ||
          action.type === 'run.aborted'
        ) {
          unsubscribe();
          const finalRun = store.getRun(runId);
          if (finalRun) resolve(finalRun);
        }
      });
    });
  }

  return { store, getActions, getActionTypes, waitForRun };
}
