export type ConcurrencyLimiter = {
  run: <T>(task: () => Promise<T>) => Promise<T>;
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
  const queue: Array<() => void> = [];
  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= resolved) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      const next = queue.shift();
      if (next) {
        next();
      }
    }
  };
  return { run };
}
