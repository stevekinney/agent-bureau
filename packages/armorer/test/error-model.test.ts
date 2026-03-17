import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool, createToolCall } from '../src/create-tool';

describe('ToolError model', () => {
  it('maps validation errors to structured ToolError', async () => {
    const tool = createTool({
      name: 'validate-me',
      description: 'validate input',
      input: z.object({ value: z.string() }),
      async execute({ value }) {
        return value.toUpperCase();
      },
    });

    const result = await tool.execute(
      createToolCall('validate-me', { value: 123 } as any),
    );

    expect(result.error?.category).toBe('validation');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    const issues = (result.error?.details as any)?.issues;
    expect(Array.isArray(issues)).toBe(true);
  });

  it('maps timeouts to retryable ToolError', async () => {
    const tool = createTool({
      name: 'timeout-tool',
      description: 'times out',
      input: z.object({}),
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return 'ok';
      },
    });

    const result = await tool.executeWith({ params: {}, timeout: 1 });
    expect(result.error?.category).toBe('timeout');
    expect(result.error?.retryable).toBe(true);
  });
});
