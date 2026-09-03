import type { RuntimeTimers } from 'lifecycle';
import { createDefaultRuntimeServices } from 'lifecycle';

import {
  readBackendDescriptors,
  unionBackendDescriptors,
  withBackendDescriptors,
} from '../backend-descriptor-attachment.ts';
import { extractStatusCode } from '../errors.ts';
import type { GenerateFunction } from '../types.ts';
import { classifyProviderError } from './classify-error.ts';
import { FalloverExhaustedError } from './errors.ts';
import { createProviderHealthTracker } from './provider-health.ts';
import type { ErrorClassification, FalloverOptions } from './types.ts';

/** Error classifications that warrant retrying the same provider. */
const RETRYABLE_CLASSIFICATIONS = new Set<ErrorClassification>(['server-error', 'network']);

/**
 * Creates a single GenerateFunction that cascades across multiple providers.
 *
 * On failure, the error is classified to decide the recovery strategy:
 * - **auth** (401/403): skip to next provider immediately, cooldown the failed one.
 * - **rate-limit** (429): skip to next provider immediately, cooldown the failed one.
 * - **server-error** (5xx): retry up to `retriesPerProvider` with exponential backoff, then skip.
 * - **overflow**: throw immediately — the content is too large, cascading won't help.
 * - **network**: retry up to `retriesPerProvider`, then skip.
 * - **unknown**: skip to next provider immediately.
 *
 * When all providers are exhausted, throws `FalloverExhaustedError`.
 *
 * Attaches the ordered union of every provider's attached
 * `BackendDescriptor`(s), deduplicated by `(provider, endpoint, model)`
 * (AB-64 AC2, AB-245, AB-288) — see `unionBackendDescriptors` — onto the
 * returned wrapper, so an Agent whose generate is `createFalloverGenerate`'s
 * output reports the routed or fixed mode rather than opaque.
 */
export function createFalloverGenerate(options: FalloverOptions): GenerateFunction {
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const {
    providers,
    retriesPerProvider = 1,
    retryDelay = 1000,
    cooldownDuration = 300_000,
    now = runtime.clock.now,
    sleep: sleepFunction = (milliseconds, signal) => sleep(milliseconds, signal, runtime.timers),
    onFallover,
    onRecovery,
    classifyError = classifyProviderError,
  } = options;

  const tracker = createProviderHealthTracker(providers, { cooldownDuration, now });

  // Track which providers have previously been on cooldown so we can detect recovery
  const previouslyFailed = new Set<string>();

  const wrapped: GenerateFunction = async (context) => {
    if (context.signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    const collectedErrors: Array<{ provider: string; error: unknown }> = [];

    for (let providerIndex = 0; providerIndex < providers.length; providerIndex++) {
      const provider = providers[providerIndex]!;

      // Skip providers on cooldown, but record the skip for diagnostics
      if (!tracker.isAvailable(provider.name)) {
        collectedErrors.push({
          provider: provider.name,
          error: new Error(`Provider ${provider.name} is on cooldown`),
        });
        continue;
      }

      let lastError: unknown;
      const maxAttempts = retriesPerProvider + 1; // 1 initial + retries

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (context.signal?.aborted) {
          throw new DOMException('The operation was aborted', 'AbortError');
        }

        try {
          const result = await provider.generate(context);
          tracker.recordSuccess(provider.name);

          // Detect recovery: provider was previously failed and now succeeds
          if (previouslyFailed.has(provider.name)) {
            previouslyFailed.delete(provider.name);
            onRecovery?.(provider.name);
          }

          return result;
        } catch (error) {
          lastError = error;
          const errorType = classifyError(error);

          // Overflow is a content problem — throw immediately, never cascade
          if (errorType === 'overflow') {
            throw error;
          }

          const errorCode = extractStatusCode(error) ?? 0;
          tracker.recordFailure(provider.name, errorType, {
            code: errorCode,
            message: error instanceof Error ? error.message : String(error),
          });

          if (errorType === 'auth' || errorType === 'rate-limit') {
            previouslyFailed.add(provider.name);
          }

          // Only retry for retryable classifications; others skip immediately
          if (!RETRYABLE_CLASSIFICATIONS.has(errorType) || attempt === maxAttempts) {
            break;
          }

          // Exponential backoff between retries
          const delay = retryDelay * Math.pow(2, attempt - 1);
          if (delay > 0) {
            await sleepFunction(delay, context.signal);
          }
        }
      }

      collectedErrors.push({ provider: provider.name, error: lastError });

      // Fire fallover event if there's a next provider to try
      const nextAvailable = findNextAvailable(providers, providerIndex + 1, tracker);
      if (nextAvailable !== undefined && onFallover) {
        onFallover({
          failedProvider: provider.name,
          nextProvider: providers[nextAvailable]!.name,
          error: lastError,
          errorType: classifyError(lastError),
          attempt: collectedErrors.length,
        });
      }
    }

    throw new FalloverExhaustedError(collectedErrors);
  };

  return withBackendDescriptors(
    wrapped,
    unionBackendDescriptors(providers.map((provider) => readBackendDescriptors(provider.generate))),
  );
}

function findNextAvailable(
  providers: FalloverOptions['providers'],
  startIndex: number,
  tracker: ReturnType<typeof createProviderHealthTracker>,
): number | undefined {
  for (let i = startIndex; i < providers.length; i++) {
    if (tracker.isAvailable(providers[i]!.name)) {
      return i;
    }
  }
  return undefined;
}

function sleep(ms: number, signal: AbortSignal | undefined, timers: RuntimeTimers): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'));
      return;
    }

    // Guards against a resolve/abort race (the timer firing and the signal
    // aborting in the same tick) settling the promise twice.
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };

    const timer = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      // A normal (non-aborted) resolution must remove its own `abort`
      // listener — `{ once: true }` only detaches the listener once IT
      // fires, not once the promise settles some other way. Without this, a
      // long-lived `signal` reused across many retry sleeps (the exact
      // caller pattern here) accumulates one listener per completed sleep
      // for as long as the signal lives.
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
