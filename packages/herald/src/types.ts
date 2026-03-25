import type { GenerateFunction } from 'operative';

export type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
  TokenUsage,
} from 'operative';

/**
 * Provider names supported by herald.
 */
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'voyage' | 'ollama';

/**
 * Base options shared across all provider factories.
 */
export interface BaseProviderOptions {
  model: string;
  maximumTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

/**
 * Structural interface for the Anthropic SDK client surface herald uses.
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
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

/**
 * Options for createAnthropicGenerate.
 */
export interface AnthropicProviderOptions extends BaseProviderOptions {
  client?: AnthropicClient;
  apiKey?: string;
}

/**
 * Structural interface for the OpenAI SDK client surface herald uses.
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
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * Options for createOpenAIGenerate.
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
 * Options for createGeminiGenerate.
 */
export interface GeminiProviderOptions extends BaseProviderOptions {
  client?: GeminiGenerativeModel;
  apiKey?: string;
}

/**
 * Common return type — all factories return a GenerateFunction.
 */
export type CreateProviderGenerate<T extends BaseProviderOptions> = (
  options: T,
) => GenerateFunction;

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
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  index?: number;
  content_block?: { type: string; id?: string; name?: string; text?: string };
  delta?: {
    type?: string;
    text?: string;
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
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
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
