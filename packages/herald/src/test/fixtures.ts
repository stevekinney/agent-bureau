import type {
  AnthropicMessageResponse,
  GeminiGenerateContentResult,
  OpenAIChatCompletion,
} from '../types.ts';

// ── Anthropic Fixtures ───────────────────────────────────────────────

export const anthropicTextResponse: AnthropicMessageResponse = {
  content: [{ type: 'text', text: 'Hello from Anthropic!' }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: 'end_turn',
};

export const anthropicToolUseResponse: AnthropicMessageResponse = {
  content: [
    {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'get_weather',
      input: { location: 'San Francisco' },
    },
  ],
  usage: { input_tokens: 15, output_tokens: 20 },
  stop_reason: 'tool_use',
};

export const anthropicMixedResponse: AnthropicMessageResponse = {
  content: [
    { type: 'text', text: 'Let me check the weather.' },
    {
      type: 'tool_use',
      id: 'toolu_02',
      name: 'get_weather',
      input: { location: 'New York' },
    },
  ],
  usage: { input_tokens: 20, output_tokens: 25 },
  stop_reason: 'tool_use',
};

export const anthropicNoUsageResponse: AnthropicMessageResponse = {
  content: [{ type: 'text', text: 'No usage info.' }],
  stop_reason: 'end_turn',
};

// ── OpenAI Fixtures ──────────────────────────────────────────────────

export const openAITextResponse: OpenAIChatCompletion = {
  choices: [
    {
      message: { content: 'Hello from OpenAI!' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

export const openAIToolCallResponse: OpenAIChatCompletion = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: 'call_01',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location":"San Francisco"}',
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 15, completion_tokens: 20, total_tokens: 35 },
};

export const openAIMixedResponse: OpenAIChatCompletion = {
  choices: [
    {
      message: {
        content: 'Let me check the weather.',
        tool_calls: [
          {
            id: 'call_02',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location":"New York"}',
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 25, total_tokens: 45 },
};

export const openAINoUsageResponse: OpenAIChatCompletion = {
  choices: [
    {
      message: { content: 'No usage info.' },
      finish_reason: 'stop',
    },
  ],
};

// ── Gemini Fixtures ──────────────────────────────────────────────────

export const geminiTextResponse: GeminiGenerateContentResult = {
  response: {
    candidates: [
      {
        content: {
          parts: [{ text: 'Hello from Gemini!' }],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
  },
};

export const geminiFunctionCallResponse: GeminiGenerateContentResult = {
  response: {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: { location: 'San Francisco' },
              },
            },
          ],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 15,
      candidatesTokenCount: 20,
      totalTokenCount: 35,
    },
  },
};

export const geminiMixedResponse: GeminiGenerateContentResult = {
  response: {
    candidates: [
      {
        content: {
          parts: [
            { text: 'Let me check the weather.' },
            {
              functionCall: {
                name: 'get_weather',
                args: { location: 'New York' },
              },
            },
          ],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 20,
      candidatesTokenCount: 25,
      totalTokenCount: 45,
    },
  },
};

export const geminiNoUsageResponse: GeminiGenerateContentResult = {
  response: {
    candidates: [
      {
        content: {
          parts: [{ text: 'No usage info.' }],
        },
      },
    ],
  },
};
