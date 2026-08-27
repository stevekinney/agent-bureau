export type ConcurrencyLimiter = {
  readonly capacity: number;
  run: <T>(
    task: () => Promise<T>,
    options?: {
      signal?: AbortSignal;
      onQueuePosition?: (position: number) => void;
    },
  ) => Promise<T>;
};

export function normalizeConcurrency(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const floored = Math.floor(value);
  if (floored <= 0) {
    return undefined;
  }
  return floored;
}

export function createConcurrencyLimiter(limit?: number): ConcurrencyLimiter | undefined {
  const resolved = normalizeConcurrency(limit);
  if (resolved === undefined) {
    return undefined;
  }
  let active = 0;
  const queue: Array<{ promote: () => void; updatePosition: (position: number) => void }> = [];

  const updateQueuePositions = () => {
    queue.forEach((entry, index) => entry.updatePosition(index + 1));
  };
  const promoteNext = () => {
    const next = queue.shift();
    updateQueuePositions();
    next?.promote();
  };
  const abortError = (signal: AbortSignal) =>
    signal.reason instanceof Error
      ? signal.reason
      : new Error(String(signal.reason ?? 'Execution aborted while queued'));

  // Promote the next task from the settlement handler itself. Resolving a
  // separate admission promise adds an avoidable chain of microtasks and can
  // leave a newly available slot observably empty for a turn. Keeping the
  // task's resolver in the queue preserves FIFO ordering while starting the
  // successor synchronously when the previous task releases its slot.
  const start = <T>(task: () => Promise<T>): Promise<T> => {
    active += 1;
    let execution: Promise<T>;
    try {
      execution = task();
    } catch (error) {
      execution = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return execution.finally(() => {
      active -= 1;
      promoteNext();
    });
  };

  const run = <T>(
    task: () => Promise<T>,
    options: { signal?: AbortSignal; onQueuePosition?: (position: number) => void } = {},
  ): Promise<T> => {
    if (options.signal?.aborted) {
      return Promise.reject(abortError(options.signal));
    }
    if (active < resolved) return start(task);
    return new Promise<T>((resolve, reject) => {
      let queued = true;
      const onAbort = () => {
        if (!queued) return;
        const index = queue.indexOf(entry);
        if (index >= 0) {
          queue.splice(index, 1);
          updateQueuePositions();
        }
        queued = false;
        reject(
          options.signal ? abortError(options.signal) : new Error('Execution aborted while queued'),
        );
      };
      let lastPosition: number | undefined;
      const entry = {
        updatePosition: (position: number) => {
          if (position === lastPosition) return;
          lastPosition = position;
          try {
            options.onQueuePosition?.(position);
          } catch {
            // Queue-position observers are informational. A consumer failure
            // must not reject admission or interrupt queue bookkeeping.
          }
        },
        promote: () => {
          if (!queued) return promoteNext();
          queued = false;
          options.signal?.removeEventListener('abort', onAbort);
          void start(task).then(resolve, reject);
        },
      };
      queue.push(entry);
      updateQueuePositions();
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
  return { capacity: resolved, run };
}
