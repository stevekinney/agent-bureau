import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool, createToolbox } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { Conversation } from 'conversationalist';
import { createRun, stopWhen, type GenerateResponse } from 'operative';
import { createMockGenerate } from 'operative/test';
import { createTestStore } from 'sentinel/test';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get the current weather for a location',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location, unit: 'F' }),
});

function textResponse(content: string, usage?: GenerateResponse['usage']): GenerateResponse {
  return { content, toolCalls: [], ...(usage ? { usage } : {}) };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
  usage?: GenerateResponse['usage'],
): GenerateResponse {
  return { content, toolCalls, ...(usage ? { usage } : {}) };
}

describe('sentinel integration: full operative loop tracked by store', () => {
  it('tracks a complete run with correct status, steps, and actions', async () => {
    const { store, waitForRun } = createTestStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('What is the weather in Denver?');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('The weather in Denver is 72F.'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    const finalRun = await waitForRun(runId);

    expect(finalRun.status).toBe('completed');
    expect(finalRun.steps).toHaveLength(2);
    expect(finalRun.finishReason).toBe('stop-condition');
    expect(finalRun.actions.length).toBeGreaterThan(0);

    const actionTypes = finalRun.actions.map((a) => a.type);
    expect(actionTypes).toContain('run.started');
    expect(actionTypes).toContain('step.completed');
    expect(actionTypes).toContain('run.completed');
  });

  it('captures snapshot count matching steps + 1 in multi-step run', async () => {
    const { store, waitForRun } = createTestStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Get weather then summarize');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Seattle' } }]),
      textResponse('Done.'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    const finalRun = await waitForRun(runId);

    expect(finalRun.steps).toHaveLength(3);
    // 3 step.completed snapshots + 1 run.completed snapshot = 4
    expect(finalRun.snapshots).toHaveLength(4);
  });

  it('accumulates usage across steps', async () => {
    const { store, waitForRun } = createTestStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Weather?');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }], '', {
        prompt: 10,
        completion: 5,
        total: 15,
      }),
      textResponse('72F.', { prompt: 20, completion: 10, total: 30 }),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    const finalRun = await waitForRun(runId);

    expect(finalRun.usage.prompt).toBe(30);
    expect(finalRun.usage.completion).toBe(15);
    expect(finalRun.usage.total).toBe(45);
  });

  it('tracks multiple concurrent runs independently', async () => {
    const { store, waitForRun } = createTestStore();

    const toolbox1 = createTestToolbox([weatherTool]);
    const conversation1 = new Conversation();
    conversation1.appendUserMessage('Run 1');
    const generate1 = createMockGenerate([textResponse('Result 1')]);
    const run1 = createRun({
      generate: generate1,
      toolbox: toolbox1,
      conversation: conversation1,
      stopWhen: stopWhen.noToolCalls(),
    });

    const toolbox2 = createTestToolbox([weatherTool]);
    const conversation2 = new Conversation();
    conversation2.appendUserMessage('Run 2');
    const generate2 = createMockGenerate([textResponse('Result 2')]);
    const run2 = createRun({
      generate: generate2,
      toolbox: toolbox2,
      conversation: conversation2,
      stopWhen: stopWhen.noToolCalls(),
    });

    const id1 = store.register(run1);
    const id2 = store.register(run2);

    const [final1, final2] = await Promise.all([waitForRun(id1), waitForRun(id2)]);

    expect(final1.status).toBe('completed');
    expect(final2.status).toBe('completed');
    expect(final1.id).not.toBe(final2.id);

    // Each run has its own actions
    const run1ActionRunIds = new Set(final1.actions.map((a) => a.runId));
    const run2ActionRunIds = new Set(final2.actions.map((a) => a.runId));
    expect(run1ActionRunIds.size).toBe(1);
    expect(run2ActionRunIds.size).toBe(1);
    expect([...run1ActionRunIds][0]).toBe(id1);
    expect([...run2ActionRunIds][0]).toBe(id2);

    // Global actions contain both
    const globalActions = store.getState().actions;
    const globalRunIds = new Set(globalActions.map((a) => a.runId));
    expect(globalRunIds.has(id1)).toBe(true);
    expect(globalRunIds.has(id2)).toBe(true);
  });

  it('toolbox events appear as toolbox.* actions', async () => {
    const { store, waitForRun } = createTestStore();
    const toolbox = createToolbox([weatherTool]) as import('armorer').Toolbox;
    const conversation = new Conversation();
    conversation.appendUserMessage('Weather?');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('72F.'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    const finalRun = await waitForRun(runId);

    const toolboxActions = finalRun.actions.filter((a) => a.type.startsWith('toolbox.'));
    expect(toolboxActions.length).toBeGreaterThan(0);
  });

  it('error run records run.error action and error status', async () => {
    const { store } = createTestStore();
    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Will fail');

    const failingGenerate = createMockGenerate([]);

    const activeRun = createRun({
      generate: failingGenerate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);

    // The run will reject because createMockGenerate with [] throws on first call
    await activeRun.result.catch(() => {});

    // Give event processing a tick
    await new Promise((resolve) => setTimeout(resolve, 50));

    const finalRun = store.getRun(runId);
    expect(finalRun).toBeDefined();
    expect(finalRun!.status).toBe('error');
    expect(finalRun!.error).toBeDefined();

    const actionTypes = finalRun!.actions.map((a) => a.type);
    expect(actionTypes).toContain('run.error');
  });
});
