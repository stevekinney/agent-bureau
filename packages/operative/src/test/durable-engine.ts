import type { CheckpointStore } from '../durable/checkpoint-store';
import type { AnyRunEngine } from '../durable/create-run-engine';
import type { AgentRunWorkflowResult } from '../durable/run-workflow';

/**
 * Counts calls to an engine's `suspend`/`resume`/`cancel` so tests can prove
 * the durable preemption path was actually exercised (not an accidental
 * abort-and-rerun that happens to satisfy the higher-level assertions).
 */
export interface EngineSpy {
  engine: AnyRunEngine;
  suspends: string[];
  resumes: string[];
  cancels: string[];
}

/**
 * Wraps a real or manual durable engine with spies on `suspend`, `resume`, and
 * `cancel`. The engine is mutated in place so any object already holding a
 * reference (e.g. a scheduler) sees the wrapped methods.
 */
export function spyEngine(engine: AnyRunEngine): EngineSpy {
  const spy: EngineSpy = { engine, suspends: [], resumes: [], cancels: [] };
  const realSuspend = engine.suspend.bind(engine);
  const realResume = engine.resume.bind(engine);
  const realCancel = engine.cancel.bind(engine);

  engine.suspend = async (id: string) => {
    spy.suspends.push(id);
    return realSuspend(id);
  };
  engine.resume = async (id: string) => {
    spy.resumes.push(id);
    return realResume(id);
  };
  engine.cancel = async (id: string) => {
    spy.cancels.push(id);
    return realCancel(id);
  };

  return spy;
}

/**
 * A lightweight manual durable engine for unit tests that do not need a real
 * Weft workflow. The engine's `start`/`resume` return a handle whose `result()`
 * resolves/rejects only when the test explicitly calls `resolveResult()` or
 * `rejectResult()`.
 *
 * Use this when you want to control exactly when the engine-level result
 * settles — for example, testing scheduler preemption edge cases where the
 * backing store would add noise.
 */
export function createManualDurableEngine(): {
  engine: AnyRunEngine;
  resolveResult: () => void;
  rejectResult: (error: unknown) => void;
} {
  let resolveResult: ((value: unknown) => void) | undefined;
  let rejectResult: ((error: unknown) => void) | undefined;
  const result = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const engine = {
    start: async () => ({ result: () => result }),
    resume: async () => ({ result: () => result }),
    suspend: async () => {},
    get: async () => ({ status: 'suspended' }),
    cancel: async () => {
      rejectResult?.(new Error('Workflow cancelled'));
    },
  } as unknown as AnyRunEngine;

  return {
    engine,
    resolveResult: () =>
      resolveResult?.({
        runId: 'manual-run',
        steps: 0,
        content: 'manual',
        finishReason: 'stop-condition',
      } satisfies AgentRunWorkflowResult),
    rejectResult: (error: unknown) => rejectResult?.(error),
  };
}

/**
 * A minimal {@link CheckpointStore} stub for tests that use
 * {@link createManualDurableEngine}. The `loadCheckpoint` method returns a
 * zero-step cursor so the run-workflow resumes from step 0 without reading a
 * real backing store.
 */
export function createManualCheckpointStore(): CheckpointStore {
  return {
    loadCheckpoint: async (runId: string) => ({
      runId,
      cursor: {
        step: 0,
        totalUsage: { prompt: 0, completion: 0, total: 0 },
        lastContent: '',
        schemaAttempts: 0,
      },
      conversation: null,
      steps: [],
    }),
    saveCursor: async () => {},
    loadCursor: async () => null,
    saveConversation: async () => {},
    loadConversation: async () => null,
    saveStep: async () => {},
    loadSteps: async () => [],
    clear: async () => 0,
  };
}
