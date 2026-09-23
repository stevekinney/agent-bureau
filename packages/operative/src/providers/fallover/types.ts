import type { RuntimeServices } from '@lostgradient/lifecycle';

import type { GenerateFunction } from '../types.ts';

/**
 * Classification of a provider error for fallover decision-making.
 */
export type ErrorClassification =
  'auth' | 'rate-limit' | 'server-error' | 'overflow' | 'network' | 'unknown';

/**
 * A named provider with its generate function.
 */
export type FalloverProvider = {
  name: string;
  generate: GenerateFunction;
};

/**
 * Options for configuring fallover behavior across providers.
 */
export type FalloverOptions = {
  providers: FalloverProvider[];
  /** Maximum retries per provider before moving to the next. Defaults to 1. */
  retriesPerProvider?: number | undefined;
  /** Base delay in ms between retries, doubles per attempt. Defaults to 1000. */
  retryDelay?: number | undefined;
  /** Duration in ms a provider stays on cooldown after auth/billing failures. Defaults to 300_000 (5 min). */
  cooldownDuration?: number | undefined;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: (() => number) | undefined;
  /** Injectable retry sleep for tests. Defaults to a setTimeout-backed sleep. */
  sleep?: ((milliseconds: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Called when the system falls over from one provider to the next. */
  onFallover?: ((event: FalloverEvent) => void) | undefined;
  /** Called when a previously failed provider succeeds again. */
  onRecovery?: ((provider: string) => void) | undefined;
  /** Override the default error classification logic. */
  classifyError?: ((error: unknown) => ErrorClassification) | undefined;
  /**
   * The AB-92/AB-252/AB-253 injectable runtime-service seam. Resolved
   * exactly once at construction — omitted, `now`'s and `sleep`'s own
   * defaults (above) read the real globals via
   * `createDefaultRuntimeServices()`; a test composes its own deterministic
   * instance with `createManualRuntimeServices()`. An explicitly supplied
   * `now`/`sleep` still wins over this seam.
   */
  runtime?: RuntimeServices | undefined;
};

/**
 * Event emitted when falling over from one provider to another.
 */
export type FalloverEvent = {
  failedProvider: string;
  nextProvider: string;
  error: unknown;
  errorType: ErrorClassification;
  attempt: number;
};

/**
 * Health snapshot of a single provider.
 */
export type ProviderHealth = {
  name: string;
  available: boolean;
  lastError?: { code: number; message: string; timestamp: number } | undefined;
  cooldownUntil?: number | undefined;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
};
