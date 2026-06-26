import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { createRunRecorder } from '../src/test/index';
import type { ElicitationRequest, GenerateResponse } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

describe('elicitation', () => {
  it('callback receives correct request shape', async () => {
    const requests: ElicitationRequest[] = [];
    const confirmationSchema = z.object({ confirmed: z.boolean() });

    await run({
      generate: async () => textResponse('Hello'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      onElicitation: async (request) => {
        requests.push(request);
        return { data: { confirmed: true } } as any;
      },
      prepareStep: async ({ elicit }) => {
        if (elicit) {
          await elicit('Do you confirm?', confirmationSchema);
        }
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].message).toBe('Do you confirm?');
    expect(requests[0].schema).toBe(confirmationSchema);
    expect(requests[0].context.step).toBe(0);
    expect(requests[0].context.conversation).toBeInstanceOf(Conversation);
  });

  it('loop pauses and resumes with validated data', async () => {
    const confirmationSchema = z.object({ approved: z.boolean() });

    const result = await run({
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      onElicitation: async () => {
        return { data: { approved: true } } as any;
      },
      prepareStep: async ({ elicit }) => {
        if (elicit) {
          const response = await elicit('Approve?', confirmationSchema);
          expect(response).toEqual({ approved: true });
        }
      },
    });

    expect(result.finishReason).toBe('stop-condition');
  });

  it('returns null when user declines', async () => {
    const confirmationSchema = z.object({ confirmed: z.boolean() });

    const result = await run({
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      onElicitation: async () => {
        return null;
      },
      prepareStep: async ({ elicit }) => {
        if (elicit) {
          const response = await elicit('Do you confirm?', confirmationSchema);
          expect(response).toBeNull();
        }
      },
    });

    expect(result.finishReason).toBe('stop-condition');
  });

  it('emits elicitation.requested and elicitation.resolved events', async () => {
    const confirmationSchema = z.object({ confirmed: z.boolean() });

    const activeRun = createActiveRun({
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      onElicitation: async () => {
        return { data: { confirmed: true } } as any;
      },
      prepareStep: async ({ elicit }) => {
        if (elicit) {
          await elicit('Do you confirm?', confirmationSchema);
        }
      },
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const requestedEvents = recorder.events.filter((e) => e.type === 'elicitation.requested');
    expect(requestedEvents).toHaveLength(1);
    expect((requestedEvents[0].detail as { step: number; message: string }).message).toBe(
      'Do you confirm?',
    );
    expect((requestedEvents[0].detail as { step: number; message: string }).step).toBe(0);

    const resolvedEvents = recorder.events.filter((e) => e.type === 'elicitation.resolved');
    expect(resolvedEvents).toHaveLength(1);
    expect((resolvedEvents[0].detail as { step: number; accepted: boolean }).accepted).toBe(true);
  });

  it('emits elicitation.resolved with accepted false when declined', async () => {
    const confirmationSchema = z.object({ confirmed: z.boolean() });

    const activeRun = createActiveRun({
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      onElicitation: async () => {
        return null;
      },
      prepareStep: async ({ elicit }) => {
        if (elicit) {
          await elicit('Do you confirm?', confirmationSchema);
        }
      },
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const resolvedEvents = recorder.events.filter((e) => e.type === 'elicitation.resolved');
    expect(resolvedEvents).toHaveLength(1);
    expect((resolvedEvents[0].detail as { step: number; accepted: boolean }).accepted).toBe(false);
  });

  it('elicit is undefined when no onElicitation callback is configured', async () => {
    let elicitValue: unknown = 'not-set';

    const result = await run({
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      prepareStep: async ({ elicit }) => {
        elicitValue = elicit;
      },
    });

    expect(elicitValue).toBeUndefined();
    expect(result.finishReason).toBe('stop-condition');
  });

  it('works from beforeToolExecution hook', async () => {
    const confirmationSchema = z.object({ proceed: z.boolean() });
    let elicitedValue: unknown = null;

    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      onElicitation: async () => {
        return { data: { proceed: true } } as any;
      },
      beforeToolExecution: async ({ toolCalls, elicit }) => {
        if (elicit) {
          elicitedValue = await elicit('Proceed with tool calls?', confirmationSchema);
        }
        return toolCalls;
      },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(elicitedValue).toEqual({ proceed: true });
  });

  it('works from afterToolExecution hook', async () => {
    const feedbackSchema = z.object({ rating: z.number() });
    let elicitedValue: unknown = null;

    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      onElicitation: async () => {
        return { data: { rating: 5 } } as any;
      },
      afterToolExecution: async ({ elicit }) => {
        if (elicit) {
          elicitedValue = await elicit('Rate this result', feedbackSchema);
        }
      },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(elicitedValue).toEqual({ rating: 5 });
  });

  it('works from validateResponse hook', async () => {
    const approvalSchema = z.object({ approved: z.boolean() });
    let elicitedValue: unknown = null;

    const result = await run({
      generate: async () => textResponse('Sensitive content'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      onElicitation: async () => {
        return { data: { approved: true } } as any;
      },
      validateResponse: async (response, { elicit }) => {
        if (elicit) {
          elicitedValue = await elicit('Approve this response?', approvalSchema);
        }
        return response;
      },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(elicitedValue).toEqual({ approved: true });
  });

  it('works from validateToolResult hook', async () => {
    const reviewSchema = z.object({ accepted: z.boolean() });
    let elicitedValue: unknown = null;

    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      onElicitation: async () => {
        return { data: { accepted: true } } as any;
      },
      validateToolResult: async (toolResult, { elicit }) => {
        if (elicit) {
          elicitedValue = await elicit('Accept this tool result?', reviewSchema);
        }
        return toolResult;
      },
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(elicitedValue).toEqual({ accepted: true });
  });
});
