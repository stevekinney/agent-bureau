import { isPromise } from '../type-guards';

export type ToolExecute<TInput, TOutput, TContext> = (
  params: TInput,
  context: TContext,
) => Promise<TOutput>;

export type LazyToolExecute<TInput, TOutput, TContext> =
  ToolExecute<TInput, TOutput, TContext> | Promise<ToolExecute<TInput, TOutput, TContext>>;

/** Creates a lazy-loaded function that defers execution until first call. */
export function lazy<TArgs extends unknown[], TResult>(
  loader:
    | (() => PromiseLike<(...args: TArgs) => Promise<TResult>>)
    | (() => (...args: TArgs) => Promise<TResult>),
): (...args: TArgs) => Promise<TResult> {
  let resolved: ((...args: TArgs) => Promise<TResult>) | undefined;
  let pending: Promise<(...args: TArgs) => Promise<TResult>> | undefined;

  const load = async () => {
    if (resolved) return resolved;
    if (!pending) {
      pending = Promise.resolve()
        .then(() => loader())
        .then((value) => {
          if (typeof value !== 'function') {
            throw new TypeError('lazy loader must resolve to a function');
          }
          resolved = value;
          return value;
        })
        .catch((error) => {
          pending = undefined;
          throw error;
        });
    }
    return pending;
  };

  return async (...args: TArgs) => {
    const execute = await load();
    return execute(...args);
  };
}

export function createLazyExecuteResolver<TInput, TOutput, TContext>(
  execute: LazyToolExecute<TInput, TOutput, TContext>,
): () => Promise<ToolExecute<TInput, TOutput, TContext>> {
  if (!isExecutable(execute)) {
    throw new TypeError('execute must be a function or a promise that resolves to a function');
  }
  if (typeof execute === 'function') {
    const fn = execute;
    return () => Promise.resolve(fn);
  }
  let resolved: ToolExecute<TInput, TOutput, TContext> | undefined;
  let pending: Promise<ToolExecute<TInput, TOutput, TContext>> | undefined;

  return async () => {
    if (resolved) return resolved;
    if (!pending) {
      pending = Promise.resolve(execute)
        .then((value) => {
          if (typeof value !== 'function') {
            throw new TypeError(
              'execute must be a function or a promise that resolves to a function',
            );
          }
          resolved = value;
          return value;
        })
        .catch((error) => {
          pending = undefined;
          throw error;
        });
    }
    return pending;
  };
}

function isExecutable<TInput, TOutput, TContext>(
  execute: LazyToolExecute<TInput, TOutput, TContext>,
): boolean {
  return typeof execute === 'function' || isPromise(execute);
}
