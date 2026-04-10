import { describe, expect, it } from 'bun:test';
import type { StreamState } from 'operative';

import type { OpenAIChatCompletionChunk } from '../types';
import { normalizeOpenAIStream } from './normalize-openai';
import type { NormalizerState } from './stream-helpers';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

describe('normalizeOpenAIStream', () => {
  it('normalizes delta.content into stream:text-delta', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ', world!' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];

    const result = await collect(normalizeOpenAIStream(toAsync(chunks)));
    const textDeltas = result.filter((e) => e.type === 'stream:text-delta');

    expect(textDeltas).toHaveLength(2);
    if (textDeltas[0]?.type === 'stream:text-delta') {
      expect(textDeltas[0].content).toBe('Hello');
      expect(textDeltas[0].accumulated).toBe('Hello');
    }
    if (textDeltas[1]?.type === 'stream:text-delta') {
      expect(textDeltas[1].content).toBe(', world!');
      expect(textDeltas[1].accumulated).toBe('Hello, world!');
    }
  });

  it('normalizes new tool_calls index into stream:tool-call-start', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_123',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];

    const result = await collect(normalizeOpenAIStream(toAsync(chunks)));
    const toolStart = result.find((e) => e.type === 'stream:tool-call-start');

    expect(toolStart).toBeDefined();
    if (toolStart?.type === 'stream:tool-call-start') {
      expect(toolStart.toolName).toBe('get_weather');
    }
  });

  it('normalizes tool_calls arguments into stream:tool-call-delta', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_123',
                  type: 'function',
                  function: { name: 'search', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"query":' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"test"}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];

    const result = await collect(normalizeOpenAIStream(toAsync(chunks)));
    const toolDeltas = result.filter((e) => e.type === 'stream:tool-call-delta');

    expect(toolDeltas.length).toBeGreaterThanOrEqual(2);
    if (toolDeltas[0]?.type === 'stream:tool-call-delta') {
      expect(toolDeltas[0].toolName).toBe('search');
    }
  });

  it('emits stream:block-delta for tracked tool calls even when the block lookup misses', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_123',
                  type: 'function',
                  function: { name: 'search', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"query":"test"}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];

    const result = await collect(
      normalizeOpenAIStream(toAsync(chunks), {
        buildState: (state: NormalizerState): StreamState => ({
          blocks: [...state.blocks],
          activeBlock: undefined,
          textContent: state.blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.content)
            .join(''),
          toolCalls: state.blocks.filter((block) => block.type === 'tool-call'),
          complete: false,
          usage: undefined,
        }),
        findBlock: (blocks: NormalizerState['blocks'], id: string) =>
          id === 'call_123' ? undefined : blocks.find((block) => block.id === id),
      }),
    );
    const blockDeltas = result.filter((event) => event.type === 'stream:block-delta');

    expect(blockDeltas).toHaveLength(1);
    if (blockDeltas[0]?.type === 'stream:block-delta') {
      expect(blockDeltas[0].delta).toBe('{"query":"test"}');
      expect(blockDeltas[0].block).toEqual({
        id: 'call_123',
        type: 'tool-call',
        index: 0,
        content: '{"query":"test"}',
        complete: false,
        toolName: 'search',
        partialArguments: '{"query":"test"}',
      });
    }
  });

  it('emits stream:complete on finish_reason stop', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      { choices: [{ delta: { content: 'Done' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];

    const result = await collect(normalizeOpenAIStream(toAsync(chunks)));
    const complete = result.find((e) => e.type === 'stream:complete');

    expect(complete).toBeDefined();
  });

  it('emits stream:usage when usage chunk is present', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      { choices: [{ delta: { content: 'Hi' }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ];

    const result = await collect(normalizeOpenAIStream(toAsync(chunks)));
    const usageEvent = result.find((e) => e.type === 'stream:usage');

    expect(usageEvent).toBeDefined();
    if (usageEvent?.type === 'stream:usage') {
      expect(usageEvent.usage.prompt).toBe(10);
      expect(usageEvent.usage.completion).toBe(5);
      expect(usageEvent.usage.total).toBe(15);
    }
  });

  it('handles empty stream with only stop chunk', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];

    const result = await collect(normalizeOpenAIStream(toAsync(chunks)));
    const complete = result.find((e) => e.type === 'stream:complete');

    expect(complete).toBeDefined();
    if (complete?.type === 'stream:complete') {
      expect(complete.state.textContent).toBe('');
    }
  });

  it('emits stream:tool-call-complete on finish', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'foo', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];

    const result = await collect(normalizeOpenAIStream(toAsync(chunks)));
    const toolComplete = result.find((e) => e.type === 'stream:tool-call-complete');

    expect(toolComplete).toBeDefined();
    if (toolComplete?.type === 'stream:tool-call-complete') {
      expect(toolComplete.toolName).toBe('foo');
    }
  });

  it('handles multiple concurrent tool calls', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'tool_a', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'tool_b', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 1, function: { arguments: '{"y":2}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];

    const result = await collect(normalizeOpenAIStream(toAsync(chunks)));
    const toolStarts = result.filter((e) => e.type === 'stream:tool-call-start');
    const toolCompletes = result.filter((e) => e.type === 'stream:tool-call-complete');

    expect(toolStarts).toHaveLength(2);
    expect(toolCompletes).toHaveLength(2);
  });

  it('processes usage from a usage-only chunk with empty choices', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      { choices: [{ delta: { content: 'Hi' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      },
    ];

    const result = await collect(normalizeOpenAIStream(toAsync(chunks)));
    const usageEvents = result.filter((e) => e.type === 'stream:usage');

    expect(usageEvents).toHaveLength(1);
    if (usageEvents[0]?.type === 'stream:usage') {
      expect(usageEvents[0].usage.prompt).toBe(20);
      expect(usageEvents[0].usage.completion).toBe(10);
      expect(usageEvents[0].usage.total).toBe(30);
    }
  });

  it('ignores chunks with null content', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      { choices: [{ delta: { content: null }, finish_reason: null }] },
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];

    const result = await collect(normalizeOpenAIStream(toAsync(chunks)));
    const textDeltas = result.filter((e) => e.type === 'stream:text-delta');

    expect(textDeltas).toHaveLength(1);
  });
});
