import { AbortAgentRunError, AsyncDefinitionLoadError } from './errors.ts';
import { withBackendDescriptors } from './providers/backend-descriptor-attachment.ts';
import type { BackendDescriptor } from './providers/model-catalog.ts';
import type { GenerateFunction } from './types.ts';

export type LazyGenerateLoader = () => GenerateFunction | PromiseLike<GenerateFunction>;

export interface CreateLazyGenerateOptions {
  /** Human-readable label included in lazy loading error messages. */
  label?: string | undefined;

  /**
   * `BackendDescriptor`(s) attached to the RETURNED wrapper function at
   * construction time (AB-64, AB-245) — never derived from the loader,
   * which must not run just to answer a capability read. A profile read off
   * the wrapper (`readBackendDescriptors`/`readGenerationProfile`) reports
   * these without ever invoking `loader`.
   */
  descriptors?: readonly BackendDescriptor[] | undefined;
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

interface LoadWaiter {
  resolve: (generate: GenerateFunction) => void;
  reject: (error: Error) => void;
}

type LazyGenerateState =
  | { kind: 'unloaded' }
  | { kind: 'loading'; waiters: Set<LoadWaiter> }
  | { kind: 'loaded'; generate: GenerateFunction };

/** Lazily loads and memoizes a GenerateFunction, sharing its first load across concurrent calls. */
export function createLazyGenerate(
  loader: LazyGenerateLoader,
  options: CreateLazyGenerateOptions = {},
): GenerateFunction {
  const label = options.label ?? 'anonymous';
  let state: LazyGenerateState = { kind: 'unloaded' };

  const load = async (): Promise<GenerateFunction> => {
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
  };

  // Publishes the `loading` state BEFORE `loader` runs, so a reentrant call
  // made synchronously from inside `loader` joins this load. Callers wait on
  // per-caller entries in `waiters` rather than on a shared promise, so an
  // aborted caller removes itself and nothing retains it if the load never
  // settles.
  const start = (): Set<LoadWaiter> => {
    const waiters = new Set<LoadWaiter>();
    const current: LazyGenerateState = { kind: 'loading', waiters };
    state = current;
    void load().then(
      (generate) => {
        if (state === current) state = { kind: 'loaded', generate };
        for (const waiter of waiters) waiter.resolve(generate);
        waiters.clear();
        return undefined;
      },
      (error: unknown) => {
        if (state === current) state = { kind: 'unloaded' };
        const failure = error instanceof Error ? error : new Error(String(error), { cause: error });
        for (const waiter of waiters) waiter.reject(failure);
        waiters.clear();
        return undefined;
      },
    );
    return waiters;
  };

  const waitForLoad = (
    waiters: Set<LoadWaiter>,
    signal: AbortSignal | undefined,
  ): Promise<GenerateFunction> =>
    new Promise<GenerateFunction>((resolve, reject) => {
      const onAbort = (): void => {
        waiters.delete(waiter);
        reject(abortError(signal as AbortSignal));
      };
      const waiter: LoadWaiter = {
        resolve: (generate) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(generate);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      waiters.add(waiter);
      if (!signal) return;
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        signal.removeEventListener('abort', onAbort);
        onAbort();
      }
    });

  const wrapper: GenerateFunction = async (context) => {
    const { signal } = context;

    // Once loaded, behave exactly like a directly-referenced GenerateFunction:
    // the loaded function owns the signal.
    if (state.kind === 'loaded') return state.generate(context);

    if (signal?.aborted) throw abortError(signal);
    const waiters = state.kind === 'loading' ? state.waiters : start();
    const generate = await waitForLoad(waiters, signal);
    return generate(context);
  };

  // Attached to the WRAPPER at construction time, never derived from the
  // loader — a profile read must never invoke `loader` (see
  // `CreateLazyGenerateOptions.descriptors`'s doc comment).
  return withBackendDescriptors(wrapper, options.descriptors ?? []);
}
