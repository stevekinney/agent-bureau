import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { stopWhen } from '../../src/conditions';
import { createRun } from '../../src/create-run';
import { createStore } from '../../src/store';
import type { StoreActionEvent } from '../../src/store/events';
import type { Action } from '../../src/store/types';
import { createMockGenerate } from '../../src/test';
import type { GenerateResponse } from '../../src/types';

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

describe('Store events (EventTarget)', () => {
  it('addEventListener("action", listener) receives Actions from runs', async () => {
    const store = createStore();
    const received: Action[] = [];

    store.addEventListener('action', (event) => {
      received.push(event.action);
    });

    const activeRun = createActiveRun();
    store.register(activeRun);
    await activeRun.result;

    expect(received.length).toBeGreaterThan(0);
    for (const action of received) {
      expect(action).toHaveProperty('type');
      expect(action).toHaveProperty('runId');
      expect(typeof action.sequence).toBe('number');
    }

    store.dispose();
  });

  it('on("action") returns Observable that emits StoreActionEvents', async () => {
    const store = createStore();
    const received: Action[] = [];

    const observable = store.on('action');
    const subscription = observable.subscribe((event) => {
      received.push(event.action);
    });

    const activeRun = createActiveRun();
    store.register(activeRun);
    await activeRun.result;

    expect(received.length).toBeGreaterThan(0);
    subscription.unsubscribe();
    store.dispose();
  });

  it('once("action", listener) fires exactly once', async () => {
    const store = createStore();
    const received: Action[] = [];

    store.once('action', (event) => {
      received.push(event.action);
    });

    const activeRun = createActiveRun();
    store.register(activeRun);
    await activeRun.result;

    expect(received.length).toBe(1);
    store.dispose();
  });

  it('toObservable() emits all event types', async () => {
    const store = createStore();
    const types: string[] = [];

    const observable = store.toObservable();
    const subscription = observable.subscribe((event) => {
      types.push(event.type);
    });

    const activeRun = createActiveRun();
    store.register(activeRun);
    await activeRun.result;

    expect(types).toContain('action');
    expect(types).toContain('run.registered');
    subscription.unsubscribe();
    store.dispose();
  });

  it('events("action") returns async iterator', async () => {
    const store = createStore();
    const received: Action[] = [];

    // Set up the iterator before events fire so it can buffer them
    const iterator = store.events('action');

    const activeRun = createActiveRun();
    const runId = store.register(activeRun);
    await activeRun.result;

    // Complete the emitter so the iterator terminates
    store.complete();

    for await (const event of iterator) {
      received.push(event.action);
    }

    expect(received.length).toBeGreaterThan(0);
    for (const action of received) {
      expect(action.runId).toBe(runId);
    }
  });

  it('subscribe("action", observer) returns Subscription with .unsubscribe()', async () => {
    const store = createStore();
    const received: Action[] = [];

    const subscription = store.subscribe('action', (event) => {
      received.push(event.action);
    });

    expect(subscription).toHaveProperty('unsubscribe');
    expect(typeof subscription.unsubscribe).toBe('function');

    const activeRun = createActiveRun();
    store.register(activeRun);
    await activeRun.result;

    const countBefore = received.length;
    expect(countBefore).toBeGreaterThan(0);

    subscription.unsubscribe();

    const activeRun2 = createActiveRun();
    store.register(activeRun2);
    await activeRun2.result;

    expect(received.length).toBe(countBefore);
    store.dispose();
  });

  it('"run.registered" fires on register()', async () => {
    const store = createStore();
    const registered: string[] = [];

    store.addEventListener('run.registered', (event) => {
      registered.push(event.runId);
    });

    const activeRun = createActiveRun();
    const runId = store.register(activeRun);

    expect(registered).toContain(runId);

    await activeRun.result;
    store.dispose();
  });

  it('"run.removed" fires on removeRun()', async () => {
    const store = createStore();
    const removed: string[] = [];

    store.addEventListener('run.removed', (event) => {
      removed.push(event.runId);
    });

    const activeRun = createActiveRun();
    const runId = store.register(activeRun);
    await activeRun.result;

    store.removeRun(runId);

    expect(removed).toContain(runId);
    store.dispose();
  });

  it('complete() signals completion; completed flips to true', () => {
    const store = createStore();

    expect(store.completed).toBe(false);
    store.complete();
    expect(store.completed).toBe(true);
  });

  it('legacy subscribe(listener) still works alongside EventTarget subscribers', async () => {
    const store = createStore();
    const legacyActions: Action[] = [];
    const eventTargetActions: Action[] = [];

    store.subscribe((_state, action) => {
      legacyActions.push(action);
    });

    store.addEventListener('action', (event) => {
      eventTargetActions.push(event.action);
    });

    const activeRun = createActiveRun();
    store.register(activeRun);
    await activeRun.result;

    expect(legacyActions.length).toBeGreaterThan(0);
    expect(eventTargetActions.length).toBe(legacyActions.length);

    for (let i = 0; i < legacyActions.length; i++) {
      expect(legacyActions[i].type).toBe(eventTargetActions[i].type);
      expect(legacyActions[i].sequence).toBe(eventTargetActions[i].sequence);
    }

    store.dispose();
  });

  it('multiple concurrent runs interleave correctly through EventTarget', async () => {
    const store = createStore();
    const events: StoreActionEvent[] = [];

    store.addEventListener('action', (event) => {
      events.push(event);
    });

    const activeRunA = createActiveRun([textResponse('A')]);
    const activeRunB = createActiveRun([textResponse('B')]);

    const idA = store.register(activeRunA);
    const idB = store.register(activeRunB);

    await Promise.all([activeRunA.result, activeRunB.result]);

    const runAEvents = events.filter((e) => e.action.runId === idA);
    const runBEvents = events.filter((e) => e.action.runId === idB);

    expect(runAEvents.length).toBeGreaterThan(0);
    expect(runBEvents.length).toBeGreaterThan(0);
    expect(events.length).toBe(runAEvents.length + runBEvents.length);

    store.dispose();
  });
});
