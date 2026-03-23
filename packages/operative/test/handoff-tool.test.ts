import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { toolCalled } from '../src/conditions/predicates';
import {
  createHandoffTool,
  extractHandoffTarget,
  HANDOFF_MARKER,
} from '../src/create-handoff-tool';
import { defineAgent } from '../src/define-agent';
import { run } from '../src/run';
import type { AgentDefinition, GenerateResponse } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

const targetAgent: AgentDefinition = defineAgent({
  name: 'specialist',
  generate: async () => textResponse('Specialist response'),
  toolbox: createTestToolbox([]),
  stopWhen: (context) => context.toolCalls.length === 0,
});

describe('createHandoffTool', () => {
  it('creates a tool named transfer_to_<agent_name> by default', () => {
    const tool = createHandoffTool({ agent: targetAgent });
    expect(tool.name).toBe('transfer_to_specialist');
  });

  it('uses a custom name when provided', () => {
    const tool = createHandoffTool({ agent: targetAgent, name: 'hand_to_expert' });
    expect(tool.name).toBe('hand_to_expert');
  });

  it('uses a custom description when provided', () => {
    const tool = createHandoffTool({
      agent: targetAgent,
      description: 'Transfer to the specialist agent.',
    });
    expect(tool.description).toBe('Transfer to the specialist agent.');
  });

  it('returns handoff metadata as JSON with the marker', async () => {
    const tool = createHandoffTool({ agent: targetAgent });
    const result = await tool({});
    const parsed = JSON.parse(String(result)) as Record<string, unknown>;
    expect(parsed['type']).toBe(HANDOFF_MARKER);
    expect(parsed['agent']).toBe('specialist');
  });
});

describe('extractHandoffTarget', () => {
  it('extracts the agent name from a handoff result', () => {
    const steps = [
      {
        results: [
          {
            content: JSON.stringify({ type: HANDOFF_MARKER, agent: 'specialist' }),
          },
        ],
      },
    ];

    expect(extractHandoffTarget(steps)).toBe('specialist');
  });

  it('returns undefined when no handoff result exists', () => {
    const steps = [
      {
        results: [{ content: 'Just a normal tool result' }],
      },
    ];

    expect(extractHandoffTarget(steps)).toBeUndefined();
  });

  it('returns undefined for empty steps', () => {
    expect(extractHandoffTarget([])).toBeUndefined();
  });

  it('returns undefined when the last step has no results', () => {
    const steps = [{ results: [] }];
    expect(extractHandoffTarget(steps)).toBeUndefined();
  });

  it('ignores non-JSON results gracefully', () => {
    const steps = [
      {
        results: [
          { content: 'not json' },
          { content: JSON.stringify({ type: HANDOFF_MARKER, agent: 'target' }) },
        ],
      },
    ];

    expect(extractHandoffTarget(steps)).toBe('target');
  });
});

describe('handoff integration with stopWhen.toolCalled', () => {
  it('stops the loop when the handoff tool is called', async () => {
    const handoffTool = createHandoffTool({ agent: targetAgent });

    let callCount = 0;
    const generate = async (): Promise<GenerateResponse> => {
      callCount++;
      if (callCount === 1) {
        return toolCallResponse([{ name: 'transfer_to_specialist', arguments: {} }]);
      }
      return textResponse('Should not reach here');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([handoffTool]),
      conversation: new Conversation(),
      stopWhen: toolCalled('transfer_to_specialist'),
      maximumSteps: 10,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(1);

    const target = extractHandoffTarget(result.steps);
    expect(target).toBe('specialist');
  });

  it('preserves the conversation for the caller to pass to the next agent', async () => {
    const handoffTool = createHandoffTool({ agent: targetAgent });

    let callCount = 0;
    const parentGenerate = async (): Promise<GenerateResponse> => {
      callCount++;
      if (callCount === 1) {
        return toolCallResponse(
          [{ name: 'transfer_to_specialist', arguments: {} }],
          'I need to hand this off.',
        );
      }
      return textResponse('Should not reach here');
    };

    const conversation = new Conversation();
    conversation.appendUserMessage('Help me with a specialized task.');

    const parentResult = await run({
      generate: parentGenerate,
      toolbox: createTestToolbox([handoffTool]),
      conversation,
      stopWhen: toolCalled('transfer_to_specialist'),
      maximumSteps: 10,
    });

    // The conversation should contain the parent's messages
    const messages = parentResult.conversation.getMessages();
    expect(messages.length).toBeGreaterThan(1);

    // The caller could now pass parentResult.conversation to the target agent
    const target = extractHandoffTarget(parentResult.steps);
    expect(target).toBe('specialist');
  });
});
