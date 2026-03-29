/**
 * Token budget tracking for context window management.
 *
 * Tracks token usage against a maximum budget with configurable thresholds
 * for compaction triggers and early warnings.
 */

/** Tracks token usage and enforces budget constraints for context windows. */
export interface TokenBudget {
  readonly maxTokens: number;
  readonly minimumResponseTokens: number;
  readonly warningThreshold: number;
  readonly compactionThreshold: number;
  readonly used: number;
  readonly remaining: number;
  /** True when `used >= compactionThreshold`. */
  readonly exceeds: boolean;
  /** True when `remaining <= warningThreshold`. */
  readonly warning: boolean;
  /** Adds `tokens` to the running usage total. */
  update(tokens: number): void;
  /**
   * Returns the number of allocatable tokens.
   *
   * When `ratio` is provided, the allocation is `floor(allocatable * ratio)`.
   * Without a ratio the full allocatable budget is returned.
   *
   * Allocatable tokens are `max(0, remaining - minimumResponseTokens)` so
   * the model always has room to respond.
   */
  allocate(ratio?: number): number;
  /** Estimates the number of tokens in `text` using the configured estimator. */
  estimate(text: string): number;
}

/** Options for `createTokenBudget`. */
export interface TokenBudgetOptions {
  maxTokens: number;
  minimumResponseTokens?: number;
  warningThreshold?: number;
  compactionThreshold?: number;
  tokenEstimator?: (text: string) => number;
}

/** Default token estimator: roughly 4 characters per token. */
const defaultTokenEstimator = (text: string): number => Math.ceil(text.length / 4);

/**
 * Creates a `TokenBudget` that tracks token usage against a fixed maximum.
 *
 * - `exceeds` flips to `true` when `used >= compactionThreshold` (default 80%).
 * - `warning` flips to `true` when `remaining <= warningThreshold` (default 20%).
 * - `allocate()` reserves room for `minimumResponseTokens` (default 1500).
 */
export function createTokenBudget(options: TokenBudgetOptions): TokenBudget {
  const {
    maxTokens,
    minimumResponseTokens = 1500,
    warningThreshold = Math.floor(maxTokens * 0.2),
    compactionThreshold = Math.floor(maxTokens * 0.8),
    tokenEstimator = defaultTokenEstimator,
  } = options;

  let used = 0;

  return {
    get maxTokens() {
      return maxTokens;
    },
    get minimumResponseTokens() {
      return minimumResponseTokens;
    },
    get warningThreshold() {
      return warningThreshold;
    },
    get compactionThreshold() {
      return compactionThreshold;
    },
    get used() {
      return used;
    },
    get remaining() {
      return maxTokens - used;
    },
    get exceeds() {
      return used >= compactionThreshold;
    },
    get warning() {
      return maxTokens - used <= warningThreshold;
    },
    update(tokens: number): void {
      used += tokens;
    },
    allocate(ratio?: number): number {
      const allocatable = Math.max(0, maxTokens - used - minimumResponseTokens);
      if (ratio !== undefined) {
        const clamped = Math.max(0, Math.min(1, ratio));
        return Math.floor(allocatable * clamped);
      }
      return allocatable;
    },
    estimate(text: string): number {
      return tokenEstimator(text);
    },
  };
}
