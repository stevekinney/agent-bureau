import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AnyToolDefinition } from '../../core';
import { createRegistry, defineTool, serializeToolDefinition } from '../../core';
import {
  formatGeminiToolResults,
  fromGeminiTools,
  parseGeminiToolCalls,
  toGeminiTools,
} from './index';

describe('toGeminiTools', () => {
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
    it('includes function name', () => {
      const result = toGeminiTools(serializedTool);
      expect(result[0]?.functionDeclarations[0]?.name).toBe('search');
    });

    it('includes function description', () => {
      const result = toGeminiTools(serializedTool);
      expect(result[0]?.functionDeclarations[0]?.description).toBe('Search for items');
    });

    it('includes parameters object', () => {
      const result = toGeminiTools(serializedTool);
      expect(result[0]?.functionDeclarations[0]?.parameters).toHaveProperty(
        'type',
        'object',
      );
      expect(result[0]?.functionDeclarations[0]?.parameters).toHaveProperty(
        'properties',
      );
    });

    it('includes required fields', () => {
      const result = toGeminiTools(serializedTool);
      expect(result[0]?.functionDeclarations[0]?.parameters).toHaveProperty('required');
      expect(result[0]?.functionDeclarations[0]?.parameters.required).toContain(
        'query',
      );
    });

    it('does not include $schema property', () => {
      const result = toGeminiTools(serializedTool);
      expect(result[0]?.functionDeclarations[0]?.parameters).not.toHaveProperty(
        '$schema',
      );
    });
  });

  describe('array conversion', () => {
    it('returns a single Gemini tool for array input', () => {
      const result = toGeminiTools([serializedTool, serializedTool]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]?.functionDeclarations).toHaveLength(2);
    });

    it('returns array for empty array', () => {
      const result = toGeminiTools([]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('registry conversion', () => {
    it('returns array for registry input', () => {
      const registry = createRegistry();
      registry.register(tool);
      const result = toGeminiTools(registry);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it('returns empty array for empty registry', () => {
      const registry = createRegistry();
      const result = toGeminiTools(registry);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('serialized tool conversion', () => {
    it('works with serialized tool definitions', () => {
      const serialized = serializeToolDefinition(tool);
      const result = toGeminiTools(serialized);
      expect(result[0]?.functionDeclarations[0]?.name).toBe('search');
      expect(result[0]?.functionDeclarations[0]?.parameters).toHaveProperty(
        'type',
        'object',
      );
    });
  });

  describe('usage pattern', () => {
    it('returns Gemini tools that are ready for the SDK', () => {
      const tools = toGeminiTools([tool]);

      expect(tools).toEqual([
        {
          functionDeclarations: [
            expect.objectContaining({
              name: 'search',
            }),
          ],
        },
      ]);
    });
  });
});

describe('parseGeminiToolCalls', () => {
  it('parses function call parts', () => {
    expect(
      parseGeminiToolCalls([
        { text: 'thinking' },
        { functionCall: { name: 'search', args: { query: 'gemini' } } },
      ]),
    ).toEqual([{ name: 'search', arguments: { query: 'gemini' } }]);
  });

  it('returns an empty array for missing parts', () => {
    expect(parseGeminiToolCalls(undefined)).toEqual([]);
    expect(parseGeminiToolCalls(null)).toEqual([]);
  });
});

describe('formatGeminiToolResults', () => {
  it('formats provider responses for success and action-required outcomes', () => {
    expect(
      formatGeminiToolResults([
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
          outcome: 'action_required',
          content: { prompt: 'approve' },
          toolCallId: 'call-2',
          toolName: 'approve',
          result: { prompt: 'approve' },
          action: { type: 'approval', message: 'Approve this request' },
        },
      ]),
    ).toEqual([
      {
        functionResponse: {
          name: 'search',
          response: { ok: true },
        },
      },
      {
        functionResponse: {
          name: 'approve',
          response: {
            outcome: 'action_required',
            content: { prompt: 'approve' },
            action: { type: 'approval', message: 'Approve this request' },
          },
        },
      },
    ]);
  });
});

describe('fromGeminiTools', () => {
  it('converts Gemini tools into imported tool configurations', () => {
    const imported = fromGeminiTools([
      {
        functionDeclarations: [
          {
            name: 'search',
            description: 'Search for items',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                includeArchived: { type: 'boolean', nullable: true },
              },
              required: ['query'],
            },
          },
        ],
      },
    ]);

    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe('search');
    expect(imported[0]?.input.safeParse({ query: 'gemini', includeArchived: null }).success).toBe(
      true,
    );
  });

  it('accepts direct function declaration input', () => {
    const imported = fromGeminiTools({
      name: 'lookup',
      description: 'Lookup',
      parameters: { type: 'object', properties: {} },
    });

    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe('lookup');
  });

  it('accepts direct function declaration arrays', () => {
    const imported = fromGeminiTools([
      {
        name: 'array-tool',
        description: 'Array input',
        parameters: { type: 'object', properties: {} },
      },
    ]);

    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe('array-tool');
  });

  it('accepts a single Gemini tool input', () => {
    const imported = fromGeminiTools({
      functionDeclarations: [
        {
          name: 'single-tool',
          description: 'Single tool import',
          parameters: { type: 'object', properties: {} },
        },
      ],
    });

    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe('single-tool');
  });
});
