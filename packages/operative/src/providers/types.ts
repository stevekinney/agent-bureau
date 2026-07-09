import type { ResponseFormat, ToolChoice } from './structured-output/types.ts';

export type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
  TokenUsage,
} from '../types.ts';

/**
 * Provider names supported by operative providers.
 */
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'voyage' | 'ollama';

/**
 * Provider-neutral reasoning-effort tier. Superset of Tribunal's
 * `effort IN ('low','medium','high','xhigh','max')` database CHECK
 * constraint. Each shipped provider maps this to its own native mechanism —
 * see `providers/shared/effort.ts` for the per-provider mapping table and
 * the fallback matrix used when a resolved model doesn't support a tier.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Base options shared across all provider factories.
 */
export interface BaseProviderOptions {
  /**
   * Provider-native model ID, OR a shorthand alias resolved once at
   * provider-construction time — see `providers/shared/model-registry.ts`
   * for the per-provider alias table and its single resolution point.
   * Full provider-native IDs pass through unchanged. The alias `'inherit'`
   * is never resolved here; it is a caller-side concern (see that module's
   * doc comment).
   */
  model: string;
  /**
   * Provider-neutral effort tier. Mapped to the resolved model's native
   * mechanism, with a deterministic fallback when unsupported — see
   * `providers/shared/effort.ts`. The actually-used tier is reported back
   * on `GenerateResponse.metadata.effectiveEffort`.
   */
  effort?: Effort;
  maximumTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
}

/**
 * Structural interface for the Anthropic SDK client surface the provider uses.
 */
export interface AnthropicClient {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicMessageResponse>;
  };
}

/**
 * Minimal shape of an Anthropic Messages API response.
 */
export interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  stop_reason?: string;
}

/**
 * Options for createAnthropicProvider.
 */
export interface AnthropicProviderOptions extends BaseProviderOptions {
  client?: AnthropicClient;
  apiKey?: string;
}

/**
 * Structural interface for the OpenAI SDK client surface the provider uses.
 */
export interface OpenAIClient {
  chat: {
    completions: {
      create(params: Record<string, unknown>): Promise<OpenAIChatCompletion>;
    };
  };
}

/**
 * Minimal shape of an OpenAI Chat Completion response.
 */
export interface OpenAIChatCompletion {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Options for createOpenAIProvider.
 */
export interface OpenAIProviderOptions extends BaseProviderOptions {
  client?: OpenAIClient;
  apiKey?: string;
  baseURL?: string;
}

/**
 * Structural interface for a Gemini GenerativeModel instance.
 */
export interface GeminiGenerativeModel {
  generateContent(params: Record<string, unknown>): Promise<GeminiGenerateContentResult>;
}

/**
 * Minimal shape of a Gemini generateContent result.
 */
export interface GeminiGenerateContentResult {
  response: {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          functionCall?: { name: string; args: Record<string, unknown> };
        }>;
      };
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
}

/**
 * Options for createGeminiProvider.
 */
export interface GeminiProviderOptions extends BaseProviderOptions {
  client?: GeminiGenerativeModel;
  apiKey?: string;
}

// ── Streaming Types ─────────────────────────────────────────────────

/**
 * Events emitted by the Anthropic Messages API when streaming.
 */
export interface AnthropicStreamEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop';
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  index?: number;
  content_block?: { type: string; id?: string; name?: string; text?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
    usage?: { output_tokens?: number };
  };
  usage?: { output_tokens?: number };
}

/**
 * A single chunk from the OpenAI Chat Completions streaming API.
 */
export interface OpenAIChatCompletionChunk {
  choices: Array<{
    delta: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

/**
 * Structural interface for an Anthropic client that supports streaming.
 */
export interface AnthropicStreamingClient {
  messages: {
    create(params: Record<string, unknown>): AsyncIterable<AnthropicStreamEvent>;
  };
}

/**
 * Structural interface for an OpenAI client that supports streaming.
 */
export interface OpenAIStreamingClient {
  chat: {
    completions: {
      create(params: Record<string, unknown>): AsyncIterable<OpenAIChatCompletionChunk>;
    };
  };
}

/**
 * Structural interface for a Gemini GenerativeModel that supports streaming.
 */
export interface GeminiStreamingModel {
  generateContentStream(
    params: Record<string, unknown>,
  ): Promise<{ stream: AsyncIterable<GeminiGenerateContentResult['response']> }>;
}
