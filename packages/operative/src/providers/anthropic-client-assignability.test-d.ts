/**
 * Type-level regression test: a real `@anthropic-ai/sdk` `Anthropic` instance
 * must satisfy the structural {@link AnthropicClient} and
 * {@link AnthropicStreamingClient} interfaces this package advertises as
 * `options.client`, with no cast at either construction site.
 *
 * Why this file exists: `MessageCreateParamsBase` (and its streaming/
 * non-streaming siblings) are SDK `interface`s, so they have no implicit
 * index signature and are *not* assignable to `Record<string, unknown>`.
 * Declaring the structural request parameter as `Record<string, unknown>`
 * therefore fails both directions of the bivariant method check and made a
 * real `Anthropic` un-injectable without `as unknown as` — the AB-154 defect,
 * fixed for token counting by AB-167
 * (`anthropic-token-counting-assignability.test-d.ts`) and here by AB-174 for
 * `messages.create`.
 *
 * `messages.create` is additionally overloaded three times in the real SDK
 * (`MessageCreateParamsNonStreaming` / `...Streaming` / `...Base`, each
 * returning a different `APIPromise<...>` shape). The two assertions below
 * are what actually pin the resulting shapes down — confirmed empirically
 * against the installed SDK (0.122.0) rather than derived from a documented
 * TypeScript overload-assignability rule. Two consequences fell out of
 * making both pass: {@link AnthropicMessageResponse} widens `stop_reason`
 * and the cache-token `usage` fields to allow `null` (the real
 * `Message`/`Usage` types declare them nullable, not merely optional), and
 * {@link AnthropicStreamingClient} resolves to `Promise<AsyncIterable<...>>`
 * rather than a bare `AsyncIterable<...>`, since the SDK's streaming
 * overload returns an `APIPromise` — a `Promise`, not itself iterable.
 *
 * Why the `.test-d.ts` suffix: `tsconfig.json` includes `src`, so
 * `bun run check-types` checks this file, while `tsconfig.build.json`
 * excludes the suffix, so it never reaches `dist/` and cannot leak
 * `@anthropic-ai/sdk` into the published declarations — the SDK is an
 * *optional* peer dependency, so a published declaration referencing it
 * would break every consumer who does not install it. It declares only
 * types, so it is erased entirely and contributes no coverage.
 */
import type { Anthropic } from '@anthropic-ai/sdk';

import type { AnthropicClient, AnthropicStreamingClient } from './types.ts';

/** Fails to compile unless `T` resolves to exactly `true`. */
type Assert<T extends true> = T;

/**
 * `createAnthropicProvider({ client })` accepts a real `Anthropic`, with no
 * `as unknown as AnthropicClient` at the SDK construction site.
 */
export type AnthropicSatisfiesClient = Assert<Anthropic extends AnthropicClient ? true : false>;

/**
 * `createAnthropicProviderStream({ client })` accepts a real `Anthropic`,
 * with no `as unknown as AnthropicStreamingClient` at the SDK construction
 * site.
 */
export type AnthropicSatisfiesStreamingClient = Assert<
  Anthropic extends AnthropicStreamingClient ? true : false
>;
