/**
 * AB-189: the Anthropic providers must hand the run's abort signal to the SDK
 * as request options — `messages.create(params, { signal })` — never as a
 * body field. A signal inside the body is JSON-serialized into `{}` and
 * ignored, so `run.abort()` left the upstream HTTP stream open until the
 * model finished on its own, and an aborted run parked on a stalled stream
 * never resolved.
 */
import { createToolbox } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createAgentRun } from '../src/agent-run';
import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { AbortAgentRunError } from '../src/errors';
import {
  createAnthropicProvider,
  createAnthropicProviderStream,
} from '../src/providers/anthropic.ts';
import {
  anthropicStreamTextEvents,
  anthropicTextResponse,
} from '../src/providers/test/fixtures.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../src/providers/test/mock-clients.ts';
import type {
  AnthropicMessageCreateRequest,
  AnthropicRequestOptions,
  AnthropicStreamEvent,
  AnthropicStreamingClient,
} from '../src/providers/types.ts';
import { waitForCondition } from '../src/test/index';
import type { GenerateContext, StreamingHandle } from '../src/types.ts';

function makeContext(signal?: AbortSignal): GenerateContext {
  return { conversation: new Conversation(), step: 0, toolbox: createToolbox([]), signal };
}

function makeStreamingHandle(): StreamingHandle {
  return { update: () => {}, messageId: 'test-message-id' };
}

describe('createAnthropicProvider — abort signal placement', () => {
  it('passes the signal as the request-options argument and never in the body', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-sonnet-5', client });
    const controller = new AbortController();

    await generate(makeContext(controller.signal));

    expect(client._requestOptions[0]).toEqual({ signal: controller.signal });
    expect(client._requestOptions[0]?.signal).toBe(controller.signal);
    expect(Object.hasOwn(client._calls[0] ?? {}, 'signal')).toBe(false);
  });

  it('passes no request options when the context carries no signal', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-sonnet-5', client });

    await generate(makeContext());

    expect(client._requestOptions[0]).toBeUndefined();
    expect(Object.hasOwn(client._calls[0] ?? {}, 'signal')).toBe(false);
  });
});

describe('createAnthropicProviderStream — abort signal placement', () => {
  it('passes the signal as the request-options argument and never in the body', async () => {
    const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
    const generate = createAnthropicProviderStream({ model: 'claude-sonnet-5', client });
    const controller = new AbortController();

    await generate({ ...makeContext(controller.signal), streaming: makeStreamingHandle() });

    expect(client._requestOptions[0]).toEqual({ signal: controller.signal });
    expect(client._requestOptions[0]?.signal).toBe(controller.signal);
    expect(Object.hasOwn(client._calls[0] ?? {}, 'signal')).toBe(false);
  });

  it('passes no request options when the context carries no signal', async () => {
    const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
    const generate = createAnthropicProviderStream({ model: 'claude-sonnet-5', client });

    await generate({ ...makeContext(), streaming: makeStreamingHandle() });

    expect(client._requestOptions[0]).toBeUndefined();
    expect(Object.hasOwn(client._calls[0] ?? {}, 'signal')).toBe(false);
  });
});

/**
 * A client that behaves like the real SDK on the one axis that matters here:
 * the stream yields its first event and then blocks on the next chunk
 * forever, and only `options.signal` — never anything in the body — makes
 * the pending read reject with the SDK's abort error. A provider that put the
 * signal in the body would park here until the test timed out.
 */
function createStalledStreamingClient(): AnthropicStreamingClient & {
  bodySignals: unknown[];
} {
  const bodySignals: unknown[] = [];
  return {
    bodySignals,
    messages: {
      create(
        params: AnthropicMessageCreateRequest,
        options?: AnthropicRequestOptions,
      ): AsyncIterable<AnthropicStreamEvent> {
        bodySignals.push((params as unknown as Record<string, unknown>)['signal']);
        const signal = options?.signal;
        return (async function* () {
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'partial' },
          } as AnthropicStreamEvent;
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
  };
}

describe('run.abort() while the streaming provider is blocked on the next chunk', () => {
  it('resolves result() as aborted rather than hanging or reporting a generate error', async () => {
    const client = createStalledStreamingClient();
    const generate = createAnthropicProviderStream({ model: 'claude-sonnet-5', client });

    const activeRun = createActiveRun({
      generate: (context) => generate({ ...context, streaming: makeStreamingHandle() }),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });
    const run = createAgentRun(activeRun);

    // Wait for the streaming request to actually start (the client has
    // observed a `messages.create` call) rather than a single event-loop
    // yield, which risks aborting before the request begins on a loaded host.
    await waitForCondition(() => client.bodySignals.length > 0, 'streaming request never started');
    run.abort('user cancelled');

    const resultPromise = run.result();
    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitForCondition(() => settled, 'result() hung after abort');
    const result = await resultPromise;

    expect(result.finishReason).toBe('aborted');
    expect(result.error).toBeInstanceOf(AbortAgentRunError);
    expect((result.error as AbortAgentRunError).message).toBe('user cancelled');
    expect(client.bodySignals).toEqual([undefined]);
  });
});
