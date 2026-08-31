/**
 * Type-level regression test: a real `@anthropic-ai/sdk` `Anthropic` instance
 * must satisfy the structural token-counting client this package advertises as
 * an `options.client`, with no cast at the call site.
 *
 * Why this file exists: `MessageCountTokensParams` is an SDK `interface`, so it
 * has no implicit index signature and is *not* assignable to
 * `Record<string, unknown>`. Declaring a structural request parameter as
 * `Record<string, unknown>` therefore fails both directions of the bivariant
 * method check and makes `createAnthropicTokenCounter({ client })` impossible
 * to call without `as unknown as`. That is exactly the defect AB-154 found on
 * the Gemini migration, and it is still live on the older
 * {@link AnthropicClient} — `createAnthropicProvider` carries an
 * `as unknown as AnthropicClient` at its construction site because of it. This
 * assertion is what keeps the new interface out of that trap.
 *
 * Scope is deliberately just the token-counting client. Asserting the legacy
 * `AnthropicClient` here would fail for the reason above and drag an unrelated
 * public-surface change into AB-167.
 *
 * Why the `.test-d.ts` suffix: `tsconfig.json` includes `src`, so
 * `bun run check-types` checks this file, while `tsconfig.build.json` excludes
 * the suffix, so it never reaches `dist/` and cannot leak `@anthropic-ai/sdk`
 * into the published declarations — the SDK is an *optional* peer dependency,
 * so a published declaration referencing it would break every consumer who does
 * not install it. It declares only types, so it is erased entirely and
 * contributes no coverage.
 */
import type { Anthropic } from '@anthropic-ai/sdk';

import type { AnthropicTokenCountingClient } from './types.ts';

/** Fails to compile unless `T` resolves to exactly `true`. */
type Assert<T extends true> = T;

/**
 * `createAnthropicTokenCounter({ client })` accepts a real `Anthropic`.
 *
 * Pins down that `messages.countTokens` — Anthropic's server-side
 * token-counting operation — lives on the same stable `messages` namespace as
 * `create`, not behind `client.beta`. It has been there since SDK 0.31.0.
 */
export type AnthropicSatisfiesTokenCountingClient = Assert<
  Anthropic extends AnthropicTokenCountingClient ? true : false
>;
