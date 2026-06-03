import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from '../src/conditions/predicates';
import { createRun } from '../src/create-run';
import { run } from '../src/run';
import { createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('retry on generate failure', () => {
  it('succeeds on the second attempt after a transient failure', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      if (callCount === 1) throw new Error('rate limit');
      return textResponse('Success');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3 },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('Success');
    expect(callCount).toBe(2);
  });

  it('exhausts all retry attempts and returns error', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      throw new Error(`fail ${callCount}`);
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3 },
    });

    expect(result.finishReason).toBe('error');
    expect(callCount).toBe(3);
  });

  it('shouldRetry returning false stops retries early', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      throw new Error('permanent failure');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: {
        attempts: 5,
        shouldRetry: async (error) => {
          return !(error instanceof Error && error.message === 'permanent failure');
        },
      },
    });

    expect(result.finishReason).toBe('error');
    expect(callCount).toBe(1);
  });

  it('delay function receives the attempt number', async () => {
    const delayAttempts: number[] = [];
    let callCount = 0;

    const generate = async () => {
      callCount++;
      if (callCount <= 2) throw new Error('retry me');
      return textResponse('Done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: {
        attempts: 3,
        delay: (attempt) => {
          delayAttempts.push(attempt);
          return 0; // No actual delay in tests
        },
      },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(delayAttempts).toEqual([1, 2]);
  });

  it('abort cancels retry delay', async () => {
    const controller = new AbortController();
    let callCount = 0;

    const generate = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('retry me');
      }
      return textResponse('Should not reach');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      signal: controller.signal,
      retry: {
        attempts: 3,
        delay: 1000,
        sleep: async (_milliseconds) => {
          controller.abort('cancel');
        },
      },
    });

    expect(result.finishReason).toBe('aborted');
    expect(callCount).toBe(1);
  });

  it('does not retry prepareStep failures', async () => {
    let generateCallCount = 0;
    const generate = async () => {
      generateCallCount++;
      return textResponse('Done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3 },
      prepareStep: async () => {
        throw new Error('prepareStep error');
      },
    });

    expect(result.finishReason).toBe('error');
    expect(generateCallCount).toBe(0);
  });

  it('emits generate.retry events via createRun', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      if (callCount <= 2) throw new Error(`fail ${callCount}`);
      return textResponse('Done');
    };

    const activeRun = createRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3 },
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const retryEvents = recorder.events.filter((e) => e.type === 'generate.retry');
    expect(retryEvents).toHaveLength(2);
    expect((retryEvents[0].detail as { attempt: number }).attempt).toBe(1);
    expect((retryEvents[1].detail as { attempt: number }).attempt).toBe(2);
  });

  it('works without retry option (no retries by default)', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      throw new Error('fail');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('error');
    expect(callCount).toBe(1);
  });
});
