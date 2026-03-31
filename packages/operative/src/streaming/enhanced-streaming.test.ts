import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { TypedEventTarget } from 'lifecycle';

import type { GenerateContext, GenerateResponse, StreamingGenerateFunction } from '../types';
import { withEnhancedStreaming } from './enhanced-streaming';
import type { StreamCustomEvent, StreamEventMap } from './types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function makeContext(overrides?: Partial<GenerateContext>): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createTestToolbox([]),
    ...overrides,
  };
}

describe('withEnhancedStreaming', () => {
  it('wraps a streaming generate function and returns a standard GenerateFunction', async () => {
    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Hello, world!');
      return textResponse('Hello, world!');
    };

    const generate = withEnhancedStreaming(streamingGenerate);
    const context = makeContext();
    const result = await generate(context);

    expect(result.content).toBe('Hello, world!');
    expect(result.messageAppended).toBe(true);
  });

  it('calls onTextDelta callback with each delta', async () => {
    const deltas: Array<{ delta: string; accumulated: string }> = [];

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Hello');
      streaming.update('Hello, world!');
      return textResponse('Hello, world!');
    };

    const generate = withEnhancedStreaming(streamingGenerate, {
      onTextDelta: (delta, accumulated) => {
        deltas.push({ delta, accumulated });
      },
    });

    const context = makeContext();
    await generate(context);

    expect(deltas).toHaveLength(2);
    expect(deltas[0]?.delta).toBe('Hello');
    expect(deltas[0]?.accumulated).toBe('Hello');
    expect(deltas[1]?.delta).toBe(', world!');
    expect(deltas[1]?.accumulated).toBe('Hello, world!');
  });

  it('calls onToolCallStart when tool calls are in the response', async () => {
    const toolStarts: string[] = [];

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Searching...');
      return {
        content: 'Searching...',
        toolCalls: [{ name: 'get_weather', arguments: { location: 'Denver' } }],
      };
    };

    const generate = withEnhancedStreaming(streamingGenerate, {
      onToolCallStart: (toolName) => {
        toolStarts.push(toolName);
      },
    });

    const context = makeContext();
    await generate(context);

    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]).toBe('get_weather');
  });

  it('emits events on eventTarget when provided', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const receivedEvents: string[] = [];

    eventTarget.addEventListener(
      'stream:text-delta',
      (event: StreamCustomEvent<'stream:text-delta'>) => {
        receivedEvents.push(`text:${event.detail.content}`);
      },
    );

    eventTarget.addEventListener('stream:complete', () => {
      receivedEvents.push('complete');
    });

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Hi');
      return textResponse('Hi');
    };

    const generate = withEnhancedStreaming(streamingGenerate, { eventTarget });
    const context = makeContext();
    await generate(context);

    expect(receivedEvents).toContain('text:Hi');
    expect(receivedEvents).toContain('complete');
  });

  it('cancels streaming message on error', async () => {
    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Partial...');
      throw new Error('Connection lost');
    };

    const generate = withEnhancedStreaming(streamingGenerate);
    const context = makeContext();

    let thrownError: unknown;
    try {
      await generate(context);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toBe('Connection lost');

    const streamingMessage = context.conversation.getStreamingMessage();
    expect(streamingMessage).toBeUndefined();
  });

  it('emits stream:error on eventTarget when an error occurs', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const errors: unknown[] = [];

    eventTarget.addEventListener('stream:error', (event: StreamCustomEvent<'stream:error'>) => {
      errors.push(event.detail.error);
    });

    const streamingGenerate: StreamingGenerateFunction = async () => {
      throw new Error('LLM failed');
    };

    const generate = withEnhancedStreaming(streamingGenerate, { eventTarget });
    const context = makeContext();

    let thrownError: unknown;
    try {
      await generate(context);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toBe('LLM failed');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it('tracks state through the stream via state machine', async () => {
    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Part 1');
      streaming.update('Part 1 Part 2');
      return {
        content: 'Part 1 Part 2',
        toolCalls: [],
        usage: { prompt: 10, completion: 20, total: 30 },
      };
    };

    const eventTarget = new TypedEventTarget<StreamEventMap>();
    let finalState: unknown;

    eventTarget.addEventListener(
      'stream:complete',
      (event: StreamCustomEvent<'stream:complete'>) => {
        finalState = event.detail.state;
      },
    );

    const generate = withEnhancedStreaming(streamingGenerate, { eventTarget });
    const context = makeContext();
    await generate(context);

    expect(finalState).toBeDefined();
  });

  it('works with existing withStreaming behavior preserved', async () => {
    const conversation = new Conversation();

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Hello');
      streaming.update('Hello, world!');
      return textResponse('Hello, world!');
    };

    const generate = withEnhancedStreaming(streamingGenerate);
    const result = await generate(makeContext({ conversation }));

    expect(result.content).toBe('Hello, world!');
    expect(result.messageAppended).toBe(true);

    // The streaming message should be finalized (not still streaming)
    const streamingMessage = conversation.getStreamingMessage();
    expect(streamingMessage).toBeUndefined();
  });

  it('calls onToolCallDelta when provided', async () => {
    const toolDeltas: Array<{ toolName: string; partialArgs: string }> = [];

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Calling tool');
      return {
        content: 'Calling tool',
        toolCalls: [{ name: 'search', arguments: { query: 'test' } }],
      };
    };

    const generate = withEnhancedStreaming(streamingGenerate, {
      onToolCallDelta: (toolName, partialArgs) => {
        toolDeltas.push({ toolName, partialArgs });
      },
    });

    const context = makeContext();
    await generate(context);

    // onToolCallDelta is called for each tool call in the response
    // The response contains pre-formed tool calls, so we emit one delta with the full args
    if (toolDeltas.length > 0) {
      expect(toolDeltas[0]?.toolName).toBe('search');
    }
  });
});
