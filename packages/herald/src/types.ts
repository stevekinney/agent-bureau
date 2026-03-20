import type { GenerateFunction } from 'operative';

export type { GenerateContext, GenerateFunction, GenerateResponse, TokenUsage } from 'operative';

/**
 * Provider names supported by herald.
 */
export type ProviderName = 'anthropic' | 'openai' | 'gemini';

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
