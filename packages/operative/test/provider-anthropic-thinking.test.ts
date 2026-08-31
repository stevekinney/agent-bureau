/**
 * Explicit extended-thinking request parameter for Anthropic (AB-157).
 *
 * `thinking` mirrors Anthropic's native `ThinkingConfigParam` shape directly on
 * `AnthropicProviderOptions` — all three variants: `enabled`, `disabled`, and
 * `adaptive`, the last two of which carry an optional `display`. It is a
 * second, provider-native escape hatch alongside the existing neutral `effort`
 * knob — the two lower to different wire fields (`thinking` vs.
 * `output_config.effort`) and neither overrides the other: when both are set,
 * both are sent on the request body.
 *
 * That the union stays a faithful mirror is pinned at compile time, not here:
 * see `src/providers/anthropic-thinking-assignability.test-d.ts`. The runtime
 * tests below cover what it lowers to on the wire, plus the one constraint
 * Anthropic imposes on an enabled budget — "Must be ≥1024 and less than
 * `max_tokens`", quoted from `ThinkingConfigEnabled` in `@anthropic-ai/sdk` —
 * which both factories check rather than letting the API reject the request.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import {
  createAnthropicProvider,
  createAnthropicProviderStream,
} from '../src/providers/anthropic.ts';
import { ProviderError } from '../src/providers/errors.ts';
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
      // 4096 against the default `maximumTokens` of 4096 would be invalid by
      // construction — `budget_tokens` must be strictly below `max_tokens`.
      maximumTokens: 8192,
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });

    await generate({ ...makeContext(), streaming: makeStreamingHandle() });

    expect(client._calls[0]?.['thinking']).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(client._calls[0]?.['output_config']).toEqual({ effort: 'high' });
  });

  it('emits `{ type: "adaptive" }` with its `display` field on the request body', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-sonnet-5',
      client,
      thinking: { type: 'adaptive', display: 'omitted' },
    });

    await generate(makeContext());

    expect(client._calls[0]?.['thinking']).toEqual({ type: 'adaptive', display: 'omitted' });
  });

  it('emits an enabled `display` field on the request body', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-sonnet-5',
      client,
      maximumTokens: 8192,
      thinking: { type: 'enabled', budget_tokens: 2048, display: 'summarized' },
    });

    await generate(makeContext());

    expect(client._calls[0]?.['thinking']).toEqual({
      type: 'enabled',
      budget_tokens: 2048,
      display: 'summarized',
    });
  });
});

describe('Anthropic extended-thinking budget validation', () => {
  /**
   * The exact case from review: a plausible budget that happens to equal the
   * provider's default `maximumTokens`, which Anthropic rejects with a 400 on
   * every request because the budget must be strictly below `max_tokens`.
   */
  it('rejects a budget equal to the default maximumTokens at construction, naming both values', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    const construct = (): unknown =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        thinking: { type: 'enabled', budget_tokens: 4096 },
      });

    expect(construct).toThrow(ProviderError);
    expect(construct).toThrow(/budget_tokens \(4096\) must be less than max_tokens \(4096\)/);
  });

  it('rejects a budget above an explicit maximumTokens at construction', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        maximumTokens: 2048,
        thinking: { type: 'enabled', budget_tokens: 3000 },
      }),
    ).toThrow(/budget_tokens \(3000\) must be less than max_tokens \(2048\)/);
  });

  it("rejects a budget below Anthropic's documented minimum of 1024", () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        thinking: { type: 'enabled', budget_tokens: 512 },
      }),
    ).toThrow(/budget_tokens \(512\) is below Anthropic's minimum of 1024/);
  });

  it('rejects the same budget from the streaming factory at construction', () => {
    const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);

    expect(() =>
      createAnthropicProviderStream({
        model: 'claude-3-5-sonnet-20241022',
        client,
        thinking: { type: 'enabled', budget_tokens: 4096 },
      }),
    ).toThrow(/budget_tokens \(4096\) must be less than max_tokens \(4096\)/);
  });

  it('rejects a per-call maximumTokens that drops below an otherwise-valid budget', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      maximumTokens: 8192,
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });

    await expect(generate({ ...makeContext(), maximumTokens: 2048 })).rejects.toThrow(
      /budget_tokens \(4096\) must be less than max_tokens \(2048\)/,
    );
    expect(client._calls).toEqual([]);
  });

  it('rejects a per-call maximumTokens override on the streaming factory too', async () => {
    const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
    const generate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client,
      maximumTokens: 8192,
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });

    await expect(
      generate({ ...makeContext(), maximumTokens: 2048, streaming: makeStreamingHandle() }),
    ).rejects.toThrow(/budget_tokens \(4096\) must be less than max_tokens \(2048\)/);
    expect(client._calls).toEqual([]);
  });

  it('classifies the failure as a non-retryable configuration fault', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    let thrown: unknown;
    try {
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        thinking: { type: 'enabled', budget_tokens: 4096 },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).provider).toBe('anthropic');
    expect((thrown as ProviderError).retryable).toBe(false);
  });

  it('leaves `disabled` and `adaptive` unvalidated — neither carries a budget', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        maximumTokens: 16,
        thinking: { type: 'disabled' },
      }),
    ).not.toThrow();

    expect(() =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        maximumTokens: 16,
        thinking: { type: 'adaptive' },
      }),
    ).not.toThrow();
  });
});
