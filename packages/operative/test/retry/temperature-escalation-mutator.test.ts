import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import {
  createTemperatureEscalationMutator,
  RETRY_TEMPERATURE_KEY,
} from '../../src/retry/temperature-escalation-mutator';
import type { GenerateContext } from '../../src/types';

function makeContext(): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createTestToolbox([]),
  };
}

describe('createTemperatureEscalationMutator', () => {
  it('increases temperature on each retry attempt', async () => {
    const mutator = createTemperatureEscalationMutator();
    const context = makeContext();

    const result1 = await mutator(context, new Error('fail'), 1);
    expect(result1).toBeDefined();
    expect(result1!.conversation.getSnapshot().metadata[RETRY_TEMPERATURE_KEY]).toBe(0.2);

    const result2 = await mutator(context, new Error('fail'), 2);
    expect(result2).toBeDefined();
    expect(result2!.conversation.getSnapshot().metadata[RETRY_TEMPERATURE_KEY]).toBe(0.4);
  });

  it('respects custom increment', async () => {
    const mutator = createTemperatureEscalationMutator({ increment: 0.1 });
    const context = makeContext();

    const result = await mutator(context, new Error('fail'), 1);
    expect(result).toBeDefined();
    expect(result!.conversation.getSnapshot().metadata[RETRY_TEMPERATURE_KEY]).toBe(0.1);
  });

  it('caps temperature at max', async () => {
    const mutator = createTemperatureEscalationMutator({ increment: 0.5, max: 0.8 });
    const context = makeContext();

    const result1 = await mutator(context, new Error('fail'), 1);
    expect(result1!.conversation.getSnapshot().metadata[RETRY_TEMPERATURE_KEY]).toBe(0.5);

    const result2 = await mutator(context, new Error('fail'), 2);
    expect(result2!.conversation.getSnapshot().metadata[RETRY_TEMPERATURE_KEY]).toBe(0.8);

    const result3 = await mutator(context, new Error('fail'), 3);
    expect(result3!.conversation.getSnapshot().metadata[RETRY_TEMPERATURE_KEY]).toBe(0.8);
  });

  it('defaults max to 1.0', async () => {
    const mutator = createTemperatureEscalationMutator({ increment: 0.6 });
    const context = makeContext();

    const result1 = await mutator(context, new Error('fail'), 1);
    expect(result1!.conversation.getSnapshot().metadata[RETRY_TEMPERATURE_KEY]).toBe(0.6);

    const result2 = await mutator(context, new Error('fail'), 2);
    expect(result2!.conversation.getSnapshot().metadata[RETRY_TEMPERATURE_KEY]).toBe(1.0);
  });

  it('does not mutate the original conversation', async () => {
    const mutator = createTemperatureEscalationMutator();
    const context = makeContext();
    const originalMetadata = { ...context.conversation.getSnapshot().metadata };
    await mutator(context, new Error('fail'), 1);
    expect(context.conversation.getSnapshot().metadata).toEqual(originalMetadata);
  });
});
