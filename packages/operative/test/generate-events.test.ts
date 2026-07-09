import { createTool, createToolbox } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { createMockGenerate, createRunRecorder } from '../src/test/index';
import type { GenerateResponse, TokenUsage } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather for a location',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function textResponse(content: string, usage?: TokenUsage): GenerateResponse {
  return { content, toolCalls: [], usage };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
  usage?: TokenUsage,
): GenerateResponse {
  return { content, toolCalls, usage };
}

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

describe('generate lifecycle events', () => {
  it('generate.started emitted before each generate call', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    const activeRun = createActiveRun({
      generate,
      toolbox: createToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const generateStartedEvents = recorder.events.filter((e) => e.type === 'generate.started');
    expect(generateStartedEvents).toHaveLength(2);
    expect((generateStartedEvents[0].detail as { step: number }).step).toBe(0);
    expect((generateStartedEvents[1].detail as { step: number }).step).toBe(1);
  });

  it('generate.completed emitted after with correct duration and response', async () => {
    const generate = createMockGenerate([textResponse('Hello')]);

    const activeRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const completedEvents = recorder.events.filter((e) => e.type === 'generate.completed');
    expect(completedEvents).toHaveLength(1);

    const detail = completedEvents[0].detail as {
      step: number;
      response: GenerateResponse;
      durationMilliseconds: number;
    };
    expect(detail.step).toBe(0);
    expect(detail.response.content).toBe('Hello');
    expect(detail.durationMilliseconds).toBeGreaterThanOrEqual(0);
  });

  it('generate.error emitted when generate throws', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      throw new Error('LLM failed');
    };

    const activeRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    const result = await activeRun.result;

    expect(result.finishReason).toBe('error');

    const errorEvents = recorder.events.filter((e) => e.type === 'generate.error');
    expect(errorEvents).toHaveLength(1);

    const detail = errorEvents[0].detail as {
      step: number;
      error: unknown;
      durationMilliseconds: number;
    };
    expect(detail.step).toBe(0);
    expect(detail.error).toBeInstanceOf(Error);
    expect(detail.durationMilliseconds).toBeGreaterThanOrEqual(0);
  });

  it('no generate events when prepareStep returns a response', async () => {
    const generate = createMockGenerate([textResponse('Should not be called')]);

    const activeRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      prepareStep: async () => ({ content: 'Intercepted', toolCalls: [] }),
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const generateEvents = recorder.events.filter(
      (e) =>
        e.type === 'generate.started' ||
        e.type === 'generate.completed' ||
        e.type === 'generate.error',
    );
    expect(generateEvents).toHaveLength(0);
    expect(generate.callCount).toBe(0);
  });

  it('duration is positive and reasonable', async () => {
    const generate = createMockGenerate([textResponse('Hello')]);

    const activeRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const completed = recorder.events.find((e) => e.type === 'generate.completed');
    const detail = completed!.detail as { durationMilliseconds: number };
    expect(detail.durationMilliseconds).toBeGreaterThanOrEqual(0);
    expect(detail.durationMilliseconds).toBeLessThan(5000);
  });
});

describe('step metadata', () => {
  it('step result contains metadata from generate response', async () => {
    const generate = createMockGenerate([
      {
        content: 'Hello',
        toolCalls: [],
        metadata: { model: 'test-model', latency: 42 },
      },
    ]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    expect(result.steps[0].metadata).toEqual({ model: 'test-model', latency: 42 });
  });

  it('step result metadata is undefined when response has no metadata', async () => {
    const generate = createMockGenerate([textResponse('Hello')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    expect(result.steps[0].metadata).toBeUndefined();
  });

  it('metadata propagates to step.completed event and to RunResult.steps', async () => {
    const generate = createMockGenerate([
      {
        content: 'Hello',
        toolCalls: [],
        metadata: { provider: 'anthropic' },
      },
    ]);

    const activeRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    const result = await activeRun.result;

    // Check step.completed event
    const stepCompleted = recorder.events.find((e) => e.type === 'step.completed');
    expect((stepCompleted!.detail as { metadata?: Record<string, unknown> }).metadata).toEqual({
      provider: 'anthropic',
    });

    // Check RunResult.steps
    expect(result.steps[0].metadata).toEqual({ provider: 'anthropic' });
  });
});

describe('usage.accumulated event', () => {
  it('emitted after each step with correct running total', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall()], '', { prompt: 100, completion: 50, total: 150 }),
      textResponse('Done', { prompt: 80, completion: 30, total: 110 }),
    ]);

    const activeRun = createActiveRun({
      generate,
      toolbox: createToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const usageEvents = recorder.events.filter((e) => e.type === 'usage.accumulated');
    expect(usageEvents).toHaveLength(2);

    const first = usageEvents[0].detail as {
      step: number;
      stepUsage?: TokenUsage;
      totalUsage: TokenUsage;
    };
    expect(first.step).toBe(0);
    expect(first.stepUsage).toEqual({ prompt: 100, completion: 50, total: 150 });
    expect(first.totalUsage).toEqual({ prompt: 100, completion: 50, total: 150 });

    const second = usageEvents[1].detail as {
      step: number;
      stepUsage?: TokenUsage;
      totalUsage: TokenUsage;
    };
    expect(second.step).toBe(1);
    expect(second.stepUsage).toEqual({ prompt: 80, completion: 30, total: 110 });
    expect(second.totalUsage).toEqual({ prompt: 180, completion: 80, total: 260 });
  });

  it('stepUsage is undefined when generate returns no usage', async () => {
    const generate = createMockGenerate([textResponse('Hello')]);

    const activeRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const usageEvents = recorder.events.filter((e) => e.type === 'usage.accumulated');
    expect(usageEvents).toHaveLength(1);

    const detail = usageEvents[0].detail as {
      stepUsage?: TokenUsage;
      totalUsage: TokenUsage;
    };
    expect(detail.stepUsage).toBeUndefined();
    expect(detail.totalUsage).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it('totalUsage accumulates across steps', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall()], '', { prompt: 10, completion: 5, total: 15 }),
      toolCallResponse([weatherToolCall()], '', { prompt: 20, completion: 10, total: 30 }),
      textResponse('Done', { prompt: 30, completion: 15, total: 45 }),
    ]);

    const activeRun = createActiveRun({
      generate,
      toolbox: createToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const usageEvents = recorder.events.filter((e) => e.type === 'usage.accumulated');
    expect(usageEvents).toHaveLength(3);

    const totals = usageEvents.map((e) => (e.detail as { totalUsage: TokenUsage }).totalUsage);
    expect(totals[0]).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(totals[1]).toEqual({ prompt: 30, completion: 15, total: 45 });
    expect(totals[2]).toEqual({ prompt: 60, completion: 30, total: 90 });
  });

  it('accumulates cacheCreationTokens/cacheReadTokens across steps without fabricating them when absent', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall()], '', {
        prompt: 10,
        completion: 5,
        total: 15,
        cacheCreationTokens: 100,
        cacheReadTokens: 0,
      }),
      // A step whose provider reported no cache fields at all.
      toolCallResponse([weatherToolCall()], '', { prompt: 20, completion: 10, total: 30 }),
      textResponse('Done', {
        prompt: 30,
        completion: 15,
        total: 45,
        cacheReadTokens: 200,
      }),
    ]);

    const activeRun = createActiveRun({
      generate,
      toolbox: createToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    const result = await activeRun.result;

    const usageEvents = recorder.events.filter((e) => e.type === 'usage.accumulated');
    const totals = usageEvents.map((e) => (e.detail as { totalUsage: TokenUsage }).totalUsage);

    expect(totals[0]).toEqual({
      prompt: 10,
      completion: 5,
      total: 15,
      cacheCreationTokens: 100,
      cacheReadTokens: 0,
    });
    // Step 2 reported no cache fields — the run total carries forward
    // unchanged rather than being reset or fabricated.
    expect(totals[1]).toEqual({
      prompt: 30,
      completion: 15,
      total: 45,
      cacheCreationTokens: 100,
      cacheReadTokens: 0,
    });
    expect(totals[2]).toEqual({
      prompt: 60,
      completion: 30,
      total: 90,
      cacheCreationTokens: 100,
      cacheReadTokens: 200,
    });
    expect(result.usage).toEqual(totals[2]!);
  });

  it('exposes a cache hit rate on usage.accumulated, computed from cacheReadTokens/cacheCreationTokens/prompt', async () => {
    const generate = createMockGenerate([
      // First step: a cold cache write — every prompt token is fresh, none served from cache.
      // Includes a tool call so the run doesn't stop before the second step.
      toolCallResponse([weatherToolCall()], '', {
        prompt: 0,
        completion: 5,
        total: 5,
        cacheCreationTokens: 100,
      }),
      // Second step: the whole prior prefix is served from cache.
      textResponse('Second', { prompt: 10, completion: 5, total: 15, cacheReadTokens: 100 }),
    ]);

    const activeRun = createActiveRun({
      generate,
      toolbox: createToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const usageEvents = recorder.events.filter((e) => e.type === 'usage.accumulated');
    const rates = usageEvents.map(
      (e) => e.detail as { stepCacheHitRate?: number; totalCacheHitRate?: number },
    );

    // Step 1: cacheReadTokens absent, cacheCreationTokens=100, prompt=0 → 0 / (0 + 100 + 0) = 0.
    expect(rates[0]?.stepCacheHitRate).toBe(0);
    expect(rates[0]?.totalCacheHitRate).toBe(0);
    // Step 2: cacheReadTokens=100, prompt=10 → 100 / (100 + 0 + 10).
    expect(rates[1]?.stepCacheHitRate).toBeCloseTo(100 / 110, 10);
    // Running total across both steps: cacheReadTokens=100, cacheCreationTokens=100, prompt=10.
    expect(rates[1]?.totalCacheHitRate).toBeCloseTo(100 / 210, 10);
  });

  it('leaves cacheHitRate absent when the step reported no cache signal at all', async () => {
    const generate = createMockGenerate([
      textResponse('Done', { prompt: 10, completion: 5, total: 15 }),
    ]);

    const activeRun = createActiveRun({
      generate,
      toolbox: createToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const usageEvents = recorder.events.filter((e) => e.type === 'usage.accumulated');
    const detail = usageEvents[0]?.detail as {
      stepCacheHitRate?: number;
      totalCacheHitRate?: number;
    };

    expect(detail.stepCacheHitRate).toBeUndefined();
    expect(detail.totalCacheHitRate).toBeUndefined();
  });
});

describe('RunOptions.maximumTokens → GenerateContext.maximumTokens', () => {
  it('threads maximumTokens from RunOptions through to every GenerateContext', async () => {
    const capturedContexts: import('../src/types').GenerateContext[] = [];
    const generate = createMockGenerate([textResponse('Done')]);
    const capturingGenerate = async (
      ctx: import('../src/types').GenerateContext,
    ): Promise<GenerateResponse> => {
      capturedContexts.push(ctx);
      return generate(ctx);
    };

    await createActiveRun({
      generate: capturingGenerate,
      toolbox: createToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      maximumTokens: 512,
    }).result;

    expect(capturedContexts.length).toBeGreaterThanOrEqual(1);
    for (const ctx of capturedContexts) {
      expect(ctx.maximumTokens).toBe(512);
    }
  });

  it('passes undefined maximumTokens when RunOptions does not set it', async () => {
    const capturedContexts: import('../src/types').GenerateContext[] = [];
    const generate = createMockGenerate([textResponse('Done')]);
    const capturingGenerate = async (
      ctx: import('../src/types').GenerateContext,
    ): Promise<GenerateResponse> => {
      capturedContexts.push(ctx);
      return generate(ctx);
    };

    await createActiveRun({
      generate: capturingGenerate,
      toolbox: createToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    }).result;

    expect(capturedContexts.length).toBeGreaterThanOrEqual(1);
    for (const ctx of capturedContexts) {
      expect(ctx.maximumTokens).toBeUndefined();
    }
  });
});
