import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createToolRemovalMutator } from '../../src/retry/tool-removal-mutator';
import type { GenerateContext } from '../../src/types';

function makeContext(toolNames: string[]): GenerateContext {
  const entries = toolNames.map((name) => ({
    name,
    description: `A tool named ${name}`,
    parameters: {},
    execute: async () => `result from ${name}`,
  }));

  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createTestToolbox(entries),
  };
}

describe('createToolRemovalMutator', () => {
  it('returns void for errors without a tool name', async () => {
    const mutator = createToolRemovalMutator();
    const context = makeContext(['toolA', 'toolB']);
    const result = await mutator(context, new Error('generic error'), 1);
    expect(result).toBeUndefined();
  });

  it('removes the failing tool from the toolbox when tool name is in the error message', async () => {
    const mutator = createToolRemovalMutator();
    const context = makeContext(['calculator', 'weather']);
    const error = new Error('Tool "calculator" failed: invalid input');
    const result = await mutator(context, error, 1);
    expect(result).toBeDefined();
    const tools = result!.toolbox.tools();
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain('calculator');
    expect(toolNames).toContain('weather');
  });

  it('extracts tool name from error with toolName property', async () => {
    const mutator = createToolRemovalMutator();
    const context = makeContext(['search', 'browse']);
    const error = Object.assign(new Error('tool failed'), { toolName: 'search' });
    const result = await mutator(context, error, 1);
    expect(result).toBeDefined();
    const toolNames = result!.toolbox.tools().map((t) => t.name);
    expect(toolNames).not.toContain('search');
    expect(toolNames).toContain('browse');
  });

  it('extracts tool name from error with tool_name property', async () => {
    const mutator = createToolRemovalMutator();
    const context = makeContext(['search', 'browse']);
    const error = Object.assign(new Error('failed'), { tool_name: 'browse' });
    const result = await mutator(context, error, 1);
    expect(result).toBeDefined();
    const toolNames = result!.toolbox.tools().map((t) => t.name);
    expect(toolNames).toContain('search');
    expect(toolNames).not.toContain('browse');
  });

  it('does not mutate the original toolbox', async () => {
    const mutator = createToolRemovalMutator();
    const context = makeContext(['calculator', 'weather']);
    const originalToolCount = context.toolbox.tools().length;
    const error = new Error('Tool "calculator" failed');
    await mutator(context, error, 1);
    expect(context.toolbox.tools().length).toBe(originalToolCount);
  });

  it('returns void when the named tool is not in the toolbox', async () => {
    const mutator = createToolRemovalMutator();
    const context = makeContext(['toolA']);
    const error = new Error('Tool "nonexistent" failed');
    const result = await mutator(context, error, 1);
    expect(result).toBeUndefined();
  });
});
