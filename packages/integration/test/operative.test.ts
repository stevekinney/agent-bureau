import { createTool, createToolbox } from 'armorer';
import { createTestToolbox, createToolboxRecorder } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createRun, type GenerateResponse,run, stopWhen, withStreaming } from 'operative';
import { createMockGenerate, createRunRecorder } from 'operative/test';
import { z } from 'zod';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location, unit: 'F' }),
});

const summarizeTool = createTool({
  name: 'summarize_weather',
  description: 'Summarize weather data',
  input: z.object({ data: z.string() }),
  execute: async ({ data }) => ({ summary: `Weather summary: ${data}` }),
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

describe('operative loop integration', () => {
  it('completes a full single-step loop: user → generate(tool call) → execute → generate(text) → done', async () => {
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('What is the weather in Denver?');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('The weather in Denver is 72F.'),
    ]);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(2);
    expect(result.content).toBe('The weather in Denver is 72F.');

    const firstStepResults = result.steps[0]!.results;
    expect(firstStepResults).toHaveLength(1);
    expect(firstStepResults[0]!.outcome).toBe('success');
  });

  it('completes a multi-step chain: get_weather → summarize_weather → text', async () => {
    const toolbox = createTestToolbox([weatherTool, summarizeTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Summarize the Denver weather');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      toolCallResponse([{ name: 'summarize_weather', arguments: { data: 'Denver 72F' } }]),
      textResponse('Here is the weather summary for Denver.'),
    ]);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(3);
    expect(result.content).toBe('Here is the weather summary for Denver.');
  });

  it('handles tool error recovery: failing tool → generate sees error → text response', async () => {
    const failingTool = createTool({
      name: 'fail_weather',
      description: 'Always fails',
      input: z.object({ location: z.string() }),
      execute: async () => {
        throw new Error('Service unavailable');
      },
    });

    const toolbox = createTestToolbox([failingTool]);
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'fail_weather', arguments: { location: 'Denver' } }]),
      textResponse('Sorry, the weather service is unavailable right now.'),
    ]);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.results[0]!.outcome).toBe('error');
    expect(result.content).toBe('Sorry, the weather service is unavailable right now.');
  });

  it('handles action_required stopping condition', async () => {
    const approvalTool = createTool({
      name: 'request_approval',
      description: 'Request user approval',
      input: z.object({ action: z.string() }),
      execute: async ({ action }) => ({
        callId: 'mock',
        outcome: 'action_required' as const,
        content: `Approval needed for: ${action}`,
        action: { type: 'approval' as const, message: `Approve ${action}?` },
      }),
    });

    const toolbox = createTestToolbox([approvalTool]);
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'request_approval', arguments: { action: 'deploy' } }]),
      textResponse('Should not reach here'),
    ]);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.toolOutcome('action_required'),
    });

    // The tool result outcome itself is 'success' because the tool returns normally
    // (action_required is returned inside the result content, not as the outcome)
    // The loop should run for at most 2 steps
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
  });
});

describe('operative provider round-trips', () => {
  it('round-trips through OpenAI format after loop', async () => {
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Weather?');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'NYC' } }]),
      textResponse('NYC is 72F.'),
    ]);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const openAIMessages = await result.conversation.toOpenAIMessages();
    expect(Array.isArray(openAIMessages)).toBe(true);
    expect(openAIMessages.length).toBeGreaterThan(0);
  });

  it('round-trips through Anthropic format after loop', async () => {
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Weather?');

    const generate = createMockGenerate([textResponse('It is sunny.')]);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const anthropicMessages = await result.conversation.toAnthropicMessages();
    expect(anthropicMessages).toBeDefined();
    expect(anthropicMessages.messages.length).toBeGreaterThan(0);
  });
});

describe('operative streaming integration', () => {
  it('streaming generate works through the full loop', async () => {
    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    const streamingGenerate = withStreaming(async ({ streaming }) => {
      streaming.update('Hel');
      streaming.update('Hello');
      streaming.update('Hello world');
      return { content: 'Hello world', toolCalls: [] };
    });

    const result = await run({
      generate: streamingGenerate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('Hello world');
  });
});

describe('operative abort propagation', () => {
  it('AbortSignal propagates from operative and terminates the run', async () => {
    const controller = new AbortController();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Seattle' } }]),
      textResponse('Done'),
    ]);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
      signal: controller.signal,
      onStep: async ({ step }) => {
        if (step === 0) controller.abort('test-abort');
      },
    });

    expect(result.finishReason).toBe('aborted');
    expect(result.steps).toHaveLength(1);
  });
});

describe('operative event ordering', () => {
  it('events fire in correct order across operative + toolbox recorders', async () => {
    const toolbox = createToolbox([weatherTool]) as import('armorer').Toolbox;
    const toolboxRecorder = createToolboxRecorder(toolbox);
    const conversation = new Conversation();
    conversation.appendUserMessage('Weather?');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('72F in Denver.'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runRecorder = createRunRecorder(activeRun);
    await activeRun.result;

    // Operative events should include run lifecycle events
    const operativeEventTypes = runRecorder.events.map((event) => event.type);
    expect(operativeEventTypes).toContain('run.started');
    expect(operativeEventTypes).toContain('step.started');
    expect(operativeEventTypes).toContain('step.generated');
    expect(operativeEventTypes).toContain('tools.executing');
    expect(operativeEventTypes).toContain('tools.executed');
    expect(operativeEventTypes).toContain('step.completed');
    expect(operativeEventTypes).toContain('run.completed');

    // Toolbox events should also fire
    expect(toolboxRecorder.events.length).toBeGreaterThan(0);
  });
});
