import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AnyToolDefinition } from '../core';
import { defineTool, serializeToolDefinition } from '../core';
import {
  isSerializedToolDefinition,
  isSingleInput,
  isToolDefinition,
  normalizeToSerializedDefinitions,
} from './shared';

describe('shared adapter utilities', () => {
  const testSchema = z.object({ message: z.string() });
  const testTool = defineTool({
    name: 'test-tool',
    description: 'A test tool',
    input: testSchema,
  }) as AnyToolDefinition;

  const serializedTool = serializeToolDefinition(testTool);

  describe('isSerializedToolDefinition', () => {
    it('returns true for serialized tool definitions', () => {
      expect(isSerializedToolDefinition(serializedTool)).toBe(true);
    });

    it('returns false for tool definitions', () => {
      expect(isSerializedToolDefinition(testTool)).toBe(false);
    });
  });

  describe('isToolDefinition', () => {
    it('returns true for tool definitions', () => {
      expect(isToolDefinition(testTool)).toBe(true);
    });

    it('returns false for serialized tools', () => {
      expect(isToolDefinition(serializedTool)).toBe(false);
    });
  });

  describe('normalizeToSerializedDefinitions', () => {
    it('handles single tool definition', () => {
      const configurations = normalizeToSerializedDefinitions(serializedTool);
      expect(configurations).toHaveLength(1);
      expect(configurations[0]?.identity.name).toBe('test-tool');
    });

    it('handles single serialized tool', () => {
      const configurations = normalizeToSerializedDefinitions(serializedTool);
      expect(configurations).toHaveLength(1);
      expect(configurations[0]?.identity.name).toBe('test-tool');
    });

    it('handles array of tools', () => {
      const configurations = normalizeToSerializedDefinitions([serializedTool, serializedTool]);
      expect(configurations).toHaveLength(2);
    });

    it('handles array of serialized tools', () => {
      const configurations = normalizeToSerializedDefinitions([serializedTool, serializedTool]);
      expect(configurations).toHaveLength(2);
    });

    it('handles registry-like list()', () => {
      const registryLike = { list: () => [serializedTool] };
      const configurations = normalizeToSerializedDefinitions(registryLike);
      expect(configurations).toHaveLength(1);
      expect(configurations[0]?.identity.name).toBe('test-tool');
    });

    it('handles registry-like tools()', () => {
      const registryLike = { tools: () => [serializedTool] };
      const configurations = normalizeToSerializedDefinitions(registryLike);
      expect(configurations).toHaveLength(1);
      expect(configurations[0]?.identity.name).toBe('test-tool');
    });

    it('throws Error when registry list returns non-array', () => {
      const mockRegistry = {
        list: () => Promise.resolve([]),
      } as any;
      expect(() => normalizeToSerializedDefinitions(mockRegistry)).toThrow(
        'Registry tools() must return an array.',
      );
    });

    it('throws TypeError for invalid item in array', () => {
      const invalidItem = { notATool: true };
      expect(() => normalizeToSerializedDefinitions([invalidItem] as any)).toThrow(TypeError);
      expect(() => normalizeToSerializedDefinitions([invalidItem] as any)).toThrow(
        'Invalid tool input: expected ToolDefinition or SerializedToolDefinition',
      );
    });

    it('throws TypeError for completely invalid input', () => {
      const invalidInput = 'not a tool';
      expect(() => normalizeToSerializedDefinitions(invalidInput as any)).toThrow(TypeError);
      expect(() => normalizeToSerializedDefinitions(invalidInput as any)).toThrow(
        'Invalid tool input: expected ToolDefinition or SerializedToolDefinition',
      );
    });
  });

  describe('isSingleInput', () => {
    it('returns true for single tool', () => {
      expect(isSingleInput(serializedTool)).toBe(true);
    });

    it('returns true for single serialized tool', () => {
      expect(isSingleInput(serializedTool)).toBe(true);
    });

    it('returns false for array', () => {
      expect(isSingleInput([serializedTool])).toBe(false);
    });

    it('returns false for registry', () => {
      const registryLike = { list: () => [serializedTool] };
      expect(isSingleInput(registryLike)).toBe(false);
    });
  });
});
