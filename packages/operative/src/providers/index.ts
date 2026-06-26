/**
 * Operative providers — LLM provider factories folded from the former herald package.
 *
 * These are re-exported from the three provider subpaths for consumers who want
 * all providers at once. For tree-shaking, prefer the individual subpaths:
 *   import { createAnthropicProvider } from 'operative/anthropic'
 *   import { createOpenAIProvider }    from 'operative/openai'
 *   import { createGeminiProvider }    from 'operative/gemini'
 */

export { createAnthropicProvider, createAnthropicProviderStream } from './anthropic.ts';
export type {
  GeminiEmbedderOptions,
  GeminiEmbeddingClient,
  GeminiEmbeddingModel,
  OllamaEmbedderOptions,
  OpenAIEmbedderOptions,
  OpenAIEmbeddingClient,
  VoyageEmbedderOptions,
} from './embeddings/index.ts';
export {
  createGeminiEmbedder,
  createOllamaEmbedder,
  createOpenAIEmbedder,
  createVoyageEmbedder,
} from './embeddings/index.ts';
export { ProviderError, shouldRetryProviderError } from './errors.ts';
export type {
  ErrorClassification,
  FalloverEvent,
  FalloverOptions,
  FalloverProvider,
  ProviderHealth,
} from './fallover/index.ts';
export {
  classifyProviderError,
  createFalloverGenerate,
  createProviderHealthTracker,
  FalloverExhaustedError,
} from './fallover/index.ts';
export { createGeminiProvider, createGeminiProviderStream } from './gemini.ts';
export { createOpenAIProvider, createOpenAIProviderStream } from './openai.ts';
export type {
  ComplexitySignals,
  ComplexityStrategyOptions,
  CostAwareStrategyOptions,
  ModelRoute,
  RoutingDecision,
  RoutingEvent,
  RoutingMetrics,
  RoutingMetricsResult,
  RoutingOptions,
  RoutingStrategy,
  StepBasedStrategyOptions,
} from './routing/index.ts';
export {
  composeStrategies,
  createComplexityStrategy,
  createCostAwareStrategy,
  createRoutingGenerate,
  createStepBasedStrategy,
  extractComplexitySignals,
  withRoutingMetrics,
} from './routing/index.ts';
export { normalizeAnthropicStream, normalizeOpenAIStream } from './streaming/index.ts';
export type { ResponseFormat, ToolChoice } from './structured-output/index.ts';
export {
  toAnthropicToolChoice,
  toGeminiResponseFormat,
  toGeminiToolChoice,
  toOpenAIResponseFormat,
  toOpenAIToolChoice,
} from './structured-output/index.ts';
export type {
  AnthropicClient,
  AnthropicMessageResponse,
  AnthropicProviderOptions,
  AnthropicStreamEvent,
  AnthropicStreamingClient,
  BaseProviderOptions,
  GeminiGenerateContentResult,
  GeminiGenerativeModel,
  GeminiProviderOptions,
  GeminiStreamingModel,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIClient,
  OpenAIProviderOptions,
  OpenAIStreamingClient,
  ProviderName,
  StreamingGenerateFunction,
  StreamingHandle,
  TokenUsage,
} from './types.ts';
