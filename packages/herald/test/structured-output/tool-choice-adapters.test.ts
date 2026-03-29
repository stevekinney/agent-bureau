import { describe, expect, it } from 'bun:test';

import {
  toAnthropicToolChoice,
  toGeminiToolChoice,
  toOpenAIToolChoice,
} from '../../src/structured-output/tool-choice-adapters.ts';
import type { ToolChoice } from '../../src/structured-output/types.ts';

describe('toAnthropicToolChoice', () => {
  it('maps auto to { type: "auto" }', () => {
    expect(toAnthropicToolChoice('auto')).toEqual({ type: 'auto' });
  });

  it('maps required to { type: "any" }', () => {
    expect(toAnthropicToolChoice('required')).toEqual({ type: 'any' });
  });

  it('maps none to undefined', () => {
    expect(toAnthropicToolChoice('none')).toBeUndefined();
  });

  it('maps a specific tool to { type: "tool", name }', () => {
    const choice: ToolChoice = { tool: 'get_weather' };
    expect(toAnthropicToolChoice(choice)).toEqual({ type: 'tool', name: 'get_weather' });
  });
});

describe('toOpenAIToolChoice', () => {
  it('maps auto to "auto"', () => {
    expect(toOpenAIToolChoice('auto')).toBe('auto');
  });

  it('maps required to "required"', () => {
    expect(toOpenAIToolChoice('required')).toBe('required');
  });

  it('maps none to "none"', () => {
    expect(toOpenAIToolChoice('none')).toBe('none');
  });

  it('maps a specific tool to the function format', () => {
    const choice: ToolChoice = { tool: 'get_weather' };
    expect(toOpenAIToolChoice(choice)).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });
});

describe('toGeminiToolChoice', () => {
  it('maps auto to AUTO mode', () => {
    expect(toGeminiToolChoice('auto')).toEqual({
      function_calling_config: { mode: 'AUTO' },
    });
  });

  it('maps required to ANY mode', () => {
    expect(toGeminiToolChoice('required')).toEqual({
      function_calling_config: { mode: 'ANY' },
    });
  });

  it('maps none to NONE mode', () => {
    expect(toGeminiToolChoice('none')).toEqual({
      function_calling_config: { mode: 'NONE' },
    });
  });

  it('maps a specific tool to ANY mode with allowed_function_names', () => {
    const choice: ToolChoice = { tool: 'get_weather' };
    expect(toGeminiToolChoice(choice)).toEqual({
      function_calling_config: { mode: 'ANY', allowed_function_names: ['get_weather'] },
    });
  });
});
