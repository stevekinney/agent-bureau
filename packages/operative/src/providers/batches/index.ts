/**
 * Native batch-inference clients, one per provider that has a batch endpoint.
 *
 * Three factories, not four. Anthropic, OpenAI, and Gemini each ship a native
 * asynchronous batch API and each gets a factory here. An OpenAI-compatible
 * local server — Ollama, vLLM, LM Studio — does not: it reuses OpenAI's chat
 * shape and implements no `/v1/batches`, so there is deliberately nothing here
 * to import for it. That is the whole convention: a capability a provider does
 * not have is absent at compile time, never a factory that throws or no-ops at
 * runtime. `getProviderCapabilities` in `providers/capabilities.ts` reports the
 * same fact for code that picks a provider dynamically.
 *
 * The three surfaces are not unified, because the providers' are not. See each
 * module's `*BatchOperations` interface for what its provider actually offers.
 */
export type { AnthropicBatchClientOptions, AnthropicBatchOperations } from './anthropic.ts';
export { createAnthropicBatchClient } from './anthropic.ts';
export type { GeminiBatchClientOptions, GeminiBatchOperations } from './gemini.ts';
export { createGeminiBatchClient } from './gemini.ts';
export type { OpenAIBatchClientOptions, OpenAIBatchOperations } from './openai.ts';
export { createOpenAIBatchClient } from './openai.ts';
