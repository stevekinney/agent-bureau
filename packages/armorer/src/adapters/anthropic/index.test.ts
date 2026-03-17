import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AnyToolDefinition } from '../../core';
import { createRegistry, defineTool, serializeToolDefinition } from '../../core';
import {
  formatAnthropicToolResults,
  parseAnthropicToolCalls,
  toAnthropicTools,
} from './index';

describe('toAnthropicTools', () => {
  const schema = z.object({
    query: z.string().describe('Search query'),
    limit: z.number().optional().describe('Max results'),
  });

  const tool = defineTool({
    name: 'search',
    description: 'Search for items',
    input: schema,
  }) as AnyToolDefinition;

  const serializedTool = serializeToolDefinition(tool);

  describe('single tool conversion', () => {
    it('includes tool name', () => {
      const result = toAnthropicTools(serializedTool);
      expect(result.name).toBe('search');
    });

    it('includes tool description', () => {
      const result = toAnthropicTools(serializedTool);
      expect(result.description).toBe('Search for items');
    });

    it('includes input_schema with type object', () => {
      const result = toAnthropicTools(serializedTool);
      expect(result.input_schema.type).toBe('object');
    });

    it('includes properties in input_schema', () => {
      const result = toAnthropicTools(serializedTool);
      expect(result.input_schema.properties).toHaveProperty('query');
      expect(result.input_schema.properties).toHaveProperty('limit');
    });

    it('includes required fields', () => {
      const result = toAnthropicTools(serializedTool);
      expect(result.input_schema).toHaveProperty('required');
      expect(result.input_schema.required).toContain('query');
    });
  });

  describe('array conversion', () => {
    it('returns array for array input', () => {
      const result = toAnthropicTools([serializedTool, serializedTool]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it('returns array for empty array', () => {
      const result = toAnthropicTools([]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('registry conversion', () => {
    it('returns array for registry input', () => {
      const registry = createRegistry();
      registry.register(tool);
      const result = toAnthropicTools(registry);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it('returns empty array for empty registry', () => {
      const registry = createRegistry();
      const result = toAnthropicTools(registry);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('serialized tool conversion', () => {
    it('works with serialized tool definitions', () => {
      const serialized = serializeToolDefinition(tool);
      const result = toAnthropicTools(serialized);
      expect(result.name).toBe('search');
      expect(result.input_schema.type).toBe('object');
    });
  });
});

describe('parseAnthropicToolCalls', () => {
  it('parses tool use blocks', () => {
    expect(
      parseAnthropicToolCalls([
        { type: 'text', text: 'thinking' },
        {
          type: 'tool_use',
          id: 'toolu_123',
          name: 'search',
          input: { query: 'armorer' },
        },
      ]),
    ).toEqual([
      {
        id: 'toolu_123',
        name: 'search',
        arguments: { query: 'armorer' },
      },
    ]);
  });

  it('returns an empty array for missing content blocks', () => {
    expect(parseAnthropicToolCalls(undefined)).toEqual([]);
    expect(parseAnthropicToolCalls(null)).toEqual([]);
  });
});

describe('formatAnthropicToolResults', () => {
  it('formats success and error results', () => {
    expect(
      formatAnthropicToolResults([
        {
          callId: 'call-1',
          outcome: 'success',
          content: { ok: true },
          toolCallId: 'call-1',
          toolName: 'search',
          result: { ok: true },
        },
        {
          callId: 'call-2',
          outcome: 'error',
          content: { message: 'denied' },
          toolCallId: 'call-2',
          toolName: 'search',
          result: { message: 'denied' },
        },
      ]),
    ).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: '{"ok":true}',
      },
      {
        type: 'tool_result',
        tool_use_id: 'call-2',
        content: '{"message":"denied"}',
        is_error: true,
      },
    ]);
  });
});
