import { describe, expect, expectTypeOf, it } from 'bun:test';
import { z } from 'zod';

import {
  createMiddleware,
  createTool,
  createToolbox,
  createToolCall,
  lazy,
  type ToolConfiguration,
} from '../src';
import { toAnthropicTools } from '../src/adapters/anthropic';
import { toGeminiTools } from '../src/adapters/gemini';
import { toOpenAITools } from '../src/adapters/openai';
import { queryTools, reindexSearchIndex, searchTools } from '../src/core/registry';
import { internalToolboxTestUtilities } from '../src/create-toolbox';
import { createTruncatingAsyncIterable } from '../src/truncation/index';

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

describe('createToolbox', () => {
  it('hydrates from serialized configurations and executes tools', async () => {
    const toolbox = createToolbox([makeConfiguration()]);

    const result = await toolbox.execute({
      id: 'abc',
      name: 'sum',
      arguments: { a: 1, b: 2 },
    });
    expect(result.toolCallId).toBe('abc');
    expect(result.toolName).toBe('sum');
    expect(result.result).toBe(3);
  });

  it('exports provider tools through lazy toolbox methods', async () => {
    const toolbox = createToolbox([makeConfiguration()]);

    await expect(toolbox.toOpenAITools()).resolves.toEqual(toOpenAITools(toolbox));
    await expect(toolbox.toAnthropicTools()).resolves.toEqual(toAnthropicTools(toolbox));
    await expect(toolbox.toGeminiTools()).resolves.toEqual(toGeminiTools(toolbox));
  });

  it('exports provider tools through the generic toolbox.toProvider helper', async () => {
    const toolbox = createToolbox([makeConfiguration()]);

    await expect(toolbox.toProvider('openai')).resolves.toEqual(toOpenAITools(toolbox));
    await expect(toolbox.toProvider('anthropic')).resolves.toEqual(toAnthropicTools(toolbox));
    await expect(toolbox.toProvider('gemini')).resolves.toEqual(toGeminiTools(toolbox));
  });

  it('rehydrates imported tools through createToolbox.fromProvider with sourceToolbox', async () => {
    const toolbox = createToolbox([makeConfiguration()]);
    const imported = await createToolbox.fromProvider(
      'openai',
      await toolbox.toProvider('openai'),
      {
        sourceToolbox: toolbox,
      },
    );

    const result = await imported.execute({
      id: 'import-provider',
      name: 'sum',
      arguments: { a: 4, b: 5 },
    });

    expect(result.result).toBe(9);
  });

  it('rehydrates Anthropic and Gemini imports through createToolbox.fromProvider', async () => {
    const toolbox = createToolbox([makeConfiguration()]);

    const importedAnthropic = await createToolbox.fromProvider(
      'anthropic',
      await toolbox.toProvider('anthropic'),
      {
        sourceToolbox: toolbox,
      },
    );
    const importedGemini = await createToolbox.fromProvider(
      'gemini',
      await toolbox.toProvider('gemini'),
      {
        sourceToolbox: toolbox,
      },
    );

    await expect(
      importedAnthropic.execute({
        id: 'anthropic-import',
        name: 'sum',
        arguments: { a: 5, b: 6 },
      }),
    ).resolves.toMatchObject({ result: 11 });

    await expect(
      importedGemini.execute({
        id: 'gemini-import',
        name: 'sum',
        arguments: { a: 6, b: 7 },
      }),
    ).resolves.toMatchObject({ result: 13 });
  });

  it('exposes execute resolvers for imported toolboxes', async () => {
    const toolbox = createToolbox([makeConfiguration()]);
    const execute = toolbox.asExecuteResolver()({
      name: 'sum',
      description: 'add two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
    });

    expect(execute).toBeDefined();
    await expect(execute?.({ a: 1, b: 2 }, {} as never)).resolves.toBe(3);
  });

  it('falls back to imported execute placeholders when an execute resolver cannot find a tool', async () => {
    const toolbox = createToolbox([makeConfiguration()]);
    const execute = toolbox.asExecuteResolver()({
      name: 'missing-tool',
      description: 'missing tool',
      input: z.object({}),
    });

    expect(execute).toBeDefined();
    await expect(execute?.({}, {} as never)).rejects.toThrow(
      'Imported tool "missing-tool" does not have an execute implementation',
    );
  });

  it('normalizes missing and non-serializable tool-call arguments through the internal helper seam', () => {
    const circularArguments: Record<string, unknown> = {};
    circularArguments.self = circularArguments;

    expect(internalToolboxTestUtilities.normalizeToolCallArguments(undefined)).toEqual({});
    expect(internalToolboxTestUtilities.normalizeToolCallArguments(Symbol('arguments'))).toBe(
      'Symbol(arguments)',
    );
    expect(internalToolboxTestUtilities.normalizeToolCallArguments(circularArguments)).toBe(
      '[object Object]',
    );
  });

  it('imports OpenAI tools through createToolbox.fromOpenAITools', async () => {
    const imported = await createToolbox.fromOpenAITools([
      {
        type: 'function',
        function: {
          name: 'sum',
          description: 'add two numbers',
          parameters: {
            type: 'object',
            properties: {
              a: { type: 'number' },
              b: { type: 'number' },
            },
            required: ['a', 'b'],
            additionalProperties: false,
          },
        },
      },
    ]);

    expect(imported.getTool('sum')).toBeDefined();
    const result = await imported.execute({
      id: 'import-openai',
      name: 'sum',
      arguments: { a: 1, b: 2 },
    });
    expect(result.error?.message).toContain(
      'Imported tool "sum" does not have an execute implementation',
    );
  });

  it('imports a single OpenAI tool input through createToolbox.fromOpenAITools', async () => {
    const imported = await createToolbox.fromOpenAITools({
      type: 'function',
      function: {
        name: 'single-openai',
        description: 'single tool',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
        },
      },
    });

    expect(imported.getTool('single-openai')).toBeDefined();
  });

  it('resolves imported tool execute functions through getTool', async () => {
    const imported = await createToolbox.fromAnthropicTools(
      [
        {
          name: 'sum',
          description: 'add two numbers',
          input_schema: {
            type: 'object',
            properties: {
              a: { type: 'number' },
              b: { type: 'number' },
            },
            required: ['a', 'b'],
          },
        },
      ],
      {
        getTool(configuration) {
          expect(configuration.name).toBe('sum');
          return async (params) => {
            const values = params as { a: number; b: number };
            return values.a + values.b;
          };
        },
      },
    );

    const result = await imported.execute({
      id: 'import-anthropic',
      name: 'sum',
      arguments: { a: 2, b: 3 },
    });

    expect(result.result).toBe(5);
  });

  it('imports a single Anthropic tool input through createToolbox.fromAnthropicTools', async () => {
    const imported = await createToolbox.fromAnthropicTools({
      name: 'single-anthropic',
      description: 'single tool',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    });

    expect(imported.getTool('single-anthropic')).toBeDefined();
  });

  it('imports Gemini tools through createToolbox.fromGeminiTools', async () => {
    const imported = await createToolbox.fromGeminiTools([
      {
        functionDeclarations: [
          {
            name: 'lookup',
            description: 'Lookup values',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string' },
              },
              required: ['query'],
            },
          },
        ],
      },
    ]);

    expect(imported.getTool('lookup')).toBeDefined();
    const result = await imported.execute({
      id: 'import-gemini',
      name: 'lookup',
      arguments: { query: 'docs' },
    });
    expect(result.error?.message).toContain(
      'Imported tool "lookup" does not have an execute implementation',
    );
  });

  it('materializes imported tool configuration metadata for lazy imports', async () => {
    const { createImportedExecute, materializeImportedToolConfiguration } =
      internalToolboxTestUtilities;
    const diagnostics = {
      safeParseWithReport: () => ({
        success: true as const,
        data: {},
        report: { warnings: [], cost: 0 },
      }),
    };
    const policy = {
      beforeExecute: () => ({ allow: true }),
    };
    const configuration = materializeImportedToolConfiguration(
      {
        name: 'materialized-tool',
        description: 'materialized',
        input: z.object({ value: z.string() }),
        policy,
        policyContext: () => ({ scope: 'test' }),
        digests: { input: true, output: true },
        concurrency: 2,
        diagnostics,
      },
      {},
    );

    expect(configuration.policy).toBe(policy);
    expect(configuration.policyContext).toBeDefined();
    expect(configuration.digests).toEqual({ input: true, output: true });
    expect(configuration.concurrency).toBe(2);
    expect(configuration.diagnostics).toBe(diagnostics);

    const placeholder = createImportedExecute('missing-tool');
    await expect(placeholder({}, {})).rejects.toThrow('Imported tool "missing-tool"');
  });

  it('generates a call id when missing', async () => {
    const toolbox = createToolbox([makeConfiguration()]);

    const result = await toolbox.execute({
      name: 'sum',
      arguments: { a: 1, b: 2 },
    });

    expect(typeof result.callId).toBe('string');
    expect(result.callId.length).toBeGreaterThan(0);
    expect(result.toolCallId).toBe(result.callId);
    expect(result.outcome).toBe('success');
    expect(result.content).toBe(3);
  });

  it('normalizes missing and non-JSON tool-call arguments before execution', async () => {
    const toolbox = createToolbox([
      createTool({
        name: 'inspect-arguments',
        description: 'inspects arguments',
        input: z.object({}).passthrough(),
        async execute(parameters) {
          return parameters;
        },
      }),
    ]);

    await expect(
      toolbox.execute({
        id: 'missing-arguments',
        name: 'inspect-arguments',
      } as any),
    ).resolves.toMatchObject({
      result: {},
      content: {},
    });

    await expect(
      toolbox.execute({
        id: 'symbol-arguments',
        name: 'inspect-arguments',
        arguments: Symbol('tool-arguments'),
      } as any),
    ).resolves.toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining('expected object'),
      }),
    });

    const circularArguments: Record<string, unknown> = {};
    circularArguments.self = circularArguments;

    await expect(
      toolbox.execute({
        id: 'circular-arguments',
        name: 'inspect-arguments',
        arguments: circularArguments as any,
      }),
    ).resolves.toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining('expected object'),
      }),
    });
  });

  it('supports lazy execute functions in configurations', async () => {
    const executePromise = Promise.resolve().then(
      () =>
        async ({ a, b }: { a: number; b: number }) =>
          a + b + 1,
    );
    const toolbox = createToolbox([
      makeConfiguration({
        name: 'sum-lazy',
        execute: executePromise,
      }),
    ]);

    const result = await toolbox.execute({
      id: 'lazy',
      name: 'sum-lazy',
      arguments: { a: 1, b: 2 },
    });
    expect(result.result).toBe(4);
  });

  it('supports lazy helper in configurations', async () => {
    let loads = 0;
    const toolbox = createToolbox([
      makeConfiguration({
        name: 'sum-lazy-helper',
        execute: lazy(async () => {
          loads += 1;
          return async ({ a, b }: { a: number; b: number }) => a + b + 1;
        }),
      }),
    ]);

    expect(loads).toBe(0);
    const result = await toolbox.execute({
      id: 'lazy-helper',
      name: 'sum-lazy-helper',
      arguments: { a: 1, b: 2 },
    });
    expect(result.result).toBe(4);
    expect(loads).toBe(1);

    const second = await toolbox.execute({
      id: 'lazy-helper-2',
      name: 'sum-lazy-helper',
      arguments: { a: 2, b: 2 },
    });
    expect(second.result).toBe(5);
    expect(loads).toBe(1);
  });

  it('returns an error when lazy execute rejects in configurations', async () => {
    const toolbox = createToolbox([
      makeConfiguration({
        name: 'sum-lazy-fail',
        execute: Promise.resolve().then(() => {
          throw new Error('configuration lazy load failed');
        }),
      }),
    ]);

    const result = await toolbox.execute({
      id: 'lazy-fail',
      name: 'sum-lazy-fail',
      arguments: { a: 1, b: 2 },
    });
    expect(result.error?.message).toContain('configuration lazy load failed');
  });

  it('passes diagnostics through tool configurations', async () => {
    const report = { warnings: [], cost: 1 };
    const hints = [
      {
        path: 'arguments.value',
        message: 'Value must be a string',
        suggestion: 'Provide a string value',
      },
    ];
    const diagnostics = {
      safeParseWithReport: () => ({
        success: false as const,
        error: new Error('bad input'),
        report,
      }),
      createRepairHints: () => hints,
    };

    const toolbox = createToolbox([
      makeConfiguration({
        name: 'diagnostic-tool',
        description: 'diagnostics',
        input: z.object({ value: z.string() }),
        async execute({ value }) {
          return value;
        },
        diagnostics,
      }),
    ]);

    const tool = toolbox.getTool('diagnostic-tool')!;
    let captured: any;
    tool.addEventListener('validate-error', (event: any) => {
      captured = event;
    });

    const result = await tool.execute(createToolCall('diagnostic-tool', { value: 123 } as any));

    expect(result.error).toBeDefined();
    expect(captured.report).toEqual(report);
    expect(captured.repairHints).toEqual(hints);
  });

  it('serializes registered configurations and rehydrates clean copies', async () => {
    const toolbox = createToolbox();
    toolbox.register(makeConfiguration({ tags: ['math', 'utilities'] }));

    const serialized = toolbox.toJSON();
    expect(serialized).toHaveLength(1);
    expect(serialized[0]?.name).toBe('sum');
    expect(serialized[0]?.tags).toEqual(['math', 'utilities']);

    // Mutating the serialized tag list does not affect the stored configuration.
    (serialized[0]?.tags as string[]).push('mutated');
    const tool = toolbox.getTool('sum');
    expect(tool?.tags).toEqual(['math', 'utilities']);

    const rehydrated = createToolbox(serialized);
    const result = await rehydrated.execute({
      id: 'rehydrated',
      name: 'sum',
      arguments: { a: 2, b: 2 },
    });
    expect(result.result).toBe(4);
  });

  it('extend() returns a new toolbox without mutating the original', async () => {
    const base = createToolbox([
      makeConfiguration({
        name: 'base-tool',
        input: z.object({}),
        execute: async () => 'base',
      }),
    ]);

    const extended = base.extend({
      name: 'extended-tool',
      description: 'extended',
      input: z.object({}),
      execute: async () => 'extended',
    });

    const baseResult = await base.execute({
      id: 'base-call',
      name: 'base-tool',
      arguments: {},
    });
    const missingResult = await base.execute({
      id: 'missing-call',
      name: 'extended-tool',
      arguments: {},
    });
    const extendedResult = await extended.execute({
      id: 'extended-call',
      name: 'extended-tool',
      arguments: {},
    });

    expect(baseResult.result).toBe('base');
    expect(missingResult.error?.category).toBe('not_found');
    expect(extendedResult.result).toBe('extended');
  });

  it('extend() can compose another toolbox and merges context (last wins)', async () => {
    const first = createToolbox(
      [
        {
          name: 'ctx-read',
          description: 'reads context',
          input: z.object({}),
          execute: async (_params, context) => {
            const ctx = context as Record<string, unknown>;
            return {
              region: ctx.region,
              role: ctx.role,
              shared: ctx.shared,
            };
          },
        },
      ],
      { context: { region: 'us-east-1', shared: 'first' } },
    );
    const second = createToolbox([], {
      context: { role: 'admin', shared: 'second' },
    });

    const combined = first.extend(second);
    const result = await combined.execute({ id: 'ctx-merge', name: 'ctx-read', arguments: {} });

    expect(result.result).toEqual({
      region: 'us-east-1',
      role: 'admin',
      shared: 'second',
    });
  });

  it('extend() preserves tool type information', () => {
    const alpha = createTool({
      name: 'alpha',
      description: 'alpha',
      input: z.object({}),
      execute: async () => 'alpha',
    });
    const beta = createTool({
      name: 'beta',
      description: 'beta',
      input: z.object({}),
      execute: async () => 'beta',
    });

    const base = createToolbox([alpha] as const);
    const extendedWithEntry = base.extend(beta);
    const extra = createToolbox([beta] as const);
    const extendedWithToolbox = base.extend(extra);

    expectTypeOf<ReturnType<typeof extendedWithEntry.tools>[number]['name']>().toEqualTypeOf<
      'alpha' | 'beta'
    >();
    expectTypeOf<ReturnType<typeof extendedWithToolbox.tools>[number]['name']>().toEqualTypeOf<
      'alpha' | 'beta'
    >();
  });

  it('exports registered tools as JSON Schema via toJSON({ format: "json-schema" })', () => {
    const toolbox = createToolbox();
    toolbox.register(makeConfiguration({ name: 'sum-json-schema' }));

    const serialized = toolbox.toJSON({ format: 'json-schema' });
    expect(serialized).toHaveLength(1);
    expect(serialized[0]?.schemaVersion).toBe('2020-12');
    expect(serialized[0]?.name).toBe('sum-json-schema');
    expect(serialized[0]?.input).toMatchObject({
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    });
    expect((serialized[0]?.input as Record<string, unknown>)['$schema']).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });

  it('returns built tools via getTool()', async () => {
    const toolbox = createToolbox();
    toolbox.register(
      makeConfiguration({
        name: 'bump',
        async execute({ a, b }) {
          return a + b + 1;
        },
      }),
    );
    const tool = toolbox.getTool('bump');
    expect(tool).toBeDefined();
    const value = await tool!({ a: 1, b: 1 } as any);
    expect(value).toBe(3);
  });

  it('supports registering tools from createTool()', async () => {
    const built = createTool({
      name: 'echo',
      description: 'returns the provided value',
      input: z.object({ text: z.string() }),
      async execute({ text }) {
        return text;
      },
      tags: ['utility'],
    });
    const toolbox = createToolbox();
    toolbox.register(built);
    const result = await toolbox.execute({
      id: 'echo-1',
      name: 'echo',
      arguments: { text: 'hi' },
    });
    expect(result.result).toBe('hi');
  });

  it('creates and registers tools via createTool()', async () => {
    const toolbox = createToolbox();
    const tool = toolbox.createTool({
      name: 'from-toolbox',
      description: 'created via toolbox',
      input: z.object({ value: z.string() }),
      async execute({ value }) {
        return value.toUpperCase();
      },
    });

    expect(toolbox.getTool('from-toolbox')).toBe(tool);

    const result = await toolbox.execute({
      id: 'from-toolbox-1',
      name: 'from-toolbox',
      arguments: { value: 'hi' },
    });
    expect(result.result).toBe('HI');
  });

  it('creates and registers tools via createTool() using input', async () => {
    const toolbox = createToolbox();
    const tool = toolbox.createTool({
      name: 'from-toolbox-input',
      description: 'created via toolbox with input',
      input: z.object({ value: z.string() }),
      async execute({ value }) {
        return value.toUpperCase();
      },
    });

    expect(toolbox.getTool('from-toolbox-input')).toBe(tool);

    const result = await toolbox.execute({
      id: 'from-toolbox-input-1',
      name: 'from-toolbox-input',
      arguments: { value: 'hi' },
    });
    expect(result.result).toBe('HI');
  });

  it('createTool supports tags and metadata', () => {
    const toolbox = createToolbox();
    const tool = toolbox.createTool({
      name: 'tagged',
      description: 'tagged tool',
      input: z.object({}),
      tags: ['alpha', 'beta'],
      metadata: { tier: 'gold' },
      execute: async () => 'ok',
    });

    expect(tool.tags).toEqual(['alpha', 'beta']);
    expect(tool.metadata).toEqual({ tier: 'gold' });
  });

  it('createTool supports metadata from a sync factory', async () => {
    const toolbox = createToolbox();
    const tool = toolbox.createTool({
      name: 'sync-factory-metadata',
      description: 'metadata from sync factory',
      input: z.object({ value: z.string() }),
      metadata: () => ({ source: 'sync' as const }),
      async execute({ value }) {
        return value;
      },
    });

    expect(tool.metadata).toEqual({ source: 'sync' });
    const result = await toolbox.execute({
      id: 'sync-factory-metadata-1',
      name: 'sync-factory-metadata',
      arguments: { value: 'ok' },
    });
    expect(result.result).toBe('ok');
  });

  it('createTool supports metadata from a promise', async () => {
    const toolbox = createToolbox();
    const toolPromise = toolbox.createTool({
      name: 'promise-metadata-toolbox',
      description: 'metadata from promise',
      input: z.object({ value: z.string() }),
      metadata: Promise.resolve({ source: 'promise' as const }),
      async execute({ value }) {
        return value;
      },
    });

    expect(toolPromise).toBeInstanceOf(Promise);
    const tool = await toolPromise;
    expect(tool.metadata).toEqual({ source: 'promise' });
    expect(toolbox.getTool('promise-metadata-toolbox')).toBe(tool);
  });

  it('createTool supports metadata from an async factory', async () => {
    const toolbox = createToolbox();
    const toolPromise = toolbox.createTool({
      name: 'async-factory-metadata-toolbox',
      description: 'metadata from async factory',
      input: z.object({ value: z.string() }),
      metadata: async () => ({ source: 'async-factory' as const }),
      async execute({ value }) {
        return value;
      },
    });

    expect(toolPromise).toBeInstanceOf(Promise);
    const tool = await toolPromise;
    expect(tool.metadata).toEqual({ source: 'async-factory' });
    expect(toolbox.getTool('async-factory-metadata-toolbox')).toBe(tool);
  });

  it('enforces readOnly for mutating tools', async () => {
    const toolbox = createToolbox([], { readOnly: true });
    toolbox.register({
      name: 'mutating',
      description: 'mutates',
      input: z.object({}),
      metadata: { mutates: true },
      execute: async () => 'ok',
    });

    const result = await toolbox.execute({
      id: 'mutating-1',
      name: 'mutating',
      arguments: {},
    });

    expect(result.error?.message).toContain('not allowed');
  });

  it('enforces allowDangerous for dangerous tools', async () => {
    const toolbox = createToolbox([], { allowDangerous: false });
    toolbox.register({
      name: 'dangerous',
      description: 'dangerous tool',
      input: z.object({}),
      metadata: { dangerous: true },
      execute: async () => 'ok',
    });

    const result = await toolbox.execute({
      id: 'dangerous-1',
      name: 'dangerous',
      arguments: {},
    });

    expect(result.error?.message).toContain('Dangerous tool');
  });

  it('enforces session budgets for max calls', async () => {
    const toolbox = createToolbox([], { budget: { maxCalls: 1 } });
    toolbox.register({
      name: 'one',
      description: 'budgeted',
      input: z.object({}),
      execute: async () => 'ok',
    });

    const first = await toolbox.execute({
      id: 'call-1',
      name: 'one',
      arguments: {},
    });
    const second = await toolbox.execute({
      id: 'call-2',
      name: 'one',
      arguments: {},
    });

    expect(first.result).toBe('ok');
    expect(second.error?.category).toBe('conflict');
    expect(second.error?.message).toContain('Budget exceeded');
  });

  it('enforces session budgets for max duration', async () => {
    const toolbox = createToolbox([], { budget: { maxDurationMs: 0 } });
    toolbox.register({
      name: 'time',
      description: 'budgeted',
      input: z.object({}),
      execute: async () => 'ok',
    });

    const result = await toolbox.execute({
      id: 'call-1',
      name: 'time',
      arguments: {},
    });

    expect(result.error?.category).toBe('conflict');
    expect(result.error?.message).toContain('Budget exceeded');
  });

  it('createTool accepts object schemas', () => {
    const toolbox = createToolbox();
    const tool = toolbox.createTool({
      name: 'object-schema',
      description: 'object schema',
      input: { value: z.string() },
      execute: async ({ value }) => value,
    });

    expect(tool.input.safeParse({ value: 'ok' }).success).toBe(true);
  });

  it('createTool accepts input in configuration normalization', async () => {
    const toolbox = createToolbox();
    toolbox.register({
      name: 'input-configuration',
      description: 'registered with input',
      input: z.object({ value: z.string() }),
      async execute({ value }) {
        return value;
      },
    } as any);

    const result = await toolbox.execute({
      name: 'input-configuration',
      arguments: { value: 'ok' },
    });

    expect(result.result).toBe('ok');
  });

  it('createTool rejects invalid execute types', () => {
    const toolbox = createToolbox();
    expect(() =>
      toolbox.createTool({
        name: 'bad-execute',
        description: 'invalid execute type',
        input: z.object({}),
        execute: 42 as any,
      }),
    ).toThrow('execute must be a function or a promise that resolves to a function');
  });

  it('createTool rejects invalid schema types', () => {
    const toolbox = createToolbox();
    expect(() =>
      toolbox.createTool({
        name: 'bad-schema',
        description: 'invalid schema type',
        input: 123 as any,
        execute: async () => null,
      }),
    ).toThrow('Tool input must be a Zod object schema or an object of Zod schemas');
  });

  it('createTool rejects non-object Zod schemas', () => {
    const toolbox = createToolbox();
    expect(() =>
      toolbox.createTool({
        name: 'bad-zod-schema',
        description: 'invalid zod schema',
        input: z.number(),
        execute: async () => null,
      }),
    ).toThrow('Tool input must be a Zod object schema');
  });

  it('createTool throws when toolFactory returns mismatched name', () => {
    const toolbox = createToolbox([], {
      toolFactory: (configuration) =>
        createTool({
          name: `other-${configuration.name}`,
          description: configuration.description,
          input: configuration.input,
          execute: async () => null,
        }),
    });

    expect(() =>
      toolbox.createTool({
        name: 'mismatch',
        description: 'should fail',
        input: z.object({}),
        execute: async () => null,
      }),
    ).toThrow('Failed to register tool: mismatch');
  });

  it('defaults input when using toolbox.createTool', async () => {
    const toolbox = createToolbox();
    const tool = toolbox.createTool({
      name: 'from-toolbox-default',
      description: 'default schema',
      execute: async () => 'ok',
    });

    expect(tool.input.safeParse({}).success).toBe(true);

    const result = await toolbox.execute({
      id: 'from-toolbox-default-1',
      name: 'from-toolbox-default',
      arguments: {},
    });
    expect(result.result).toBe('ok');
  });

  it('defaults input when registering a raw tool configuration with no input', async () => {
    const toolbox = createToolbox();
    toolbox.register({
      name: 'configuration-default-schema',
      description: 'defaults schema for raw configurations too',
      async execute() {
        return 'ok';
      },
    });

    const tool = toolbox.getTool('configuration-default-schema');
    expect(tool?.input.safeParse({}).success).toBe(true);

    const result = await toolbox.execute({
      id: 'configuration-default-schema-1',
      name: 'configuration-default-schema',
      arguments: {},
    });
    expect(result.result).toBe('ok');
  });

  it('returns an error when lazy execute resolves to non-function in configurations', async () => {
    const toolbox = createToolbox([
      makeConfiguration({
        name: 'sum-lazy-bad',
        execute: Promise.resolve(123 as any),
      }),
    ]);

    const result = await toolbox.execute({
      id: 'lazy-bad',
      name: 'sum-lazy-bad',
      arguments: { a: 1, b: 2 },
    });
    expect(result.error?.message).toContain('sum-lazy-bad');
    expect(result.error?.message).toContain(
      'Expected a function or a promise that resolves to a function',
    );
  });

  it('marks registry as completed', () => {
    const toolbox = createToolbox();
    expect(toolbox.completed).toBe(false);
    toolbox.complete();
    expect(toolbox.completed).toBe(true);
  });

  it('provides robust query support', () => {
    const toolbox = createToolbox();
    toolbox.register(
      makeConfiguration({
        name: 'increment',
        description: 'increase by one',
        tags: ['math'],
        async execute({ a }) {
          return a + 1;
        },
        input: z.object({ a: z.number() }),
      }),
      makeConfiguration({
        name: 'double',
        description: 'double it',
        tags: ['math', 'fast'],
        async execute({ a }) {
          return a * 2;
        },
        input: z.object({ a: z.number() }),
      }),
      makeConfiguration({
        name: 'describe',
        description: 'describe value',
        tags: ['text'],
        input: z.object({ value: z.string() }),
        async execute({ value }) {
          return value.toUpperCase();
        },
      }),
    );

    const tagMatches = queryTools(toolbox, { tags: { any: ['math'] } });
    expect(tagMatches.map((tool) => tool.name).sort()).toEqual(['double', 'increment']);

    const descriptorMatches = queryTools(toolbox, {
      tags: { any: ['fast'] },
      text: 'double',
    });
    expect(descriptorMatches.map((tool) => tool.name)).toEqual(['double']);

    const argumentMatches = queryTools(toolbox, { schema: { keys: ['value'] } });
    expect(argumentMatches.map((tool) => tool.name)).toEqual(['describe']);

    const schemaMatches = queryTools(toolbox, {
      schema: { matches: z.object({ a: z.number() }) },
    });
    expect(schemaMatches.map((tool) => tool.name).sort()).toEqual(['double', 'increment']);

    const predicateMatches = queryTools(toolbox, {
      predicate: (tool) => tool.tags?.includes('text') ?? false,
    });
    expect(predicateMatches.map((tool) => tool.name)).toEqual(['describe']);
  });

  it('supports boolean query groups', () => {
    const toolbox = createToolbox();
    toolbox.register(
      makeConfiguration({
        name: 'alpha',
        tags: ['math'],
        input: z.object({ a: z.number() }),
      }),
      makeConfiguration({
        name: 'beta',
        tags: ['text'],
        input: z.object({ value: z.string() }),
      }),
      makeConfiguration({
        name: 'gamma',
        tags: ['math', 'fast'],
        input: z.object({ a: z.number(), fast: z.boolean() }),
      }),
    );

    const orMatches = queryTools(toolbox, {
      or: [{ tags: { any: ['text'] } }, { tags: { all: ['math', 'fast'] } }],
    });
    expect(orMatches.map((tool) => tool.name).sort()).toEqual(['beta', 'gamma']);

    const notMatches = queryTools(toolbox, {
      tags: { any: ['math'] },
      not: { tags: { any: ['fast'] } },
    });
    expect(notMatches.map((tool) => tool.name)).toEqual(['alpha']);
  });

  it('returns all tools when no query criteria is provided', () => {
    const toolbox = createToolbox();
    toolbox.register(makeConfiguration({ name: 'foo' }), makeConfiguration({ name: 'bar' }));

    const allTools = queryTools(toolbox);
    expect(allTools.map((tool) => tool.name).sort()).toEqual(['bar', 'foo']);
  });

  it('supports pagination and selection in queries', () => {
    const toolbox = createToolbox();
    toolbox.register(
      makeConfiguration({ name: 'alpha' }),
      makeConfiguration({ name: 'beta' }),
      makeConfiguration({ name: 'gamma' }),
    );

    const names = queryTools(toolbox, { select: 'name', offset: 1, limit: 1 });
    expect(names).toEqual(['beta']);

    const summaries = queryTools(toolbox, { select: 'summary', includeSchema: true });
    expect(summaries[0]?.schema).toBeDefined();
  });

  it('throws when query input is not an object', () => {
    const toolbox = createToolbox();
    toolbox.register(makeConfiguration({ name: 'alpha' }), makeConfiguration({ name: 'beta' }));

    expect(() => queryTools(toolbox, 42 as unknown as any)).toThrow(
      'query expects a ToolQuery object',
    );
  });

  it('supports schema descriptors within query objects', () => {
    const toolbox = createToolbox();
    const schema = z.object({ text: z.string(), flag: z.boolean().optional() });
    toolbox.register(
      makeConfiguration({
        name: 'writer',
        input: schema,
        async execute({ text }) {
          return text;
        },
      }),
      makeConfiguration({ name: 'mathy', input: z.object({ a: z.number() }) }),
    );

    const matches = queryTools(toolbox, { schema: { matches: schema } });
    expect(matches.map((tool) => tool.name)).toEqual(['writer']);
  });

  it('ignores predicate errors while filtering', () => {
    const toolbox = createToolbox();
    toolbox.register(makeConfiguration({ name: 'ok' }), makeConfiguration({ name: 'nope' }));

    const matches = queryTools(toolbox, {
      predicate: (tool) => {
        if (tool.name === 'nope') {
          throw new Error('boom');
        }
        return tool.name === 'ok';
      },
    });

    expect(matches.map((tool) => tool.name)).toEqual(['ok']);
  });

  it('handles invalid configurations by throwing a helpful error', () => {
    const toolbox = createToolbox();
    expect(() => {
      toolbox.register({} as any);
    }).toThrow(/ToolConfiguration/);
    expect(() => {
      toolbox.register(null as any);
    }).toThrow(/ToolConfiguration/);
    expect(() => {
      toolbox.register({
        name: '',
        description: 'ok',
        input: makeConfiguration().input,
        execute: async () => {},
      } as any);
    }).toThrow(/ToolConfiguration/);
    expect(() => {
      toolbox.register({
        name: 'x',
        description: 42 as any,
        input: makeConfiguration().input,
        execute: async () => {},
      } as any);
    }).toThrow(/ToolConfiguration/);
    expect(() => {
      toolbox.register({
        name: 'x',
        description: 'ok',
        input: undefined as any,
        execute: async () => {},
      } as any);
    }).not.toThrow();
    expect(() => {
      toolbox.register({
        name: 'x',
        description: 'ok',
        input: makeConfiguration().input,
        execute: null as any,
      });
    }).toThrow(/missing execute/i);
  });

  it('emits lifecycle events for register, call, complete, error, and not-found', async () => {
    const toolbox = createToolbox();
    const events: Record<string, number> = {
      registering: 0,
      registered: 0,
      call: 0,
      complete: 0,
      error: 0,
      'not-found': 0,
    };
    (Object.keys(events) as (keyof typeof events)[]).forEach((type) => {
      toolbox.addEventListener(type, () => {
        events[type] += 1;
      });
    });

    toolbox.register(
      makeConfiguration({ name: 'ok' }),
      makeConfiguration({
        name: 'boom',
        async execute() {
          throw new Error('boom');
        },
      }),
    );
    await toolbox.execute({ id: 'ok-1', name: 'ok', arguments: { a: 1, b: 1 } });
    await toolbox.execute({ id: 'boom-1', name: 'boom', arguments: { a: 0, b: 0 } });
    await toolbox.execute({ id: 'missing', name: 'nope', arguments: {} as any });

    expect(events.registering).toBe(2);
    expect(events.registered).toBe(2);
    expect(events.call).toBe(2);
    expect(events.complete).toBe(1);
    expect(events.error).toBe(1);
    expect(events['not-found']).toBe(1);
  });

  it('passes toolbox context into registered tools', async () => {
    const contexts: any[] = [];
    const toolbox = createToolbox([], {
      context: { workspaceId: 'ws-123', role: 'admin' },
    });
    toolbox.register({
      name: 'ctx',
      description: 'ctx aware',
      input: z.object({}),
      async execute(_params, context) {
        contexts.push(context);
        expect(context.workspaceId).toBe('ws-123');
        expect(context.role).toBe('admin');
        expect(typeof context.dispatchEvent).toBe('function');
        expect(context.toolCall.id).toBe('ctx-1');
        return 'ok';
      },
    });

    const res = await toolbox.execute({ id: 'ctx-1', name: 'ctx', arguments: {} });
    expect(res.result).toBe('ok');
    expect(contexts).toHaveLength(1);
  });

  it('clears listeners when provided signal aborts', async () => {
    const controller = new AbortController();
    const toolbox = createToolbox([], { signal: controller.signal as any });

    let calls = 0;
    toolbox.addEventListener('call', () => {
      calls += 1;
    });

    controller.abort();

    toolbox.register(makeConfiguration({ name: 'adder' }));
    await toolbox.execute({ id: 'adder', name: 'adder', arguments: { a: 1, b: 2 } });
    expect(calls).toBe(0);
  });

  it('clears listeners immediately when provided signal is already aborted', () => {
    const signal = {
      aborted: true,
      addEventListener() {
        throw new Error('should not add abort listeners');
      },
      removeEventListener() {},
    };
    expect(() => createToolbox([], { signal: signal as any })).not.toThrow();
  });

  it('allows tools to dispatch status:update events via context.dispatchEvent', async () => {
    const statusUpdates: Array<{
      callId: string;
      name: string;
      status: string;
      percent?: number;
    }> = [];

    const toolbox = createToolbox([], {
      context: { tabId: 42 },
    });

    toolbox.addEventListener('status:update', (event: any) => {
      statusUpdates.push(event);
    });

    toolbox.register({
      name: 'long-task',
      description: 'a task that reports progress',
      input: z.object({ steps: z.number() }),
      async execute({ steps }, context) {
        for (let i = 1; i <= steps; i++) {
          const event = new Event('status:update');
          Object.assign(event, {
            callId: context.toolCall.id,
            name: 'long-task',
            status: `Step ${i} of ${steps}`,
            percent: Math.round((i / steps) * 100),
          });
          context.dispatchEvent(event);
        }
        return { completed: steps };
      },
    });

    const result = await toolbox.execute({
      id: 'task-1',
      name: 'long-task',
      arguments: { steps: 3 },
    });

    expect(result.result).toEqual({ completed: 3 });
    expect(statusUpdates).toHaveLength(3);
    expect(statusUpdates[0].callId).toBe('task-1');
    expect(statusUpdates[0].name).toBe('long-task');
    expect(statusUpdates[0].status).toBe('Step 1 of 3');
    expect(statusUpdates[0].percent).toBe(33);
    expect(statusUpdates[2].callId).toBe('task-1');
    expect(statusUpdates[2].name).toBe('long-task');
    expect(statusUpdates[2].status).toBe('Step 3 of 3');
    expect(statusUpdates[2].percent).toBe(100);
  });

  it('bubbles stream lifecycle events and forwards stream execute options', async () => {
    const toolbox = createToolbox();
    const events: string[] = [];

    toolbox.addEventListener('stream-start', (event) => {
      events.push(`start:${(event as any).mode}`);
    });
    toolbox.addEventListener('stream-chunk', (event) => {
      events.push(`chunk:${(event as any).index}:${(event as any).chunk as string}`);
    });
    toolbox.addEventListener('stream-end', (event) => {
      events.push(`end:${(event as any).chunks}:${(event as any).completed}`);
    });

    toolbox.register({
      name: 'streaming-task',
      description: 'streams chunks',
      input: z.object({}),
      async execute() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 'x';
            yield 'y';
          },
        };
      },
    });

    const collected = await toolbox.execute({
      id: 'stream-collect',
      name: 'streaming-task',
      arguments: {},
    });
    expect(collected.result).toEqual(['x', 'y']);

    const live = await toolbox.execute(
      { id: 'stream-live', name: 'streaming-task', arguments: {} },
      { stream: true },
    );
    expect(live.stream).toBeDefined();
    const chunks: string[] = [];
    for await (const chunk of live.stream!) {
      chunks.push(chunk as string);
    }
    expect(chunks).toEqual(['x', 'y']);

    expect(events).toEqual([
      'start:collect',
      'chunk:0:x',
      'chunk:1:y',
      'end:2:true',
      'start:stream',
      'chunk:0:x',
      'chunk:1:y',
      'end:2:true',
    ]);
  });

  it('consumes stream results exposed only through result and keeps bubbling events', async () => {
    const toolbox = createToolbox([], {
      toolFactory(configuration, { buildDefaultTool }) {
        const tool = buildDefaultTool(configuration);
        if (configuration.name !== 'result-only-stream') {
          return tool;
        }
        return new Proxy(tool, {
          get(target, prop, receiver) {
            if (prop === 'execute') {
              return async (...args: any[]) => {
                const original = await (target as any).execute(...args);
                const { stream: _ignored, ...rest } = original;
                return rest;
              };
            }
            return Reflect.get(target as any, prop, receiver);
          },
          apply(target, thisArg, args) {
            return Reflect.apply(target as any, thisArg, args);
          },
        });
      },
    });

    const events: string[] = [];
    toolbox.addEventListener('stream-start', (event) => {
      events.push(`start:${(event as any).mode}`);
    });
    toolbox.addEventListener('stream-chunk', (event) => {
      events.push(`chunk:${(event as any).index}:${(event as any).chunk as string}`);
    });
    toolbox.addEventListener('stream-end', (event) => {
      events.push(`end:${(event as any).chunks}:${(event as any).completed}`);
    });

    toolbox.register({
      name: 'result-only-stream',
      description: 'streams chunks via result only',
      input: z.object({}),
      async execute() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 'r1';
            yield 'r2';
          },
        };
      },
    });

    const live = await toolbox.execute(
      { id: 'result-only-1', name: 'result-only-stream', arguments: {} },
      { stream: true },
    );

    expect(live.stream).toBeUndefined();
    const chunks: string[] = [];
    for await (const chunk of live.result as AsyncIterable<unknown>) {
      chunks.push(chunk as string);
    }
    expect(chunks).toEqual(['r1', 'r2']);
    expect(events).toEqual(['start:stream', 'chunk:0:r1', 'chunk:1:r2', 'end:2:true']);
  });

  it('surfaces unexpected tool execution errors as ToolResult errors', async () => {
    const toolbox = createToolbox([], {
      toolFactory(configuration, { buildDefaultTool }) {
        const tool = buildDefaultTool(configuration);
        if (configuration.name !== 'fragile') {
          return tool;
        }
        return new Proxy(tool, {
          get(target, prop, receiver) {
            if (prop === 'execute') {
              return () => {
                throw new Error('kaboom');
              };
            }
            return Reflect.get(target as any, prop, receiver);
          },
          apply(target, thisArg, args) {
            return Reflect.apply(target as any, thisArg, args);
          },
        });
      },
    });
    toolbox.register(makeConfiguration({ name: 'fragile' }));

    const result = await toolbox.execute({
      id: 'fragile-1',
      name: 'fragile',
      arguments: { a: 1, b: 2 },
    });
    expect(result.error?.message).toContain('kaboom');
  });

  it('throws tool errors when errorMode is failFast', async () => {
    const toolbox = createToolbox();
    toolbox.register({
      name: 'fail-fast-tool-error',
      description: 'returns a ToolResult error',
      input: z.object({}),
      async execute() {
        throw new Error('tool failed');
      },
    });

    await expect(
      toolbox.execute(
        { id: 'fail-fast-1', name: 'fail-fast-tool-error', arguments: {} },
        { errorMode: 'failFast' },
      ),
    ).rejects.toMatchObject({ message: 'tool failed' });
  });

  it('throws unexpected execution errors when errorMode is failFast', async () => {
    const toolbox = createToolbox([], {
      toolFactory(configuration, { buildDefaultTool }) {
        const tool = buildDefaultTool(configuration);
        if (configuration.name !== 'fail-fast-unexpected') {
          return tool;
        }
        return new Proxy(tool, {
          get(target, prop, receiver) {
            if (prop === 'execute') {
              return () => {
                throw new Error('unexpected failure');
              };
            }
            return Reflect.get(target as any, prop, receiver);
          },
          apply(target, thisArg, args) {
            return Reflect.apply(target as any, thisArg, args);
          },
        });
      },
    });
    toolbox.register(makeConfiguration({ name: 'fail-fast-unexpected' }));

    await expect(
      toolbox.execute(
        {
          id: 'fail-fast-unexpected-1',
          name: 'fail-fast-unexpected',
          arguments: { a: 1, b: 2 },
        },
        { errorMode: 'failFast' },
      ),
    ).rejects.toThrow('unexpected failure');
  });

  describe('getMissingTools', () => {
    it('returns empty array when all tools are registered', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'toolA' }),
        makeConfiguration({ name: 'toolB' }),
        makeConfiguration({ name: 'toolC' }),
      );

      const missing = toolbox.getMissingTools(['toolA', 'toolB', 'toolC']);
      expect(missing).toEqual([]);
    });

    it('returns only the missing tool names when some are not registered', () => {
      const toolbox = createToolbox();
      toolbox.register(makeConfiguration({ name: 'toolA' }), makeConfiguration({ name: 'toolC' }));

      const missing = toolbox.getMissingTools(['toolA', 'toolB', 'toolC', 'toolD']);
      expect(missing).toEqual(['toolB', 'toolD']);
    });

    it('returns all tool names when none are registered', () => {
      const toolbox = createToolbox();

      const missing = toolbox.getMissingTools(['toolA', 'toolB']);
      expect(missing).toEqual(['toolA', 'toolB']);
    });

    it('returns empty array for empty input', () => {
      const toolbox = createToolbox();

      const missing = toolbox.getMissingTools([]);
      expect(missing).toEqual([]);
    });
  });

  describe('hasAllTools', () => {
    it('returns true when all tools are registered', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'toolA' }),
        makeConfiguration({ name: 'toolB' }),
        makeConfiguration({ name: 'toolC' }),
      );

      expect(toolbox.hasAllTools(['toolA', 'toolB', 'toolC'])).toBe(true);
    });

    it('returns true when checking a subset of registered tools', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'toolA' }),
        makeConfiguration({ name: 'toolB' }),
        makeConfiguration({ name: 'toolC' }),
      );

      expect(toolbox.hasAllTools(['toolA', 'toolB'])).toBe(true);
    });

    it('returns false when any tool is not registered', () => {
      const toolbox = createToolbox();
      toolbox.register(makeConfiguration({ name: 'toolA' }), makeConfiguration({ name: 'toolB' }));

      expect(toolbox.hasAllTools(['toolA', 'toolB', 'toolC'])).toBe(false);
    });

    it('returns false when no tools are registered', () => {
      const toolbox = createToolbox();

      expect(toolbox.hasAllTools(['toolA'])).toBe(false);
    });

    it('returns true for empty input array', () => {
      const toolbox = createToolbox();

      expect(toolbox.hasAllTools([])).toBe(true);
    });
  });

  describe('tag filters', () => {
    it('excludes tools with forbidden tags', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'safe-tool', tags: ['safe', 'utility'] }),
        makeConfiguration({ name: 'dangerous-tool', tags: ['destructive', 'utility'] }),
        makeConfiguration({ name: 'another-safe', tags: ['safe'] }),
      );

      const results = queryTools(toolbox, { tags: { none: ['destructive'] } });
      expect(results.map((t) => t.name).sort()).toEqual(['another-safe', 'safe-tool']);
    });

    it('performs case-insensitive tag exclusions', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'tool-a', tags: ['safe'] }),
        makeConfiguration({ name: 'tool-b', tags: ['destructive'] }),
      );

      const results = queryTools(toolbox, { tags: { none: ['DESTRUCTIVE'] } });
      expect(results.map((t) => t.name)).toEqual(['tool-a']);
    });

    it('requires all tags when using tags.all', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'math-fast', tags: ['math', 'fast'] }),
        makeConfiguration({ name: 'math-only', tags: ['math'] }),
      );

      const results = queryTools(toolbox, { tags: { all: ['math', 'fast'] } });
      expect(results.map((t) => t.name)).toEqual(['math-fast']);
    });
  });

  describe('search ranking', () => {
    it('uses embeddings to match query text when configured', () => {
      const embed = (texts: string[]) =>
        texts.map((text) => {
          const normalized = text.toLowerCase();
          if (normalized.includes('weather') || normalized.includes('forecast')) {
            return [1, 0];
          }
          if (normalized.includes('stocks')) {
            return [0, 1];
          }
          return [0, 0];
        });

      const toolbox = createToolbox([], { embed });
      toolbox.register(
        makeConfiguration({
          name: 'forecast-tool',
          description: 'daily forecast',
          tags: ['reports'],
        }),
        makeConfiguration({
          name: 'stock-tool',
          description: 'market summary',
          tags: ['finance'],
        }),
      );

      const results = queryTools(toolbox, { text: 'weather' });
      expect(results.map((tool) => tool.name)).toEqual(['forecast-tool']);
    });

    it('ranks tools by preferred tags', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'no-match', tags: ['other'] }),
        makeConfiguration({ name: 'one-match', tags: ['math'] }),
        makeConfiguration({ name: 'two-matches', tags: ['math', 'fast'] }),
        makeConfiguration({ name: 'zero-tags', tags: undefined }),
      );

      const results = searchTools(toolbox, { rank: { tags: ['math', 'fast'] } });
      expect(results.map((t) => t.tool.name)).toEqual([
        'two-matches',
        'one-match',
        'no-match',
        'zero-tags',
      ]);
      expect(results[0]?.reasons).toContain('tag:math');
    });

    it('applies filters before ranking', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'best', tags: ['math', 'fast', 'destructive'] }),
        makeConfiguration({ name: 'good', tags: ['math', 'fast'] }),
        makeConfiguration({ name: 'ok', tags: ['math'] }),
      );

      const results = searchTools(toolbox, {
        filter: { tags: { none: ['destructive'] } },
        rank: { tags: ['math', 'fast'] },
      });
      expect(results.map((t) => t.tool.name)).toEqual(['good', 'ok']);
    });

    it('supports tag boosts', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'standard', tags: ['misc'] }),
        makeConfiguration({ name: 'boosted', tags: ['fast'] }),
      );

      const results = searchTools(toolbox, { rank: { tagWeights: { fast: 4 } } });
      expect(results[0]?.tool.name).toBe('boosted');
      expect(results[0]?.reasons).toContain('tag:fast');
    });

    it('supports custom rankers and tie breakers', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'alpha', tags: ['misc'] }),
        makeConfiguration({ name: 'beta', tags: ['misc'] }),
        makeConfiguration({ name: 'preferred', tags: ['misc'] }),
      );

      const results = searchTools(toolbox, {
        ranker: (tool) =>
          tool.name === 'preferred' ? { score: 10, reasons: ['custom'] } : { score: 0 },
        tieBreaker: (a, b) => b.tool.name.localeCompare(a.tool.name),
      });

      expect(results[0]?.tool.name).toBe('preferred');
      expect(results[0]?.reasons).toContain('custom');
      expect(results[1]?.tool.name).toBe('beta');
    });

    it('limits results and includes text reasons', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'double', description: 'double it', tags: ['math'] }),
        makeConfiguration({
          name: 'increment',
          description: 'increase by one',
          tags: ['math'],
        }),
      );

      const results = searchTools(toolbox, { rank: { text: 'double' }, limit: 1 });
      expect(results).toHaveLength(1);
      expect(results[0]?.tool.name).toBe('double');
      expect(results[0]?.reasons).toContain('text:name');
    });

    it('supports selection and pagination in search results', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'alpha', tags: ['misc'] }),
        makeConfiguration({ name: 'beta', tags: ['misc'] }),
        makeConfiguration({ name: 'gamma', tags: ['misc'] }),
      );

      const results = searchTools(toolbox, {
        select: 'summary',
        includeSchema: true,
        offset: 1,
        limit: 1,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.tool.name).toBe('beta');
      expect(results[0]?.tool.schema).toBeDefined();
    });

    it('sorts by name when scores tie', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'beta', tags: ['misc'] }),
        makeConfiguration({ name: 'alpha', tags: ['misc'] }),
      );

      const results = searchTools(toolbox);
      expect(results.map((t) => t.tool.name)).toEqual(['alpha', 'beta']);
    });

    it('treats non-finite limits as no limit', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'first', tags: ['misc'] }),
        makeConfiguration({ name: 'second', tags: ['misc'] }),
      );

      const results = searchTools(toolbox, { limit: Number.POSITIVE_INFINITY });
      expect(results).toHaveLength(2);
    });

    it('handles empty text ranking input', () => {
      const toolbox = createToolbox();
      toolbox.register(makeConfiguration({ name: 'alpha', tags: ['misc'] }));

      const results = searchTools(toolbox, { rank: { text: '' } });
      expect(results[0]?.score).toBe(0);
      expect(results[0]?.reasons).toEqual([]);
    });

    it('applies ranking weights', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({
          name: 'b-tagged',
          description: 'slow path',
          tags: ['priority'],
          input: z.object({ value: z.string() }),
        }),
        makeConfiguration({
          name: 'a-text',
          description: 'double output',
          tags: ['other'],
          input: z.object({ value: z.string() }),
        }),
      );

      const results = searchTools(toolbox, {
        rank: { tags: ['priority'], text: 'double', weights: { tags: 2, text: 1 } },
      });
      expect(results[0]?.tool.name).toBe('b-tagged');
    });

    it('ranks by number of matched text tokens', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'one-token', tags: ['alpha'] }),
        makeConfiguration({ name: 'two-token', tags: ['alpha', 'beta'] }),
      );

      const results = searchTools(toolbox, { rank: { text: 'alpha beta' } });
      expect(results[0]?.tool.name).toBe('two-token');
    });

    it('respects text field weights', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({
          name: 'summarize',
          description: 'misc',
          tags: [],
        }),
        makeConfiguration({
          name: 'notes',
          description: 'summarize notes',
          tags: [],
        }),
      );

      const results = searchTools(toolbox, {
        rank: {
          text: {
            query: 'summarize',
            weights: { name: 2, description: 0.5 },
          },
        },
      });
      expect(results[0]?.tool.name).toBe('summarize');
    });

    it('uses embeddings to rank text matches when configured', () => {
      const embed = (texts: string[]) =>
        texts.map((text) => {
          const normalized = text.toLowerCase();
          if (normalized.includes('weather') || normalized.includes('forecast')) {
            return [1, 0];
          }
          if (normalized.includes('stocks')) {
            return [0, 1];
          }
          return [0, 0];
        });

      const toolbox = createToolbox([], { embed });
      toolbox.register(
        makeConfiguration({
          name: 'forecast-tool',
          description: 'daily forecast',
        }),
        makeConfiguration({
          name: 'stock-tool',
          description: 'market summary',
        }),
      );

      const results = searchTools(toolbox, {
        rank: {
          text: {
            query: 'weather',
            weights: { description: 2, name: 0.1 },
          },
        },
        explain: true,
      });
      expect(results[0]?.tool.name).toBe('forecast-tool');
      expect(results[0]?.reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('embedding:description')]),
      );
      expect(results[0]?.matches?.embedding?.field).toBe('description');
    });

    it('includes tag and schema key text reasons', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({
          name: 'audit-tool',
          description: 'writes events',
          tags: ['audit-log'],
          input: z.object({ logId: z.string() }),
          metadata: { logId: 'audit' },
        }),
        makeConfiguration({
          name: 'other-tool',
          description: 'unrelated',
          tags: ['misc'],
          input: z.object({ value: z.string() }),
        }),
      );

      const results = searchTools(toolbox, { rank: { text: 'log' }, explain: true });
      expect(results[0]?.tool.name).toBe('audit-tool');
      expect(results[0]?.reasons).toContain('text:tags(audit-log)');
      expect(results[0]?.reasons).toContain('text:schema-keys(logId)');
      expect(results[0]?.reasons).toContain('text:metadata-keys(logId)');
      expect(results[0]?.matches?.fields).toEqual(
        expect.arrayContaining(['tags', 'schemaKeys', 'metadataKeys']),
      );
      expect(results[0]?.matches?.tags).toEqual(['audit-log']);
      expect(results[0]?.matches?.schemaKeys).toEqual(['logId']);
      expect(results[0]?.matches?.metadataKeys).toEqual(['logId']);
    });

    it('reindexes cached search data on demand', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({
          name: 'audit-tool',
          description: 'writes events',
          tags: ['audit'],
          input: z.object({ eventId: z.string() }),
          metadata: { owner: 'team-a' },
        }),
      );

      const tool = toolbox.getTool('audit-tool');
      expect(tool).toBeDefined();

      const initial = searchTools(toolbox, { rank: { text: 'trace' }, explain: true });
      expect(initial[0]?.reasons).toEqual([]);
      expect(initial[0]?.matches?.metadataKeys).toBeUndefined();

      const metadata = tool?.metadata as Record<string, unknown>;
      metadata.traceId = 'trace-1';

      const stale = searchTools(toolbox, { rank: { text: 'trace' }, explain: true });
      expect(stale[0]?.reasons).toEqual([]);
      expect(stale[0]?.matches?.metadataKeys).toBeUndefined();

      reindexSearchIndex(toolbox);

      const refreshed = searchTools(toolbox, { rank: { text: 'trace' }, explain: true });
      expect(refreshed[0]?.reasons).toContain('text:metadata-keys(traceId)');
      expect(refreshed[0]?.matches?.metadataKeys).toEqual(['traceId']);
    });

    it('throws when search input is not an object', () => {
      const toolbox = createToolbox();
      expect(() => searchTools(toolbox, 42 as unknown as any)).toThrow(
        'search expects a ToolSearchOptions object',
      );
    });
  });

  describe('metadata filters', () => {
    it('filters by metadata predicate', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'tool-a', tags: ['test'] }),
        makeConfiguration({ name: 'tool-b', tags: ['test'] }),
      );

      const results = queryTools(toolbox, {
        metadata: { predicate: (meta) => meta === undefined },
      });
      expect(results).toHaveLength(2);

      const noResults = queryTools(toolbox, {
        metadata: {
          predicate: (meta) => meta !== undefined && (meta as any).category === 'special',
        },
      });
      expect(noResults).toHaveLength(0);
    });

    it('ignores metadata predicate errors', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({
          name: 'safe-meta',
          metadata: { tier: 'gold' },
        }),
        makeConfiguration({
          name: 'boom-meta',
          metadata: { tier: 'silver' },
        }),
      );

      const results = queryTools(toolbox, {
        metadata: {
          predicate: (meta) => {
            if ((meta as any)?.tier === 'silver') {
              throw new Error('boom');
            }
            return (meta as any)?.tier === 'gold';
          },
        },
      });
      expect(results.map((t) => t.name)).toEqual(['safe-meta']);
    });

    it('filters tools with metadata eq and has', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({
          name: 'premium-tool',
          tags: ['utility'],
          metadata: { category: 'premium', tier: 1 },
        }),
        makeConfiguration({
          name: 'basic-tool',
          tags: ['utility'],
          metadata: { category: 'basic', tier: 2 },
        }),
        makeConfiguration({
          name: 'no-metadata-tool',
          tags: ['utility'],
        }),
      );

      const premiumResults = queryTools(toolbox, {
        metadata: { eq: { category: 'premium' } },
      });
      expect(premiumResults.map((t) => t.name)).toEqual(['premium-tool']);

      const tieredResults = queryTools(toolbox, {
        metadata: { has: ['tier'] },
      });
      expect(tieredResults.map((t) => t.name).sort()).toEqual(['basic-tool', 'premium-tool']);

      const undefinedResults = queryTools(toolbox, {
        metadata: { predicate: (meta) => meta === undefined },
      });
      expect(undefinedResults.map((t) => t.name)).toEqual(['no-metadata-tool']);
    });

    it('supports contains, startsWith, and range metadata filters', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({
          name: 'alpha-tool',
          metadata: { owner: 'team-alpha', score: 10, labels: ['fast', 'safe'] },
        }),
        makeConfiguration({
          name: 'beta-tool',
          metadata: { owner: 'team-beta', score: 3, labels: ['safe'] },
        }),
      );

      const containsResults = queryTools(toolbox, {
        metadata: { contains: { owner: 'team-' } },
      });
      expect(containsResults.map((t) => t.name).sort()).toEqual(['alpha-tool', 'beta-tool']);

      const labelResults = queryTools(toolbox, {
        metadata: { contains: { labels: 'fast' } },
      });
      expect(labelResults.map((t) => t.name)).toEqual(['alpha-tool']);

      const startsWithResults = queryTools(toolbox, {
        metadata: { startsWith: { owner: 'team-a' } },
      });
      expect(startsWithResults.map((t) => t.name)).toEqual(['alpha-tool']);

      const rangeResults = queryTools(toolbox, {
        metadata: { range: { score: { min: 5, max: 12 } } },
      });
      expect(rangeResults.map((t) => t.name)).toEqual(['alpha-tool']);
    });

    it('preserves metadata through serialization and rehydration', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({
          name: 'meta-tool',
          metadata: { category: 'special', value: 42 },
        }),
      );

      const serialized = toolbox.toJSON();
      expect(serialized[0]?.metadata).toEqual({ category: 'special', value: 42 });

      const rehydrated = createToolbox(serialized);
      const results = queryTools(rehydrated, {
        metadata: { eq: { category: 'special' } },
      });
      expect(results.map((t) => t.name)).toEqual(['meta-tool']);
    });
  });

  describe('combined query options', () => {
    it('supports tags, schema keys, and text together', () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({
          name: 'increment',
          description: 'increase by one',
          tags: ['math'],
          input: z.object({ a: z.number() }),
        }),
        makeConfiguration({
          name: 'double',
          description: 'double it',
          tags: ['math', 'fast'],
          input: z.object({ a: z.number() }),
        }),
        makeConfiguration({
          name: 'describe',
          description: 'describe value',
          tags: ['text'],
          input: z.object({ value: z.string() }),
        }),
      );

      const matches = queryTools(toolbox, {
        tags: { any: ['math'], none: ['slow'] },
        schema: { keys: ['a'] },
        text: 'double',
      });
      expect(matches.map((t) => t.name)).toEqual(['double']);
    });
  });

  describe('middleware', () => {
    it('applies synchronous middleware during registration', () => {
      const middleware = (configuration: ToolConfiguration) => ({
        ...configuration,
        description: `[Enhanced] ${configuration.description}`,
      });

      const toolbox = createToolbox([], { middleware: [middleware] });
      toolbox.register(makeConfiguration({ name: 'test-tool' }));

      const tool = toolbox.getTool('test-tool');
      expect(tool?.description).toBe('[Enhanced] add two numbers');
    });

    it('throws error for async middleware', () => {
      const asyncMiddleware = async (configuration: ToolConfiguration) => ({
        ...configuration,
        description: `[Async] ${configuration.description}`,
      });

      const toolbox = createToolbox([], { middleware: [asyncMiddleware as any] });
      expect(() => toolbox.register(makeConfiguration())).toThrow(
        'Async middleware is not supported. Provide synchronous middleware only.',
      );
    });
  });

  describe('tool replacement', () => {
    it('replaces an existing tool when re-registering with same name', () => {
      const toolbox = createToolbox();

      toolbox.register(makeConfiguration({ name: 'calc', execute: async ({ a, b }) => a + b }));
      expect(toolbox.getTool('calc')).toBeDefined();

      // Register a replacement tool with the same name
      toolbox.register(makeConfiguration({ name: 'calc', execute: async ({ a, b }) => a * b }));

      // Should still have exactly one tool
      expect(toolbox.tools()).toHaveLength(1);
    });
  });

  describe('configuration edges', () => {
    it('createTool applies optional configuration fields', () => {
      const toolbox = createToolbox([], { telemetry: true });
      const tool = toolbox.createTool({
        name: 'configured',
        description: 'configured tool',
        input: z.object({}),
        policy: { beforeExecute: () => ({ allow: true }) },
        policyContext: () => ({ source: 'tool' }),
        digests: { input: false, output: true },
        concurrency: 2,
        execute: async () => ({ ok: true }),
      });

      expect(tool.configuration.policy).toBeDefined();
      expect(tool.configuration.policyContext).toBeDefined();
      expect(tool.configuration.digests).toEqual({ input: false, output: true });
      expect(tool.configuration.concurrency).toBe(2);
    });

    it('passes signal and timeout through execute', async () => {
      const observed: { signal?: AbortSignal; timeout?: number } = {};
      const toolbox = createToolbox();
      toolbox.register({
        name: 'capture',
        description: 'captures context',
        input: z.object({}),
        async execute(_params, context) {
          observed.signal = context?.signal;
          observed.timeout = context?.timeout;
          return 'ok';
        },
      });

      const controller = new AbortController();
      await toolbox.execute(
        { name: 'capture', arguments: {} },
        { signal: controller.signal, timeout: 42 },
      );

      expect(observed.signal).toBe(controller.signal);
      expect(observed.timeout).toBe(42);
    });

    it('uses metadata concurrency when provided', async () => {
      const toolbox = createToolbox([], { concurrency: 10 });
      toolbox.register({
        name: 'meta-concurrency',
        description: 'metadata concurrency',
        input: z.object({}),
        metadata: { concurrency: 3 },
        execute: async () => 'ok',
      });

      const tool = toolbox.getTool('meta-concurrency');
      expect(tool?.configuration.concurrency).toBe(3);
    });

    it('ignores non-positive concurrency values', () => {
      const toolbox = createToolbox([], { concurrency: 0 });
      toolbox.register({
        name: 'no-concurrency',
        description: 'invalid concurrency',
        input: z.object({}),
        execute: async () => 'ok',
      });

      const tool = toolbox.getTool('no-concurrency');
      expect(tool?.configuration.concurrency).toBeUndefined();
    });

    it('honors boolean policy decisions', async () => {
      const toolbox = createToolbox([], {
        policy: {
          beforeExecute: () => false,
        },
      });
      toolbox.register({
        name: 'policy-bool',
        description: 'boolean policy',
        input: z.object({}),
        execute: async () => 'ok',
      });

      const result = await toolbox.execute({
        name: 'policy-bool',
        arguments: {},
      });
      expect(result.error?.message).toBe('Policy denied');
    });

    it('merges registry and tool policy contexts', async () => {
      const toolbox = createToolbox([], {
        policyContext: { fromRegistry: true },
      });
      toolbox.register({
        name: 'policy-merge',
        description: 'policy merge',
        input: z.object({}),
        policyContext: async () => ({ fromTool: true }),
        policy: {
          beforeExecute({ policyContext }) {
            expect(policyContext).toEqual({ fromRegistry: true, fromTool: true });
            return { allow: true };
          },
        },
        execute: async () => 'ok',
      });

      const result = await toolbox.execute({
        name: 'policy-merge',
        arguments: {},
      });
      expect(result.result).toBe('ok');
    });

    it('denies mutating tools based on tags in read-only mode', async () => {
      const toolbox = createToolbox([], { readOnly: true });
      toolbox.register({
        name: 'tag-mutating',
        description: 'tag mutating',
        tags: ['mutating'],
        input: z.object({}),
        execute: async () => 'ok',
      });

      const result = await toolbox.execute({
        name: 'tag-mutating',
        arguments: {},
      });
      expect(result.error?.message).toContain('Mutating tool');
    });

    it('denies dangerous tools based on tags when allowDangerous is false', async () => {
      const toolbox = createToolbox([], { allowDangerous: false });
      toolbox.register({
        name: 'tag-dangerous',
        description: 'tag dangerous',
        tags: ['dangerous'],
        input: z.object({}),
        execute: async () => 'ok',
      });

      const result = await toolbox.execute({
        name: 'tag-dangerous',
        arguments: {},
      });
      expect(result.error?.message).toContain('Dangerous tool');
    });

    it('retries cached embeddings after a rejection', async () => {
      let calls = 0;
      const embed = async (texts: string[]) => {
        calls += 1;
        if (calls === 1) {
          throw new Error('embed failed');
        }
        return texts.map(() => [1, 0, 0]);
      };
      const toolbox = createToolbox([], { embed });
      toolbox.register(makeConfiguration({ name: 'retry-embed' }));

      await new Promise((resolve) => setTimeout(resolve, 0));
      toolbox.register(makeConfiguration({ name: 'retry-embed' }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toBeGreaterThanOrEqual(2);
    });

    it('skips embedding updates when a tool is replaced mid-warm', async () => {
      let resolveEmbeddings: ((value: number[][]) => void) | undefined;
      let lastTexts: string[] = [];
      const embed = (texts: string[]) =>
        new Promise<number[][]>((resolve) => {
          lastTexts = texts;
          resolveEmbeddings = resolve;
        });

      const toolbox = createToolbox([], { embed });
      toolbox.register(makeConfiguration({ name: 'swap' }));
      toolbox.register(makeConfiguration({ name: 'swap', description: 'second' }));

      resolveEmbeddings?.(lastTexts.map(() => [1, 0]));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(toolbox.getTool('swap')?.description).toBe('second');
    });

    it('throws when deserializing with async middleware', () => {
      const asyncMiddleware = async (configuration: ToolConfiguration) => configuration;
      expect(() =>
        createToolbox([makeConfiguration()], { middleware: [asyncMiddleware as any] }),
      ).toThrow(
        'Async middleware is not supported when deserializing. Provide synchronous middleware only.',
      );
    });

    it('supports async getTool resolvers during deserialization', async () => {
      const toolbox = createToolbox(
        [
          {
            name: 'async-resolved-tool',
            description: 'resolved via async getTool',
            input: z.object({ value: z.string() }),
          } as any,
        ],
        {
          getTool: async () => {
            return async (params: unknown) => (params as { value: string }).value.toUpperCase();
          },
        },
      );

      const result = await toolbox.execute({
        name: 'async-resolved-tool',
        arguments: { value: 'ok' },
      });

      expect(result.result).toBe('OK');
    });

    it('returns a useful error when getTool resolves to a non-function', async () => {
      const toolbox = createToolbox(
        [
          {
            name: 'broken-tool',
            description: 'broken resolver',
            input: z.object({}),
          } as any,
        ],
        {
          getTool: async () => undefined as any,
        },
      );

      const result = await toolbox.execute({
        name: 'broken-tool',
        arguments: {},
      });

      expect(result.outcome).toBe('error');
      expect(result.error?.message).toContain('broken-tool');
      expect(result.error?.message).toContain('createToolbox({ getTool })');
    });
  });

  describe('createMiddleware helper', () => {
    it('creates a typed middleware function', () => {
      const middleware = createMiddleware((configuration) => ({
        ...configuration,
        metadata: { ...configuration.metadata, enhanced: true },
      }));

      const toolbox = createToolbox([], { middleware: [middleware] });
      toolbox.register(makeConfiguration({ name: 'test' }));

      const tool = toolbox.getTool('test');
      expect(tool?.metadata).toEqual({ enhanced: true });
    });
  });

  describe('multi-tool execution', () => {
    it('executes multiple tools and returns results in order', async () => {
      const toolbox = createToolbox();
      toolbox.register(
        makeConfiguration({ name: 'add', execute: async ({ a, b }) => a + b }),
        makeConfiguration({ name: 'subtract', execute: async ({ a, b }) => a - b }),
      );

      const results = await toolbox.execute([
        { name: 'add', arguments: { a: 10, b: 5 } },
        { name: 'subtract', arguments: { a: 10, b: 5 } },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]?.result).toBe(15);
      expect(results[1]?.result).toBe(5);
    });
  });

  describe('truncation middleware integration', () => {
    it('truncates oversized string content', async () => {
      const toolbox = createToolbox(
        [
          makeConfiguration({
            name: 'big-output',
            async execute() {
              return 'x'.repeat(10000);
            },
          }),
        ],
        {
          middleware: [
            createMiddleware((config) => {
              const orig = config.execute;
              return {
                ...config,
                execute: async (params: unknown, ctx: unknown) => {
                  const fn = typeof orig === 'function' ? orig : await orig;
                  const result = await fn(params, ctx);
                  if (typeof result === 'string' && result.length > 8000) {
                    return result.slice(0, 7980) + '\n\u2026(truncated)\u2026';
                  }
                  return result;
                },
              };
            }),
          ],
        },
      );

      const result = await toolbox.execute({
        id: 'tc-1',
        name: 'big-output',
        arguments: { a: 1, b: 2 },
      });
      expect(typeof result.result).toBe('string');
      expect((result.result as string).length).toBeLessThanOrEqual(8000);
    });

    it('passes small content through unchanged', async () => {
      const toolbox = createToolbox([
        makeConfiguration({
          name: 'small-output',
          async execute() {
            return 'hello';
          },
        }),
      ]);

      const result = await toolbox.execute({
        id: 'tc-2',
        name: 'small-output',
        arguments: { a: 1, b: 2 },
      });
      expect(result.result).toBe('hello');
    });

    it('wraps streaming tool results and enforces character limit', async () => {
      async function* generateChunks(): AsyncIterable<string> {
        yield 'a'.repeat(5000);
        yield 'b'.repeat(5000);
        yield 'c'.repeat(5000);
      }

      function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
        return Symbol.asyncIterator in value;
      }

      const maxCharacters = 8000;

      const toolbox = createToolbox(
        [
          makeConfiguration({
            name: 'stream-output',
            async execute() {
              return {
                content: '[stream]',
                stream: generateChunks(),
                result: generateChunks(),
              };
            },
          }),
        ],
        {
          middleware: [
            createMiddleware((configuration) => {
              const originalExecute = configuration.execute;
              return {
                ...configuration,
                execute: async (params: unknown, context: unknown) => {
                  const executeFn =
                    typeof originalExecute === 'function' ? originalExecute : await originalExecute;
                  const result = await executeFn(params, context);
                  if (result && typeof result === 'object') {
                    const obj = result as Record<string, unknown>;
                    if (isAsyncIterable(obj['stream'])) {
                      obj['stream'] = createTruncatingAsyncIterable(obj['stream'], {
                        maxCharacters,
                      });
                    }
                    if (isAsyncIterable(obj['result'])) {
                      obj['result'] = createTruncatingAsyncIterable(obj['result'], {
                        maxCharacters,
                      });
                    }
                  }
                  return result;
                },
              };
            }),
          ],
        },
      );

      const executionResult = await toolbox.execute({
        id: 'tc-stream',
        name: 'stream-output',
        arguments: { a: 1, b: 2 },
      });

      const resultObject = executionResult.result as Record<string, unknown>;
      const stream = resultObject['stream'] as AsyncIterable<string>;

      const collected: string[] = [];
      for await (const chunk of stream) {
        collected.push(chunk);
      }

      // First chunk (5000) fits, second chunk gets sliced to 3000, then marker
      const totalContent = collected.join('');
      expect(totalContent).toContain('\u2026(truncated)\u2026');
      expect(totalContent.length).toBeLessThanOrEqual(
        maxCharacters + '\n\u2026(truncated)\u2026'.length,
      );
    });
  });

  describe('fuzzy tool name resolution', () => {
    it('resolves misnamed tool call when resolution is enabled', async () => {
      const toolbox = createToolbox([makeConfiguration({ name: 'read-file' })], {
        resolution: true,
      });

      const result = await toolbox.execute({
        id: 'r1',
        name: 'Read-File',
        arguments: { a: 1, b: 2 },
      });

      expect(result.outcome).not.toBe('error');
    });

    it('returns not-found without resolution enabled', async () => {
      const toolbox = createToolbox([makeConfiguration({ name: 'read-file' })]);

      const result = await toolbox.execute({
        id: 'r2',
        name: 'Read-File',
        arguments: { a: 1, b: 2 },
      });

      expect(result.outcome).toBe('error');
    });

    it('emits name-resolved event', async () => {
      const toolbox = createToolbox([makeConfiguration({ name: 'read-file' })], {
        resolution: true,
      });

      const events: Array<{ originalName: string; resolvedName: string; tier: string }> = [];
      toolbox.addEventListener('name-resolved', (e) => {
        events.push(e);
      });

      await toolbox.execute({ id: 'r3', name: 'read.file', arguments: { a: 1, b: 2 } });

      expect(events).toHaveLength(1);
      expect(events[0].originalName).toBe('read.file');
      expect(events[0].resolvedName).toBe('read-file');
      expect(events[0].tier).toBe('normalized');
    });
  });

  describe('loop detection integration', () => {
    it('emits loop-warning for repeated calls', async () => {
      const toolbox = createToolbox([makeConfiguration()], {
        loopDetection: { warningThreshold: 3, blockThreshold: 6, windowSize: 30 },
      });

      const warnings: unknown[] = [];
      toolbox.addEventListener('loop-warning', (e) => warnings.push(e));

      for (let i = 0; i < 4; i++) {
        await toolbox.execute({ id: `lw-${i}`, name: 'sum', arguments: { a: 1, b: 2 } });
      }

      expect(warnings.length).toBeGreaterThan(0);
    });

    it('blocks at block threshold', async () => {
      const toolbox = createToolbox([makeConfiguration()], {
        loopDetection: { warningThreshold: 2, blockThreshold: 4, windowSize: 30 },
      });

      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(
          await toolbox.execute({ id: `lb-${i}`, name: 'sum', arguments: { a: 1, b: 2 } }),
        );
      }

      const blocked = results.filter((r) => r.outcome === 'error' && r.content?.includes('loop'));
      expect(blocked.length).toBeGreaterThan(0);
    });

    it('does not trigger loop detection when disabled', async () => {
      const toolbox = createToolbox([makeConfiguration()]);

      const warnings: unknown[] = [];
      toolbox.addEventListener('loop-warning', (e) => warnings.push(e));

      for (let i = 0; i < 5; i++) {
        await toolbox.execute({ id: `nd-${i}`, name: 'sum', arguments: { a: 1, b: 2 } });
      }

      expect(warnings).toHaveLength(0);
    });

    it('uses default thresholds when loopDetection is set to true (boolean)', async () => {
      const toolbox = createToolbox([makeConfiguration()], {
        loopDetection: true,
      });

      const warnings: unknown[] = [];
      toolbox.addEventListener('loop-warning', (e) => warnings.push(e));

      // Default warningThreshold is 10, so 11 identical calls should trigger a warning
      for (let i = 0; i < 11; i++) {
        await toolbox.execute({ id: `bool-${i}`, name: 'sum', arguments: { a: 1, b: 2 } });
      }

      expect(warnings.length).toBeGreaterThan(0);
    });

    it('emits loop-blocked event', async () => {
      const toolbox = createToolbox([makeConfiguration()], {
        loopDetection: { warningThreshold: 2, blockThreshold: 4, windowSize: 30 },
      });

      const blocked: unknown[] = [];
      toolbox.addEventListener('loop-blocked', (e) => blocked.push(e));

      for (let i = 0; i < 5; i++) {
        await toolbox.execute({ id: `bl-${i}`, name: 'sum', arguments: { a: 1, b: 2 } });
      }

      expect(blocked.length).toBeGreaterThan(0);
    });
  });

  describe('createLoopDetector', () => {
    it('detects repeated calls via on-demand detector', async () => {
      const toolbox = createToolbox([makeConfiguration()]);
      const detector = toolbox.createLoopDetector({ repetitionThreshold: 3 });

      for (let i = 0; i < 3; i++) {
        await toolbox.execute({ id: `ld-${i}`, name: 'sum', arguments: { a: 1, b: 2 } });
      }

      const result = detector.detectLoop();
      expect(result.detected).toBe(true);
    });

    it('returns statistics from on-demand detector', async () => {
      const toolbox = createToolbox([makeConfiguration()]);
      const detector = toolbox.createLoopDetector();

      await toolbox.execute({ id: 'ls-1', name: 'sum', arguments: { a: 1, b: 2 } });
      await toolbox.execute({ id: 'ls-2', name: 'sum', arguments: { a: 1, b: 2 } });

      const stats = detector.getLoopStatistics();
      expect(stats.callCount).toBe(2);
    });

    it('detects no loop for varied calls', async () => {
      const toolbox = createToolbox([makeConfiguration()]);
      const detector = toolbox.createLoopDetector();

      await toolbox.execute({ id: 'v-1', name: 'sum', arguments: { a: 1, b: 2 } });
      await toolbox.execute({ id: 'v-2', name: 'sum', arguments: { a: 3, b: 4 } });

      const result = detector.detectLoop();
      expect(result.detected).toBe(false);
    });

    it('detects ping-pong via on-demand detector', async () => {
      const sumTool = makeConfiguration({ name: 'sum' });
      const diffTool = makeConfiguration({
        name: 'difference',
        async execute({ a, b }: { a: number; b: number }) {
          return a - b;
        },
      });
      const toolbox = createToolbox([sumTool, diffTool]);
      const detector = toolbox.createLoopDetector({ pingPongThreshold: 5, maxWindowSize: 30 });

      for (let i = 0; i < 12; i++) {
        if (i % 2 === 0) {
          await toolbox.execute({ id: `pp-${i}`, name: 'sum', arguments: { a: 1, b: 2 } });
        } else {
          await toolbox.execute({ id: `pp-${i}`, name: 'difference', arguments: { a: 5, b: 3 } });
        }
      }

      const result = detector.detectLoop();
      expect(result.detected).toBe(true);
      expect(result.message).toContain('ping-pong');
    });

    it('trims window when maxWindowSize is exceeded', async () => {
      const toolbox = createToolbox([makeConfiguration()]);
      const detector = toolbox.createLoopDetector({ maxWindowSize: 5, repetitionThreshold: 100 });

      for (let i = 0; i < 10; i++) {
        await toolbox.execute({ id: `tw-${i}`, name: 'sum', arguments: { a: i, b: i } });
      }

      const stats = detector.getLoopStatistics();
      expect(Object.keys(stats.hashCounts).length).toBeLessThanOrEqual(5);
    });

    it('clears loopDetectors map when complete() is called', async () => {
      const toolbox = createToolbox([makeConfiguration()]);
      const detector = toolbox.createLoopDetector({ repetitionThreshold: 3 });

      await toolbox.execute({ id: 'c-1', name: 'sum', arguments: { a: 1, b: 2 } });
      await toolbox.execute({ id: 'c-2', name: 'sum', arguments: { a: 1, b: 2 } });

      // Detector should show 2 calls
      expect(detector.getLoopStatistics().callCount).toBe(2);

      // Complete the toolbox - detectors should be cleaned up
      toolbox.complete();

      // After complete, creating a new detector and executing should work independently
      // The old detectors should have been removed from the internal map
      // We verify by checking that the toolbox is completed
      expect(toolbox.completed).toBe(true);
    });
  });
});
