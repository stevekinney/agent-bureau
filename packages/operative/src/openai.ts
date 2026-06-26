/**
 * OpenAI provider subpath — `operative/openai`.
 *
 * Dynamically imports `openai` on first call (zero-SDK-if-unused).
 * This is the preferred import for consumers who only use OpenAI, avoiding
 * bundling the Anthropic or Gemini SDKs. Also works with any OpenAI-compatible
 * endpoint (LM Studio, Ollama, Groq, etc.) via `baseURL`.
 *
 * Note: `createOpenAIProvider` returns a `GenerateFunction` — an operative
 * seam type naming the operation, not an SDK provider object. The "Provider"
 * suffix names the role (a provider of generation), not the Vercel AI SDK concept.
 */
export { createOpenAIProvider, createOpenAIProviderStream } from './providers/openai.ts';
export type {
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIClient,
  OpenAIProviderOptions,
  OpenAIStreamingClient,
} from './providers/types.ts';
