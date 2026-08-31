/**
 * Type-level regression test: a real `@google/genai` `GoogleGenAI` instance
 * must satisfy every structural client interface this package advertises as an
 * `options.client`, with no cast at the call site.
 *
 * Why this file exists: `GenerateContentParameters` and `EmbedContentParameters`
 * are SDK `interface`s, so they have no implicit index signature and are *not*
 * assignable to `Record<string, unknown>`. Declaring a structural request
 * parameter as `Record<string, unknown>` therefore fails both directions of the
 * bivariant method check and makes `createGeminiProvider({ client })` — the
 * headline migration path — impossible to call without `as unknown as`.
 *
 * Why the `.test-d.ts` suffix: `tsconfig.json` includes `src`, so
 * `bun run check-types` checks this file, while `tsconfig.build.json` excludes
 * the suffix, so it never reaches `dist/` and cannot leak `@google/genai` into
 * the published declarations. It declares only types, so it is erased entirely
 * and contributes no coverage.
 */
import type { GoogleGenAI } from '@google/genai';

import type { GeminiEmbeddingClient } from './embeddings/gemini.ts';
import type {
  GeminiCacheCreatingClient,
  GeminiGenerativeModel,
  GeminiStreamingModel,
  GeminiTokenCountingClient,
} from './types.ts';

/** Fails to compile unless `T` resolves to exactly `true`. */
type Assert<T extends true> = T;

/** `createGeminiProvider({ client })` accepts a real `GoogleGenAI`. */
export type GoogleGenAiSatisfiesGenerativeModel = Assert<
  GoogleGenAI extends GeminiGenerativeModel ? true : false
>;

/** `createGeminiProviderStream({ client })` accepts a real `GoogleGenAI`. */
export type GoogleGenAiSatisfiesStreamingModel = Assert<
  GoogleGenAI extends GeminiStreamingModel ? true : false
>;

/** `createGeminiEmbedder({ client })` accepts a real `GoogleGenAI`. */
export type GoogleGenAiSatisfiesEmbeddingClient = Assert<
  GoogleGenAI extends GeminiEmbeddingClient ? true : false
>;

/**
 * The provider-managed context cache can call `caches.create` on a real
 * `GoogleGenAI` — as `createGeminiProvider`'s own imported client, and as a
 * caller's `client` or `cacheClient`.
 *
 * This pins down that context caching lives on the `caches` namespace of the
 * maintained SDK's top-level client. It is emphatically not the deprecated
 * `@google/generative-ai` `getGenerativeModelFromCachedContent` shape, which
 * bound a cache to a model handle at construction time and which this SDK does
 * not carry forward: here a cache is a standalone named resource, created
 * through `caches.create` and referenced by name on an ordinary request.
 */
export type GoogleGenAiSatisfiesCacheCreatingClient = Assert<
  GoogleGenAI extends GeminiCacheCreatingClient ? true : false
>;

/**
 * `createGeminiTokenCounter({ client })` accepts a real `GoogleGenAI`.
 *
 * Pins down that `models.countTokens` — the maintained SDK's server-side
 * token-counting operation — lives on the same `models` namespace as
 * `generateContent`, not on a separate counting-specific client.
 */
export type GoogleGenAiSatisfiesTokenCountingClient = Assert<
  GoogleGenAI extends GeminiTokenCountingClient ? true : false
>;
