import { describe, expect, it } from 'bun:test';

import type { GenerateContext } from '../../types.ts';
import type { ModelRoute } from '../types.ts';
import { createStepBasedStrategy } from './step-based.ts';

function makeContext(overrides?: Partial<GenerateContext>): GenerateContext {
  return {
    conversation: {
      current: { ids: [], messages: {} },
    } as unknown as GenerateContext['conversation'],
    step: 0,
    toolbox: { tools: () => [] } as unknown as GenerateContext['toolbox'],
    ...overrides,
  };
}

function makeRoutes(): ModelRoute[] {
  return [
    { name: 'fast', generate: async () => ({ content: '', toolCalls: [] }) },
    { name: 'smart', generate: async () => ({ content: '', toolCalls: [] }) },
    { name: 'summarizer', generate: async () => ({ content: '', toolCalls: [] }) },
  ];
}

function makeContextWithMessages(
  messages: Array<{ role: string; content: string }>,
  step: number,
): GenerateContext {
  const ids = messages.map((_, i) => `msg-${i}`);
  const messagesRecord: Record<string, unknown> = {};
  for (let i = 0; i < messages.length; i++) {
    messagesRecord[`msg-${i}`] = {
      id: `msg-${i}`,
      role: messages[i]!.role,
      content: messages[i]!.content,
      position: i,
      createdAt: new Date().toISOString(),
      metadata: {},
      hidden: false,
    };
  }

  return {
    conversation: {
      current: { ids, messages: messagesRecord },
    } as unknown as GenerateContext['conversation'],
    step,
    toolbox: { tools: () => [] } as unknown as GenerateContext['toolbox'],
  };
}

describe('createStepBasedStrategy', () => {
  it('routes step 0 to the first model', () => {
    const strategy = createStepBasedStrategy({ first: 'fast', middle: 'smart' });
    const routes = makeRoutes();
    const context = makeContext({ step: 0 });

    const decision = strategy(context, routes);
    expect(decision.route).toBe('fast');
    expect(decision.reason).toContain('first');
  });

  it('routes step 1 to the middle model by default', () => {
    const strategy = createStepBasedStrategy({ first: 'fast', middle: 'smart' });
    const routes = makeRoutes();
    const context = makeContext({ step: 1 });

    const decision = strategy(context, routes);
    expect(decision.route).toBe('smart');
    expect(decision.reason).toContain('middle');
  });

  it('routes steps >= middleAfterStep to the middle model', () => {
    const strategy = createStepBasedStrategy({
      first: 'fast',
      middle: 'smart',
      middleAfterStep: 3,
    });
    const routes = makeRoutes();

    // Steps 1 and 2 should still be 'first' since middleAfterStep is 3
    expect(strategy(makeContext({ step: 1 }), routes).route).toBe('fast');
    expect(strategy(makeContext({ step: 2 }), routes).route).toBe('fast');
    expect(strategy(makeContext({ step: 3 }), routes).route).toBe('smart');
    expect(strategy(makeContext({ step: 10 }), routes).route).toBe('smart');
  });

  it('routes to last model when no tool calls are pending', () => {
    const strategy = createStepBasedStrategy({
      first: 'fast',
      middle: 'smart',
      last: 'summarizer',
    });
    const routes = makeRoutes();

    // An assistant message at the end with no tool-call messages — looks like final step
    const context = makeContextWithMessages(
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Done!' },
      ],
      5,
    );

    const decision = strategy(context, routes);
    expect(decision.route).toBe('summarizer');
    expect(decision.reason).toContain('last');
  });

  it('routes to middle model when tool calls are pending even with last configured', () => {
    const strategy = createStepBasedStrategy({
      first: 'fast',
      middle: 'smart',
      last: 'summarizer',
    });
    const routes = makeRoutes();

    // Tool-call messages at the end indicate more work
    const context = makeContextWithMessages(
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Let me check' },
        { role: 'tool-call', content: 'get_weather' },
      ],
      5,
    );

    const decision = strategy(context, routes);
    expect(decision.route).toBe('smart');
  });

  it('uses default middleAfterStep of 1', () => {
    const strategy = createStepBasedStrategy({ first: 'fast', middle: 'smart' });
    const routes = makeRoutes();

    expect(strategy(makeContext({ step: 0 }), routes).route).toBe('fast');
    expect(strategy(makeContext({ step: 1 }), routes).route).toBe('smart');
  });

  it('does not use last model on step 0', () => {
    const strategy = createStepBasedStrategy({
      first: 'fast',
      middle: 'smart',
      last: 'summarizer',
    });
    const routes = makeRoutes();

    const context = makeContext({ step: 0 });
    const decision = strategy(context, routes);
    expect(decision.route).toBe('fast');
  });
});
