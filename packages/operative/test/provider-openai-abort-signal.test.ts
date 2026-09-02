/**
 * AB-238: the OpenAI providers must hand the run's abort signal to the SDK as
 * request options — `chat.completions.create(params, { signal })` — never as
 * a body field. Same defect class as AB-189: a signal inside the body is
 * JSON-serialized away and ignored, so `run.abort()` left the upstream HTTP
 * stream open until the model finished on its own, and an aborted run parked
 * on a stalled stream never resolved.
 */
import { createToolbox } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createAgentRun } from '../src/agent-run';
import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { AbortAgentRunError } from '../src/errors';
import { createOpenAIProvider, createOpenAIProviderStream } from '../src/providers/openai.ts';
import { openAIStreamTextChunks, openAITextResponse } from '../src/providers/test/fixtures.ts';
import {
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../src/providers/test/mock-clients.ts';
import type {
  OpenAIChatCompletionChunk,
  OpenAIRequestOptions,
  OpenAIStreamingClient,
} from '../src/providers/types.ts';
import type { GenerateContext, StreamingHandle } from '../src/types.ts';

function makeContext(signal?: AbortSignal): GenerateContext {
  return { conversation: new Conversation(), step: 0, toolbox: createToolbox([]), signal };
}

function makeStreamingHandle(): StreamingHandle {
  return { update: () => {} };
}

describe('createOpenAIProvider — abort signal placement', () => {
  it('passes the signal as the request-options argument and never in the body', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'gpt-4o', client });
    const controller = new AbortController();

    await generate(makeContext(controller.signal));

    expect(client._requestOptions[0]).toEqual({ signal: controller.signal });
    expect(client._requestOptions[0]?.signal).toBe(controller.signal);
    expect(Object.hasOwn(client._calls[0] ?? {}, 'signal')).toBe(false);
  });

  it('passes no request options when the context carries no signal', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'gpt-4o', client });

    await generate(makeContext());

    expect(client._requestOptions[0]).toBeUndefined();
    expect(Object.hasOwn(client._calls[0] ?? {}, 'signal')).toBe(false);
  });
});

describe('createOpenAIProviderStream — abort signal placement', () => {
  it('passes the signal as the request-options argument and never in the body', async () => {
    const client = createMockOpenAIStreamingClient([openAIStreamTextChunks]);
    const generate = createOpenAIProviderStream({ model: 'gpt-4o', client });
    const controller = new AbortController();

    await generate({ ...makeContext(controller.signal), streaming: makeStreamingHandle() });

    expect(client._requestOptions[0]).toEqual({ signal: controller.signal });
    expect(client._requestOptions[0]?.signal).toBe(controller.signal);
    expect(Object.hasOwn(client._calls[0] ?? {}, 'signal')).toBe(false);
  });

  it('passes no request options when the context carries no signal', async () => {
    const client = createMockOpenAIStreamingClient([openAIStreamTextChunks]);
    const generate = createOpenAIProviderStream({ model: 'gpt-4o', client });

    await generate({ ...makeContext(), streaming: makeStreamingHandle() });

    expect(client._requestOptions[0]).toBeUndefined();
    expect(Object.hasOwn(client._calls[0] ?? {}, 'signal')).toBe(false);
  });
});

/**
 * A client that behaves like the real SDK on the one axis that matters here:
 * the stream yields its first chunk and then blocks on the next one forever,
 * and only `options.signal` — never anything in the body — makes the pending
 * read reject with the SDK's abort error. A provider that put the signal in
 * the body would park here until the test timed out.
 */
function createStalledStreamingClient(): OpenAIStreamingClient & {
  bodySignals: unknown[];
} {
  const bodySignals: unknown[] = [];
  return {
    bodySignals,
    chat: {
      completions: {
        create(
          params: Record<string, unknown>,
          options?: OpenAIRequestOptions,
        ): AsyncIterable<OpenAIChatCompletionChunk> {
          bodySignals.push(params['signal']);
          const signal = options?.signal;
          return (async function* () {
            yield {
              choices: [{ delta: { content: 'partial' }, finish_reason: null }],
            } as OpenAIChatCompletionChunk;
            await new Promise<never>((_resolve, reject) => {
              if (signal?.aborted) {
                reject(new DOMException('Request was aborted.', 'AbortError'));
                return;
              }
              signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Request was aborted.', 'AbortError')),
                { once: true },
              );
            });
          })();
        },
      },
    },
  };
}

describe('run.abort() while the streaming OpenAI provider is blocked on the next chunk', () => {
  it('resolves result() as aborted rather than hanging or reporting a generate error', async () => {
    const client = createStalledStreamingClient();
    const generate = createOpenAIProviderStream({ model: 'gpt-4o', client });

    const activeRun = createActiveRun({
      generate: (context) => generate({ ...context, streaming: makeStreamingHandle() }),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });
    const run = createAgentRun(activeRun);

    setTimeout(() => run.abort('user cancelled'), 20);

    const result = await Promise.race([
      run.result(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('result() hung after abort')), 1_000),
      ),
    ]);

    expect(result.finishReason).toBe('aborted');
    expect(result.error).toBeInstanceOf(AbortAgentRunError);
    expect((result.error as AbortAgentRunError).message).toBe('user cancelled');
    expect(client.bodySignals).toEqual([undefined]);
  });
});
