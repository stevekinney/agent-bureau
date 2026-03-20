import type {
  AnthropicClient,
  AnthropicMessageResponse,
  GeminiGenerateContentResult,
  GeminiGenerativeModel,
  OpenAIChatCompletion,
  OpenAIClient,
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
