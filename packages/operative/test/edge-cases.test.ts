import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createRun } from '../src/create-run';
import { run } from '../src/run';
import { createMockGenerate, createMockGenerateOnce, createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

describe('edge cases', () => {
  it('returns error results for tool calls when the toolbox has no matching tools', async () => {
    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'nonexistent_tool', arguments: { foo: 'bar' } }]),
      { content: 'I could not find that tool.', toolCalls: [] },
    ]);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(2);

    // The first step should have an error result for the missing tool
    const firstStepResults = result.steps[0].results;
    expect(firstStepResults).toHaveLength(1);
    expect(firstStepResults[0].outcome).toBe('error');
    expect(firstStepResults[0].toolName).toBe('nonexistent_tool');
  });

  it('handles a high turn count without stack overflow', async () => {
    const counterTool = createTool({
      name: 'increment',
      description: 'Increment a counter',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => ({ next: value + 1 }),
    });

    const toolbox = createTestToolbox([counterTool]);
    const conversation = new Conversation();
    const stepCount = 60;

    const responses: GenerateResponse[] = Array.from({ length: stepCount }, (_, index) =>
      toolCallResponse([{ name: 'increment', arguments: { value: index } }]),
    );

    const generate = createMockGenerate(responses);

    const result = await run({
      generate,
      toolbox,
      conversation,
      maximumSteps: stepCount,
    });

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.steps).toHaveLength(stepCount);
    // Generous timeout: this is a correctness smoke test (the loop is iterative,
    // not recursive — no stack overflow), but driving 200 steps grows the
    // conversation to ~600 messages and conversationalist's immutable append is
    // O(current length), so the run is O(n^2). It takes ~0.8s standalone but
    // 4.4-4.6s in CI under 2-core/13-suite contention, brushing Bun's default
    // 5000ms ceiling. The headroom keeps a correctness test from flaking on
    // throughput; it is not masking a hang.
  }, 30_000);

  it('stops at maximumSteps when generate returns the same tool calls repeatedly', async () => {
    const echoTool = createTool({
      name: 'echo',
      description: 'Echo input',
      input: z.object({ message: z.string() }),
      execute: async ({ message }) => ({ echoed: message }),
    });

    const toolbox = createTestToolbox([echoTool]);
    const conversation = new Conversation();
    const limit = 10;

    const responses: GenerateResponse[] = Array.from({ length: limit }, () =>
      toolCallResponse([{ name: 'echo', arguments: { message: 'hello' } }]),
    );

    const generate = createMockGenerate(responses);

    const result = await run({
      generate,
      toolbox,
      conversation,
      maximumSteps: limit,
    });

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.steps).toHaveLength(limit);
    expect(generate.callCount).toBe(limit);
  });
});

describe('collectAsync option', () => {
  it('uses appendToolResultsAsync when collectAsync is true', async () => {
    const tool = createTool({
      name: 'echo',
      description: 'Echo',
      input: z.object({ message: z.string() }),
      execute: async ({ message }) => ({ echoed: message }),
    });

    const toolbox = createTestToolbox([tool]);
    const conversation = new Conversation();
    const generate = createMockGenerate([
      toolCallResponse([{ name: 'echo', arguments: { message: 'hi' } }]),
      { content: 'Done', toolCalls: [] },
    ]);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      collectAsync: true,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].results).toHaveLength(1);
  });
});

describe('test utility coverage', () => {
  it('createMockGenerate throws when exhausted', async () => {
    const generate = createMockGenerate([{ content: 'only one', toolCalls: [] }]);

    // First call succeeds
    await generate({ conversation: {} as any, step: 0 });

    // Second call throws
    await expect(generate({ conversation: {} as any, step: 1 })).rejects.toThrow(
      'createMockGenerate: no response at index 1',
    );
  });

  it('createMockGenerateOnce returns response on first call, throws on second', async () => {
    const generate = createMockGenerateOnce({ content: 'once', toolCalls: [] });

    const response = await generate({ conversation: {} as any, step: 0 });
    expect(response.content).toBe('once');

    await expect(generate({ conversation: {} as any, step: 1 })).rejects.toThrow(
      'createMockGenerateOnce: already called',
    );
  });

  it('createRunRecorder clear resets events and steps', async () => {
    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();
    const generate = createMockGenerate([{ content: 'Hello', toolCalls: [] }]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    expect(recorder.events.length).toBeGreaterThan(0);
    expect(recorder.steps.length).toBeGreaterThan(0);

    recorder.clear();

    expect(recorder.events).toHaveLength(0);
    expect(recorder.steps).toHaveLength(0);
  });
});
