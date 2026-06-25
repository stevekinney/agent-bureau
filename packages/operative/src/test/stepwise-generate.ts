import type { GenerateFunction, GenerateResponse } from '../types';

/**
 * Creates a generate function that, on its FIRST step (step === 0), returns a
 * tool call immediately — ensuring the run takes at least two steps. On step 1
 * it **blocks** until the caller invokes `releaseStep1(response)`, or resolves
 * immediately with `'aborted'` if the run's abort signal fires.
 *
 * This lets a test park a durable run mid-flight (at step 1's generate call)
 * and then prove that a resume continues from step 1 rather than re-running
 * step 0.
 *
 * Under a *suspend* (not cancel) the abort signal does NOT fire, so the
 * generate stays blocked and the run parks at step 1. Under a *cancel* the
 * signal fires and the generate resolves immediately, allowing the run to
 * terminate.
 *
 * All subsequent steps (step >= 2) complete immediately with a
 * step-numbered marker string.
 */
export function createStepwiseBlockingGenerate(): {
  generate: GenerateFunction;
  releaseStep1: (response: GenerateResponse) => void;
  steps: number[];
} {
  const steps: number[] = [];
  let step1Resolver: ((response: GenerateResponse) => void) | undefined;
  const step1Promise = new Promise<GenerateResponse>((resolve) => {
    step1Resolver = resolve;
  });

  const generate: GenerateFunction = async (context) => {
    steps.push(context.step);

    if (context.step === 0) {
      // Step 0 completes immediately with a tool call so the run proceeds to
      // step 1 (where it will block).
      return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
    }

    if (context.step === 1) {
      // Block at step 1 until released, or abort if the signal fires. Under a
      // suspend (not cancel) the signal does NOT fire, so the run stays parked.
      return Promise.race([
        step1Promise,
        new Promise<GenerateResponse>((resolve) => {
          context.signal?.addEventListener(
            'abort',
            () => resolve({ content: 'aborted', toolCalls: [] }),
            { once: true },
          );
        }),
      ]);
    }

    return { content: `step ${context.step}`, toolCalls: [] };
  };

  return {
    generate,
    releaseStep1: (response) => step1Resolver?.(response),
    steps,
  };
}
