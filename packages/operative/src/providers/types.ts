import type { Message } from 'conversationalist';

import type { TokenBudget } from '../context/token-budget.ts';
import type { ContextAssembler } from '../context/types.ts';
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
  /**
   * Provider-neutral per-run request metadata, attached to every generate
   * request of the run. Mapped to each provider's native field: Anthropic
   * Messages `metadata`; OpenAI Chat Completions `metadata` (native
   * string-keyed map, up to 16 keys). Gemini has no request-level metadata
   * field in its API — this option is an explicit no-op for
   * {@link createGeminiProvider}.
   *
   * Anthropic caveat: its `Metadata` type documents exactly one field
   * (`user_id`) — the whole object is still forwarded as-is so a
   * credential-injecting proxy (see {@link AnthropicProviderOptions.baseURL})
   * can inspect arbitrary keys on the wire, but sending non-`user_id` keys
   * straight to Anthropic's real endpoint (no proxy in front) gets the
   * request rejected. Only pass extra keys when a proxy will translate or
   * strip them before forwarding.
   */
  requestMetadata?: Record<string, string>;
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
  /**
   * Overrides the Anthropic SDK's default base URL. Accepts any string —
   * including a credential-injecting proxy origin — with no shape
   * validation. Passed straight to the `Anthropic` client constructor.
   */
  baseURL?: string;
  /**
   * Opts every `cache_control` breakpoint lowered from a conversation
   * `cacheBoundary` into Anthropic's extended one-hour cache TTL instead of
   * the default 5-minute one. No effect unless `assembler`/`contextBudget`
   * (or an already-marked conversation) actually produce a cache boundary.
   */
  extendedCacheTtl?: boolean;
  /**
   * Enables prompt-cache-aware context assembly. When set (together with
   * {@link AnthropicProviderOptions.contextBudget}), each call runs
   * `assembler` in stable-prefix mode instead of sending the conversation
   * verbatim. The resulting `cacheBoundary` mark on the assembled
   * system/pinned prefix is preserved through to the request, so
   * `toAnthropicMessages` lowers it to a `cache_control` breakpoint — see
   * `createContextAssembler`'s `stablePrefix` option.
   */
  assembler?: ContextAssembler;
  /** Token budget passed to `assembler`. Required when `assembler` is set. */
  contextBudget?: TokenBudget;
  /** Passed through to `assembler` as `pinnedMessages` (e.g. reference docs, tool usage notes). */
  pinnedMessages?: ReadonlyArray<Message>;
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
  /**
   * Overrides the OpenAI SDK's default base URL. Accepts any string —
   * including a credential-injecting proxy origin — with no shape
   * validation. Enables LM Studio, Ollama, Groq, etc.
   */
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
  /**
   * Overrides the Gemini SDK's default base URL (`RequestOptions.baseUrl`).
   * Accepts any string — including a credential-injecting proxy origin —
   * with no shape validation.
   */
  baseURL?: string;
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
