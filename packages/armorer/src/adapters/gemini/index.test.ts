import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AnyToolDefinition } from '../../core';
import { createRegistry, defineTool, serializeToolDefinition } from '../../core';
import {
  formatGeminiToolResults,
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
