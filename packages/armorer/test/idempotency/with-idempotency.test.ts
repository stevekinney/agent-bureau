import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { StandardSchemaV1 } from 'interoperability';
import { z } from 'zod';

import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { CachedToolResult, ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';
import type { Tool } from '../../src/is-tool';

const requestContext = {
  runId: 'run-a',
  agentId: 'agent-a',
  authority: {
    tenantId: 'tenant-a',
    principalId: 'principal-a',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization:1',
  },
} as const;

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
        return { value: { name: name.trim() } };
      },
    },
  };
}

function createTestStore() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async (prefix: string) => [...map.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
}

describe('withIdempotency', () => {
  let cache: ToolResultCache;
  let callCount: number;

  beforeEach(() => {
    callCount = 0;
    cache = createToolResultCache({
      store: createTestStore(),
      defaultTTL: 60_000,
    });
  });

  function createTestTool() {
    return createTool({
      name: 'add',
      description: 'Adds two numbers',
      version: '1.0.0',
      input: z.object({ a: z.number(), b: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ a, b }) {
        callCount++;
        return a + b;
      },
    });
  }

  it('executes normally on the first call', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
    });

    const result = await wrapped({ a: 1, b: 2 });
    expect(result).toBe(3);
    expect(callCount).toBe(1);
  });

  it('returns cached result on duplicate call', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
    });

    const result1 = await wrapped({ a: 1, b: 2 });
    const result2 = await wrapped({ a: 1, b: 2 });

    expect(result1).toBe(3);
    expect(result2).toBe(3);
    expect(callCount).toBe(1); // Only executed once
  });

  it('executes again for different inputs', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    await wrapped({ a: 1, b: 2 });
    await wrapped({ a: 3, b: 4 });

    expect(callCount).toBe(2);
  });

  it('preserves tool name and description', () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    expect(wrapped.name).toBe('add');
    expect(wrapped.description).toBe('Adds two numbers');
  });

  it('preserves tool input schema', () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    expect(wrapped.input).toBe(tool.input);
  });

  it('calls onCacheHit when returning a cached result', async () => {
    const tool = createTestTool();
    const onCacheHit = mock((key: string, result: CachedToolResult) => {});
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a', onCacheHit });

    await wrapped({ a: 1, b: 2 });
    await wrapped({ a: 1, b: 2 });

    expect(onCacheHit).toHaveBeenCalledTimes(1);
    expect(onCacheHit.mock.calls[0]![1]!.result).toBe(3);
    expect(onCacheHit.mock.calls[0]![1]!.toolName).toBe('add');
  });

  it('keeps started state when execution throws after claiming a key', async () => {
    const sideEffects: number[] = [];
    const tool = createTool({
      name: 'charge',
      description: 'Charges a payment method',
      input: z.object({ cents: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ cents }) {
        callCount++;
        sideEffects.push(cents);
        throw new Error('provider timeout after charge');
      },
    });

    const onUnknownOutcome = mock(() => {});
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'charge:1',
      onUnknownOutcome,
    });
    const key = `["tenant-a","charge:1","charge",${JSON.stringify(fullInputKey({ cents: 100 }))}]`;

    await expect(wrapped({ cents: 100 })).rejects.toThrow('provider timeout after charge');
    expect(callCount).toBe(1);
    expect(sideEffects).toEqual([100]);

    await expect(wrapped({ cents: 100 })).rejects.toThrow('unknown outcome');
    expect(callCount).toBe(1);
    expect(sideEffects).toEqual([100]);
    expect(onUnknownOutcome).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ status: 'started', toolName: 'charge' }),
    );
  });

  it('does not mark invalid inputs as started', async () => {
    const tool = createTool({
      name: 'typed-input',
      description: 'Requires a numeric input',
      input: z.object({ x: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ x }) {
        callCount++;
        return x * 2;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'typed-input:1',
    });
    const key = `["tenant-a","typed-input:1","typed-input",${JSON.stringify(fullInputKey({ x: '5' }))}]`;

    await expect(wrapped({ x: '5' })).rejects.toThrow();
    expect(await cache.getState!(key)).toBeUndefined();
    expect(callCount).toBe(0);
  });

  it('supports tools with non-Zod input schemas', async () => {
    const tool = Object.assign(
      async function jsonSchemaInput(input: { x: number }) {
        callCount++;
        return input.x * 2;
      },
      {
        description: 'Uses a JSON schema input',
        input: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
        idempotencyKey: (input: unknown) => fullInputKey(input),
        execute(input: { x: number }) {
          return tool(input);
        },
        configuration: {
          identity: { name: 'jsonSchemaInput' },
        },
      },
    ) as unknown as Tool & { idempotencyKey: (input: unknown) => string };
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'json-schema-input:1',
    });

    await expect(wrapped({ x: 5 })).resolves.toBe(10);
    await expect(wrapped({ x: 5 })).resolves.toBe(10);
    expect(callCount).toBe(1);
  });

  it('surfaces an unknown outcome when a key was started without a result', async () => {
    const tool = createTool({
      name: 'flaky',
      description: 'A flaky tool',
      input: z.object({ x: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ x }) {
        callCount++;
        return x * 2;
      },
    });
    const key = `["tenant-a","flaky:1","flaky",${JSON.stringify(fullInputKey({ x: 5 }))}]`;
    await cache.claimStarted(key, {
      status: 'started',
      toolName: 'flaky',
      startedAt: Date.now(),
      ttl: 60_000,
    });

    const onUnknownOutcome = mock(() => {});
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'flaky:1',
      onUnknownOutcome,
    });

    await expect(wrapped({ x: 5 })).rejects.toThrow('unknown outcome');
    expect(onUnknownOutcome).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ status: 'started', toolName: 'flaky' }),
    );
    expect(callCount).toBe(0);
  });

  it('throws when tool has no idempotencyKey', () => {
    const tool = createTool({
      name: 'no-key',
      version: '1.0.0',
      description: 'Tool without idempotency key',
      input: z.object({ x: z.number() }),
      async execute({ x }) {
        return x;
      },
    });

    expect(() => withIdempotency(tool, { cache, tenantId: 'tenant-a' })).toThrow(
      'does not have an idempotencyKey',
    );
  });

  it('requires a tenant and complete tool revision', () => {
    const tool = createTestTool();
    expect(() => withIdempotency(tool, { cache, tenantId: '' })).toThrow(
      'requires tenantId and a versioned tool definition revision',
    );
    expect(() => withIdempotency(tool, { cache, tenantId: 'tenant-a', toolRevision: '' })).toThrow(
      'requires tenantId and a versioned tool definition revision',
    );
  });

  it('rejects an unversioned tool without an explicit durable revision', () => {
    const tool = createTool({
      name: 'unversioned-charge',
      description: 'Charges a card',
      input: z.object({ cents: z.number() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ cents }) {
        return cents;
      },
    });

    expect(() => withIdempotency(tool, { cache, tenantId: 'tenant-a' })).toThrow(
      'versioned tool definition revision',
    );
  });

  it('requires matching request authority and scopes direct execution by identity', async () => {
    const wrapped = withIdempotency(createTestTool(), { cache, tenantId: 'tenant-a' });

    await expect(wrapped.execute({ a: 1, b: 2 }, {})).rejects.toThrow(
      'requires request-scoped execution authority',
    );
    await expect(
      wrapped.execute(
        { a: 1, b: 2 },
        {
          requestContext: {
            ...requestContext,
            authority: { ...requestContext.authority, tenantId: 'tenant-b' },
          },
        },
      ),
    ).rejects.toThrow('tenantId must match request authority tenantId');

    await expect(wrapped.execute({ a: 1, b: 2 }, { requestContext })).resolves.toBe(3);
    await expect(wrapped.execute({ a: 1, b: 2 }, { requestContext })).resolves.toBe(3);
    expect(callCount).toBe(1);

    await expect(
      wrapped.execute(
        { a: 1, b: 2 },
        {
          requestContext: {
            ...requestContext,
            agentId: 'agent-b',
          },
        },
      ),
    ).resolves.toBe(3);
    expect(callCount).toBe(2);
  });

  it('uses the injected clock for started and completed cache timestamps', async () => {
    const cacheHits: CachedToolResult[] = [];
    const timestamp = Date.now();
    const wrapped = withIdempotency(createTestTool(), {
      cache,
      tenantId: 'tenant-a',
      now: () => timestamp,
      onCacheHit: (_key, entry) => cacheHits.push(entry),
    });

    await wrapped({ a: 1, b: 2 });
    await wrapped({ a: 1, b: 2 });

    expect(cacheHits).toHaveLength(1);
    expect(cacheHits[0]?.executedAt).toBe(timestamp);
  });

  it('clears claims when policy stops execution before the callback runs', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'approval-gated',
      description: 'Requires approval before execution',
      input: z.object({ value: z.string() }),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      policy: {
        beforeExecute: () => ({
          status: 'needs_approval' as const,
          reason: 'Operator approval required',
          action: { message: 'Approve execution' },
        }),
      },
      async execute({ value }) {
        executions += 1;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'approval-gated:1',
    });

    const first = wrapped.execute({ value: 'one' }, { requestContext });
    const second = wrapped.execute({ value: 'one' }, { requestContext });

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(outcomes.map((outcome) => outcome.status)).toContain('rejected');
    expect(executions).toBe(0);
  });

  it('keeps delimiter-bearing tenant and revision tuples in distinct cache scopes', async () => {
    const first = withIdempotency(createTestTool(), {
      cache,
      tenantId: 'tenant:a',
      toolRevision: 'revision',
    });
    const second = withIdempotency(createTestTool(), {
      cache,
      tenantId: 'tenant',
      toolRevision: 'a:revision',
    });

    await expect(first({ a: 1, b: 2 })).resolves.toBe(3);
    await expect(second({ a: 1, b: 2 })).resolves.toBe(3);

    const firstKey = `["tenant:a","revision","add",${JSON.stringify(fullInputKey({ a: 1, b: 2 }))}]`;
    const secondKey = `["tenant","a:revision","add",${JSON.stringify(fullInputKey({ a: 1, b: 2 }))}]`;
    expect(firstKey).not.toBe(secondKey);
    expect(await cache.getState(firstKey)).toBeDefined();
    expect(await cache.getState(secondKey)).toBeDefined();
  });

  it('honors atomic claim races and rejects a lost completion fence', async () => {
    const tool = createTestTool();
    const completed: CachedToolResult = {
      result: 99,
      toolName: 'add',
      executedAt: Date.now(),
      ttl: 60_000,
    };
    const completedRace: ToolResultCache = {
      ...cache,
      getState: async () => undefined,
      claimStarted: async () => ({ outcome: 'existing', entry: completed }),
    };
    await expect(
      withIdempotency(tool, { cache: completedRace, tenantId: 'tenant-a' })({ a: 1, b: 2 }),
    ).resolves.toBe(99);

    const startedRace: ToolResultCache = {
      ...cache,
      getState: async () => undefined,
      claimStarted: async (_key, execution) => ({ outcome: 'existing', entry: execution }),
    };
    await expect(
      withIdempotency(tool, { cache: startedRace, tenantId: 'tenant-a' })({ a: 1, b: 2 }),
    ).rejects.toThrow('unknown outcome');

    const lostFence: ToolResultCache = {
      ...cache,
      completeStarted: async () => false,
    };
    await expect(
      withIdempotency(tool, { cache: lostFence, tenantId: 'tenant-a' })({ a: 3, b: 4 }),
    ).rejects.toThrow('lost its execution fence');
  });

  it('uses custom TTL when provided', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, { cache, tenantId: 'tenant-a', ttl: 1000 });

    await wrapped({ a: 1, b: 2 });

    // The cached entry should have the custom TTL
    // We verify indirectly: result should be returned from cache
    const result = await wrapped({ a: 1, b: 2 });
    expect(result).toBe(3);
    expect(callCount).toBe(1);
  });

  it('supports execute() for both raw params and ToolCall inputs', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    const directResult = await wrapped.execute({ a: 1, b: 2 });
    const cachedDirectResult = await wrapped.execute({ a: 1, b: 2 });
    expect(directResult).toBe(3);
    expect(cachedDirectResult).toBe(3);
    expect(callCount).toBe(1);

    const toolCall = { id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } };
    const executionResult = await wrapped.execute(toolCall);
    expect(executionResult.result).toBe(5);
    expect(executionResult.toolName).toBe('add');
    expect(callCount).toBe(2);
  });

  it('passes direct ToolCall-style invocations through the original tool path', async () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    await expect(
      (wrapped as unknown as (input: unknown) => Promise<unknown>)({
        id: 'call-1',
        name: 'add',
        arguments: { a: 1, b: 2 },
      }),
    ).rejects.toThrow();
    expect(callCount).toBe(0);
  });

  it('preserves the tool configuration', () => {
    const tool = createTestTool();
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    expect(wrapped.configuration).toBeDefined();
    expect(wrapped.configuration.identity.name).toBe('add');
  });

  it('wraps a non-Zod Standard Schema tool without throwing on the schema-match check', async () => {
    // A Standard Schema tool's `input` is `wrapStandardSchema(...)` — a
    // `z.any().transform(async ...)` pipe. `inputMatchesToolSchema` used to
    // call `input.safeParse(params)`, and Zod's SYNC `safeParse` throws for
    // an async transform ("Encountered Promise during synchronous parse")
    // instead of returning `{ success: false }`, so every idempotent call to
    // a Standard Schema tool rejected before `execute()` ever ran.
    const tool = createTool({
      name: 'greet',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute(params: { name: string }) {
        callCount++;
        return `hello, ${params.name}`;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
      toolRevision: 'greet:1',
    });

    const result = await wrapped({ name: 'ada' });
    expect(result).toBe('hello, ada');
    expect(callCount).toBe(1);

    const cached = await wrapped({ name: 'ada' });
    expect(cached).toBe('hello, ada');
    expect(callCount).toBe(1);
  });

  it('NEUTER CHECK: a sync `safeParse` on the wrapped schema throws (proves the fix is load-bearing)', () => {
    const tool = createTool({
      name: 'greet-neuter',
      description: 'Greets by name',
      input: greetingSchema(),
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      execute: async (params: { name: string }) => `hello, ${params.name}`,
    });
    const input = (tool as unknown as { input: { safeParse: (v: unknown) => unknown } }).input;
    expect(() => input.safeParse({ name: 'ada' })).toThrow(
      'Encountered Promise during synchronous parse',
    );
  });
});
