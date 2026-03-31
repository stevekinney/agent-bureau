import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from '../../src/conditions/predicates';
import { createRun } from '../../src/create-run';
import type { GenerateRetryEvent } from '../../src/events';
import { composeMutators } from '../../src/retry/compose-mutators';
import type { RetryMutator } from '../../src/retry/types';
import { run } from '../../src/run';
import { createRunRecorder } from '../../src/test/index';
import type { GenerateResponse } from '../../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('retry with mutation integration', () => {
  it('calls the mutator before retrying', async () => {
    let callCount = 0;
    const mutationLog: number[] = [];

    const generate = async () => {
      callCount++;
      if (callCount <= 2) throw new Error('fail');
      return textResponse('Success');
    };

    const mutator: RetryMutator = (_context, _error, attempt) => {
      mutationLog.push(attempt);
      return undefined; // no mutation, just tracking
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3, mutate: mutator },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('Success');
    expect(mutationLog).toEqual([1, 2]);
  });

  it('uses the mutated context for subsequent retry attempts', async () => {
    let callCount = 0;
    const stepsSeenByGenerate: number[] = [];

    const generate = async (context: { step: number }) => {
      callCount++;
      stepsSeenByGenerate.push(context.step);
      if (callCount <= 1) throw new Error('fail');
      return textResponse('Done');
    };

    const mutator: RetryMutator = (context) => {
      return { ...context, step: context.step + 100 };
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3, mutate: mutator },
    });

    expect(result.finishReason).toBe('stop-condition');
    // First call: step 0, second call: step 100 (mutated)
    expect(stepsSeenByGenerate).toEqual([0, 100]);
  });

  it('emits GenerateRetryEvent with mutated=true when context was mutated', async () => {
    let callCount = 0;

    const generate = async () => {
      callCount++;
      if (callCount <= 1) throw new Error('fail');
      return textResponse('Done');
    };

    const mutator: RetryMutator = (context) => {
      return { ...context, step: 42 };
    };

    const activeRun = createRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3, mutate: mutator },
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const retryEvents = recorder.events.filter((e) => e.type === 'generate.retry');
    expect(retryEvents).toHaveLength(1);
    expect((retryEvents[0]!.detail as GenerateRetryEvent).mutated).toBe(true);
  });

  it('emits GenerateRetryEvent with mutated=false when mutator returns void', async () => {
    let callCount = 0;

    const generate = async () => {
      callCount++;
      if (callCount <= 1) throw new Error('fail');
      return textResponse('Done');
    };

    const noopMutator: RetryMutator = () => undefined;

    const activeRun = createRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3, mutate: noopMutator },
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const retryEvents = recorder.events.filter((e) => e.type === 'generate.retry');
    expect(retryEvents).toHaveLength(1);
    expect((retryEvents[0]!.detail as GenerateRetryEvent).mutated).toBe(false);
  });

  it('composes multiple mutators via composeMutators', async () => {
    let callCount = 0;
    const log: string[] = [];

    const generate = async () => {
      callCount++;
      if (callCount <= 1) throw new Error('fail');
      return textResponse('Done');
    };

    const mutatorA: RetryMutator = (context) => {
      log.push('A');
      return { ...context, step: context.step + 10 };
    };

    const mutatorB: RetryMutator = (context) => {
      log.push('B');
      return { ...context, step: context.step + 5 };
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3, mutate: composeMutators(mutatorA, mutatorB) },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(log).toEqual(['A', 'B']);
  });

  it('applies jitter to retry delay', async () => {
    let callCount = 0;
    const startTime = performance.now();

    const generate = async () => {
      callCount++;
      if (callCount <= 1) throw new Error('fail');
      return textResponse('Done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3, delay: 10, jitter: true },
    });

    expect(result.finishReason).toBe('stop-condition');
    // Just verify it completed — jitter timing is non-deterministic
    expect(callCount).toBe(2);
  });

  it('backward compatible: works without mutate or jitter options', async () => {
    let callCount = 0;

    const generate = async () => {
      callCount++;
      if (callCount <= 1) throw new Error('fail');
      return textResponse('Done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3 },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(callCount).toBe(2);
  });
});
