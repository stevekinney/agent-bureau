import type {
  DurableEventEnvelope,
  DurableEventGap,
  DurableEventOwner,
  DurableEventPage,
} from '@lostgradient/operative/durable';
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import type { Bureau, EventHistoryUnsupportedOutcome } from '../types';
import { respondWithEventHistoryPage } from './event-history';

function createBureauStub(eventHistory: Bureau['eventHistory']): Bureau {
  return { eventHistory } as unknown as Bureau;
}

function buildApp(eventHistory: Bureau['eventHistory']) {
  const bureau = createBureauStub(eventHistory);
  const app = new Hono();
  app.get('/:id/events', (context) =>
    respondWithEventHistoryPage(context, bureau, { kind: 'run', id: context.req.param('id') }),
  );
  return app;
}

function createEnvelope(overrides: Partial<DurableEventEnvelope> = {}): DurableEventEnvelope {
  return {
    kind: 'run.completed',
    owner: { kind: 'run', id: 'run-1' },
    sequence: 1,
    cursor: '1',
    emittedAtMs: 1_000,
    payload: { content: 'done' },
    schemaVersion: 1,
    ...overrides,
  };
}

describe('GET .../:id/events — durable event history paging', () => {
  it('returns a 200 page for a normal DurableEventPage outcome', async () => {
    const page: DurableEventPage = { events: [createEnvelope()], hasMore: false, nextCursor: '1' };
    const app = buildApp(async () => page);

    const response = await app.request('/run-1/events');
    expect(response.status).toBe(200);
    const body = (await response.json()) as DurableEventPage;
    expect(body.events).toHaveLength(1);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBe('1');
  });

  it('forwards "since" and "limit" query params to bureau.eventHistory — a connection with no scopes header is privileged, so no "principal" is forwarded (AB-313)', async () => {
    let received:
      | {
          owner: DurableEventOwner;
          options?: { since?: string; limit?: number; principal?: string };
        }
      | undefined;
    const app = buildApp(async (owner, options) => {
      received = { owner, options };
      return { events: [], hasMore: false };
    });

    await app.request('/run-1/events?since=42&limit=10');

    expect(received?.owner).toEqual({ kind: 'run', id: 'run-1' });
    expect(received?.options).toEqual({ since: '42', limit: 10 });
  });

  it('forwards the resolved principal for a non-privileged (scoped) connection — AB-313', async () => {
    let received: { options?: { principal?: string } } | undefined;
    const app = buildApp(async (_owner, options) => {
      received = { options };
      return { events: [], hasMore: false };
    });

    await app.request('/run-1/events', {
      headers: { 'x-api-key-scopes': 'runs:read', 'x-auth-principal': 'alice' },
    });

    expect(received?.options?.principal).toBe('alice');
  });

  it('omits "principal" for a privileged (admin-key) connection — AB-313', async () => {
    let received: { options?: { principal?: string } } | undefined;
    const app = buildApp(async (_owner, options) => {
      received = { options };
      return { events: [], hasMore: false };
    });

    await app.request('/run-1/events', {
      headers: { 'x-api-key-scopes': '', 'x-auth-principal': 'alice' },
    });

    expect(received?.options?.principal).toBeUndefined();
  });

  it('maps a DurableEventGap outcome to 410 Gone', async () => {
    const gap: DurableEventGap = {
      outcome: 'gap',
      requestedCursor: '3',
      firstRetainedSequence: 10,
    };
    const app = buildApp(async () => gap);

    const response = await app.request('/run-1/events?since=3');
    expect(response.status).toBe(410);
    const body = (await response.json()) as DurableEventGap;
    expect(body).toEqual(gap);
  });

  it('maps an unsupported-capability outcome to 501', async () => {
    const outcome: EventHistoryUnsupportedOutcome = {
      outcome: 'unsupported-capability',
      reason: 'no-persistent-storage',
    };
    const app = buildApp(async () => outcome);

    const response = await app.request('/run-1/events');
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('maps a bureau validation error (its own "Durable event history:" prefix) to 400', async () => {
    const app = buildApp(async () => {
      throw new Error('Durable event history: invalid cursor "not-a-cursor".');
    });

    const response = await app.request('/run-1/events?since=not-a-cursor');
    expect(response.status).toBe(400);
  });

  it('maps a non-validation error (e.g. a storage I/O failure) to 500, without leaking its message', async () => {
    const app = buildApp(async () => {
      throw new Error('sqlite: disk I/O error');
    });

    const response = await app.request('/run-1/events');
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('sqlite');
    expect(text).not.toContain('disk I/O');
  });

  it('rejects a non-integer "limit" with 400 before ever calling bureau.eventHistory', async () => {
    let called = false;
    const app = buildApp(async () => {
      called = true;
      return { events: [], hasMore: false };
    });

    const response = await app.request('/run-1/events?limit=not-a-number');
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  it('rejects a zero "limit" with 400', async () => {
    const app = buildApp(async () => ({ events: [], hasMore: false }));

    const response = await app.request('/run-1/events?limit=0');
    expect(response.status).toBe(400);
  });

  it('redacts a response.validated event\'s "original" for a non-privileged connection', async () => {
    const secret = 'sk-real-secret-do-not-leak';
    const page: DurableEventPage = {
      events: [
        createEnvelope({
          kind: 'response.validated',
          payload: { step: 0, original: { content: secret, toolCalls: [] }, validated: {} },
        }),
      ],
      hasMore: false,
    };
    const app = buildApp(async () => page);

    const response = await app.request('/run-1/events', {
      headers: { 'x-api-key-scopes': 'runs:read' },
    });
    const body = await response.text();
    expect(body).not.toContain(secret);
  });

  it('leaves a response.validated event\'s "original" intact for a privileged (admin-key) connection', async () => {
    const secret = 'sk-real-secret-do-not-leak';
    const page: DurableEventPage = {
      events: [
        createEnvelope({
          kind: 'response.validated',
          payload: { step: 0, original: { content: secret, toolCalls: [] }, validated: {} },
        }),
      ],
      hasMore: false,
    };
    const app = buildApp(async () => page);

    const response = await app.request('/run-1/events', {
      headers: { 'x-api-key-scopes': '' },
    });
    const body = await response.text();
    expect(body).toContain(secret);
  });

  it('leaves a non-response.validated event untouched regardless of privilege', async () => {
    const page: DurableEventPage = { events: [createEnvelope()], hasMore: false };
    const app = buildApp(async () => page);

    const response = await app.request('/run-1/events', {
      headers: { 'x-api-key-scopes': 'runs:read' },
    });
    const body = (await response.json()) as DurableEventPage;
    expect(body.events[0]?.payload).toEqual({ content: 'done' });
  });

  it('maps a not-found outcome to 404 "Run not found" — AB-313', async () => {
    const app = buildApp(async () => ({ outcome: 'not-found' }));

    const response = await app.request('/run-1/events', {
      headers: { 'x-api-key-scopes': 'runs:read' },
    });
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain('Run not found');
  });

  it('maps a deleted-aggregate outcome to 200, projecting its events for privilege and carrying owner + hasMore/nextCursor — AB-313', async () => {
    const secret = 'sk-real-secret-do-not-leak';
    const app = buildApp(async (owner) => ({
      outcome: 'deleted-aggregate',
      owner,
      events: [
        createEnvelope({
          kind: 'response.validated',
          payload: { step: 0, original: { content: secret, toolCalls: [] }, validated: {} },
        }),
      ],
      hasMore: true,
      nextCursor: '2',
    }));

    const response = await app.request('/run-1/events', {
      headers: { 'x-api-key-scopes': 'runs:read' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome: string;
      owner: DurableEventOwner;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(body.outcome).toBe('deleted-aggregate');
    expect(body.owner).toEqual({ kind: 'run', id: 'run-1' });
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe('2');
    expect(JSON.stringify(body)).not.toContain(secret);
  });
});
