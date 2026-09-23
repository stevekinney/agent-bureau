/**
 * Operative providers — LLM provider factories folded from the former herald package.
 *
 * These are re-exported from the `@lostgradient/operative` root entry point. Each
 * provider loads its SDK dynamically when called, so unused SDKs stay unused.
 */

export {
  createAnthropicProvider,
  createAnthropicProviderStream,
  createAnthropicTokenCounter,
} from './anthropic.ts';
export type {
  AnthropicTokenCounterOptions,
  AnthropicTokenCountingOperations,
} from './anthropic.ts';
export { readBackendDescriptors, withBackendDescriptors } from './backend-descriptor-attachment.ts';
export {
  createAnthropicBatchClient,
  createGeminiBatchClient,
  createOpenAIBatchClient,
} from './batches/index.ts';
export type {
  AnthropicBatchClientOptions,
  AnthropicBatchOperations,
  GeminiBatchClientOptions,
  GeminiBatchOperations,
  OpenAIBatchClientOptions,
  OpenAIBatchOperations,
} from './batches/index.ts';
export { getProviderCapabilities } from './capabilities.ts';
export type { ProviderCapabilities } from './capabilities.ts';
export {
  createGeminiEmbedder,
  createOllamaEmbedder,
  createOpenAIEmbedder,
  createVoyageEmbedder,
} from './embeddings/index.ts';
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
  ProviderError,
  ToolCallParseError,
  isToolCallParseError,
  shouldRetryProviderError,
} from './errors.ts';
export {
  FalloverExhaustedError,
  classifyProviderError,
  createFalloverGenerate,
  createProviderHealthTracker,
} from './fallover/index.ts';
export type {
  ErrorClassification,
  FalloverEvent,
  FalloverOptions,
  FalloverProvider,
  ProviderHealth,
} from './fallover/index.ts';
export {
  createGeminiProvider,
  createGeminiProviderStream,
  createGeminiTokenCounter,
} from './gemini.ts';
export type { GeminiTokenCounterOptions, GeminiTokenCountingOperations } from './gemini.ts';
export {
  GENERAL_PROJECTION_REDACTED_KEYS,
  projectCatalog,
  projectDescriptor,
} from './model-catalog-projection.ts';
export { createModelCatalog } from './model-catalog.ts';
export type {
  BackendDescriptor,
  BackendLifecycleState,
  CatalogProjection,
  CreateModelCatalogOptions,
  EffortSupport,
  GeneratedAssetBehavior,
  ModelAlias,
  ModelCatalog,
} from './model-catalog.ts';
export { createOpenAIProvider, createOpenAIProviderStream } from './openai.ts';
export { composePolicy } from './policy.ts';
export type {
  BureauInvariants,
  ComposePolicyInput,
  DelegatedAuthority,
  DeploymentInvariants,
  PolicyCandidate,
  SelectionExclusionCode,
  UserModelConfiguration,
} from './policy.ts';
export {
  composeStrategies,
  createComplexityStrategy,
  createCostAwareStrategy,
  createRoutingGenerate,
  createStepBasedStrategy,
  extractComplexitySignals,
  withRoutingMetrics,
} from './routing/index.ts';
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
export { recordEffectiveGeneration, select } from './selection.ts';
export type {
  EffectiveGenerationResult,
  RevalidationInput,
  SelectOptions,
  SelectionCandidate,
  SelectionOutcomeFailure,
  SelectionOutcomeKind,
  SelectionPlan,
  SelectionRequest,
  TaskClassification,
} from './selection.ts';
export {
  ANTHROPIC_EFFORT_SUPPORT,
  GEMINI_THINKING_MODELS,
  OPENAI_REASONING_MODELS,
  resolveAnthropicEffort,
  resolveGeminiEffort,
  resolveOpenAIEffort,
} from './shared/effort.ts';
export type { GeminiResolvedEffort } from './shared/effort.ts';
export {
  ANTHROPIC_MODEL_ALIASES,
  GEMINI_MODEL_ALIASES,
  OPENAI_MODEL_ALIASES,
  resolveAnthropicModel,
  resolveGeminiModel,
  resolveOpenAIModel,
} from './shared/model-registry.ts';
export { normalizeAnthropicStream, normalizeOpenAIStream } from './streaming/index.ts';
export {
  toAnthropicToolChoice,
  toGeminiResponseFormat,
  toGeminiToolChoice,
  toOpenAIResponseFormat,
  toOpenAIToolChoice,
} from './structured-output/index.ts';
export type { ResponseFormat, ToolChoice } from './structured-output/index.ts';
export type {
  AnthropicBatchClient,
  AnthropicBatchCreateRequest,
  AnthropicBatchCreateRequestItem,
  AnthropicBatchListQuery,
  AnthropicClient,
  AnthropicCountTokensRequest,
  AnthropicMessageBatch,
  AnthropicMessageBatchIndividualResponse,
  AnthropicMessageBatchRequestCounts,
  AnthropicMessageBatchResult,
  AnthropicMessageCreateRequest,
  AnthropicMessageResponse,
  AnthropicProviderOptions,
  AnthropicRequestOptions,
  AnthropicStreamEvent,
  AnthropicStreamingClient,
  AnthropicThinkingConfig,
  AnthropicTokenCountingClient,
  BaseProviderOptions,
  Effort,
  GeminiBatchClient,
  GeminiBatchJob,
  GeminiBatchJobReference,
  GeminiCacheCreatingClient,
  GeminiCachedContent,
  GeminiCountTokensRequest,
  GeminiCreateBatchJobRequest,
  GeminiCreateCachedContentRequest,
  GeminiDeleteResourceJob,
  GeminiGenerateContentRequest,
  GeminiGenerateContentResult,
  GeminiGenerativeModel,
  GeminiListBatchJobsRequest,
  GeminiProviderOptions,
  GeminiStreamingModel,
  GeminiTokenCountingClient,
  GeminiUsageMetadata,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  OpenAIBatch,
  OpenAIBatchClient,
  OpenAIBatchCreateRequest,
  OpenAIBatchListQuery,
  OpenAIBatchRequestCounts,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIClient,
  OpenAIProviderOptions,
  OpenAIRequestOptions,
  OpenAIStreamingClient,
  ProviderName,
  StreamingGenerateFunction,
  StreamingHandle,
  TokenCountResult,
  TokenUsage,
} from './types.ts';
