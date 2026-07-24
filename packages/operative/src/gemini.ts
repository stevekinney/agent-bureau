/**
 * Gemini provider subpath — `@lostgradient/operative/gemini`.
 *
 * Dynamically imports `@google/generative-ai` on first call (zero-SDK-if-unused).
 * This is the preferred import for consumers who only use Gemini, avoiding
 * bundling the Anthropic or OpenAI SDKs.
 *
 * Note: `createGeminiProvider` returns a `GenerateFunction` — an operative
 * seam type naming the operation, not an SDK provider object. The "Provider"
 * suffix names the role (a provider of generation), not the Vercel AI SDK concept.
 */
export { createGeminiProvider, createGeminiProviderStream } from './providers/gemini.ts';
export type {
  GeminiGenerateContentResult,
  GeminiGenerativeModel,
  GeminiProviderOptions,
  GeminiStreamingModel,
} from './providers/types.ts';
