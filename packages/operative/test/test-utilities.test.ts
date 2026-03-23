import { describe, expect, it } from 'bun:test';

import {
  createMockAgentDefinition,
  createMockAgentRegistry,
  createMockScratchpad,
} from '../src/test/index';

describe('createMockScratchpad', () => {
  it('creates a scratchpad with initial values', () => {
    const pad = createMockScratchpad({ x: 1, y: 2 });
    expect(pad.get('x')).toBe(1);
    expect(pad.get('y')).toBe(2);
  });

  it('creates an empty scratchpad when no values given', () => {
    const pad = createMockScratchpad();
    expect(pad.toJSON()).toEqual({});
  });
});

describe('createMockAgentDefinition', () => {
  it('creates a mock agent with the given name', () => {
    const agent = createMockAgentDefinition('test');
    expect(agent.name).toBe('test');
  });

  it('run returns mock content', async () => {
    const agent = createMockAgentDefinition('helper');
    const result = await agent.run('Hello');
    expect(result.content).toBe('Mock response from helper');
    expect(result.finishReason).toBe('stop-condition');
  });

  it('exposes options with a mock generate function', async () => {
    const agent = createMockAgentDefinition('helper');
    const response = await agent.options.generate({
      conversation: {} as never,
      step: 0,
      toolbox: {} as never,
    });
    expect(response.content).toBe('Mock response from helper');
  });

  it('createRun returns a placeholder', () => {
    const agent = createMockAgentDefinition('helper');
    // Just verify it doesn't throw
    const result = agent.createRun('Hi');
    expect(result).toBeDefined();
  });

  it('applies overrides', async () => {
    const agent = createMockAgentDefinition('custom', {
      run: async () => ({
        conversation: {} as never,
        steps: [],
        content: 'Custom output',
        usage: { prompt: 0, completion: 0, total: 0 },
        finishReason: 'stop-condition' as const,
      }),
    });
    const result = await agent.run('Hi');
    expect(result.content).toBe('Custom output');
  });
});

describe('createMockAgentRegistry', () => {
  it('creates an empty registry', () => {
    const registry = createMockAgentRegistry();
    expect(registry.entries()).toEqual([]);
  });

  it('creates a pre-populated registry', () => {
    const agent = createMockAgentDefinition('a');
    const registry = createMockAgentRegistry([
      { agent, description: 'Agent A', capabilities: ['x'] },
    ]);
    expect(registry.has('a')).toBe(true);
    expect(registry.entries()).toHaveLength(1);
  });
});
