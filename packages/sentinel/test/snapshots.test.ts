import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createRun, type GenerateResponse, stopWhen, type TokenUsage } from 'operative';
import { createMockGenerate } from 'operative/test';
import { z } from 'zod';

import { createStore } from '../src/store';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function textResponse(content: string, usage?: TokenUsage): GenerateResponse {
  return { content, toolCalls: [], ...(usage ? { usage } : {}) };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
  usage?: TokenUsage,
): GenerateResponse {
  return { content, toolCalls, ...(usage ? { usage } : {}) };
}

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

describe('snapshots', () => {
  it('captures a conversation snapshot on each step.completed event', async () => {
    const store = createStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('What is the weather in Denver?');

    const generate = createMockGenerate([textResponse('It is sunny.')]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    await activeRun.result;

    const runState = store.getRun(runId);
    expect(runState).toBeDefined();
    // 1 step.completed + 1 run.completed = 2 snapshots
    expect(runState!.snapshots).toHaveLength(2);
  });

  it('captures a conversation snapshot on run.completed event', async () => {
    const store = createStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');

    const generate = createMockGenerate([textResponse('Hi there.')]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    await activeRun.result;

    const runState = store.getRun(runId);
    expect(runState).toBeDefined();

    // The last snapshot is the run.completed snapshot
    const snapshots = runState!.snapshots;
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    // Verify the final snapshot exists and has the ConversationSnapshot shape
    const finalSnapshot = snapshots[snapshots.length - 1];
    expect(finalSnapshot).toBeDefined();
    expect(finalSnapshot).toHaveProperty('root');
    expect(finalSnapshot).toHaveProperty('currentPath');
  });

  it('accumulates snapshots in order across a multi-step run', async () => {
    const store = createStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Weather in Denver and Seattle?');

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('Denver is 72, Seattle is 72.'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    await activeRun.result;

    const runState = store.getRun(runId);
    expect(runState).toBeDefined();
    // 3 step.completed events + 1 run.completed event = 4 snapshots
    expect(runState!.snapshots).toHaveLength(4);
    expect(runState!.steps).toHaveLength(3);

    // Each snapshot should have the ConversationSnapshot shape
    for (const snapshot of runState!.snapshots) {
      expect(snapshot).toHaveProperty('root');
      expect(snapshot).toHaveProperty('currentPath');
    }

    // Later snapshots should have deeper paths as the conversation grows
    const pathLengths = runState!.snapshots.map((snapshot) => snapshot.currentPath.length);
    for (let i = 1; i < pathLengths.length; i++) {
      expect(pathLengths[i]).toBeGreaterThanOrEqual(pathLengths[i - 1]);
    }
  });

  it('accumulates token usage from step.generated events', async () => {
    const store = createStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Weather?');

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')], '', {
        prompt: 10,
        completion: 5,
        total: 15,
      }),
      textResponse('It is 72 degrees.', { prompt: 20, completion: 10, total: 30 }),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    await activeRun.result;

    const runState = store.getRun(runId);
    expect(runState).toBeDefined();
    expect(runState!.usage).toEqual({
      prompt: 30,
      completion: 15,
      total: 45,
    });
  });

  it('missing usage in a step does not break accumulation', async () => {
    const store = createStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Weather?');

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')], '', {
        prompt: 10,
        completion: 5,
        total: 15,
      }),
      // This step has no usage
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('Both are warm.', { prompt: 30, completion: 15, total: 45 }),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    await activeRun.result;

    const runState = store.getRun(runId);
    expect(runState).toBeDefined();
    // Only the first and third steps contribute usage; the middle step is skipped
    expect(runState!.usage).toEqual({
      prompt: 40,
      completion: 20,
      total: 60,
    });
  });

  it('caps per-run snapshots to maxSnapshots, keeping the most recent', async () => {
    const store = createStore({ maxSnapshots: 2 });
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Weather in Denver and Seattle?');

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('Denver is 72, Seattle is 72.'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    await activeRun.result;

    const runState = store.getRun(runId);
    expect(runState).toBeDefined();
    // Without maxSnapshots this would be 4 (3 step.completed + 1 run.completed)
    expect(runState!.snapshots).toHaveLength(2);

    // The kept snapshots should have valid ConversationSnapshot shape
    for (const snapshot of runState!.snapshots) {
      expect(snapshot).toHaveProperty('root');
      expect(snapshot).toHaveProperty('currentPath');
    }
  });

  it('does not cap snapshots when maxSnapshots is not set', async () => {
    const store = createStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('Weather in Denver and Seattle?');

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('Denver is 72, Seattle is 72.'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    await activeRun.result;

    const runState = store.getRun(runId);
    expect(runState).toBeDefined();
    // 3 step.completed + 1 run.completed = 4 snapshots when uncapped
    expect(runState!.snapshots).toHaveLength(4);
  });
});
