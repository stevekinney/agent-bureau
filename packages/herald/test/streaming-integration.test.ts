import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import type { RunResult } from 'operative';
import { run, stopWhen, withStreaming } from 'operative';
import { z } from 'zod';

import { createAnthropicGenerateStream } from '../src/anthropic.ts';
import { HeraldError } from '../src/errors.ts';
import { anthropicStreamTextEvents, anthropicStreamToolUseEvents } from '../src/test/fixtures.ts';
import { createMockAnthropicStreamingClient } from '../src/test/mock-clients.ts';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather for a location',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function createWeatherToolbox() {
  return createToolbox([weatherTool]);
}

describe('streaming integration with operative', () => {
  describe('withStreaming end-to-end with run()', () => {
    it('completes a two-step tool-use loop using a streaming generate function', async () => {
      const client = createMockAnthropicStreamingClient([
        anthropicStreamToolUseEvents,
        anthropicStreamTextEvents,
      ]);
      const streamingGenerate = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const generate = withStreaming(streamingGenerate);

      const conversation = new Conversation();
      conversation.appendUserMessage('What is the weather in San Francisco?');

      const result: RunResult = await run({
        generate,
        toolbox: createWeatherToolbox(),
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });

      expect(result.steps).toHaveLength(2);
      expect(result.content).toBe('Hello from Anthropic!');
      expect(client._calls).toHaveLength(2);
    });

    it('returns messageAppended: true from withStreaming so the loop skips duplicate append', async () => {
      const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
      const streamingGenerate = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const generate = withStreaming(streamingGenerate);

      const conversation = new Conversation();
      conversation.appendUserMessage('Hello');

      const result: RunResult = await run({
        generate,
        toolbox: createToolbox(),
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });

      expect(result.steps).toHaveLength(1);
      expect(result.content).toBe('Hello from Anthropic!');
    });
  });

  describe('error cancellation via cancelStreamingMessage', () => {
    it('cancels the streaming message when the stream errors', async () => {
      const sdkError = new Error('Stream failed');
      const client = createMockAnthropicStreamingClient([], [sdkError]);
      const streamingGenerate = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const generate = withStreaming(streamingGenerate);

      const conversation = new Conversation();
      conversation.appendUserMessage('Hello');

      const result: RunResult = await run({
        generate,
        toolbox: createToolbox(),
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });

      expect(result.finishReason).toBe('error');
      expect(result.error).toBeInstanceOf(HeraldError);

      const streamingMessage = conversation.getStreamingMessage();
      expect(streamingMessage).toBeUndefined();
    });
  });

  describe('usage forwarding through withStreaming', () => {
    it('preserves usage from the streaming generate response', async () => {
      const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
      const streamingGenerate = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const generate = withStreaming(streamingGenerate);

      const conversation = new Conversation();
      conversation.appendUserMessage('Hello');

      const result: RunResult = await run({
        generate,
        toolbox: createToolbox(),
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });

      expect(result.usage.prompt).toBe(10);
      expect(result.usage.completion).toBe(5);
      expect(result.usage.total).toBe(15);
    });

    it('sums usage across multiple streaming steps', async () => {
      const client = createMockAnthropicStreamingClient([
        anthropicStreamToolUseEvents,
        anthropicStreamTextEvents,
      ]);
      const streamingGenerate = createAnthropicGenerateStream({
        model: 'claude-sonnet-4-20250514',
        client,
      });
      const generate = withStreaming(streamingGenerate);

      const conversation = new Conversation();
      conversation.appendUserMessage('What is the weather in San Francisco?');

      const result: RunResult = await run({
        generate,
        toolbox: createWeatherToolbox(),
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });

      // anthropicStreamToolUseEvents: input_tokens: 15, output_tokens: 20
      // anthropicStreamTextEvents: input_tokens: 10, output_tokens: 5
      expect(result.usage.prompt).toBe(25);
      expect(result.usage.completion).toBe(25);
      expect(result.usage.total).toBe(50);
    });
  });
});
