import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createSubagentTool } from '../src/create-subagent-tool';
import { defineAgent } from '../src/define-agent';
import { run } from '../src/run';
import type { GenerateResponse } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

describe('createSubagentTool', () => {
  it('runs nested agent and returns its content', async () => {
    const subAgent = defineAgent({
      name: 'sub-agent',
      generate: async () => textResponse('Sub-agent result'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    const subTool = createSubagentTool({
      name: 'delegate',
      description: 'Delegate to sub-agent',
      agent: subAgent,
      input: z.object({ task: z.string() }),
    });

    let callCount = 0;
    const generate = async () => {
      callCount++;
      if (callCount === 1) {
        return toolCallResponse([{ name: 'delegate', arguments: { task: 'do something' } }]);
      }
      return textResponse('Parent done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([subTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('Parent done');
    expect(result.steps[0].results).toHaveLength(1);
    // The sub-agent result should be available as the tool result content
    expect(result.steps[0].results[0].outcome).toBe('success');
  });

  it('uses custom mapInput to transform tool params', async () => {
    let receivedInput: string | undefined;

    const subAgent = defineAgent({
      name: 'mapped-sub',
      generate: async ({ conversation }) => {
        const messages = conversation.getMessages();
        receivedInput = (messages[messages.length - 1] as { content: string }).content;
        return textResponse('Mapped result');
      },
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    const subTool = createSubagentTool({
      name: 'delegate',
      description: 'Delegate',
      agent: subAgent,
      input: z.object({ task: z.string(), priority: z.string() }),
      mapInput: (params) => {
        const p = params as { task: string; priority: string };
        return `[${p.priority}] ${p.task}`;
      },
    });

    let callCount = 0;
    const result = await run({
      generate: async () => {
        callCount++;
        if (callCount === 1)
          return toolCallResponse([
            { name: 'delegate', arguments: { task: 'deploy', priority: 'high' } },
          ]);
        return textResponse('Done');
      },
      toolbox: createTestToolbox([subTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    expect(receivedInput).toBe('[high] deploy');
  });

  it('uses custom mapOutput to transform the result', async () => {
    const subAgent = defineAgent({
      name: 'output-sub',
      generate: async () => textResponse('raw output'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    const subTool = createSubagentTool({
      name: 'delegate',
      description: 'Delegate',
      agent: subAgent,
      input: z.object({ task: z.string() }),
      mapOutput: (result) => ({ transformed: result.content, steps: result.steps.length }),
    });

    let callCount = 0;
    const result = await run({
      generate: async () => {
        callCount++;
        if (callCount === 1)
          return toolCallResponse([{ name: 'delegate', arguments: { task: 'test' } }]);
        return textResponse('Done');
      },
      toolbox: createTestToolbox([subTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    expect(result.steps[0].results[0].outcome).toBe('success');
  });

  it('sub-agent gets its own independent conversation', async () => {
    const parentMessages: number[] = [];
    const subMessages: number[] = [];

    const subAgent = defineAgent({
      name: 'isolated-sub',
      generate: async ({ conversation }) => {
        subMessages.push(conversation.getMessages().length);
        return textResponse('Sub done');
      },
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    const subTool = createSubagentTool({
      name: 'delegate',
      description: 'Delegate',
      agent: subAgent,
      input: z.object({ task: z.string() }),
    });

    let callCount = 0;
    await run({
      generate: async ({ conversation }) => {
        callCount++;
        parentMessages.push(conversation.getMessages().length);
        if (callCount === 1)
          return toolCallResponse([{ name: 'delegate', arguments: { task: 'work' } }]);
        return textResponse('Parent done');
      },
      toolbox: createTestToolbox([subTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    // Sub-agent should have its own conversation with only the delegated message
    expect(subMessages).toHaveLength(1);
    // Sub-agent conversation starts fresh (1 user message from mapInput default)
    expect(subMessages[0]).toBe(1);
  });

  it('handles sub-agent errors gracefully as tool errors', async () => {
    const subAgent = defineAgent({
      name: 'failing-sub',
      generate: async () => {
        throw new Error('Sub-agent exploded');
      },
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    const subTool = createSubagentTool({
      name: 'delegate',
      description: 'Delegate',
      agent: subAgent,
      input: z.object({ task: z.string() }),
    });

    let callCount = 0;
    const result = await run({
      generate: async () => {
        callCount++;
        if (callCount === 1)
          return toolCallResponse([{ name: 'delegate', arguments: { task: 'fail' } }]);
        return textResponse('Recovered');
      },
      toolbox: createTestToolbox([subTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    // The sub-agent error should be caught by armorer's tool execution
    // and returned as an error result, allowing the parent loop to continue
    expect(result.steps[0].results[0].outcome).toBe('error');
    expect(result.content).toBe('Recovered');
  });
});
