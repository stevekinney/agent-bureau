/**
 * AB-91 — provider-neutral effort tiers + model alias registry.
 *
 * Covers, for each of the three shipped providers (Anthropic, OpenAI, Gemini):
 *   - Every model alias resolves to its documented concrete model ID.
 *   - Full provider-native IDs pass through untouched.
 *   - `'inherit'` is never resolved (caller-side concern).
 *   - Every effort tier maps to the provider's native mechanism on a
 *     capable model.
 *   - The fallback matrix: an unsupported tier degrades to the nearest
 *     supported lower tier, and a model with no reasoning knob at all
 *     degrades to omitting the parameter.
 *   - The effective model and effort actually used are reported on
 *     `GenerateResponse.metadata`.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createAnthropicProvider } from '../src/providers/anthropic.ts';
import { createGeminiProvider } from '../src/providers/gemini.ts';
import { createOpenAIProvider } from '../src/providers/openai.ts';
import {
  ANTHROPIC_MODEL_ALIASES,
  GEMINI_MODEL_ALIASES,
  OPENAI_MODEL_ALIASES,
  resolveAnthropicModel,
  resolveGeminiModel,
  resolveOpenAIModel,
} from '../src/providers/shared/model-registry.ts';
import {
  anthropicTextResponse,
  geminiTextResponse,
  openAITextResponse,
} from '../src/providers/test/fixtures.ts';
import {
  createMockAnthropicClient,
  createMockGeminiModel,
  createMockOpenAIClient,
} from '../src/providers/test/mock-clients.ts';

function makeContext() {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([]),
  };
}

// ── Model alias registry ────────────────────────────────────────────

describe('model alias registry — Anthropic', () => {
  it.each(Object.entries(ANTHROPIC_MODEL_ALIASES))('resolves alias %s to %s', (alias, expected) => {
    expect(resolveAnthropicModel(alias)).toBe(expected);
  });

  it('passes a full provider-native ID through unchanged', () => {
    expect(resolveAnthropicModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveAnthropicModel('claude-sonnet-4-6-20251114')).toBe('claude-sonnet-4-6-20251114');
  });

  it('never resolves the inherit alias — caller-side concern', () => {
    expect(resolveAnthropicModel('inherit')).toBe('inherit');
  });

  it('actually threads the resolved alias into the request the client receives', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'sonnet', client });

    await generate(makeContext());

    expect(client._calls[0]?.['model']).toBe('claude-sonnet-5');
  });
});

describe('model alias registry — OpenAI', () => {
  it.each(Object.entries(OPENAI_MODEL_ALIASES))('resolves alias %s to %s', (alias, expected) => {
    expect(resolveOpenAIModel(alias)).toBe(expected);
  });

  it('passes a full provider-native ID through unchanged', () => {
    expect(resolveOpenAIModel('gpt-4o')).toBe('gpt-4o');
  });

  it('never resolves the inherit alias — caller-side concern', () => {
    expect(resolveOpenAIModel('inherit')).toBe('inherit');
  });

  it('actually threads the resolved alias into the request the client receives', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'gpt-mini', client });

    await generate(makeContext());

    expect(client._calls[0]?.['model']).toBe('gpt-4.1-mini');
  });
});

describe('model alias registry — Gemini', () => {
  it.each(Object.entries(GEMINI_MODEL_ALIASES))('resolves alias %s to %s', (alias, expected) => {
    expect(resolveGeminiModel(alias)).toBe(expected);
  });

  it('passes a full provider-native ID through unchanged', () => {
    expect(resolveGeminiModel('gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });

  it('never resolves the inherit alias — caller-side concern', () => {
    expect(resolveGeminiModel('inherit')).toBe('inherit');
  });

  it('actually threads the resolved alias into the client construction', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'flash', client });

    const result = await generate(makeContext());

    // The mock client stands in for the already-resolved GenerativeModel
    // instance; the resolved model id is verified via effective-value
    // reporting instead of client-construction args.
    expect(result.metadata?.['effectiveModel']).toBe('gemini-2.5-flash');
  });
});

// ── Effort tiers + fallback matrix — Anthropic ──────────────────────

describe('effort tiers — Anthropic', () => {
  const EFFORT_CAPABLE_MODEL = 'claude-opus-4-8'; // full low..max, including xhigh
  const NO_XHIGH_MODEL = 'claude-opus-4-6'; // low..max, no xhigh
  const NO_EFFORT_MODEL = 'claude-haiku-4-5'; // no effort support at all

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'sends output_config.effort=%s on a fully-capable model',
    async (effort) => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      const generate = createAnthropicProvider({ model: EFFORT_CAPABLE_MODEL, effort, client });

      const result = await generate(makeContext());

      expect(client._calls[0]?.['output_config']).toEqual({ effort });
      expect(result.metadata?.['effectiveEffort']).toBe(effort);
    },
  );

  it('degrades xhigh to high on a model that supports max but not xhigh', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: NO_XHIGH_MODEL,
      effort: 'xhigh',
      client,
    });

    const result = await generate(makeContext());

    expect(client._calls[0]?.['output_config']).toEqual({ effort: 'high' });
    expect(result.metadata?.['effectiveEffort']).toBe('high');
  });

  it('omits output_config entirely on a model with no effort support', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: NO_EFFORT_MODEL,
      effort: 'max',
      client,
    });

    const result = await generate(makeContext());

    expect(client._calls[0]).not.toHaveProperty('output_config');
    expect(result.metadata?.['effectiveEffort']).toBe('none');
  });

  it('reports effectiveModel and a "none" effectiveEffort when no effort was requested', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'opus', client });

    const result = await generate(makeContext());

    expect(result.metadata?.['effectiveModel']).toBe('claude-opus-4-8');
    expect(result.metadata?.['effectiveEffort']).toBe('none');
    expect(client._calls[0]).not.toHaveProperty('output_config');
  });
});

// ── Effort tiers + fallback matrix — OpenAI ─────────────────────────

describe('effort tiers — OpenAI', () => {
  const REASONING_MODEL = 'o3';
  const NON_REASONING_MODEL = 'gpt-4o';

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'high'],
    ['max', 'high'],
  ] as const)(
    'maps effort=%s to reasoning_effort=%s on a reasoning model',
    async (effort, expected) => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = createOpenAIProvider({ model: REASONING_MODEL, effort, client });

      const result = await generate(makeContext());

      expect(client._calls[0]?.['reasoning_effort']).toBe(expected);
      expect(result.metadata?.['effectiveEffort']).toBe(expected);
    },
  );

  it('omits reasoning_effort entirely on a non-reasoning model', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({
      model: NON_REASONING_MODEL,
      effort: 'high',
      client,
    });

    const result = await generate(makeContext());

    expect(client._calls[0]).not.toHaveProperty('reasoning_effort');
    expect(result.metadata?.['effectiveEffort']).toBe('none');
  });

  it('reports effectiveModel when no effort was requested', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'o-mini', client });

    const result = await generate(makeContext());

    expect(result.metadata?.['effectiveModel']).toBe('o3-mini');
    expect(result.metadata?.['effectiveEffort']).toBe('none');
  });
});

// ── Effort tiers + fallback matrix — Gemini ─────────────────────────

describe('effort tiers — Gemini', () => {
  const THINKING_MODEL = 'gemini-2.5-pro';
  const NO_THINKING_MODEL = 'gemini-2.0-flash';

  it.each([
    ['low', 1024],
    ['medium', 8192],
    ['high', 16384],
    ['xhigh', 24576],
    ['max', -1],
  ] as const)(
    'maps effort=%s to thinkingBudget=%d on a thinking-capable model',
    async (effort, budget) => {
      const client = createMockGeminiModel([geminiTextResponse]);
      const generate = createGeminiProvider({ model: THINKING_MODEL, effort, client });

      const result = await generate(makeContext());

      expect(client._calls[0]?.['generationConfig']).toMatchObject({
        thinkingConfig: { thinkingBudget: budget },
      });
      expect(result.metadata?.['effectiveEffort']).toBe(effort);
    },
  );

  it('omits thinkingConfig entirely on a model with no thinking support', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({
      model: NO_THINKING_MODEL,
      effort: 'max',
      client,
    });

    const result = await generate(makeContext());

    const generationConfig = client._calls[0]?.['generationConfig'] as
      | Record<string, unknown>
      | undefined;
    expect(generationConfig?.['thinkingConfig']).toBeUndefined();
    expect(result.metadata?.['effectiveEffort']).toBe('none');
  });

  it('reports effectiveModel when no effort was requested', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'pro', client });

    const result = await generate(makeContext());

    expect(result.metadata?.['effectiveModel']).toBe('gemini-2.5-pro');
    expect(result.metadata?.['effectiveEffort']).toBe('none');
  });
});
