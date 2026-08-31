/**
 * Explicit extended-thinking request parameter for Anthropic (AB-157).
 *
 * `thinking` mirrors Anthropic's native request shape directly
 * (`{ type: 'enabled'; budget_tokens: number } | { type: 'disabled' }`) on
 * `AnthropicProviderOptions`. It is a second, provider-native escape hatch
 * alongside the existing neutral `effort` knob — the two lower to different
 * wire fields (`thinking` vs. `output_config.effort`) and neither overrides
 * the other: when both are set, both are sent on the request body.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

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
import type { GenerateContext, StreamingHandle } from '../src/types.ts';

function makeContext(): GenerateContext {
  return { conversation: new Conversation(), step: 0, toolbox: createToolbox([]) };
}

function makeStreamingHandle(): StreamingHandle {
  return { update: () => {} };
}

describe('Anthropic explicit extended-thinking request', () => {
  it('emits `thinking` alone on the request body', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });

    await generate(makeContext());

    expect(client._calls[0]?.['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(Object.hasOwn(client._calls[0] ?? {}, 'output_config')).toBe(false);
  });

  it('emits `output_config.effort` alone when only `effort` is set', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-sonnet-5',
      client,
      effort: 'high',
    });

    await generate(makeContext());

    expect(client._calls[0]?.['output_config']).toEqual({ effort: 'high' });
    expect(Object.hasOwn(client._calls[0] ?? {}, 'thinking')).toBe(false);
  });

  it('emits both `thinking` and `output_config.effort` when both are set, neither overriding the other', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-sonnet-5',
      client,
      effort: 'high',
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });

    await generate(makeContext());

    expect(client._calls[0]?.['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(client._calls[0]?.['output_config']).toEqual({ effort: 'high' });
  });

  it('omits `thinking` entirely when not set', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-3-5-sonnet-20241022', client });

    await generate(makeContext());

    expect(Object.hasOwn(client._calls[0] ?? {}, 'thinking')).toBe(false);
  });

  it('emits `{ type: "disabled" }` on the request body', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      thinking: { type: 'disabled' },
    });

    await generate(makeContext());

    expect(client._calls[0]?.['thinking']).toEqual({ type: 'disabled' });
  });

  it('emits `thinking` on the streaming request body alongside `output_config.effort`', async () => {
    const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
    const generate = createAnthropicProviderStream({
      model: 'claude-sonnet-5',
      client,
      effort: 'high',
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });

    await generate({ ...makeContext(), streaming: makeStreamingHandle() });

    expect(client._calls[0]?.['thinking']).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(client._calls[0]?.['output_config']).toEqual({ effort: 'high' });
  });
});
