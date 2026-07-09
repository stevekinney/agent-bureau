import { describe, expect, it } from 'bun:test';

import {
  ANTHROPIC_MODEL_ALIASES,
  GEMINI_MODEL_ALIASES,
  OPENAI_MODEL_ALIASES,
  resolveAnthropicModel,
  resolveGeminiModel,
  resolveOpenAIModel,
} from './model-registry.ts';

describe('resolveAnthropicModel', () => {
  it('resolves every documented alias', () => {
    for (const [alias, expected] of Object.entries(ANTHROPIC_MODEL_ALIASES)) {
      expect(resolveAnthropicModel(alias)).toBe(expected);
    }
  });

  it('passes an unrecognized string through unchanged', () => {
    expect(resolveAnthropicModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveAnthropicModel('some-custom-fine-tune')).toBe('some-custom-fine-tune');
  });

  it('never resolves inherit', () => {
    expect(resolveAnthropicModel('inherit')).toBe('inherit');
  });
});

describe('resolveOpenAIModel', () => {
  it('resolves every documented alias', () => {
    for (const [alias, expected] of Object.entries(OPENAI_MODEL_ALIASES)) {
      expect(resolveOpenAIModel(alias)).toBe(expected);
    }
  });

  it('passes an unrecognized string through unchanged', () => {
    expect(resolveOpenAIModel('gpt-4o')).toBe('gpt-4o');
  });

  it('never resolves inherit', () => {
    expect(resolveOpenAIModel('inherit')).toBe('inherit');
  });
});

describe('resolveGeminiModel', () => {
  it('resolves every documented alias', () => {
    for (const [alias, expected] of Object.entries(GEMINI_MODEL_ALIASES)) {
      expect(resolveGeminiModel(alias)).toBe(expected);
    }
  });

  it('passes an unrecognized string through unchanged', () => {
    expect(resolveGeminiModel('gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });

  it('never resolves inherit', () => {
    expect(resolveGeminiModel('inherit')).toBe('inherit');
  });
});
