import { createTool, createToolbox } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import {
  AbortAgentRunError,
  AgentRunError,
  agentRunErrorToJSON,
  BudgetExceededError,
  reclassifyToolError,
  serializeAgentRunError,
} from '../src/errors';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

describe('error handling', () => {
  it('serializes AgentRunError diagnostics with stable cause metadata', () => {
    const uncased = new AbortAgentRunError('cancelled');
    expect(agentRunErrorToJSON(uncased)).toEqual({
      name: 'AbortAgentRunError',
      message: 'cancelled',
      kind: 'abort',
      code: 'ABORTED',
    });

    expect(
      agentRunErrorToJSON(
        new AbortAgentRunError(
          'wrapped',
          new AgentRunError('inner', { kind: 'tool', code: 'UNKNOWN' }),
        ),
      ).cause,
    ).toEqual({
      name: 'AgentRunError',
      message: 'inner',
      kind: 'tool',
      code: 'UNKNOWN',
    });
    expect(
      agentRunErrorToJSON(new AbortAgentRunError('error', new Error('socket closed'))).cause,
    ).toEqual({
      name: 'Error',
      message: 'socket closed',
    });

    expect(agentRunErrorToJSON(new AbortAgentRunError('null', null)).cause).toBeNull();
    expect(agentRunErrorToJSON(new AbortAgentRunError('string', 'string cause')).cause).toBe(
      'string cause',
    );
    expect(agentRunErrorToJSON(new AbortAgentRunError('number', 42)).cause).toBe(42);
    expect(agentRunErrorToJSON(new AbortAgentRunError('boolean', false)).cause).toBe(false);
    expect(agentRunErrorToJSON(new AbortAgentRunError('bigint', 42n)).cause).toBe('42');
    expect(agentRunErrorToJSON(new AbortAgentRunError('symbol', Symbol('token'))).cause).toBe(
      'Symbol(token)',
    );

    expect(
      agentRunErrorToJSON(new AbortAgentRunError('object', { retryable: true })).cause,
    ).toEqual({
      retryable: true,
    });

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(agentRunErrorToJSON(new AbortAgentRunError('circular', circular)).cause).toBe(
      '[object Object]',
    );

    expect(JSON.parse(serializeAgentRunError(new AbortAgentRunError('cancelled')))).toEqual({
      name: 'AbortAgentRunError',
      message: 'cancelled',
      kind: 'abort',
      code: 'ABORTED',
    });
  });

  it('terminates with error finish reason when generate throws', async () => {
    const generate = async () => {
      throw new Error('API rate limit exceeded');
    };

    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('API rate limit exceeded');
    expect(result.steps).toHaveLength(0);
  });

  it('continues the loop when a tool returns an error outcome', async () => {
    const failingTool = createTool({
      name: 'failing_lookup',
      description: 'A tool that fails',
      input: z.object({ query: z.string() }),
      execute: async () => {
        throw new Error('Database connection refused');
      },
    });

    const toolbox = createTestToolbox([failingTool, weatherTool]);
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'failing_lookup', arguments: { query: 'test' } }]),
      textResponse('The lookup failed, but I can still help.'),
    ]);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    // The loop should continue past the tool error and finish normally
    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(2);
    expect(result.content).toBe('The lookup failed, but I can still help.');

    // The first step should have an error result from the tool
    const firstStepResults = result.steps[0].results;
    expect(firstStepResults).toHaveLength(1);
    expect(firstStepResults[0].outcome).toBe('error');
  });

  it('terminates with error finish reason when toolbox.execute throws', async () => {
    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('Done'),
    ]);

    const toolbox = createTestToolbox([weatherTool]);
    const originalExecute = toolbox.execute.bind(toolbox);
    (toolbox as any).execute = async () => {
      throw new Error('Toolbox execute failed catastrophically');
    };

    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('Toolbox execute failed catastrophically');
    expect(result.steps).toHaveLength(0);
    void originalExecute;
  });

  it('seals the dangling tool-call with an error result when toolbox.execute throws (tool-pair integrity)', async () => {
    // The tool-call message is appended to the conversation BEFORE execution
    // runs. If execution then throws and the error is not recovered, the
    // conversation must not be left with a tool-call that has no matching
    // tool-result — a killed/errored run's history would otherwise be unsafe
    // to replay against a provider (every tool_use requires a paired
    // tool_result).
    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
    ]);

    const toolbox = createTestToolbox([weatherTool]);
    (toolbox as any).execute = async () => {
      throw new Error('Toolbox execute failed catastrophically');
    };

    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('error');
    expect(conversation.getPendingToolCalls()).toHaveLength(0);

    const messages = conversation.getMessages({ includeHidden: true });
    const toolCallMessage = messages.find((m) => m.role === 'tool-call');
    const toolResultMessage = messages.find((m) => m.role === 'tool-result');
    expect(toolCallMessage).toBeDefined();
    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage?.toolResult?.callId).toBe(toolCallMessage?.toolCall?.id);
    expect(toolResultMessage?.toolResult?.outcome).toBe('error');
  });

  it('terminates with error finish reason when onStep hook throws', async () => {
    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('Done'),
    ]);
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      onStep: async () => {
        throw new Error('Hook crashed');
      },
    });

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('Hook crashed');
    // The step where the hook threw is still partially recorded
    expect(result.steps).toHaveLength(0);
  });

  it('emits both run.error and run.completed for generic errors via createRun', async () => {
    const thrownError = new Error('Generic network error');
    const generate = async () => {
      throw thrownError;
    };

    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const receivedEvents: string[] = [];
    let eventError: AgentRunError | undefined;

    activeRun.addEventListener('run.error', (event) => {
      receivedEvents.push('run.error');
      eventError = event.error;
    });

    activeRun.addEventListener('run.completed', () => {
      receivedEvents.push('run.completed');
    });

    const result = await activeRun.result;

    expect(result.finishReason).toBe('error');
    expect(receivedEvents).toContain('run.error');
    expect(receivedEvents).toContain('run.completed');
    expect(eventError).toBeInstanceOf(AgentRunError);
    expect(eventError?.kind).toBe('generate');
    expect(eventError?.code).toBe('UNKNOWN');
    expect(eventError?.cause).toBe(thrownError);
  });
});

describe('reclassifyToolError (AB-231)', () => {
  const weatherTool = createTool({
    name: 'get_weather',
    description: 'Get weather for a location',
    input: z.object({ location: z.string() }),
    execute: async ({ location }) => ({ temperature: 72, location }),
  });

  it('reclassifies a genuine toolbox checkBudget rejection (carrying the provenance marker) as a BudgetExceededError', async () => {
    const toolbox = createToolbox([weatherTool], { budget: { maxCalls: 1 } });

    await toolbox.execute(
      { id: 'call-1', name: 'get_weather', arguments: { location: 'Denver' } },
      { errorMode: 'failFast' },
    );

    let thrown: unknown;
    try {
      await toolbox.execute(
        { id: 'call-2', name: 'get_weather', arguments: { location: 'Boulder' } },
        { errorMode: 'failFast' },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const result = reclassifyToolError(thrown);

    expect(result).toBeInstanceOf(BudgetExceededError);
    expect((result as BudgetExceededError).message).toBe('Budget exceeded: max calls 1');
  });

  it("does not reclassify a tool-defined error whose code coincidentally also normalizes to 'BUDGET_EXCEEDED' (no toolbox-accounting provenance marker)", async () => {
    const impostorTool = createTool({
      name: 'impostor',
      description: 'Throws its own BUDGET_EXCEEDED-coded error, unrelated to toolbox accounting',
      input: z.object({}),
      execute: async () => {
        const error = new Error('This tool ran out of its own budget') as Error & {
          code: string;
        };
        error.code = 'BUDGET_EXCEEDED';
        throw error;
      },
    });
    const toolbox = createToolbox([impostorTool]);

    let thrown: unknown;
    try {
      await toolbox.execute(
        { id: 'call-1', name: 'impostor', arguments: {} },
        { errorMode: 'failFast' },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const result = reclassifyToolError(thrown);

    expect(result).not.toBeInstanceOf(BudgetExceededError);
    expect(result).toBe(thrown);
  });

  it('leaves a ToolError with a different code unchanged', () => {
    const toolError = {
      code: 'EXECUTION_ERROR',
      category: 'internal',
      retryable: false,
      message: 'boom',
    };

    expect(reclassifyToolError(toolError)).toBe(toolError);
  });

  it('leaves a non-ToolError value unchanged', () => {
    const plainError = new Error('not a tool error');
    expect(reclassifyToolError(plainError)).toBe(plainError);
  });

  it('leaves a ToolError-shaped object missing required fields unchanged', () => {
    const almostToolError = { code: 'BUDGET_EXCEEDED', message: 'missing fields' };
    expect(reclassifyToolError(almostToolError)).toBe(almostToolError);
  });

  it('leaves null and primitive values unchanged', () => {
    expect(reclassifyToolError(null)).toBeNull();
    expect(reclassifyToolError('a string error')).toBe('a string error');
  });
});
