import type {
  AnthropicClient,
  AnthropicMessageResponse,
  AnthropicStreamEvent,
  AnthropicStreamingClient,
  GeminiGenerateContentResult,
  GeminiGenerativeModel,
  GeminiStreamingModel,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIClient,
  OpenAIStreamingClient,
} from '../types.ts';

export interface MockAnthropicClient extends AnthropicClient {
  _calls: Array<Record<string, unknown>>;
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
  const calls: Array<Record<string, unknown>> = [];
  let responseIndex = 0;
  let errorIndex = 0;

  return {
    _calls: calls,
    _responses: responses,
    _errors: errors,
    messages: {
      async create(params: Record<string, unknown>): Promise<AnthropicMessageResponse> {
        calls.push(params);
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
  _calls: Array<Record<string, unknown>>;
  _responses: GeminiGenerateContentResult[];
  _errors: Error[];
}

/**
 * Creates a mock Gemini GenerativeModel that records calls and returns queued responses.
 */
export function createMockGeminiModel(
  responses: GeminiGenerateContentResult[],
  errors: Error[] = [],
): MockGeminiModel {
  const calls: Array<Record<string, unknown>> = [];
  let responseIndex = 0;
  let errorIndex = 0;

  return {
    _calls: calls,
    _responses: responses,
    _errors: errors,
    async generateContent(params: Record<string, unknown>): Promise<GeminiGenerateContentResult> {
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
  };
}

// ── Streaming Mock Clients ──────────────────────────────────────────

export interface MockAnthropicStreamingClient extends AnthropicStreamingClient {
  _calls: Array<Record<string, unknown>>;
  _eventSequences: AnthropicStreamEvent[][];
  _errors: Error[];
}

/**
 * Creates a mock Anthropic streaming client that yields queued event sequences.
 */
export function createMockAnthropicStreamingClient(
  eventSequences: AnthropicStreamEvent[][],
  errors: Error[] = [],
): MockAnthropicStreamingClient {
  const calls: Array<Record<string, unknown>> = [];
  let sequenceIndex = 0;
  let errorIndex = 0;

  return {
    _calls: calls,
    _eventSequences: eventSequences,
    _errors: errors,
    messages: {
      create(params: Record<string, unknown>): AsyncIterable<AnthropicStreamEvent> {
        calls.push(params);
        const error = errors[errorIndex];
        if (error && errorIndex < errors.length) {
          errorIndex++;
          throw error;
        }
        const events = eventSequences[sequenceIndex++] ?? [];

        return (async function* () {
          for (const event of events) {
            yield event;
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
 */
export function createMockOpenAIStreamingClient(
  chunkSequences: OpenAIChatCompletionChunk[][],
  errors: Error[] = [],
): MockOpenAIStreamingClient {
  const calls: Array<Record<string, unknown>> = [];
  let sequenceIndex = 0;
  let errorIndex = 0;

  return {
    _calls: calls,
    _chunkSequences: chunkSequences,
    _errors: errors,
    chat: {
      completions: {
        create(params: Record<string, unknown>): AsyncIterable<OpenAIChatCompletionChunk> {
          calls.push(params);
          const error = errors[errorIndex];
          if (error && errorIndex < errors.length) {
            errorIndex++;
            throw error;
          }
          const chunks = chunkSequences[sequenceIndex++] ?? [];

          return (async function* () {
            for (const chunk of chunks) {
              yield chunk;
            }
          })();
        },
      },
    },
  };
}

export interface MockGeminiStreamingModel extends GeminiStreamingModel {
  _calls: Array<Record<string, unknown>>;
  _chunkSequences: Array<GeminiGenerateContentResult['response'][]>;
  _errors: Error[];
}

/**
 * Creates a mock Gemini streaming model that yields queued chunk sequences.
 */
export function createMockGeminiStreamingModel(
  chunkSequences: Array<GeminiGenerateContentResult['response'][]>,
  errors: Error[] = [],
): MockGeminiStreamingModel {
  const calls: Array<Record<string, unknown>> = [];
  let sequenceIndex = 0;
  let errorIndex = 0;

  return {
    _calls: calls,
    _chunkSequences: chunkSequences,
    _errors: errors,
    async generateContentStream(
      params: Record<string, unknown>,
    ): Promise<{ stream: AsyncIterable<GeminiGenerateContentResult['response']> }> {
      calls.push(params);
      const error = errors[errorIndex];
      if (error && errorIndex < errors.length) {
        errorIndex++;
        throw error;
      }
      const chunks = chunkSequences[sequenceIndex++] ?? [];

      return {
        stream: (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })(),
      };
    },
  };
}
