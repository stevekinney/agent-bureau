import { describe, expect, it } from 'bun:test';

import type { AnthropicStreamEvent } from '../types';
import { normalizeAnthropicStream } from './normalize-anthropic';

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

describe('normalizeAnthropicStream', () => {
  it('emits stream:usage on message_start with usage', async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: 'message_start',
        message: { usage: { input_tokens: 100, output_tokens: 0 } },
      },
      { type: 'message_stop' },
    ];

    const result = await collect(normalizeAnthropicStream(toAsync(events)));
    const usageEvent = result.find((e) => e.type === 'stream:usage');

    expect(usageEvent).toBeDefined();
    if (usageEvent?.type === 'stream:usage') {
      expect(usageEvent.usage.prompt).toBe(100);
    }
  });

  it('normalizes text content_block_start into stream:block-start', async () => {
    const events: AnthropicStreamEvent[] = [
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];

    const result = await collect(normalizeAnthropicStream(toAsync(events)));
    const blockStart = result.find((e) => e.type === 'stream:block-start');

    expect(blockStart).toBeDefined();
    if (blockStart?.type === 'stream:block-start') {
      expect(blockStart.block.type).toBe('text');
    }
  });

  it('normalizes text content_block_delta into stream:text-delta and stream:block-delta', async () => {
    const events: AnthropicStreamEvent[] = [
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ', world!' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];

    const result = await collect(normalizeAnthropicStream(toAsync(events)));
    const textDeltas = result.filter((e) => e.type === 'stream:text-delta');
    const blockDeltas = result.filter((e) => e.type === 'stream:block-delta');

    expect(textDeltas).toHaveLength(2);
    if (textDeltas[0]?.type === 'stream:text-delta') {
      expect(textDeltas[0].content).toBe('Hello');
      expect(textDeltas[0].accumulated).toBe('Hello');
    }
    if (textDeltas[1]?.type === 'stream:text-delta') {
      expect(textDeltas[1].content).toBe(', world!');
      expect(textDeltas[1].accumulated).toBe('Hello, world!');
    }

    expect(blockDeltas).toHaveLength(2);
  });

  it('normalizes tool_use content_block_start into stream:tool-call-start', async () => {
    const events: AnthropicStreamEvent[] = [
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_123', name: 'get_weather' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];

    const result = await collect(normalizeAnthropicStream(toAsync(events)));
    const toolStart = result.find((e) => e.type === 'stream:tool-call-start');

    expect(toolStart).toBeDefined();
    if (toolStart?.type === 'stream:tool-call-start') {
      expect(toolStart.toolName).toBe('get_weather');
      expect(toolStart.blockId).toBeDefined();
    }
  });

  it('normalizes input_json_delta into stream:tool-call-delta', async () => {
    const events: AnthropicStreamEvent[] = [
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_123', name: 'search' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"test"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];

    const result = await collect(normalizeAnthropicStream(toAsync(events)));
    const toolDeltas = result.filter((e) => e.type === 'stream:tool-call-delta');

    expect(toolDeltas).toHaveLength(2);
    if (toolDeltas[0]?.type === 'stream:tool-call-delta') {
      expect(toolDeltas[0].toolName).toBe('search');
      expect(toolDeltas[0].partialArguments).toBe('{"query":');
    }
    if (toolDeltas[1]?.type === 'stream:tool-call-delta') {
      expect(toolDeltas[1].partialArguments).toBe('{"query":"test"}');
    }
  });

  it('emits stream:tool-call-complete on tool block stop', async () => {
    const events: AnthropicStreamEvent[] = [
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_123', name: 'search' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"test"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];

    const result = await collect(normalizeAnthropicStream(toAsync(events)));
    const toolComplete = result.find((e) => e.type === 'stream:tool-call-complete');

    expect(toolComplete).toBeDefined();
    if (toolComplete?.type === 'stream:tool-call-complete') {
      expect(toolComplete.toolName).toBe('search');
    }
  });

  it('emits stream:block-complete on content_block_stop', async () => {
    const events: AnthropicStreamEvent[] = [
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];

    const result = await collect(normalizeAnthropicStream(toAsync(events)));
    const blockComplete = result.find((e) => e.type === 'stream:block-complete');

    expect(blockComplete).toBeDefined();
  });

  it('emits stream:complete on message_stop', async () => {
    const events: AnthropicStreamEvent[] = [{ type: 'message_start' }, { type: 'message_stop' }];

    const result = await collect(normalizeAnthropicStream(toAsync(events)));
    const complete = result.find((e) => e.type === 'stream:complete');

    expect(complete).toBeDefined();
  });

  it('emits stream:usage from message_delta with usage', async () => {
    const events: AnthropicStreamEvent[] = [
      { type: 'message_start' },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 42 },
      },
      { type: 'message_stop' },
    ];

    const result = await collect(normalizeAnthropicStream(toAsync(events)));
    const usageEvents = result.filter((e) => e.type === 'stream:usage');

    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('handles empty stream with just message_start and message_stop', async () => {
    const events: AnthropicStreamEvent[] = [{ type: 'message_start' }, { type: 'message_stop' }];

    const result = await collect(normalizeAnthropicStream(toAsync(events)));
    const complete = result.find((e) => e.type === 'stream:complete');

    expect(complete).toBeDefined();
    if (complete?.type === 'stream:complete') {
      expect(complete.state.blocks).toEqual([]);
      expect(complete.state.textContent).toBe('');
    }
  });

  it('handles thinking blocks with the thinking delta field', async () => {
    const events: AnthropicStreamEvent[] = [
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me think...' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];

    const result = await collect(normalizeAnthropicStream(toAsync(events)));
    const blockStart = result.find((e) => e.type === 'stream:block-start');

    expect(blockStart).toBeDefined();
    if (blockStart?.type === 'stream:block-start') {
      expect(blockStart.block.type).toBe('thinking');
    }

    const blockDelta = result.find((e) => e.type === 'stream:block-delta');
    expect(blockDelta).toBeDefined();
    if (blockDelta?.type === 'stream:block-delta') {
      expect(blockDelta.delta).toBe('Let me think...');
    }
  });
});
