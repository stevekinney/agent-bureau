import { AbortAgentRunError, AsyncDefinitionLoadError } from './errors.ts';
import { withBackendDescriptors } from './providers/backend-descriptor-attachment.ts';
import type { BackendDescriptor } from './providers/model-catalog.ts';
import type { GenerateFunction } from './types.ts';

export type LazyGenerateLoader = () => GenerateFunction | PromiseLike<GenerateFunction>;

export interface CreateLazyGenerateOptions {
  /** Human-readable label included in lazy loading error messages. */
  label?: string;

  /**
   * `BackendDescriptor`(s) attached to the RETURNED wrapper function at
   * construction time (AB-64, AB-245) — never derived from the loader,
   * which must not run just to answer a capability read. A profile read off
   * the wrapper (`readBackendDescriptors`/`readGenerationProfile`) reports
   * these without ever invoking `loader`.
   */
  descriptors?: readonly BackendDescriptor[];
}

function isGenerateFunction(value: unknown): value is GenerateFunction {
  return typeof value === 'function';
}

function validateGenerateFunction(value: unknown, label: string): GenerateFunction {
  if (!isGenerateFunction(value)) {
    throw new AsyncDefinitionLoadError(
      'INVALID_EXPORT',
      `Lazy generate loader "${label}" must resolve to a callable GenerateFunction`,
      value,
    );
  }
  return value;
}

function abortError(signal: AbortSignal): AbortAgentRunError {
  return new AbortAgentRunError(
    'The agent run was aborted while loading a lazy generate function',
    signal.reason,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void promise
      .then((value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      })
      .catch((error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
      });
  });
}

type LazyGenerateState =
  | { kind: 'unloaded' }
  | { kind: 'loading'; pending: Promise<GenerateFunction> }
  | { kind: 'loaded'; generate: GenerateFunction };

/** Lazily loads and memoizes a GenerateFunction, sharing its first load across concurrent calls. */
export function createLazyGenerate(
  loader: LazyGenerateLoader,
  options: CreateLazyGenerateOptions = {},
): GenerateFunction {
  const label = options.label ?? 'anonymous';
  let state: LazyGenerateState = { kind: 'unloaded' };

  const resolve = (): Promise<GenerateFunction> => {
    if (state.kind === 'loaded') return Promise.resolve(state.generate);
    if (state.kind === 'loading') return state.pending;

    const pending = (async () => {
      let loaded: GenerateFunction;
      try {
        loaded = await loader();
      } catch (cause) {
        throw new AsyncDefinitionLoadError(
          'LOAD_FAILED',
          `Failed to load lazy generate function "${label}"`,
          cause,
        );
      }

      return validateGenerateFunction(loaded, label);
    })();

    state = { kind: 'loading', pending };
    void pending.then(
      (generate) => {
        if (state.kind === 'loading' && state.pending === pending) {
          state = { kind: 'loaded', generate };
        }
      },
      () => {
        if (state.kind === 'loading' && state.pending === pending) {
          state = { kind: 'unloaded' };
        }
      },
    );
    return pending;
  };

  const wrapper: GenerateFunction = async (context) => {
    const { signal } = context;
    throwIfAborted(signal);

    const generate = await awaitWithAbort(resolve(), signal);
    throwIfAborted(signal);

    return generate(context);
  };

  // Attached to the WRAPPER at construction time, never derived from the
  // loader — a profile read must never invoke `loader` (see
  // `CreateLazyGenerateOptions.descriptors`'s doc comment).
  return withBackendDescriptors(wrapper, options.descriptors ?? []);
}
