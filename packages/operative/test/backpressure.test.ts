import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createAdaptiveBackoff, createSlidingWindow, createTokenBucket } from '../src/backpressure';
import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('createAdaptiveBackoff', () => {
  it('starts with 0 delay', () => {
    const strategy = createAdaptiveBackoff();
    expect(strategy.currentDelay).toBe(0);
    expect(strategy.isActive).toBe(false);
    expect(strategy.beforeStep().delay).toBe(0);
  });

  it('increases delay on error', () => {
    const strategy = createAdaptiveBackoff({ initialDelay: 100, multiplier: 2 });
    strategy.onError(new Error('fail'));
    expect(strategy.currentDelay).toBe(100);
    expect(strategy.isActive).toBe(true);
    expect(strategy.beforeStep().delay).toBe(100);
  });

  it('applies multiplier on consecutive errors', () => {
    const strategy = createAdaptiveBackoff({ initialDelay: 100, multiplier: 3 });
    strategy.onError(new Error('fail 1'));
    expect(strategy.currentDelay).toBe(100);
    strategy.onError(new Error('fail 2'));
    expect(strategy.currentDelay).toBe(300);
    strategy.onError(new Error('fail 3'));
    expect(strategy.currentDelay).toBe(900);
  });

  it('caps delay at maximumDelay', () => {
    const strategy = createAdaptiveBackoff({
      initialDelay: 1000,
      maximumDelay: 5000,
      multiplier: 10,
    });
    strategy.onError(new Error('fail 1'));
    expect(strategy.currentDelay).toBe(1000);
    strategy.onError(new Error('fail 2'));
    expect(strategy.currentDelay).toBe(5000);
    strategy.onError(new Error('fail 3'));
    expect(strategy.currentDelay).toBe(5000);
  });

  it('resets after consecutive successes', () => {
    const strategy = createAdaptiveBackoff({
      initialDelay: 100,
      resetAfterSuccesses: 2,
    });
    strategy.onError(new Error('fail'));
    expect(strategy.currentDelay).toBe(100);
    strategy.onSuccess();
    expect(strategy.currentDelay).toBe(100);
    strategy.onSuccess();
    expect(strategy.currentDelay).toBe(0);
    expect(strategy.isActive).toBe(false);
  });

  it('resets after one success by default', () => {
    const strategy = createAdaptiveBackoff({ initialDelay: 100 });
    strategy.onError(new Error('fail'));
    expect(strategy.currentDelay).toBe(100);
    strategy.onSuccess();
    expect(strategy.currentDelay).toBe(0);
  });

  it('isActive reflects current state', () => {
    const strategy = createAdaptiveBackoff({ initialDelay: 100 });
    expect(strategy.isActive).toBe(false);
    strategy.onError(new Error('fail'));
    expect(strategy.isActive).toBe(true);
    strategy.onSuccess();
    expect(strategy.isActive).toBe(false);
  });

  it('uses default options when none provided', () => {
    const strategy = createAdaptiveBackoff();
    strategy.onError(new Error('fail'));
    expect(strategy.currentDelay).toBe(1000);
    strategy.onError(new Error('fail'));
    expect(strategy.currentDelay).toBe(2000);
  });

  it('resets consecutive success count on error', () => {
    const strategy = createAdaptiveBackoff({
      initialDelay: 100,
      resetAfterSuccesses: 3,
    });
    strategy.onError(new Error('fail'));
    strategy.onSuccess();
    strategy.onSuccess();
    // Interrupt with error before reaching 3 successes
    strategy.onError(new Error('fail again'));
    strategy.onSuccess();
    // Only 1 success after the second error, still active
    expect(strategy.isActive).toBe(true);
  });
});

describe('createTokenBucket', () => {
  it('allows requests when tokens are available', () => {
    const strategy = createTokenBucket({
      tokensPerInterval: 5,
      interval: 1000,
    });
    expect(strategy.beforeStep().delay).toBe(0);
    expect(strategy.isActive).toBe(false);
  });

  it('delays when tokens are exhausted', () => {
    const strategy = createTokenBucket({
      tokensPerInterval: 2,
      interval: 1000,
    });
    // Consume all tokens
    strategy.onSuccess();
    strategy.onSuccess();
    const signal = strategy.beforeStep();
    expect(signal.delay).toBeGreaterThan(0);
    expect(strategy.isActive).toBe(true);
  });

  it('maximumTokens caps the bucket', () => {
    const strategy = createTokenBucket({
      tokensPerInterval: 10,
      interval: 1000,
      maximumTokens: 3,
    });
    // Should only have 3 tokens, not 10
    strategy.onSuccess();
    strategy.onSuccess();
    strategy.onSuccess();
    expect(strategy.beforeStep().delay).toBeGreaterThan(0);
  });

  it('defaults maximumTokens to tokensPerInterval', () => {
    const strategy = createTokenBucket({
      tokensPerInterval: 2,
      interval: 1000,
    });
    strategy.onSuccess();
    strategy.onSuccess();
    expect(strategy.isActive).toBe(true);
  });

  it('replenishes tokens over time', () => {
    let now = 0;
    const strategy = createTokenBucket({
      tokensPerInterval: 1,
      interval: 50,
      maximumTokens: 1,
      now: () => now,
    });
    strategy.onSuccess();
    expect(strategy.isActive).toBe(true);
    now += 60;
    expect(strategy.beforeStep().delay).toBe(0);
    expect(strategy.isActive).toBe(false);
  });

  it('onError also consumes a token', () => {
    const strategy = createTokenBucket({
      tokensPerInterval: 1,
      interval: 1000,
      maximumTokens: 1,
    });
    strategy.onError(new Error('fail'));
    expect(strategy.isActive).toBe(true);
    expect(strategy.currentDelay).toBeGreaterThan(0);
  });
});

describe('createSlidingWindow', () => {
  it('allows requests within the limit', () => {
    const strategy = createSlidingWindow({
      windowSize: 1000,
      maximumRequests: 3,
    });
    expect(strategy.beforeStep().delay).toBe(0);
    expect(strategy.isActive).toBe(false);
  });

  it('delays when at maximum requests', () => {
    const strategy = createSlidingWindow({
      windowSize: 1000,
      maximumRequests: 2,
    });
    strategy.onSuccess();
    strategy.onSuccess();
    const signal = strategy.beforeStep();
    expect(signal.delay).toBeGreaterThan(0);
    expect(strategy.isActive).toBe(true);
  });

  it('window slides over time', () => {
    let now = 0;
    const strategy = createSlidingWindow({
      windowSize: 50,
      maximumRequests: 1,
      now: () => now,
    });
    strategy.onSuccess();
    expect(strategy.isActive).toBe(true);
    now += 60;
    expect(strategy.beforeStep().delay).toBe(0);
    expect(strategy.isActive).toBe(false);
  });

  it('onError also counts toward the window', () => {
    const strategy = createSlidingWindow({
      windowSize: 1000,
      maximumRequests: 1,
    });
    strategy.onError(new Error('fail'));
    expect(strategy.isActive).toBe(true);
    expect(strategy.currentDelay).toBeGreaterThan(0);
  });

  it('handles multiple requests correctly', () => {
    const strategy = createSlidingWindow({
      windowSize: 1000,
      maximumRequests: 3,
    });
    strategy.onSuccess();
    strategy.onSuccess();
    expect(strategy.beforeStep().delay).toBe(0);
    strategy.onSuccess();
    expect(strategy.beforeStep().delay).toBeGreaterThan(0);
  });
});

describe('backpressure loop integration', () => {
  it('backpressure delay is applied before the step', async () => {
    let generateCallCount = 0;
    const strategy = createAdaptiveBackoff({ initialDelay: 0 });
    // The strategy starts at 0, so no actual delay on the first step.
    const generate = async () => {
      generateCallCount++;
      return textResponse('Done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      backpressure: strategy,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(generateCallCount).toBe(1);
  });

  it('emits backpressure.applied and backpressure.released events', async () => {
    // Create a strategy that always reports a small delay
    const mockStrategy = {
      beforeStep: () => ({ delay: 1 }),
      onSuccess: () => {},
      onError: () => {},
      get currentDelay() {
        return 1;
      },
      get isActive() {
        return true;
      },
    };

    const activeRun = createActiveRun({
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      backpressure: mockStrategy,
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const appliedEvents = recorder.events.filter((e) => e.type === 'backpressure.applied');
    const releasedEvents = recorder.events.filter((e) => e.type === 'backpressure.released');
    expect(appliedEvents).toHaveLength(1);
    expect(releasedEvents).toHaveLength(1);
    expect((appliedEvents[0].detail as { step: number; delay: number }).step).toBe(0);
    expect((appliedEvents[0].detail as { step: number; delay: number }).delay).toBe(1);
    expect((releasedEvents[0].detail as { step: number }).step).toBe(0);
  });

  it('does not emit backpressure events when delay is 0', async () => {
    const strategy = createAdaptiveBackoff();

    const activeRun = createActiveRun({
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      backpressure: strategy,
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const appliedEvents = recorder.events.filter((e) => e.type === 'backpressure.applied');
    const releasedEvents = recorder.events.filter((e) => e.type === 'backpressure.released');
    expect(appliedEvents).toHaveLength(0);
    expect(releasedEvents).toHaveLength(0);
  });

  it('aborts immediately if signal fires during beforeStep', async () => {
    const controller = new AbortController();

    const mockStrategy = {
      beforeStep: () => {
        // Abort the signal during beforeStep so the pre-wait check catches it
        controller.abort('during-beforeStep');
        return { delay: 10_000 };
      },
      onSuccess: () => {},
      onError: () => {},
      get currentDelay() {
        return 10_000;
      },
      get isActive() {
        return true;
      },
    };

    const result = await run({
      generate: async () => textResponse('Should not reach'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      signal: controller.signal,
      backpressure: mockStrategy,
    });

    expect(result.finishReason).toBe('aborted');
  });

  it('abort signal cancels backpressure delay', async () => {
    const controller = new AbortController();
    const mockStrategy = {
      beforeStep: () => ({ delay: 10_000 }),
      onSuccess: () => {},
      onError: () => {},
      get currentDelay() {
        return 10_000;
      },
      get isActive() {
        return true;
      },
    };

    const result = await run({
      generate: async () => textResponse('Should not reach'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      signal: controller.signal,
      backpressure: {
        ...mockStrategy,
        beforeStep: () => {
          controller.abort('cancel');
          return { delay: 10_000 };
        },
      },
    });

    expect(result.finishReason).toBe('aborted');
  });

  it('backpressure composes with retry (both can be set)', async () => {
    let callCount = 0;
    const strategy = createAdaptiveBackoff({ initialDelay: 1 });

    const generate = async () => {
      callCount++;
      if (callCount === 1) throw new Error('transient');
      return textResponse('Done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      backpressure: strategy,
      retry: { attempts: 3, delay: 0 },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('Done');
    expect(callCount).toBe(2);
  });

  it('onSuccess is called when generate succeeds', async () => {
    let successCount = 0;
    const mockStrategy = {
      beforeStep: () => ({ delay: 0 }),
      onSuccess: () => {
        successCount++;
      },
      onError: () => {},
      get currentDelay() {
        return 0;
      },
      get isActive() {
        return false;
      },
    };

    await run({
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      backpressure: mockStrategy,
    });

    expect(successCount).toBe(1);
  });

  it('onError is called when generate fails', async () => {
    let errorCount = 0;
    const mockStrategy = {
      beforeStep: () => ({ delay: 0 }),
      onSuccess: () => {},
      onError: () => {
        errorCount++;
      },
      get currentDelay() {
        return 0;
      },
      get isActive() {
        return false;
      },
    };

    const result = await run({
      generate: async () => {
        throw new Error('fail');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      backpressure: mockStrategy,
    });

    expect(result.finishReason).toBe('error');
    expect(errorCount).toBe(1);
  });

  it('backpressure delay is applied on each step in a multi-step loop', async () => {
    let beforeStepCount = 0;
    const mockStrategy = {
      beforeStep: () => {
        beforeStepCount++;
        return { delay: 0 };
      },
      onSuccess: () => {},
      onError: () => {},
      get currentDelay() {
        return 0;
      },
      get isActive() {
        return false;
      },
    };

    const result = await run({
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 3,
      backpressure: mockStrategy,
    });

    expect(result.finishReason).toBe('maximum-steps');
    expect(beforeStepCount).toBe(3);
  });
});
