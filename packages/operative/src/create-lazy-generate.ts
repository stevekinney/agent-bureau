import { AsyncDefinitionLoadError } from './errors.ts';
import type { GenerateFunction } from './types.ts';

/** A module which exports a GenerateFunction directly or as its default export. */
export type GenerateModule = GenerateFunction | { default: GenerateFunction };

export interface CreateLazyGenerateOptions {
  /** Signal used to cancel loading before or while the provider module imports. */
  signal?: AbortSignal;
}

function isGenerateFunction(value: unknown): value is GenerateFunction {
  return typeof value === 'function';
}

function getGenerateFunction(module: unknown): GenerateFunction {
  const candidate =
    typeof module === 'function' ? module : (module as { default?: unknown })?.default;
  if (!isGenerateFunction(candidate)) {
    throw new AsyncDefinitionLoadError(
      'INVALID_MODULE',
      'The lazy generate loader must resolve to a callable GenerateFunction or a module with a callable default export',
    );
  }
  return candidate;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AsyncDefinitionLoadError(
      'ABORTED',
      'Loading the lazy generate function was aborted',
      signal.reason,
    );
  }
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(
        new AsyncDefinitionLoadError(
          'ABORTED',
          'Loading the lazy generate function was aborted',
          signal.reason,
        ),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
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

/** Lazily loads and memoizes a GenerateFunction, sharing its first load across concurrent calls. */
export function createLazyGenerate(
  loader: () => Promise<GenerateModule>,
  options: CreateLazyGenerateOptions = {},
): GenerateFunction {
  let loaded: GenerateFunction | undefined;
  let loading: Promise<GenerateFunction> | undefined;

  const resolve = (): Promise<GenerateFunction> => {
    if (loaded) return Promise.resolve(loaded);
    if (!loading) {
      const current = (async () => {
        let module: GenerateModule;
        try {
          module = await loader();
        } catch (cause) {
          throw new AsyncDefinitionLoadError(
            'LOAD_FAILED',
            'Failed to load the lazy generate function',
            cause,
          );
        }
        return getGenerateFunction(module);
      })();
      loading = current;
      void current.then(
        (generate) => {
          if (loading === current) {
            loaded = generate;
            loading = undefined;
          }
        },
        () => {
          if (loading === current) loading = undefined;
        },
      );
    }
    return loading;
  };

  return async (context) => {
    const signal = options.signal ?? context.signal;
    throwIfAborted(signal);
    const generate = await awaitWithAbort(resolve(), signal);
    throwIfAborted(signal);
    return generate(context);
  };
}
