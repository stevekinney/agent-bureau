import {
  readBackendDescriptors,
  unionBackendDescriptors,
  withBackendDescriptors,
} from './providers/backend-descriptor-attachment';
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
 *
 * Attaches the ordered union of every provider's attached
 * `BackendDescriptor`(s), deduplicated by `(provider, endpoint, model)`
 * (AB-64 AC2, AB-245, AB-288) — see `unionBackendDescriptors` — onto the
 * returned wrapper, so an Agent whose generate is `createFallbackGenerate`'s
 * output reports the routed or fixed mode rather than opaque.
 */
export function createFallbackGenerate(options: {
  providers: GenerateFunction[];
  shouldFallback?: (error: unknown) => boolean;
}): GenerateFunction {
  const { providers, shouldFallback = () => true } = options;

  if (providers.length === 0) {
    throw new Error('createFallbackGenerate requires at least one provider');
  }

  const wrapped: GenerateFunction = async (context) => {
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

  return withBackendDescriptors(
    wrapped,
    unionBackendDescriptors(providers.map((provider) => readBackendDescriptors(provider))),
  );
}
