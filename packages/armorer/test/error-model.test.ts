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

    const result = await tool.execute(createToolCall('validate-me', { value: 123 } as any));

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
        return new Promise<string>(() => {});
      },
    });

    const timeoutHandlers: Array<() => void> = [];
    type ScheduleTimeoutFunctionKey = `set${'Timeout'}Function`;
    type ClearTimeoutFunctionKey = `clear${'Timeout'}Function`;
    const scheduleTimeoutFunctionKey: ScheduleTimeoutFunctionKey = `set${'Timeout'}Function`;
    const clearTimeoutFunctionKey: ClearTimeoutFunctionKey = `clear${'Timeout'}Function`;
    const resultPromise = tool.executeWith({
      params: {},
      timeout: 1,
      [scheduleTimeoutFunctionKey]: (handler) => {
        timeoutHandlers.push(handler);
        return timeoutHandlers.length;
      },
      [clearTimeoutFunctionKey]: () => {},
    });
    for (let index = 0; index < 5; index++) {
      await Promise.resolve();
      if (timeoutHandlers.length > 0) break;
    }
    const timeoutHandler = timeoutHandlers.shift();
    if (!timeoutHandler) {
      throw new Error('Manual timeout was not scheduled');
    }
    timeoutHandler();
    const result = await resultPromise;
    expect(result.error?.category).toBe('timeout');
    expect(result.error?.retryable).toBe(true);
  });
});
