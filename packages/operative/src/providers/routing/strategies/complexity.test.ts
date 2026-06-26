import { describe, expect, it } from 'bun:test';

import type { GenerateContext } from '../../types.ts';
import { createComplexityStrategy, extractComplexitySignals } from './complexity.ts';
import { makeContext, makeContextWithMessages, makeRoutes } from './test-helpers.ts';

describe('extractComplexitySignals', () => {
  it('returns zero-valued signals for empty context', () => {
    const context = makeContext();
    const signals = extractComplexitySignals(context);

    expect(signals.messageCount).toBe(0);
    expect(signals.toolCount).toBe(0);
    expect(signals.lastMessageLength).toBe(0);
    expect(signals.hasCodeContent).toBe(false);
    expect(signals.conversationDepth).toBe(0);
    expect(signals.pendingToolResults).toBe(0);
  });

  it('counts messages from conversation history', () => {
    const context = makeContextWithMessages([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);

    const signals = extractComplexitySignals(context);
    expect(signals.messageCount).toBe(2);
  });

  it('counts tools from toolbox', () => {
    const tools = [{ name: 'tool1' }, { name: 'tool2' }, { name: 'tool3' }];
    const context = makeContext({
      toolbox: { tools: () => tools } as unknown as GenerateContext['toolbox'],
    });

    const signals = extractComplexitySignals(context);
    expect(signals.toolCount).toBe(3);
  });

  it('measures last message content length', () => {
    const context = makeContextWithMessages([
      { role: 'user', content: 'Short' },
      { role: 'user', content: 'This is a longer message with more content' },
    ]);

    const signals = extractComplexitySignals(context);
    expect(signals.lastMessageLength).toBe('This is a longer message with more content'.length);
  });

  it('detects code content with backticks', () => {
    const context = makeContextWithMessages([
      { role: 'user', content: 'Here is some code: `console.log("hello")`' },
    ]);

    const signals = extractComplexitySignals(context);
    expect(signals.hasCodeContent).toBe(true);
  });

  it('detects code content with triple backticks', () => {
    const context = makeContextWithMessages([
      { role: 'user', content: '```javascript\nconsole.log("hello")\n```' },
    ]);

    const signals = extractComplexitySignals(context);
    expect(signals.hasCodeContent).toBe(true);
  });

  it('detects code content with common patterns', () => {
    const context = makeContextWithMessages([
      { role: 'user', content: 'function getData() { return 42; }' },
    ]);

    const signals = extractComplexitySignals(context);
    expect(signals.hasCodeContent).toBe(true);
  });

  it('returns false for hasCodeContent on plain text', () => {
    const context = makeContextWithMessages([
      { role: 'user', content: 'What is the weather like today?' },
    ]);

    const signals = extractComplexitySignals(context);
    expect(signals.hasCodeContent).toBe(false);
  });

  it('uses step field for conversationDepth', () => {
    const context = makeContext({ step: 7 });
    const signals = extractComplexitySignals(context);
    expect(signals.conversationDepth).toBe(7);
  });

  it('counts pending tool results', () => {
    const context = makeContextWithMessages([
      { role: 'user', content: 'Do something' },
      { role: 'assistant', content: 'Calling tools' },
      { role: 'tool-result', content: 'Result 1' },
      { role: 'tool-result', content: 'Result 2' },
    ]);

    const signals = extractComplexitySignals(context);
    // Two tool-results at the end with no subsequent assistant message
    expect(signals.pendingToolResults).toBe(2);
  });

  it('returns zero pending tool results when assistant replied after tools', () => {
    const context = makeContextWithMessages([
      { role: 'user', content: 'Do something' },
      { role: 'assistant', content: 'Calling tools' },
      { role: 'tool-result', content: 'Result 1' },
      { role: 'assistant', content: 'Here is the answer' },
    ]);

    const signals = extractComplexitySignals(context);
    expect(signals.pendingToolResults).toBe(0);
  });
});

describe('createComplexityStrategy', () => {
  it('routes simple tasks to the simple model', () => {
    const strategy = createComplexityStrategy({ simple: 'fast', complex: 'smart' });
    const routes = makeRoutes();

    // Short message, no tools, no code, low depth
    const context = makeContextWithMessages([{ role: 'user', content: 'Hello' }]);

    const decision = strategy(context, routes);
    expect(decision.route).toBe('fast');
    expect(decision.reason).toContain('simple');
  });

  it('routes complex tasks to the complex model', () => {
    const strategy = createComplexityStrategy({ simple: 'fast', complex: 'smart' });
    const routes = makeRoutes();

    // Many tools, moderate message
    const tools = Array.from({ length: 5 }, (_, i) => ({ name: `tool-${i}` }));
    const context = makeContextWithMessages(
      [{ role: 'user', content: 'Please analyze this data and generate a report' }],
      {
        toolbox: { tools: () => tools } as unknown as GenerateContext['toolbox'],
        step: 3,
      },
    );

    const decision = strategy(context, routes);
    expect(decision.route).toBe('smart');
  });

  it('routes frontier tasks to the frontier model when provided', () => {
    const strategy = createComplexityStrategy({
      simple: 'fast',
      complex: 'smart',
      frontier: 'frontier',
    });
    const routes = makeRoutes();

    // Very long message, many tools, deep conversation
    const tools = Array.from({ length: 12 }, (_, i) => ({ name: `tool-${i}` }));
    const context = makeContextWithMessages([{ role: 'user', content: 'x'.repeat(2500) }], {
      toolbox: { tools: () => tools } as unknown as GenerateContext['toolbox'],
      step: 25,
    });

    const decision = strategy(context, routes);
    expect(decision.route).toBe('frontier');
  });

  it('falls back to complex when frontier is not provided', () => {
    const strategy = createComplexityStrategy({ simple: 'fast', complex: 'smart' });
    const routes = makeRoutes();

    // Frontier-level signals but no frontier route configured
    const tools = Array.from({ length: 12 }, (_, i) => ({ name: `tool-${i}` }));
    const context = makeContextWithMessages([{ role: 'user', content: 'x'.repeat(2500) }], {
      toolbox: { tools: () => tools } as unknown as GenerateContext['toolbox'],
      step: 25,
    });

    const decision = strategy(context, routes);
    expect(decision.route).toBe('smart');
  });

  it('uses custom scorer when provided', () => {
    const strategy = createComplexityStrategy({
      simple: 'fast',
      complex: 'smart',
      frontier: 'frontier',
      scorer: () => 'frontier',
    });
    const routes = makeRoutes();

    // Even a simple context gets routed to frontier by custom scorer
    const context = makeContextWithMessages([{ role: 'user', content: 'Hi' }]);

    const decision = strategy(context, routes);
    expect(decision.route).toBe('frontier');
  });

  it('classifies based on tool count threshold', () => {
    const strategy = createComplexityStrategy({ simple: 'fast', complex: 'smart' });
    const routes = makeRoutes();

    // Exactly 3 tools — should be complex (not simple, since simple requires < 3)
    const tools = Array.from({ length: 3 }, (_, i) => ({ name: `tool-${i}` }));
    const context = makeContextWithMessages([{ role: 'user', content: 'Short' }], {
      toolbox: { tools: () => tools } as unknown as GenerateContext['toolbox'],
    });

    const decision = strategy(context, routes);
    expect(decision.route).toBe('smart');
  });

  it('classifies based on message length threshold', () => {
    const strategy = createComplexityStrategy({ simple: 'fast', complex: 'smart' });
    const routes = makeRoutes();

    // Message exactly at 500 chars — should be complex (simple requires < 500)
    const context = makeContextWithMessages([{ role: 'user', content: 'x'.repeat(500) }]);

    const decision = strategy(context, routes);
    expect(decision.route).toBe('smart');
  });

  it('classifies as simple when all conditions met', () => {
    const strategy = createComplexityStrategy({ simple: 'fast', complex: 'smart' });
    const routes = makeRoutes();

    // toolCount < 3 AND lastMessageLength < 500 AND !hasCodeContent AND depth < 5
    const tools = [{ name: 'tool1' }, { name: 'tool2' }];
    const context = makeContextWithMessages(
      [{ role: 'user', content: 'What is the capital of France?' }],
      {
        toolbox: { tools: () => tools } as unknown as GenerateContext['toolbox'],
        step: 2,
      },
    );

    const decision = strategy(context, routes);
    expect(decision.route).toBe('fast');
  });

  it('classifies as complex when code content is present', () => {
    const strategy = createComplexityStrategy({ simple: 'fast', complex: 'smart' });
    const routes = makeRoutes();

    const context = makeContextWithMessages([{ role: 'user', content: '`console.log(42)`' }]);

    const decision = strategy(context, routes);
    expect(decision.route).toBe('smart');
  });
});
