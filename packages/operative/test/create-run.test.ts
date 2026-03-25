import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from '../src/conditions/predicates';
import { createRun } from '../src/create-run';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse, RunResult } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('createRun', () => {
  it('addEventListener registers a listener that fires on the given event', async () => {
    const generate = createMockGenerate([textResponse('Hello')]);
    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const receivedTypes: string[] = [];

    activeRun.addEventListener('run.started', () => {
      receivedTypes.push('run.started');
    });

    activeRun.addEventListener('run.completed', () => {
      receivedTypes.push('run.completed');
    });

    await activeRun.result;

    expect(receivedTypes).toContain('run.started');
    expect(receivedTypes).toContain('run.completed');
  });

  it('on returns an observable that emits matching events', async () => {
    const generate = createMockGenerate([textResponse('Hello')]);
    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const steps: number[] = [];

    activeRun.on('step.started').subscribe({
      next(event) {
        steps.push((event as unknown as { step: number }).step);
      },
    });

    await activeRun.result;

    expect(steps).toEqual([0]);
  });

  it('once fires the listener only once', async () => {
    const generate = createMockGenerate([textResponse('first'), textResponse('second')]);
    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      maximumSteps: 2,
    });

    let callCount = 0;

    activeRun.once('step.started', () => {
      callCount++;
    });

    await activeRun.result;

    expect(callCount).toBe(1);
  });

  it('abort() terminates the loop with aborted finish reason', async () => {
    async function slowGenerate() {
      await Bun.sleep(100);
      return { content: 'done', toolCalls: [] } satisfies GenerateResponse;
    }

    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createRun({
      generate: slowGenerate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      maximumSteps: 10,
    });

    // Abort shortly after starting
    setTimeout(() => activeRun.abort('test abort'), 10);

    const result = await activeRun.result;

    expect(result.finishReason).toBe('aborted');
  });

  it('Symbol.dispose aborts the run', async () => {
    async function slowGenerate() {
      await Bun.sleep(100);
      return { content: 'done', toolCalls: [] } satisfies GenerateResponse;
    }

    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createRun({
      generate: slowGenerate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      maximumSteps: 10,
    });

    // Dispose shortly after starting
    setTimeout(() => activeRun[Symbol.dispose](), 10);

    const result = await activeRun.result;

    expect(result.finishReason).toBe('aborted');
  });

  it('result promise resolves with a RunResult containing expected fields', async () => {
    const generate = createMockGenerate([textResponse('Final answer')]);
    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const result: RunResult = await activeRun.result;

    expect(result).toHaveProperty('conversation');
    expect(result).toHaveProperty('steps');
    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('usage');
    expect(result).toHaveProperty('finishReason');

    expect(result.conversation).toBeInstanceOf(Conversation);
    expect(result.steps).toHaveLength(1);
    expect(result.content).toBe('Final answer');
    expect(result.finishReason).toBe('stop-condition');
    expect(result.usage).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it('subscribe collects events as they are emitted', async () => {
    const generate = createMockGenerate([textResponse('Hello from subscribe')]);
    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    const collected: string[] = [];

    activeRun.subscribe('run.started', () => {
      collected.push('run.started');
    });

    activeRun.subscribe('step.completed', () => {
      collected.push('step.completed');
    });

    activeRun.subscribe('run.completed', () => {
      collected.push('run.completed');
    });

    await activeRun.result;

    expect(collected).toContain('run.started');
    expect(collected).toContain('step.completed');
    expect(collected).toContain('run.completed');
  });

  it('completes the emitter when result resolves without explicit complete()', async () => {
    const generate = createMockGenerate([textResponse('auto-complete')]);
    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    let observableCompleted = false;

    activeRun.toObservable().subscribe({
      complete() {
        observableCompleted = true;
      },
    });

    await activeRun.result;

    // Allow microtask for .finally to run
    await Promise.resolve();

    expect(observableCompleted).toBe(true);
  });

  it('calling complete() after auto-complete is a harmless no-op', async () => {
    const generate = createMockGenerate([textResponse('double-complete')]);
    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    await activeRun.result;
    await Promise.resolve();

    // Should not throw
    expect(() => activeRun.complete()).not.toThrow();
  });

  it('Symbol.dispose after auto-complete is a harmless no-op', async () => {
    const generate = createMockGenerate([textResponse('dispose-after-complete')]);
    const toolbox = createToolbox([]);
    const conversation = new Conversation();

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    await activeRun.result;
    await Promise.resolve();

    // Should not throw
    expect(() => activeRun[Symbol.dispose]()).not.toThrow();
  });
});
