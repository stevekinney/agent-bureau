import { describe, expect, it } from 'bun:test';
import type { StandardSchemaV1 } from 'interoperability';
import { z } from 'zod';

import { createTool, createToolCall } from '../src';

/**
 * A minimal hand-rolled Standard Schema V1 validator (no vendor dependency
 * required — Valibot, ArkType, etc. all implement the same `~standard`
 * shape). Trims and uppercases the `name` field, so a successful parse
 * proves the validator's TRANSFORMED output — not the raw input — reaches
 * `execute()`.
 */
function greetingSchema(): StandardSchemaV1<unknown, { name: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        if (
          typeof value !== 'object' ||
          value === null ||
          typeof (value as Record<string, unknown>)['name'] !== 'string' ||
          (value as { name: string }).name.trim().length === 0
        ) {
          return { issues: [{ message: 'expected { name: non-empty string }' }] };
        }
        const name = (value as { name: string }).name.trim().toUpperCase();
        return { value: { name } };
      },
    },
  };
}

const greetingJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string' } },
};

describe('createTool with a non-Zod Standard Schema input', () => {
  it('throws at creation time when `inputSchema` is not supplied', () => {
    expect(() =>
      createTool({
        name: 'greet-missing-schema',
        description: 'Greets by name',
        input: greetingSchema(),
        execute: async (params: { name: string }) => `hello, ${params.name}`,
      }),
    ).toThrow('requires an explicit `inputSchema`');
  });

  it('NEUTER CHECK: a Zod input never trips the missing-inputSchema guard', () => {
    // Confirms the guard in create-tool.ts is gated on `isStandardSchema` +
    // `!isZodSchema`, not merely "non-undefined input" — a plain Zod schema
    // must never require `inputSchema`.
    expect(() =>
      createTool({
        name: 'greet-zod',
        description: 'Greets by name',
        input: z.object({ name: z.string() }),
        execute: async (params: { name: string }) => `hello, ${params.name}`,
      }),
    ).not.toThrow();
  });

  it('validates via `~standard.validate`, transforms the input, and executes with the transformed value', async () => {
    const tool = createTool({
      name: 'greet',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: greetingJsonSchema,
      execute: async (params: { name: string }) => `hello, ${params.name}`,
    });

    const result = await tool.execute(createToolCall('greet', { name: '  ada  ' }));
    expect(result.outcome).toBe('success');
    expect(result.result).toBe('hello, ADA');
  });

  it('rejects invalid input with a validate-error outcome', async () => {
    const tool = createTool({
      name: 'greet-invalid',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: greetingJsonSchema,
      execute: async (params: { name: string }) => `hello, ${params.name}`,
    });

    const result = await tool.execute(createToolCall('greet-invalid', { name: '' }));
    expect(result.outcome).toBe('error');
    expect(result.errorCategory).toBe('validation');
  });

  it('serializes using the caller-supplied `inputSchema`, not a derived Zod schema', () => {
    const tool = createTool({
      name: 'greet-serialize',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: greetingJsonSchema,
      execute: async (params: { name: string }) => `hello, ${params.name}`,
    });

    const serialized = tool.toJSON();
    expect(serialized.input).toEqual(greetingJsonSchema);
  });
});
