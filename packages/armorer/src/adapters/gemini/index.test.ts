import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AnyToolDefinition } from '../../core';
import { createRegistry, defineTool, serializeToolDefinition } from '../../core';
import { toGemini } from './index';

describe('toGemini', () => {
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
      const result = toGemini(serializedTool);
      expect(result.name).toBe('search');
    });

    it('includes function description', () => {
      const result = toGemini(serializedTool);
      expect(result.description).toBe('Search for items');
    });

    it('includes parameters object', () => {
      const result = toGemini(serializedTool);
      expect(result.parameters).toHaveProperty('type', 'object');
      expect(result.parameters).toHaveProperty('properties');
    });

    it('includes required fields', () => {
      const result = toGemini(serializedTool);
      expect(result.parameters).toHaveProperty('required');
      expect(result.parameters.required).toContain('query');
    });

    it('does not include $schema property', () => {
      const result = toGemini(serializedTool);
      expect(result.parameters).not.toHaveProperty('$schema');
    });
  });

  describe('array conversion', () => {
    it('returns array for array input', () => {
      const result = toGemini([serializedTool, serializedTool]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it('returns array for empty array', () => {
      const result = toGemini([]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('registry conversion', () => {
    it('returns array for registry input', () => {
      const registry = createRegistry();
      registry.register(tool);
      const result = toGemini(registry);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it('returns empty array for empty registry', () => {
      const registry = createRegistry();
      const result = toGemini(registry);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('serialized tool conversion', () => {
    it('works with serialized tool definitions', () => {
      const serialized = serializeToolDefinition(tool);
      const result = toGemini(serialized);
      expect(result.name).toBe('search');
      expect(result.parameters).toHaveProperty('type', 'object');
    });
  });

  describe('usage pattern', () => {
    it('can be wrapped in functionDeclarations', () => {
      const declarations = toGemini([tool]);
      const geminiTool = { functionDeclarations: declarations };

      expect(geminiTool.functionDeclarations).toHaveLength(1);
      expect(geminiTool.functionDeclarations[0]?.name).toBe('search');
    });
  });
});
