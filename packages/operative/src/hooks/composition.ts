export type TimeoutHandle = unknown;
export type ScheduleTimeout = (callback: () => void, milliseconds?: number) => TimeoutHandle;
export type ClearScheduledTimeout = (handle: TimeoutHandle) => void;

/**
 * Creates a hook that only runs on a specific step number.
 * Uses the `step` property from the hook's context argument.
 * Returns undefined when the step does not match.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function onlyOnStep<H extends (...args: any[]) => any>(step: number, hook: H): H {
  return ((...args: unknown[]) => {
    const context = args[0] as { step?: number } | undefined;
    if (context && typeof context === 'object' && 'step' in context && context.step === step) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return hook(...args);
    }
    return undefined;
  }) as unknown as H;
}

/**
 * Creates a hook that runs at most once.
 * Subsequent calls return undefined until `reset()` is called.
 *
 * The returned function exposes a `reset()` method that clears the
 * "already called" flag, allowing the hook to fire again. Call
 * `reset()` between runs when the same hook instance is reused
 * across multiple `run()` invocations on a persistent `HookRegistry`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function runOnce<H extends (...args: any[]) => any>(hook: H): H & { reset(): void } {
  let called = false;
  const wrapped = ((...args: unknown[]) => {
    if (called) return undefined;
    called = true;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return hook(...args);
  }) as unknown as H & { reset(): void };

  wrapped.reset = () => {
    called = false;
  };

  return wrapped;
}

/**
 * Creates a hook that runs every N steps (0, N, 2N, 3N...).
 * Uses the `step` property from the hook's context argument.
 * Returns undefined when the step does not match.
 *
 * @throws {Error} if `n` is not a positive integer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function everyNSteps<H extends (...args: any[]) => any>(n: number, hook: H): H {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('everyNSteps: n must be a positive integer');
  }

  return ((...args: unknown[]) => {
    const context = args[0] as { step?: number } | undefined;
    if (context && typeof context === 'object' && 'step' in context) {
      const step = (context as { step?: number }).step;
      if (typeof step === 'number' && Number.isFinite(step) && step % n === 0) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return hook(...args);
      }
    }
    return undefined;
  }) as unknown as H;
}

/**
 * Creates a hook with a timeout. If the hook doesn't resolve within
 * the timeout, behavior depends on onTimeout: 'ignore' returns undefined,
 * 'error' throws a TimeoutError.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withTimeout<H extends (...args: any[]) => any>(
  ms: number,
  hook: H,
  onTimeout: 'ignore' | 'error' = 'ignore',
  options: {
    clearTimeoutFunction?: ClearScheduledTimeout;
    setTimeoutFunction?: ScheduleTimeout;
  } = {},
): H {
  return ((...args: unknown[]) => {
    return new Promise<unknown>((resolve, reject) => {
      const setTimeoutFunction =
        options.setTimeoutFunction ??
        ((callback, milliseconds) => setTimeout(callback, milliseconds));
      const clearTimeoutFunction =
        options.clearTimeoutFunction ??
        ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
      const timer = setTimeoutFunction(() => {
        if (onTimeout === 'error') {
          reject(new Error(`Hook timed out after ${ms}ms`));
        } else {
          resolve(undefined);
        }
      }, ms);

      const hookResult: Promise<unknown> = Promise.resolve(hook(...args));
      void hookResult.then(
        (result: unknown) => {
          clearTimeoutFunction(timer);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeoutFunction(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }) as unknown as H;
}

/**
 * Composes multiple hooks of the same type into a single hook.
 * Hooks are executed sequentially. If a hook returns a non-void value,
 * it replaces the first argument for subsequent hooks (waterfall).
 * If all hooks return void, the composed hook returns void.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function composeHooks<H extends (...args: any[]) => any>(...hooks: H[]): H {
  return (async (...args: unknown[]) => {
    const currentArgs = [...args];
    let lastResult: unknown;
    let hasResult = false;

    for (const hook of hooks) {
      const result: unknown = await hook(...currentArgs);
      if (result !== undefined) {
        currentArgs[0] = result;
        lastResult = result;
        hasResult = true;
      }
    }

    return hasResult ? lastResult : undefined;
  }) as unknown as H;
}
