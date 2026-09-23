import { createOperationCancelledError, createRevisionConflictError } from './errors';

export type LifecycleState = 'open' | 'closed' | 'disposed';

/** Owns lifecycle state, cancellation, and quiescence for controller work. */
export class HistoryLifecycle {
  private lifecycleState: LifecycleState = 'open';
  private readonly operationAbortController = new AbortController();
  private readonly inFlightOperations = new Set<Promise<unknown>>();

  get state(): LifecycleState {
    return this.lifecycleState;
  }

  get signal(): AbortSignal {
    return this.operationAbortController.signal;
  }

  get inFlightOperationCount(): number {
    return this.inFlightOperations.size;
  }

  setState(state: LifecycleState): void {
    this.lifecycleState = state;
  }

  close(conversationId: string): boolean {
    if (this.lifecycleState !== 'open') return false;
    this.lifecycleState = 'closed';
    this.operationAbortController.abort(createOperationCancelledError(conversationId, 'operation'));
    return true;
  }

  dispose(conversationId: string): boolean {
    if (this.lifecycleState === 'disposed') return false;
    this.lifecycleState = 'disposed';
    this.operationAbortController.abort(createOperationCancelledError(conversationId, 'operation'));
    return true;
  }

  track<T>(operation: Promise<T>): Promise<T> {
    this.inFlightOperations.add(operation);
    return operation;
  }

  untrack(operation: Promise<unknown>): void {
    this.inFlightOperations.delete(operation);
  }

  async quiesce(): Promise<void> {
    await Promise.allSettled(this.inFlightOperations);
  }

  async runOwnedOperation<T>(
    name: string,
    conversationId: string,
    startingRevision: number,
    currentRevision: () => number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.lifecycleState !== 'open') {
      throw createOperationCancelledError(conversationId, name);
    }
    const promise = this.track(operation(this.signal));
    try {
      const result = await promise;
      if (this.lifecycleState !== 'open' || this.signal.aborted) {
        throw createOperationCancelledError(conversationId, name);
      }
      if (currentRevision() !== startingRevision) {
        throw createRevisionConflictError(conversationId, startingRevision, currentRevision());
      }
      return result;
    } finally {
      this.untrack(promise);
    }
  }
}
