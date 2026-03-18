import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { formatAnthropicToolResults, toAnthropicTools } from '../src/adapters/anthropic';
import { formatGeminiToolResults } from '../src/adapters/gemini';
import {
  createOpenAIToolGate,
  internalOpenAIAgentsTestUtilities,
  toOpenAIAgentTools,
} from '../src/adapters/open-ai/agents';
import {
  formatOpenAIToolResults,
  formatOpenAIToolResultsAsync,
} from '../src/adapters/openai';
import { defineTool, serializeToolDefinition } from '../src/core';
import { normalizeIdentity } from '../src/core/identity';
import { internalQueryPredicateTestUtilities } from '../src/core/query-predicates';
import {
  getQueryEmbeddingInfo,
  getToolEmbeddings,
  registerRegistryEmbedder,
  warmToolEmbeddings,
} from '../src/core/registry/embeddings';
import { unwrapSchema } from '../src/core/schema-utilities';
import { assertJsonValue } from '../src/core/serialization/json';
import { createTool, internalToolTestUtilities } from '../src/create-tool';
import { createToolbox, internalToolboxTestUtilities } from '../src/create-toolbox';
import { createMCP, internalMcpTestUtilities } from '../src/integrations/mcp';
import { createSearchTool } from '../src/tools/search-tools';
import { internalRetryTestUtilities, retry } from '../src/utilities/retry';

const {
  checkBudget,
  createLazyExecuteResolver,
  deriveRiskFromMetadata,
  isDangerousToolContext,
  isMutatingToolContext,
  mergePolicies,
  normalizeToolSchema,
  resolvePolicyDecision,
  toPolicyContextProvider,
} = internalToolboxTestUtilities;

const { maxSimilarityPossible, normalizeForSearch } = internalQueryPredicateTestUtilities;
const { resolveRetryDelay, toError, wait } = internalRetryTestUtilities;

describe('coverage edges', () => {
  it('covers toolbox policy and schema helper branches', async () => {
    expect(toPolicyContextProvider(['invalid'] as unknown as Record<string, unknown>)).toBeUndefined();
    expect(toPolicyContextProvider({ scope: 'team' })?.({} as any)).toEqual({ scope: 'team' });

    const merged = mergePolicies(
      {
        async beforeExecute() {
          return { allow: true };
        },
        async afterExecute(context) {
          order.push(`registry:${context.outcome}`);
        },
      },
      {
        async beforeExecute() {
          return { allow: false, reason: 'tool denied' };
        },
        async afterExecute(context) {
          order.push(`tool:${context.outcome}`);
        },
      },
      { readOnly: false, allowMutation: true, allowDangerous: true },
    );
    const order: string[] = [];

    expect(
      await merged?.beforeExecute?.({
        toolName: 'alpha',
        metadata: {},
        tags: [],
      } as any),
    ).toEqual({ allow: false, reason: 'tool denied' });
    await merged?.afterExecute?.({ outcome: 'success' } as any);
    expect(order).toEqual(['tool:success', 'registry:success']);

    expect(await resolvePolicyDecision(undefined, {} as any)).toBeUndefined();
    expect(await resolvePolicyDecision(async () => undefined, {} as any)).toBeUndefined();
    expect(await resolvePolicyDecision(async () => false, {} as any)).toEqual({ allow: false });

    expect(
      isMutatingToolContext({
        toolName: 'readonly-tool',
        metadata: { readOnly: true },
        tags: ['mutating'],
      } as any),
    ).toBe(false);
    expect(
      isDangerousToolContext({
        toolName: 'dangerous-tool',
        metadata: {},
        tags: ['dangerous'],
      } as any),
    ).toBe(true);
    expect(
      isMutatingToolContext({
        toolName: 'readonly-tag-tool',
        metadata: {},
        tags: ['readonly'],
      } as any),
    ).toBe(false);
    expect(
      isMutatingToolContext({
        toolName: 'read-only-tag-tool',
        metadata: {},
        tags: ['read-only'],
      } as any),
    ).toBe(false);
    expect(
      isMutatingToolContext({
        toolName: 'safe-tool',
        metadata: {},
        tags: ['safe'],
      } as any),
    ).toBe(false);
    expect(
      isDangerousToolContext({
        toolName: 'safe-tool',
        metadata: {},
        tags: ['safe'],
      } as any),
    ).toBe(false);

    expect(normalizeToolSchema({ value: z.string() })).toBeInstanceOf(z.ZodObject);
    expect(() => normalizeToolSchema(z.string())).toThrow('Tool input must be a Zod object schema');
    expect(() => normalizeToolSchema(123)).toThrow(
      'Tool input must be a Zod object schema or an object of Zod schemas',
    );

    const originalNow = Date.now;
    Date.now = () => 1_000;
    expect(checkBudget({ maxDurationMs: 100 }, 900, 0)).toBe(
      'Budget exceeded: max duration 100ms',
    );
    Date.now = originalNow;

    const functionResolver = createLazyExecuteResolver(
      async (params: unknown) => params,
      'direct',
    );
    expect(await functionResolver()).toBeInstanceOf(Function);

    expect(deriveRiskFromMetadata({ readOnly: true, dangerous: true })).toEqual({
      readOnly: true,
      dangerous: true,
    });
  });

  it('covers toolbox fail-fast and registration edge paths', async () => {
    const failFastNotFound = createToolbox([], { errorMode: 'failFast' });
    await expect(
      failFastNotFound.execute(
        [{ id: 'call-missing', name: 'missing', arguments: {} }],
        { errorMode: 'failFast' },
      ),
    ).rejects.toThrow('Tool not found: missing');

    const budgeted = createToolbox(
      [
        createTool({
          name: 'noop',
          description: 'noop',
          input: z.object({}),
          async execute() {
            return { ok: true };
          },
        }),
      ],
      {
        errorMode: 'failFast',
        budget: { maxCalls: 0 },
      },
    );
    await expect(
      budgeted.execute(
        [{ id: 'call-noop', name: 'noop', arguments: {} }],
        { errorMode: 'failFast' },
      ),
    ).rejects.toThrow('Budget exceeded: max calls 0');

    expect(() =>
      createToolbox([
        {
          name: 'bad-execute',
          description: 'bad',
          input: z.object({}),
          execute: { then: 'nope' } as any,
        },
      ]),
    ).toThrow(
      'Tool "bad-execute" has invalid execute. Expected a function or a promise that resolves to a function.',
    );

    const toolboxWithAsyncMiddleware = createToolbox([], {
      middleware: [async (configuration) => configuration] as any,
    });
    expect(() =>
      toolboxWithAsyncMiddleware.register({
        name: 'async-middleware',
        description: 'async middleware',
        input: z.object({}),
        execute: async () => ({ ok: true }),
      } as any),
    ).toThrow('Async middleware is not supported. Provide synchronous middleware only.');

    const serializedConfiguration = serializeToolDefinition(
      defineTool({
        name: 'serialized-tool',
        version: '1.0.0',
        description: 'serialized tool',
        input: z.object({}),
      }),
    );
    expect(() =>
      createToolbox([serializedConfiguration as any], {
        getTool() {
          return async () => ({ ok: true });
        },
        middleware: [async (configuration) => configuration] as any,
      }),
    ).toThrow(
      'Async middleware is not supported when deserializing. Provide synchronous middleware only.',
    );

    const embeddingResolutions: Array<(vectors: number[][]) => void> = [];
    const embed = () =>
      new Promise<number[][]>((resolve) => {
        embeddingResolutions.push(resolve);
      });
    const toolbox = createToolbox([], { embed });
    const first = createTool({
      name: 'replace-me',
      description: 'first',
      input: z.object({}),
      async execute() {
        return { ok: true };
      },
    });
    const replacement = createTool({
      name: 'replace-me',
      description: 'replacement',
      input: z.object({}),
      async execute() {
        return { ok: true };
      },
    });

    toolbox.register(first);
    toolbox.register(replacement);
    expect(embeddingResolutions).toHaveLength(2);
    embeddingResolutions[0]?.(Array.from({ length: 5 }, () => [1, 0]));
    embeddingResolutions[1]?.(Array.from({ length: 5 }, () => [1, 0]));
    await Promise.resolve();
    await Promise.resolve();

    expect(toolbox.getTool('replace-me')?.description).toBe('replacement');
  });

  it('covers create-tool helper branches and streamed abort handling', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(normalizeForSearch(42)).toBe('42');
    expect(normalizeForSearch(true)).toBe('true');
    expect(normalizeForSearch(1n)).toBe('1');
    expect(normalizeForSearch({ ok: true })).toBe('{"ok":true}');
    expect(normalizeForSearch(circular)).toBe('');
    expect(normalizeForSearch(Symbol('symbolic'))).toBe('');
    expect(normalizeForSearch(() => 'function')).toBe('');
    expect(maxSimilarityPossible('', '')).toBe(1);

    const streamingTool = createTool({
      name: 'stream-abort',
      description: 'stream abort',
      input: z.object({}),
      async execute() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 'first';
            await new Promise((resolve) => setTimeout(resolve, 0));
            yield 'second';
          },
        };
      },
    });

    const controller = new AbortController();
    const result = (await (streamingTool as any).executeWith({
      params: {},
      stream: true,
      signal: controller.signal,
    })) as any;
    const stream = result.stream[Symbol.asyncIterator]();

    expect(await stream.next()).toEqual({ done: false, value: 'first' });
    controller.abort('stop');
    await expect(stream.next()).rejects.toThrow('Aborted');
  });

  it('covers internal create-tool stringification and error code helpers', () => {
    const { defaultErrorCode, formatNonStringReason, stableStringify } =
      internalToolTestUtilities;
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(formatNonStringReason(undefined)).toBeUndefined();
    expect(formatNonStringReason({ ok: true })).toBe('{"ok":true}');
    expect(formatNonStringReason(circular)).toBeUndefined();
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(stableStringify(Symbol('x'))).toBeUndefined();
    expect(stableStringify(() => {})).toBeUndefined();
    expect(defaultErrorCode('validation')).toBe('VALIDATION_ERROR');
    expect(defaultErrorCode('permission')).toBe('PERMISSION_DENIED');
    expect(defaultErrorCode('not_found')).toBe('NOT_FOUND');
    expect(defaultErrorCode('conflict')).toBe('CONFLICT');
    expect(defaultErrorCode('transient')).toBe('TRANSIENT_ERROR');
    expect(defaultErrorCode('timeout')).toBe('TIMEOUT');
    expect(defaultErrorCode('cancelled')).toBe('CANCELLED');
    expect(defaultErrorCode('internal')).toBe('INTERNAL_ERROR');
  });

  it('covers adapter formatting edges for special values and streaming rejection', async () => {
    const anthropicSerialized = serializeToolDefinition(
      defineTool({
        name: 'anthropic',
        version: '1.0.0',
        description: 'anthropic tool',
        input: z.object({}),
      }),
    );
    anthropicSerialized.input.additionalProperties = true;
    const anthropicTool = toAnthropicTools(anthropicSerialized as any);
    expect(anthropicTool.input_schema.additionalProperties).toBe(true);
    expect(() =>
      formatAnthropicToolResults({
        callId: 'call-stream',
        outcome: 'success',
        content: '[stream]',
        toolCallId: 'call-stream',
        toolName: 'anthropic',
        result: {
          async *[Symbol.asyncIterator]() {
            yield 'chunk';
          },
        },
        stream: {
          async *[Symbol.asyncIterator]() {
            yield 'chunk';
          },
        },
      } as any),
    ).toThrow('formatAnthropicToolResults does not support streaming results');
    expect(
      formatAnthropicToolResults([
        {
          callId: 'call-string',
          outcome: 'success',
          content: 'ok',
          toolCallId: 'call-string',
          toolName: 'anthropic',
          result: 'ok',
        },
        {
          callId: 'call-null',
          outcome: 'success',
          content: null,
          toolCallId: 'call-null',
          toolName: 'anthropic',
          result: null,
        },
        {
          callId: 'call-symbol',
          outcome: 'success',
          content: Symbol('tag'),
          toolCallId: 'call-symbol',
          toolName: 'anthropic',
          result: Symbol('tag'),
        },
        {
          callId: 'call-function',
          outcome: 'success',
          content: Object.assign(() => {}, {
            toJSON() {
              throw new Error('function');
            },
          }),
          toolCallId: 'call-function',
          toolName: 'anthropic',
          result: null,
        },
        {
          callId: 'call-bigint',
          outcome: 'success',
          content: 1n,
          toolCallId: 'call-bigint',
          toolName: 'anthropic',
          result: null,
        },
        {
          callId: 'call-cycle',
          outcome: 'success',
          content: (() => {
            const value: Record<string, unknown> = {};
            value.self = value;
            return value;
          })(),
          toolCallId: 'call-cycle',
          toolName: 'anthropic',
          result: null,
        },
      ] as any).map((block) => block.content),
    ).toEqual(['ok', 'null', 'Symbol(tag)', '[function]', '1', '[unserializable object]']);

    expect(() =>
      formatGeminiToolResults({
        callId: 'call-stream',
        outcome: 'success',
        content: '[stream]',
        toolCallId: 'call-stream',
        toolName: 'gemini',
        result: {
          async *[Symbol.asyncIterator]() {
            yield 'chunk';
          },
        },
        stream: {
          async *[Symbol.asyncIterator]() {
            yield 'chunk';
          },
        },
      } as any),
    ).toThrow('formatGeminiToolResults does not support streaming results');
    expect(
      formatGeminiToolResults([
        {
          callId: 'call-scalar',
          outcome: 'success',
          content: 42,
          toolCallId: 'call-scalar',
          toolName: 'gemini',
          result: 42,
        },
        {
          callId: 'call-null',
          outcome: 'success',
          content: null,
          toolCallId: 'call-null',
          toolName: 'gemini',
          result: null,
        },
      ] as any),
    ).toEqual([
      { functionResponse: { name: 'gemini', response: { result: 42 } } },
      { functionResponse: { name: 'gemini', response: { result: null } } },
    ]);

    expect(
      formatOpenAIToolResults({
        callId: 'call-null',
        outcome: 'success',
        content: null,
        toolCallId: 'call-null',
        toolName: 'openai',
        result: null,
      } as any),
    ).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call-null',
        content: 'null',
      },
    ]);
    expect(
      formatOpenAIToolResults({
        callId: 'call-symbol',
        outcome: 'success',
        content: Symbol('x'),
        toolCallId: 'call-symbol',
        toolName: 'openai',
        result: Symbol('x'),
      } as any),
    ).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call-symbol',
        content: 'Symbol(x)',
      },
    ]);
    expect(
      await formatOpenAIToolResultsAsync({
        callId: 'call-throwing',
        outcome: 'success',
        content: Object.assign(() => {}, {
          toJSON() {
            throw new Error('explode');
          },
          toString() {
            return '[fn]';
          },
        }),
        toolCallId: 'call-throwing',
        toolName: 'openai',
        result: Object.assign(() => {}, {
          toJSON() {
            throw new Error('explode');
          },
          toString() {
            return '[fn]';
          },
        }),
      } as any),
    ).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call-throwing',
        content: '[fn]',
      },
    ]);
  });

  it('covers createTool content normalization fallbacks', async () => {
    const symbolResult = await (createTool({
      name: 'symbol-result',
      description: 'symbol result',
      input: z.object({}),
      async execute() {
        return Symbol('result');
      },
    }) as any).executeWith({ params: {} });

    expect(symbolResult.content).toBe('Symbol(result)');

    const throwingError = new Error('explode');
    (throwingError as Error & { toJSON?: () => never }).toJSON = () => {
      throw new Error('cannot serialize error');
    };

    const errorResult = await (createTool({
      name: 'error-result',
      description: 'error result',
      input: z.object({}),
      async execute() {
        return throwingError;
      },
    }) as any).executeWith({ params: {} });

    expect(errorResult.content).toContain('"name":"Error"');
    expect(errorResult.content).toContain('"message":"explode"');
  });

  it('covers loader failure seams for MCP and OpenAI agents adapters', async () => {
    internalOpenAIAgentsTestUtilities.resetModuleState();
    internalOpenAIAgentsTestUtilities.setModuleLoader(async () => {
      throw new Error('agents missing');
    });
    await expect(toOpenAIAgentTools([])).rejects.toThrow(
      'Missing peer dependency "@openai/agents". Install it to use armorer/open-ai/agents.',
    );
    internalOpenAIAgentsTestUtilities.resetModuleState();

    internalMcpTestUtilities.resetModuleState();
    internalMcpTestUtilities.setModuleLoader(() => {
      throw new Error('mcp missing');
    });
    expect(() => createMCP(createToolbox())).toThrow(
      'Missing peer dependency "@modelcontextprotocol/sdk". Install it to use armorer/mcp.',
    );
    internalMcpTestUtilities.resetModuleState();

    const defaultUnknownDecision = await createOpenAIToolGate({
      registry: [],
      allowUnknown: false,
    })('mystery-tool');
    expect(defaultUnknownDecision).toEqual({
      behavior: 'deny',
      message: 'Tool not allowed: mystery-tool',
    });
  });

  it('covers retry helpers, search tool legacy guard, and small helper branches', async () => {
    expect(resolveRetryDelay(2, 10, 'linear')).toBe(10);
    expect(resolveRetryDelay(3, 10, 'exponential', 25)).toBe(25);
    expect(toError({ ok: true }).message).toBe('{"ok":true}');
    expect(toError({ toJSON() { throw new Error('bad'); } }).message).toBe('[object Object]');

    const preAborted = new AbortController();
    preAborted.abort('stop');
    await expect(wait(1, preAborted.signal as any)).rejects.toThrow('stop');

    const delayedAbort = new AbortController();
    const pending = wait(100, delayedAbort.signal as any);
    delayedAbort.abort('later');
    await expect(pending).rejects.toThrow('later');
    await expect(wait(1, new AbortController().signal as any)).resolves.toBeUndefined();

    expect(() => normalizeIdentity({ name: '   ' } as any)).toThrow(
      'Tool identity requires a name',
    );
    const schemaLike = {
      safeParse() {
        return { success: true };
      },
    };
    expect(unwrapSchema(schemaLike as any)).toBe(schemaLike);
    expect(() => assertJsonValue(Symbol('bad') as any, 'value')).toThrow(
      'Symbol is not valid JSON at value',
    );
    expect(() =>
      defineTool({
        name: 'invalid-tags',
        description: 'invalid',
        input: z.object({}),
        tags: ['valid', 123 as any] as any,
      }),
    ).toThrow('Tool "invalid-tags": tag must be a string');

    expect(() => createSearchTool(123 as any)).not.toThrow();
    const searchableToolbox = createToolbox([
      createTool({
        name: 'ops-search-target',
        description: 'searchable target',
        input: z.object({}),
        tags: ['ops'],
        async execute() {
          return { ok: true };
        },
      }),
    ]);
    const searchTool = createSearchTool(searchableToolbox, { explain: true });
    await expect(searchTool({ query: 'ops', tags: ['ops'] })).resolves.toMatchObject([
      {
        name: 'ops-search-target',
        reasons: ['text:ops', 'tag:ops'],
      },
    ]);
    const originalNodeEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const registered: unknown[] = [];
    createSearchTool(
      {
        tools: () => [],
        register(tool: unknown) {
          registered.push(tool);
        },
      } as any,
      { name: 'legacy-search' },
    );
    if (originalNodeEnvironment === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnvironment;
    }
    expect(registered).toHaveLength(1);

    const retried = retry(
      createTool({
        name: 'retry-abort',
        description: 'retry abort',
        input: z.object({}),
        async execute() {
          throw new Error('nope');
        },
      }),
      { attempts: 2, delayMs: 0 },
    );
    const controller = new AbortController();
    controller.abort('cancelled');
    const retriedResult = await (retried as any).executeWith({
      params: {},
      signal: controller.signal,
    });
    expect(retriedResult.errorMessage).toBe('cancelled');
    await expect((retried as any).rawExecute({}, { signal: controller.signal })).rejects.toThrow(
      'cancelled',
    );

    const neverRetry = retry(
      createTool({
        name: 'never-retry',
        description: 'never retry',
        input: z.object({}),
        async execute() {
          throw new Error('stop');
        },
      }),
      {
        attempts: 3,
        delayMs: 0,
        async shouldRetry() {
          return false;
        },
      },
    );
    const neverRetryResult = await (neverRetry as any).executeWith({ params: {} });
    expect(neverRetryResult.errorMessage).toBe('stop');
    await expect((neverRetry as any).rawExecute({}, {})).rejects.toThrow('stop');

    const emptyEmbeddingTool = {
      ...defineTool({
        name: 'placeholder',
        description: 'placeholder',
        input: z.object({}),
      }),
      identity: { namespace: 'default', name: '' },
      display: { description: '   ' },
      tags: [],
      metadata: {},
      input: z.object({}),
    } as any;
    warmToolEmbeddings(emptyEmbeddingTool, () => []);
    registerRegistryEmbedder({}, () => []);
    expect(true).toBe(true);

    const partiallyMissingEmbeddingsTool = defineTool({
      name: 'partial-embeddings',
      description: 'partial embeddings',
      input: z.object({ value: z.string() }),
      tags: ['vectorized'],
      metadata: { owner: 'ops' },
    });
    warmToolEmbeddings(
      partiallyMissingEmbeddingsTool,
      () => [undefined, [1, 0], [1, 0], [1, 0], [1, 0]] as any,
    );
    expect(getToolEmbeddings(partiallyMissingEmbeddingsTool)).toEqual([]);
    expect(getQueryEmbeddingInfo(() => [], 'query')).toBeUndefined();

    const selfReferentialSchema: any = {
      safeParse() {
        return { success: true };
      },
      _def: {},
    };
    selfReferentialSchema._def.innerType = selfReferentialSchema;
    expect(unwrapSchema(selfReferentialSchema)).toBe(selfReferentialSchema);
  });
});
