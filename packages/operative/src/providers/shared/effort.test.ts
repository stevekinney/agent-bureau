import { describe, expect, it } from 'bun:test';

import {
  ANTHROPIC_EFFORT_SUPPORT,
  GEMINI_THINKING_MODELS,
  OPENAI_REASONING_MODELS,
  resolveAnthropicEffort,
  resolveGeminiEffort,
  resolveOpenAIEffort,
} from './effort.ts';

describe('resolveAnthropicEffort', () => {
  it('returns the requested tier unchanged when the model supports it', () => {
    expect(resolveAnthropicEffort('xhigh', 'claude-opus-4-8')).toBe('xhigh');
    expect(resolveAnthropicEffort('max', 'claude-sonnet-5')).toBe('max');
  });

  it('degrades xhigh to high on a model without xhigh support', () => {
    expect(resolveAnthropicEffort('xhigh', 'claude-opus-4-6')).toBe('high');
    expect(resolveAnthropicEffort('xhigh', 'claude-sonnet-4-6')).toBe('high');
  });

  it('exposes the documented capability table for a model without xhigh support', () => {
    expect(ANTHROPIC_EFFORT_SUPPORT['claude-opus-4-6']).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('returns undefined (omit the parameter) for a model with no effort support', () => {
    expect(resolveAnthropicEffort('low', 'claude-haiku-4-5')).toBeUndefined();
    expect(resolveAnthropicEffort('max', 'claude-haiku-4-5')).toBeUndefined();
  });

  it('returns undefined for an unrecognized model — conservative default', () => {
    expect(resolveAnthropicEffort('medium', 'claude-some-future-model')).toBeUndefined();
  });
});

describe('resolveOpenAIEffort', () => {
  it('passes low and medium through unchanged on a reasoning model', () => {
    expect(resolveOpenAIEffort('low', 'o3')).toBe('low');
    expect(resolveOpenAIEffort('medium', 'o3-mini')).toBe('medium');
  });

  it('clamps high, xhigh, and max down to high', () => {
    expect(resolveOpenAIEffort('high', 'o3')).toBe('high');
    expect(resolveOpenAIEffort('xhigh', 'o3')).toBe('high');
    expect(resolveOpenAIEffort('max', 'o4-mini')).toBe('high');
  });

  it('returns undefined (omit the parameter) for a non-reasoning model', () => {
    expect(resolveOpenAIEffort('low', 'gpt-4o')).toBeUndefined();
    expect(resolveOpenAIEffort('max', 'gpt-4.1-mini')).toBeUndefined();
  });

  it('agrees with the OPENAI_REASONING_MODELS set', () => {
    for (const model of OPENAI_REASONING_MODELS) {
      expect(resolveOpenAIEffort('low', model)).toBe('low');
    }
    expect(resolveOpenAIEffort('low', 'gpt-4o')).toBeUndefined();
  });
});

describe('resolveGeminiEffort', () => {
  it('maps every tier to a thinkingBudget on a thinking-capable model', () => {
    expect(resolveGeminiEffort('low', 'gemini-2.5-flash')).toEqual({
      effort: 'low',
      thinkingBudget: 1024,
    });
    expect(resolveGeminiEffort('max', 'gemini-2.5-pro')).toEqual({
      effort: 'max',
      thinkingBudget: -1,
    });
  });

  it('returns undefined (omit thinkingConfig) for a non-thinking model', () => {
    expect(resolveGeminiEffort('high', 'gemini-2.0-flash')).toBeUndefined();
  });

  it('agrees with the GEMINI_THINKING_MODELS set', () => {
    for (const model of GEMINI_THINKING_MODELS) {
      expect(resolveGeminiEffort('medium', model)).toBeDefined();
    }
    expect(resolveGeminiEffort('medium', 'gemini-2.0-flash')).toBeUndefined();
  });
});
