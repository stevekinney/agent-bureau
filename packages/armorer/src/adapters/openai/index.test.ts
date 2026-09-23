import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../../create-tool';
import { createToolbox } from '../../create-toolbox';
import { fromOpenAITools, parseOpenAIToolCalls, toOpenAITools } from './index';

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

  it('parses tool calls from OpenAI response envelope shapes', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: {
          name: 'tool1',
          arguments: '{"foo":"bar"}',
        },
      },
    ];

    expect(parseOpenAIToolCalls({ tool_calls: toolCalls })).toEqual([
      {
        id: 'call_1',
        name: 'tool1',
        arguments: { foo: 'bar' },
      },
    ]);
    expect(parseOpenAIToolCalls({ message: { tool_calls: toolCalls } })).toEqual([
      {
        id: 'call_1',
        name: 'tool1',
        arguments: { foo: 'bar' },
      },
    ]);
    expect(
      parseOpenAIToolCalls({
        choices: [{ message: { tool_calls: toolCalls } }],
      }),
    ).toEqual([
      {
        id: 'call_1',
        name: 'tool1',
        arguments: { foo: 'bar' },
      },
    ]);
  });

  it('returns an empty array for unsupported OpenAI envelope shapes', () => {
    expect(parseOpenAIToolCalls({ choices: undefined })).toEqual([]);
    expect(Reflect.apply(parseOpenAIToolCalls, undefined, [{ unrelated: true }])).toEqual([]);
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
