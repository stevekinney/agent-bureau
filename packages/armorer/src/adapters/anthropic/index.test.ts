import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AnyToolDefinition } from '../../core';
import { createRegistry, defineTool, serializeToolDefinition } from '../../core';
import { toAnthropic } from './index';

describe('toAnthropic', () => {
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
      const result = toAnthropic(serializedTool);
      expect(result.name).toBe('search');
    });

    it('includes tool description', () => {
      const result = toAnthropic(serializedTool);
      expect(result.description).toBe('Search for items');
    });

    it('includes input_schema with type object', () => {
      const result = toAnthropic(serializedTool);
      expect(result.input_schema.type).toBe('object');
    });

    it('includes properties in input_schema', () => {
      const result = toAnthropic(serializedTool);
      expect(result.input_schema.properties).toHaveProperty('query');
      expect(result.input_schema.properties).toHaveProperty('limit');
    });

    it('includes required fields', () => {
      const result = toAnthropic(serializedTool);
      expect(result.input_schema).toHaveProperty('required');
      expect(result.input_schema.required).toContain('query');
    });
  });

  describe('array conversion', () => {
    it('returns array for array input', () => {
      const result = toAnthropic([serializedTool, serializedTool]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it('returns array for empty array', () => {
      const result = toAnthropic([]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('registry conversion', () => {
    it('returns array for registry input', () => {
      const registry = createRegistry();
      registry.register(tool);
      const result = toAnthropic(registry);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it('returns empty array for empty registry', () => {
      const registry = createRegistry();
      const result = toAnthropic(registry);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe('serialized tool conversion', () => {
    it('works with serialized tool definitions', () => {
      const serialized = serializeToolDefinition(tool);
      const result = toAnthropic(serialized);
      expect(result.name).toBe('search');
      expect(result.input_schema.type).toBe('object');
    });
  });
});
