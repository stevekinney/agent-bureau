import type { ErrorClassification, ProviderHealth } from './types.ts';

/** Error classifications that trigger a cooldown period. */
const COOLDOWN_CLASSIFICATIONS = new Set<ErrorClassification>(['auth', 'rate-limit']);

type ProviderEntry = {
  name: string;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
  lastError?: { code: number; message: string; timestamp: number };
  cooldownUntil?: number;
};

type HealthTrackerOptions = {
  /** Duration in ms a provider stays on cooldown. Defaults to 300_000 (5 min). */
  cooldownDuration?: number;
  /** Injectable clock for testing. Defaults to Date.now. */
  now?: () => number;
};

type ProviderHealthTracker = {
  /** Returns health snapshots for all tracked providers. */
  getHealth: () => ProviderHealth[];
  /** Returns names of providers not currently on cooldown. */
  getAvailableProviders: () => string[];
  /** Returns whether a specific provider is available at the given time. */
  isAvailable: (name: string, now?: number) => boolean;
  /** Records a successful call, resetting cooldown and consecutive failures. */
  recordSuccess: (name: string) => void;
  /** Records a failed call with its classification and error details. */
  recordFailure: (
    name: string,
    classification: ErrorClassification,
    errorInfo: { code: number; message: string },
  ) => void;
};

/**
 * Creates a tracker that monitors per-provider health for fallover decisions.
 *
 * Auth and rate-limit failures place the provider on a cooldown period.
 * Server errors and other transient failures increment the failure counter
 * without triggering cooldown, allowing the fallover loop to retry or skip.
 */
export function createProviderHealthTracker(
  providers: ReadonlyArray<{ name: string }>,
  options?: HealthTrackerOptions,
): ProviderHealthTracker {
  const cooldownDuration = options?.cooldownDuration ?? 300_000;
  const clock = options?.now ?? Date.now;

  const entries = new Map<string, ProviderEntry>();
  for (const provider of providers) {
    entries.set(provider.name, {
      name: provider.name,
      consecutiveFailures: 0,
      totalCalls: 0,
      totalFailures: 0,
    });
  }

  function isProviderAvailable(entry: ProviderEntry, now: number): boolean {
    if (entry.cooldownUntil === undefined) return true;
    return now > entry.cooldownUntil;
  }

  function toHealth(entry: ProviderEntry, now: number): ProviderHealth {
    return {
      name: entry.name,
      available: isProviderAvailable(entry, now),
      lastError: entry.lastError,
      cooldownUntil: entry.cooldownUntil,
      consecutiveFailures: entry.consecutiveFailures,
      totalCalls: entry.totalCalls,
      totalFailures: entry.totalFailures,
    };
  }

  return {
    getHealth(): ProviderHealth[] {
      const now = clock();
      return [...entries.values()].map((entry) => toHealth(entry, now));
    },

    getAvailableProviders(): string[] {
      const now = clock();
      return [...entries.values()]
        .filter((entry) => isProviderAvailable(entry, now))
        .map((entry) => entry.name);
    },

    isAvailable(name: string, now?: number): boolean {
      const entry = entries.get(name);
      if (!entry) return false;
      return isProviderAvailable(entry, now ?? clock());
    },

    recordSuccess(name: string): void {
      const entry = entries.get(name);
      if (!entry) return;
      entry.totalCalls += 1;
      entry.consecutiveFailures = 0;
      entry.cooldownUntil = undefined;
    },

    recordFailure(
      name: string,
      classification: ErrorClassification,
      errorInfo: { code: number; message: string },
    ): void {
      const entry = entries.get(name);
      if (!entry) return;

      const now = clock();
      entry.totalCalls += 1;
      entry.totalFailures += 1;
      entry.consecutiveFailures += 1;
      entry.lastError = { ...errorInfo, timestamp: now };

      if (COOLDOWN_CLASSIFICATIONS.has(classification)) {
        entry.cooldownUntil = now + cooldownDuration;
      }
    },
  };
}
