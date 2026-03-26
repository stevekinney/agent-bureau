import type { StepResultLike } from './experiential';
import { summarizeRun } from './experiential';
import type { Memory } from './types';

/**
 * Options for `createReflectionHook`.
 */
export interface CreateReflectionHookOptions {
  /** Memory instance to store extracted insights in. */
  memory: Memory;
  /**
   * LLM-powered reflection function. Receives a run summary and returns a
   * transferable insight or strategy. The consumer provides this function —
   * the memory package does not import an LLM SDK.
   */
  reflect: (runSummary: string) => Promise<string>;
  /** Namespace for stored entries. Default: `'experiential'`. */
  namespace?: string;
  /**
   * Predicate controlling which runs trigger reflection. When omitted,
   * every final step triggers reflection.
   */
  shouldReflect?: (result: StepResultLike) => boolean;
}

/**
 * Creates an `onStep` hook that reflects on a completed run and extracts a
 * transferable strategy or insight. The insight is stored in memory for
 * future retrieval, enabling agents to improve over time.
 *
 * Builds on the case storage pattern from `createRunCaptureHook`: it generates
 * a run summary via `summarizeRun`, passes it through the consumer-provided
 * `reflect` function, and stores the resulting insight.
 *
 * The hook fires only on the final step (`result.final === true`).
 */
export function createReflectionHook(options: CreateReflectionHookOptions): {
  onStep: (context: StepResultLike) => Promise<void>;
} {
  const { memory, reflect, namespace = 'experiential', shouldReflect } = options;

  return {
    async onStep(context: StepResultLike): Promise<void> {
      if (!context.final) return;
      if (shouldReflect && !shouldReflect(context)) return;

      const summary = summarizeRun(context);
      const insight = await reflect(summary);

      const finishReason = context.metadata?.['finishReason'] as string | undefined;
      const agentId = context.metadata?.['agentId'] as string | undefined;

      await memory.remember(insight, {
        source: 'experiential',
        namespace,
        tags: ['strategy'],
        ...(finishReason ? { finishReason } : {}),
        ...(agentId ? { agentId } : {}),
      });
    },
  };
}
