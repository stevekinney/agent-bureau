import type {
  AnthropicMessageResponse,
  AnthropicStreamEvent,
  GeminiGenerateContentResult,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
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

// ── Anthropic Streaming Fixtures ────────────────────────────────────

export const anthropicStreamTextEvents: AnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: { usage: { input_tokens: 10, output_tokens: 0 } },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello ' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'from Anthropic!' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 5 },
  },
  { type: 'message_stop' },
];

export const anthropicStreamToolUseEvents: AnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: { usage: { input_tokens: 15, output_tokens: 0 } },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"location":' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '"San Francisco"}' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 20 },
  },
  { type: 'message_stop' },
];

// ── OpenAI Streaming Fixtures ───────────────────────────────────────

export const openAIStreamTextChunks: OpenAIChatCompletionChunk[] = [
  { choices: [{ delta: { content: 'Hello ' }, finish_reason: null }], usage: null },
  { choices: [{ delta: { content: 'from OpenAI!' }, finish_reason: null }], usage: null },
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
];

export const openAIStreamToolCallChunks: OpenAIChatCompletionChunk[] = [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_01',
              type: 'function',
              function: { name: 'get_weather', arguments: '' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '{"location":' } }],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"San Francisco"}' } }],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 15, completion_tokens: 20, total_tokens: 35 },
  },
];

// ── Gemini Streaming Fixtures ───────────────────────────────────────

export const geminiStreamTextChunks: GeminiGenerateContentResult['response'][] = [
  {
    candidates: [{ content: { parts: [{ text: 'Hello ' }] } }],
  },
  {
    candidates: [{ content: { parts: [{ text: 'from Gemini!' }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  },
];

export const geminiStreamFunctionCallChunks: GeminiGenerateContentResult['response'][] = [
  {
    candidates: [
      {
        content: {
          parts: [{ functionCall: { name: 'get_weather', args: { location: 'San Francisco' } } }],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 20, totalTokenCount: 35 },
  },
];

// ── Anthropic Mixed Text + Tool Streaming Fixtures ─────────────────

export const anthropicStreamMixedEvents: AnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: { usage: { input_tokens: 20, output_tokens: 0 } },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Let me check.' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_mixed_01', name: 'get_weather' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"location":"New York"}' },
  },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 25 },
  },
  { type: 'message_stop' },
];

// ── OpenAI Mixed Text + Tool Streaming Fixtures ────────────────────

export const openAIStreamMixedChunks: OpenAIChatCompletionChunk[] = [
  { choices: [{ delta: { content: 'Checking ' }, finish_reason: null }], usage: null },
  { choices: [{ delta: { content: 'weather.' }, finish_reason: null }], usage: null },
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_mixed_01',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"location":' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  },
];

// ── Gemini Mixed Text + Function Call Streaming Fixtures ───────────

export const geminiStreamMixedChunks: GeminiGenerateContentResult['response'][] = [
  {
    candidates: [
      {
        content: {
          parts: [
            { text: 'Checking weather...' },
            { functionCall: { name: 'get_weather', args: { location: 'Tokyo' } } },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
  },
];

// ── Anthropic Empty Stream Fixtures ────────────────────────────────

export const anthropicStreamEmptyEvents: AnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: { usage: { input_tokens: 5, output_tokens: 0 } },
  },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 0 },
  },
  { type: 'message_stop' },
];

// ── OpenAI Empty Stream Fixtures ───────────────────────────────────

export const openAIStreamEmptyChunks: OpenAIChatCompletionChunk[] = [
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
  },
];

// ── Gemini Empty Stream Fixtures ───────────────────────────────────

export const geminiStreamEmptyChunks: GeminiGenerateContentResult['response'][] = [
  {
    candidates: [],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 },
  },
];

// ── Anthropic Multi-Tool-Call Streaming Fixtures ───────────────────

export const anthropicStreamMultiToolEvents: AnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: { usage: { input_tokens: 25, output_tokens: 0 } },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_multi_01', name: 'get_weather' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"location":"Paris"}' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_multi_02', name: 'get_weather' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"location":"London"}' },
  },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 30 },
  },
  { type: 'message_stop' },
];

// ── OpenAI Multi-Tool-Call Streaming Fixtures ──────────────────────

export const openAIStreamMultiToolChunks: OpenAIChatCompletionChunk[] = [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_multi_01',
              type: 'function',
              function: { name: 'get_weather', arguments: '' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '{"location":"Paris"}' } }],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 1,
              id: 'call_multi_02',
              type: 'function',
              function: { name: 'get_weather', arguments: '' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 1, function: { arguments: '{"location":"London"}' } }],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 25, completion_tokens: 30, total_tokens: 55 },
  },
];

// ── Gemini Multi-Function-Call Streaming Fixtures ──────────────────

export const geminiStreamMultiFunctionCallChunks: GeminiGenerateContentResult['response'][] = [
  {
    candidates: [
      {
        content: {
          parts: [
            { functionCall: { name: 'get_weather', args: { location: 'Paris' } } },
            { functionCall: { name: 'get_weather', args: { location: 'London' } } },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 30, totalTokenCount: 55 },
  },
];
