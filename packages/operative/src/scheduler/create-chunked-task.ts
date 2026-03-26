import { Conversation } from 'conversationalist';

import type { RunResult } from '../types';
import type { Scheduler } from './create-scheduler';
import type { SchedulerPriority, SchedulerTask } from './types';

/**
 * Options for creating a chunked background task.
 */
export interface CreateChunkedTaskOptions<TState> {
  /** Human-readable name for logging. */
  name: string;
  /** Priority for all chunks. Default: 'background'. */
  priority?: SchedulerPriority;
  /** Initial state for the first chunk. */
  initialState: TState;
  /** Process one chunk. Returns the updated state and whether more chunks remain. */
  processChunk: (state: TState, signal: AbortSignal) => Promise<{ state: TState; done: boolean }>;
  /** Called when all chunks are complete. */
  onComplete?: (finalState: TState) => void | Promise<void>;
  /** Called on error. */
  onError?: (error: unknown, state: TState) => void | Promise<void>;
  /** Maximum number of times a single chunk can be retried after permanent
   *  preemption (submit returned null) before giving up. Default: 5. */
  maxPreemptionRetries?: number;
}

let chunkedTaskIdCounter = 0;

/**
 * Creates a chunked task utility that breaks a large background job into
 * small, preemption-friendly chunks submitted to the scheduler one at a time.
 *
 * Returns a function that, when called with a scheduler, submits chunks
 * sequentially and resolves with the final state when all chunks complete.
 *
 * Each chunk is a separate scheduler task. If a chunk is preempted, the
 * same chunk is re-submitted with the same state (idempotent retry).
 */
export function createChunkedTask<TState>(
  options: CreateChunkedTaskOptions<TState>,
): (scheduler: Scheduler) => Promise<TState> {
  const {
    name,
    priority = 'background',
    initialState,
    processChunk,
    onComplete,
    onError,
    maxPreemptionRetries = 5,
  } = options;

  return async function submitChunkedWork(scheduler: Scheduler): Promise<TState> {
    let currentState = initialState;
    let preemptionRetries = 0;

    while (true) {
      const stateForChunk = currentState;
      const taskId = `${name}-chunk-${++chunkedTaskIdCounter}`;

      let chunkResult: { state: TState; done: boolean } | undefined;
      let chunkError: unknown;

      const task: SchedulerTask = {
        id: taskId,
        priority,
        requeue: true,
        maxRequeues: 10, // High limit — chunks are designed for preemption
        createRun: () => {
          // We don't actually run an LLM loop for chunks — we use the
          // createRun factory to execute our processChunk function and
          // return a minimal RunResult. The scheduler calls executeLoop
          // which will run our generate function once and stop.
          return {
            generate: async (context) => {
              try {
                chunkResult = await processChunk(stateForChunk, context.signal!);
              } catch (error) {
                chunkError = error;
              }
              return { content: '', toolCalls: [] };
            },
            toolbox: {
              tools: () => [],
              execute: () => Promise.resolve([]),
              toObservable: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
            } as never,
            conversation: new Conversation(),
            maximumSteps: 1,
          };
        },
      };

      const result: RunResult | null = await scheduler.submit(task);

      // Task was permanently preempted (exceeded maxRequeues) — retry with same state
      if (result === null) {
        preemptionRetries++;
        if (preemptionRetries > maxPreemptionRetries) {
          const error = new Error(
            `Chunked task "${name}": exceeded ${maxPreemptionRetries} preemption retries`,
          );
          void onError?.(error, stateForChunk);
          throw error;
        }
        continue;
      }

      // Check if the chunk itself errored
      if (chunkError) {
        void onError?.(chunkError, stateForChunk);
        if (chunkError instanceof Error) throw chunkError;
        throw new Error('Chunk processing failed');
      }

      // Check if the run was aborted (preempted mid-step)
      if (result.finishReason === 'aborted' && !chunkResult) {
        preemptionRetries++;
        if (preemptionRetries > maxPreemptionRetries) {
          const error = new Error(
            `Chunked task "${name}": exceeded ${maxPreemptionRetries} preemption retries`,
          );
          void onError?.(error, stateForChunk);
          throw error;
        }
        continue;
      }

      if (!chunkResult) {
        const error = new Error(`Chunked task "${name}": processChunk did not produce a result`);
        void onError?.(error, stateForChunk);
        throw error;
      }

      currentState = chunkResult.state;
      preemptionRetries = 0; // Reset retry budget for the next chunk

      if (chunkResult.done) {
        void onComplete?.(currentState);
        return currentState;
      }
    }
  };
}
