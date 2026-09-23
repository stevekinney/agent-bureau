import { TypedEventTarget } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentSession } from '../agent-session';
import {
  SessionCancelEvent,
  SessionForkEvent,
  SessionQueryEvent,
  SessionRecoverEvent,
  SessionSignalEvent,
  SessionSleepEvent,
  SessionUpdateEvent,
  type OperativeEventMap,
} from '../events';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle } from './session-handle';
import { collectEvents, createTestRunOptions, fixtureRuntime } from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('session verb event dispatch (C3 completeness rule)', () => {
  it('recover() dispatches SessionRecoverEvent on the emitter', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('recover-event-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });

    const events = collectEvents(emitter, 'session.recover');
    h.recover();

    expect(events).toHaveLength(1);
    const e = events[0];
    if (!(e instanceof SessionRecoverEvent))
      throw new TypeError(`Expected ${SessionRecoverEvent.type} event`);
    expect(e.type).toBe('session.recover');
    expect(e.sessionId).toBe('recover-event-session');
  });

  it('cancel() dispatches SessionCancelEvent on the emitter', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('cancel-event-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });

    const events = collectEvents(emitter, 'session.cancel');
    await h.cancel();

    expect(events).toHaveLength(1);
    const e = events[0];
    if (!(e instanceof SessionCancelEvent))
      throw new TypeError(`Expected ${SessionCancelEvent.type} event`);
    expect(e.type).toBe('session.cancel');
    expect(e.sessionId).toBe('cancel-event-session');
  });

  it('fork() dispatches SessionForkEvent on the emitter after persisting', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('fork-event-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });
    await h.getSession(); // ensure source session exists

    const events = collectEvents(emitter, 'session.fork');
    const forked = await h.fork({ throughRun: 0 });

    expect(events).toHaveLength(1);
    const e = events[0];
    if (!(e instanceof SessionForkEvent))
      throw new TypeError(`Expected ${SessionForkEvent.type} event`);
    expect(e.type).toBe('session.fork');
    expect(e.sourceSessionId).toBe('fork-event-session');
    expect(e.forkedSessionId).toBe(forked.id);
    expect(e.throughRun).toBe(0);
  });

  it('sleep() dispatches SessionSleepEvent before sleeping', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('sleep-event-session', {
      store,
      agentName: 'agent',
      emitter,
      runOptions: createTestRunOptions(),
    });

    const events = collectEvents(emitter, 'session.sleep');
    await h.sleep(5); // 5ms so the test stays fast

    expect(events).toHaveLength(1);
    const e = events[0];
    if (!(e instanceof SessionSleepEvent))
      throw new TypeError(`Expected ${SessionSleepEvent.type} event`);
    expect(e.type).toBe('session.sleep');
    expect(e.sessionId).toBe('sleep-event-session');
    expect(e.durationMs).toBe(5);
  });

  it('signal() dispatches SessionSignalEvent after resolving the run id', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'signal-event-session',
      runs: [
        {
          runId: 'signal-event-session:0',
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const fakeEngine = createSessionEngine({
      signal: mock(async () => {}),
    });

    const h = createSessionHandle('signal-event-session', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      emitter,
      runOptions: createTestRunOptions(),
    });

    const events = collectEvents(emitter, 'session.signal');
    await h.signal('approve', { ok: true });

    expect(events).toHaveLength(1);
    const e = events[0];
    if (!(e instanceof SessionSignalEvent))
      throw new TypeError(`Expected ${SessionSignalEvent.type} event`);
    expect(e.type).toBe('session.signal');
    expect(e.sessionId).toBe('signal-event-session');
    expect(e.runId).toBe('signal-event-session:0');
    expect(e.signalName).toBe('approve');
    expect(e.payload).toEqual({ ok: true });
  });

  it('update() dispatches SessionUpdateEvent after resolving the run id', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'update-event-session',
      runs: [
        {
          runId: 'update-event-session:0',
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const fakeEngine = createSessionEngine({
      update: mock(async () => ({ ok: true })),
    });

    const h = createSessionHandle('update-event-session', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      emitter,
      runOptions: createTestRunOptions(),
    });

    const events = collectEvents(emitter, 'session.update');
    await h.update('params', { temp: 0.7 });

    expect(events).toHaveLength(1);
    const e = events[0];
    if (!(e instanceof SessionUpdateEvent))
      throw new TypeError(`Expected ${SessionUpdateEvent.type} event`);
    expect(e.type).toBe('session.update');
    expect(e.sessionId).toBe('update-event-session');
    expect(e.runId).toBe('update-event-session:0');
    expect(e.updateName).toBe('params');
    expect(e.payload).toEqual({ temp: 0.7 });
  });

  it('query() dispatches SessionQueryEvent after resolving the last run', async () => {
    const emitter = new TypedEventTarget<OperativeEventMap>();
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: 'query-event-session',
      runs: [
        {
          runId: 'query-event-session:0',
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
      ],
    });
    await store.save(session);

    const fakeEngine = createSessionEngine({
      query: mock(async () => ({ step: 3 })),
    });

    const h = createSessionHandle('query-event-session', {
      store,
      agentName: 'agent',
      engine: fakeEngine,
      emitter,
      runOptions: createTestRunOptions(),
    });

    const events = collectEvents(emitter, 'session.query');
    await h.query('status', { detail: 'full' });

    expect(events).toHaveLength(1);
    const e = events[0];
    if (!(e instanceof SessionQueryEvent))
      throw new TypeError(`Expected ${SessionQueryEvent.type} event`);
    expect(e.type).toBe('session.query');
    expect(e.sessionId).toBe('query-event-session');
    expect(e.queryName).toBe('status');
    expect(e.input).toEqual({ detail: 'full' });
  });

  it('handle.emitter is accessible for subscribing to session verb events', () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const h = createSessionHandle('emitter-access-session', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(),
    });

    // The emitter is accessible without injecting one.
    expect(h.emitter).toBeDefined();
    expect(typeof h.emitter.addEventListener).toBe('function');
  });
});
