/**
 * Type-level regression test: a real SDK client must satisfy the structural
 * batch-client interface this package advertises as an `options.client`, with
 * no cast at the call site — and the factories must be able to construct one
 * internally without a cast either.
 *
 * Why this file exists: the SDKs' own parameter types are `interface`s, so they
 * have no implicit index signature and are *not* assignable to
 * `Record<string, unknown>`. Declaring a structural request parameter that way
 * fails both directions of the bivariant method check, which makes
 * `createOpenAIBatchClient({ client })` — the documented escape hatch for a
 * non-default base URL — impossible to call without `as unknown as`. The same
 * trap already cost a migration once; see `GeminiGenerateContentRequest` in
 * `types.ts` and `gemini-client-assignability.test-d.ts`.
 *
 * These assertions also pin down two facts worth failing loudly on: Message
 * Batches live on Anthropic's *stable* `client.messages.batches` in the
 * installed SDK (not only under `client.beta`), and `@google/genai` exposes
 * batches on the client's own `batches` namespace rather than under `models`.
 *
 * Why the `.test-d.ts` suffix: `tsconfig.json` includes `src`, so
 * `bun run check-types` checks this file, while `tsconfig.build.json` excludes
 * the suffix, so it never reaches `dist/` and cannot leak an SDK type into the
 * published declarations. It declares only types, so it is erased entirely and
 * contributes no coverage.
 */
import type { Anthropic } from '@anthropic-ai/sdk';
import type { GoogleGenAI } from '@google/genai';
import type { OpenAI } from 'openai';

import type { AnthropicBatchClient, GeminiBatchClient, OpenAIBatchClient } from './types.ts';

/** Fails to compile unless `T` resolves to exactly `true`. */
type Assert<T extends true> = T;

/** `createAnthropicBatchClient({ client })` accepts a real `Anthropic`. */
export type AnthropicSatisfiesBatchClient = Assert<
  Anthropic extends AnthropicBatchClient ? true : false
>;

/** `createOpenAIBatchClient({ client })` accepts a real `OpenAI`. */
export type OpenAiSatisfiesBatchClient = Assert<OpenAI extends OpenAIBatchClient ? true : false>;

/** `createGeminiBatchClient({ client })` accepts a real `GoogleGenAI`. */
export type GoogleGenAiSatisfiesBatchClient = Assert<
  GoogleGenAI extends GeminiBatchClient ? true : false
>;
