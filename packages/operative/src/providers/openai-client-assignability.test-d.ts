/**
 * Type-level regression test: a real `openai` SDK `OpenAI` instance must
 * satisfy the structural {@link OpenAIClient} and {@link OpenAIStreamingClient}
 * interfaces with no cast at either construction site.
 */
import type { OpenAI } from 'openai';
import type { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';

import type { MockOpenAIStreamingClient } from './test/mock-clients.ts';
import type {
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionCreateRequest,
  OpenAIClient,
  OpenAIStreamingClient,
} from './types.ts';

/** Fails to compile unless `T` resolves to exactly `true`. */
type Assert<T extends true> = T;

export type OpenAISatisfiesClient = Assert<OpenAI extends OpenAIClient ? true : false>;

export type OpenAISatisfiesStreamingClient = Assert<
  OpenAI extends OpenAIStreamingClient ? true : false
>;

/** Every SDK request field is named on {@link OpenAIChatCompletionCreateRequest}. */
export type RequestNamesEverySdkField = Assert<
  keyof ChatCompletionCreateParamsBase extends keyof OpenAIChatCompletionCreateRequest
    ? true
    : false
>;

/** The streaming mock accepts a bare iterable as well as a promise of one. */
export type StreamingMockAcceptsBareIterable = Assert<
  AsyncIterable<OpenAIChatCompletionChunk> extends ReturnType<
    MockOpenAIStreamingClient['chat']['completions']['create']
  >
    ? true
    : false
>;
