import { createDefaultRuntimeServices, type RuntimeServices } from 'lifecycle';

export interface TemporalDecayOptions {
  halfLifeMilliseconds: number;
  referenceTime?: number; // defaults to runtime.clock.now()
  evergreenExempt?: boolean; // defaults to true
  /**
   * Runtime services to read the default `referenceTime` from when it is
   * omitted. Defaults to the real implementation
   * (`createDefaultRuntimeServices()`). A test composes its own via
   * `createManualRuntimeServices()` from `lifecycle`.
   */
  runtime?: RuntimeServices;
}

/**
 * Applies exponential decay to a score based on age.
 * Formula: score *= 2^(-age / halfLife)
 *
 * If the item was created in the future (negative age), the score is returned unchanged.
 */
export function computeTemporalDecay(
  score: number,
  createdAt: number,
  options: TemporalDecayOptions,
): number {
  const referenceTime =
    options.referenceTime ?? (options.runtime ?? createDefaultRuntimeServices()).clock.now();
  const age = referenceTime - createdAt;

  // Do not decay items from the future
  if (age <= 0) return score;

  const decayFactor = Math.pow(2, -age / options.halfLifeMilliseconds);
  return score * decayFactor;
}

/**
 * Applies temporal decay to an array of scored results.
 * Entries with `metadata.evergreen = true` are exempt from decay by default.
 *
 * Returns a new array with updated scores (does not mutate the input).
 */
export function applyTemporalDecay<
  T extends { score: number; createdAt: number; metadata: { evergreen?: boolean } },
>(results: T[], options: TemporalDecayOptions): T[] {
  const evergreenExempt = options.evergreenExempt ?? true;

  return results.map((result) => {
    if (evergreenExempt && result.metadata.evergreen) {
      return { ...result };
    }

    return {
      ...result,
      score: computeTemporalDecay(result.score, result.createdAt, options),
    };
  });
}
