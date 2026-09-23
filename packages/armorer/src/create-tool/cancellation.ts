import type { RuntimeServices } from '@lostgradient/lifecycle';

import { errorString, normalizeError } from '../errors';
import type { MinimalAbortSignal, ToolExecuteOptions } from '../is-tool';
import type { InternalToolExecuteOptions } from './execution-options';

const abortRejections = new WeakSet<object>();

export type AbortRejection = Error & { reason?: unknown };

export function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(errorString(normalizeError(error)));
}

export function createDeadlineError(reason?: unknown): Error {
  const message = deadlineMessage(reason);
  const error = new Error(message);
  Object.defineProperty(error, 'code', {
    configurable: true,
    enumerable: true,
    value: 'TIMEOUT',
    writable: true,
  });
  return error;
}

function deadlineMessage(reason: unknown): string {
  if (typeof reason === 'string' && reason.length > 0) return reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return 'Execution deadline exceeded';
}

export function createAbortRejection(reason?: unknown): AbortRejection {
  const error = Object.assign(new Error('Aborted'), { reason });
  abortRejections.add(error);
  return error;
}

export function isAbortRejection(error: unknown): error is AbortRejection {
  return typeof error === 'object' && error !== null && abortRejections.has(error);
}

export function racePreExecution<T>(
  operation: () => T | Promise<T>,
  signal?: MinimalAbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(createAbortRejection(signal.reason));
  }
  return raceWithSignal(Promise.resolve(operation()), signal);
}

export function raceWithSignal<T>(promise: Promise<T>, signal?: MinimalAbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(createAbortRejection(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortRejection(signal.reason));
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort);
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
        return undefined;
      },
      (error) => {
        cleanup();
        reject(asError(error));
        return undefined;
      },
    );
  });
}

export function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  options: ToolExecuteOptions,
  timers: RuntimeServices['timers'],
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const setTimeoutFunction = options.setTimeoutFunction ?? timers.setTimeout;
    const clearTimeoutFunction = options.clearTimeoutFunction ?? timers.clearTimeout;
    const timeoutHandle = setTimeoutFunction(() => {
      abortDeadline(options);
      reject(new Error('TIMEOUT'));
    }, milliseconds);
    void promise.then(
      (value) => {
        clearTimeoutFunction(timeoutHandle);
        resolve(value);
        return undefined;
      },
      (error) => {
        clearTimeoutFunction(timeoutHandle);
        reject(asError(error));
        return undefined;
      },
    );
  });
}

function abortDeadline(options: ToolExecuteOptions): void {
  if (hasExecutionHandle(options)) {
    options.executionHandle.abort('deadline', 'Execution deadline exceeded');
  }
}

function hasExecutionHandle(options: ToolExecuteOptions): options is InternalToolExecuteOptions & {
  executionHandle: NonNullable<InternalToolExecuteOptions['executionHandle']>;
} {
  return 'executionHandle' in options && options.executionHandle !== undefined;
}
