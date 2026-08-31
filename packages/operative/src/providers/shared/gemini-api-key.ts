import { ProviderError } from '../errors.ts';

/**
 * Resolves the Gemini API key from the explicit option or the `GOOGLE_API_KEY`
 * environment variable, throwing a `ProviderError` when neither is set.
 *
 * Shared by every `@google/genai`-backed factory that constructs its own
 * client (`createGeminiProvider`, `createGeminiProviderStream`,
 * `createGeminiBatchClient`) so the key-resolution policy — and the error text
 * a caller sees when it fails — is stated once.
 *
 * The `@google/genai` constructor accepts an empty key and only fails later, at
 * the first request, with an opaque auth error. Failing here instead keeps the
 * diagnosis at the call site that is actually missing configuration.
 */
export function resolveGeminiApiKey(apiKey: string | undefined): string {
  const resolved =
    apiKey ??
    (typeof Bun !== 'undefined' ? Bun.env['GOOGLE_API_KEY'] : process.env['GOOGLE_API_KEY']);
  if (!resolved) {
    throw new ProviderError({
      provider: 'gemini',
      cause: undefined,
      message:
        '[provider:gemini] Missing API key: provide an apiKey option or set the GOOGLE_API_KEY environment variable.',
    });
  }
  return resolved;
}
