import type {
  AnthropicClient,
  AnthropicMessageCreateRequest,
  AnthropicMessageResponse,
  AnthropicRequestOptions,
  AnthropicStreamEvent,
  AnthropicStreamingClient,
  GeminiGenerateContentRequest,
  GeminiGenerateContentResult,
  GeminiGenerativeModel,
  GeminiStreamingModel,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIClient,
  OpenAIStreamingClient,
} from '../types.ts';

export interface MockAnthropicClient extends AnthropicClient {
  _calls: AnthropicMessageCreateRequest[];
  /** The request-options argument of each call, index-aligned with `_calls`. */
  _requestOptions: Array<AnthropicRequestOptions | undefined>;
  _responses: AnthropicMessageResponse[];
  _errors: Error[];
}

/**
 * Creates a mock Anthropic client that records calls and returns queued responses.
 */
export function createMockAnthropicClient(
  responses: AnthropicMessageResponse[],
  errors: Error[] = [],
): MockAnthropicClient {
  const calls: AnthropicMessageCreateRequest[] = [];
  const requestOptions: Array<AnthropicRequestOptions | undefined> = [];
  let responseIndex = 0;
  let errorIndex = 0;

  return {
    _calls: calls,
    _requestOptions: requestOptions,
    _responses: responses,
    _errors: errors,
    messages: {
      async create(
        params: AnthropicMessageCreateRequest,
        options?: AnthropicRequestOptions,
      ): Promise<AnthropicMessageResponse> {
        calls.push(params);
        requestOptions.push(options);
        const error = errors[errorIndex];
        if (error && errorIndex < errors.length) {
          errorIndex++;
          throw error;
        }
        const response = responses[responseIndex];
        if (!response) {
          throw new Error(
            `MockAnthropicClient: no response at index ${responseIndex} (${responses.length} total)`,
          );
        }
        responseIndex++;
        return response;
      },
    },
  };
}

export interface MockOpenAIClient extends OpenAIClient {
  _calls: Array<Record<string, unknown>>;
  _responses: OpenAIChatCompletion[];
  _errors: Error[];
}

/**
 * Creates a mock OpenAI client that records calls and returns queued responses.
 */
export function createMockOpenAIClient(
  responses: OpenAIChatCompletion[],
  errors: Error[] = [],
): MockOpenAIClient {
  const calls: Array<Record<string, unknown>> = [];
  let responseIndex = 0;
  let errorIndex = 0;

  return {
    _calls: calls,
    _responses: responses,
    _errors: errors,
    chat: {
      completions: {
        async create(params: Record<string, unknown>): Promise<OpenAIChatCompletion> {
          calls.push(params);
          const error = errors[errorIndex];
          if (error && errorIndex < errors.length) {
            errorIndex++;
            throw error;
          }
          const response = responses[responseIndex];
          if (!response) {
            throw new Error(
              `MockOpenAIClient: no response at index ${responseIndex} (${responses.length} total)`,
            );
          }
          responseIndex++;
          return response;
        },
      },
    },
  };
}

export interface MockGeminiModel extends GeminiGenerativeModel {
  _calls: GeminiGenerateContentRequest[];
  _responses: GeminiGenerateContentResult[];
  _errors: Error[];
}

/**
 * Creates a mock `@google/genai` client that records calls and returns queued
 * responses. Calls land on the `models` namespace, matching the maintained SDK.
 */
export function createMockGeminiModel(
  responses: GeminiGenerateContentResult[],
  errors: Error[] = [],
): MockGeminiModel {
  const calls: GeminiGenerateContentRequest[] = [];
  let responseIndex = 0;
  let errorIndex = 0;

  return {
    _calls: calls,
    _responses: responses,
    _errors: errors,
    models: {
      async generateContent(
        params: GeminiGenerateContentRequest,
      ): Promise<GeminiGenerateContentResult> {
        calls.push(params);
        const error = errors[errorIndex];
        if (error && errorIndex < errors.length) {
          errorIndex++;
          throw error;
        }
        const response = responses[responseIndex];
        if (!response) {
          throw new Error(
            `MockGeminiModel: no response at index ${responseIndex} (${responses.length} total)`,
          );
        }
        responseIndex++;
        return response;
      },
    },
  };
}

// ── Streaming Mock Clients ──────────────────────────────────────────

export interface MockAnthropicStreamingClient extends AnthropicStreamingClient {
  _calls: AnthropicMessageCreateRequest[];
  /** The request-options argument of each call, index-aligned with `_calls`. */
  _requestOptions: Array<AnthropicRequestOptions | undefined>;
  _eventSequences: AnthropicStreamEvent[][];
  _errors: Error[];
}

/**
 * Creates a mock Anthropic streaming client that yields queued event sequences.
 *
 * When `errorAfterEvents` is set, the async generator yields that many events
 * from the current sequence before throwing the next error from `errors`.
 *
 * `create` returns its async generator synchronously, and queued errors throw
 * synchronously, so `for await (const event of client.messages.create(params))`
 * works directly against this mock. {@link AnthropicStreamingClient} accepts
 * either that bare iterable or a `Promise` of one, the latter because the real
 * SDK's `create` returns an `APIPromise` rather than a bare async iterable —
 * see the interface's doc comment in `types.ts`.
 */
export function createMockAnthropicStreamingClient(
  eventSequences: AnthropicStreamEvent[][],
  errors: Error[] = [],
  options?: { errorAfterEvents?: number },
): MockAnthropicStreamingClient {
  const calls: AnthropicMessageCreateRequest[] = [];
  const requestOptions: Array<AnthropicRequestOptions | undefined> = [];
  let sequenceIndex = 0;
  let errorIndex = 0;
  const errorAfterEvents = options?.errorAfterEvents;

  return {
    _calls: calls,
    _requestOptions: requestOptions,
    _eventSequences: eventSequences,
    _errors: errors,
    messages: {
      create(
        params: AnthropicMessageCreateRequest,
        callOptions?: AnthropicRequestOptions,
      ): AsyncIterable<AnthropicStreamEvent> {
        calls.push(params);
        requestOptions.push(callOptions);
        const error = errors[errorIndex];
        if (error && errorIndex < errors.length && errorAfterEvents === undefined) {
          errorIndex++;
          throw error;
        }
        const events = eventSequences[sequenceIndex++] ?? [];
        const midStreamError =
          errorAfterEvents !== undefined && errorIndex < errors.length
            ? errors[errorIndex++]
            : undefined;
        const threshold = errorAfterEvents ?? 0;

        return (async function* () {
          let yielded = 0;
          for (const event of events) {
            if (midStreamError && yielded >= threshold) {
              throw midStreamError;
            }
            yield event;
            yielded++;
          }
          if (midStreamError && yielded <= threshold) {
            throw midStreamError;
          }
        })();
      },
    },
  };
}

export interface MockOpenAIStreamingClient extends OpenAIStreamingClient {
  _calls: Array<Record<string, unknown>>;
  _chunkSequences: OpenAIChatCompletionChunk[][];
  _errors: Error[];
}

/**
 * Creates a mock OpenAI streaming client that yields queued chunk sequences.
 *
 * When `errorAfterEvents` is set, the async generator yields that many chunks
 * from the current sequence before throwing the next error from `errors`.
 */
export function createMockOpenAIStreamingClient(
  chunkSequences: OpenAIChatCompletionChunk[][],
  errors: Error[] = [],
  options?: { errorAfterEvents?: number },
): MockOpenAIStreamingClient {
  const calls: Array<Record<string, unknown>> = [];
  let sequenceIndex = 0;
  let errorIndex = 0;
  const errorAfterEvents = options?.errorAfterEvents;

  return {
    _calls: calls,
    _chunkSequences: chunkSequences,
    _errors: errors,
    chat: {
      completions: {
        create(params: Record<string, unknown>): AsyncIterable<OpenAIChatCompletionChunk> {
          calls.push(params);
          const error = errors[errorIndex];
          if (error && errorIndex < errors.length && errorAfterEvents === undefined) {
            errorIndex++;
            throw error;
          }
          const chunks = chunkSequences[sequenceIndex++] ?? [];
          const midStreamError =
            errorAfterEvents !== undefined && errorIndex < errors.length
              ? errors[errorIndex++]
              : undefined;
          const threshold = errorAfterEvents ?? 0;

          return (async function* () {
            let yielded = 0;
            for (const chunk of chunks) {
              if (midStreamError && yielded >= threshold) {
                throw midStreamError;
              }
              yield chunk;
              yielded++;
            }
            if (midStreamError && yielded <= threshold) {
              throw midStreamError;
            }
          })();
        },
      },
    },
  };
}

export interface MockGeminiStreamingModel extends GeminiStreamingModel {
  _calls: GeminiGenerateContentRequest[];
  _chunkSequences: GeminiGenerateContentResult[][];
  _errors: Error[];
}

/**
 * Creates a mock `@google/genai` streaming client that yields queued chunk
 * sequences. `models.generateContentStream` resolves to the async iterable
 * directly, matching the maintained SDK — there is no `{ stream }` wrapper.
 *
 * When `errorAfterEvents` is set, the async generator yields that many chunks
 * from the current sequence before throwing the next error from `errors`.
 */
export function createMockGeminiStreamingModel(
  chunkSequences: GeminiGenerateContentResult[][],
  errors: Error[] = [],
  options?: { errorAfterEvents?: number },
): MockGeminiStreamingModel {
  const calls: GeminiGenerateContentRequest[] = [];
  let sequenceIndex = 0;
  let errorIndex = 0;
  const errorAfterEvents = options?.errorAfterEvents;

  return {
    _calls: calls,
    _chunkSequences: chunkSequences,
    _errors: errors,
    models: {
      async generateContentStream(
        params: GeminiGenerateContentRequest,
      ): Promise<AsyncIterable<GeminiGenerateContentResult>> {
        calls.push(params);
        const error = errors[errorIndex];
        if (error && errorIndex < errors.length && errorAfterEvents === undefined) {
          errorIndex++;
          throw error;
        }
        const chunks = chunkSequences[sequenceIndex++] ?? [];
        const midStreamError =
          errorAfterEvents !== undefined && errorIndex < errors.length
            ? errors[errorIndex++]
            : undefined;
        const threshold = errorAfterEvents ?? 0;

        return (async function* () {
          let yielded = 0;
          for (const chunk of chunks) {
            if (midStreamError && yielded >= threshold) {
              throw midStreamError;
            }
            yield chunk;
            yielded++;
          }
          if (midStreamError && yielded <= threshold) {
            throw midStreamError;
          }
        })();
      },
    },
  };
}
