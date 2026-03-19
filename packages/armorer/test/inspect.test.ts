import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import {
  extractMetadataFlags,
  extractSchemaSummary,
  inspectRegistry,
  inspectTool,
  RegistryInspectionSchema,
  ToolInspectionSchema,
} from '../src/inspect';
import type { ToolConfiguration } from '../src/is-tool';

const makeConfiguration = (overrides?: Partial<ToolConfiguration>): ToolConfiguration => ({
  name: 'sum',
  description: 'add two numbers',
  input: z.object({ a: z.number(), b: z.number() }),
  tags: ['math'],
  async execute({ a, b }) {
    return a + b;
  },
  ...overrides,
});

describe('inspect', () => {
  describe('extractSchemaSummary', () => {
    it('extracts keys from a simple schema', () => {
      const schema = z.object({ a: z.number(), b: z.string() });
      const summary = extractSchemaSummary(schema);

      expect(summary.keys).toEqual(['a', 'b']);
      expect(summary.shape).toBeUndefined();
    });

    it('includes shape when requested', () => {
      const schema = z.object({ count: z.number(), name: z.string() });
      const summary = extractSchemaSummary(schema, true);

      expect(summary.keys).toEqual(['count', 'name']);
      expect(summary.shape).toBeDefined();
      expect(summary.shape?.count).toBe('number');
      expect(summary.shape?.name).toBe('string');
    });

    it('handles optional fields', () => {
      const schema = z.object({ required: z.string(), optional: z.string().optional() });
      const summary = extractSchemaSummary(schema, true);

      expect(summary.keys).toEqual(['required', 'optional']);
      expect(summary.shape?.required).toBe('string');
      expect(summary.shape?.optional).toBe('string?');
    });

    it('handles nullable fields', () => {
      const schema = z.object({ value: z.string().nullable() });
      const summary = extractSchemaSummary(schema, true);

      expect(summary.shape?.value).toBe('string | null');
    });

    it('handles default fields', () => {
      const schema = z.object({ value: z.string().default('hello') });
      const summary = extractSchemaSummary(schema, true);

      expect(summary.shape?.value).toBe('string');
    });

    it('returns empty keys for non-object schemas', () => {
      const schema = z.string();
      const summary = extractSchemaSummary(schema);

      expect(summary.keys).toEqual([]);
    });

    it('handles array fields', () => {
      const schema = z.object({ items: z.array(z.string()) });
      const summary = extractSchemaSummary(schema, true);

      expect(summary.keys).toEqual(['items']);
      // Array type should be detected
      expect(summary.shape?.items).toBeDefined();
    });

    it('handles enum fields', () => {
      const schema = z.object({ status: z.enum(['active', 'inactive']) });
      const summary = extractSchemaSummary(schema, true);

      expect(summary.keys).toEqual(['status']);
      expect(summary.shape?.status).toBeDefined();
    });

    it('handles non-standard field values (null shape entries)', () => {
      // Create a mock schema-like object with a null field entry
      const mockSchema = {
        _def: {
          shape: () => ({ field: null }),
        },
      };

      const summary = extractSchemaSummary(mockSchema as any, true);
      expect(summary.keys).toEqual(['field']);
      expect(summary.shape?.field).toBe('unknown');
    });

    it('handles object field values without type info', () => {
      // Create a mock schema-like object with non-schema object values
      const mockSchema = {
        _def: {
          shape: () => ({ field: {} }),
        },
      };

      const summary = extractSchemaSummary(mockSchema as any, true);
      expect(summary.keys).toEqual(['field']);
      expect(summary.shape?.field).toBe('unknown');
    });

    it('handles transform types', () => {
      const schema = z.object({
        value: z.string().transform((v) => v.toUpperCase()),
      });
      const summary = extractSchemaSummary(schema, true);

      expect(summary.keys).toEqual(['value']);
      // Transform wraps the inner type
      expect(summary.shape?.value).toBeDefined();
    });

    it('handles Zod 4 style wrapped types with generic format', () => {
      const innerSchema = {
        type: 'string',
        _def: {},
      };
      const mockZod4Catch = {
        type: 'catch',
        _def: {
          innerType: innerSchema,
        },
      };
      const mockObjectSchema = {
        _def: {
          shape: () => ({ field: mockZod4Catch }),
        },
      };

      const summary = extractSchemaSummary(mockObjectSchema as any, true);
      // Should return `catch<string>` format
      expect(summary.shape?.field).toBe('catch<string>');
    });
  });

  describe('extractMetadataFlags', () => {
    it('returns hasCustomMetadata: false for undefined metadata', () => {
      const flags = extractMetadataFlags(undefined);

      expect(flags.hasCustomMetadata).toBe(false);
      expect(flags.capabilities).toBeUndefined();
      expect(flags.effort).toBeUndefined();
    });

    it('returns hasCustomMetadata: false for empty metadata', () => {
      const flags = extractMetadataFlags({});

      expect(flags.hasCustomMetadata).toBe(false);
    });

    it('returns hasCustomMetadata: true when metadata has properties', () => {
      const flags = extractMetadataFlags({ foo: 'bar' });

      expect(flags.hasCustomMetadata).toBe(true);
    });

    it('extracts capabilities array when present', () => {
      const flags = extractMetadataFlags({ capabilities: ['read', 'write'] });

      expect(flags.capabilities).toEqual(['read', 'write']);
      expect(flags.hasCustomMetadata).toBe(true);
    });

    it('filters non-string capabilities', () => {
      const flags = extractMetadataFlags({
        capabilities: ['valid', 123, null, 'also-valid'],
      });

      expect(flags.capabilities).toEqual(['valid', 'also-valid']);
    });

    it('extracts string effort when present', () => {
      const flags = extractMetadataFlags({ effort: 'low' });

      expect(flags.effort).toBe('low');
    });

    it('extracts numeric effort when present', () => {
      const flags = extractMetadataFlags({ effort: 5 });

      expect(flags.effort).toBe(5);
    });

    it('ignores non-string/number effort', () => {
      const flags = extractMetadataFlags({ effort: { level: 'high' } });

      expect(flags.effort).toBeUndefined();
    });
  });

  describe('inspectTool', () => {
    it('returns tool inspection at standard detail level', () => {
      const tool = createTool({
        name: 'calculator',
        description: 'performs calculations',
        input: z.object({ a: z.number(), b: z.number() }),
        tags: ['math', 'utility'],
        async execute({ a, b }) {
          return a + b;
        },
      });

      const inspection = inspectTool(tool);

      expect(inspection.name).toBe('calculator');
      expect(inspection.description).toBe('performs calculations');
      expect(inspection.tags).toEqual(['math', 'utility']);
      expect(inspection.input?.keys).toEqual(['a', 'b']);
      expect(inspection.input?.shape).toBeUndefined();
      expect(inspection.metadata?.hasCustomMetadata).toBe(false);
    });

    it('returns tool inspection at full detail level', () => {
      const tool = createTool({
        name: 'calculator',
        description: 'performs calculations',
        input: z.object({ a: z.number(), b: z.number() }),
        tags: ['math'],
        async execute({ a, b }) {
          return a + b;
        },
      });

      const inspection = inspectTool(tool, 'full');

      expect(inspection.input?.shape).toBeDefined();
      expect(inspection.input?.shape?.a).toBe('number');
      expect(inspection.input?.shape?.b).toBe('number');
    });

    it('handles tools with metadata', () => {
      const tool = createTool({
        name: 'advanced-tool',
        description: 'a tool with metadata',
        input: z.object({ input: z.string() }),
        metadata: {
          capabilities: ['read', 'write'],
          effort: 'medium',
        },
        async execute({ input }) {
          return input;
        },
      });

      const inspection = inspectTool(tool);

      expect(inspection.metadata?.hasCustomMetadata).toBe(true);
      expect(inspection.metadata?.capabilities).toEqual(['read', 'write']);
      expect(inspection.metadata?.effort).toBe('medium');
    });

    it('handles tools without tags', () => {
      const tool = createTool({
        name: 'no-tags',
        description: 'a tool without tags',
        input: z.object({}),
        async execute() {
          return null;
        },
      });

      const inspection = inspectTool(tool);

      expect(inspection.tags).toEqual([]);
    });
  });

  describe('inspectRegistry', () => {
    it('returns empty inspection for empty registry', () => {
      const inspection = inspectRegistry([]);

      expect(inspection.detailLevel).toBe('standard');
      expect(inspection.counts.total).toBe(0);
      expect(inspection.counts.withTags).toBe(0);
      expect(inspection.counts.withMetadata).toBe(0);
      expect(inspection.tools).toEqual([]);
    });

    it('counts tools with tags correctly', () => {
      const tools = [
        createTool({
          name: 'with-tags',
          description: 'has tags',
          input: z.object({}),
          tags: ['tag1'],
          async execute() {},
        }),
        createTool({
          name: 'no-tags',
          description: 'no tags',
          input: z.object({}),
          async execute() {},
        }),
        createTool({
          name: 'more-tags',
          description: 'also has tags',
          input: z.object({}),
          tags: ['tag2', 'tag3'],
          async execute() {},
        }),
      ];

      const inspection = inspectRegistry(tools);

      expect(inspection.counts.total).toBe(3);
      expect(inspection.counts.withTags).toBe(2);
    });

    it('counts tools with metadata correctly', () => {
      const tools = [
        createTool({
          name: 'with-metadata',
          description: 'has metadata',
          input: z.object({}),
          metadata: { key: 'value' },
          async execute() {},
        }),
        createTool({
          name: 'no-metadata',
          description: 'no metadata',
          input: z.object({}),
          async execute() {},
        }),
      ];

      const inspection = inspectRegistry(tools);

      expect(inspection.counts.total).toBe(2);
      expect(inspection.counts.withMetadata).toBe(1);
    });

    it('respects detail level parameter', () => {
      const tools = [
        createTool({
          name: 'tool',
          description: 'a tool',
          input: z.object({ x: z.number() }),
          async execute() {},
        }),
      ];

      const summaryInspection = inspectRegistry(tools, 'summary');
      const standardInspection = inspectRegistry(tools, 'standard');
      const fullInspection = inspectRegistry(tools, 'full');

      // Summary level: only name, description, tags (no input or metadata)
      expect(summaryInspection.detailLevel).toBe('summary');
      expect(summaryInspection.tools[0]?.input).toBeUndefined();
      expect(summaryInspection.tools[0]?.metadata).toBeUndefined();

      // Standard level: includes input.keys and metadata, but not input.shape
      expect(standardInspection.detailLevel).toBe('standard');
      expect(standardInspection.tools[0]?.input).toBeDefined();
      expect(standardInspection.tools[0]?.input?.keys).toEqual(['x']);
      expect(standardInspection.tools[0]?.input?.shape).toBeUndefined();
      expect(standardInspection.tools[0]?.metadata).toBeDefined();

      // Full level: includes input.shape details
      expect(fullInspection.detailLevel).toBe('full');
      expect(fullInspection.tools[0]?.input?.shape).toBeDefined();
    });
  });

  describe('Toolbox.inspect()', () => {
    it('returns inspection of empty registry', () => {
      const toolbox = createToolbox();
      const inspection = toolbox.inspect();

      expect(inspection.counts.total).toBe(0);
      expect(inspection.tools).toEqual([]);
    });

    it('returns inspection of single-tool registry', () => {
      const toolbox = createToolbox([makeConfiguration()]);
      const inspection = toolbox.inspect();

      expect(inspection.counts.total).toBe(1);
      expect(inspection.tools[0]?.name).toBe('sum');
      expect(inspection.tools[0]?.description).toBe('add two numbers');
      expect(inspection.tools[0]?.tags).toEqual(['math']);
      expect(inspection.tools[0]?.input?.keys).toEqual(['a', 'b']);
    });

    it('returns inspection of multi-tool registry', () => {
      const toolbox = createToolbox([
        makeConfiguration({ name: 'sum', tags: ['math'] }),
        makeConfiguration({ name: 'greet', description: 'say hello', tags: ['text'] }),
        makeConfiguration({ name: 'plain', tags: undefined }),
      ]);
      const inspection = toolbox.inspect();

      expect(inspection.counts.total).toBe(3);
      expect(inspection.counts.withTags).toBe(2);
      expect(inspection.tools.map((t) => t.name).sort()).toEqual(['greet', 'plain', 'sum']);
    });

    it('supports summary detail level', () => {
      const toolbox = createToolbox([makeConfiguration()]);
      const inspection = toolbox.inspect('summary');

      expect(inspection.detailLevel).toBe('summary');
      // Summary level excludes input and metadata entirely
      expect(inspection.tools[0]?.input).toBeUndefined();
      expect(inspection.tools[0]?.metadata).toBeUndefined();
      // But still includes name, description, and tags
      expect(inspection.tools[0]?.name).toBe('sum');
      expect(inspection.tools[0]?.description).toBe('add two numbers');
      expect(inspection.tools[0]?.tags).toEqual(['math']);
    });

    it('supports standard detail level (default)', () => {
      const toolbox = createToolbox([makeConfiguration()]);
      const inspection = toolbox.inspect();

      expect(inspection.detailLevel).toBe('standard');
      // Standard level includes input.keys and metadata, but not input.shape
      expect(inspection.tools[0]?.input).toBeDefined();
      expect(inspection.tools[0]?.input?.keys).toEqual(['a', 'b']);
      expect(inspection.tools[0]?.input?.shape).toBeUndefined();
      expect(inspection.tools[0]?.metadata).toBeDefined();
    });

    it('supports full detail level', () => {
      const toolbox = createToolbox([makeConfiguration()]);
      const inspection = toolbox.inspect('full');

      expect(inspection.detailLevel).toBe('full');
      expect(inspection.tools[0]?.input?.shape).toBeDefined();
      expect(inspection.tools[0]?.input?.shape?.a).toBe('number');
    });

    it('is side-effect free (does not modify registry)', () => {
      const toolbox = createToolbox([makeConfiguration()]);

      const inspection1 = toolbox.inspect();
      const inspection2 = toolbox.inspect();

      expect(inspection1).toEqual(inspection2);
      expect(toolbox.tools().length).toBe(1);
    });

    it('returns independent copies (mutations do not affect registry)', () => {
      const toolbox = createToolbox([makeConfiguration()]);
      const inspection = toolbox.inspect();

      // Mutate the inspection
      inspection.tools[0]!.name = 'mutated';
      inspection.tools[0]!.tags.push('extra');

      // Re-inspect should show original data
      const freshInspection = toolbox.inspect();
      expect(freshInspection.tools[0]?.name).toBe('sum');
      expect(freshInspection.tools[0]?.tags).toEqual(['math']);
    });
  });

  describe('schema validation', () => {
    it('ToolInspectionSchema validates tool inspection output', () => {
      const tool = createTool({
        name: 'test',
        description: 'test tool',
        input: z.object({ x: z.number() }),
        tags: ['test'],
        async execute() {},
      });

      const inspection = inspectTool(tool);
      const result = ToolInspectionSchema.safeParse(inspection);

      expect(result.success).toBe(true);
    });

    it('RegistryInspectionSchema validates registry inspection output', () => {
      const toolbox = createToolbox([
        makeConfiguration({ name: 'tool1' }),
        makeConfiguration({ name: 'tool2', tags: ['tag1', 'tag2'] }),
      ]);

      const inspection = toolbox.inspect();
      const result = RegistryInspectionSchema.safeParse(inspection);

      expect(result.success).toBe(true);
    });

    it('RegistryInspectionSchema validates empty registry inspection', () => {
      const toolbox = createToolbox();
      const inspection = toolbox.inspect();
      const result = RegistryInspectionSchema.safeParse(inspection);

      expect(result.success).toBe(true);
    });

    it('RegistryInspectionSchema validates full detail level inspection', () => {
      const toolbox = createToolbox([makeConfiguration()]);
      const inspection = toolbox.inspect('full');
      const result = RegistryInspectionSchema.safeParse(inspection);

      expect(result.success).toBe(true);
    });
  });
});
