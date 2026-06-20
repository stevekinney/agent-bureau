import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { stopWhen } from '../../src/conditions';
import { createRun } from '../../src/create-run';
import { createStore } from '../../src/store';
import { createMockGenerate } from '../../src/test';
import type { GenerateResponse } from '../../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

describe('action log behavior', () => {
  it('every operative event becomes an action with sequence, runId, type, detail, and timestamp', async () => {
    const store = createStore();
    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();
    conversation.appendUserMessage('hello');

    const generate = createMockGenerate([textResponse('hi there')]);
    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    await activeRun.result;

    const actions = store.getState().actions;
    expect(actions.length).toBeGreaterThan(0);

    for (const action of actions) {
      expect(action).toHaveProperty('sequence');
      expect(action).toHaveProperty('runId');
      expect(action).toHaveProperty('type');
      expect(action).toHaveProperty('detail');
      expect(action).toHaveProperty('timestamp');

      expect(typeof action.sequence).toBe('number');
      expect(action.runId).toBe(runId);
      expect(typeof action.type).toBe('string');
      expect(typeof action.timestamp).toBe('number');
    }

    const types = actions.map((action) => action.type);
    expect(types).toContain('run.started');
    expect(types).toContain('step.started');
    expect(types).toContain('step.generated');
    expect(types).toContain('step.completed');
    expect(types).toContain('run.completed');

    store.dispose();
  });

  it('actions have globally unique, monotonically increasing sequence numbers', async () => {
    const store = createStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('What is the weather?');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('It is 72 degrees in Denver.'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    store.register(activeRun);
    await activeRun.result;

    const actions = store.getState().actions;
    expect(actions.length).toBeGreaterThan(1);

    const sequences = actions.map((action) => action.sequence);
    const uniqueSequences = new Set(sequences);
    expect(uniqueSequences.size).toBe(sequences.length);

    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
    }

    store.dispose();
  });

  it('per-run actions contain only that run events', async () => {
    const store = createStore();

    const toolboxA = createTestToolbox([]);
    const conversationA = new Conversation();
    conversationA.appendUserMessage('first run');
    const generateA = createMockGenerate([textResponse('response A')]);
    const activeRunA = createRun({
      generate: generateA,
      toolbox: toolboxA,
      conversation: conversationA,
      stopWhen: stopWhen.noToolCalls(),
    });
    const runIdA = store.register(activeRunA);

    const toolboxB = createTestToolbox([]);
    const conversationB = new Conversation();
    conversationB.appendUserMessage('second run');
    const generateB = createMockGenerate([textResponse('response B')]);
    const activeRunB = createRun({
      generate: generateB,
      toolbox: toolboxB,
      conversation: conversationB,
      stopWhen: stopWhen.noToolCalls(),
    });
    const runIdB = store.register(activeRunB);

    await Promise.all([activeRunA.result, activeRunB.result]);

    const runStateA = store.getRun(runIdA)!;
    const runStateB = store.getRun(runIdB)!;

    expect(runStateA).toBeDefined();
    expect(runStateB).toBeDefined();

    expect(runStateA.actions.length).toBeGreaterThan(0);
    expect(runStateB.actions.length).toBeGreaterThan(0);

    for (const action of runStateA.actions) {
      expect(action.runId).toBe(runIdA);
    }

    for (const action of runStateB.actions) {
      expect(action.runId).toBe(runIdB);
    }

    store.dispose();
  });

  it('global actions interleave events from multiple concurrent runs in order', async () => {
    const store = createStore();

    const toolboxA = createTestToolbox([]);
    const conversationA = new Conversation();
    conversationA.appendUserMessage('run A');
    const generateA = createMockGenerate([textResponse('A done')]);
    const activeRunA = createRun({
      generate: generateA,
      toolbox: toolboxA,
      conversation: conversationA,
      stopWhen: stopWhen.noToolCalls(),
    });
    const runIdA = store.register(activeRunA);

    const toolboxB = createTestToolbox([]);
    const conversationB = new Conversation();
    conversationB.appendUserMessage('run B');
    const generateB = createMockGenerate([textResponse('B done')]);
    const activeRunB = createRun({
      generate: generateB,
      toolbox: toolboxB,
      conversation: conversationB,
      stopWhen: stopWhen.noToolCalls(),
    });
    const runIdB = store.register(activeRunB);

    await Promise.all([activeRunA.result, activeRunB.result]);

    const globalActions = store.getState().actions;
    expect(globalActions.length).toBeGreaterThan(0);

    const runIdsInGlobal = new Set(globalActions.map((action) => action.runId));
    expect(runIdsInGlobal.has(runIdA)).toBe(true);
    expect(runIdsInGlobal.has(runIdB)).toBe(true);

    // Sequence numbers must be strictly increasing across the global log
    for (let i = 1; i < globalActions.length; i++) {
      expect(globalActions[i].sequence).toBeGreaterThan(globalActions[i - 1].sequence);
    }

    // The sum of per-run actions should equal the global count
    const runStateA = store.getRun(runIdA)!;
    const runStateB = store.getRun(runIdB)!;
    expect(runStateA.actions.length + runStateB.actions.length).toBe(globalActions.length);

    store.dispose();
  });

  it('forwarded toolbox events appear as toolbox.* actions', async () => {
    const store = createStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('What is the weather in Denver?');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('It is 72 degrees.'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    await activeRun.result;

    const actions = store.getState().actions;
    const toolboxActions = actions.filter((action) => action.type.startsWith('toolbox.'));

    expect(toolboxActions.length).toBeGreaterThan(0);

    const toolboxTypes = toolboxActions.map((action) => action.type);
    expect(toolboxTypes).toContain('toolbox.call');
    expect(toolboxTypes).toContain('toolbox.complete');

    // All toolbox actions should belong to the registered run
    for (const action of toolboxActions) {
      expect(action.runId).toBe(runId);
    }

    // Per-run state should include the toolbox actions too
    const runState = store.getRun(runId)!;
    const perRunToolboxActions = runState.actions.filter((action) =>
      action.type.startsWith('toolbox.'),
    );
    expect(perRunToolboxActions.length).toBe(toolboxActions.length);

    store.dispose();
  });

  it('forwarded conversation events appear as conversation.* actions', async () => {
    const store = createStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('What is the weather?');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('Done.'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    const runId = store.register(activeRun);
    await activeRun.result;

    const actions = store.getState().actions;
    const conversationActions = actions.filter((action) => action.type.startsWith('conversation.'));

    expect(conversationActions.length).toBeGreaterThan(0);

    const conversationTypes = conversationActions.map((action) => action.type);
    expect(conversationTypes).toContain('conversation.messages.appended');

    // All conversation actions should belong to the registered run
    for (const action of conversationActions) {
      expect(action.runId).toBe(runId);
    }

    // Per-run state should include the conversation actions
    const runState = store.getRun(runId)!;
    const perRunConversationActions = runState.actions.filter((action) =>
      action.type.startsWith('conversation.'),
    );
    expect(perRunConversationActions.length).toBe(conversationActions.length);

    store.dispose();
  });

  it('caps global actions to maxActions with FIFO eviction', async () => {
    const store = createStore({ maxActions: 5 });
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('What is the weather in Denver?');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('It is 72 degrees in Denver.'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    store.register(activeRun);
    await activeRun.result;

    const actions = store.getState().actions;
    expect(actions.length).toBeLessThanOrEqual(5);

    // Sequences should still be monotonically increasing (oldest were evicted)
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i].sequence).toBeGreaterThan(actions[i - 1].sequence);
    }

    store.dispose();
  });

  it('does not cap actions when maxActions is not set', async () => {
    const store = createStore();
    const toolbox = createTestToolbox([weatherTool]);
    const conversation = new Conversation();
    conversation.appendUserMessage('What is the weather in Denver?');

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
      textResponse('It is 72 degrees in Denver.'),
    ]);

    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
    });

    store.register(activeRun);
    await activeRun.result;

    const actions = store.getState().actions;
    // Without maxActions, all actions should remain (more than 5 for a tool-call run)
    expect(actions.length).toBeGreaterThan(5);

    store.dispose();
  });
});
