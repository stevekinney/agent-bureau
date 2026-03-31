import type { GenerateContext } from '../types';
import type { RetryMutator } from './types';

/**
 * Chains multiple retry mutators into a single mutator.
 *
 * Each mutator receives the context produced by the previous one.
 * When a mutator returns void, the current context passes through
 * unchanged. Returns void only when every mutator returns void.
 */
export function composeMutators(...mutators: RetryMutator[]): RetryMutator {
  return async (
    context: GenerateContext,
    error: unknown,
    attempt: number,
  ): Promise<GenerateContext | void> => {
    let current = context;
    let anyMutated = false;

    for (const mutator of mutators) {
      const result = await mutator(current, error, attempt);
      if (result !== undefined) {
        current = result;
        anyMutated = true;
      }
    }

    return anyMutated ? current : undefined;
  };
}
