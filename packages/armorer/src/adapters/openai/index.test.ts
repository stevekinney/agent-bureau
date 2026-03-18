import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../../create-tool';
import { createToolbox } from '../../create-toolbox';
import {
  formatOpenAIToolResults,
  formatOpenAIToolResultsAsync,
  fromOpenAITools,
  parseOpenAIToolCalls,
  toOpenAITools,
} from './index';

describe('toOpenAITools', () => {
  const tool = createTool({
    name: 'test-tool',
    description: 'A test tool',
    input: z.object({
      query: z.string().describe('Search query'),
      limit: z.number().optional().describe('Max results'),
    }),
    execute: async (params) => params,
  });

  describe('single tool conversion', () => {
    const openAI = toOpenAITools(tool);

    it('returns correct type', () => {
      expect(openAI.type).toBe('function');
    });

    it('includes function name', () => {
      expect(openAI.function.name).toBe('test-tool');
    });

    it('includes function description', () => {
      expect(openAI.function.description).toBe('A test tool');
    });

    it('includes strict mode', () => {
      expect(openAI.function.strict).toBe(true);
    });

    it('includes parameters object', () => {
      expect(openAI.function.parameters).toHaveProperty('type', 'object');
      expect(openAI.function.parameters).toHaveProperty('properties');
    });

    it('includes required fields', () => {
      expect(openAI.function.parameters.required).toContain('query');
    });
  });

  describe('array conversion', () => {
    it('returns array for array input', () => {
      const openAI = toOpenAITools([tool]);
      expect(Array.isArray(openAI)).toBe(true);
      expect(openAI).toHaveLength(1);
    });

    it('returns array for empty array', () => {
      const openAI = toOpenAITools([]);
      expect(Array.isArray(openAI)).toBe(true);
      expect(openAI).toHaveLength(0);
    });
  });

  describe('registry conversion', () => {
    it('returns array for registry input', () => {
      const toolbox = createToolbox([tool]);
      const openAI = toOpenAITools(toolbox);
      expect(Array.isArray(openAI)).toBe(true);
      expect(openAI).toHaveLength(1);
      expect(openAI[0]?.function.name).toBe('test-tool');
    });

    it('returns empty array for empty registry', () => {
      const toolbox = createToolbox();
      const openAI = toOpenAITools(toolbox);
      expect(Array.isArray(openAI)).toBe(true);
      expect(openAI).toHaveLength(0);
    });
  });
});

describe('parseOpenAIToolCalls', () => {
  it('returns an empty array when tool calls are missing', () => {
    expect(parseOpenAIToolCalls(undefined)).toEqual([]);
    expect(parseOpenAIToolCalls(null)).toEqual([]);
  });

  it('parses valid tool calls', () => {
    const calls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: {
          name: 'tool1',
          arguments: '{"foo": "bar"}',
        },
      },
    ];
    const parsed = parseOpenAIToolCalls(calls);
    expect(parsed).toEqual([
      {
        id: 'call_1',
        name: 'tool1',
        arguments: { foo: 'bar' },
      },
    ]);
  });

  it('handles invalid JSON arguments', () => {
    const calls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: {
          name: 'tool1',
          arguments: '{invalid}',
        },
      },
    ];
    const parsed = parseOpenAIToolCalls(calls);
    expect(parsed).toEqual([
      {
        id: 'call_1',
        name: 'tool1',
        arguments: {},
      },
    ]);
  });
});

describe('fromOpenAITools', () => {
  it('converts provider tools into imported tool configurations', () => {
    const imported = fromOpenAITools({
      type: 'function',
      function: {
        name: 'search-documents',
        description: 'Searches documents',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Query text' },
            limit: { type: 'integer', default: 5 },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    });

    expect(imported.name).toBe('search-documents');
    expect(imported.description).toBe('Searches documents');
    const parsed = imported.input.safeParse({ query: 'armorer' });
    expect(parsed.success).toBe(true);
    expect(imported.input.safeParse({}).success).toBe(false);
    expect(imported.input.safeParse({ query: 'armorer', extra: true }).success).toBe(false);
  });

  it('returns arrays for array input', () => {
    const imported = fromOpenAITools([
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Lookup',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);

    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe('lookup');
  });
});

describe('formatOpenAIToolResults', () => {
  it('formats single result', () => {
    const result = {
      callId: 'call_1',
      outcome: 'success' as const,
      content: 'result',
      toolCallId: 'call_1',
      toolName: 'tool1',
      result: 'result',
    };
    const messages = formatOpenAIToolResults(result);
    expect(messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'result',
      },
    ]);
  });

  it('formats multiple results', () => {
    const results = [
      {
        callId: 'call_1',
        outcome: 'success' as const,
        content: 'result1',
        toolCallId: 'call_1',
        toolName: 'tool1',
        result: 'result1',
      },
      {
        callId: 'call_2',
        outcome: 'success' as const,
        content: { foo: 'bar' },
        toolCallId: 'call_2',
        toolName: 'tool2',
        result: { foo: 'bar' },
      },
    ];
    const messages = formatOpenAIToolResults(results);
    expect(messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'result1',
      },
      {
        role: 'tool',
        tool_call_id: 'call_2',
        content: '{"foo":"bar"}',
      },
    ]);
  });

  it('throws for streaming results', () => {
    const result = {
      callId: 'call_1',
      outcome: 'success' as const,
      content: '[stream]',
      toolCallId: 'call_1',
      toolName: 'tool1',
      result: {
        async *[Symbol.asyncIterator]() {
          yield 'a';
        },
      },
      stream: {
        async *[Symbol.asyncIterator]() {
          yield 'a';
        },
      },
    };

    expect(() => formatOpenAIToolResults(result)).toThrow(
      'formatOpenAIToolResults does not support streaming results. Use formatOpenAIToolResultsAsync or execute without { stream: true }.',
    );
  });
});

describe('formatOpenAIToolResultsAsync', () => {
  it('formats non-streaming results without collection', async () => {
    const result = {
      callId: 'call_plain',
      outcome: 'success' as const,
      content: { ok: true },
      toolCallId: 'call_plain',
      toolName: 'tool-plain',
      result: { ok: true },
    };

    const messages = await formatOpenAIToolResultsAsync(result as any);
    expect(messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_plain',
        content: '{"ok":true}',
      },
    ]);
  });

  it('formats streaming results by collecting chunks', async () => {
    const result = {
      callId: 'call_1',
      outcome: 'success' as const,
      content: '[stream]',
      toolCallId: 'call_1',
      toolName: 'tool1',
      result: {
        async *[Symbol.asyncIterator]() {
          yield { token: 'a' };
          yield { token: 'b' };
        },
      },
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { token: 'a' };
          yield { token: 'b' };
        },
      },
    };

    const messages = await formatOpenAIToolResultsAsync(result as any);
    expect(messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '[{"token":"a"},{"token":"b"}]',
      },
    ]);
  });

  it('collects chunks from result when stream handle is absent', async () => {
    const result = {
      callId: 'call_2',
      outcome: 'success' as const,
      content: '[stream]',
      toolCallId: 'call_2',
      toolName: 'tool2',
      result: {
        async *[Symbol.asyncIterator]() {
          yield 'x';
          yield 'y';
        },
      },
    };

    const messages = await formatOpenAIToolResultsAsync(result as any);
    expect(messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_2',
        content: '["x","y"]',
      },
    ]);
  });
});
