import { describe, expect, it } from 'bun:test';
import type { StandardSchemaV1 } from 'interoperability';

import { createTool, createToolbox } from '../src';

/** A minimal hand-rolled Standard Schema V1 validator — no vendor dependency required. */
function greetingSchema(): StandardSchemaV1<unknown, { name: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        const name = (value as { name?: unknown })?.name;
        if (typeof name !== 'string' || !name.trim()) {
          return { issues: [{ message: 'expected { name: non-empty string }' }] };
        }
        return { value: { name: name.trim().toUpperCase() } };
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

describe('createToolbox with a non-Zod Standard Schema tool', () => {
  it('registers a `createTool`-built Standard Schema tool without throwing', () => {
    // `createTool` normalizes the Standard Schema into a wrapped Zod pipe and
    // stores it on `tool.configuration.input`. `createToolbox([tool])` reads
    // that configuration back off the tool and re-normalizes it —
    // `normalizeSchema` must be idempotent for the already-wrapped pipe, or
    // this throws "Tool input must be a Zod object schema".
    const tool = createTool({
      name: 'greet-toolbox',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: greetingJsonSchema,
      execute: async (params: { name: string }) => `hello, ${params.name}`,
    });

    expect(() => createToolbox([tool])).not.toThrow();
  });

  it('NEUTER CHECK: the re-registered tool still validates and executes through the toolbox', async () => {
    const tool = createTool({
      name: 'greet-toolbox-exec',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: greetingJsonSchema,
      execute: async (params: { name: string }) => `hello, ${params.name}`,
    });

    const toolbox = createToolbox([tool]);

    const result = await toolbox.execute({
      id: 'call-1',
      name: 'greet-toolbox-exec',
      arguments: { name: '  ada  ' },
    });
    expect(result.outcome).toBe('success');
    expect(result.result).toBe('hello, ADA');
  });
});
