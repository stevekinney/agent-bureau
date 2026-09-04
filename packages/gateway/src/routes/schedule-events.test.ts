import { describe, expect, it } from 'bun:test';

import { createTestGateway, requestJSON } from '../test';

const AUTH_TOKEN = 'test-token';
const authHeaders = { authorization: `Bearer ${AUTH_TOKEN}` };

describe('GET /api/v1/schedules/:id/events (AB-312)', () => {
  it('reaches bureau.eventHistory({kind: "schedule", id}) — 501 when no durable engine is configured', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, '/api/v1/schedules/my-schedule/events', {
      headers: authHeaders,
    });

    // This test gateway's default bureau has no persistent storage backend
    // — this proves the route is mounted at `/api/v1/schedules` (not
    // `/schedules`, where `createSchedulesRoutes` itself lives) and reaches
    // `bureau.eventHistory` with the `'schedule'` owner kind (deterministically
    // `unsupported-capability` here). The full paged/redacted response
    // shape is covered by `event-history.test.ts`; a real durable schedule
    // page by the conformance suite.
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('requires authentication (401 with no bearer token, when an authToken is configured)', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, '/api/v1/schedules/my-schedule/events');

    expect(response.status).toBe(401);
  });
});
