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
 * tests below cover what it lowers to on the wire, plus the constraints
 * Anthropic imposes on a thinking-enabled request, which both factories check
 * rather than letting the API reject them:
 *
 * - The enabled budget — "Must be ≥1024 and less than `max_tokens`", quoted
 *   from `ThinkingConfigEnabled` in `@anthropic-ai/sdk`. The two halves are
 *   checked at different times on purpose: the ≥1024 floor depends on nothing
 *   but the budget, so it is a construction-time fault, while the
 *   `< max_tokens` bound depends on the `max_tokens` actually sent, which
 *   `GenerateContext.maximumTokens` can raise per call.
 * - The parameter combinations Anthropic's thinking documentation rejects
 *   while thinking is on: a non-default `temperature`, a `top_p` below 0.95,
 *   and — for manual `{ type: 'enabled' }` only — forced tool use. Adaptive
 *   thinking is documented to support forced tool use, so that one variant is
 *   deliberately left alone.
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
  it("rejects a budget below Anthropic's documented minimum of 1024 at construction", () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        thinking: { type: 'enabled', budget_tokens: 512 },
      }),
    ).toThrow(/budget_tokens \(512\) is below Anthropic's minimum of 1024/);
  });

  it('rejects the same sub-minimum budget from the streaming factory at construction', () => {
    const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);

    expect(() =>
      createAnthropicProviderStream({
        model: 'claude-3-5-sonnet-20241022',
        client,
        thinking: { type: 'enabled', budget_tokens: 512 },
      }),
    ).toThrow(/budget_tokens \(512\) is below Anthropic's minimum of 1024/);
  });

  /**
   * The floor is the only budget rule that can be settled at construction: it
   * depends on nothing but the budget itself. The `< max_tokens` bound cannot,
   * because `GenerateContext.maximumTokens` is documented to override the
   * construction-time value for that call — so the effective `max_tokens` is
   * not known until the call happens. A construction-time upper-bound check
   * rejected configurations that never produce an invalid request; these two
   * tests are the regression for that.
   */
  it('accepts a budget equal to the default maximumTokens at construction, deferring the bound to the call', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });

    await generate({ ...makeContext(), maximumTokens: 8192 });

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0]?.['max_tokens']).toBe(8192);
    expect(client._calls[0]?.['thinking']).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('defers the same bound to the call on the streaming factory', async () => {
    const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);

    const generate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client,
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });

    await generate({ ...makeContext(), maximumTokens: 8192, streaming: makeStreamingHandle() });

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0]?.['max_tokens']).toBe(8192);
  });

  /**
   * The case from review, now checked where the effective limit is actually
   * known: a plausible budget that equals the `max_tokens` the request will
   * send, which Anthropic rejects with a 400 because the budget must be
   * strictly below it.
   */
  it('rejects a budget equal to the effective maximumTokens on the call, naming both values', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });

    await expect(generate(makeContext())).rejects.toThrow(
      /budget_tokens \(4096\) must be less than max_tokens \(4096\)/,
    );
    expect(client._calls).toEqual([]);
  });

  it('rejects a budget above an explicit maximumTokens on the call', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      maximumTokens: 2048,
      thinking: { type: 'enabled', budget_tokens: 3000 },
    });

    await expect(generate(makeContext())).rejects.toThrow(
      /budget_tokens \(3000\) must be less than max_tokens \(2048\)/,
    );
    expect(client._calls).toEqual([]);
  });

  it('rejects the same budget from the streaming factory on the call', async () => {
    const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
    const generate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client,
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });

    await expect(generate({ ...makeContext(), streaming: makeStreamingHandle() })).rejects.toThrow(
      /budget_tokens \(4096\) must be less than max_tokens \(4096\)/,
    );
    expect(client._calls).toEqual([]);
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

  it('classifies the construction-time floor failure as a non-retryable configuration fault', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    let thrown: unknown;
    try {
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        thinking: { type: 'enabled', budget_tokens: 512 },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).provider).toBe('anthropic');
    expect((thrown as ProviderError).retryable).toBe(false);
  });

  it('classifies the per-call upper-bound failure as a non-retryable configuration fault', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });

    const thrown: unknown = await generate(makeContext()).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).provider).toBe('anthropic');
    expect((thrown as ProviderError).retryable).toBe(false);
  });

  it('leaves `disabled` and `adaptive` unvalidated — neither carries a budget', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse, anthropicTextResponse]);

    const disabled = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      maximumTokens: 16,
      thinking: { type: 'disabled' },
    });
    const adaptive = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      maximumTokens: 16,
      thinking: { type: 'adaptive' },
    });

    await disabled(makeContext());
    await adaptive(makeContext());

    expect(client._calls).toHaveLength(2);
  });
});

/**
 * Anthropic documents three parameter combinations that a thinking-enabled
 * request cannot carry. Each was verified against Anthropic's thinking
 * documentation before being enforced, because they do not all cover the same
 * modes — in particular, forced tool use is a *manual* extended-thinking
 * limitation only: "Adaptive thinking, including on models where thinking is
 * on by default, supports forced tool use."
 */
describe('Anthropic thinking parameter-compatibility validation', () => {
  it('rejects a non-default temperature alongside enabled thinking, naming both fields', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        maximumTokens: 8192,
        temperature: 0.2,
        thinking: { type: 'enabled', budget_tokens: 2048 },
      }),
    ).toThrow(/temperature \(0\.2\) cannot be combined with thinking\.type 'enabled'/);
  });

  it('rejects a non-default temperature alongside adaptive thinking too', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-sonnet-5',
        client,
        temperature: 0,
        thinking: { type: 'adaptive' },
      }),
    ).toThrow(/temperature \(0\) cannot be combined with thinking\.type 'adaptive'/);
  });

  it('accepts the default temperature of 1 alongside thinking', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-sonnet-5',
        client,
        temperature: 1,
        thinking: { type: 'adaptive' },
      }),
    ).not.toThrow();
  });

  it('rejects a topP below Anthropic’s 0.95 floor while thinking is on', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-sonnet-5',
        client,
        topP: 0.5,
        thinking: { type: 'adaptive' },
      }),
    ).toThrow(/topP \(0\.5\) cannot be combined with thinking\.type 'adaptive'/);
  });

  it('accepts a topP of exactly 0.95 — Anthropic’s bound is inclusive', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-sonnet-5',
        client,
        topP: 0.95,
        thinking: { type: 'adaptive' },
      }),
    ).not.toThrow();
  });

  it('rejects a forced toolChoice of `required` alongside enabled thinking', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        maximumTokens: 8192,
        toolChoice: 'required',
        thinking: { type: 'enabled', budget_tokens: 2048 },
      }),
    ).toThrow(/toolChoice 'required' cannot be combined with thinking\.type 'enabled'/);
  });

  it('rejects a named-tool toolChoice alongside enabled thinking, naming the tool', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        maximumTokens: 8192,
        toolChoice: { tool: 'search' },
        thinking: { type: 'enabled', budget_tokens: 2048 },
      }),
    ).toThrow(
      /toolChoice the named tool 'search' cannot be combined with thinking\.type 'enabled'/,
    );
  });

  /**
   * The limitation is manual-mode-only. Guarding adaptive here would reject a
   * combination Anthropic explicitly documents as supported.
   */
  it('accepts a forced toolChoice alongside adaptive thinking', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-sonnet-5',
        client,
        toolChoice: 'required',
        thinking: { type: 'adaptive' },
      }),
    ).not.toThrow();

    expect(() =>
      createAnthropicProvider({
        model: 'claude-sonnet-5',
        client,
        toolChoice: { tool: 'search' },
        thinking: { type: 'adaptive' },
      }),
    ).not.toThrow();
  });

  it('accepts the unforced toolChoice values alongside enabled thinking', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        maximumTokens: 8192,
        toolChoice: 'auto',
        thinking: { type: 'enabled', budget_tokens: 2048 },
      }),
    ).not.toThrow();

    expect(() =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        maximumTokens: 8192,
        toolChoice: 'none',
        thinking: { type: 'enabled', budget_tokens: 2048 },
      }),
    ).not.toThrow();
  });

  it('leaves every combination alone when thinking is disabled or absent', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    expect(() =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        temperature: 0.2,
        topP: 0.1,
        toolChoice: 'required',
        thinking: { type: 'disabled' },
      }),
    ).not.toThrow();

    expect(() =>
      createAnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
        client,
        temperature: 0.2,
        topP: 0.1,
        toolChoice: 'required',
      }),
    ).not.toThrow();
  });

  it('applies the same checks to the streaming factory', () => {
    const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);

    expect(() =>
      createAnthropicProviderStream({
        model: 'claude-sonnet-5',
        client,
        temperature: 0.2,
        thinking: { type: 'adaptive' },
      }),
    ).toThrow(/temperature \(0\.2\) cannot be combined with thinking\.type 'adaptive'/);
  });

  it('classifies the conflict as a non-retryable configuration fault', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    let thrown: unknown;
    try {
      createAnthropicProvider({
        model: 'claude-sonnet-5',
        client,
        toolChoice: 'required',
        thinking: { type: 'enabled', budget_tokens: 2048 },
        maximumTokens: 8192,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).provider).toBe('anthropic');
    expect((thrown as ProviderError).retryable).toBe(false);
  });
});
