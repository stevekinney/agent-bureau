import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { LiveFrameBroker } from '../live-events';
import type { Bureau, ServerFrame } from '../types';
import { createEventsRoutes } from './events';

function createBureauStub(overrides: Partial<Bureau> = {}): Bureau {
  return {
    store: {} as Bureau['store'],
    memory: undefined,
    scheduler: undefined,
    ready: true,
    createRun: async () => {
      throw new Error('not implemented');
    },
    listRuns: () => [],
    getRun: () => undefined,
    abortRun: () => {
      throw new Error('not implemented');
    },
    deleteRun: () => {},
    listSessions: async () => [],
    getSession: async () => undefined,
    deleteSession: async () => {},
    getConfiguration: () => ({
      provider: undefined,
      providers: [],
      maximumSteps: 10,
      systemPrompt: undefined,
      tools: [],
    }),
    getTools: () => [],
    subscribeLiveFrames: () => () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    on: () => ({ subscribe: () => ({ closed: false, unsubscribe: () => {} }) }),
    once: () => {},
    subscribe: () => ({ closed: false, unsubscribe: () => {} }),
    toObservable: () => ({ subscribe: () => ({ closed: false, unsubscribe: () => {} }) }),
    events: async function* () {},
    complete: () => {},
    completed: false,
    signal: new AbortController().signal,
    dispose: () => {},
    sessionStore: undefined,
    kv: undefined,
    ...overrides,
  } as unknown as Bureau;
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = await reader.read();
  if (!chunk.value) {
    return '';
  }

  return new TextDecoder().decode(chunk.value);
}

describe('events routes', () => {
  it('streams run frames over server-sent events', async () => {
    const broker = new LiveFrameBroker();
    const app = new Hono();
    app.route('/api/v1/events', createEventsRoutes(createBureauStub(), broker));

    const response = await app.request('/api/v1/events?runId=run-1');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) {
      return;
    }

    await readChunk(reader);

    const frame: ServerFrame = {
      type: 'event',
      runId: 'run-1',
      event: 'run.completed',
      detail: { content: 'Done.' },
      sequence: 1,
      timestamp: Date.now(),
    };
    broker.broadcast(frame);

    const payload = await readChunk(reader);
    expect(payload).toContain('"runId":"run-1"');
    expect(payload).toContain('"event":"run.completed"');

    await reader.cancel();
  });

  it('sets SSE hardening headers: no-cache, no-transform', async () => {
    const broker = new LiveFrameBroker();
    const app = new Hono();
    app.route('/api/v1/events', createEventsRoutes(createBureauStub(), broker));

    const response = await app.request('/api/v1/events?runId=run-1');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    await response.body?.cancel();
  });

  it('sets X-Accel-Buffering: no to disable nginx proxy buffering', async () => {
    const broker = new LiveFrameBroker();
    const app = new Hono();
    app.route('/api/v1/events', createEventsRoutes(createBureauStub(), broker));

    const response = await app.request('/api/v1/events?runId=run-1');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    await response.body?.cancel();
  });

  it('sets X-Content-Type-Options: nosniff to prevent MIME sniffing', async () => {
    const broker = new LiveFrameBroker();
    const app = new Hono();
    app.route('/api/v1/events', createEventsRoutes(createBureauStub(), broker));

    const response = await app.request('/api/v1/events?runId=run-1');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await response.body?.cancel();
  });

  it('includes scheduler state frames when requested', async () => {
    const broker = new LiveFrameBroker();
    const bureau = createBureauStub({
      scheduler: {
        getState: () => ({
          activeTask: undefined,
          queued: { immediate: [], scheduled: [], background: [], ambient: [] },
          completedCount: 0,
          preemptedCount: 0,
          idle: true,
        }),
      } as unknown as Bureau['scheduler'],
    });

    const app = new Hono();
    app.route('/api/v1/events', createEventsRoutes(bureau, broker));

    const response = await app.request('/api/v1/events?scheduler=true');
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) {
      return;
    }

    const payload = await readChunk(reader);
    expect(payload).toContain('scheduler.state');

    await reader.cancel();
  });
});
