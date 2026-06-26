type ProviderError = { provider: string; error: unknown };

/**
 * Thrown when all providers in the fallover chain have been exhausted.
 *
 * Contains every provider's error for diagnostics, with `lastError`
 * pointing to the final provider's failure.
 */
export class FalloverExhaustedError extends Error {
  readonly errors: ReadonlyArray<ProviderError>;
  readonly lastError: unknown;

  constructor(errors: ProviderError[]) {
    const providerNames = errors.map((e) => e.provider).join(', ');
    super(`All ${errors.length} providers failed: ${providerNames}`);
    this.name = 'FalloverExhaustedError';
    this.errors = [...errors];
    this.lastError = errors.length > 0 ? errors[errors.length - 1]!.error : undefined;
  }
}
