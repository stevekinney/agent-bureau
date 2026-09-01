/**
 * AB-186 — tool-call stream events must be observable while the provider
 * response is still open.
 *
 * Spec: with `withEnhancedStreaming(..., { liveToolCalls: true })`, the
 * Anthropic and OpenAI streaming adapters report `stream:tool-call-start` and
 * `stream:tool-call-delta` through `StreamingHandle.report` at the moment the
 * provider emits them — not after the generate promise resolves. Each test
 * drives a fake client that fully emits a tool call and then *holds the
 * response open* on a gate, and asserts the events land before the response
 * closes. `stream:text-delta` is the control: it already fires live today, so
 * an ordering assertion that passes for text and fails for tool calls isolates
 * the defect rather than the probe.
 *
 * `stream:tool-call-complete` is deliberately not live. An adapter only knows a
 * tool call's parsed `arguments` after the stream closes — that is where
 * `ToolCallParseError` is raised — so the wrapper synthesizes the completion
 * from the resolved `GenerateResponse`, pairing each resolved tool call with
 * the live block at the same ordinal position.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { TypedEventTarget } from 'lifecycle';
import { z } from 'zod';

import { createAnthropicProviderStream } from '../src/providers/anthropic.ts';
import { createOpenAIProviderStream } from '../src/providers/openai.ts';
import type {
  AnthropicStreamEvent,
  AnthropicStreamingClient,
  OpenAIChatCompletionChunk,
  OpenAIStreamingClient,
} from '../src/providers/types.ts';
import { withEnhancedStreaming } from '../src/streaming/index.ts';
import type { StreamEventMap } from '../src/streaming/types.ts';
import type { GenerateContext } from '../src/types.ts';

const weatherTool = {
  name: 'get_weather',
  description: 'Get the weather',
  parameters: z.object({ location: z.string() }),
  execute: async () => 'sunny',
};

function makeContext(): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([weatherTool]),
  };
}

/** A gate the fake client awaits before closing the provider response. */
function createGate(): { gate: Promise<void>; release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/**
 * Records stream events and provider milestones into one ordered log, so a
 * test can assert that an event happened *before* the response closed.
 */
function createTranscript(): {
  log: string[];
  eventTarget: TypedEventTarget<StreamEventMap>;
} {
  const log: string[] = [];
  const eventTarget = new TypedEventTarget<StreamEventMap>();
  const observed = [
    'stream:text-delta',
    'stream:tool-call-start',
    'stream:tool-call-delta',
    'stream:tool-call-complete',
    'stream:complete',
  ] as const;
  for (const type of observed) {
    eventTarget.addEventListener(type, () => log.push(`EVENT: ${type}`));
  }
  return { log, eventTarget };
}

describe('live tool-call streaming — Anthropic adapter', () => {
  it('emits stream:tool-call-start and stream:tool-call-delta before the response closes', async () => {
    const { log, eventTarget } = createTranscript();
    const { gate, release } = createGate();

    const client: AnthropicStreamingClient = {
      messages: {
        create(): AsyncIterable<AnthropicStreamEvent> {
          return (async function* () {
            yield {
              type: 'message_start',
              message: { usage: { input_tokens: 10, output_tokens: 0 } },
            };
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: { id: 'txt_01', type: 'text' },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Checking…' },
            };
            yield { type: 'content_block_stop', index: 0 };
            yield {
              type: 'content_block_start',
              index: 1,
              content_block: { id: 'toolu_01', type: 'tool_use', name: 'get_weather' },
            };
            yield {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"location":' },
            };
            yield {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '"Denver"}' },
            };
            yield { type: 'content_block_stop', index: 1 };
            log.push('PROVIDER: tool_use block emitted, response still open');
            await gate;
            log.push('PROVIDER: response closing');
            yield { type: 'message_stop' };
          })();
        },
      },
    };

    const generate = withEnhancedStreaming(
      createAnthropicProviderStream({ model: 'claude-sonnet-5', client }),
      { eventTarget, liveToolCalls: true },
    );

    const pending = generate(makeContext());
    // Let the provider drain up to the gate before releasing it, so "still
    // open" is a real window rather than a scheduling accident.
    await Promise.resolve();
    release();
    const response = await pending;

    const closingIndex = log.indexOf('PROVIDER: response closing');
    const startIndex = log.indexOf('EVENT: stream:tool-call-start');
    const deltaIndex = log.indexOf('EVENT: stream:tool-call-delta');

    expect(closingIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeLessThan(closingIndex);
    expect(deltaIndex).toBeLessThan(closingIndex);

    // The completion still lands after the response closes, by design.
    expect(log.indexOf('EVENT: stream:tool-call-complete')).toBeGreaterThan(closingIndex);
    expect(response.toolCalls).toEqual([
      { id: 'toolu_01', name: 'get_weather', arguments: { location: 'Denver' } },
    ]);
  });

  it('reports accumulated partial arguments on each delta', async () => {
    const partials: string[] = [];
    const { gate, release } = createGate();

    const client: AnthropicStreamingClient = {
      messages: {
        create(): AsyncIterable<AnthropicStreamEvent> {
          return (async function* () {
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: { id: 'toolu_01', type: 'tool_use', name: 'get_weather' },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"location":' },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '"Denver"}' },
            };
            await gate;
            yield { type: 'message_stop' };
          })();
        },
      },
    };

    const generate = withEnhancedStreaming(
      createAnthropicProviderStream({ model: 'claude-sonnet-5', client }),
      {
        liveToolCalls: true,
        onToolCallDelta: (_toolName, partialArgs) => partials.push(partialArgs),
      },
    );

    const pending = generate(makeContext());
    await Promise.resolve();
    release();
    await pending;

    expect(partials).toEqual(['{"location":', '{"location":"Denver"}']);
  });

  it('falls back to a synthesized block id when the tool_use block carries none', async () => {
    const blockIds: string[] = [];
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    eventTarget.addEventListener('stream:tool-call-start', (event) =>
      blockIds.push(event.detail.blockId),
    );

    const client: AnthropicStreamingClient = {
      messages: {
        create(): AsyncIterable<AnthropicStreamEvent> {
          return (async function* () {
            yield {
              type: 'content_block_start',
              index: 3,
              content_block: { type: 'tool_use', name: 'get_weather' },
            };
            yield {
              type: 'content_block_delta',
              index: 3,
              delta: { type: 'input_json_delta', partial_json: '{"location":"Denver"}' },
            };
            yield { type: 'message_stop' };
          })();
        },
      },
    };

    const generate = withEnhancedStreaming(
      createAnthropicProviderStream({ model: 'claude-sonnet-5', client }),
      { eventTarget, liveToolCalls: true },
    );

    await generate(makeContext());

    expect(blockIds).toEqual(['block-3']);
  });

  it('emits no completion events when the caller aborts after live events fired', async () => {
    const { log, eventTarget } = createTranscript();
    const controller = new AbortController();

    const client: AnthropicStreamingClient = {
      messages: {
        create(): AsyncIterable<AnthropicStreamEvent> {
          return (async function* () {
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: { id: 'toolu_01', type: 'tool_use', name: 'get_weather' },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"loc' },
            };
            controller.abort();
            yield { type: 'message_stop' };
          })();
        },
      },
    };

    const generate = withEnhancedStreaming(
      createAnthropicProviderStream({ model: 'claude-sonnet-5', client }),
      { eventTarget, liveToolCalls: true },
    );

    const response = await generate({ ...makeContext(), signal: controller.signal });

    // The truncated call is dropped from the response, so no completion is
    // synthesized for it — and the wrapper must not fall back to the
    // reconstruct-on-resolve path and re-emit the start it already sent.
    expect(response.toolCalls).toEqual([]);
    expect(log.filter((entry) => entry === 'EVENT: stream:tool-call-start')).toHaveLength(1);
    expect(log).not.toContain('EVENT: stream:tool-call-complete');
  });
});

describe('live tool-call streaming — OpenAI adapter', () => {
  it('emits stream:tool-call-start and stream:tool-call-delta before the response closes', async () => {
    const { log, eventTarget } = createTranscript();
    const { gate, release } = createGate();

    const client: OpenAIStreamingClient = {
      chat: {
        completions: {
          create(): AsyncIterable<OpenAIChatCompletionChunk> {
            return (async function* () {
              yield {
                choices: [{ delta: { content: 'Checking…' }, finish_reason: null }],
                usage: null,
              };
              yield {
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
              };
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [{ index: 0, function: { arguments: '{"location":"Denver"}' } }],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: null,
              };
              log.push('PROVIDER: tool_call chunks emitted, response still open');
              await gate;
              log.push('PROVIDER: response closing');
              yield {
                choices: [],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              };
            })();
          },
        },
      },
    };

    const generate = withEnhancedStreaming(
      createOpenAIProviderStream({ model: 'gpt-4o', client }),
      { eventTarget, liveToolCalls: true },
    );

    const pending = generate(makeContext());
    await Promise.resolve();
    release();
    const response = await pending;

    const closingIndex = log.indexOf('PROVIDER: response closing');
    const startIndex = log.indexOf('EVENT: stream:tool-call-start');
    const deltaIndex = log.indexOf('EVENT: stream:tool-call-delta');

    expect(closingIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeLessThan(closingIndex);
    expect(deltaIndex).toBeLessThan(closingIndex);
    expect(log.indexOf('EVENT: stream:tool-call-complete')).toBeGreaterThan(closingIndex);
    expect(response.toolCalls).toEqual([
      { id: 'call_01', name: 'get_weather', arguments: { location: 'Denver' } },
    ]);
  });

  it('reports arguments that arrive on the same chunk that opens the tool call', async () => {
    const partials: Array<{ toolName: string; partialArguments: string }> = [];
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    eventTarget.addEventListener('stream:tool-call-delta', (event) =>
      partials.push({
        toolName: event.detail.toolName,
        partialArguments: event.detail.partialArguments,
      }),
    );

    const client: OpenAIStreamingClient = {
      chat: {
        completions: {
          create(): AsyncIterable<OpenAIChatCompletionChunk> {
            return (async function* () {
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_01',
                          type: 'function',
                          function: { name: 'get_weather', arguments: '{"loc' },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              };
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [{ index: 0, function: { arguments: 'ation":"Denver"}' } }],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: null,
              };
            })();
          },
        },
      },
    };

    const generate = withEnhancedStreaming(
      createOpenAIProviderStream({ model: 'gpt-4o', client }),
      { eventTarget, liveToolCalls: true },
    );

    await generate(makeContext());

    expect(partials).toEqual([
      { toolName: 'get_weather', partialArguments: '{"loc' },
      { toolName: 'get_weather', partialArguments: '{"location":"Denver"}' },
    ]);
  });

  it('falls back to a synthesized block id when the tool call chunk carries no id', async () => {
    const blockIds: string[] = [];
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    eventTarget.addEventListener('stream:tool-call-start', (event) =>
      blockIds.push(event.detail.blockId),
    );

    const client: OpenAIStreamingClient = {
      chat: {
        completions: {
          create(): AsyncIterable<OpenAIChatCompletionChunk> {
            return (async function* () {
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 2,
                          type: 'function',
                          function: { name: 'get_weather', arguments: '{"location":"Denver"}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: null,
              };
            })();
          },
        },
      },
    };

    const generate = withEnhancedStreaming(
      createOpenAIProviderStream({ model: 'gpt-4o', client }),
      { eventTarget, liveToolCalls: true },
    );

    await generate(makeContext());

    expect(blockIds).toEqual(['tool-2']);
  });
});
