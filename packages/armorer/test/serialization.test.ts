import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  assertJsonValue,
  createRegistry,
  defineTool,
  type JsonValue,
  serializeRegistry,
  serializeToolDefinition,
  stableStringifyJson,
} from '../src/core';

describe('serialization', () => {
  const schema = z.object({
    query: z.string(),
    limit: z.number().optional(),
  });

  it('rejects non-JSON metadata with a precise path', () => {
    const tool = defineTool({
      name: 'bad-meta',
      description: 'bad metadata',
      input: schema,
      metadata: { when: new Date() } as unknown as Record<string, unknown>,
    });

    expect(() => serializeToolDefinition(tool)).toThrow(
      'Non-plain object is not valid JSON at metadata.when',
    );
  });

  it('rejects undefined values with a precise path', () => {
    const tool = defineTool({
      name: 'bad-undefined',
      description: 'bad undefined',
      input: schema,
      metadata: { nested: { value: undefined } } as unknown as Record<string, unknown>,
    });

    expect(() => serializeToolDefinition(tool)).toThrow(
      'Undefined is not valid JSON at metadata.nested.value',
    );
  });

  it('produces provider-neutral JSON schema output', () => {
    const tool = defineTool({
      name: 'search',
      description: 'search tool',
      input: schema,
    });
    const serialized = serializeToolDefinition(tool);

    expect(serialized.schemaVersion).toBe('2020-12');
    expect(serialized.input).toHaveProperty('type', 'object');
    expect((serialized.input as Record<string, unknown>).safeParse).toBeUndefined();
  });

  it('keeps serialized metadata deterministic', () => {
    const toolA = defineTool({
      name: 'sorted',
      description: 'sorted tool',
      input: schema,
      metadata: { z: 1, a: 2 },
    });
    const toolB = defineTool({
      name: 'sorted',
      description: 'sorted tool',
      input: schema,
      metadata: { a: 2, z: 1 },
    });

    const jsonA = stableStringifyJson(
      serializeToolDefinition(toolA) as unknown as JsonValue,
    );
    const jsonB = stableStringifyJson(
      serializeToolDefinition(toolB) as unknown as JsonValue,
    );

    expect(jsonA).toBe(jsonB);
  });

  it('serializes registry aliases in sorted order', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'alias-tool',
      description: 'alias tool',
      input: schema,
      version: '1.0.0',
    });
    registry.register(tool, {
      aliases: ['default:alias-b@1.0.0', 'default:alias-a@1.0.0'],
    });

    const serialized = serializeRegistry(registry);
    expect(serialized[0]?.aliases).toEqual([
      'default:alias-a@1.0.0',
      'default:alias-b@1.0.0',
    ]);
  });

  it('rejects non-JSON primitives and circular references', () => {
    expect(() => assertJsonValue({ value: Number.POSITIVE_INFINITY })).toThrow(
      'Non-finite number at metadata.value',
    );
    expect(() => assertJsonValue({ value: 10n })).toThrow(
      'BigInt is not valid JSON at metadata.value',
    );
    expect(() => assertJsonValue({ value: () => 'nope' })).toThrow(
      'Function is not valid JSON at metadata.value',
    );
    expect(() => assertJsonValue({ value: Symbol('nope') })).toThrow(
      'Symbol is not valid JSON at metadata.value',
    );

    const circularArray: unknown[] = [];
    circularArray.push(circularArray);
    expect(() => assertJsonValue(circularArray)).toThrow(
      'Circular reference detected at metadata[0]',
    );

    const circularObject: Record<string, unknown> = {};
    circularObject.self = circularObject;
    expect(() => assertJsonValue(circularObject)).toThrow(
      'Circular reference detected at metadata.self',
    );
  });
});
