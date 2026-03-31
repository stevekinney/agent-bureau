import type { GenerateContext } from '../types';

/**
 * Transforms the generate context before a retry attempt.
 *
 * Return a new context to replace the current one, or void to leave
 * it unchanged. The mutator receives the error that triggered the retry
 * and the current attempt number (1-indexed).
 */
export type RetryMutator = (
  context: GenerateContext,
  error: unknown,
  attempt: number,
) => Promise<GenerateContext | void> | GenerateContext | void;
