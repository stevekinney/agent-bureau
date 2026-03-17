import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createNameMapper, toOpenAITools } from '../src/adapters/openai/index';
import { pipe } from '../src/compose';
import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import { type ToolResult } from '../src/is-tool';

describe('Core Runtime Completeness', () => {
  describe('Composition Execution', () => {
    const logStep = createTool({
      name: 'log-step',
      description: 'Logs a step',
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ value: `${value}-executed` }),
    });

    const noDryRunTool = createTool({
      name: 'no-dry-run',
      description: 'No dry run support',
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ value: `${value}-executed` }),
    });

    it('pipe executes composed tools in order', async () => {
      const pipeline = pipe(logStep, logStep);

      const result = await pipeline.execute({ value: 'start' });
      expect(result).toEqual({ value: 'start-executed-executed' });
    });

    it('pipe works when steps have mixed implementations', async () => {
      const pipeline = pipe(logStep, noDryRunTool);

      const result = await pipeline.execute({ value: 'start' });
      expect(result).toEqual({ value: 'start-executed-executed' });
    });
  });

  describe('Policy Outcomes', () => {
    it('returns action_required for needs_approval', async () => {
      const tool = createTool({
        name: 'sensitive-tool',
        description: 'Requires approval',
        input: z.object({}),
        execute: async () => 'done',
        policy: {
          beforeExecute: async () =>
            ({
              allow: false, // Wait, status overrides allow?
              status: 'needs_approval',
              allow: true, // Type definition says 'allow' is boolean.
              // If status is present, does allow matter?
              // Based on code:
              // if (decision?.status === 'needs_approval' ...) return action_required
              // So status takes precedence.
            }) as any,
        },
      });

      const result = await tool.execute({});
      const toolResult = result as unknown as ToolResult;

      // Since execute() returns ToolResult OR TReturn, and we are using createTool with TReturn type...
      // Actually execute() returns Promise<ToolResult | TReturn>.
      // But if it's action_required, it returns ToolResult.
      // Wait, createTool.execute returns TReturn if called with params directly.
      // But if it returns a ToolResult object (which is not TReturn), what happens?

      // `executeParams` throws if result.error.
      // If result.outcome === 'action_required', it is returned?
      // `executeParams` logic:
      // const result = await executeCall(toolCall, options);
      // if (result.error) throw ...
      // return result.result as TReturn;

      // If outcome is 'action_required', result.result is undefined.
      // So it returns undefined.

      // To see the full result, we should use `tool.executeWith(...)` or call with ToolCall object.

      const callResult = await tool.executeWith({ params: {} });
      expect(callResult.outcome).toBe('action_required');
      expect(callResult.action?.type).toBe('approval');
    });
  });

  describe('Tool Identity and Toolbox', () => {
    it('supports multiple tools with same name but different ID', () => {
      const tool1 = createTool({
        name: 'my-tool',
        namespace: 'ns1',
        version: '1.0.0',
        description: 'Tool 1',
        input: z.object({}),
        execute: async () => '1',
      });

      const tool2 = createTool({
        name: 'my-tool',
        namespace: 'ns2',
        version: '1.0.0',
        description: 'Tool 2',
        input: z.object({}),
        execute: async () => '2',
      });

      const toolbox = createToolbox();
      toolbox.register(tool1);
      toolbox.register(tool2);

      const retrieved1 = toolbox.getTool(tool1.id);
      const retrieved2 = toolbox.getTool(tool2.id);

      expect(retrieved1).toBeDefined();
      expect(retrieved2).toBeDefined();
      expect(retrieved1?.id).not.toBe(retrieved2?.id);

      // Retrieve by name gets the last one (tool2)
      const retrievedByName = toolbox.getTool('my-tool');
      expect(retrievedByName?.id).toBe(tool2.id);
    });

    it('serializes all configurations correctly', () => {
      const tool1 = createTool({
        name: 'my-tool',
        namespace: 'ns1',
        description: 'Tool 1',
        input: z.object({}),
        execute: async () => '1',
      });
      const tool2 = createTool({
        name: 'my-tool',
        namespace: 'ns2',
        description: 'Tool 2',
        input: z.object({}),
        execute: async () => '2',
      });

      const toolbox = createToolbox().register(tool1, tool2);
      const json = toolbox.toJSON();
      expect(json).toHaveLength(2);
      const ids = json.map((c) => c.id);
      expect(ids).toContain(tool1.id);
      expect(ids).toContain(tool2.id);
    });
  });

  describe('OpenAI Adapter', () => {
    it('exports with safe-id naming strategy', () => {
      const tool = createTool({
        name: 'my-tool',
        namespace: 'ns1',
        description: 'Tool 1',
        input: z.object({}),
        execute: async () => '1',
      });

      const openAiTool = toOpenAITools(tool, { naming: 'safe-id' });
      expect(openAiTool.function.name).not.toBe('my-tool');
      expect(openAiTool.function.name).toContain('ns1');
      expect(openAiTool.function.name).not.toContain(':');
    });

    it('creates name mapper', () => {
      const tool = createTool({
        name: 'my-tool',
        namespace: 'ns1',
        description: 'Tool 1',
        input: z.object({}),
        execute: async () => '1',
      });

      const mapper = createNameMapper([tool]);
      const safeName = toOpenAITools(tool, { naming: 'safe-id' }).function.name;

      const originalId = mapper(safeName);
      expect(originalId).toBe(tool.id);
    });
  });
});
