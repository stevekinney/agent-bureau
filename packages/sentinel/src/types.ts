import type { ConversationSnapshot } from 'conversationalist';
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

export interface Store {
  register(activeRun: ActiveRun, id?: string): string;
  getState(): StoreState;
  getRun(id: string): RunState | undefined;
  subscribe(listener: StoreListener): Unsubscribe;
  removeRun(id: string): void;
  deregister(id: string): void;
  dispose(): void;
}
