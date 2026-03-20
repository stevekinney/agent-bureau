import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createRun, type GenerateResponse, stopWhen } from 'operative';
import { createMockGenerate } from 'operative/test';
import { z } from 'zod';

import { createStore } from '../src/store';
import type { Action, StoreState } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function createActiveRun(responses: GenerateResponse[] = [textResponse('response')]) {
  const toolbox = createTestToolbox([weatherTool]);
  const conversation = new Conversation();
  conversation.appendUserMessage('test');
  const generate = createMockGenerate(responses);
  return createRun({ generate, toolbox, conversation, stopWhen: stopWhen.noToolCalls() });
}

describe('createStore', () => {
  it('returns a store with empty state', () => {
    const store = createStore();
    const state = store.getState();

    expect(state.runs.size).toBe(0);
    expect(state.actions).toEqual([]);
  });

  it('register returns a run id and adds it to state', async () => {
    const store = createStore();
    const activeRun = createActiveRun();

    const id = store.register(activeRun);

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(store.getState().runs.has(id)).toBe(true);

    await activeRun.result;
    store.dispose();
  });

  it('register with a custom id uses that id', async () => {
    const store = createStore();
    const activeRun = createActiveRun();

    const id = store.register(activeRun, 'my-custom-id');

    expect(id).toBe('my-custom-id');
    expect(store.getState().runs.has('my-custom-id')).toBe(true);

    await activeRun.result;
    store.dispose();
  });

  it('register auto-generates sequential ids', async () => {
    const store = createStore();
    const activeRunA = createActiveRun();
    const activeRunB = createActiveRun();

    const idA = store.register(activeRunA);
    const idB = store.register(activeRunB);

    expect(idA).toBe('run-1');
    expect(idB).toBe('run-2');

    await Promise.all([activeRunA.result, activeRunB.result]);
    store.dispose();
  });

  it('getState returns runs map and global actions', async () => {
    const store = createStore();
    const activeRun = createActiveRun();
    const id = store.register(activeRun);

    await activeRun.result;

    const state = store.getState();

    expect(state.runs).toBeInstanceOf(Map);
    expect(state.runs.has(id)).toBe(true);
    expect(Array.isArray(state.actions)).toBe(true);
    expect(state.actions.length).toBeGreaterThan(0);

    store.dispose();
  });

  it('getRun returns a specific run state', async () => {
    const store = createStore();
    const activeRun = createActiveRun();
    const id = store.register(activeRun);

    const runState = store.getRun(id);

    expect(runState).toBeDefined();
    expect(runState!.id).toBe(id);
    expect(runState!.status).toBe('running');
    expect(runState!.activeRun).toBe(activeRun);

    await activeRun.result;
    store.dispose();
  });

  it('getRun returns undefined for unknown ids', () => {
    const store = createStore();

    expect(store.getRun('nonexistent')).toBeUndefined();
  });

  it('subscribe calls listener on every action with state and action', async () => {
    const store = createStore();
    const received: Array<{ state: StoreState; action: Action }> = [];

    store.subscribe((state, action) => {
      received.push({ state, action });
    });

    const activeRun = createActiveRun();
    const id = store.register(activeRun);

    await activeRun.result;

    expect(received.length).toBeGreaterThan(0);

    for (const entry of received) {
      expect(entry.state).toHaveProperty('runs');
      expect(entry.state).toHaveProperty('actions');
      expect(entry.action).toHaveProperty('type');
      expect(entry.action).toHaveProperty('runId');
      expect(entry.action.runId).toBe(id);
      expect(typeof entry.action.sequence).toBe('number');
      expect(typeof entry.action.timestamp).toBe('number');
    }

    store.dispose();
  });

  it('subscribe returns unsubscribe that stops notifications', async () => {
    const store = createStore();
    const received: Action[] = [];

    const unsubscribe = store.subscribe((_state, action) => {
      received.push(action);
    });

    const activeRunA = createActiveRun();
    store.register(activeRunA);
    await activeRunA.result;

    const countBeforeUnsubscribe = received.length;
    expect(countBeforeUnsubscribe).toBeGreaterThan(0);

    unsubscribe();

    const activeRunB = createActiveRun();
    store.register(activeRunB);
    await activeRunB.result;

    expect(received.length).toBe(countBeforeUnsubscribe);

    store.dispose();
  });

  it('multiple listeners all receive notifications', async () => {
    const store = createStore();
    const receivedA: Action[] = [];
    const receivedB: Action[] = [];

    store.subscribe((_state, action) => {
      receivedA.push(action);
    });

    store.subscribe((_state, action) => {
      receivedB.push(action);
    });

    const activeRun = createActiveRun();
    store.register(activeRun);

    await activeRun.result;

    expect(receivedA.length).toBeGreaterThan(0);
    expect(receivedB.length).toBeGreaterThan(0);
    expect(receivedA.length).toBe(receivedB.length);

    for (let i = 0; i < receivedA.length; i++) {
      expect(receivedA[i].type).toBe(receivedB[i].type);
      expect(receivedA[i].sequence).toBe(receivedB[i].sequence);
    }

    store.dispose();
  });

  it('dispose unsubscribes all runs and clears listeners', async () => {
    const store = createStore();
    const received: Action[] = [];

    store.subscribe((_state, action) => {
      received.push(action);
    });

    const activeRunA = createActiveRun();
    store.register(activeRunA);
    await activeRunA.result;

    const countBeforeDispose = received.length;
    expect(countBeforeDispose).toBeGreaterThan(0);

    store.dispose();

    const activeRunB = createActiveRun();
    store.register(activeRunB);
    await activeRunB.result;

    expect(received.length).toBe(countBeforeDispose);

    store.dispose();
  });

  it('multiple concurrent runs are tracked independently', async () => {
    const store = createStore();

    const activeRunA = createActiveRun([textResponse('response A')]);
    const activeRunB = createActiveRun([textResponse('response B')]);

    const idA = store.register(activeRunA);
    const idB = store.register(activeRunB);

    expect(idA).not.toBe(idB);

    await Promise.all([activeRunA.result, activeRunB.result]);

    const state = store.getState();
    expect(state.runs.size).toBe(2);

    const runA = store.getRun(idA);
    const runB = store.getRun(idB);

    expect(runA).toBeDefined();
    expect(runB).toBeDefined();
    expect(runA!.id).toBe(idA);
    expect(runB!.id).toBe(idB);
    expect(runA!.status).toBe('completed');
    expect(runB!.status).toBe('completed');

    // Each run should have its own actions
    expect(runA!.actions.length).toBeGreaterThan(0);
    expect(runB!.actions.length).toBeGreaterThan(0);

    // Actions for each run should reference the correct run id
    for (const action of runA!.actions) {
      expect(action.runId).toBe(idA);
    }

    for (const action of runB!.actions) {
      expect(action.runId).toBe(idB);
    }

    // Global actions should contain actions from both runs
    const allActions = state.actions;
    const runAActions = allActions.filter((a) => a.runId === idA);
    const runBActions = allActions.filter((a) => a.runId === idB);

    expect(runAActions.length).toBe(runA!.actions.length);
    expect(runBActions.length).toBe(runB!.actions.length);

    // Sequences should be globally unique and monotonically increasing
    for (let i = 1; i < allActions.length; i++) {
      expect(allActions[i].sequence).toBeGreaterThan(allActions[i - 1].sequence);
    }

    store.dispose();
  });
});
