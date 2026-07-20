import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import {
  createAnthropicProvider,
  createAnthropicProviderStream,
} from '../src/providers/anthropic.ts';
import {
  extractStatusCode,
  ProviderError,
  shouldRetryProviderError,
  ToolCallParseError,
} from '../src/providers/errors.ts';
import { createGeminiProvider, createGeminiProviderStream } from '../src/providers/gemini.ts';
import { createOpenAIProvider, createOpenAIProviderStream } from '../src/providers/openai.ts';
import { resolveCommonParameters } from '../src/providers/shared/resolve-common-parameters.ts';
import {
  toGeminiResponseFormat,
  toOpenAIResponseFormat,
} from '../src/providers/structured-output/response-format-adapters.ts';
import {
  toAnthropicToolChoice,
  toGeminiToolChoice,
  toOpenAIToolChoice,
} from '../src/providers/structured-output/tool-choice-adapters.ts';
import {
  anthropicMixedResponse,
  anthropicNoUsageResponse,
  anthropicStreamEmptyEvents,
  anthropicStreamMixedEvents,
  anthropicStreamMultiToolEvents,
  anthropicStreamTextEvents,
  anthropicStreamToolUseEvents,
  anthropicTextResponse,
  anthropicToolUseResponse,
  geminiFunctionCallResponse,
  geminiMixedResponse,
  geminiNoUsageResponse,
  geminiStreamEmptyChunks,
  geminiStreamFunctionCallChunks,
  geminiStreamMixedChunks,
  geminiStreamMultiFunctionCallChunks,
  geminiStreamTextChunks,
  geminiTextResponse,
  openAIMixedResponse,
  openAINoUsageResponse,
  openAIStreamEmptyChunks,
  openAIStreamMixedChunks,
  openAIStreamMultiToolChunks,
  openAIStreamTextChunks,
  openAIStreamToolCallChunks,
  openAITextResponse,
  openAIToolCallResponse,
} from '../src/providers/test/fixtures.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
  createMockGeminiModel,
  createMockGeminiStreamingModel,
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../src/providers/test/mock-clients.ts';
import type { AnthropicStreamEvent } from '../src/providers/types.ts';
import type { GenerateContext, StreamingHandle } from '../src/types.ts';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ location }),
});

function makeContext(
  options: { maximumTokens?: number; signal?: AbortSignal } = {},
): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([weatherTool]),
    maximumTokens: options.maximumTokens,
    signal: options.signal,
  };
}

function makeStreamingHandle(updates: string[] = []): StreamingHandle {
  return {
    update: (text) => updates.push(text),
  };
}

describe('provider helper coverage', () => {
  it('extracts common parameters and omits empty stop sequences', () => {
    expect(resolveCommonParameters({ stopSequences: [] })).toEqual({});
    expect(
      resolveCommonParameters({
        maximumTokens: 100,
        temperature: 0.2,
        topP: 0.9,
        stopSequences: ['END'],
      }),
    ).toEqual({
      maximumTokens: 100,
      temperature: 0.2,
      topP: 0.9,
      stopSequences: ['END'],
    });
  });

  it('adapts response formats for OpenAI and Gemini', () => {
    expect(toOpenAIResponseFormat({ type: 'text' })).toBeUndefined();
    expect(toOpenAIResponseFormat({ type: 'json' })).toEqual({ type: 'json_object' });
    expect(toOpenAIResponseFormat({ type: 'json_schema', schema: { type: 'object' } })).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: { type: 'object' }, strict: true },
    });
    expect(
      toOpenAIResponseFormat({
        type: 'json_schema',
        name: 'answer',
        schema: { type: 'object' },
      }),
    ).toEqual({
      type: 'json_schema',
      json_schema: { name: 'answer', schema: { type: 'object' }, strict: true },
    });

    expect(toGeminiResponseFormat({ type: 'text' })).toBeUndefined();
    expect(toGeminiResponseFormat({ type: 'json' })).toEqual({
      responseMimeType: 'application/json',
    });
    expect(toGeminiResponseFormat({ type: 'json_schema', schema: { type: 'object' } })).toEqual({
      responseMimeType: 'application/json',
      responseSchema: { type: 'object' },
    });
  });

  it('adapts every supported tool choice shape', () => {
    expect(toAnthropicToolChoice('auto')).toEqual({ type: 'auto' });
    expect(toAnthropicToolChoice('required')).toEqual({ type: 'any' });
    expect(toAnthropicToolChoice('none')).toBeUndefined();
    expect(toAnthropicToolChoice({ tool: 'get_weather' })).toEqual({
      type: 'tool',
      name: 'get_weather',
    });

    expect(toOpenAIToolChoice('auto')).toBe('auto');
    expect(toOpenAIToolChoice('required')).toBe('required');
    expect(toOpenAIToolChoice('none')).toBe('none');
    expect(toOpenAIToolChoice({ tool: 'get_weather' })).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });

    expect(toGeminiToolChoice('auto')).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(toGeminiToolChoice('required')).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    expect(toGeminiToolChoice('none')).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(toGeminiToolChoice({ tool: 'get_weather' })).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
  });

  it('extracts provider status codes and retryability from SDK error shapes', () => {
    expect(extractStatusCode({ status: 429 })).toBe(429);
    expect(extractStatusCode({ statusCode: 500 })).toBe(500);
    expect(extractStatusCode({ error: { status: 400 } })).toBe(400);
    expect(extractStatusCode('plain failure')).toBeUndefined();

    const retryable = new ProviderError({ provider: 'openai', cause: { status: 503 } });
    const nonRetryable = new ProviderError({ provider: 'openai', cause: 'bad request' });

    expect(retryable.message).toBe('[provider:openai] Unknown error');
    expect(retryable.retryable).toBe(true);
    expect(nonRetryable.message).toBe('[provider:openai] bad request');
    expect(shouldRetryProviderError(retryable)).toBe(true);
    expect(shouldRetryProviderError(nonRetryable)).toBe(false);
    expect(shouldRetryProviderError(new Error('other'))).toBe(false);
  });

  it('mock clients fail loudly when queued responses are exhausted', async () => {
    await expect(createMockAnthropicClient([]).messages.create({})).rejects.toThrow(
      'MockAnthropicClient: no response at index 0',
    );
    await expect(createMockOpenAIClient([]).chat.completions.create({})).rejects.toThrow(
      'MockOpenAIClient: no response at index 0',
    );
    await expect(createMockGeminiModel([]).generateContent({})).rejects.toThrow(
      'MockGeminiModel: no response at index 0',
    );
  });

  it('streaming mock clients can fail after yielding part of a stream', async () => {
    const anthropicStream = createMockAnthropicStreamingClient(
      [anthropicStreamTextEvents],
      [new Error('anthropic stream failed')],
      { errorAfterEvents: 1 },
    ).messages.create({});
    const openAIStream = createMockOpenAIStreamingClient(
      [openAIStreamTextChunks],
      [new Error('openai stream failed')],
      { errorAfterEvents: 1 },
    ).chat.completions.create({});
    const geminiStream = await createMockGeminiStreamingModel(
      [geminiStreamTextChunks],
      [new Error('gemini stream failed')],
      { errorAfterEvents: 1 },
    ).generateContentStream({});

    await expect(
      (async () => {
        for await (const _event of anthropicStream) {
          // consume until the configured error fires
        }
      })(),
    ).rejects.toThrow('anthropic stream failed');
    await expect(
      (async () => {
        for await (const _chunk of openAIStream) {
          // consume until the configured error fires
        }
      })(),
    ).rejects.toThrow('openai stream failed');
    await expect(
      (async () => {
        for await (const _chunk of geminiStream.stream) {
          // consume until the configured error fires
        }
      })(),
    ).rejects.toThrow('gemini stream failed');
  });

  it('streaming mock clients throw after a short stream when the error threshold is beyond the stream length', async () => {
    const anthropicStream = createMockAnthropicStreamingClient(
      [[]],
      [new Error('anthropic late failure')],
      { errorAfterEvents: 1 },
    ).messages.create({});
    const openAIStream = createMockOpenAIStreamingClient([[]], [new Error('openai late failure')], {
      errorAfterEvents: 1,
    }).chat.completions.create({});
    const geminiStream = await createMockGeminiStreamingModel(
      [[]],
      [new Error('gemini late failure')],
      { errorAfterEvents: 1 },
    ).generateContentStream({});

    await expect(
      (async () => {
        for await (const _event of anthropicStream) {
          // consume until the configured error fires
        }
      })(),
    ).rejects.toThrow('anthropic late failure');
    await expect(
      (async () => {
        for await (const _chunk of openAIStream) {
          // consume until the configured error fires
        }
      })(),
    ).rejects.toThrow('openai late failure');
    await expect(
      (async () => {
        for await (const _chunk of geminiStream.stream) {
          // consume until the configured error fires
        }
      })(),
    ).rejects.toThrow('gemini late failure');
  });
});

describe('OpenAI provider coverage', () => {
  it('maps text, tool calls, usage fallbacks, request options, and errors', async () => {
    const client = createMockOpenAIClient([
      openAITextResponse,
      openAIToolCallResponse,
      openAIMixedResponse,
      openAINoUsageResponse,
      {
        choices: [{ message: { content: undefined }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      },
    ]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o',
      client,
      maximumTokens: 200,
      temperature: 0.1,
      topP: 0.8,
      stopSequences: ['END'],
      toolChoice: { tool: 'get_weather' },
      responseFormat: { type: 'json' },
    });

    expect(await generate(makeContext())).toMatchObject({
      content: 'Hello from OpenAI!',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    const generatedOpenAIToolCallResponse = await generate(makeContext());
    expect(generatedOpenAIToolCallResponse.toolCalls).toEqual([
      { id: 'call_01', name: 'get_weather', arguments: { location: 'San Francisco' } },
    ]);
    expect(await generate(makeContext())).toMatchObject({
      content: 'Let me check the weather.',
      usage: { prompt: 20, completion: 25, total: 45 },
    });
    const openAIResponseWithoutUsage = await generate(makeContext());
    expect(openAIResponseWithoutUsage.usage).toBeUndefined();
    expect(await generate(makeContext())).toMatchObject({
      content: '',
      usage: { prompt: 3, completion: 4, total: 7 },
    });

    expect(client._calls[0]).toMatchObject({
      model: 'gpt-4o',
      max_tokens: 200,
      temperature: 0.1,
      top_p: 0.8,
      stop: ['END'],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      response_format: { type: 'json_object' },
    });

    const failingClient = createMockOpenAIClient([], [new Error('OpenAI failed')]);
    const failingGenerate = createOpenAIProvider({ model: 'gpt-4o', client: failingClient });
    await expect(failingGenerate(makeContext())).rejects.toMatchObject({ provider: 'openai' });
  });

  it('streams text, tool calls, empty responses, usage fallbacks, aborts, and errors', async () => {
    const client = createMockOpenAIStreamingClient([
      openAIStreamTextChunks,
      openAIStreamToolCallChunks,
      openAIStreamMixedChunks,
      openAIStreamEmptyChunks,
      [
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2 } },
      ],
      openAIStreamMultiToolChunks,
    ]);
    const generate = createOpenAIProviderStream({
      model: 'gpt-4o',
      client,
      toolChoice: 'required',
      responseFormat: { type: 'text' },
    });

    const textUpdates: string[] = [];
    expect(
      await generate({ ...makeContext(), streaming: makeStreamingHandle(textUpdates) }),
    ).toMatchObject({
      content: 'Hello from OpenAI!',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    expect(textUpdates).toEqual(['Hello ', 'Hello from OpenAI!']);

    const openAIStreamingToolCallResponse = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(openAIStreamingToolCallResponse.toolCalls).toEqual([
      { id: 'call_01', name: 'get_weather', arguments: { location: 'San Francisco' } },
    ]);

    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      content: 'Checking weather.',
      toolCalls: [{ id: 'call_mixed_01', name: 'get_weather', arguments: { location: 'NYC' } }],
    });
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      content: '',
      usage: { prompt: 5, completion: 0, total: 5 },
    });
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      usage: { prompt: 2, completion: 0, total: 2 },
    });
    const openAIStreamingMultipleToolCallResponse = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(openAIStreamingMultipleToolCallResponse.toolCalls).toEqual([
      { id: 'call_multi_01', name: 'get_weather', arguments: { location: 'Paris' } },
      { id: 'call_multi_02', name: 'get_weather', arguments: { location: 'London' } },
    ]);

    const abortController = new AbortController();
    abortController.abort();
    const abortedClient = createMockOpenAIStreamingClient([openAIStreamTextChunks]);
    const abortedGenerate = createOpenAIProviderStream({ model: 'gpt-4o', client: abortedClient });
    expect(
      await abortedGenerate({
        ...makeContext({ signal: abortController.signal }),
        streaming: makeStreamingHandle(),
      }),
    ).toEqual({
      content: '',
      toolCalls: [],
      usage: undefined,
      metadata: { effectiveModel: 'gpt-4o', effectiveEffort: 'none' },
    });

    const failingClient = createMockOpenAIStreamingClient([], [new Error('OpenAI stream failed')]);
    const failingGenerate = createOpenAIProviderStream({ model: 'gpt-4o', client: failingClient });
    await expect(
      failingGenerate({ ...makeContext(), streaming: makeStreamingHandle() }),
    ).rejects.toMatchObject({ provider: 'openai' });
  });

  it('surfaces malformed streamed tool-call JSON as a distinct ToolCallParseError, not a generic ProviderError', async () => {
    const malformedToolCallChunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_bad_01',
                  type: 'function',
                  function: { name: 'roll_dice', arguments: '{"sides": 2' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
        usage: null,
      },
    ];
    const client = createMockOpenAIStreamingClient([malformedToolCallChunks]);
    const generate = createOpenAIProviderStream({ model: 'gpt-4o', client });

    let caught: unknown;
    try {
      await generate({ ...makeContext(), streaming: makeStreamingHandle() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ToolCallParseError);
    expect(caught).toBeInstanceOf(ProviderError);
    const parseError = caught as ToolCallParseError;
    expect(parseError.provider).toBe('openai');
    expect(parseError.toolName).toBe('roll_dice');
    expect(parseError.toolCallId).toBe('call_bad_01');
    expect(parseError.rawArguments).toBe('{"sides": 2');
    expect(parseError.retryable).toBe(false);
  });
});

describe('Anthropic provider coverage', () => {
  it('maps text, tool calls, usage fallbacks, request options, and errors', async () => {
    const client = createMockAnthropicClient([
      anthropicTextResponse,
      anthropicToolUseResponse,
      anthropicMixedResponse,
      anthropicNoUsageResponse,
      {
        content: [{ type: 'text' }],
        usage: { input_tokens: 3 },
      },
    ]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      maximumTokens: 200,
      temperature: 0.1,
      topP: 0.8,
      stopSequences: ['END'],
      toolChoice: { tool: 'get_weather' },
    });

    expect(await generate(makeContext())).toMatchObject({
      content: 'Hello from Anthropic!',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    const anthropicToolCallResponse = await generate(makeContext());
    expect(anthropicToolCallResponse.toolCalls).toEqual([
      { id: 'toolu_01', name: 'get_weather', arguments: { location: 'San Francisco' } },
    ]);
    expect(await generate(makeContext())).toMatchObject({
      content: 'Let me check the weather.',
      usage: { prompt: 20, completion: 25, total: 45 },
    });
    const anthropicResponseWithoutUsage = await generate(makeContext());
    expect(anthropicResponseWithoutUsage.usage).toBeUndefined();
    expect(await generate(makeContext())).toMatchObject({
      content: '',
      usage: { prompt: 3, completion: 0, total: 3 },
    });

    expect(client._calls[0]).toMatchObject({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 200,
      temperature: 0.1,
      top_p: 0.8,
      stop_sequences: ['END'],
      tool_choice: { type: 'tool', name: 'get_weather' },
    });

    const noToolsClient = createMockAnthropicClient([anthropicTextResponse]);
    const noToolsGenerate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client: noToolsClient,
      toolChoice: 'none',
    });
    await noToolsGenerate(makeContext());
    expect(noToolsClient._calls[0]?.['tools']).toBeUndefined();

    const failingClient = createMockAnthropicClient([], [new Error('Anthropic failed')]);
    const failingGenerate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client: failingClient,
    });
    await expect(failingGenerate(makeContext())).rejects.toMatchObject({ provider: 'anthropic' });
  });

  it('streams text, tool calls, empty responses, usage fallbacks, aborts, and errors', async () => {
    const client = createMockAnthropicStreamingClient([
      anthropicStreamTextEvents,
      anthropicStreamToolUseEvents,
      anthropicStreamMixedEvents,
      anthropicStreamEmptyEvents,
      [{ type: 'message_start' }, { type: 'message_delta' }, { type: 'message_stop' }],
      anthropicStreamMultiToolEvents,
    ]);
    const generate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client,
      toolChoice: 'required',
    });

    const textUpdates: string[] = [];
    expect(
      await generate({ ...makeContext(), streaming: makeStreamingHandle(textUpdates) }),
    ).toMatchObject({
      content: 'Hello from Anthropic!',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    expect(textUpdates).toEqual(['Hello ', 'Hello from Anthropic!']);

    const anthropicStreamingToolCallResponse = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(anthropicStreamingToolCallResponse.toolCalls).toEqual([
      { id: 'toolu_01', name: 'get_weather', arguments: { location: 'San Francisco' } },
    ]);
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      content: 'Let me check.',
      toolCalls: [
        { id: 'toolu_mixed_01', name: 'get_weather', arguments: { location: 'New York' } },
      ],
    });
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      content: '',
      usage: { prompt: 5, completion: 0, total: 5 },
    });
    const anthropicStreamingResponseWithoutUsage = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(anthropicStreamingResponseWithoutUsage.usage).toBeUndefined();
    const anthropicStreamingMultipleToolCallResponse = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(anthropicStreamingMultipleToolCallResponse.toolCalls).toEqual([
      { id: 'toolu_multi_01', name: 'get_weather', arguments: { location: 'Paris' } },
      { id: 'toolu_multi_02', name: 'get_weather', arguments: { location: 'London' } },
    ]);

    const abortController = new AbortController();
    abortController.abort();
    const abortedClient = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
    const abortedGenerate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client: abortedClient,
    });
    expect(
      await abortedGenerate({
        ...makeContext({ signal: abortController.signal }),
        streaming: makeStreamingHandle(),
      }),
    ).toEqual({
      content: '',
      toolCalls: [],
      usage: undefined,
      metadata: { effectiveModel: 'claude-3-5-sonnet-20241022', effectiveEffort: 'none' },
    });

    const failingClient = createMockAnthropicStreamingClient(
      [],
      [new Error('Anthropic stream failed')],
    );
    const failingGenerate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client: failingClient,
    });
    await expect(
      failingGenerate({ ...makeContext(), streaming: makeStreamingHandle() }),
    ).rejects.toMatchObject({ provider: 'anthropic' });
  });

  it('surfaces malformed streamed tool-call JSON as a distinct ToolCallParseError, not a generic ProviderError', async () => {
    const malformedToolUseEvents: AnthropicStreamEvent[] = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_bad_01', name: 'roll_dice' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"sides": 2' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];
    const client = createMockAnthropicStreamingClient([malformedToolUseEvents]);
    const generate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client,
    });

    let caught: unknown;
    try {
      await generate({ ...makeContext(), streaming: makeStreamingHandle() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ToolCallParseError);
    expect(caught).toBeInstanceOf(ProviderError);
    const parseError = caught as ToolCallParseError;
    expect(parseError.provider).toBe('anthropic');
    expect(parseError.toolName).toBe('roll_dice');
    expect(parseError.toolCallId).toBe('toolu_bad_01');
    expect(parseError.rawArguments).toBe('{"sides": 2');
    expect(parseError.retryable).toBe(false);
  });
});

describe('Gemini provider coverage', () => {
  it('maps text, function calls, usage fallbacks, request options, and errors', async () => {
    const client = createMockGeminiModel([
      geminiTextResponse,
      geminiFunctionCallResponse,
      geminiMixedResponse,
      geminiNoUsageResponse,
      {
        response: {
          candidates: [{ content: {} }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
        },
      },
    ]);
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      maximumTokens: 200,
      temperature: 0.1,
      topP: 0.8,
      stopSequences: ['END'],
      toolChoice: { tool: 'get_weather' },
      responseFormat: { type: 'json' },
    });

    expect(await generate(makeContext())).toMatchObject({
      content: 'Hello from Gemini!',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    const geminiToolCallResponse = await generate(makeContext());
    expect(geminiToolCallResponse.toolCalls).toEqual([
      { name: 'get_weather', arguments: { location: 'San Francisco' } },
    ]);
    expect(await generate(makeContext())).toMatchObject({
      content: 'Let me check the weather.',
      usage: { prompt: 20, completion: 25, total: 45 },
    });
    const geminiResponseWithoutUsage = await generate(makeContext());
    expect(geminiResponseWithoutUsage.usage).toBeUndefined();
    expect(await generate(makeContext())).toMatchObject({
      content: '',
      usage: { prompt: 3, completion: 4, total: 7 },
    });

    expect(client._calls[0]).toMatchObject({
      contents: [],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
      generationConfig: {
        maxOutputTokens: 200,
        temperature: 0.1,
        topP: 0.8,
        stopSequences: ['END'],
        responseMimeType: 'application/json',
      },
    });

    const failingClient = createMockGeminiModel([], [new Error('Gemini failed')]);
    const failingGenerate = createGeminiProvider({ model: 'gemini-pro', client: failingClient });
    await expect(failingGenerate(makeContext())).rejects.toMatchObject({ provider: 'gemini' });
  });

  it('streams text, function calls, empty responses, usage fallbacks, aborts, and errors', async () => {
    const client = createMockGeminiStreamingModel([
      geminiStreamTextChunks,
      geminiStreamFunctionCallChunks,
      geminiStreamMixedChunks,
      geminiStreamEmptyChunks,
      [
        {
          candidates: [{ content: {} }],
          usageMetadata: { promptTokenCount: 2 },
        },
      ],
      geminiStreamMultiFunctionCallChunks,
    ]);
    const generate = createGeminiProviderStream({
      model: 'gemini-pro',
      client,
      maximumTokens: 200,
      toolChoice: 'required',
      responseFormat: { type: 'json' },
    });

    const textUpdates: string[] = [];
    expect(
      await generate({ ...makeContext(), streaming: makeStreamingHandle(textUpdates) }),
    ).toMatchObject({
      content: 'Hello from Gemini!',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    expect(textUpdates).toEqual(['Hello ', 'Hello from Gemini!']);

    const geminiStreamingToolCallResponse = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(geminiStreamingToolCallResponse.toolCalls).toEqual([
      { name: 'get_weather', arguments: { location: 'San Francisco' } },
    ]);
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      content: 'Checking weather...',
      toolCalls: [{ name: 'get_weather', arguments: { location: 'Tokyo' } }],
    });
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      content: '',
      usage: { prompt: 5, completion: 0, total: 5 },
    });
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      usage: { prompt: 2, completion: 0, total: 2 },
    });
    const geminiStreamingMultipleToolCallResponse = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(geminiStreamingMultipleToolCallResponse.toolCalls).toEqual([
      { name: 'get_weather', arguments: { location: 'Paris' } },
      { name: 'get_weather', arguments: { location: 'London' } },
    ]);

    const abortController = new AbortController();
    abortController.abort();
    const abortedClient = createMockGeminiStreamingModel([geminiStreamTextChunks]);
    const abortedGenerate = createGeminiProviderStream({
      model: 'gemini-pro',
      client: abortedClient,
    });
    expect(
      await abortedGenerate({
        ...makeContext({ signal: abortController.signal }),
        streaming: makeStreamingHandle(),
      }),
    ).toEqual({
      content: '',
      toolCalls: [],
      usage: undefined,
      metadata: { effectiveModel: 'gemini-pro', effectiveEffort: 'none' },
    });

    const failingClient = createMockGeminiStreamingModel([], [new Error('Gemini stream failed')]);
    const failingGenerate = createGeminiProviderStream({
      model: 'gemini-pro',
      client: failingClient,
    });
    await expect(
      failingGenerate({ ...makeContext(), streaming: makeStreamingHandle() }),
    ).rejects.toMatchObject({ provider: 'gemini' });

    expect(client._calls[0]?.['generationConfig']).toMatchObject({
      maxOutputTokens: 200,
      responseMimeType: 'application/json',
    });
  });
});
