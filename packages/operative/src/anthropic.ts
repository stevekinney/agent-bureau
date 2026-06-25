/**
 * Anthropic provider subpath — `operative/anthropic`.
 *
 * Dynamically imports `@anthropic-ai/sdk` on first call (zero-SDK-if-unused).
 * This is the preferred import for consumers who only use Anthropic, avoiding
 * bundling the OpenAI or Gemini SDKs.
 *
 * Note: `createAnthropicProvider` returns a `GenerateFunction` — an operative
 * seam type naming the operation, not an SDK provider object. The "Provider"
 * suffix names the role (a provider of generation), not the Vercel AI SDK concept.
 */
export { createAnthropicProvider, createAnthropicProviderStream } from './providers/anthropic.ts';
export type {
  AnthropicClient,
  AnthropicMessageResponse,
  AnthropicProviderOptions,
  AnthropicStreamEvent,
  AnthropicStreamingClient,
} from './providers/types.ts';
