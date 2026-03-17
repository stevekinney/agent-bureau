import { z } from 'zod';

import { createTool } from '../create-tool';
import { createToolbox, type Toolbox } from '../create-toolbox';
import type { Tool, ToolCallWithArguments } from '../is-tool';
import type { ToolResult } from '../types';

type AnyToolbox = Toolbox<any>;

export type MockToolOptions<TInput = any, TOutput = any> = {
  name?: string;
  input?: z.ZodType<TInput>;
  impl?: (params: TInput) => Promise<TOutput> | TOutput;
};

/**
 * Creates a mock tool for testing.
 *
 * @param options - Configuration options.
 * @returns A mock Tool.
 */
export function createMockTool<TInput extends object = any, TOutput = any>(
  options: MockToolOptions<TInput, TOutput> = {},
): Tool<z.ZodType<TInput>, any, TOutput> & {
  calls: TInput[];
  mockResolve: (value: TOutput) => void;
  mockReject: (error: Error) => void;
  mockReset: () => void;
} {
  const name = options.name ?? 'mock-tool';
  const input = options.input ?? (z.object({}) as unknown as z.ZodType<TInput>);

  const calls: TInput[] = [];
  let nextImplementation: ((params: TInput) => Promise<TOutput> | TOutput) | undefined;

  const tool = createTool({
    name,
    description: 'A mock tool for testing',
    input,
    execute: async (params: TInput) => {
      calls.push(params);
      if (nextImplementation) {
        return nextImplementation(params);
      }
      if (options.impl) {
        return options.impl(params);
      }
      return undefined as unknown as TOutput;
    },
  });

  const mockTool = tool as any;
  mockTool.calls = calls;

  mockTool.mockResolve = (value: TOutput) => {
    nextImplementation = async () => value;
  };

  mockTool.mockReject = (error: Error) => {
    nextImplementation = async () => {
      throw error;
    };
  };

  mockTool.mockReset = () => {
    calls.length = 0;
    nextImplementation = undefined;
  };

  return mockTool;
}

export type TestRegistry = AnyToolbox & {
  history: { call: ToolCallWithArguments; result?: ToolResult; error?: unknown }[];
  clearHistory: () => void;
};

/**
 * Creates a Toolbox instance configured for testing.
 * Records execution history.
 */
export function createTestRegistry(): TestRegistry {
  const toolbox = createToolbox([] as Tool[]);
  const history: TestRegistry['history'] = [];

  // Listen to finished events to record history.
  toolbox.addEventListener('tool.finished', (event) => {
    const { toolCall, result, error, status } = event.detail;

    history.push({
      call: toolCall,
      result: status === 'success' ? ({ result } as any) : undefined,
      error,
    });
  });

  const testRegistry = toolbox as TestRegistry;
  testRegistry.history = history;
  testRegistry.clearHistory = () => {
    history.length = 0;
  };

  return testRegistry;
}
