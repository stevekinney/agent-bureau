import { describe, expect, expectTypeOf, it } from 'bun:test';
import { hmacSha256HexSync } from 'interoperability';
import { z } from 'zod';

import {
  createMiddleware,
  createProcessLocalApprovalStateStore,
  createTool,
  createToolbox,
  createToolCall,
  lazy,
  type SignedPendingToolApproval,
  type ToolConfiguration,
} from '../src';
import { toAnthropicTools } from '../src/adapters/anthropic';
import { toGeminiTools } from '../src/adapters/gemini';
import { toOpenAITools } from '../src/adapters/openai';
import { queryTools, reindexSearchIndex, searchTools } from '../src/core/registry';
import { stableStringifyJson } from '../src/core/serialization/json';
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

const approvalRequestContext = {
  authority: {
    principalId: 'principal-a',
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization:1',
  },
  audience: 'tenant' as const,
  agentId: 'agent-a',
  runId: 'run-a',
};

const approvalExecutionOptions = { requestContext: approvalRequestContext };

function createManualToolboxDeadlineTiming(initialNow = 0) {
  let now = initialNow;
  const scheduled: Array<{ callback: () => void; milliseconds: number | undefined }> = [];
  const scheduledDelayHistory: Array<number | undefined> = [];
  const cleared: unknown[] = [];

  return {
    clearCount(): number {
      return cleared.length;
    },
    fireDeadline(): void {
      const entry = scheduled.shift();
      if (!entry) throw new Error('Manual deadline was not scheduled');
      entry.callback();
    },
    scheduledDelays(): readonly (number | undefined)[] {
      return scheduled.map(({ milliseconds }) => milliseconds);
    },
    scheduledDelayHistory(): readonly (number | undefined)[] {
      return scheduledDelayHistory;
    },
    setNow(nextNow: number): void {
      now = nextNow;
    },
    options: {
      now: () => now,
      setTimeoutFunction(callback: () => void, milliseconds?: number) {
        const handle = scheduled.length + 1;
        scheduled.push({ callback, milliseconds });
        scheduledDelayHistory.push(milliseconds);
        return handle;
      },
      clearTimeoutFunction(handle: unknown) {
        cleared.push(handle);
      },
    },
  };
}

async function createResumeApprovalValidationFixture(options: {
  currentInput: z.ZodTypeAny;
  name: string;
  secret?: string;
}) {
  const approvalStateStore = createProcessLocalApprovalStateStore();
  const approvalPolicy = {
    beforeExecute: () => ({
      allow: false as const,
      status: 'needs_approval' as const,
      reason: 'approval required',
    }),
  };
  let executions = 0;
  const secret = options.secret ?? `${options.name}-secret`;
  const sourceToolbox = createToolbox(
    [
      createTool({
        name: options.name,
        description: 'issues approval before current schema validation',
        version: '1.0.0',
        input: z.object({ value: z.string() }),
        async execute() {
          executions += 1;
          return 'source';
        },
      }),
    ],
    {
      approvalSecret: secret,
      approvalStateStore,
      policy: approvalPolicy,
    },
  );
  const paused = await sourceToolbox.execute(
    {
      id: `${options.name}-call`,
      name: options.name,
      arguments: { value: 'approved' },
    },
    approvalExecutionOptions,
  );
  const resumeToolbox = createToolbox(
    [
      createTool({
        name: options.name,
        description: 'resumes approval after current schema validation',
        version: '1.0.0',
        input: options.currentInput,
        async execute() {
          executions += 1;
          return 'resumed';
        },
      }),
    ],
    {
      approvalSecret: secret,
      approvalStateStore,
      policy: approvalPolicy,
    },
  );

  return {
    approvalStateStore,
    executions: () => executions,
    paused,
    resumeToolbox,
  };
}

describe('createToolbox', () => {
  it('forwards custom deadline timer cleanup to the toolbox lifecycle', async () => {
    const scheduled: Array<() => void> = [];
    const cleared: unknown[] = [];
    const toolbox = createToolbox([
      createTool({
        name: 'timer-forwarding',
        description: 'timer forwarding',
        version: '1.0.0',
        input: z.object({}),
        async execute() {
          return 'ok';
        },
      }),
    ]);

    await toolbox.execute(
      { id: 'timer-call', name: 'timer-forwarding', arguments: {} },
      {
        requestContext: { ...approvalRequestContext, deadline: 10 },
        now: () => 0,
        setTimeoutFunction(callback) {
          scheduled.push(callback);
          return 'timer-token';
        },
        clearTimeoutFunction(timer) {
          cleared.push(timer);
        },
      },
    );

    expect(cleared).toEqual(['timer-token', 'timer-token']);
    expect(scheduled).toHaveLength(2);
  });

  it('starts relative timeouts when sequential child execution is admitted', async () => {
    let secondExecuted = false;
    const toolbox = createToolbox([
      createTool({
        name: 'slow-first',
        description: 'slow first',
        input: z.object({}),
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return 'first';
        },
      }),
      createTool({
        name: 'fast-second',
        description: 'fast second',
        input: z.object({}),
        async execute() {
          secondExecuted = true;
          return 'second';
        },
      }),
    ]);

    const results = await toolbox.execute(
      [
        { id: 'first', name: 'slow-first', arguments: {} },
        { id: 'second', name: 'fast-second', arguments: {} },
      ],
      { mode: 'sequential', timeout: 10 },
    );

    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ outcome: 'success', result: 'second' });
    expect(secondExecuted).toBe(true);
  });

  it('classifies expired deadlines before missing or unavailable dispatch', async () => {
    const unavailable = createTool({
      name: 'expired-unavailable',
      description: 'expired unavailable',
      input: z.object({}),
      availability: () => false,
      async execute() {
        return 'unreachable';
      },
    });
    const toolbox = createToolbox([unavailable]);
    const requestContext = { ...approvalRequestContext, deadline: 99 };

    const results = await toolbox.execute(
      [
        { id: 'missing', name: 'expired-missing', arguments: {} },
        { id: 'unavailable', name: 'expired-unavailable', arguments: {} },
      ],
      { now: () => 100, requestContext },
    );

    expect(results).toEqual([
      expect.objectContaining({ outcome: 'error', errorCategory: 'timeout' }),
      expect.objectContaining({ outcome: 'error', errorCategory: 'timeout' }),
    ]);
  });

  it('races pending availability against the request deadline', async () => {
    let currentTime = 0;
    let resolveAvailability!: (available: boolean) => void;
    const availability = new Promise<boolean>((resolve) => {
      resolveAvailability = resolve;
    });
    const scheduled: Array<() => void> = [];
    const toolbox = createToolbox([
      createTool({
        name: 'pending-availability',
        description: 'pending availability',
        input: z.object({}),
        availability: () => availability,
        async execute() {
          return 'unreachable';
        },
      }),
    ]);

    const pending = toolbox.execute(
      { id: 'pending-availability-call', name: 'pending-availability', arguments: {} },
      {
        now: () => currentTime,
        requestContext: { ...approvalRequestContext, deadline: 10 },
        setTimeoutFunction(callback) {
          scheduled.push(callback);
          return 'deadline';
        },
        clearTimeoutFunction() {},
      },
    );
    await Promise.resolve();
    currentTime = 10;
    scheduled[0]!();

    await expect(pending).resolves.toMatchObject({
      outcome: 'error',
      errorCategory: 'timeout',
      error: { code: 'TIMEOUT' },
    });
    resolveAvailability(false);
  });

  it('preserves caller cancellation while availability is pending', async () => {
    let resolveAvailability!: (available: boolean) => void;
    const availability = new Promise<boolean>((resolve) => {
      resolveAvailability = resolve;
    });
    const controller = new AbortController();
    const toolbox = createToolbox([
      createTool({
        name: 'caller-cancelled-availability',
        description: 'caller cancelled availability',
        input: z.object({}),
        availability: () => availability,
        async execute() {
          return 'unreachable';
        },
      }),
    ]);

    const pending = toolbox.execute(
      { id: 'caller-cancelled-call', name: 'caller-cancelled-availability', arguments: {} },
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort('caller stopped');

    await expect(pending).resolves.toMatchObject({
      outcome: 'error',
      errorCategory: 'cancelled',
      error: { code: 'CANCELLED' },
    });
    resolveAvailability(false);
  });

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

  it('evaluates availability lazily against toolbox context', async () => {
    let availabilityChecks = 0;
    const toolbox = createToolbox(
      [
        createTool({
          name: 'darwin-tool',
          description: 'Runs on Darwin hosts',
          input: z.object({}),
          availability(context) {
            availabilityChecks += 1;
            return context['platform'] === 'darwin';
          },
          async execute() {
            return 'ok';
          },
        }),
        createTool({
          name: 'linux-tool',
          description: 'Runs on Linux hosts',
          input: z.object({}),
          availability: async (context) => context['platform'] === 'linux',
          async execute() {
            return 'ok';
          },
        }),
        createTool({
          name: 'always-tool',
          description: 'Runs everywhere',
          input: z.object({}),
          async execute() {
            return 'ok';
          },
        }),
      ],
      { context: { platform: 'darwin' } },
    );

    expect(availabilityChecks).toBe(0);

    const available = await toolbox.getAvailable();

    expect(availabilityChecks).toBe(1);
    expect(available.map((tool) => tool.name)).toEqual(['darwin-tool', 'always-tool']);
  });

  it('evaluates availability hooks in parallel while preserving order', async () => {
    const resolvers: Array<(value: boolean) => void> = [];
    const started: string[] = [];
    const makeAvailability = (name: string) => () =>
      new Promise<boolean>((resolve) => {
        started.push(name);
        resolvers.push(resolve);
      });
    const toolbox = createToolbox([
      createTool({
        name: 'first',
        description: 'First tool',
        input: z.object({}),
        availability: makeAvailability('first'),
        async execute() {
          return 'first';
        },
      }),
      createTool({
        name: 'second',
        description: 'Second tool',
        input: z.object({}),
        availability: makeAvailability('second'),
        async execute() {
          return 'second';
        },
      }),
    ]);

    const availablePromise = toolbox.getAvailable();
    await Promise.resolve();

    expect(started).toEqual(['first', 'second']);
    expect(resolvers).toHaveLength(2);

    resolvers[1]?.(true);
    resolvers[0]?.(true);

    await expect(availablePromise).resolves.toEqual([
      toolbox.getTool('first'),
      toolbox.getTool('second'),
    ]);
  });

  it('filters unavailable tools from toolbox provider materialization', async () => {
    const toolbox = createToolbox(
      [
        createTool({
          name: 'available-tool',
          description: 'Available tool',
          input: z.object({}),
          availability: () => true,
          async execute() {
            return 'ok';
          },
        }),
        createTool({
          name: 'unavailable-tool',
          description: 'Unavailable tool',
          input: z.object({}),
          availability: () => false,
          async execute() {
            return 'nope';
          },
        }),
      ],
      { context: { optionalApiKey: undefined } },
    );

    const openAITools = await toolbox.toOpenAITools();
    const anthropicTools = await toolbox.toAnthropicTools();
    const geminiTools = await toolbox.toGeminiTools();

    expect(openAITools.map((tool) => tool.function.name)).toEqual(['available-tool']);
    expect(anthropicTools.map((tool) => tool.name)).toEqual(['available-tool']);
    expect(
      geminiTools.flatMap((tool) =>
        tool.functionDeclarations.map((declaration) => declaration.name),
      ),
    ).toEqual(['available-tool']);
  });

  it('treats throwing availability hooks as unavailable during materialization and execution', async () => {
    let executed = false;
    const toolbox = createToolbox([
      createTool({
        name: 'probe-tool',
        description: 'Tool with a failing availability probe',
        input: z.object({}),
        async availability() {
          throw new Error('probe failed');
        },
        async execute() {
          executed = true;
          return 'ok';
        },
      }),
    ]);

    await expect(toolbox.getAvailable()).resolves.toEqual([]);
    await expect(toolbox.toOpenAITools()).resolves.toEqual([]);

    const result = await toolbox.execute({ id: 'call-1', name: 'probe-tool', arguments: {} });

    expect(executed).toBe(false);
    expect(result.outcome).toBe('error');
    expect(result.error).toMatchObject({
      category: 'unavailable',
      code: 'TOOL_UNAVAILABLE',
    });
  });

  it('does not advertise an older same-name tool when the executable name resolves to an unavailable tool', async () => {
    const toolbox = createToolbox([
      createTool({
        name: 'duplicate',
        description: 'Older available tool',
        input: z.object({}),
        availability: () => true,
        async execute() {
          return 'older';
        },
      }),
      createTool({
        name: 'duplicate',
        description: 'Newer unavailable tool',
        input: z.object({}),
        availability: () => false,
        async execute() {
          return 'newer';
        },
      }),
    ]);

    const availableTools = await toolbox.getAvailable();
    const openAITools = await toolbox.toOpenAITools();

    expect(availableTools.map((tool) => tool.name)).toEqual([]);
    expect(openAITools.map((tool) => tool.function.name)).toEqual([]);

    const result = await toolbox.execute({ id: 'call-1', name: 'duplicate', arguments: {} });

    expect(result).toMatchObject({
      outcome: 'error',
      errorCategory: 'unavailable',
      error: { code: 'TOOL_UNAVAILABLE' },
    });
  });

  it('returns a structured unavailable ToolError without executing the tool', async () => {
    let executed = false;
    const toolbox = createToolbox(
      [
        createTool({
          name: 'macos-only',
          description: 'Requires macOS APIs',
          input: z.object({}),
          availability: () => false,
          async execute() {
            executed = true;
            return 'ok';
          },
        }),
      ],
      { context: { platform: 'linux' } },
    );

    const result = await toolbox.execute({ id: 'call-1', name: 'macos-only', arguments: {} });

    expect(executed).toBe(false);
    expect(result).toMatchObject({
      callId: 'call-1',
      outcome: 'error',
      toolCallId: 'call-1',
      toolName: 'macos-only',
      result: undefined,
      errorMessage: 'Tool unavailable: macos-only',
      errorCategory: 'unavailable',
      error: {
        code: 'TOOL_UNAVAILABLE',
        category: 'unavailable',
        retryable: false,
        message: 'Tool unavailable: macos-only',
      },
    });
    await expect(
      toolbox.execute(
        { id: 'call-2', name: 'macos-only', arguments: {} },
        { errorMode: 'failFast' },
      ),
    ).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' });
  });

  it('returns a serializable pending approval descriptor and resumes with edited arguments', async () => {
    const charges: number[] = [];
    const createChargeToolbox = (approvalSecret: string) =>
      createToolbox(
        [
          createTool({
            name: 'charge-card',
            description: 'Charge a payment card',
            version: '1.0.0',
            input: z.object({ cents: z.number(), confirmed: z.boolean().optional() }),
            metadata: { mutates: true },
            async execute({ cents }) {
              charges.push(cents);
              return { charged: cents };
            },
          }),
        ],
        {
          approvalSecret,
          policy: {
            beforeExecute(context) {
              if (
                context.params &&
                typeof context.params === 'object' &&
                'confirmed' in context.params &&
                context.params.confirmed === true
              ) {
                return { allow: true };
              }
              return {
                allow: false,
                status: 'needs_approval',
                reason: 'Operator approval required',
                action: { message: 'Approve charge' },
              };
            },
          },
        },
      );

    const toolbox = createChargeToolbox('test-secret');

    const paused = await toolbox.execute(
      {
        id: 'tool-call-1',
        name: 'charge-card',
        arguments: { cents: 100 },
      },
      approvalExecutionOptions,
    );

    expect(paused.outcome).toBe('action_required');
    const { approvalToken, ...approvalDescriptor } = paused.pendingApproval!;
    expect(typeof approvalToken).toBe('string');
    expect(approvalDescriptor).toMatchObject({
      callId: 'tool-call-1',
      toolName: 'charge-card',
      arguments: { cents: 100 },
      action: {
        type: 'approval',
        message: 'Approve charge',
      },
      reason: 'Operator approval required',
      metadata: { mutates: true },
      policyPauseTier: 'registry',
      approvalBinding: {
        version: 1,
        principalId: 'principal-a',
        tenantId: 'tenant-a',
        runId: 'run-a',
      },
    });
    expect(Object.hasOwn(paused.pendingApproval!.action, 'schema')).toBe(false);
    const serializedApproval = JSON.parse(JSON.stringify(paused.pendingApproval)) as Record<
      string,
      unknown
    >;
    expect(serializedApproval['approvalToken']).toBe(approvalToken);
    expect(serializedApproval['approvalBinding']).toEqual(paused.pendingApproval?.approvalBinding);
    const signedApproval = paused.pendingApproval as SignedPendingToolApproval;

    expect(() =>
      toolbox.resumeApproval({
        ...signedApproval,
        approvalToken: 'forged',
      }),
    ).toThrow('invalid approval token');

    expect(() =>
      toolbox.resumeApproval({
        ...signedApproval,
        approvalToken: undefined,
      } as unknown as SignedPendingToolApproval),
    ).toThrow('invalid approval token');

    expect(() =>
      toolbox.resumeApproval({
        ...signedApproval,
        callId: 'other-call',
      }),
    ).toThrow('invalid approval token');

    expect(() =>
      toolbox.resumeApproval({
        ...signedApproval,
        arguments: { cents: 999 },
      }),
    ).toThrow('invalid approval token');

    expect(() =>
      toolbox.resumeApproval({
        ...signedApproval,
        toolName: 'other-tool',
      }),
    ).toThrow('invalid approval token');

    expect(() =>
      toolbox.resumeApproval({
        ...signedApproval,
        action: {
          type: 'approval',
          message: 'Different approval',
        },
      }),
    ).toThrow('invalid approval token');

    expect(() =>
      toolbox.resumeApproval({
        ...signedApproval,
        reason: 'Changed reason',
      }),
    ).toThrow('invalid approval token');

    expect(() =>
      toolbox.resumeApproval({
        ...signedApproval,
        metadata: { mutates: false },
      }),
    ).toThrow('invalid approval token');

    const incompatibleToolbox = createChargeToolbox('other-secret');
    expect(() => incompatibleToolbox.resumeApproval(signedApproval)).toThrow(
      'invalid approval token',
    );

    const missingToolbox = createToolbox([], { approvalSecret: 'test-secret' });
    await expect(missingToolbox.resumeApproval(signedApproval)).rejects.toThrow(
      'Tool not found: charge-card',
    );

    const unconfirmedEdit = await toolbox.resumeApproval(signedApproval, {
      arguments: { cents: 125 },
      ...approvalExecutionOptions,
    });

    expect(unconfirmedEdit.outcome).toBe('action_required');
    expect(unconfirmedEdit.pendingApproval?.approvalToken).toEqual(expect.any(String));
    expect(charges).toEqual([]);

    const resumed = await toolbox.resumeApproval(
      unconfirmedEdit.pendingApproval as SignedPendingToolApproval,
      {
        arguments: { cents: 125, confirmed: true },
        ...approvalExecutionOptions,
      },
    );

    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toEqual({ charged: 125 });
    expect(resumed.executedArgumentsEdited).toBe(true);

    const originalApprovalResumed = await toolbox.resumeApproval(
      signedApproval,
      approvalExecutionOptions,
    );
    expect(originalApprovalResumed.outcome).toBe('success');
    expect(originalApprovalResumed.result).toEqual({ charged: 100 });

    const invalidPaused = await toolbox.execute(
      { id: 'tool-call-invalid', name: 'charge-card', arguments: { cents: 100 } },
      approvalExecutionOptions,
    );
    await expect(
      toolbox.resumeApproval(invalidPaused.pendingApproval as SignedPendingToolApproval, {
        arguments: { cents: '125' },
        ...approvalExecutionOptions,
      }),
    ).rejects.toBeInstanceOf(z.ZodError);

    const correctedResume = await toolbox.resumeApproval(
      invalidPaused.pendingApproval as SignedPendingToolApproval,
      { arguments: { cents: 100, confirmed: true }, ...approvalExecutionOptions },
    );

    expect(correctedResume.outcome).toBe('success');
    expect(correctedResume.result).toEqual({ charged: 100 });
    expect(charges).toEqual([125, 100, 100]);
    await expect(
      toolbox.resumeApproval(invalidPaused.pendingApproval as SignedPendingToolApproval, {
        arguments: { cents: 100, confirmed: true },
        ...approvalExecutionOptions,
      }),
    ).rejects.toThrow('already been consumed');
  });

  it('supports destructured resumeApproval calls', async () => {
    let executedValue: string | undefined;
    const toolbox = createToolbox(
      [
        createTool({
          name: 'destructured-approval',
          description: 'Requires approval before execution',
          version: '1.0.0',
          input: z.object({ value: z.string(), confirmed: z.boolean().optional() }),
          async execute({ value }) {
            executedValue = value;
            return value;
          },
        }),
      ],
      {
        approvalSecret: 'destructured-secret',
        policy: {
          beforeExecute(context) {
            if (
              context.params &&
              typeof context.params === 'object' &&
              'confirmed' in context.params &&
              context.params.confirmed === true
            ) {
              return { allow: true };
            }
            return {
              allow: false,
              status: 'needs_approval',
              reason: 'approval required',
              action: { message: 'Approve destructured execution' },
            };
          },
        },
      },
    );
    const paused = await toolbox.execute(
      {
        id: 'destructured-call',
        name: 'destructured-approval',
        arguments: { value: 'approved' },
      },
      approvalExecutionOptions,
    );
    const { resumeApproval } = toolbox;

    const resumed = await resumeApproval(paused.pendingApproval as SignedPendingToolApproval, {
      arguments: { value: 'approved', confirmed: true },
      ...approvalExecutionOptions,
    });

    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toBe('approved');
    expect(executedValue).toBe('approved');
  });

  it('cancels stalled resumed-approval schema validation without consuming the approval', async () => {
    let startValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      startValidation = resolve;
    });
    let executions = 0;
    const approvalStateStore = createProcessLocalApprovalStateStore();
    const approvalPolicy = {
      beforeExecute: () => ({
        allow: false as const,
        status: 'needs_approval' as const,
        reason: 'approval required',
      }),
    };
    const sourceToolbox = createToolbox(
      [
        createTool({
          name: 'resume-stalled-validation',
          description: 'issues approval before current schema stalls',
          version: '1.0.0',
          input: z.object({ value: z.string() }),
          async execute() {
            executions += 1;
            return 'source';
          },
        }),
      ],
      {
        approvalSecret: 'resume-stalled-validation-secret',
        approvalStateStore,
        policy: approvalPolicy,
      },
    );
    const paused = await sourceToolbox.execute(
      {
        id: 'resume-stalled-validation-call',
        name: 'resume-stalled-validation',
        arguments: { value: 'approved' },
      },
      approvalExecutionOptions,
    );
    const resumeToolbox = createToolbox(
      [
        createTool({
          name: 'resume-stalled-validation',
          description: 'stalls during resumed approval validation',
          version: '1.0.0',
          input: z.object({ value: z.string() }).superRefine(async () => {
            startValidation();
            await new Promise<void>(() => {});
          }),
          async execute() {
            executions += 1;
            return 'unreachable';
          },
        }),
      ],
      {
        approvalSecret: 'resume-stalled-validation-secret',
        approvalStateStore,
        policy: approvalPolicy,
      },
    );
    const controller = new AbortController();

    const pending = resumeToolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      {
        ...approvalExecutionOptions,
        signal: controller.signal,
      },
    );
    await validationStarted;
    controller.abort('caller cancelled resumed validation');

    const result = await pending;

    expect(result).toMatchObject({
      outcome: 'error',
      errorCategory: 'cancelled',
      error: { code: 'CANCELLED', message: 'caller cancelled resumed validation' },
    });
    expect(executions).toBe(0);
    expect(resumeToolbox.executions.inspect()).toHaveLength(0);
    expect(await approvalStateStore.state(paused.pendingApproval!.approvalBinding!)).toBe('issued');
  });

  it('cancels while reading durable approval state without consuming or executing', async () => {
    let executions = 0;
    const sourceStore = createProcessLocalApprovalStateStore();
    const tool = createTool({
      name: 'stalled-approval-state',
      description: 'stalled approval state',
      version: '1.0.0',
      input: z.object({}),
      async execute() {
        executions += 1;
        return 'executed';
      },
    });
    const options = {
      approvalSecret: 'stalled-approval-state-secret',
      approvalStateStore: sourceStore,
      policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
    };
    const paused = await createToolbox([tool], options).execute(
      { id: 'stalled-state-call', name: tool.name, arguments: {} },
      approvalExecutionOptions,
    );
    const approval = paused.pendingApproval as SignedPendingToolApproval;
    const betweenReadsController = new AbortController();
    const abortAfterStateStore = {
      ...sourceStore,
      state: () =>
        ({
          then(
            onFulfilled: (state: 'issued') => unknown,
            _onRejected?: (error: unknown) => unknown,
          ) {
            const result = onFulfilled('issued');
            betweenReadsController.abort('cancelled after state read');
            return Promise.resolve(result);
          },
        }) as Promise<'issued'>,
    };
    await expect(
      createToolbox([tool], {
        ...options,
        approvalStateStore: abortAfterStateStore,
      }).resumeApproval(approval, {
        ...approvalExecutionOptions,
        signal: betweenReadsController.signal,
      }),
    ).resolves.toMatchObject({ outcome: 'error', errorCategory: 'cancelled' });
    let deadlineClockReads = 0;
    await expect(
      createToolbox([tool], options).resumeApproval(approval, {
        ...approvalExecutionOptions,
        requestContext: { ...approvalExecutionOptions.requestContext, deadline: 10 },
        now: () => (deadlineClockReads++ === 0 ? 0 : 10),
      }),
    ).resolves.toMatchObject({ outcome: 'error', errorCategory: 'timeout' });
    let resolveState!: (state: 'issued' | 'consumed' | 'revoked' | undefined) => void;
    const statePending = new Promise<'issued' | 'consumed' | 'revoked' | undefined>((resolve) => {
      resolveState = resolve;
    });
    const stalledStore = { ...sourceStore, state: async () => statePending };
    const resumeToolbox = createToolbox([tool], {
      ...options,
      approvalStateStore: stalledStore,
    });
    const preAbortedController = new AbortController();
    preAbortedController.abort('already cancelled state read');
    await expect(
      resumeToolbox.resumeApproval(approval, {
        ...approvalExecutionOptions,
        signal: preAbortedController.signal,
      }),
    ).resolves.toMatchObject({ outcome: 'error', errorCategory: 'cancelled' });
    await expect(
      resumeToolbox.resumeApproval(approval, {
        ...approvalExecutionOptions,
        requestContext: { ...approvalExecutionOptions.requestContext, deadline: 10 },
        now: () => 10,
      }),
    ).resolves.toMatchObject({ outcome: 'error', errorCategory: 'timeout' });
    await expect(
      resumeToolbox.resumeApproval(approval, {
        ...approvalExecutionOptions,
        requestContext: {
          ...approvalExecutionOptions.requestContext,
          deadline: Date.now() + 5,
        },
      }),
    ).resolves.toMatchObject({ outcome: 'error', errorCategory: 'timeout' });
    const controller = new AbortController();
    const pending = resumeToolbox.resumeApproval(approval, {
      ...approvalExecutionOptions,
      signal: controller.signal,
    });
    controller.abort('caller cancelled state read');
    const result = await pending;

    expect(result).toMatchObject({ outcome: 'error', errorCategory: 'cancelled' });
    expect(executions).toBe(0);
    resolveState('issued');
  });

  it('re-arms long approval-state read deadlines without overflowing timer delay', async () => {
    const maximumTimerDelay = 2_147_483_647;
    const timing = createManualToolboxDeadlineTiming();
    const sourceStore = createProcessLocalApprovalStateStore();
    const tool = createTool({
      name: 'long-approval-state-read',
      description: 'waits for durable approval state',
      version: '1.0.0',
      input: z.object({}),
      execute: () => 'executed',
    });
    const options = {
      approvalSecret: 'long-approval-state-read-secret',
      approvalStateStore: sourceStore,
      policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
    };
    const paused = await createToolbox([tool], options).execute(
      { id: 'long-state-call', name: tool.name, arguments: {} },
      approvalExecutionOptions,
    );
    let stateReadStarted!: () => void;
    const stateRead = new Promise<void>((resolve) => {
      stateReadStarted = resolve;
    });
    const controller = new AbortController();
    const resume = createToolbox([tool], {
      ...options,
      approvalStateStore: {
        ...sourceStore,
        state: async () => {
          stateReadStarted();
          return new Promise<'issued'>(() => {});
        },
      },
    }).resumeApproval(paused.pendingApproval as SignedPendingToolApproval, {
      ...approvalExecutionOptions,
      requestContext: {
        ...approvalRequestContext,
        deadline: maximumTimerDelay + 1_000,
      },
      signal: controller.signal,
      ...timing.options,
    });
    await stateRead;

    expect(timing.scheduledDelayHistory()).toEqual([maximumTimerDelay]);
    timing.fireDeadline();
    expect(timing.scheduledDelayHistory()).toEqual([maximumTimerDelay, maximumTimerDelay]);
    controller.abort('stop durable state read');
    await expect(resume).resolves.toMatchObject({
      outcome: 'error',
      errorCategory: 'cancelled',
    });
  });

  it('cleans up approval-state read controls when durable storage rejects', async () => {
    const timing = createManualToolboxDeadlineTiming();
    const sourceStore = createProcessLocalApprovalStateStore();
    const tool = createTool({
      name: 'rejected-approval-state-read',
      description: 'rejects durable approval state reads',
      version: '1.0.0',
      input: z.object({}),
      execute: () => 'executed',
    });
    const options = {
      approvalSecret: 'rejected-approval-state-read-secret',
      approvalStateStore: sourceStore,
      policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
    };
    const paused = await createToolbox([tool], options).execute(
      { id: 'rejected-state-call', name: tool.name, arguments: {} },
      approvalExecutionOptions,
    );
    let removedAbortListeners = 0;
    const signalTarget = new EventTarget();
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: signalTarget.addEventListener.bind(signalTarget),
      removeEventListener(...arguments_: Parameters<EventTarget['removeEventListener']>) {
        removedAbortListeners += 1;
        signalTarget.removeEventListener(...arguments_);
      },
    } as unknown as AbortSignal;

    await expect(
      createToolbox([tool], {
        ...options,
        approvalStateStore: {
          ...sourceStore,
          state: async () => {
            throw new Error('durable approval state unavailable');
          },
        },
      }).resumeApproval(paused.pendingApproval as SignedPendingToolApproval, {
        ...approvalExecutionOptions,
        requestContext: { ...approvalRequestContext, deadline: 10 },
        signal,
        ...timing.options,
      }),
    ).rejects.toThrow('durable approval state unavailable');

    expect(removedAbortListeners).toBe(1);
    expect(timing.clearCount()).toBe(1);
  });

  it('times out stalled resumed-approval schema validation without consuming the approval', async () => {
    const timing = createManualToolboxDeadlineTiming();
    let startValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      startValidation = resolve;
    });
    let executions = 0;
    const approvalStateStore = createProcessLocalApprovalStateStore();
    const approvalPolicy = {
      beforeExecute: () => ({
        allow: false as const,
        status: 'needs_approval' as const,
        reason: 'approval required',
      }),
    };
    const sourceToolbox = createToolbox(
      [
        createTool({
          name: 'resume-deadline-validation',
          description: 'issues approval before current schema stalls until deadline',
          version: '1.0.0',
          input: z.object({ value: z.string() }),
          async execute() {
            executions += 1;
            return 'source';
          },
        }),
      ],
      {
        approvalSecret: 'resume-deadline-validation-secret',
        approvalStateStore,
        policy: approvalPolicy,
      },
    );
    const paused = await sourceToolbox.execute(
      {
        id: 'resume-deadline-validation-call',
        name: 'resume-deadline-validation',
        arguments: { value: 'approved' },
      },
      approvalExecutionOptions,
    );
    const resumeToolbox = createToolbox(
      [
        createTool({
          name: 'resume-deadline-validation',
          description: 'stalls during resumed approval deadline validation',
          version: '1.0.0',
          input: z.object({ value: z.string() }).superRefine(async () => {
            startValidation();
            await new Promise<void>(() => {});
          }),
          async execute() {
            executions += 1;
            return 'unreachable';
          },
        }),
      ],
      {
        approvalSecret: 'resume-deadline-validation-secret',
        approvalStateStore,
        policy: approvalPolicy,
      },
    );

    const pending = resumeToolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      {
        ...approvalExecutionOptions,
        requestContext: { ...approvalRequestContext, deadline: 10 },
        ...timing.options,
      },
    );
    await validationStarted;
    expect(timing.scheduledDelays()).toEqual([10, 10]);
    timing.setNow(10);
    timing.fireDeadline();
    timing.fireDeadline();

    const result = await pending;

    expect(result).toMatchObject({
      outcome: 'error',
      errorCategory: 'timeout',
      error: { code: 'TIMEOUT', message: 'Execution deadline exceeded' },
    });
    expect(timing.clearCount()).toBe(1);
    expect(executions).toBe(0);
    expect(resumeToolbox.executions.inspect()).toHaveLength(0);
    expect(await approvalStateStore.state(paused.pendingApproval!.approvalBinding!)).toBe('issued');
  });

  it('rejects non-finite resumed-approval validation deadlines before scheduling', async () => {
    const timing = createManualToolboxDeadlineTiming();
    const { approvalStateStore, executions, paused, resumeToolbox } =
      await createResumeApprovalValidationFixture({
        name: 'resume-non-finite-validation',
        currentInput: z.object({ value: z.string() }),
      });

    await expect(
      resumeToolbox.resumeApproval(paused.pendingApproval as SignedPendingToolApproval, {
        ...approvalExecutionOptions,
        requestContext: { ...approvalRequestContext, deadline: Infinity },
        ...timing.options,
      }),
    ).rejects.toThrow('Execution deadline must be finite');

    expect(timing.scheduledDelayHistory()).toEqual([]);
    expect(executions()).toBe(0);
    expect(await approvalStateStore.state(paused.pendingApproval!.approvalBinding!)).toBe('issued');
  });

  it('times out already-expired resumed-approval schema validation before scheduling', async () => {
    const timing = createManualToolboxDeadlineTiming(10);
    const { approvalStateStore, executions, paused, resumeToolbox } =
      await createResumeApprovalValidationFixture({
        name: 'resume-expired-validation',
        currentInput: z.object({ value: z.string() }),
      });

    const result = await resumeToolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      {
        ...approvalExecutionOptions,
        requestContext: { ...approvalRequestContext, deadline: 10 },
        ...timing.options,
      },
    );

    expect(result).toMatchObject({
      outcome: 'error',
      errorCategory: 'timeout',
      error: { code: 'TIMEOUT', message: 'Execution deadline exceeded' },
    });
    expect(timing.scheduledDelayHistory()).toEqual([]);
    expect(executions()).toBe(0);
    expect(await approvalStateStore.state(paused.pendingApproval!.approvalBinding!)).toBe('issued');
  });

  it('clears resumed-approval validation deadline timers after successful validation', async () => {
    const timing = createManualToolboxDeadlineTiming();
    const { approvalStateStore, executions, paused, resumeToolbox } =
      await createResumeApprovalValidationFixture({
        name: 'resume-successful-validation-cleanup',
        currentInput: z.object({ value: z.string() }).superRefine(async () => {}),
      });

    const result = await resumeToolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      {
        ...approvalExecutionOptions,
        requestContext: { ...approvalRequestContext, deadline: 10 },
        ...timing.options,
      },
    );

    expect(result).toMatchObject({ outcome: 'success', result: 'resumed' });
    expect(timing.clearCount()).toBeGreaterThan(0);
    expect(executions()).toBe(1);
    expect(await approvalStateStore.state(paused.pendingApproval!.approvalBinding!)).toBe(
      'consumed',
    );
  });

  it('clears resumed-approval validation deadline timers when validation rejects', async () => {
    const timing = createManualToolboxDeadlineTiming();
    const { approvalStateStore, executions, paused, resumeToolbox } =
      await createResumeApprovalValidationFixture({
        name: 'resume-rejected-validation-cleanup',
        currentInput: z.object({ value: z.string() }).superRefine(async () => {
          throw new Error('resume validation failed');
        }),
      });

    await expect(
      resumeToolbox.resumeApproval(paused.pendingApproval as SignedPendingToolApproval, {
        ...approvalExecutionOptions,
        requestContext: { ...approvalRequestContext, deadline: 10 },
        ...timing.options,
      }),
    ).rejects.toThrow('resume validation failed');

    expect(timing.clearCount()).toBe(2);
    expect(executions()).toBe(0);
    expect(await approvalStateStore.state(paused.pendingApproval!.approvalBinding!)).toBe('issued');
  });

  it('re-arms long resumed-approval validation deadlines without overflowing timer delay', async () => {
    const maximumTimerDelay = 2_147_483_647;
    const timing = createManualToolboxDeadlineTiming();
    let startValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      startValidation = resolve;
    });
    const { executions, paused, resumeToolbox } = await createResumeApprovalValidationFixture({
      name: 'resume-long-validation-deadline',
      currentInput: z.object({ value: z.string() }).superRefine(async () => {
        startValidation();
        await new Promise<void>(() => {});
      }),
    });
    const controller = new AbortController();

    const pending = resumeToolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      {
        ...approvalExecutionOptions,
        requestContext: { ...approvalRequestContext, deadline: maximumTimerDelay + 1_000 },
        signal: controller.signal,
        ...timing.options,
      },
    );
    const pendingState = pending.then(
      () => 'resolved',
      () => 'rejected',
    );
    await validationStarted;

    expect(timing.scheduledDelayHistory()).toEqual([maximumTimerDelay, maximumTimerDelay]);
    timing.fireDeadline();
    timing.fireDeadline();
    expect(await Promise.race([pendingState, Promise.resolve('pending')])).toBe('pending');
    expect(timing.scheduledDelayHistory()).toEqual([
      maximumTimerDelay,
      maximumTimerDelay,
      maximumTimerDelay,
    ]);
    controller.abort('stop long validation');

    await expect(pending).resolves.toMatchObject({
      outcome: 'error',
      errorCategory: 'cancelled',
      error: { code: 'CANCELLED', message: 'stop long validation' },
    });
    expect(executions()).toBe(0);
  });

  it('uses Error cancellation reasons while resumed-approval validation is pending', async () => {
    let startValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      startValidation = resolve;
    });
    const { executions, paused, resumeToolbox } = await createResumeApprovalValidationFixture({
      name: 'resume-error-cancel-validation',
      currentInput: z.object({ value: z.string() }).superRefine(async () => {
        startValidation();
        await new Promise<void>(() => {});
      }),
    });
    const controller = new AbortController();

    const pending = resumeToolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      {
        ...approvalExecutionOptions,
        signal: controller.signal,
      },
    );
    await validationStarted;
    controller.abort(new Error('error cancellation reason'));

    await expect(pending).resolves.toMatchObject({
      outcome: 'error',
      errorCategory: 'cancelled',
      error: { code: 'CANCELLED', message: 'error cancellation reason' },
    });
    expect(executions()).toBe(0);
  });

  it('uses the default cancellation reason while resumed-approval validation is pending', async () => {
    let startValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      startValidation = resolve;
    });
    const { executions, paused, resumeToolbox } = await createResumeApprovalValidationFixture({
      name: 'resume-default-cancel-validation',
      currentInput: z.object({ value: z.string() }).superRefine(async () => {
        startValidation();
        await new Promise<void>(() => {});
      }),
    });
    const controller = new AbortController();

    const pending = resumeToolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      {
        ...approvalExecutionOptions,
        signal: controller.signal,
      },
    );
    await validationStarted;
    controller.abort({ reason: 'non-string reason' });

    await expect(pending).resolves.toMatchObject({
      outcome: 'error',
      errorCategory: 'cancelled',
      error: { code: 'CANCELLED', message: 'Cancelled' },
    });
    expect(executions()).toBe(0);
  });

  it('uses the default resumed-approval validation deadline scheduler', async () => {
    const { executions, paused, resumeToolbox } = await createResumeApprovalValidationFixture({
      name: 'resume-default-validation-scheduler',
      currentInput: z.object({ value: z.string() }).superRefine(async () => {}),
    });

    const result = await resumeToolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      {
        ...approvalExecutionOptions,
        requestContext: { ...approvalRequestContext, deadline: Date.now() + 60_000 },
      },
    );

    expect(result).toMatchObject({ outcome: 'success', result: 'resumed' });
    expect(executions()).toBe(1);
  });

  it('requires an approval secret before signing or resuming pending approvals', async () => {
    const toolbox = createToolbox(
      [
        createTool({
          name: 'sensitive-action',
          description: 'Requires approval',
          input: z.object({ value: z.string() }),
          async execute({ value }) {
            return value;
          },
        }),
      ],
      {
        policy: {
          beforeExecute() {
            return {
              allow: false,
              status: 'needs_approval',
              reason: 'approval required',
            };
          },
        },
      },
    );

    const paused = await toolbox.execute({
      id: 'unsigned-approval',
      name: 'sensitive-action',
      arguments: { value: 'x' },
    });

    expect(paused.pendingApproval?.approvalToken).toBeUndefined();
    expect(() =>
      toolbox.resumeApproval({
        ...paused.pendingApproval!,
        approvalToken: 'token',
      }),
    ).toThrow('approvalSecret is required');
  });

  it('rejects invalid approval binding lifetimes at toolbox construction', () => {
    for (const approvalBindingTtlMs of [0, -1, Number.NaN, Infinity, -Infinity]) {
      expect(() => createToolbox([], { approvalBindingTtlMs })).toThrow(
        'approvalBindingTtlMs must be finite and positive',
      );
    }
  });

  it('fails approval issuance when a finite lifetime cannot produce a future expiry', async () => {
    const toolbox = createToolbox(
      [
        createTool({
          name: 'overflowing-approval',
          description: 'Requires an approval with an invalid numeric expiry',
          version: '1.0.0',
          input: z.object({}),
          execute: () => 'executed',
        }),
      ],
      {
        approvalSecret: 'overflow-secret',
        approvalBindingTtlMs: Number.MAX_VALUE,
        approvalNow: () => Number.MAX_VALUE,
        policy: { beforeExecute: () => ({ status: 'needs_approval' }) },
      },
    );

    const result = await toolbox.execute(
      { id: 'overflow-call', name: 'overflowing-approval', arguments: {} },
      approvalExecutionOptions,
    );

    expect(result).toMatchObject({
      outcome: 'error',
      error: { message: 'approvalBindingTtlMs produces an invalid approval expiry.' },
    });
  });

  it('consumes approval bindings only after execution admission succeeds', async () => {
    const createApprovalToolbox = (
      store: ReturnType<typeof createProcessLocalApprovalStateStore>,
      policyContext?: () => Record<string, unknown>,
    ) =>
      createToolbox(
        [
          createTool({
            name: 'admission-gated-action',
            description: 'Requires approval',
            version: '1.0.0',
            input: z.object({}),
            execute: () => 'executed',
          }),
        ],
        {
          approvalSecret: 'admission-secret',
          approvalStateStore: store,
          policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
          ...(policyContext ? { policyContext } : {}),
        },
      );

    const createStore = () => {
      const baseStore = createProcessLocalApprovalStateStore();
      let consumeCount = 0;
      return {
        store: {
          issue: baseStore.issue,
          reserve: baseStore.reserve,
          commit: async (...args: Parameters<typeof baseStore.commit>) => {
            consumeCount += 1;
            return baseStore.commit(...args);
          },
          release: baseStore.release,
          consume: async (...args: Parameters<typeof baseStore.consume>) => {
            return baseStore.consume(...args);
          },
          revoke: baseStore.revoke,
          state: baseStore.state,
        },
        get consumeCount() {
          return consumeCount;
        },
      };
    };

    const abortedStore = createStore();
    const abortedToolbox = createApprovalToolbox(abortedStore.store);
    const abortedApproval = await abortedToolbox.execute(
      { id: 'aborted-admission', name: 'admission-gated-action', arguments: {} },
      approvalExecutionOptions,
    );
    const abortedController = new AbortController();
    abortedController.abort('already aborted');
    const abortedResult = await abortedToolbox.resumeApproval(
      abortedApproval.pendingApproval as SignedPendingToolApproval,
      { ...approvalExecutionOptions, signal: abortedController.signal },
    );
    expect(abortedResult.outcome).toBe('error');
    expect(abortedStore.consumeCount).toBe(0);
    const admittedAfterAbort = await abortedToolbox.resumeApproval(
      abortedApproval.pendingApproval as SignedPendingToolApproval,
      approvalExecutionOptions,
    );
    expect(admittedAfterAbort.outcome).toBe('success');
    expect(abortedStore.consumeCount).toBe(1);

    const deferredBaseStore = createProcessLocalApprovalStateStore();
    const deferredApprovalReference: { current?: SignedPendingToolApproval } = {};
    let deferCommit = true;
    let resolveCommitStarted: (() => void) | undefined;
    const commitStarted = new Promise<void>((resolve) => {
      resolveCommitStarted = resolve;
    });
    let resolveDeferredCommit: (() => void) | undefined;
    const deferredStore = {
      issue: deferredBaseStore.issue,
      reserve: deferredBaseStore.reserve,
      commit: () => {
        const deferredApproval = deferredApprovalReference.current!;
        if (!deferCommit) return deferredBaseStore.commit(deferredApproval.approvalBinding!);
        return new Promise<void>((resolve) => {
          resolveCommitStarted?.();
          resolveDeferredCommit = () => {
            void deferredBaseStore.commit(deferredApproval.approvalBinding!).then(resolve);
          };
        });
      },
      release: deferredBaseStore.release,
      consume: deferredBaseStore.consume,
      state: deferredBaseStore.state,
    };
    const deferredToolbox = createApprovalToolbox(deferredStore);
    const deferredApprovalResult = await deferredToolbox.execute(
      { id: 'deferred-admission', name: 'admission-gated-action', arguments: {} },
      approvalExecutionOptions,
    );
    const deferredApproval = deferredApprovalResult.pendingApproval as SignedPendingToolApproval;
    deferredApprovalReference.current = deferredApproval;
    const deferredController = new AbortController();
    const deferredResume = deferredToolbox.resumeApproval(deferredApproval, {
      ...approvalExecutionOptions,
      signal: deferredController.signal,
    });
    await commitStarted;
    deferredController.abort('aborted while reserving approval');
    resolveDeferredCommit?.();
    const deferredResult = await deferredResume;
    expect(deferredResult.outcome).toBe('error');
    deferCommit = false;
    const admittedAfterDeferredAbort = await deferredToolbox.resumeApproval(
      deferredApproval,
      approvalExecutionOptions,
    );
    expect(admittedAfterDeferredAbort.outcome).toBe('success');

    const deferredReserveBaseStore = createProcessLocalApprovalStateStore();
    let deferReserve = true;
    let resolveReserveStarted: (() => void) | undefined;
    const reserveStarted = new Promise<void>((resolve) => {
      resolveReserveStarted = resolve;
    });
    let resolveDeferredReserve: (() => void) | undefined;
    const deferredReserveStore = {
      ...deferredReserveBaseStore,
      reserve: (...arguments_: Parameters<typeof deferredReserveBaseStore.reserve>) => {
        if (!deferReserve) return deferredReserveBaseStore.reserve(...arguments_);
        return new Promise<void>((resolve, reject) => {
          resolveReserveStarted?.();
          resolveDeferredReserve = () => {
            void deferredReserveBaseStore.reserve(...arguments_).then(resolve, reject);
          };
        });
      },
    };
    const deferredReserveToolbox = createApprovalToolbox(deferredReserveStore);
    const deferredReserveApprovalResult = await deferredReserveToolbox.execute(
      { id: 'deferred-reserve-admission', name: 'admission-gated-action', arguments: {} },
      approvalExecutionOptions,
    );
    const deferredReserveApproval =
      deferredReserveApprovalResult.pendingApproval as SignedPendingToolApproval;
    const deferredReserveController = new AbortController();
    const deferredReserveResume = deferredReserveToolbox.resumeApproval(deferredReserveApproval, {
      ...approvalExecutionOptions,
      signal: deferredReserveController.signal,
    });
    await reserveStarted;
    deferredReserveController.abort('aborted while reserving approval');
    resolveDeferredReserve?.();
    const deferredReserveResult = await deferredReserveResume;
    expect(deferredReserveResult.errorCategory).toBe('cancelled');
    deferReserve = false;
    const admittedAfterDeferredReserveAbort = await deferredReserveToolbox.resumeApproval(
      deferredReserveApproval,
      approvalExecutionOptions,
    );
    expect(admittedAfterDeferredReserveAbort.outcome).toBe('success');

    for (const interruptedWrite of ['reserve', 'commit'] as const) {
      const deadlineBaseStore = createProcessLocalApprovalStateStore();
      let currentTime = 0;
      const deadlineStore = {
        ...deadlineBaseStore,
        async reserve(...arguments_: Parameters<typeof deadlineBaseStore.reserve>) {
          await deadlineBaseStore.reserve(...arguments_);
          if (interruptedWrite === 'reserve') currentTime = 10;
        },
        async commit(...arguments_: Parameters<typeof deadlineBaseStore.commit>) {
          await deadlineBaseStore.commit(...arguments_);
          if (interruptedWrite === 'commit') currentTime = 10;
        },
      };
      const deadlineToolbox = createApprovalToolbox(deadlineStore);
      const deadlineApprovalResult = await deadlineToolbox.execute(
        {
          id: `${interruptedWrite}-deadline-admission`,
          name: 'admission-gated-action',
          arguments: {},
        },
        approvalExecutionOptions,
      );
      const deadlineApproval = deadlineApprovalResult.pendingApproval as SignedPendingToolApproval;
      const deadlineResult = await deadlineToolbox.resumeApproval(deadlineApproval, {
        ...approvalExecutionOptions,
        now: () => currentTime,
        requestContext: { ...approvalExecutionOptions.requestContext, deadline: 10 },
      });
      expect(deadlineResult.errorCategory).toBe('timeout');
      currentTime = 0;
      const admittedAfterDeadline = await deadlineToolbox.resumeApproval(
        deadlineApproval,
        approvalExecutionOptions,
      );
      expect(admittedAfterDeadline.outcome).toBe('success');
    }

    const closedStore = createStore();
    const closedToolbox = createApprovalToolbox(closedStore.store);
    const closedApproval = await closedToolbox.execute(
      { id: 'closed-admission', name: 'admission-gated-action', arguments: {} },
      approvalExecutionOptions,
    );
    closedToolbox.closeAdmission();
    await expect(
      closedToolbox.resumeApproval(
        closedApproval.pendingApproval as SignedPendingToolApproval,
        approvalExecutionOptions,
      ),
    ).rejects.toThrow('Execution admission is closed');
    expect(closedStore.consumeCount).toBe(0);

    let failPolicyContext = false;
    const policyStore = createStore();
    const policyToolbox = createApprovalToolbox(policyStore.store, () => {
      if (failPolicyContext) throw new Error('policy context unavailable');
      return {};
    });
    const policyApproval = await policyToolbox.execute(
      { id: 'policy-admission', name: 'admission-gated-action', arguments: {} },
      approvalExecutionOptions,
    );
    failPolicyContext = true;
    const failedPolicyResult = await policyToolbox.resumeApproval(
      policyApproval.pendingApproval as SignedPendingToolApproval,
      approvalExecutionOptions,
    );
    expect(failedPolicyResult.outcome).toBe('error');
    expect(policyStore.consumeCount).toBe(0);
    failPolicyContext = false;
    const admittedAfterPolicyRecovery = await policyToolbox.resumeApproval(
      policyApproval.pendingApproval as SignedPendingToolApproval,
      approvalExecutionOptions,
    );
    expect(admittedAfterPolicyRecovery.outcome).toBe('success');
    expect(policyStore.consumeCount).toBe(1);

    await expect(
      policyToolbox.resumeApproval(
        policyApproval.pendingApproval as SignedPendingToolApproval,
        approvalExecutionOptions,
      ),
    ).rejects.toThrow('already been consumed');
    expect(policyStore.consumeCount).toBe(1);

    const missingBaseStore = createProcessLocalApprovalStateStore();
    const missingStateToolbox = createApprovalToolbox({
      ...missingBaseStore,
      state: async () => undefined,
    });
    const missingStateApproval = await missingStateToolbox.execute(
      { id: 'missing-state-admission', name: 'admission-gated-action', arguments: {} },
      approvalExecutionOptions,
    );
    await expect(
      missingStateToolbox.resumeApproval(
        missingStateApproval.pendingApproval as SignedPendingToolApproval,
        approvalExecutionOptions,
      ),
    ).rejects.toThrow('not found');

    const failedCommitBaseStore = createProcessLocalApprovalStateStore();
    const failedCommitToolbox = createApprovalToolbox({
      ...failedCommitBaseStore,
      commit: async () => {
        throw new Error('approval commit race');
      },
    });
    const failedCommitApproval = await failedCommitToolbox.execute(
      { id: 'failed-commit-admission', name: 'admission-gated-action', arguments: {} },
      approvalExecutionOptions,
    );
    await expect(
      failedCommitToolbox.resumeApproval(
        failedCommitApproval.pendingApproval as SignedPendingToolApproval,
        approvalExecutionOptions,
      ),
    ).rejects.toThrow('approval commit race');
    expect(
      await failedCommitBaseStore.state(failedCommitApproval.pendingApproval!.approvalBinding!),
    ).toBe('issued');
  });

  it('requires versioned tool definitions for durable approvals and invalidates revisions', async () => {
    const approvalStateStore = createProcessLocalApprovalStateStore();
    const makeTool = (version?: string) =>
      createTool({
        name: 'versioned-charge',
        description: 'Requires approval',
        ...(version !== undefined ? { version } : {}),
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          return { charged: cents };
        },
      });
    const policy = {
      beforeExecute: () => ({
        allow: false as const,
        status: 'needs_approval' as const,
        reason: 'approval required',
      }),
    };
    const unversioned = createToolbox([makeTool()], {
      approvalSecret: 'version-secret',
      approvalStateStore,
      policy,
    });

    const unversionedResult = await unversioned.execute(
      { id: 'unversioned-approval', name: 'versioned-charge', arguments: { cents: 100 } },
      approvalExecutionOptions,
    );
    expect(unversionedResult.outcome).toBe('error');
    expect(unversionedResult.error?.message).toContain('versioned tool definition');

    const versionOne = createToolbox([makeTool('1.0.0')], {
      approvalSecret: 'version-secret',
      approvalStateStore,
      policy,
    });
    const versionTwo = createToolbox([makeTool('2.0.0')], {
      approvalSecret: 'version-secret',
      approvalStateStore,
      policy,
    });
    const approvalRevisionTwo = createToolbox([makeTool('1.0.0')], {
      approvalSecret: 'version-secret',
      approvalStateStore,
      approvalRevision: 'approval:2',
      policy,
    });
    const paused = await versionOne.execute(
      { id: 'versioned-approval', name: 'versioned-charge', arguments: { cents: 100 } },
      approvalExecutionOptions,
    );

    await expect(
      versionTwo.resumeApproval(
        paused.pendingApproval! as SignedPendingToolApproval,
        approvalExecutionOptions,
      ),
    ).rejects.toThrow('toolDefinitionRevision does not match');

    await expect(
      approvalRevisionTwo.resumeApproval(
        paused.pendingApproval! as SignedPendingToolApproval,
        approvalExecutionOptions,
      ),
    ).rejects.toThrow('approvalRevision does not match');
  });

  it('validates resumed approvals with the configured approval clock', async () => {
    const toolbox = createToolbox(
      [
        createTool({
          name: 'clock-bound-approval',
          version: '1.0.0',
          description: 'Uses a deterministic approval clock',
          input: z.object({}),
          execute: async () => 'executed',
        }),
      ],
      {
        approvalSecret: 'clock-bound-secret',
        approvalNow: () => 1_000,
        policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
      },
    );
    const paused = await toolbox.execute(
      { id: 'clock-bound-call', name: 'clock-bound-approval', arguments: {} },
      approvalExecutionOptions,
    );

    const resumed = await toolbox.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      approvalExecutionOptions,
    );

    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toBe('executed');
  });

  it('requires request authority for signed approvals and supports revocation', async () => {
    const toolbox = createToolbox(
      [
        createTool({
          name: 'revoke-me',
          version: '1.0.0',
          description: 'Requires approval',
          input: z.object({}),
          execute: () => 'unexpected',
        }),
      ],
      {
        approvalSecret: 'revocation-secret',
        policy: { beforeExecute: () => ({ status: 'needs_approval' }) },
      },
    );

    const missingAuthority = await toolbox.execute({
      id: 'missing-authority',
      name: 'revoke-me',
      arguments: {},
    });
    expect(missingAuthority.outcome).toBe('error');
    expect(missingAuthority.error?.message).toContain('requires request principal');

    const paused = await toolbox.execute(
      { id: 'revoked-approval', name: 'revoke-me', arguments: {} },
      approvalExecutionOptions,
    );
    await expect(
      toolbox.resumeApproval(paused.pendingApproval as SignedPendingToolApproval),
    ).rejects.toThrow('Request context and approval binding are required');
    await toolbox.revokeApproval(paused.pendingApproval as SignedPendingToolApproval);
    await expect(
      toolbox.resumeApproval(paused.pendingApproval as SignedPendingToolApproval, {
        arguments: { unexpected: true },
        ...approvalExecutionOptions,
      }),
    ).rejects.toThrow('revoked');
    await expect(
      toolbox.resumeApproval(
        paused.pendingApproval as SignedPendingToolApproval,
        approvalExecutionOptions,
      ),
    ).rejects.toThrow('revoked');

    const {
      approvalBinding: _approvalBinding,
      approvalToken: _approvalToken,
      ...unboundDescriptor
    } = paused.pendingApproval!;
    const unboundApproval = {
      ...unboundDescriptor,
      approvalToken: hmacSha256HexSync(
        'revocation-secret',
        stableStringifyJson(JSON.parse(JSON.stringify(unboundDescriptor))),
      ),
    } as SignedPendingToolApproval;
    await expect(toolbox.revokeApproval(unboundApproval)).rejects.toThrow(
      'Approval state store and binding are required',
    );
    await expect(toolbox.restoreApproval(unboundApproval)).rejects.toThrow(
      'Approval state store and binding are required',
    );
  });

  it('binds approval consumption to the complete captured authority', async () => {
    const executions: string[] = [];
    const toolbox = createToolbox(
      [
        createTool({
          name: 'authority-bound-action',
          version: '1.0.0',
          description: 'Executes only under the approved authority',
          input: z.object({}),
          execute: () => {
            executions.push('executed');
            return 'ok';
          },
        }),
      ],
      {
        approvalSecret: 'authority-binding-secret',
        policy: { beforeExecute: () => ({ status: 'needs_approval' }) },
      },
    );
    const paused = await toolbox.execute(
      { id: 'authority-bound-call', name: 'authority-bound-action', arguments: {} },
      approvalExecutionOptions,
    );
    const approval = paused.pendingApproval as SignedPendingToolApproval;

    for (const authority of [
      { ...approvalRequestContext.authority, ownerId: 'owner-b' },
      { ...approvalRequestContext.authority, authorizationRevision: 'authorization:2' },
      { ...approvalRequestContext.authority, capabilities: ['tools:execute', 'payments:charge'] },
    ]) {
      await expect(
        toolbox.resumeApproval(approval, {
          requestContext: { ...approvalRequestContext, authority },
        }),
      ).rejects.toMatchObject({ code: 'mismatch' });
    }

    expect(executions).toEqual([]);
    const resumed = await toolbox.resumeApproval(approval, approvalExecutionOptions);
    expect(resumed.outcome).toBe('success');
    expect(executions).toEqual(['executed']);
  });

  it('restores persisted signed approval bindings without reviving terminal bindings', async () => {
    const tool = createTool({
      name: 'restore-me',
      version: '1.0.0',
      description: 'Requires approval across process recovery',
      input: z.object({}),
      execute: () => 'restored',
    });
    const options = {
      approvalSecret: 'restore-secret',
      policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
    };
    const source = createToolbox([tool], options);
    const paused = await source.execute(
      { id: 'restored-approval', name: tool.name, arguments: {} },
      approvalExecutionOptions,
    );
    const approval = paused.pendingApproval as SignedPendingToolApproval;
    const recovered = createToolbox([tool], options);

    await recovered.restoreApproval(approval);
    await recovered.restoreApproval(approval);
    const resumed = await recovered.resumeApproval(approval, approvalExecutionOptions);
    expect(resumed.result).toBe('restored');
    await expect(recovered.restoreApproval(approval)).rejects.toThrow('consumed');

    const revokedSource = createToolbox([tool], options);
    const revokedPause = await revokedSource.execute(
      { id: 'revoked-after-restore', name: tool.name, arguments: {} },
      approvalExecutionOptions,
    );
    const revokedApproval = revokedPause.pendingApproval as SignedPendingToolApproval;
    const revokedRecovery = createToolbox([tool], options);
    await revokedRecovery.restoreApproval(revokedApproval);
    await revokedRecovery.revokeApproval(revokedApproval);
    await expect(revokedRecovery.restoreApproval(revokedApproval)).rejects.toThrow('revoked');
  });

  it('accepts a concurrent restore when the binding is already issued', async () => {
    const tool = createTool({
      name: 'concurrent-restore',
      version: '1.0.0',
      description: 'Concurrent restore',
      input: z.object({}),
      execute: () => 'restored',
    });
    const sourceStore = createProcessLocalApprovalStateStore();
    const options = {
      approvalSecret: 'concurrent-restore-secret',
      approvalStateStore: sourceStore,
      policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
    };
    const paused = await createToolbox([tool], options).execute(
      { id: 'concurrent-restore-call', name: tool.name, arguments: {} },
      approvalExecutionOptions,
    );
    const approval = paused.pendingApproval as SignedPendingToolApproval;
    let firstStateRead = true;
    const concurrentStore = {
      ...sourceStore,
      state: async () => (firstStateRead ? undefined : ('issued' as const)),
      issue: async () => {
        firstStateRead = false;
        throw new Error('concurrent issue');
      },
    };

    await createToolbox([tool], {
      ...options,
      approvalStateStore: concurrentStore,
    }).restoreApproval(approval);
  });

  it('rejects an expired issued binding during approval restoration', async () => {
    const tool = createTool({
      name: 'expired-restore',
      version: '1.0.0',
      description: 'Rejects expired restored approvals',
      input: z.object({}),
      execute: () => 'restored',
    });
    const sourceOptions = {
      approvalSecret: 'expired-restore-secret',
      approvalNow: () => 1_000,
      policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
    };
    const paused = await createToolbox([tool], sourceOptions).execute(
      { id: 'expired-restore-call', name: tool.name, arguments: {} },
      approvalExecutionOptions,
    );
    const approval = paused.pendingApproval as SignedPendingToolApproval;

    await expect(
      createToolbox([tool], {
        ...sourceOptions,
        approvalNow: () => approval.approvalBinding!.expiresAt,
      }).restoreApproval(approval),
    ).rejects.toMatchObject({ code: 'expired' });
  });

  it('rejects persisted approvals with stale toolbox or policy revisions', async () => {
    const approvalStateStore = createProcessLocalApprovalStateStore();
    const makeTool = (version: string) =>
      createTool({
        name: 'stale-revision-restore',
        version,
        description: 'Rejects stale recovery bindings',
        input: z.object({}),
        execute: () => 'restored',
      });
    const tool = makeTool('1.0.0');
    const sourceOptions = {
      approvalSecret: 'stale-revision-secret',
      approvalStateStore,
      policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
    };
    const source = createToolbox([tool], sourceOptions);
    const paused = await source.execute(
      { id: 'stale-revision-approval', name: tool.name, arguments: {} },
      approvalExecutionOptions,
    );
    const approval = paused.pendingApproval as SignedPendingToolApproval;

    for (const { options: revisionOptions, tool: recoveryTool } of [
      { options: { toolboxRevision: 'toolbox:2' }, tool },
      { options: {}, tool: makeTool('2.0.0') },
      { options: { policyRevision: 'policy:2' }, tool },
      { options: { approvalRevision: 'approval:2' }, tool },
    ]) {
      const recovery = createToolbox([recoveryTool], {
        ...sourceOptions,
        ...revisionOptions,
      });
      await expect(recovery.restoreApproval(approval)).rejects.toMatchObject({
        code: 'invalid-binding',
      });
    }
  });

  it('resumes signed input requests with unchanged arguments', async () => {
    const toolbox = createToolbox(
      [
        createTool({
          name: 'collect-name',
          version: '1.0.0',
          description: 'Collect a name',
          input: z.object({ name: z.string() }),
          async execute({ name }) {
            return { name };
          },
        }),
      ],
      {
        approvalSecret: 'input-secret',
        policy: {
          beforeExecute() {
            return {
              allow: false,
              status: 'needs_input',
              reason: 'Name confirmation required',
              action: { message: 'Confirm name' },
            };
          },
        },
      },
    );

    const paused = await toolbox.execute(
      { id: 'input-request', name: 'collect-name', arguments: { name: 'Ada' } },
      approvalExecutionOptions,
    );
    const resumed = await toolbox.resumeApproval(
      paused.pendingApproval! as SignedPendingToolApproval,
      approvalExecutionOptions,
    );

    expect(paused.outcome).toBe('action_required');
    expect(paused.pendingApproval?.action.type).toBe('input');
    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toEqual({ name: 'Ada' });
    expect(resumed.executedArgumentsEdited).toBe(false);
  });

  it('re-runs policy when resuming an approval with unchanged arguments', async () => {
    const tool = createTool({
      name: 'charge-card',
      version: '1.0.0',
      description: 'Charge a payment card',
      input: z.object({ cents: z.number() }),
      async execute({ cents }) {
        return { charged: cents };
      },
    });

    const approvalStateStore = createProcessLocalApprovalStateStore();
    const approvingToolbox = createToolbox([tool], {
      approvalSecret: 'shared-secret',
      approvalStateStore,
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'approval required',
          };
        },
      },
    });
    const denyingToolbox = createToolbox([tool], {
      approvalSecret: 'shared-secret',
      approvalStateStore,
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'denied',
            reason: 'approval no longer valid',
          };
        },
      },
    });

    const paused = await approvingToolbox.execute(
      { id: 'policy-change', name: 'charge-card', arguments: { cents: 100 } },
      approvalExecutionOptions,
    );
    const resumed = await denyingToolbox.resumeApproval(
      paused.pendingApproval! as SignedPendingToolApproval,
      approvalExecutionOptions,
    );

    expect(resumed.outcome).toBe('error');
    expect(resumed.errorCategory).toBe('permission');
    expect(resumed.result).toBeUndefined();
  });

  it('requires the current approval prompt to match the signed approval before resuming', async () => {
    const tool = createTool({
      name: 'charge-card',
      version: '1.0.0',
      description: 'Charge a payment card',
      input: z.object({ cents: z.number() }),
      async execute({ cents }) {
        return { charged: cents };
      },
    });

    const approvalStateStore = createProcessLocalApprovalStateStore();
    const originalToolbox = createToolbox([tool], {
      approvalSecret: 'shared-secret',
      approvalStateStore,
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'Original approval required',
            action: { message: 'Approve original charge' },
          };
        },
      },
    });
    const changedToolbox = createToolbox([tool], {
      approvalSecret: 'shared-secret',
      approvalStateStore,
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'Changed approval required',
            action: { message: 'Approve changed charge' },
          };
        },
      },
    });

    const paused = await originalToolbox.execute(
      { id: 'changed-prompt', name: 'charge-card', arguments: { cents: 100 } },
      approvalExecutionOptions,
    );
    const resumed = await changedToolbox.resumeApproval(
      paused.pendingApproval! as SignedPendingToolApproval,
      approvalExecutionOptions,
    );

    expect(resumed.outcome).toBe('action_required');
    expect(resumed.pendingApproval?.reason).toBe('Changed approval required');
    expect(resumed.result).toBeUndefined();
  });

  it('preserves approval action schemas in signed pending approvals', async () => {
    const toolbox = createToolbox(
      [
        createTool({
          name: 'create-ticket',
          version: '1.0.0',
          description: 'Create a ticket',
          input: z.object({ title: z.string() }),
          async execute({ title }) {
            return { title };
          },
        }),
      ],
      {
        approvalSecret: 'schema-secret',
        policy: {
          beforeExecute() {
            return {
              allow: false,
              status: 'needs_input',
              reason: 'Need ticket metadata',
              action: {
                message: 'Add ticket metadata',
                schema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                  },
                  required: ['title'],
                },
              },
            };
          },
        },
      },
    );

    const paused = await toolbox.execute(
      {
        id: 'schema-approval',
        name: 'create-ticket',
        arguments: { title: 'Investigate approval schema' },
      },
      approvalExecutionOptions,
    );
    const resumed = await toolbox.resumeApproval(
      paused.pendingApproval! as SignedPendingToolApproval,
      approvalExecutionOptions,
    );

    expect(paused.pendingApproval?.action.schema).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
      },
      required: ['title'],
    });
    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toEqual({ title: 'Investigate approval schema' });
  });

  it('does not treat approval arguments with different JSON types as equivalent', async () => {
    const executedValues: unknown[] = [];
    const toolbox = createToolbox(
      [
        createTool({
          name: 'persist-value',
          version: '1.0.0',
          description: 'Persist a value',
          input: z.object({ value: z.union([z.string(), z.number()]) }),
          async execute({ value }) {
            executedValues.push(value);
            return { value };
          },
        }),
      ],
      {
        approvalSecret: 'typed-value-secret',
        policy: {
          beforeExecute() {
            return {
              allow: false,
              status: 'needs_approval',
              reason: 'approval required',
            };
          },
        },
      },
    );

    const paused = await toolbox.execute(
      { id: 'typed-value', name: 'persist-value', arguments: { value: '1' } },
      approvalExecutionOptions,
    );
    const resumed = await toolbox.resumeApproval(
      paused.pendingApproval! as SignedPendingToolApproval,
      {
        arguments: { value: 1 },
        ...approvalExecutionOptions,
      },
    );

    expect(resumed.outcome).toBe('action_required');
    expect(executedValues).toEqual([]);
  });

  it('resumes a durable approval descriptor from a fresh toolbox instance after JSON round-trip (cross-process scenario)', async () => {
    // Regression for A3: the pending-approval descriptor must be JSON-serializable
    // and must resume correctly in a fresh toolbox instance (simulating a different
    // process or worker that persisted and reloaded the descriptor).
    const charges: number[] = [];
    const sharedSecret = 'cross-process-secret';
    const sharedApprovalState = createProcessLocalApprovalStateStore();

    function buildToolbox(approvalSecret = sharedSecret) {
      return createToolbox(
        [
          createTool({
            name: 'charge-card',
            version: '1.0.0',
            description: 'Charge a payment card',
            input: z.object({ cents: z.number(), confirmed: z.boolean().optional() }),
            async execute({ cents }) {
              charges.push(cents);
              return { charged: cents };
            },
          }),
        ],
        {
          approvalSecret,
          approvalStateStore: sharedApprovalState,
          policy: {
            beforeExecute(context) {
              if (
                context.params &&
                typeof context.params === 'object' &&
                'confirmed' in context.params &&
                (context.params as Record<string, unknown>)['confirmed'] === true
              ) {
                return { allow: true };
              }
              return {
                allow: false,
                status: 'needs_approval',
                reason: 'Operator approval required',
                action: { message: 'Approve charge' },
              };
            },
          },
        },
      );
    }

    // "Process A": originates the tool call and pauses for approval.
    const processAToolbox = buildToolbox();
    const paused = await processAToolbox.execute(
      { id: 'cross-proc-call', name: 'charge-card', arguments: { cents: 250 } },
      approvalExecutionOptions,
    );

    expect(paused.outcome).toBe('action_required');
    expect(paused.pendingApproval?.approvalToken).toBeDefined();

    // Serialize the descriptor to JSON (e.g., to persist in a database or message queue).
    const serialized = JSON.stringify(paused.pendingApproval);
    // Deserialize it as if retrieved in a separate process.
    const deserialized = JSON.parse(serialized) as SignedPendingToolApproval;

    // "Process B": a fresh toolbox instance (no shared memory with process A).
    const processBToolbox = buildToolbox();

    // Resume with the original arguments — the token must still be valid.
    const resumed = await processBToolbox.resumeApproval(deserialized, {
      arguments: { cents: 250, confirmed: true },
      ...approvalExecutionOptions,
    });

    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toEqual({ charged: 250 });
    // Arguments were edited (confirmed: true added), so this flag must be set.
    expect(resumed.executedArgumentsEdited).toBe(true);
    // The charge ran exactly once.
    expect(charges).toEqual([250]);

    // Negative case: a fresh toolbox with a DIFFERENT secret must reject the same
    // deserialized descriptor. This proves resumption depends only on the
    // descriptor + the shared secret (genuine cross-process durability), not on
    // any process-local pending-approval state keyed by token.
    const wrongSecretToolbox = buildToolbox('a-different-secret');
    expect(() =>
      wrongSecretToolbox.resumeApproval(deserialized, {
        arguments: { cents: 250, confirmed: true },
      }),
    ).toThrow('invalid approval token');
    // The rejected resume must not have charged again.
    expect(charges).toEqual([250]);
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

  it('extend() preserves the configured approval state store', async () => {
    const base = createToolbox(
      [
        createTool({
          name: 'approved-action',
          version: '1.0.0',
          description: 'Requires approval',
          input: z.object({}),
          execute: async () => 'approved',
        }),
      ],
      {
        approvalSecret: 'extend-approval-secret',
        approvalStateStore: createProcessLocalApprovalStateStore(),
        policy: {
          beforeExecute: () => ({
            allow: false,
            status: 'needs_approval',
            reason: 'approval required',
          }),
        },
      },
    );
    const extended = base.extend({
      name: 'additional-tool',
      description: 'Additional tool',
      input: z.object({}),
      execute: async () => 'additional',
    });
    const paused = await base.execute(
      { id: 'extend-approval', name: 'approved-action', arguments: {} },
      approvalExecutionOptions,
    );
    const resumed = await extended.resumeApproval(
      paused.pendingApproval! as SignedPendingToolApproval,
      approvalExecutionOptions,
    );
    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toBe('approved');
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
    await expect(
      toolbox.execute({ id: 'adder', name: 'adder', arguments: { a: 1, b: 2 } }),
    ).rejects.toThrow('Execution admission is closed');
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

  it('completion aborts active calls and waits for the toolbox to become idle', async () => {
    let observedSignal: AbortSignal | undefined;
    const toolbox = createToolbox([
      createTool({
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
      }),
    ]);

    const pending = toolbox.execute({ name: 'lifecycle-abort', arguments: {} });
    while (!observedSignal) await Promise.resolve();
    const completion = toolbox.complete();
    expect(toolbox.executionSignal.aborted).toBe(true);
    expect(toolbox.activeExecutions).toBe(1);
    await completion;
    const result = await pending;
    expect(result.errorCategory).toBe('cancelled');
    expect(observedSignal?.aborted).toBe(true);
    expect(toolbox.activeExecutions).toBe(0);
    expect(toolbox.completed).toBe(true);
    await toolbox.whenIdle();
    await expect(toolbox.execute({ name: 'lifecycle-abort', arguments: {} })).rejects.toThrow(
      'Execution admission is closed',
    );
  });

  it('supports explicit admission closure, scoped abort, and shutdown reporting', async () => {
    let release!: () => void;
    const toolbox = createToolbox([
      createTool({
        name: 'managed-lifecycle',
        description: 'managed lifecycle',
        input: z.object({}),
        async execute(_params, context) {
          await new Promise<void>((resolve) => {
            release = resolve;
            context.signal?.addEventListener('abort', resolve, { once: true });
          });
          return 'released';
        },
      }),
    ]);

    const pending = toolbox.execute({
      id: 'managed-call',
      name: 'managed-lifecycle',
      arguments: {},
    });
    while (!release) await Promise.resolve();
    expect(toolbox.abort({ callId: 'managed-call' }, 'stop managed call')).toBe(1);
    release();
    await pending;

    const report = await toolbox.shutdown({ policy: 'drain' });
    expect(report).toMatchObject({ admissionClosed: true, policy: 'drain', terminal: 1 });

    const closed = createToolbox([]);
    closed.closeAdmission();
    await expect(closed.execute({ name: 'missing', arguments: {} })).rejects.toThrow(
      'Execution admission is closed',
    );
  });

  it('settles a deadline-aborted parent after a cancellation-ignoring callback returns', async () => {
    let release!: () => void;
    const toolbox = createToolbox([
      createTool({
        name: 'ignore-deadline-abort',
        description: 'Returns only after an external release',
        input: z.object({}),
        async execute() {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return 'late result';
        },
      }),
    ]);
    const execution = toolbox.execute(
      { id: 'ignore-deadline-call', name: 'ignore-deadline-abort', arguments: {} },
      { requestContext: { ...approvalRequestContext, deadline: Date.now() + 5 } },
    );
    while (!release) await Promise.resolve();
    await expect(execution).resolves.toMatchObject({
      outcome: 'error',
      errorMessage: 'Execution deadline exceeded',
    });
    let idle = false;
    const whenIdle = toolbox.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    release();
    await whenIdle;
    expect(idle).toBe(true);
    expect(toolbox.activeExecutions).toBe(0);
  });

  it('returns unconsumed child streams before toolbox shutdown resolves', async () => {
    let returned = 0;
    const toolbox = createToolbox([
      createTool({
        name: 'toolbox-stream-shutdown',
        description: 'stream owned by a toolbox',
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
      }),
    ]);

    const result = await toolbox.execute(
      { id: 'toolbox-stream', name: 'toolbox-stream-shutdown', arguments: {} },
      { stream: true },
    );
    expect(result.stream).toBeDefined();
    expect(toolbox.activeExecutions).toBe(1);

    const report = await toolbox.shutdown();
    expect(returned).toBe(1);
    expect(report).toMatchObject({ terminal: 1, unknownEffects: 0 });
    expect(toolbox.activeExecutions).toBe(0);
  });

  it('reports raw toolbox streams that cannot acknowledge return', async () => {
    const toolbox = createToolbox([], {
      toolFactory(configuration, { buildDefaultTool }) {
        const tool = buildDefaultTool(configuration);
        return new Proxy(tool, {
          get(target, property, receiver) {
            if (property !== 'execute') return Reflect.get(target, property, receiver);
            return async () => {
              const stream = {
                [Symbol.asyncIterator]() {
                  return {
                    async next() {
                      return new Promise<IteratorResult<string>>(() => {});
                    },
                  };
                },
              };
              return {
                callId: 'raw-unreturnable',
                toolCallId: 'raw-unreturnable',
                toolName: target.name,
                outcome: 'success' as const,
                content: '[stream]',
                result: stream,
                stream,
              };
            };
          },
        });
      },
    });
    toolbox.register({
      name: 'raw-unreturnable-stream',
      description: 'raw stream without return',
      input: z.object({}),
      async execute() {},
    });
    await toolbox.execute(
      { id: 'raw-unreturnable', name: 'raw-unreturnable-stream', arguments: {} },
      { stream: true },
    );

    const report = await toolbox.shutdown();
    expect(report).toMatchObject({ terminal: 0, unknownEffects: 1 });
  });

  it('reports raw toolbox stream return failures', async () => {
    const toolbox = createToolbox([], {
      toolFactory(configuration, { buildDefaultTool }) {
        const tool = buildDefaultTool(configuration);
        return new Proxy(tool, {
          get(target, property, receiver) {
            if (property !== 'execute') return Reflect.get(target, property, receiver);
            return async () => {
              const stream = {
                [Symbol.asyncIterator]() {
                  return {
                    async next() {
                      return new Promise<IteratorResult<string>>(() => {});
                    },
                    async return() {
                      throw new Error('raw stream return failed');
                    },
                  };
                },
              };
              return {
                callId: 'raw-failing',
                toolCallId: 'raw-failing',
                toolName: target.name,
                outcome: 'success' as const,
                content: '[stream]',
                result: stream,
                stream,
              };
            };
          },
        });
      },
    });
    toolbox.register({
      name: 'raw-failing-stream',
      description: 'raw stream with failing return',
      input: z.object({}),
      async execute() {},
    });
    await toolbox.execute(
      { id: 'raw-failing', name: 'raw-failing-stream', arguments: {} },
      { stream: true },
    );

    const report = await toolbox.shutdown();
    expect(report.cleanupFailures).toBe(1);
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

  it('supports inspection, sequential execution, afterExecute hooks, and context.emit', async () => {
    const statuses: string[] = [];
    const afterExecuteCalls: string[] = [];
    const toolbox = createToolbox([], {
      policy: {
        afterExecute(context) {
          afterExecuteCalls.push(`registry:${context.toolName}`);
        },
      },
    });

    toolbox.addEventListener('status:update', (event: any) => {
      statuses.push(`${event.callId}:${event.message as string}`);
    });

    toolbox.register({
      name: 'sequenced-status',
      description: 'emits toolbox status updates',
      input: z.object({ value: z.string() }),
      policy: {
        afterExecute(context) {
          afterExecuteCalls.push(`tool:${context.toolName}`);
        },
      },
      async execute({ value }, context) {
        context.emit('status:update', {
          callId: context.toolCall.id,
          name: context.toolCall.name,
          status: 'running',
          message: value,
        });
        return value.toUpperCase();
      },
    });

    const inspection = toolbox.inspect('summary');
    expect(inspection.counts.total).toBe(1);
    expect(inspection.tools[0]?.name).toBe('sequenced-status');

    const results = await toolbox.execute(
      [
        { id: 'sequence-1', name: 'sequenced-status', arguments: { value: 'first' } },
        { id: 'sequence-2', name: 'sequenced-status', arguments: { value: 'second' } },
      ],
      { mode: 'sequential', concurrency: 2 },
    );

    expect(results.map((result) => result.result)).toEqual(['FIRST', 'SECOND']);
    expect(statuses).toEqual(['sequence-1:first', 'sequence-2:second']);
    expect(afterExecuteCalls).toEqual([
      'tool:sequenced-status',
      'registry:sequenced-status',
      'tool:sequenced-status',
      'registry:sequenced-status',
    ]);
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
    it('forwards and intersects request capabilities across toolbox policies', async () => {
      let observedCapabilities: readonly string[] = [];
      const toolbox = createToolbox(
        [
          createTool({
            name: 'authority-capture',
            description: 'captures narrowed authority',
            input: z.object({}),
            policy: { beforeExecute: () => ({ allow: true, capabilities: ['read', 'write'] }) },
            async execute(_input, context) {
              observedCapabilities = context.requestContext?.authority.capabilities ?? [];
              expect(Object.isFrozen(context.effectiveContext)).toBe(true);
              expect(Object.isFrozen(context.effectiveContext?.authority)).toBe(true);
              return 'ok';
            },
          }),
        ],
        {
          policy: { beforeExecute: () => ({ allow: true, capabilities: ['read', 'admin'] }) },
        },
      );
      await toolbox.execute(
        { name: 'authority-capture', arguments: {} },
        {
          requestContext: {
            authority: {
              principalId: 'principal-a',
              tenantId: 'tenant-a',
              ownerId: 'owner-a',
              capabilities: ['read', 'write', 'admin'],
              authorizationRevision: 'authorization:1',
            },
          },
        },
      );
      expect(observedCapabilities).toEqual(['read']);
    });

    it('treats wildcard policy capabilities as the unrestricted intersection identity', async () => {
      const requestContext = {
        authority: {
          principalId: 'principal-a',
          tenantId: 'tenant-a',
          ownerId: 'owner-a',
          capabilities: ['read', 'write'],
          authorizationRevision: 'authorization:1',
        },
      };
      const observedCapabilities: readonly string[][] = [];

      const createCapabilityToolbox = (
        registryCapabilities: readonly string[],
        toolCapabilities: readonly string[],
      ) =>
        createToolbox(
          [
            createTool({
              name: 'wildcard-capability-capture',
              description: 'captures wildcard capability intersection',
              input: z.object({}),
              policy: { beforeExecute: () => ({ allow: true, capabilities: toolCapabilities }) },
              async execute(_input, context) {
                observedCapabilities.push([
                  ...(context.requestContext?.authority.capabilities ?? []),
                ]);
                return 'ok';
              },
            }),
          ],
          {
            policy: { beforeExecute: () => ({ allow: true, capabilities: registryCapabilities }) },
          },
        );

      await createCapabilityToolbox(['*'], ['read']).execute(
        { name: 'wildcard-capability-capture', arguments: {} },
        { requestContext },
      );
      await createCapabilityToolbox(['read'], ['*']).execute(
        { name: 'wildcard-capability-capture', arguments: {} },
        { requestContext },
      );

      expect(observedCapabilities).toEqual([['read'], ['read']]);
    });

    it('evaluates tool policy against registry-narrowed request capabilities', async () => {
      let executed = false;
      let observedToolPolicyCapabilities: readonly string[] = [];
      const toolbox = createToolbox(
        [
          createTool({
            name: 'registry-narrowed-tool-policy',
            description: 'authorizes from policy context capabilities',
            input: z.object({}),
            policy: {
              beforeExecute(context) {
                const policyContext = context.policyContext as
                  { capabilities?: readonly string[] } | undefined;
                observedToolPolicyCapabilities = policyContext?.capabilities ?? [];
                if (observedToolPolicyCapabilities.includes('payments:charge')) {
                  return { allow: true, capabilities: ['payments:charge'] };
                }
                return {
                  allow: false,
                  reason: 'Registry removed charge capability',
                };
              },
            },
            async execute() {
              executed = true;
              return 'charged';
            },
          }),
        ],
        {
          policy: {
            beforeExecute: () => ({ allow: true, capabilities: ['reports:read'] }),
          },
        },
      );

      const result = await toolbox.execute(
        { name: 'registry-narrowed-tool-policy', arguments: {} },
        {
          requestContext: {
            authority: {
              principalId: 'principal-a',
              tenantId: 'tenant-a',
              ownerId: 'owner-a',
              capabilities: ['reports:read', 'payments:charge'],
              authorizationRevision: 'authorization:1',
            },
          },
        },
      );

      expect(observedToolPolicyCapabilities).toEqual(['reports:read']);
      expect(executed).toBe(false);
      expect(result.outcome).toBe('error');
      expect(result.error?.message).toBe('Registry removed charge capability');
    });

    it('leaves policy context unchanged when it has no valid request authority', async () => {
      const malformedRequestContexts = ['not-an-object', { authority: 'not-an-object' }];

      for (const requestContext of malformedRequestContexts) {
        let observedRequestContext: unknown;
        const toolbox = createToolbox(
          [
            createTool({
              name: 'malformed-policy-context',
              description: 'observes malformed request authority',
              input: z.object({}),
              policyContext: { requestContext },
              policy: {
                beforeExecute(context) {
                  observedRequestContext = (
                    context.policyContext as { requestContext?: unknown } | undefined
                  )?.requestContext;
                  return { allow: true };
                },
              },
              async execute() {
                return 'ok';
              },
            }),
          ],
          {
            policy: {
              beforeExecute: () => ({ allow: true, capabilities: ['reports:read'] }),
            },
          },
        );

        const result = await toolbox.execute({ name: 'malformed-policy-context', arguments: {} });

        expect(result.outcome).toBe('success');
        expect(observedRequestContext).toEqual(requestContext);
      }
    });

    it('reports narrowed request capabilities to afterExecute policy hooks', async () => {
      const observed = {
        registryCapabilities: [] as readonly string[],
        registryRequestCapabilities: [] as readonly string[],
        toolCapabilities: [] as readonly string[],
        toolRequestCapabilities: [] as readonly string[],
      };
      const readCapabilities = (context: { policyContext?: unknown }) => {
        const policyContext = context.policyContext as
          | {
              capabilities?: readonly string[];
              requestContext?: { authority?: { capabilities?: readonly string[] } };
            }
          | undefined;
        return {
          capabilities: policyContext?.capabilities ?? [],
          requestCapabilities: policyContext?.requestContext?.authority?.capabilities ?? [],
        };
      };
      const toolbox = createToolbox(
        [
          createTool({
            name: 'after-authority-capture',
            description: 'captures narrowed authority in afterExecute',
            input: z.object({}),
            policy: {
              beforeExecute: () => ({ allow: true, capabilities: ['read', 'write'] }),
              afterExecute(context) {
                const capabilities = readCapabilities(context);
                observed.toolCapabilities = capabilities.capabilities;
                observed.toolRequestCapabilities = capabilities.requestCapabilities;
              },
            },
            async execute() {
              return 'ok';
            },
          }),
        ],
        {
          policy: {
            beforeExecute: () => ({ allow: true, capabilities: ['read', 'admin'] }),
            afterExecute(context) {
              const capabilities = readCapabilities(context);
              observed.registryCapabilities = capabilities.capabilities;
              observed.registryRequestCapabilities = capabilities.requestCapabilities;
            },
          },
        },
      );

      const result = await toolbox.execute(
        { name: 'after-authority-capture', arguments: {} },
        {
          requestContext: {
            authority: {
              principalId: 'principal-a',
              tenantId: 'tenant-a',
              ownerId: 'owner-a',
              capabilities: ['read', 'write', 'admin'],
              authorizationRevision: 'authorization:1',
            },
          },
        },
      );

      expect(result.result).toBe('ok');
      expect(observed.toolCapabilities).toEqual(['read']);
      expect(observed.toolRequestCapabilities).toEqual(['read']);
      expect(observed.registryCapabilities).toEqual(['read']);
      expect(observed.registryRequestCapabilities).toEqual(['read']);
    });

    it('records the full tool id in effective execution context revisions', async () => {
      let observedToolDefinitionRevision: string | undefined;
      const toolbox = createToolbox([
        createTool({
          namespace: 'payments',
          name: 'charge-card',
          version: '2026-08-27',
          description: 'charges a card',
          input: z.object({}),
          async execute(_input, context) {
            observedToolDefinitionRevision = context.effectiveContext?.revisions.toolDefinition;
            return 'ok';
          },
        }),
      ]);
      const tool = toolbox.getTool('charge-card');

      const result = await toolbox.execute(
        { name: 'charge-card', arguments: {} },
        { requestContext: approvalRequestContext },
      );

      expect(result.result).toBe('ok');
      expect(tool).toBeDefined();
      expect(observedToolDefinitionRevision).toBe(tool?.id);
      expect(observedToolDefinitionRevision).toBe('payments:charge-card@2026-08-27');
    });

    it('records narrowed effective authority in toolbox privileged lifecycle snapshots for single calls', async () => {
      const tool = createTool({
        name: 'single-lifecycle-authority',
        description: 'narrows authority for a single lifecycle snapshot',
        input: z.object({}),
        policy: { beforeExecute: () => ({ allow: true, capabilities: ['read', 'write'] }) },
        async execute() {
          return 'ok';
        },
      });
      const toolbox = createToolbox([tool], {
        policy: { beforeExecute: () => ({ allow: true, capabilities: ['read', 'admin'] }) },
      });

      const result = await toolbox.execute(
        { id: 'single-lifecycle-call', name: 'single-lifecycle-authority', arguments: {} },
        {
          requestContext: {
            authority: {
              principalId: 'principal-a',
              tenantId: 'tenant-a',
              ownerId: 'owner-a',
              capabilities: ['read', 'write', 'admin'],
              authorizationRevision: 'authorization:1',
            },
          },
        },
      );

      const [snapshot] = toolbox.executions.inspectPrivileged({
        callId: 'single-lifecycle-call',
      });
      expect(result.result).toBe('ok');
      expect(snapshot?.snapshot.toolName).toBe('single-lifecycle-authority');
      expect(snapshot?.context?.authority.capabilities).toEqual(['read']);
      expect(snapshot?.context?.revisions.toolDefinition).toBe(tool.id);
    });

    it('exposes per-child effective contexts in toolbox privileged lifecycle snapshots for batches', async () => {
      const readTool = createTool({
        name: 'batch-lifecycle-read',
        description: 'narrows batch authority to read',
        input: z.object({}),
        policy: { beforeExecute: () => ({ allow: true, capabilities: ['read'] }) },
        async execute() {
          return 'read';
        },
      });
      const writeTool = createTool({
        name: 'batch-lifecycle-write',
        description: 'narrows batch authority to write',
        input: z.object({}),
        policy: { beforeExecute: () => ({ allow: true, capabilities: ['write'] }) },
        async execute() {
          return 'write';
        },
      });
      const toolbox = createToolbox([readTool, writeTool], {
        policy: { beforeExecute: () => ({ allow: true, capabilities: ['read', 'write'] }) },
      });

      const result = await toolbox.execute(
        [
          { id: 'batch-read-call', name: 'batch-lifecycle-read', arguments: {} },
          { id: 'batch-write-call', name: 'batch-lifecycle-write', arguments: {} },
        ],
        {
          requestContext: {
            authority: {
              principalId: 'principal-a',
              tenantId: 'tenant-a',
              ownerId: 'owner-a',
              capabilities: ['read', 'write', 'admin'],
              authorizationRevision: 'authorization:1',
            },
          },
        },
      );

      const [batchSnapshot] = toolbox.executions.inspectPrivileged({ toolName: 'toolbox.batch' });
      const childSnapshots = toolbox.executions
        .inspectPrivileged()
        .filter(
          ({ snapshot }) => snapshot.parentExecutionId === batchSnapshot?.snapshot.executionId,
        )
        .sort((left, right) => left.snapshot.callId.localeCompare(right.snapshot.callId));

      expect(result.map(({ result }) => result)).toEqual(['read', 'write']);
      expect(childSnapshots).toHaveLength(2);
      expect(
        childSnapshots.map(({ context, snapshot }) => ({
          callId: snapshot.callId,
          capabilities: context?.authority.capabilities,
          toolDefinition: context?.revisions.toolDefinition,
        })),
      ).toEqual([
        {
          callId: 'batch-read-call',
          capabilities: ['read'],
          toolDefinition: readTool.id,
        },
        {
          callId: 'batch-write-call',
          capabilities: ['write'],
          toolDefinition: writeTool.id,
        },
      ]);
    });

    it('completes cleanup for aborted per-child batch lifecycle records', async () => {
      const controller = new AbortController();
      let startedCount = 0;
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      const tool = createTool({
        name: 'batch-lifecycle-abort',
        description: 'observes abort cleanup for batch children',
        input: z.object({}),
        async execute(_input, context) {
          startedCount += 1;
          if (startedCount === 2) resolveStarted();
          await new Promise<void>((resolve) => {
            if (context.signal?.aborted) resolve();
            else context.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return 'stopped';
        },
      });
      const toolbox = createToolbox([tool]);
      const execution = toolbox.execute(
        [
          { id: 'batch-abort-one', name: tool.name, arguments: {} },
          { id: 'batch-abort-two', name: tool.name, arguments: {} },
        ],
        { requestContext: approvalRequestContext, signal: controller.signal },
      );

      await started;
      const [activeBatchSnapshot] = toolbox.executions.inspectPrivileged({
        toolName: 'toolbox.batch',
      });
      const activeChildren = toolbox.executions
        .inspectPrivileged()
        .filter(
          ({ snapshot }) =>
            snapshot.parentExecutionId === activeBatchSnapshot?.snapshot.executionId,
        );
      for (const { snapshot } of activeChildren) {
        toolbox.executions.abort({ executionId: snapshot.executionId }, 'stop child');
      }
      controller.abort('stop batch');
      await execution;

      const [batchSnapshot] = toolbox.executions.inspectPrivileged({ toolName: 'toolbox.batch' });
      const childSnapshots = toolbox.executions
        .inspectPrivileged()
        .filter(
          ({ snapshot }) => snapshot.parentExecutionId === batchSnapshot?.snapshot.executionId,
        );
      expect(childSnapshots).toHaveLength(2);
      expect(
        childSnapshots.map(({ snapshot }) => ({
          state: snapshot.state,
          cleanup: snapshot.cleanup.status,
        })),
      ).toEqual([
        { state: 'terminal', cleanup: 'completed' },
        { state: 'terminal', cleanup: 'completed' },
      ]);
    });

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
          await new Promise<void>((resolve) => {
            context?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return 'ok';
        },
      });

      const controller = new AbortController();
      const pending = toolbox.execute(
        { name: 'capture', arguments: {} },
        { signal: controller.signal, timeout: 42 },
      );
      while (!observed.signal) await Promise.resolve();
      expect(observed.signal).toBeDefined();
      expect(observed.signal).not.toBe(controller.signal);
      controller.abort('caller stopped');
      expect(observed.signal?.aborted).toBe(true);
      await expect(pending).resolves.toMatchObject({ errorCategory: 'cancelled' });
      expect(observed.timeout).toBe(42);
    });

    it('uses request authority owner and deadline for toolbox lifecycle admission', async () => {
      let executions = 0;
      const toolbox = createToolbox([
        createTool({
          name: 'expired-toolbox-deadline',
          description: 'rejects expired toolbox deadlines',
          input: z.object({}),
          async execute() {
            executions += 1;
            return 'unreachable';
          },
        }),
      ]);
      const requestContext = {
        ...approvalRequestContext,
        deadline: 99,
        authority: { ...approvalRequestContext.authority, ownerId: 'request-owner' },
      };

      const result = await toolbox.execute(
        { id: 'expired-toolbox-deadline-call', name: 'expired-toolbox-deadline', arguments: {} },
        { now: () => 100, requestContext },
      );

      expect(result).toMatchObject({ outcome: 'error', errorCategory: 'timeout' });
      expect(executions).toBe(0);
      expect(toolbox.executions.inspect({ ownerId: 'request-owner' })).toEqual([
        expect.objectContaining({
          callId: 'expired-toolbox-deadline-call',
          state: 'terminal',
          abortSource: 'deadline',
        }),
      ]);
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

      await Promise.resolve();
      toolbox.register(makeConfiguration({ name: 'retry-embed' }));
      await Promise.resolve();

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
      await Promise.resolve();

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

    it('exposes public event and context helpers on the toolbox surface', () => {
      const toolbox = createToolbox([], {
        context: {
          workspace: 'agent-bureau',
        },
      });

      const receivedStatuses: string[] = [];
      const unsubscribe = toolbox.addEventListener('status:update', (event) => {
        receivedStatuses.push(event.status);
      });

      const directDispatchResult = toolbox.dispatchEvent(new Event('noop'));
      expect(directDispatchResult).toBe(true);

      const emitted = toolbox.emit('status:update', {
        callId: 'call-1',
        name: 'sum',
        status: 'working',
      });
      expect(emitted).toBe(true);
      expect(receivedStatuses).toEqual(['working']);

      unsubscribe();
      toolbox.emit('status:update', {
        callId: 'call-2',
        name: 'sum',
        status: 'done',
      });
      expect(receivedStatuses).toEqual(['working']);

      expect(toolbox.getContext?.()).toEqual({ workspace: 'agent-bureau' });
    });
  });

  describe('status-only policy decisions', () => {
    it('requires distinct registry and tool pauses to be satisfied in policy order', async () => {
      let executed = false;
      const baseApprovalStateStore = createProcessLocalApprovalStateStore();
      let approvalIssueCount = 0;
      const approvalStateStore: typeof baseApprovalStateStore = {
        ...baseApprovalStateStore,
        async issue(binding) {
          approvalIssueCount += 1;
          if (approvalIssueCount === 2) {
            throw new Error('replacement approval issue failed');
          }
          await baseApprovalStateStore.issue(binding);
        },
      };
      const toolbox = createToolbox(
        [
          createTool({
            name: 'multi-pause-operation',
            version: '1.0.0',
            description: 'requires approval and input',
            input: z.object({}),
            policy: {
              beforeExecute: () => ({
                status: 'needs_input',
                reason: 'Tool needs input',
                action: { message: 'Provide tool input' },
              }),
            },
            async execute() {
              executed = true;
              return 'completed';
            },
          }),
        ],
        {
          approvalSecret: 'multi-pause-secret',
          approvalStateStore,
          policy: {
            beforeExecute: () => ({
              status: 'needs_approval',
              reason: 'Registry needs approval',
              action: { message: 'Approve registry policy' },
            }),
          },
        },
      );

      const registryPaused = await toolbox.execute(
        { id: 'call-multi-pause', name: 'multi-pause-operation', arguments: {} },
        approvalExecutionOptions,
      );
      expect(approvalIssueCount).toBe(1);
      const failedTransition = await toolbox.resumeApproval(
        registryPaused.pendingApproval! as SignedPendingToolApproval,
        approvalExecutionOptions,
      );
      expect(approvalIssueCount).toBe(2);
      expect(failedTransition.errorMessage).toContain('replacement approval issue failed');
      const toolPaused = await toolbox.resumeApproval(
        registryPaused.pendingApproval! as SignedPendingToolApproval,
        approvalExecutionOptions,
      );
      const resumed = await toolbox.resumeApproval(
        toolPaused.pendingApproval! as SignedPendingToolApproval,
        approvalExecutionOptions,
      );

      expect(registryPaused.outcome).toBe('action_required');
      expect(registryPaused.action).toMatchObject({
        type: 'approval',
        message: 'Approve registry policy',
      });
      expect(registryPaused.pendingApproval?.policyPauseTier).toBe('registry');
      expect(toolPaused.outcome).toBe('action_required');
      expect(toolPaused.action).toMatchObject({
        type: 'input',
        message: 'Provide tool input',
      });
      expect(toolPaused.pendingApproval?.satisfiedPolicyPauses).toEqual([
        {
          action: { type: 'approval', message: 'Approve registry policy' },
          reason: 'Registry needs approval',
          tier: 'registry',
        },
      ]);
      expect(() =>
        toolbox.resumeApproval({
          ...(toolPaused.pendingApproval! as SignedPendingToolApproval),
          satisfiedPolicyPauses: [],
        }),
      ).toThrow('invalid approval token');
      await expect(
        toolbox.resumeApproval(
          registryPaused.pendingApproval! as SignedPendingToolApproval,
          approvalExecutionOptions,
        ),
      ).rejects.toThrow('already been consumed');
      expect(resumed.outcome).toBe('success');
      expect(resumed.result).toBe('completed');
      expect(executed).toBe(true);
    });

    it('does not let a disappeared registry pause satisfy an identical tool pause', async () => {
      let registryChecks = 0;
      let executed = false;
      const toolbox = createToolbox(
        [
          createTool({
            name: 'tier-bound-pause',
            version: '1.0.0',
            description: 'requires a tool-level approval',
            input: z.object({}),
            policy: {
              beforeExecute: () => ({
                status: 'needs_approval',
                reason: 'Approval required',
                action: { message: 'Approve operation' },
              }),
            },
            async execute() {
              executed = true;
              return 'completed';
            },
          }),
        ],
        {
          approvalSecret: 'tier-bound-pause-secret',
          policy: {
            beforeExecute: () => {
              registryChecks += 1;
              return registryChecks === 1
                ? {
                    status: 'needs_approval',
                    reason: 'Approval required',
                    action: { message: 'Approve operation' },
                  }
                : { allow: true };
            },
          },
        },
      );

      const registryPaused = await toolbox.execute(
        { id: 'call-tier-bound-pause', name: 'tier-bound-pause', arguments: {} },
        approvalExecutionOptions,
      );
      const toolPaused = await toolbox.resumeApproval(
        registryPaused.pendingApproval! as SignedPendingToolApproval,
        approvalExecutionOptions,
      );

      expect(registryPaused.pendingApproval?.policyPauseTier).toBe('registry');
      expect(toolPaused.outcome).toBe('action_required');
      expect(toolPaused.pendingApproval?.policyPauseTier).toBe('tool');
      expect(toolPaused.pendingApproval?.satisfiedPolicyPauses).toEqual([
        {
          action: { type: 'approval', message: 'Approve operation' },
          reason: 'Approval required',
          tier: 'registry',
        },
      ]);
      expect(executed).toBe(false);
    });

    it('does not let a stale capability pause bypass a later tool pause after policy changes', async () => {
      const policy = {
        beforeExecute: () => ({
          status: 'needs_approval' as const,
          reason: 'Approval required',
          action: { message: 'Approve operation' },
        }),
      };
      const tool = createTool({
        name: 'stale-capability-pause',
        version: '1.0.0',
        description: 'requires layered approval',
        input: z.object({}),
        policy,
        async execute() {
          return 'completed';
        },
      });
      const approvalStateStore = createProcessLocalApprovalStateStore();
      const originalToolbox = createToolbox([tool], {
        approvalSecret: 'stale-capability-pause-secret',
        approvalStateStore,
        approvalPolicy: { mode: 'always' },
        policy,
      });
      const updatedToolbox = createToolbox([tool], {
        approvalSecret: 'stale-capability-pause-secret',
        approvalStateStore,
        policy,
      });

      const capabilityPaused = await originalToolbox.execute(
        { id: 'call-stale-capability-pause', name: 'stale-capability-pause', arguments: {} },
        approvalExecutionOptions,
      );
      const registryPaused = await updatedToolbox.resumeApproval(
        capabilityPaused.pendingApproval! as SignedPendingToolApproval,
        approvalExecutionOptions,
      );
      const toolPaused = await updatedToolbox.resumeApproval(
        registryPaused.pendingApproval! as SignedPendingToolApproval,
        approvalExecutionOptions,
      );

      expect(capabilityPaused.pendingApproval?.policyPauseTier).toBe('capability');
      expect(registryPaused.pendingApproval?.policyPauseTier).toBe('registry');
      expect(toolPaused.outcome).toBe('action_required');
      expect(toolPaused.pendingApproval?.policyPauseTier).toBe('tool');
    });

    for (const status of ['needs_approval', 'needs_input'] as const) {
      it(`lets a tool policy deny a registry ${status} decision`, async () => {
        let toolPolicyCalls = 0;
        let executed = false;
        const toolbox = createToolbox(
          [
            createTool({
              name: `blocked-${status}`,
              description: 'must pass every policy tier',
              input: z.object({}),
              policy: {
                beforeExecute() {
                  toolPolicyCalls += 1;
                  return { status: 'deny', reason: 'Tool policy says no' };
                },
              },
              async execute() {
                executed = true;
                return 'unexpected';
              },
            }),
          ],
          {
            policy: {
              beforeExecute: () => ({ status, reason: 'Registry requires confirmation' }),
            },
          },
        );

        const result = await toolbox.execute({
          id: `call-blocked-${status}`,
          name: `blocked-${status}`,
          arguments: {},
        });

        expect(toolPolicyCalls).toBe(1);
        expect(executed).toBe(false);
        expect(result.outcome).toBe('error');
        expect(result.error?.message).toBe('Tool policy says no');
      });

      it(`rechecks a tool policy denial when resuming a registry ${status} decision`, async () => {
        let toolPolicyCalls = 0;
        let executed = false;
        const toolbox = createToolbox(
          [
            createTool({
              name: `resume-${status}`,
              version: '1.0.0',
              description: 'must recheck every policy tier on resume',
              input: z.object({}),
              policy: {
                beforeExecute() {
                  toolPolicyCalls += 1;
                  return toolPolicyCalls === 1
                    ? { status: 'allow' as const }
                    : { status: 'deny' as const, reason: 'Tool policy now denies' };
                },
              },
              async execute() {
                executed = true;
                return 'unexpected';
              },
            }),
          ],
          {
            approvalSecret: `resume-${status}-secret`,
            policy: {
              beforeExecute: () => ({ status, reason: 'Registry requires confirmation' }),
            },
          },
        );

        const paused = await toolbox.execute(
          { id: `call-resume-${status}`, name: `resume-${status}`, arguments: {} },
          approvalExecutionOptions,
        );
        const resumed = await toolbox.resumeApproval(
          paused.pendingApproval! as SignedPendingToolApproval,
          approvalExecutionOptions,
        );

        expect(paused.outcome).toBe('action_required');
        expect(toolPolicyCalls).toBe(2);
        expect(executed).toBe(false);
        expect(resumed.outcome).toBe('error');
        expect(resumed.error?.message).toBe('Tool policy now denies');
      });
    }

    it('pauses for approval when a tool policy returns status without allow', async () => {
      const toolbox = createToolbox(
        [
          createTool({
            name: 'sensitive-op',
            version: '1.0.0',
            description: 'requires sign-off',
            input: z.object({ value: z.string() }),
            policy: {
              beforeExecute: () => ({ status: 'needs_approval', reason: 'Sign off first' }),
            },
            async execute({ value }) {
              return { value };
            },
          }),
        ],
        { approvalSecret: 'status-only-secret' },
      );

      const result = await toolbox.execute(
        { id: 'call-status-1', name: 'sensitive-op', arguments: { value: 'x' } },
        approvalExecutionOptions,
      );

      expect(result.outcome).toBe('action_required');
      expect(result.action?.type).toBe('approval');
      expect(result.pendingApproval?.reason).toBe('Sign off first');
    });

    it('denies when a registry policy returns status deny without allow', async () => {
      let executed = false;
      const toolbox = createToolbox(
        [
          createTool({
            name: 'blocked-op',
            description: 'never runs',
            input: z.object({ value: z.string() }),
            async execute({ value }) {
              executed = true;
              return { value };
            },
          }),
        ],
        {
          policy: {
            beforeExecute: () => ({ status: 'deny', reason: 'Registry says no' }),
          },
        },
      );

      const result = await toolbox.execute({
        id: 'call-status-2',
        name: 'blocked-op',
        arguments: { value: 'x' },
      });

      expect(executed).toBe(false);
      expect(result.outcome).toBe('error');
      expect(result.error?.message).toBe('Registry says no');
    });

    it('executes when a policy returns status allow without allow', async () => {
      const toolbox = createToolbox([
        createTool({
          name: 'open-op',
          description: 'always runs',
          input: z.object({ value: z.string() }),
          policy: {
            beforeExecute: () => ({ status: 'allow' }),
          },
          async execute({ value }) {
            return { echoed: value };
          },
        }),
      ]);

      const result = await toolbox.execute({
        id: 'call-status-3',
        name: 'open-op',
        arguments: { value: 'hello' },
      });

      expect(result.outcome).toBe('success');
      expect(result.result).toEqual({ echoed: 'hello' });
    });

    it('still honors an explicit allow=false with no status', async () => {
      let executed = false;
      const toolbox = createToolbox([
        createTool({
          name: 'legacy-deny',
          description: 'explicit allow false',
          input: z.object({ value: z.string() }),
          policy: {
            beforeExecute: () => ({ allow: false, reason: 'Explicitly denied' }),
          },
          async execute({ value }) {
            executed = true;
            return { value };
          },
        }),
      ]);

      const result = await toolbox.execute({
        id: 'call-status-4',
        name: 'legacy-deny',
        arguments: { value: 'x' },
      });

      expect(executed).toBe(false);
      expect(result.outcome).toBe('error');
      expect(result.error?.message).toBe('Explicitly denied');
    });
  });
});
