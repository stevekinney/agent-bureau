import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { run } from '../src/run';
import { withStreaming } from '../src/streaming';
import type { GenerateResponse, StreamingGenerateFunction } from '../src/types';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function createWeatherToolbox() {
  return createTestToolbox([weatherTool]);
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('withStreaming', () => {
  it('creates, updates, and finalizes a streaming message', async () => {
    const conversation = new Conversation();
    const toolbox = createWeatherToolbox();

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Hel');
      streaming.update('Hello');
      streaming.update('Hello, world!');
      return textResponse('Hello, world!');
    };

    const generate = withStreaming(streamingGenerate);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('Hello, world!');

    const messages = result.conversation.getMessages();
    const assistantMessages = messages.filter((message) => message.role === 'assistant');
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

    // The streaming message should be finalized (not still streaming)
    const streamingMessage = result.conversation.getStreamingMessage();
    expect(streamingMessage).toBeUndefined();
  });

  it('cancels the streaming message on error', async () => {
    const conversation = new Conversation();

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Partial content...');
      throw new Error('LLM connection lost');
    };

    const generate = withStreaming(streamingGenerate);

    await expect(generate({ conversation, step: 0 })).rejects.toThrow('LLM connection lost');

    // The streaming message should not be left hanging
    const streamingMessage = conversation.getStreamingMessage();
    expect(streamingMessage).toBeUndefined();
  });

  it('works in a full run loop', async () => {
    const conversation = new Conversation();
    const toolbox = createWeatherToolbox();

    let callCount = 0;
    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      callCount++;
      if (callCount === 1) {
        streaming.update('Checking...');
        return {
          content: 'Checking weather...',
          toolCalls: [{ name: 'get_weather', arguments: { location: 'Denver' } }],
        };
      }
      streaming.update('The weather is nice.');
      return textResponse('The weather is nice.');
    };

    const generate = withStreaming(streamingGenerate);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(2);
    expect(result.content).toBe('The weather is nice.');
  });
});
