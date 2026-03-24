import type { GenerateFunction, GenerateMiddleware } from './types';

/**
 * Applies middleware right-to-left (first in list = outermost wrapper).
 */
export function composeGenerate(
  base: GenerateFunction,
  ...middleware: GenerateMiddleware[]
): GenerateFunction {
  return middleware.reduceRight((next, mw) => mw(next), base);
}

/**
 * Tries providers in order; falls back on error.
 */
export function createFallbackGenerate(options: {
  providers: GenerateFunction[];
  shouldFallback?: (error: unknown) => boolean;
}): GenerateFunction {
  const { providers, shouldFallback = () => true } = options;

  if (providers.length === 0) {
    throw new Error('createFallbackGenerate requires at least one provider');
  }

  return async (context) => {
    let lastError: unknown;
    for (const provider of providers) {
      try {
        return await provider(context);
      } catch (error) {
        lastError = error;
        if (!shouldFallback(error)) {
          throw error;
        }
      }
    }
    throw lastError;
  };
}
