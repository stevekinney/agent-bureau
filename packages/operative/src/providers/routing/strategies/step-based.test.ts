import { describe, expect, it } from 'bun:test';

import { createStepBasedStrategy } from './step-based.ts';
import { makeContext, makeContextWithMessages, makeRoutes } from './test-helpers.ts';

describe('createStepBasedStrategy', () => {
  it('routes step 0 to the first model', () => {
    const strategy = createStepBasedStrategy({ first: 'fast', middle: 'smart' });
    const routes = makeRoutes(['fast', 'smart', 'summarizer']);
    const context = makeContext({ step: 0 });

    const decision = strategy(context, routes);
    expect(decision.route).toBe('fast');
    expect(decision.reason).toContain('first');
  });

  it('routes step 1 to the middle model by default', () => {
    const strategy = createStepBasedStrategy({ first: 'fast', middle: 'smart' });
    const routes = makeRoutes(['fast', 'smart', 'summarizer']);
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
    const routes = makeRoutes(['fast', 'smart', 'summarizer']);

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
    const routes = makeRoutes(['fast', 'smart', 'summarizer']);

    // An assistant message at the end with no tool-call messages — looks like final step
    const context = makeContextWithMessages(
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Done!' },
      ],
      { step: 5 },
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
    const routes = makeRoutes(['fast', 'smart', 'summarizer']);

    // Tool-call messages at the end indicate more work
    const context = makeContextWithMessages(
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Let me check' },
        { role: 'tool-call', content: 'get_weather' },
      ],
      { step: 5 },
    );

    const decision = strategy(context, routes);
    expect(decision.route).toBe('smart');
  });

  it('uses default middleAfterStep of 1', () => {
    const strategy = createStepBasedStrategy({ first: 'fast', middle: 'smart' });
    const routes = makeRoutes(['fast', 'smart', 'summarizer']);

    expect(strategy(makeContext({ step: 0 }), routes).route).toBe('fast');
    expect(strategy(makeContext({ step: 1 }), routes).route).toBe('smart');
  });

  it('does not use last model on step 0', () => {
    const strategy = createStepBasedStrategy({
      first: 'fast',
      middle: 'smart',
      last: 'summarizer',
    });
    const routes = makeRoutes(['fast', 'smart', 'summarizer']);

    const context = makeContext({ step: 0 });
    const decision = strategy(context, routes);
    expect(decision.route).toBe('fast');
  });

  it('treats unknown trailing message roles as having no pending tool calls', () => {
    const strategy = createStepBasedStrategy({
      first: 'fast',
      middle: 'smart',
      last: 'summarizer',
    });
    const routes = makeRoutes(['fast', 'smart', 'summarizer']);
    const context = makeContextWithMessages([{ role: 'system', content: 'preface' }], {
      step: 5,
    });

    const decision = strategy(context, routes);
    expect(decision.route).toBe('summarizer');
  });

  it('creates routes with callable generate functions', async () => {
    const route = makeRoutes(['fast'])[0]!;

    const result = await route.generate(makeContext());

    expect(result).toEqual({ content: '', toolCalls: [] });
  });
});
