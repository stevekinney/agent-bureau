import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { HookRegistry } from 'lifecycle';
import { z } from 'zod';

import type { OperativeHookMap } from '../../src/hooks.ts';
import { executeLoop } from '../../src/loop.ts';
import type { GenerateContext, GenerateResponse, RunOptions } from '../../src/types.ts';

function createTestGenerate(responses: GenerateResponse[]): {
  generate: RunOptions['generate'];
  calls: GenerateContext[];
} {
  const calls: GenerateContext[] = [];
  let index = 0;
  const generate = async (context: GenerateContext): Promise<GenerateResponse> => {
    calls.push(context);
    const response = responses[index];
    if (!response) {
      throw new Error(`No response at index ${index}`);
    }
    index++;
    return response;
  };
  return { generate, calls };
}

const finalResponse: GenerateResponse = {
  content: 'Done',
  toolCalls: [],
};

describe('toolChoice in operative loop', () => {
  it('passes default toolChoice from RunOptions to generate context', async () => {
    const { generate, calls } = createTestGenerate([finalResponse]);
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('Hello');

    await executeLoop({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: () => true,
      toolChoice: 'required',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolChoice).toBe('required');
  });

  it('passes undefined toolChoice when not configured', async () => {
    const { generate, calls } = createTestGenerate([finalResponse]);
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('Hello');

    await executeLoop({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: () => true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolChoice).toBeUndefined();
  });

  it('allows selectToolChoice hook to override the default', async () => {
    const { generate, calls } = createTestGenerate([finalResponse]);
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('Hello');

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('selectToolChoice', async () => 'none');

    await executeLoop({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: () => true,
      toolChoice: 'auto',
      hooks,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolChoice).toBe('none');
  });

  it('passes specific tool choice objects', async () => {
    const { generate, calls } = createTestGenerate([finalResponse]);
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('Hello');

    await executeLoop({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: () => true,
      toolChoice: { tool: 'search' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolChoice).toEqual({ tool: 'search' });
  });
});

describe('responseSchema to responseFormat bridge', () => {
  it('computes responseFormat from responseSchema and passes it to generate', async () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });

    const { generate, calls } = createTestGenerate([
      { content: '{"name":"Alice","age":30}', toolCalls: [] },
    ]);
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('Hello');

    await executeLoop({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: () => true,
      responseSchema: schema,
    });

    expect(calls).toHaveLength(1);
    const format = calls[0]!.responseFormat;
    expect(format).toBeDefined();
    expect(format!.type).toBe('json_schema');
    if (format!.type === 'json_schema') {
      expect(format!.schema).toMatchObject({
        type: 'object',
      });
      const props = (format!.schema as Record<string, unknown>)['properties'] as Record<
        string,
        Record<string, unknown>
      >;
      expect(props['name']).toMatchObject({ type: 'string' });
      expect(props['age']).toMatchObject({ type: 'number' });
      expect(format!.name).toBe('response');
    }
  });

  it('does not set responseFormat when responseSchema is not provided', async () => {
    const { generate, calls } = createTestGenerate([finalResponse]);
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('Hello');

    await executeLoop({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: () => true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.responseFormat).toBeUndefined();
  });
});
