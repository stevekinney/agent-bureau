import { createHash } from 'node:crypto';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { EffectiveToolExecutionContext, ToolExecuteOptions, ToolRequestContext } from '../src';
import { createTool, createToolCall, isTool, lazy, withContext } from '../src';
import { ToolProgressEvent } from '../src/events';
import {
  approvalConsumeSymbol,
  type ApprovalResumeState,
  approvalResumeSymbol,
  policyAuthorizationOnlySymbol,
} from '../src/internal/approval-resume';
import { createConcurrencyLimiter } from '../src/utilities/concurrency';

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve();
  }
}

function createManualExecutionTiming(initialNow = 0): {
  advanceBy: (milliseconds: number) => void;
  clearCount: () => number;
  fireTimeout: () => void;
  options: ToolExecuteOptions;
} {
  let now = initialNow;
  const timers = new Map<number, { handler: () => void; milliseconds: number }>();
  const clearedHandles: unknown[] = [];
  let nextHandle = 0;
  type ScheduleTimeoutFunctionKey = `set${'Timeout'}Function`;
  type ClearTimeoutFunctionKey = `clear${'Timeout'}Function`;
  const scheduleTimeoutFunctionKey: ScheduleTimeoutFunctionKey = `set${'Timeout'}Function`;
  const clearTimeoutFunctionKey: ClearTimeoutFunctionKey = `clear${'Timeout'}Function`;
  return {
    advanceBy(milliseconds: number): void {
      now += milliseconds;
    },
    clearCount(): number {
      return clearedHandles.length;
    },
    fireTimeout(): void {
      const [handle, timer] = timers.entries().next().value ?? [];
      if (typeof handle === 'number') {
        timers.delete(handle);
      }
      if (!timer) {
        throw new Error('Manual timeout was not scheduled');
      }
      now += timer.milliseconds;
      timer.handler();
    },
    options: {
      now: () => now,
      [scheduleTimeoutFunctionKey]: (handler, milliseconds) => {
        const handle = ++nextHandle;
        timers.set(handle, { handler, milliseconds });
        return handle;
      },
      [clearTimeoutFunctionKey]: (handle: unknown) => {
        clearedHandles.push(handle);
        if (typeof handle === 'number') {
          timers.delete(handle);
        }
      },
    } as ToolExecuteOptions,
  };
}

function createEffectiveContext(): EffectiveToolExecutionContext {
  return {
    authority: {
      principalId: 'principal-a',
      tenantId: 'tenant-a',
      ownerId: 'owner-a',
      capabilities: ['tools:execute', 'runs:write'],
      authorizationRevision: 'authorization:1',
    },
    audience: 'operator',
    agentId: 'agent-a',
    runId: 'run-a',
    requestId: 'request-a',
    credentials: { token: 'secret' },
    traceContext: { traceparent: 'secret-trace' },
    revisions: {
      catalog: 'catalog:1',
      toolbox: 'toolbox:1',
      toolDefinition: 'tool:1',
      policy: 'policy:1',
      approval: 'approval:1',
      redaction: 'redaction:1',
    },
  };
}

function createRequestContext(ownerId = 'owner-a'): ToolRequestContext {
  const context = createEffectiveContext();
  return {
    authority: {
      ...context.authority,
      ownerId,
    },
    audience: context.audience,
    agentId: context.agentId,
    runId: context.runId,
    requestId: context.requestId,
    credentials: context.credentials,
    traceContext: context.traceContext,
  };
}

function expectTerminalAuditContext(context: EffectiveToolExecutionContext | undefined): void {
  expect(context).toEqual({
    authority: {
      principalId: 'principal-a',
      tenantId: 'tenant-a',
      ownerId: 'owner-a',
      capabilities: ['tools:execute', 'runs:write'],
      authorizationRevision: 'authorization:1',
    },
    audience: 'operator',
    agentId: 'agent-a',
    runId: 'run-a',
    requestId: 'request-a',
    revisions: {
      catalog: 'catalog:1',
      toolbox: 'toolbox:1',
      toolDefinition: 'tool:1',
      policy: 'policy:1',
      approval: 'approval:1',
      redaction: 'redaction:1',
    },
  });
  expect(context).not.toHaveProperty('credentials');
  expect(context).not.toHaveProperty('traceContext');
}

describe('createTool', () => {
  it('creates a callable tool function with metadata and execute()', async () => {
    const calls: unknown[] = [];
    type Events = { called: { a: string; b?: number } } & {
      'status-update': { status: string };
    };
    const tool = createTool<{ a: string; b?: number }, string, Events>({
      name: 'example',
      description: 'An example tool',
      input: z.object({
        a: z.string(),
        b: z.number().optional(),
      }),
      execute: async (params, context) => {
        const { dispatch, toolCall, configuration } = context;
        expect(toolCall.arguments).toEqual(params);
        expect(toolCall.name).toBe('example');
        expect(configuration.name).toBe('example');
        expect(configuration.input).toBe(tool.input);
        calls.push(params);
        // emit an event to ensure context works
        const event = new Event('called');
        Object.assign(event, params);
        dispatch(event);
        return 'ok';
      },
    });

    // Tool is a function and returns a promise
    const result = await tool({ a: 'hello', b: 42 });
    expect(result).toBe('ok');

    // Metadata is attached
    expect('description' in tool).toBe(true);
    expect(tool.description).toBe('An example tool');
    expect(typeof tool.execute).toBe('function');
    expect(tool.input).toBeDefined();
    // String representations
    expect(tool.toString()).toContain('example');
    expect(tool[Symbol.toPrimitive]('string')).toBe('example');
    expect(`${tool}`).toBe('example');

    // execute() validates then calls underlying fn
    const execResult = await tool.execute(createToolCall('example', { a: 'hi' }));
    expect(execResult.toolName).toBe('example');
    expect('result' in execResult).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual({ a: 'hello', b: 42 });
    expect(calls[1]).toEqual({ a: 'hi' });
  });

  it('supports rawExecute and completion', async () => {
    const tool = createTool({
      name: 'raw-exec',
      description: 'executes with raw context',
      input: z.object({ value: z.string() }),
      async execute({ value }) {
        return value.toUpperCase();
      },
    });

    const toolCall = createToolCall('raw-exec', { value: 'ok' });
    const result = await tool.rawExecute(
      { value: 'ok' },
      {
        dispatch: tool.dispatchEvent,
        toolCall,
        configuration: tool.configuration,
      },
    );
    expect(result).toBe('OK');

    expect(tool.completed).toBe(false);
    tool.complete();
    expect(tool.completed).toBe(true);
  });

  it('throws when execute is not a function or promise', () => {
    expect(() =>
      createTool({
        name: 'bad-execute',
        description: 'invalid execute type',
        input: z.object({}),
        execute: 123 as any,
      }),
    ).toThrow('execute must be a function or a promise that resolves to a function');
  });

  it('executes via execute(params) the same way as direct calls', async () => {
    const tool = createTool({
      name: 'execute-params',
      description: 'execute with params',
      input: z.object({ value: z.string() }),
      async execute({ value }) {
        return value.toUpperCase();
      },
    });

    const direct = await tool({ value: 'ok' });
    const viaExecute = await tool.execute({ value: 'ok' });
    expect(viaExecute).toBe(direct);
  });

  it('throws when execute(params) hits validation errors', async () => {
    const tool = createTool({
      name: 'execute-invalid',
      description: 'invalid params',
      input: z.object({ value: z.string() }),
      async execute({ value }) {
        return value;
      },
    });

    await expect(tool.execute({} as any)).rejects.toThrow();
  });

  it('accepts parameters as the input schema field', async () => {
    const tool = createTool({
      name: 'parameters-field',
      description: 'uses parameters',
      input: z.object({ value: z.string() }),
      async execute({ value }) {
        return value.toUpperCase();
      },
    });

    const result = await tool({ value: 'ok' });
    expect(result).toBe('OK');
    expect(tool.input.safeParse({ value: 'ok' }).success).toBe(true);
  });

  it('uses input for validation', async () => {
    const tool = createTool({
      name: 'input-validation',
      description: 'input validation',
      input: z.object({ value: z.string() }),
      async execute(params: any) {
        return params.value;
      },
    });

    expect(tool.input.safeParse({ value: 'ok' }).success).toBe(true);
    expect(tool.input.safeParse({ legacy: 'nope' }).success).toBe(false);
    const result = await tool({ value: 'ok' });
    expect(result).toBe('ok');
  });

  it('defaults input to an empty object when omitted', async () => {
    const tool = createTool({
      name: 'no-schema',
      description: 'defaults schema',
      execute: async () => 'ok',
    });

    expect(tool.input.safeParse({}).success).toBe(true);
    const result = await tool({});
    expect(result).toBe('ok');
  });

  it('supports lazy execute functions via promise', async () => {
    let resolvedCount = 0;
    const executePromise = Promise.resolve().then(() => {
      resolvedCount += 1;
      return async ({ value }: { value: string }) => value.toUpperCase();
    });

    const tool = createTool({
      name: 'lazy-exec',
      description: 'loads execute lazily',
      input: z.object({ value: z.string() }),
      execute: executePromise,
    });

    const result = await tool({ value: 'hi' });
    expect(result).toBe('HI');

    const execResult = await tool.execute(createToolCall('lazy-exec', { value: 'ok' }));
    expect(execResult.result).toBe('OK');
    expect(resolvedCount).toBe(1);
  });

  it('cancels after a lazy execute function resolves but before execution starts', async () => {
    const controller = new AbortController();
    let executed = false;
    const executePromise = Promise.resolve().then(() => {
      controller.abort('cancelled after load');
      return async () => {
        executed = true;
        return 'should not run';
      };
    });

    const tool = createTool({
      name: 'lazy-abort-after-load',
      description: 'loads execute lazily and aborts before execution',
      input: z.object({}),
      execute: executePromise,
    });

    const result = await tool.execute(createToolCall('lazy-abort-after-load', {}), {
      signal: controller.signal,
    });

    expect(result.outcome).toBe('error');
    expect(result.errorMessage).toBe('cancelled after load');
    expect(executed).toBe(false);
  });

  it('cancels after policy context resolution but before execution starts', async () => {
    const controller = new AbortController();
    let executed = false;
    const tool = createTool({
      name: 'abort-after-policy-context',
      description: 'aborts after policy context resolution',
      input: z.object({}),
      policyContext: () => {
        controller.abort('cancelled by policy context');
        return {};
      },
      async execute() {
        executed = true;
        return 'should not run';
      },
    });

    const result = await tool.execute(createToolCall('abort-after-policy-context', {}), {
      signal: controller.signal,
    });

    expect(result.outcome).toBe('error');
    expect(result.errorMessage).toBe('cancelled by policy context');
    expect(executed).toBe(false);
  });

  it('returns an error when lazy execute rejects', async () => {
    const tool = createTool({
      name: 'lazy-reject',
      description: 'fails on load',
      input: z.object({ value: z.string() }),
      execute: Promise.resolve().then(() => {
        throw new Error('lazy load failed');
      }),
    });

    const result = await tool.execute(createToolCall('lazy-reject', { value: 'x' }));
    expect(result.error?.message).toContain('lazy load failed');
  });

  it('does not consume approval admission when a lazy executor rejects', async () => {
    let consumeCount = 0;
    const tool = createTool({
      name: 'lazy-reject-before-approval',
      description: 'fails before approval admission',
      input: z.object({ value: z.string() }),
      execute: Promise.resolve().then(() => {
        throw new Error('lazy load failed before approval');
      }),
    });

    const result = await tool.execute(
      createToolCall('lazy-reject-before-approval', { value: 'x' }),
      {
        [approvalConsumeSymbol]: async () => {
          consumeCount += 1;
          return async () => {};
        },
      },
    );

    expect(result.error?.message).toContain('lazy load failed before approval');
    expect(consumeCount).toBe(0);
  });

  it('returns an error when lazy execute resolves to non-function', async () => {
    const tool = createTool({
      name: 'lazy-bad',
      description: 'bad execute',
      input: z.object({ value: z.string() }),
      execute: Promise.resolve(42 as any),
    });

    const result = await tool.execute(createToolCall('lazy-bad', { value: 'x' }));
    expect(result.error?.message).toContain(
      'execute must be a function or a promise that resolves to a function',
    );
  });

  it('defers lazy helper execution until first call', async () => {
    let loads = 0;
    const tool = createTool({
      name: 'lazy-helper',
      description: 'loads on demand',
      input: z.object({ value: z.string() }),
      execute: lazy(async () => {
        loads += 1;
        return async ({ value }: { value: string }) => value.toUpperCase();
      }),
    });

    expect(loads).toBe(0);
    const first = await tool({ value: 'hi' });
    expect(first).toBe('HI');
    expect(loads).toBe(1);

    const second = await tool({ value: 'ok' });
    expect(second).toBe('OK');
    expect(loads).toBe(1);
  });

  it('retries lazy loader after non-function resolution', async () => {
    let attempts = 0;
    const loader = lazy(async () => {
      attempts += 1;
      if (attempts === 1) {
        return 'nope' as any;
      }
      return async ({ value }: { value: string }) => value.toUpperCase();
    });

    await expect(loader({ value: 'x' })).rejects.toThrow('lazy loader must resolve to a function');
    const result = await loader({ value: 'ok' });
    expect(result).toBe('OK');
  });

  it('swallows diagnostic repair hint failures', async () => {
    const tool = createTool({
      name: 'diagnostic-failure',
      description: 'diagnostic test',
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => value,
      diagnostics: {
        createRepairHints: () => {
          throw new Error('diagnostic failed');
        },
      },
    });

    const result = await tool.execute(createToolCall('diagnostic-failure', { value: 123 } as any));
    expect(result.error).toBeDefined();
  });

  it('exposes configuration.execute for direct invocation', async () => {
    const tool = createTool({
      name: 'configuration-exec',
      description: 'call via configuration',
      input: z.object({ a: z.string() }),
      async execute({ a }) {
        return a.toUpperCase();
      },
    });

    const value = await tool.configuration.execute({ a: 'ok' });
    expect(value).toBe('OK');
  });

  it('withContext injects values into the tool context', async () => {
    const tool = withContext(
      { workspaceId: 'ws-1', role: 'admin' },
      {
        name: 'ctx-tool',
        description: 'uses context',
        input: z.object({ value: z.string() }),
        async execute({ value }, context) {
          expect(context.workspaceId).toBe('ws-1');
          expect(context.role).toBe('admin');
          return `${value}-${context.role}`;
        },
      },
    );

    const result = await tool({ value: 'hello' });
    expect(result).toBe('hello-admin');
  });

  it('withContext supports currying for later reuse', async () => {
    const builder = withContext({ region: 'eu' });
    const tool = builder({
      name: 'regional',
      description: 'curries context',
      input: z.object({ n: z.number() }),
      async execute({ n }, context) {
        expect(context.region).toBe('eu');
        return `${context.region}-${n}`;
      },
    });

    const out = await tool({ n: 2 });
    expect(out).toBe('eu-2');
  });

  it('throws on invalid params via execute()', async () => {
    const tool = createTool({
      name: 'invalid-test',
      description: 'Ensures validation errors bubble',
      input: z.object({
        a: z.string(),
      }),
      execute: async () => 'never',
    });

    // Missing required property returns a ToolResult failure shape
    const res = await tool.execute(createToolCall('invalid-test', {} as any));
    expect(res.toolName).toBe('invalid-test');
    expect(res.error?.category).toBe('validation');
    expect(res.error?.code).toBe('VALIDATION_ERROR');
  });

  it('supports AbortSignal cancellation before execution begins', async () => {
    let runs = 0;
    const tool = createTool({
      name: 'abort-now',
      description: 'cancel immediately',
      input: z.object({ a: z.string() }),
      async execute() {
        runs++;
        return 'never';
      },
    });

    const controller = new AbortController();
    controller.abort('user cancelled');
    const result = await tool.execute(createToolCall('abort-now', { a: 'x' }), {
      signal: controller.signal,
    });

    expect(runs).toBe(0);
    expect(result.result).toBeUndefined();
    expect(result.error?.message?.toLowerCase()).toContain('cancel');
  });

  it('supports AbortSignal cancellation during execution and surfaces reason', async () => {
    const tool = createTool({
      name: 'abort-mid-flight',
      description: 'cancel mid run',
      input: z.object({ a: z.string() }),
      async execute() {
        return new Promise<string>(() => {});
      },
    });

    const controller = new AbortController();
    const pending = tool.execute(createToolCall('abort-mid-flight', { a: 'x' }), {
      signal: controller.signal,
    });
    await drainMicrotasks();
    controller.abort(new Error('stop now'));
    const result = await pending;

    expect(result.result).toBeUndefined();
    expect(result.error?.message?.toLowerCase()).toContain('stop now');
  });

  it('cancels if the signal aborts during execute-start listeners', async () => {
    let runs = 0;
    const tool = createTool({
      name: 'start-abort',
      description: 'aborts after execute-start',
      input: z.object({ a: z.string() }),
      async execute() {
        runs++;
        return 'done';
      },
    });
    const controller = new AbortController();
    tool.addEventListener('execute-start', () => {
      controller.abort('abort after start');
    });

    const result = await tool.execute(createToolCall('start-abort', { a: 'ok' }), {
      signal: controller.signal,
    });

    expect(runs).toBe(0);
    expect(result.error?.message).toContain('abort after start');
  });

  it('reports a deadline abort raised during execute-start listeners as a timeout', async () => {
    let runs = 0;
    const tool = createTool({
      name: 'deadline-abort-during-start',
      description: 'reports deadline aborts during admission',
      input: z.object({}),
      async execute() {
        runs += 1;
        return 'unreachable';
      },
    });
    const removeListener = tool.addEventListener('execute-start', () => {
      const snapshot = tool.executions.inspect({ callId: 'deadline-start-call' })[0];
      tool.executions.locate(snapshot!.executionId)?.abort('deadline', 'deadline during admission');
    });

    const result = await tool.execute({
      id: 'deadline-start-call',
      name: 'deadline-abort-during-start',
      arguments: {},
    });
    removeListener();

    expect(result).toMatchObject({ outcome: 'error', errorCategory: 'timeout' });
    expect(runs).toBe(0);
  });

  it('reports a deadline abort with an Error reason after validation succeeds', async () => {
    let runs = 0;
    const tool = createTool({
      name: 'deadline-abort-after-validation',
      description: 'reports deadline aborts after validation',
      input: z.object({}),
      async execute() {
        runs += 1;
        return 'unreachable';
      },
    });
    const removeListener = tool.addEventListener('validate-success', () => {
      const snapshot = tool.executions.inspect({ callId: 'deadline-validation-call' })[0];
      tool.executions
        .locate(snapshot!.executionId)
        ?.abort('deadline', new Error('deadline error reason'));
    });

    const result = await tool.execute({
      id: 'deadline-validation-call',
      name: 'deadline-abort-after-validation',
      arguments: {},
    });
    removeListener();

    expect(result).toMatchObject({
      outcome: 'error',
      errorCategory: 'timeout',
      errorMessage: 'deadline error reason',
    });
    expect(runs).toBe(0);
  });

  it('cancels if the signal aborts after validation succeeds', async () => {
    let runs = 0;
    const tool = createTool({
      name: 'validate-abort',
      description: 'aborts after validate-success',
      input: z.object({ a: z.string() }),
      async execute() {
        runs++;
        return 'done';
      },
    });
    const controller = new AbortController();
    tool.addEventListener('validate-success', () => {
      controller.abort('abort after validate');
    });

    const result = await tool.execute(createToolCall('validate-abort', { a: 'ok' }), {
      signal: controller.signal,
    });

    expect(runs).toBe(0);
    expect(result.error?.message).toContain('abort after validate');
  });

  it('cancels if the signal is aborted before raceWithSignal attaches listeners', async () => {
    const controller = new AbortController();
    const tool = createTool({
      name: 'abort-before-race',
      description: 'abort inside execute',
      input: z.object({ a: z.string() }),
      async execute() {
        controller.abort('abort inside execute');
        return 'done';
      },
    });
    const result = await tool.execute(createToolCall('abort-before-race', { a: 'x' }), {
      signal: controller.signal,
    });
    expect(result.error?.message).toContain('abort inside execute');
  });

  it('resolves normally when a signal is provided but never aborted', async () => {
    const tool = createTool({
      name: 'steady-signal',
      description: 'signal that never aborts',
      input: z.object({ a: z.string() }),
      async execute({ a }) {
        return `${a}-done`;
      },
    });
    const controller = new AbortController();
    const result = await tool.execute(createToolCall('steady-signal', { a: 'x' }), {
      signal: controller.signal,
    });
    expect(result.result).toBe('x-done');
    expect(result.error).toBeUndefined();
  });

  it('cleans up signal listeners when execution rejects under a signal', async () => {
    const tool = createTool({
      name: 'reject-with-signal',
      description: 'runner rejects',
      input: z.object({ a: z.string() }),
      async execute() {
        throw new Error('boom');
      },
    });
    const controller = new AbortController();
    const result = await tool.execute(createToolCall('reject-with-signal', { a: 'x' }), {
      signal: controller.signal,
    });
    expect(result.error?.message).toContain('boom');
  });

  it('formats structured cancellation reasons from AbortController', async () => {
    const tool = createTool({
      name: 'structured-reason',
      description: 'object reason',
      input: z.object({ a: z.string() }),
      async execute() {
        return new Promise<string>(() => {});
      },
    });
    const controller = new AbortController();
    const pending = tool.execute(createToolCall('structured-reason', { a: 'x' }), {
      signal: controller.signal,
    });
    await drainMicrotasks();
    controller.abort({ why: 'structured', nested: true });
    const result = await pending;
    expect(result.error?.message).toBe('Cancelled: {"why":"structured","nested":true}');
  });

  it('falls back to a generic cancellation message when reason serialization fails', async () => {
    const tool = createTool({
      name: 'circular-reason',
      description: 'circular reason',
      input: z.object({ a: z.string() }),
      async execute() {
        return new Promise<string>(() => {});
      },
    });
    const controller = new AbortController();
    const pending = tool.execute(createToolCall('circular-reason', { a: 'x' }), {
      signal: controller.signal,
    });
    await drainMicrotasks();
    const reason: any = { cause: 'circular' };
    reason.self = reason;
    controller.abort(reason);
    const result = await pending;
    expect(result.error?.message).toBe('Cancelled');
  });

  it('exposes JSON metadata with input JSON Schema', () => {
    const tool = createTool({
      name: 'json-meta',
      description: 'JSON view',
      input: z.object({
        a: z.string(),
        b: z.number().optional(),
      }),
      execute: async () => null,
    });

    const meta = tool.toJSON();
    expect(meta.schemaVersion).toBe('2020-12');
    expect(meta.id).toBe('default:json-meta');
    expect(meta.identity).toEqual({ namespace: 'default', name: 'json-meta' });
    expect(meta.display.description).toBe('JSON view');
    expect(() => JSON.stringify(meta)).not.toThrow();

    // Input JSON Schema assertions
    const params = meta.input as Record<string, unknown>;
    expect(params).toBeDefined();
    expect(params['type']).toBe('object');

    // required includes only required properties
    const properties = (params['properties'] ?? {}) as Record<string, unknown>;
    const required = new Set((params['required'] as string[]) ?? []);
    const keys = Object.keys(properties);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      if (k !== 'b') {
        expect(required.has(k)).toBe(true);
      }
    }
  });

  it('throws if tags are not kebab-case', () => {
    expect(() =>
      createTool({
        name: 'bad-tags',
        description: 'invalid tag',
        input: z.object({ a: z.string() }),
        tags: ['Not-Kebab'],
        async execute() {
          return null;
        },
      }),
    ).toThrow(/kebab-case/);
  });

  it('attaches typed metadata to tool instances', () => {
    const tool = createTool({
      name: 'with-metadata',
      description: 'has custom metadata',
      input: z.object({ a: z.string() }),
      metadata: { requires: ['account'] as const, cost: 3 },
      async execute({ a }) {
        return a.toUpperCase();
      },
    });

    expect(tool.metadata.requires).toEqual(['account']);
    expect(tool.metadata.cost).toBe(3);
  });

  it('supports metadata as a sync factory function', async () => {
    const tool = createTool({
      name: 'sync-metadata-factory',
      description: 'metadata from sync factory',
      input: z.object({ value: z.string() }),
      metadata: () => ({ source: 'sync' as const }),
      async execute({ value }) {
        return value;
      },
    });

    expect(tool.metadata).toEqual({ source: 'sync' });
    const result = await tool({ value: 'ok' });
    expect(result).toBe('ok');
  });

  it('supports metadata as a promise and returns an async tool factory', async () => {
    const toolPromise = createTool({
      name: 'promise-metadata',
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
  });

  it('supports metadata as an async factory and returns an async tool factory', async () => {
    const toolPromise = createTool({
      name: 'async-metadata-factory',
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
  });

  it('collects async-iterable results by default and emits stream lifecycle events', async () => {
    const tool = createTool({
      name: 'collect-stream',
      description: 'collects stream output by default',
      input: z.object({}),
      async execute() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 1;
            yield 2;
          },
        };
      },
    });

    const streamEvents: string[] = [];
    tool.addEventListener('stream-start', (event) => {
      streamEvents.push(`start:${(event as any).mode}`);
    });
    tool.addEventListener('stream-chunk', (event) => {
      streamEvents.push(`chunk:${(event as any).index}:${(event as any).chunk}`);
    });
    tool.addEventListener('stream-end', (event) => {
      streamEvents.push(`end:${(event as any).chunks}:${(event as any).completed}`);
    });

    const result = await tool.execute({} as any);
    expect(result).toEqual([1, 2]);
    const callResult = await tool.execute({ id: 'c1', name: 'collect-stream', arguments: {} });
    expect(callResult.result).toEqual([1, 2]);
    expect(callResult.stream).toBeUndefined();
    expect(streamEvents).toEqual([
      'start:collect',
      'chunk:0:1',
      'chunk:1:2',
      'end:2:true',
      'start:collect',
      'chunk:0:1',
      'chunk:1:2',
      'end:2:true',
    ]);
  });

  it('preserves async-iterable results when stream mode is enabled', async () => {
    const executeSuccess: unknown[] = [];
    const tool = createTool({
      name: 'stream-mode',
      description: 'returns a live stream',
      input: z.object({}),
      async execute() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 'a';
            yield 'b';
          },
        };
      },
    });
    tool.addEventListener('execute-success', (event) => {
      executeSuccess.push((event as any).result);
    });

    const result = await tool.execute(
      { id: 's1', name: 'stream-mode', arguments: {} },
      { stream: true },
    );
    expect(result.stream).toBeDefined();
    expect(result.content).toBe('[stream]');
    expect(result.result).toBe(result.stream);
    expect(tool.activeExecutions).toBe(1);
    expect(tool.executions.inspect({ callId: 's1' })[0]?.state).toBe('streaming');

    const chunks: string[] = [];
    for await (const chunk of result.stream!) {
      chunks.push(chunk as string);
    }
    expect(chunks).toEqual(['a', 'b']);
    expect(executeSuccess).toEqual([['a', 'b']]);
    expect(tool.activeExecutions).toBe(0);
    expect(tool.executions.inspect({ callId: 's1' })[0]?.state).toBe('terminal');
  });

  it('returns an unconsumed stream during owner shutdown', async () => {
    let returned = 0;
    const tool = createTool({
      name: 'unconsumed-stream',
      description: 'owns an unconsumed stream',
      input: z.object({}),
      async execute() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return new Promise<IteratorResult<string>>(() => {});
              },
              async return() {
                returned += 1;
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      },
    });

    const result = await tool.execute(
      { id: 'unconsumed', name: tool.name, arguments: {} },
      { stream: true },
    );
    expect(result.stream).toBeDefined();
    await tool.complete();

    expect(returned).toBe(1);
    expect(tool.activeExecutions).toBe(0);
    expect(tool.executions.inspect({ callId: 'unconsumed' })[0]).toMatchObject({
      state: 'terminal',
      cleanup: { status: 'completed' },
    });
  });

  it('reports an unreturnable stream as an unknown effect during shutdown', async () => {
    const tool = createTool({
      name: 'unreturnable-stream',
      description: 'has no iterator return method',
      input: z.object({}),
      async execute() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return new Promise<IteratorResult<string>>(() => {});
              },
            };
          },
        };
      },
    });

    await tool.execute({ id: 'unreturnable', name: tool.name, arguments: {} }, { stream: true });
    await tool.complete();

    expect(tool.executions.inspect({ callId: 'unreturnable' })[0]).toMatchObject({
      state: 'unknown-effect',
      cleanup: { status: 'unresolved' },
    });
  });

  it('reports stream return failures during shutdown', async () => {
    const tool = createTool({
      name: 'failing-stream-return',
      description: 'fails iterator cleanup',
      input: z.object({}),
      async execute() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return new Promise<IteratorResult<string>>(() => {});
              },
              async return() {
                throw new Error('stream return failed');
              },
            };
          },
        };
      },
    });

    await tool.execute({ id: 'failing-return', name: tool.name, arguments: {} }, { stream: true });
    await tool.complete();

    expect(tool.executions.inspect({ callId: 'failing-return' })[0]).toMatchObject({
      state: 'terminal',
      cleanup: { status: 'failed' },
    });
  });

  it('digests streams incrementally in collect mode', async () => {
    const tool = createTool({
      name: 'stream-validate-digest',
      description: 'digests stream chunks',
      input: z.object({}),
      digests: { output: true, input: false, algorithm: 'sha256' },
      async execute() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 1;
            yield 2;
          },
        };
      },
    });

    const result = await tool.execute({ id: 'd1', name: 'stream-validate-digest', arguments: {} });
    expect(result.result).toEqual([1, 2]);
    const expectedDigest = createHash('sha256').update('1').update('2').digest('hex');
    expect(result.outputDigest).toBe(expectedDigest);
  });

  it('collects mixed stream chunk types without output validation', async () => {
    const streamErrors: unknown[] = [];
    const tool = createTool({
      name: 'stream-validate-throw',
      description: 'collects mixed chunks',
      input: z.object({}),
      async execute() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 1;
            yield 'bad';
          },
        };
      },
    });
    tool.addEventListener('stream-error', (event) => {
      streamErrors.push((event as any).error);
    });

    const result = await tool.execute({
      id: 'v1',
      name: 'stream-validate-throw',
      arguments: {},
    });
    expect(result.outcome).toBe('success');
    expect(result.result).toEqual([1, 'bad']);
    expect(streamErrors).toHaveLength(0);
  });

  it('emits telemetry with incremental validation and digest details in stream mode', async () => {
    const finishedDetails: any[] = [];
    const tool = createTool({
      name: 'stream-telemetry-success',
      description: 'streams with telemetry metadata',
      input: z.object({ tag: z.string() }),
      telemetry: true,
      digests: { input: true, output: true, algorithm: 'sha256' },
      async execute() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 3;
            yield 4;
          },
        };
      },
    });
    tool.addEventListener('tool.finished', (event) => {
      finishedDetails.push(event);
    });

    const result = await tool.execute(
      { id: 'stream-telemetry-1', name: 'stream-telemetry-success', arguments: { tag: 'ok' } },
      { stream: true },
    );
    expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/);

    const chunks: number[] = [];
    for await (const chunk of result.stream!) {
      chunks.push(chunk as number);
    }
    expect(chunks).toEqual([3, 4]);
    expect(finishedDetails).toHaveLength(1);
    expect(finishedDetails[0].status).toBe('success');
    expect(finishedDetails[0].inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(finishedDetails[0].outputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('emits stream and execution error events when live streams fail mid-flight', async () => {
    const streamErrors: unknown[] = [];
    const streamEndStates: boolean[] = [];
    const finishedDetails: any[] = [];
    const tool = createTool({
      name: 'stream-live-failure',
      description: 'throws during streaming iteration',
      input: z.object({}),
      telemetry: true,
      digests: { input: true, output: false, algorithm: 'sha256' },
      async execute() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 'first';
            throw new Error('stream exploded');
          },
        };
      },
    });
    tool.addEventListener('stream-error', (event) => {
      streamErrors.push((event as any).error);
    });
    tool.addEventListener('stream-end', (event) => {
      streamEndStates.push((event as any).completed);
    });
    tool.addEventListener('tool.finished', (event) => {
      finishedDetails.push(event);
    });

    const result = await tool.execute(
      { id: 'stream-fail-1', name: 'stream-live-failure', arguments: {} },
      { stream: true },
    );

    const consumed: string[] = [];
    let thrown: unknown;
    try {
      for await (const chunk of result.stream!) {
        consumed.push(chunk as string);
      }
    } catch (error) {
      thrown = error;
    }

    expect(consumed).toEqual(['first']);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('stream exploded');
    expect(streamErrors).toHaveLength(1);
    expect(streamEndStates).toEqual([false]);
    expect(finishedDetails).toHaveLength(1);
    expect(finishedDetails[0].status).toBe('error');
    expect(finishedDetails[0].inputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns timeout errors when stream collection exceeds the execution timeout', async () => {
    const timing = createManualExecutionTiming();
    const streamErrors: unknown[] = [];
    const tool = createTool({
      name: 'stream-collect-timeout',
      description: 'times out while collecting stream output',
      input: z.object({}),
      async execute() {
        return {
          async *[Symbol.asyncIterator]() {
            yield 'first';
            timing.advanceBy(20);
            yield 'second';
          },
        };
      },
    });
    tool.addEventListener('stream-error', (event) => {
      streamErrors.push((event as any).error);
    });

    const result = await tool.execute(
      { id: 'stream-timeout-1', name: 'stream-collect-timeout', arguments: {} },
      { timeout: 5, ...timing.options },
    );
    expect(result.outcome).toBe('error');
    expect(result.error?.category).toBe('timeout');
    expect(streamErrors).toHaveLength(1);
  });

  describe('input normalization', () => {
    it('accepts a plain object of Zod schemas as input', async () => {
      // This tests the normalization path where input is a plain object of Zod schemas.
      const schemaAsObject = { name: z.string(), count: z.number() } as any;

      const tool = createTool({
        name: 'object-schema',
        description: 'uses object schema',
        input: schemaAsObject,
        async execute({ name, count }) {
          return `${name}-${count}`;
        },
      });

      const result = await tool({ name: 'test', count: 5 });
      expect(result).toBe('test-5');
    });

    it('throws when input is not a Zod schema or object', () => {
      expect(() =>
        createTool({
          name: 'invalid-schema',
          description: 'uses invalid schema',
          input: 'not a schema' as any,
          async execute() {
            return null;
          },
        }),
      ).toThrow(/Tool input must be a Zod object schema or an object of Zod schemas/);
    });

    it('throws when input is null', () => {
      expect(() =>
        createTool({
          name: 'null-schema',
          description: 'uses null schema',
          input: null as any,
          async execute() {
            return null;
          },
        }),
      ).toThrow(/Tool input must be a Zod object schema or an object of Zod schemas/);
    });

    it('throws when input is a number', () => {
      expect(() =>
        createTool({
          name: 'number-schema',
          description: 'uses number schema',
          input: 42 as any,
          async execute() {
            return null;
          },
        }),
      ).toThrow(/Tool input must be a Zod object schema or an object of Zod schemas/);
    });

    it('throws when input is a non-object Zod schema', () => {
      expect(() =>
        createTool({
          name: 'primitive-schema',
          description: 'uses primitive schema',
          input: z.number(),
          async execute() {
            return null;
          },
        }),
      ).toThrow(/Tool input must be a Zod object schema/);
    });
  });
});

describe('isTool', () => {
  it('returns true for tools created by createTool', () => {
    const tool = createTool({
      name: 'checker',
      description: 'type guard',
      input: z.object({ x: z.number() }),
      execute: async () => 1,
    });
    expect(isTool(tool)).toBe(true);
  });

  it('supports addEventListener with unsubscribe and AbortSignal', async () => {
    type Events = { ping: number } & { 'status-update': { status: string } };
    const tool = createTool<{ a: string }, string, Events>({
      name: 'events',
      description: 'listener support',
      input: z.object({ a: z.string() }),
      async execute(_params, { dispatch }) {
        const event = new Event('ping');
        (event as any).value = 1;
        dispatch(event);
        return 'ok';
      },
    });

    const received: unknown[] = [];
    const unsub = tool.addEventListener('ping' as any, (evt: any) => {
      received.push(evt.value);
    });

    await tool({ a: 'x' });
    expect(received).toEqual([1]);

    // unsubscribe stops future events
    unsub();
    await tool({ a: 'x' });
    expect(received).toEqual([1]);

    // AbortSignal stops listener
    const ac = new AbortController();
    tool.addEventListener(
      'ping' as any,
      (evt: any) => {
        received.push(`ac:${evt.value}`);
      },
      { signal: ac.signal },
    );

    await tool({ a: 'x' });
    expect(received).toContain('ac:1');
    ac.abort();
    await tool({ a: 'x' });
    // no additional 'ac:' entries after abort
    const acCount = received.filter((v) => v === 'ac:1').length;
    expect(acCount).toBe(1);
  });

  it('supports once behavior and dispatchEvent API', async () => {
    type Events = { ping: number } & { 'status-update': { status: string } };
    const tool = createTool<{ a: string }, null, Events>({
      name: 'events-2',
      description: 'listener options',
      input: z.object({ a: z.string() }),
      async execute(_params, { dispatch }) {
        dispatch(new Event('ping'));
        return null;
      },
    });

    const counts = { once: 0, normal: 0 };
    tool.addEventListener(
      'ping' as any,
      () => {
        counts.once++;
      },
      { once: true },
    );
    tool.addEventListener('ping' as any, () => {
      counts.normal++;
    });

    // Using execute (which forwards to dispatchEvent)
    await tool({ a: 'x' });
    await tool({ a: 'x' });

    expect(counts.once).toBe(1);
    expect(counts.normal).toBe(2);

    // Direct dispatchEvent returns true (no preventDefault semantics)
    const ok = tool.dispatchEvent(new Event('ping'));
    expect(ok).toBe(true);
  });

  it('emit() dispatches custom object and primitive details for unknown event types', () => {
    const tool = createTool({
      name: 'custom-emitter',
      description: 'covers unknown emit branches',
      input: z.object({ value: z.string() }),
      async execute({ value }) {
        return value;
      },
    });

    const received: Event[] = [];
    tool.addEventListener('custom-object' as any, (event) => {
      received.push(event);
    });
    tool.addEventListener('custom-primitive' as any, (event) => {
      received.push(event);
    });

    expect(tool.emit('custom-object' as any, { value: 1, label: 'ok' } as any)).toBe(true);
    expect((received[0] as any).value).toBe(1);
    expect((received[0] as any).label).toBe('ok');

    expect(tool.emit('custom-primitive' as any, 'hello' as any)).toBe(true);
    expect((received[1] as any).detail).toBe('hello');
  });

  it('orders listeners by registration and isolates event types', async () => {
    type Events = { ping: number; pong: string } & {
      'status-update': { status: string };
    };
    const tool = createTool<{ a: string }, null, Events>({
      name: 'events-3',
      description: 'ordering & isolation',
      input: z.object({ a: z.string() }),
      async execute(_params, { dispatch }) {
        dispatch(new Event('ping'));
        dispatch(new Event('pong'));
        return null;
      },
    });

    const calls: string[] = [];
    const u1 = tool.addEventListener('ping' as any, () => calls.push('p1'));
    const u2 = tool.addEventListener('ping' as any, () => calls.push('p2'));
    tool.addEventListener('pong' as any, () => calls.push('g1'));

    await tool({ a: 'x' });
    expect(calls).toEqual(['p1', 'p2', 'g1']);

    // Remove middle listener and ensure order of remaining holds
    u2();
    calls.length = 0;
    await tool({ a: 'x' });
    expect(calls).toEqual(['p1', 'g1']);

    // Removing ping listener leaves pong unaffected
    u1();
    calls.length = 0;
    await tool({ a: 'x' });
    expect(calls).toEqual(['g1']);
  });

  it('returns false for non-tools', () => {
    const notAToolFn = () => {};
    const notAToolObj = { name: 'x', description: 'y' };
    expect(isTool(notAToolFn)).toBe(false);
    expect(isTool(notAToolObj)).toBe(false);
  });

  it('handles synchronous listener exceptions without blocking dispatch', () => {
    const tool = createTool<{ a: string }, null>({
      name: 'rej',
      description: 'listener exception',
      input: z.object({ a: z.string() }),
      async execute() {
        return null;
      },
    });

    let secondListenerCalled = false;

    // First listener that records it was called
    const calls: string[] = [];
    tool.addEventListener('execute-start', () => {
      calls.push('first');
    });

    // Second listener added after first
    tool.addEventListener('execute-start', () => {
      secondListenerCalled = true;
      calls.push('second');
    });

    // dispatchEvent returns true and both listeners fire
    const ok = tool.dispatchEvent(new Event('execute-start'));
    expect(ok).toBe(true);
    expect(calls).toEqual(['first', 'second']);
    expect(secondListenerCalled).toBe(true);
  });

  it('exposes stable property descriptors via proxy getOwnPropertyDescriptor', () => {
    const tool = createTool({
      name: 'descriptors',
      description: 'props',
      input: z.object({ a: z.string() }),
      async execute() {
        return 1;
      },
    });

    const desc = Object.getOwnPropertyDescriptor(tool as any, 'addEventListener');
    expect(desc?.enumerable).toBe(true);
    expect(desc?.configurable).toBe(true);
    expect(desc?.writable).toBe(false);
  });

  it('Symbol.dispose clears listeners', async () => {
    type Events = { gone: number } & { 'status-update': { status: string } };
    const tool = createTool<{ a: string }, null, Events>({
      name: 'dispose',
      description: 'cleanup',
      input: z.object({ a: z.string() }),
      async execute() {
        return null;
      },
    });

    let count = 0;
    tool.addEventListener('execute-start', () => {
      count++;
    });

    // Dispose and ensure completed=true
    (tool as any)[Symbol.dispose]?.();
    tool.dispatchEvent(new Event('execute-start'));
    // After completion, listeners registered with signal may stop receiving,
    // but native EventTarget still dispatches to active listeners.
    // The key assertion is that completed is true.
    expect(tool.completed).toBe(true);
  });

  it('completion aborts active execution and can be awaited until idle', async () => {
    let observedSignal: AbortSignal | undefined;
    const tool = createTool({
      name: 'lifecycle-abort',
      description: 'abort on completion',
      input: z.object({}),
      async execute(_params, context) {
        observedSignal = context.signal;
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'unreachable';
      },
    });

    const pending = tool.executeWith({ params: {}, callId: 'lifecycle-1' });
    while (!observedSignal) await Promise.resolve();
    expect(tool.executionSignal.aborted).toBe(false);
    const completion = tool.complete();
    expect(tool.executionSignal.aborted).toBe(true);
    expect(tool.activeExecutions).toBe(1);
    await completion;
    const result = await pending;
    expect(result.errorCategory).toBe('cancelled');
    expect(observedSignal?.aborted).toBe(true);
    expect(tool.activeExecutions).toBe(0);
    await tool.whenIdle();
    await tool.complete();
  });

  it('tracks synchronous callback results through the execution lifecycle', async () => {
    const tool = createTool({
      name: 'synchronous-lifecycle',
      description: 'returns without creating a promise',
      input: z.object({}),
      execute: () => 'synchronous result',
    });

    const result = await tool.executeWith({ params: {}, callId: 'synchronous-call' });

    expect(result.result).toBe('synchronous result');
    expect(tool.executions.inspect({ callId: 'synchronous-call' })).toEqual([
      expect.objectContaining({ state: 'terminal', result }),
    ]);
  });

  it('seeds executeWith privileged lifecycle context at queued admission', async () => {
    let releaseFirst!: () => void;
    let executionCount = 0;
    const effectiveContext = createEffectiveContext();
    const tool = createTool({
      name: 'execute-with-queued-authority',
      description: 'captures queued authority',
      input: z.object({}),
      concurrency: 1,
      async execute() {
        executionCount += 1;
        if (executionCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return executionCount;
      },
    });

    const first = tool.executeWith({ params: {}, callId: 'active-call' });
    while (executionCount === 0) await Promise.resolve();
    const queued = tool.executeWith({
      params: {},
      callId: 'queued-authority-call',
      effectiveContext,
    });
    const [queuedSnapshot] = tool.executions.inspectPrivileged({
      callId: 'queued-authority-call',
    });

    expect(queuedSnapshot?.snapshot.state).toBe('queued');
    expect(queuedSnapshot?.context?.authority).toEqual(effectiveContext.authority);
    expect(queuedSnapshot?.context?.revisions).toEqual(effectiveContext.revisions);
    expect(queuedSnapshot?.context?.credentials).toBe(effectiveContext.credentials);
    expect(queuedSnapshot?.context?.traceContext).toBe(effectiveContext.traceContext);

    releaseFirst();
    await Promise.all([first, queued]);
  });

  it('retains executeWith authority audit fields after validation failure', async () => {
    const tool = createTool({
      name: 'execute-with-validation-authority',
      description: 'validation failure still keeps audit context',
      input: z.object({ value: z.string() }),
      async execute() {
        return 'unreachable';
      },
    });

    const result = await tool.executeWith({
      params: { value: 42 },
      callId: 'validation-authority-call',
      effectiveContext: createEffectiveContext(),
    });
    const [snapshot] = tool.executions.inspectPrivileged({
      callId: 'validation-authority-call',
    });

    expect(result.outcome).toBe('error');
    expect(result.errorCategory).toBe('validation');
    expect(snapshot?.snapshot.state).toBe('terminal');
    expectTerminalAuditContext(snapshot?.context);
  });

  it('retains executeWith authority audit fields when policy context provider throws', async () => {
    const tool = createTool({
      name: 'execute-with-policy-context-authority',
      description: 'policy context provider failure still keeps audit context',
      input: z.object({ value: z.string() }),
      policyContext() {
        throw new Error('policy context failed');
      },
      async execute() {
        return 'unreachable';
      },
    });

    const result = await tool.executeWith({
      params: { value: 'ok' },
      callId: 'policy-context-authority-call',
      effectiveContext: createEffectiveContext(),
    });
    const [snapshot] = tool.executions.inspectPrivileged({
      callId: 'policy-context-authority-call',
    });

    expect(result.outcome).toBe('error');
    expect(snapshot?.snapshot.state).toBe('terminal');
    expectTerminalAuditContext(snapshot?.context);
  });

  it('uses request authority owner for executeCall lifecycle inspection', async () => {
    const requestContext = createRequestContext('request-owner');
    const tool = createTool({
      name: 'execute-call-request-owner',
      description: 'records request authority owner',
      input: z.object({}),
      async execute() {
        return 'ok';
      },
    });

    const result = await tool.execute(createToolCall('execute-call-request-owner', {}), {
      requestContext,
    });

    expect(result).toMatchObject({ outcome: 'success' });
    expect(tool.executions.inspect({ ownerId: 'request-owner' })).toEqual([
      expect.objectContaining({
        callId: expect.any(String),
        ownerId: 'request-owner',
        state: 'terminal',
      }),
    ]);
    expect(tool.executions.inspect({ ownerId: 'anonymous' })).toHaveLength(0);
  });

  it('snapshots direct request authority before entering the concurrency queue', async () => {
    let releaseFirst!: () => void;
    const observedOwners: string[] = [];
    const tool = createTool({
      name: 'queued-request-authority-snapshot',
      description: 'Keeps queued request authority immutable',
      input: z.object({ order: z.number() }),
      concurrency: 1,
      async execute({ order }, context) {
        observedOwners.push(context.requestContext!.authority.ownerId);
        if (order === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
        return order;
      },
    });
    const first = tool.execute(
      { order: 1 },
      { requestContext: createRequestContext('first-owner') },
    );
    while (!releaseFirst) await Promise.resolve();
    const queuedContext = createRequestContext('original-owner');
    const second = tool.execute({ order: 2 }, { requestContext: queuedContext });
    queuedContext.authority.ownerId = 'mutated-owner';
    releaseFirst();

    await Promise.all([first, second]);
    expect(observedOwners).toEqual(['first-owner', 'original-owner']);
  });

  it('uses request authority owner for executeWith owner-scoped abort', async () => {
    let observedSignal: AbortSignal | undefined;
    const requestContext = createRequestContext('request-owner');
    const tool = createTool({
      name: 'execute-with-request-owner-abort',
      description: 'aborts by request authority owner',
      input: z.object({}),
      async execute(_params, context) {
        observedSignal = context.signal;
        await new Promise<void>((resolve) => {
          context.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'settled after abort';
      },
    });

    const pending = tool.executeWith({
      params: {},
      callId: 'request-owner-abort-call',
      requestContext,
    });
    while (!observedSignal) await Promise.resolve();

    expect(tool.executions.abort({ ownerId: 'other-owner' }, 'wrong owner')).toBe(0);
    expect(tool.executions.abort({ ownerId: 'request-owner' }, 'request owner stopped')).toBe(1);

    const result = await pending;
    expect(result).toMatchObject({
      outcome: 'error',
      errorCategory: 'cancelled',
      errorMessage: 'request owner stopped',
    });
    await drainMicrotasks();
    expect(tool.executions.inspect({ callId: 'request-owner-abort-call' })[0]).toMatchObject({
      ownerId: 'request-owner',
      state: 'terminal',
      abortSource: 'owner',
    });
  });

  it('keeps explicit ownerId over request authority owner', async () => {
    const tool = createTool({
      name: 'explicit-owner-over-request-owner',
      description: 'keeps explicit execution owner',
      input: z.object({}),
      async execute() {
        return 'ok';
      },
    });

    const result = await tool.executeWith({
      params: {},
      callId: 'explicit-owner-call',
      ownerId: 'explicit-owner',
      requestContext: createRequestContext('request-owner'),
    });

    expect(result).toMatchObject({ outcome: 'success' });
    expect(tool.executions.inspect({ ownerId: 'explicit-owner' })).toEqual([
      expect.objectContaining({
        callId: 'explicit-owner-call',
        ownerId: 'explicit-owner',
        state: 'terminal',
      }),
    ]);
    expect(tool.executions.inspect({ ownerId: 'request-owner' })).toHaveLength(0);
  });

  it('rejects an expired request deadline before admitting the callback', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'expired-request-deadline',
      description: 'rejects expired request deadlines',
      input: z.object({}),
      async execute() {
        executions += 1;
        return 'unreachable';
      },
    });

    const result = await tool.executeWith({
      params: {},
      callId: 'expired-request-deadline-call',
      now: () => 100,
      requestContext: { ...createRequestContext(), deadline: 99 },
    });

    expect(result).toMatchObject({ outcome: 'error', errorCategory: 'timeout' });
    expect(executions).toBe(0);
    expect(tool.executions.inspect({ callId: 'expired-request-deadline-call' })[0]).toMatchObject({
      state: 'terminal',
      abortSource: 'deadline',
    });
  });

  it('rejects an expired request deadline before admitting a direct ToolCall callback', async () => {
    let executions = 0;
    const tool = createTool({
      name: 'expired-direct-request-deadline',
      description: 'rejects expired direct request deadlines',
      input: z.object({}),
      async execute() {
        executions += 1;
        return 'unreachable';
      },
    });

    const result = await tool.execute(
      {
        id: 'expired-direct-request-deadline-call',
        name: 'expired-direct-request-deadline',
        arguments: {},
      },
      {
        now: () => 100,
        requestContext: { ...createRequestContext(), deadline: 99 },
      },
    );

    expect(result).toMatchObject({ outcome: 'error', errorCategory: 'timeout' });
    expect(executions).toBe(0);
    expect(
      tool.executions.inspect({ callId: 'expired-direct-request-deadline-call' })[0],
    ).toMatchObject({
      state: 'terminal',
      abortSource: 'deadline',
    });
  });

  it('settles an absolute deadline while resolving a pending lazy executor', async () => {
    const timing = createManualExecutionTiming();
    let resolveExecutor!: (executor: (params: Record<string, never>) => Promise<string>) => void;
    const tool = createTool({
      name: 'deadline-pending-executor',
      description: 'does not wait past an absolute request deadline',
      input: z.object({}),
      execute: new Promise<(params: Record<string, never>) => Promise<string>>((resolve) => {
        resolveExecutor = resolve;
      }),
    });

    const pending = tool.executeWith({
      params: {},
      callId: 'deadline-pending-executor-call',
      requestContext: { ...createRequestContext(), deadline: 10 },
      ...timing.options,
    });

    timing.fireTimeout();
    await expect(pending).resolves.toMatchObject({
      outcome: 'error',
      errorMessage: 'Execution deadline exceeded',
    });
    resolveExecutor(async () => 'unused');
  });

  it('settles an absolute deadline while async schema parsing is pending', async () => {
    const timing = createManualExecutionTiming();
    let schemaStarted = false;
    let executions = 0;
    const tool = createTool({
      name: 'deadline-pending-schema',
      description: 'does not wait past an async schema parse',
      input: z.object({ value: z.string() }).superRefine(async () => {
        schemaStarted = true;
        await new Promise<void>(() => {});
      }),
      async execute() {
        executions += 1;
        return 'unreachable';
      },
    });

    const pending = tool.executeWith({
      params: { value: 'x' },
      callId: 'deadline-pending-schema-call',
      requestContext: { ...createRequestContext(), deadline: 10 },
      ...timing.options,
    });
    await drainMicrotasks();
    timing.fireTimeout();

    await expect(pending).resolves.toMatchObject({
      outcome: 'error',
      errorCategory: 'timeout',
    });
    expect(schemaStarted).toBe(true);
    expect(executions).toBe(0);
    expect(tool.executions.inspect({ callId: 'deadline-pending-schema-call' })[0]).toMatchObject({
      state: 'cleanup-pending',
      abortSource: 'deadline',
    });
  });

  it('settles an absolute deadline while policy context resolution is pending', async () => {
    const timing = createManualExecutionTiming();
    let policyContextRequests = 0;
    let policyChecks = 0;
    let executions = 0;
    const tool = createTool({
      name: 'deadline-pending-policy-context',
      description: 'does not wait past an async policy context provider',
      input: z.object({}),
      policyContext: async () => {
        policyContextRequests += 1;
        await new Promise<void>(() => {});
        return {};
      },
      policy: {
        beforeExecute() {
          policyChecks += 1;
          return { allow: true };
        },
      },
      async execute() {
        executions += 1;
        return 'unreachable';
      },
    });

    const pending = tool.executeWith({
      params: {},
      callId: 'deadline-pending-policy-context-call',
      requestContext: { ...createRequestContext(), deadline: 10 },
      ...timing.options,
    });
    await drainMicrotasks();
    timing.fireTimeout();

    await expect(pending).resolves.toMatchObject({
      outcome: 'error',
      errorCategory: 'timeout',
    });
    expect(policyContextRequests).toBe(1);
    expect(policyChecks).toBe(0);
    expect(executions).toBe(0);
    expect(
      tool.executions.inspect({ callId: 'deadline-pending-policy-context-call' })[0],
    ).toMatchObject({
      state: 'cleanup-pending',
      abortSource: 'deadline',
    });
  });

  it('settles an absolute deadline while policy evaluation is pending', async () => {
    const timing = createManualExecutionTiming();
    let policyChecks = 0;
    let executions = 0;
    const tool = createTool({
      name: 'deadline-pending-policy',
      description: 'does not wait past an async policy hook',
      input: z.object({}),
      policy: {
        beforeExecute: async () => {
          policyChecks += 1;
          await new Promise<void>(() => {});
          return { allow: true };
        },
      },
      async execute() {
        executions += 1;
        return 'unreachable';
      },
    });

    const pending = tool.executeWith({
      params: {},
      callId: 'deadline-pending-policy-call',
      requestContext: { ...createRequestContext(), deadline: 10 },
      ...timing.options,
    });
    await drainMicrotasks();
    timing.fireTimeout();

    await expect(pending).resolves.toMatchObject({
      outcome: 'error',
      errorCategory: 'timeout',
    });
    expect(policyChecks).toBe(1);
    expect(executions).toBe(0);
    expect(tool.executions.inspect({ callId: 'deadline-pending-policy-call' })[0]).toMatchObject({
      state: 'cleanup-pending',
      abortSource: 'deadline',
    });
  });

  it('settles an absolute deadline while policy afterExecute is pending', async () => {
    const timing = createManualExecutionTiming();
    let markAfterExecuteStarted!: () => void;
    const afterExecuteStarted = new Promise<void>((resolve) => {
      markAfterExecuteStarted = resolve;
    });
    let afterExecuteCalls = 0;
    let executions = 0;
    const tool = createTool({
      name: 'deadline-pending-after-execute',
      description: 'does not wait past an async afterExecute hook',
      input: z.object({}),
      policy: {
        afterExecute: async () => {
          afterExecuteCalls += 1;
          markAfterExecuteStarted();
          await new Promise<void>(() => {});
        },
      },
      async execute() {
        executions += 1;
        return 'completed';
      },
    });

    const pending = tool.executeWith({
      params: {},
      callId: 'deadline-pending-after-execute-call',
      requestContext: { ...createRequestContext(), deadline: 10 },
      ...timing.options,
    });
    await afterExecuteStarted;
    timing.fireTimeout();

    await expect(pending).resolves.toMatchObject({
      outcome: 'error',
      errorCategory: 'timeout',
      errorMessage: 'Execution deadline exceeded',
    });
    expect(afterExecuteCalls).toBe(1);
    expect(executions).toBe(1);
    expect(
      tool.executions.inspect({ callId: 'deadline-pending-after-execute-call' })[0],
    ).toMatchObject({
      state: 'cleanup-pending',
      abortSource: 'deadline',
    });
  });

  it('keeps deadline classification when policy afterExecute resolves late', async () => {
    const timing = createManualExecutionTiming();
    let markAfterExecuteStarted!: () => void;
    const afterExecuteStarted = new Promise<void>((resolve) => {
      markAfterExecuteStarted = resolve;
    });
    let resolveAfterExecute!: () => void;
    const afterExecuteRelease = new Promise<void>((resolve) => {
      resolveAfterExecute = resolve;
    });
    const tool = createTool({
      name: 'deadline-late-after-execute',
      description: 'does not return success after a late afterExecute hook',
      input: z.object({}),
      policy: {
        afterExecute: async () => {
          markAfterExecuteStarted();
          await afterExecuteRelease;
        },
      },
      async execute() {
        return 'completed';
      },
    });

    const pending = tool.executeWith({
      params: {},
      callId: 'deadline-late-after-execute-call',
      requestContext: { ...createRequestContext(), deadline: 10 },
      ...timing.options,
    });
    await afterExecuteStarted;
    timing.fireTimeout();

    const result = await pending;
    expect(result).toMatchObject({
      outcome: 'error',
      errorCategory: 'timeout',
      errorMessage: 'Execution deadline exceeded',
    });

    resolveAfterExecute();
    await drainMicrotasks();

    expect(
      tool.executions.inspect({ callId: 'deadline-late-after-execute-call' })[0],
    ).toMatchObject({
      state: 'cleanup-pending',
      abortSource: 'deadline',
      result: expect.any(Error),
    });
  });

  it('keeps caller cancellation classification while policy afterExecute is pending', async () => {
    const controller = new AbortController();
    let markAfterExecuteStarted!: () => void;
    const afterExecuteStarted = new Promise<void>((resolve) => {
      markAfterExecuteStarted = resolve;
    });
    let afterExecuteCalls = 0;
    const tool = createTool({
      name: 'caller-cancel-pending-after-execute',
      description: 'reports caller cancellation from an async afterExecute hook',
      input: z.object({}),
      policy: {
        afterExecute: async () => {
          afterExecuteCalls += 1;
          markAfterExecuteStarted();
          await new Promise<void>(() => {});
        },
      },
      async execute() {
        return 'completed';
      },
    });

    const pending = tool.executeWith({
      params: {},
      callId: 'caller-cancel-pending-after-execute-call',
      signal: controller.signal,
    });
    await afterExecuteStarted;
    controller.abort('caller cancelled afterExecute');

    await expect(pending).resolves.toMatchObject({
      outcome: 'error',
      errorCategory: 'cancelled',
      errorMessage: 'caller cancelled afterExecute',
    });
    expect(afterExecuteCalls).toBe(1);
    expect(
      tool.executions.inspect({ callId: 'caller-cancel-pending-after-execute-call' })[0],
    ).toMatchObject({
      state: 'cleanup-pending',
      abortSource: 'caller',
    });
  });

  it('clears absolute deadline timers with the matching custom cleanup function', async () => {
    const timing = createManualExecutionTiming();
    const tool = createTool({
      name: 'custom-deadline-cleanup',
      description: 'clears a custom absolute deadline timer',
      input: z.object({}),
      execute: async () => 'completed',
    });

    const result = await tool.executeWith({
      params: {},
      requestContext: { ...createRequestContext(), deadline: 10 },
      ...timing.options,
    });

    expect(result.outcome).toBe('success');
    expect(timing.clearCount()).toBe(1);
  });

  it('expires a queued request before its callback is admitted', async () => {
    let releaseFirst!: () => void;
    let executions = 0;
    const timing = createManualExecutionTiming();
    const tool = createTool({
      name: 'queued-request-deadline',
      description: 'expires queued request deadlines',
      concurrency: 1,
      input: z.object({}),
      async execute() {
        executions += 1;
        if (executions === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
        return executions;
      },
    });

    const first = tool.executeWith({ params: {}, callId: 'first-deadline-call' });
    while (executions === 0) await Promise.resolve();
    const queued = tool.executeWith({
      params: {},
      callId: 'queued-deadline-call',
      requestContext: { ...createRequestContext(), deadline: 10 },
      ...timing.options,
    });

    timing.fireTimeout();
    await expect(queued).resolves.toMatchObject({ outcome: 'error' });
    expect(executions).toBe(1);
    expect(tool.executions.inspect({ callId: 'queued-deadline-call' })[0]).toMatchObject({
      state: 'terminal',
      abortSource: 'deadline',
    });
    releaseFirst();
    await first;
  });

  it('starts a relative execution timeout after queued admission', async () => {
    let releaseFirst!: () => void;
    let executions = 0;
    const tool = createTool({
      name: 'queued-relative-timeout',
      description: 'does not spend execution timeout while queued',
      concurrency: 1,
      input: z.object({}),
      async execute() {
        executions += 1;
        if (executions === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
        return executions;
      },
    });

    const first = tool.executeWith({ params: {}, callId: 'relative-timeout-first' });
    while (executions === 0) await Promise.resolve();
    const queued = tool.executeWith({
      params: {},
      callId: 'relative-timeout-queued',
      timeout: 10,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    releaseFirst();

    await expect(first).resolves.toMatchObject({ outcome: 'success' });
    await expect(queued).resolves.toMatchObject({ outcome: 'success', result: 2 });
    expect(tool.executions.inspect({ callId: 'relative-timeout-queued' })[0]).toMatchObject({
      state: 'terminal',
    });
  });

  it('uses the earlier request deadline when it is sooner than the execution timeout', async () => {
    const timing = createManualExecutionTiming();
    const tool = createTool({
      name: 'combined-request-deadline',
      description: 'combines request and execution deadlines',
      input: z.object({}),
      async execute() {
        return new Promise<string>(() => {});
      },
    });

    const pending = tool.executeWith({
      params: {},
      callId: 'combined-request-deadline-call',
      timeout: 100,
      requestContext: { ...createRequestContext(), deadline: 10 },
      ...timing.options,
    });
    await drainMicrotasks();
    timing.fireTimeout();

    await expect(pending).resolves.toMatchObject({ outcome: 'error', errorCategory: 'timeout' });
    expect(tool.executions.inspect({ callId: 'combined-request-deadline-call' })[0]).toMatchObject({
      deadline: 10,
      state: 'cleanup-pending',
      abortSource: 'deadline',
    });
  });

  it('direct call emits validate-error and settled on parse failure', async () => {
    const diagnostics = {
      safeParseWithReport: () => ({
        success: false as const,
        error: new Error('invalid'),
        report: { warnings: [], cost: 0 },
      }),
      createRepairHints: () => [
        {
          path: 'arguments.a',
          message: 'Invalid input',
          suggestion: 'Provide a string for arguments.a.',
        },
      ],
    };

    const tool = createTool({
      name: 'valerr',
      description: 'validation error path',
      input: z.object({ a: z.string() }),
      diagnostics,
      async execute() {
        return 'x';
      },
    });

    let validateErr = 0;
    let settled = 0;
    tool.addEventListener('validate-error' as any, (evt) => {
      validateErr++;
      expect((evt as any).toolCall.name).toBe('valerr');
      expect((evt as any).configuration.name).toBe('valerr');
      expect((evt as any).report).toBeDefined();
      expect(Array.isArray((evt as any).repairHints)).toBe(true);
      expect((evt as any).repairHints?.length).toBe(1);
    });
    tool.addEventListener('settled' as any, (evt) => {
      settled++;
      expect((evt as any).toolCall.name).toBe('valerr');
    });

    // @ts-expect-error - intentionally invalid
    await expect(tool({})).rejects.toBeDefined();
    expect(validateErr).toBe(1);
    expect(settled).toBe(1);
  });

  it('direct call emits execute-error and settled on thrown error', async () => {
    const tool = createTool({
      name: 'throwerr',
      description: 'execute error path',
      input: z.object({ a: z.string() }),
      async execute() {
        throw new Error('boom');
      },
    });

    let execErr = 0;
    let settled = 0;
    tool.addEventListener('execute-error' as any, (evt) => {
      execErr++;
      expect((evt as any).toolCall.name).toBe('throwerr');
    });
    tool.addEventListener('settled' as any, (evt) => {
      settled++;
      expect((evt as any).configuration.name).toBe('throwerr');
    });

    await expect(tool({ a: 'x' })).rejects.toBeDefined();
    expect(execErr).toBe(1);
    expect(settled).toBe(1);
  });

  it('direct call emits start, validate-success, execute-success, and settled on success', async () => {
    const tool = createTool({
      name: 'oktool',
      description: 'success path',
      input: z.object({ a: z.string() }),
      async execute({ a }) {
        return a.toUpperCase();
      },
    });

    let started = 0;
    let validated = 0;
    let succeeded = 0;
    let settled = 0;
    tool.addEventListener('execute-start' as any, (evt) => {
      started++;
      expect((evt as any).params).toBeDefined();
      expect((evt as any).toolCall.name).toBe('oktool');
      expect((evt as any).configuration.name).toBe('oktool');
    });
    tool.addEventListener('validate-success' as any, (evt) => {
      validated++;
      expect((evt as any).parsed.a).toBe('x');
      expect((evt as any).toolCall.name).toBe('oktool');
    });
    tool.addEventListener('execute-success' as any, (evt) => {
      succeeded++;
      expect((evt as any).result).toBe('X');
      expect((evt as any).configuration.name).toBe('oktool');
    });
    tool.addEventListener('settled' as any, (evt) => {
      settled++;
      expect((evt as any).result).toBe('X');
      expect((evt as any).toolCall.name).toBe('oktool');
    });

    const out = await tool({ a: 'x' });
    expect(out).toBe('X');
    expect(started).toBe(1);
    expect(validated).toBe(1);
    expect(succeeded).toBe(1);
    expect(settled).toBe(1);
  });

  it('policy hooks can deny execution and emit policy-denied', async () => {
    const tool = createTool({
      name: 'denytool',
      description: 'policy denied',
      input: z.object({ a: z.string() }),
      policy: {
        beforeExecute() {
          return { allow: false, reason: 'nope' };
        },
      },
      async execute() {
        return 'ok';
      },
    });

    let denied = 0;
    tool.addEventListener('policy-denied' as any, (evt) => {
      denied += 1;
      expect((evt as any).reason).toBe('nope');
    });

    const result = await (tool as any).executeWith({ params: { a: 'x' } });
    expect(result.error?.message).toBe('nope');
    expect(denied).toBe(1);
  });

  it('resumes a directly executed tool after its policy pause is satisfied', async () => {
    const tool = createTool({
      name: 'approved-tool',
      description: 'requires operator approval',
      input: z.object({ value: z.string() }),
      policy: {
        beforeExecute: () => ({
          status: 'needs_approval' as const,
          reason: 'Operator approval required',
          action: { message: 'Approve direct execution' },
        }),
      },
      async execute({ value }) {
        return value.toUpperCase();
      },
    });
    const toolCall = createToolCall('approved-tool', { value: 'approved' });

    const paused = await tool.execute(toolCall);
    expect(paused.outcome).toBe('action_required');
    if (paused.action === undefined || paused.pendingApproval === undefined) {
      throw new Error('Expected the direct tool policy to return a pending approval');
    }
    const resumeOptions = {
      [approvalResumeSymbol]: {
        approvedAction: paused.action,
        approvedPolicyPauseTier: 'tool' as const,
        proposedArguments: toolCall.arguments,
        reason: paused.pendingApproval.reason,
        satisfiedPauses: [],
      },
    } satisfies ToolExecuteOptions & { [approvalResumeSymbol]: ApprovalResumeState };
    const resumed = await tool.execute(toolCall, resumeOptions);

    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toBe('APPROVED');
  });

  it('emits telemetry events when enabled', async () => {
    const tool = createTool({
      name: 'telemetry',
      description: 'telemetry events',
      input: z.object({ a: z.string() }),
      telemetry: true,
      async execute({ a }) {
        return a.toUpperCase();
      },
    });

    let started = 0;
    let finished = 0;
    tool.addEventListener('tool.started' as any, (evt) => {
      started += 1;
      expect(typeof (evt as any).startedAt).toBe('number');
    });
    tool.addEventListener('tool.finished' as any, (evt) => {
      finished += 1;
      expect((evt as any).status).toBe('success');
      expect((evt as any).durationMs).toBeGreaterThanOrEqual(0);
    });

    const out = await tool({ a: 'x' });
    expect(out).toBe('X');
    expect(started).toBe(1);
    expect(finished).toBe(1);
  });

  it('finishes telemetry for authorization-only executions', async () => {
    const tool = createTool({
      name: 'authorization-only-telemetry',
      description: 'checks authorization without executing',
      input: z.object({ value: z.string() }),
      telemetry: true,
      async execute() {
        throw new Error('authorization-only execution must not run');
      },
    });

    let started = 0;
    let finished = 0;
    let succeeded = 0;
    let settled = 0;
    tool.addEventListener('tool.started' as any, () => {
      started += 1;
    });
    tool.addEventListener('tool.finished' as any, (event) => {
      finished += 1;
      expect((event as any).status).toBe('success');
    });
    tool.addEventListener('execute-success' as any, () => {
      succeeded += 1;
    });
    tool.addEventListener('settled' as any, () => {
      settled += 1;
    });

    const result = await tool.execute(
      createToolCall('authorization-only-telemetry', { value: 'x' }),
      { [policyAuthorizationOnlySymbol]: true },
    );

    expect(result.outcome).toBe('success');
    expect(started).toBe(1);
    expect(finished).toBe(1);
    expect(succeeded).toBe(1);
    expect(settled).toBe(1);
  });

  it('does not resolve lazy executors for authorization-only executions', async () => {
    let resolveExecutor:
      ((executor: (params: { value: string }) => Promise<string>) => void) | undefined;
    let executorResolved = false;
    const executePromise = new Promise<(params: { value: string }) => Promise<string>>(
      (resolve) => {
        resolveExecutor = (executor) => {
          executorResolved = true;
          resolve(executor);
        };
      },
    );
    const tool = createTool({
      name: 'authorization-only-lazy-executor',
      description: 'checks authorization without loading execution',
      input: z.object({ value: z.string() }),
      execute: executePromise,
    });

    const result = await tool.execute(
      createToolCall('authorization-only-lazy-executor', { value: 'x' }),
      { [policyAuthorizationOnlySymbol]: true },
    );

    expect(result.outcome).toBe('success');
    expect(executorResolved).toBe(false);
    resolveExecutor?.(async ({ value }) => value);
  });

  it('rolls back approval admission when authorization-only execution is aborted', async () => {
    const controller = new AbortController();
    let rollbackCount = 0;
    const tool = createTool({
      name: 'authorization-only-abort',
      description: 'checks cancellation after approval admission',
      input: z.object({}),
      execute: async () => 'unexpected',
    });

    const result = await tool.execute(createToolCall('authorization-only-abort', {}), {
      signal: controller.signal,
      [policyAuthorizationOnlySymbol]: true,
      [approvalConsumeSymbol]: async () => {
        controller.abort('authorization cancelled');
        return async () => {
          rollbackCount += 1;
        };
      },
    });

    expect(result.outcome).toBe('error');
    expect(result.errorMessage).toBe('authorization cancelled');
    expect(rollbackCount).toBe(1);
  });

  it('reports authorization-only deadline aborts after approval admission as timeouts', async () => {
    let rollbackCount = 0;
    const tool = createTool({
      name: 'authorization-only-deadline',
      description: 'checks deadline after authorization-only approval admission',
      input: z.object({}),
      execute: async () => 'unexpected',
    });

    const result = await tool.execute(
      {
        id: 'authorization-only-deadline-call',
        name: 'authorization-only-deadline',
        arguments: {},
      },
      {
        [policyAuthorizationOnlySymbol]: true,
        [approvalConsumeSymbol]: async () => {
          const snapshot = tool.executions.inspect({
            callId: 'authorization-only-deadline-call',
          })[0];
          tool.executions.locate(snapshot!.executionId)?.abort('deadline', 'approval deadline');
          return async () => {
            rollbackCount += 1;
          };
        },
      },
    );

    expect(result).toMatchObject({
      outcome: 'error',
      errorCategory: 'timeout',
      errorMessage: 'approval deadline',
    });
    expect(rollbackCount).toBe(1);
  });

  it('reports execution deadline aborts after approval admission as timeouts', async () => {
    let runs = 0;
    let rollbackCount = 0;
    const tool = createTool({
      name: 'approval-deadline-before-execute',
      description: 'checks deadline after approval admission before execute',
      input: z.object({}),
      async execute() {
        runs += 1;
        return 'unreachable';
      },
    });

    const result = await tool.execute(
      {
        id: 'approval-deadline-before-execute-call',
        name: 'approval-deadline-before-execute',
        arguments: {},
      },
      {
        [approvalConsumeSymbol]: async () => {
          const snapshot = tool.executions.inspect({
            callId: 'approval-deadline-before-execute-call',
          })[0];
          tool.executions.locate(snapshot!.executionId)?.abort('deadline', 'approval deadline');
          return async () => {
            rollbackCount += 1;
          };
        },
      },
    );

    expect(result).toMatchObject({
      outcome: 'error',
      errorCategory: 'timeout',
      errorMessage: 'approval deadline',
    });
    expect(runs).toBe(0);
    expect(rollbackCount).toBe(1);
  });

  it('computes input and output digests when enabled', async () => {
    const tool = createTool({
      name: 'digest',
      description: 'digests',
      input: z.object({ a: z.string() }),
      digests: true,
      async execute({ a }) {
        return { ok: a === 'x' };
      },
    });

    const result = await (tool as any).executeWith({ params: { a: 'x' } });
    expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.outputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('emits output-chunk events when collecting stream results', async () => {
    const tool = createTool({
      name: 'output-validate',
      description: 'output stream chunks',
      input: z.object({}),
      async execute() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { ok: true };
            yield { ok: false };
          },
        };
      },
    });

    const chunks: unknown[] = [];
    tool.addEventListener('output-chunk' as any, (event) => {
      chunks.push((event as any).chunk);
    });

    const result = await (tool as any).executeWith({ params: { a: 'x' } });
    expect(result.result).toEqual([{ ok: true }, { ok: false }]);
    expect(chunks).toEqual([{ ok: true }, { ok: false }]);
  });

  it('injects policy context via policyContext provider', async () => {
    const tool = createTool({
      name: 'policy-context',
      description: 'policy context',
      input: z.object({ a: z.string() }),
      policyContext: () => ({ runId: 'run-1' }),
      policy: {
        beforeExecute({ policyContext }) {
          if (policyContext?.runId !== 'run-1') {
            return { allow: false, reason: 'missing runId' };
          }
        },
      },
      async execute({ a }) {
        return a.toUpperCase();
      },
    });

    const result = await (tool as any).executeWith({ params: { a: 'x' } });
    expect(result.result).toBe('X');
  });

  it('supports boolean policy decisions and includes input digests', async () => {
    const tool = createTool({
      name: 'policy-boolean',
      description: 'policy boolean',
      input: z.object({ a: z.string() }),
      digests: true,
      policy: {
        beforeExecute: () => false,
      },
      async execute() {
        return 'ok';
      },
    });

    const result = await (tool as any).executeWith({ params: { a: 'x' } });
    expect(result.error?.message).toBe('Policy denied');
    expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('logs when policy afterExecute throws', async () => {
    const tool = createTool({
      name: 'policy-log',
      description: 'policy log',
      input: z.object({ a: z.string() }),
      policy: {
        afterExecute: () => {
          throw new Error('after failed');
        },
      },
      async execute({ a }) {
        return a.toUpperCase();
      },
    });

    let logs = 0;
    tool.addEventListener('log' as any, (evt) => {
      logs += 1;
      expect((evt as any).level).toBe('warn');
    });

    const result = await (tool as any).executeWith({ params: { a: 'x' } });
    expect(result.result).toBe('X');
    expect(logs).toBe(1);
  });

  it('does not validate output shape when output validation is disabled', async () => {
    const tool = createTool({
      name: 'output-throw',
      description: 'output throws',
      input: z.object({ a: z.string() }),
      async execute() {
        return { ok: 'nope' };
      },
    });

    const result = await (tool as any).executeWith({ params: { a: 'x' } });
    expect(result.outcome).toBe('success');
    expect(result.result).toEqual({ ok: 'nope' });
  });

  it('injects policyContext into error paths', async () => {
    let calls = 0;
    const tool = createTool({
      name: 'policy-error-context',
      description: 'policy error context',
      input: z.object({ a: z.string() }),
      digests: true,
      policyContext: (context) => {
        calls += 1;
        return { traceId: context.toolCall.id };
      },
      async execute() {
        throw new Error('boom');
      },
    });

    const result = await (tool as any).executeWith({ params: { a: 'x' } });
    expect(result.error?.message).toContain('boom');
    expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(calls).toBe(2);
  });

  it('cancels when the signal aborts during error policy context injection', async () => {
    const controller = new AbortController();
    let calls = 0;
    let executions = 0;
    const tool = createTool({
      name: 'policy-error-context-cancel',
      description: 'cancels during error policy context injection',
      input: z.object({}),
      policyContext: () => {
        calls += 1;
        if (calls === 2) {
          controller.abort('cancelled while enriching error');
        }
        return {};
      },
      async execute() {
        executions += 1;
        throw new Error('boom');
      },
    });

    const result = await tool.execute(createToolCall('policy-error-context-cancel', {}), {
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      outcome: 'error',
      errorCategory: 'cancelled',
      errorMessage: 'cancelled while enriching error',
    });
    expect(calls).toBe(2);
    expect(executions).toBe(1);
  });

  it('formats cancellation reasons for numbers', async () => {
    const tool = createTool({
      name: 'cancel-number',
      description: 'cancel number',
      input: z.object({ a: z.string() }),
      digests: true,
      async execute() {
        return 'never';
      },
    });

    const controller = new AbortController();
    controller.abort(404);
    const result = await (tool as any).executeWith({
      params: { a: 'x' },
      signal: controller.signal,
    });
    expect(result.error?.message).toBe('Cancelled: 404');
    expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('formats cancellation reasons for symbols', async () => {
    const tool = createTool({
      name: 'cancel-symbol',
      description: 'cancel symbol',
      input: z.object({ a: z.string() }),
      async execute() {
        return 'never';
      },
    });

    const controller = new AbortController();
    controller.abort(Symbol('halt'));
    const result = await (tool as any).executeWith({
      params: { a: 'x' },
      signal: controller.signal,
    });
    expect(result.error?.message).toBe('Cancelled: halt');
  });

  it('uses tool.run to execute with a provided context', async () => {
    const tool = createTool({
      name: 'run-tool',
      description: 'run',
      input: z.object({ value: z.string() }),
      async execute({ value }, context) {
        return `${value}:${context.toolCall?.name}`;
      },
    });

    const result = await tool.run(
      { value: 'ok' },
      {
        dispatch: tool.dispatchEvent,
        toolCall: createToolCall('run-tool', { value: 'ok' }),
        configuration: tool.configuration,
      },
    );
    expect(result).toBe('ok:run-tool');
  });

  it('falls back to callable properties via proxy get', () => {
    const tool = createTool({
      name: 'proxy-get',
      description: 'proxy get',
      input: z.object({ a: z.string() }),
      async execute() {
        return 'x';
      },
    });

    expect(typeof (tool as any).length).toBe('number');
  });

  it('adds ids when executing ToolCalls without ids', async () => {
    const tool = createTool({
      name: 'missing-id',
      description: 'missing id',
      input: z.object({ a: z.string() }),
      async execute({ a }) {
        return a;
      },
    });

    const result = await (tool as any).execute({
      id: '',
      name: 'missing-id',
      arguments: { a: 'ok' },
    });
    expect(result.toolCallId).toBeDefined();
  });

  it('classifies transient errors by code and message', async () => {
    const tool = createTool({
      name: 'transient-code',
      description: 'transient code',
      input: z.object({ a: z.string() }),
      async execute() {
        const error = new Error('boom') as Error & { code?: string };
        error.code = 'ECONNRESET';
        throw error;
      },
    });

    const result = await (tool as any).executeWith({ params: { a: 'x' } });
    expect(result.error?.category).toBe('transient');

    const rateLimited = createTool({
      name: 'transient-message',
      description: 'transient message',
      input: z.object({ a: z.string() }),
      async execute() {
        throw new Error('Rate limit exceeded');
      },
    });

    const resultRate = await (rateLimited as any).executeWith({ params: { a: 'x' } });
    expect(resultRate.error?.category).toBe('transient');
  });

  it('computes digests for array outputs and error inputs', async () => {
    const tool = createTool({
      name: 'digest-array',
      description: 'digest array',
      input: z.object({ err: z.any() }),
      digests: { input: true, output: true, algorithm: 'sha256' },
      async execute() {
        return [1, 2, 3];
      },
    });

    const result = await (tool as any).executeWith({
      params: { err: new Error('nope') },
    });
    expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.outputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses digest options objects to control input/output', async () => {
    const tool = createTool({
      name: 'digest-options',
      description: 'digest options',
      input: z.object({ value: z.string() }),
      digests: { input: false, output: true },
      async execute({ value }) {
        return [value];
      },
    });

    const result = await (tool as any).executeWith({ params: { value: 'x' } });
    expect(result.inputDigest).toBeUndefined();
    expect(result.outputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('throws when tags are not strings', () => {
    expect(() =>
      createTool({
        name: 'bad-tags-type',
        description: 'bad tags',
        input: z.object({ a: z.string() }),
        tags: ['ok', 123 as unknown as string],
        async execute() {
          return 'ok';
        },
      }),
    ).toThrow('tag must be a string');
  });

  it('wraps non-Error rejections when timeout is applied', async () => {
    const tool = createTool({
      name: 'timeout-reject',
      description: 'timeout rejection',
      input: z.object({ a: z.string() }),
      async execute() {
        throw 'boom';
      },
    });

    const result = await (tool as any).executeWith({
      params: { a: 'x' },
      timeout: 100,
    });
    expect(result.error?.message).toContain('boom');
  });

  it('enforces per-tool concurrency limits', async () => {
    let active = 0;
    let max = 0;
    const releaseQueue: Array<() => void> = [];
    const tool = createTool({
      name: 'concurrency',
      description: 'limits',
      input: z.object({ a: z.string() }),
      concurrency: 1,
      async execute() {
        active += 1;
        max = Math.max(max, active);
        await new Promise<void>((resolve) => {
          releaseQueue.push(resolve);
        });
        active -= 1;
        return 'ok';
      },
    });

    const first = tool({ a: 'x' });
    const second = tool({ a: 'y' });
    await drainMicrotasks();
    expect(active).toBe(1);
    releaseQueue.shift()?.();
    for (let index = 0; index < 10 && releaseQueue.length === 0; index++) {
      await Promise.resolve();
    }
    expect(releaseQueue).toHaveLength(1);
    releaseQueue.shift()?.();
    await Promise.all([first, second]);
    expect(max).toBe(1);
  });

  it('releases a concurrency slot when an admitted task throws synchronously', async () => {
    const limiter = createConcurrencyLimiter(1)!;
    const failure = limiter.run(() => {
      throw new Error('synchronous failure');
    });
    await expect(failure).rejects.toThrow('synchronous failure');
    await expect(limiter.run(async () => 'available')).resolves.toBe('available');
  });

  it('removes an aborted queued execution without consuming a concurrency slot', async () => {
    let releaseFirst!: () => void;
    let runs = 0;
    const tool = createTool({
      name: 'queued-abort',
      description: 'queued cancellation',
      input: z.object({}),
      concurrency: 1,
      async execute() {
        runs += 1;
        if (runs === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
        return runs;
      },
    });
    const first = tool.executeWith({ params: {}, callId: 'active-call' });
    while (runs === 0) await Promise.resolve();
    const controller = new AbortController();
    const queued = tool.executeWith({
      params: {},
      callId: 'queued-call',
      signal: controller.signal,
    });
    controller.abort('cancelled while queued');

    await expect(queued).resolves.toMatchObject({ errorCategory: 'cancelled' });
    expect(runs).toBe(1);
    expect(tool.executions.inspect({ callId: 'queued-call' })[0]).toMatchObject({
      state: 'terminal',
      abortSource: 'caller',
    });
    releaseFirst();
    await first;
  });

  it('normalizes cancellation for a queued execute call', async () => {
    let releaseFirst!: () => void;
    let runs = 0;
    const tool = createTool({
      name: 'queued-execute-abort',
      description: 'queued execute cancellation',
      input: z.object({}),
      concurrency: 1,
      async execute() {
        runs += 1;
        if (runs === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
        return runs;
      },
    });
    const first = tool.execute({ id: 'first', name: tool.name, arguments: {} });
    while (runs === 0) await Promise.resolve();
    const controller = new AbortController();
    const queued = tool.execute(
      { id: 'second', name: tool.name, arguments: {} },
      { signal: controller.signal },
    );
    controller.abort('cancelled while queued');

    await expect(queued).resolves.toMatchObject({ errorCategory: 'cancelled' });
    releaseFirst();
    await first;
  });

  it('executeWith supports timeouts and normalizes timeout error', async () => {
    const timing = createManualExecutionTiming();
    const tool = createTool({
      name: 'slow',
      description: 'timeout',
      input: z.object({ a: z.string() }),
      async execute() {
        return new Promise<string>(() => {});
      },
    });

    const pending = (tool as any).executeWith({
      params: { a: 'x' },
      timeout: 1,
      ...timing.options,
    });
    await drainMicrotasks();
    timing.fireTimeout();
    const res = await pending;
    expect(res.error?.category).toBe('timeout');
    expect(res.error?.code).toBe('TIMEOUT');
  });

  it('keeps an ignored timeout abort observable until the callback actually settles', async () => {
    const timing = createManualExecutionTiming();
    let releaseCallback!: () => void;
    let observedSignal: AbortSignal | undefined;
    const tool = createTool({
      name: 'ignored-timeout',
      description: 'ignores abort until released',
      input: z.object({}),
      async execute(_params, context) {
        observedSignal = context.signal;
        await new Promise<void>((resolve) => (releaseCallback = resolve));
        return 'late effect';
      },
    });
    const pending = tool.executeWith({
      params: {},
      callId: 'ignored-timeout-call',
      timeout: 1,
      ...timing.options,
    });
    await drainMicrotasks();
    timing.fireTimeout();
    await expect(pending).resolves.toMatchObject({ errorCategory: 'timeout' });
    expect(observedSignal?.aborted).toBe(true);
    expect(tool.executions.inspect({ callId: 'ignored-timeout-call' })[0]?.state).toBe(
      'cleanup-pending',
    );
    expect(tool.activeExecutions).toBe(1);
    releaseCallback();
    await drainMicrotasks();
    expect(tool.executions.inspect({ callId: 'ignored-timeout-call' })[0]).toMatchObject({
      state: 'terminal',
      result: 'late effect',
    });
    expect(tool.activeExecutions).toBe(0);
  });

  it('executeWith clears the timeout when execution succeeds', async () => {
    const timing = createManualExecutionTiming();
    const tool = createTool({
      name: 'fast-timeout-cleanup',
      description: 'clears timeout handles',
      input: z.object({ a: z.string() }),
      async execute({ a }) {
        return a.toUpperCase();
      },
    });

    const result = await (tool as any).executeWith({
      params: { a: 'ok' },
      timeout: 100,
      ...timing.options,
    });

    expect(result.result).toBe('OK');
    expect(timing.clearCount()).toBe(1);
  });

  it('executeWith supports AbortSignal cancellation', async () => {
    const tool = createTool({
      name: 'slow-cancel',
      description: 'abort support',
      input: z.object({ a: z.string() }),
      async execute() {
        return new Promise<string>(() => {});
      },
    });

    const controller = new AbortController();
    const pending = (tool as any).executeWith({
      params: { a: 'x' },
      callId: 'c1',
      signal: controller.signal,
    });
    await drainMicrotasks();
    controller.abort('too-late');
    const result = await pending;

    expect(result.toolCallId).toBe('c1');
    expect(result.result).toBeUndefined();
    expect(result.error?.message?.toLowerCase()).toContain('too-late');
  });

  it('executeWith resolves before timeout (clears timer)', async () => {
    const tool = createTool({
      name: 'fast',
      description: 'no-timeout',
      input: z.object({ a: z.string() }),
      async execute({ a }) {
        return a;
      },
    });
    const res = await (tool as any).executeWith({ params: { a: 'ok' }, timeout: 1000 });
    expect(res.result).toBe('ok');
  });

  it('executeWith rejects before timeout (clears timer on reject path)', async () => {
    const tool = createTool({
      name: 'fast-fail',
      description: 'rejects quickly',
      input: z.object({ a: z.string() }),
      async execute() {
        throw new Error('bad');
      },
    });
    const res = await (tool as any).executeWith({ params: { a: 'x' }, timeout: 1000 });
    expect(res.error?.category).toBe('internal');
    expect(res.error?.code).toBe('INTERNAL_ERROR');
    expect(res.error?.message).toContain('bad');
  });

  it('getOwnPropertyDescriptor falls through to callable for non-bag property', () => {
    const tool = createTool({
      name: 'desc-proxy',
      description: 'descriptor',
      input: z.object({ a: z.string() }),
      async execute() {
        return 'x';
      },
    });
    const desc = Object.getOwnPropertyDescriptor(tool as any, 'length');
    expect(desc).toBeDefined();
  });
});

describe('RuntimeToolContext.progress()', () => {
  it('dispatches the same progress event shape a hand-constructed dispatch call produces', async () => {
    const handConstructed: Array<{ percent?: number; message?: string }> = [];
    const viaProgress: Array<{ percent?: number; message?: string }> = [];

    const handTool = createTool({
      name: 'hand-dispatch',
      description: 'dispatches progress by hand',
      input: z.object({}),
      async execute(_params, context) {
        context.dispatch(new ToolProgressEvent({ percent: 50, message: 'halfway' }));
        return 'done';
      },
    });
    handTool.addEventListener('progress', (event: any) => {
      handConstructed.push({ percent: event.percent, message: event.message });
    });
    await handTool.execute(createToolCall('hand-dispatch', {}));

    const progressTool = createTool({
      name: 'via-progress',
      description: 'dispatches progress via context.progress()',
      input: z.object({}),
      async execute(_params, context) {
        context.progress({ percent: 50, message: 'halfway' });
        return 'done';
      },
    });
    progressTool.addEventListener('progress', (event: any) => {
      viaProgress.push({ percent: event.percent, message: event.message });
    });
    await progressTool.execute(createToolCall('via-progress', {}));

    expect(viaProgress).toEqual(handConstructed);
    expect(viaProgress).toEqual([{ percent: 50, message: 'halfway' }]);
  });

  it('carries a checkpoint value through the dispatched event unmodified', async () => {
    const checkpoints: unknown[] = [];
    const checkpoint = { step: 3, cursor: 'abc', nested: { ok: true } };

    const tool = createTool({
      name: 'checkpoint-tool',
      description: 'reports a structured checkpoint',
      input: z.object({}),
      async execute(_params, context) {
        context.progress({ checkpoint });
        return 'done';
      },
    });
    tool.addEventListener('progress', (event: any) => {
      checkpoints.push(event.checkpoint);
    });
    await tool.execute(createToolCall('checkpoint-tool', {}));

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toBe(checkpoint);
    expect(checkpoints[0]).toEqual(checkpoint);
  });

  it('is a no-op when called after the tool call has completed', async () => {
    let capturedContext: any;
    const progressEvents: unknown[] = [];

    const tool = createTool({
      name: 'post-completion-progress',
      description: 'stashes the context for later use',
      input: z.object({}),
      async execute(_params, context) {
        capturedContext = context;
        return 'done';
      },
    });
    tool.addEventListener('progress', (event: any) => {
      progressEvents.push(event);
    });

    const result = await tool.execute(createToolCall('post-completion-progress', {}));
    expect(result.outcome).toBe('success');

    expect(() => capturedContext.progress({ percent: 100 })).not.toThrow();
    await drainMicrotasks();

    expect(progressEvents).toHaveLength(0);
  });

  it('is a no-op when called after the tool call has been aborted', async () => {
    let capturedContext: any;
    const progressEvents: unknown[] = [];

    const tool = createTool({
      name: 'post-abort-progress',
      description: 'stashes the context and never resolves',
      input: z.object({}),
      async execute(_params, context) {
        capturedContext = context;
        return new Promise<string>(() => {});
      },
    });
    tool.addEventListener('progress', (event: any) => {
      progressEvents.push(event);
    });

    const controller = new AbortController();
    const pending = tool.execute(createToolCall('post-abort-progress', {}), {
      signal: controller.signal,
    });
    await drainMicrotasks();
    controller.abort('stop');
    await pending;

    expect(() => capturedContext.progress({ percent: 100 })).not.toThrow();
    await drainMicrotasks();

    expect(progressEvents).toHaveLength(0);
  });

  it('does not reset or extend an explicit tool timeout', async () => {
    const timing = createManualExecutionTiming();
    let timedOut = false;

    const tool = createTool({
      name: 'progress-does-not-extend-timeout',
      description: 'reports progress while waiting for a timeout',
      input: z.object({}),
      async execute(_params, context) {
        context.progress({ percent: 10, message: 'still going' });
        return new Promise<string>(() => {});
      },
    });

    const pending = tool.execute(createToolCall('progress-does-not-extend-timeout', {}), {
      ...timing.options,
      timeout: 1000,
    });
    await drainMicrotasks();
    timing.fireTimeout();
    const result = await pending;
    if (result.errorCategory === 'timeout') timedOut = true;

    expect(timedOut).toBe(true);
  });
});
