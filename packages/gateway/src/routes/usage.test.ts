import { describe, expect, it } from 'bun:test';

import { createTestGateway, requestJSON, waitForRunState } from '../test';
import {
  groupUsage,
  UNATTRIBUTED_AGENT,
  UNATTRIBUTED_PRINCIPAL,
  type UsageRunView,
  windowKey,
} from './usage';

const AUTH_TOKEN = 'test-token';
const authHeaders = { authorization: `Bearer ${AUTH_TOKEN}` };

// Usage is mounted at /api/v1/usage
const USAGE_PATH = '/api/v1/usage';

describe('usage routes', () => {
  it('GET /api/v1/usage returns aggregate with zero totals when no runs exist', async () => {
    const gateway = await createTestGateway({ authToken: AUTH_TOKEN });

    const response = await requestJSON(gateway, USAGE_PATH, { headers: authHeaders });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.aggregate.runCount).toBe(0);
    expect(body.aggregate.totalTokens).toBe(0);
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs).toHaveLength(0);
  });

  it('GET /api/v1/usage includes run usage after a completed run', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const response = await requestJSON(gateway, USAGE_PATH, { headers: authHeaders });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.aggregate.runCount).toBeGreaterThan(0);
    expect(body.runs.length).toBeGreaterThan(0);

    const runUsage = body.runs[0];
    expect(runUsage.runId).toBeString();
    expect(runUsage.sessionId).toBeString();
    expect(typeof runUsage.usage.promptTokens).toBe('number');
    expect(typeof runUsage.usage.completionTokens).toBe('number');
    expect(typeof runUsage.usage.totalTokens).toBe('number');
    expect(typeof runUsage.steps).toBe('number');
  });

  it('GET /api/v1/usage?status=completed only returns completed runs', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const response = await requestJSON(gateway, `${USAGE_PATH}?status=completed`, {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    for (const run of body.runs) {
      expect(run.status).toBe('completed');
    }
  });

  it('GET /api/v1/usage?sessionId=... filters by session', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello', sessionId: 'my-session' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    // Filter by the specific session
    const response = await requestJSON(gateway, `${USAGE_PATH}?sessionId=my-session`, {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.runs.every((r: { sessionId: string }) => r.sessionId === 'my-session')).toBe(true);

    // Filter by a non-existent session → empty
    const emptyResponse = await requestJSON(gateway, `${USAGE_PATH}?sessionId=other-session`, {
      headers: authHeaders,
    });
    const emptyBody = await emptyResponse.json();
    expect(emptyBody.runs).toHaveLength(0);
  });

  it('GET /api/v1/usage groups runs by agent, principal, and time window', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const first = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello', agentName: 'researcher' }),
    });
    const firstRun = await first.json();
    await waitForRunState(gateway.bureau, firstRun.id);

    const second = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello', agentName: 'writer' }),
    });
    const secondRun = await second.json();
    await waitForRunState(gateway.bureau, secondRun.id);

    const response = await requestJSON(gateway, USAGE_PATH, { headers: authHeaders });
    const body = await response.json();

    expect(body.analytics.byAgent.map((g: { key: string }) => g.key).sort()).toEqual([
      'researcher',
      'writer',
    ]);
    expect(body.analytics.byAgent.every((g: { runCount: number }) => g.runCount === 1)).toBe(true);

    // A single static-token request carries one principal — both runs land in
    // the same bucket.
    expect(body.analytics.byPrincipal).toHaveLength(1);
    expect(body.analytics.byPrincipal[0].key).toBe('static-token');
    expect(body.analytics.byPrincipal[0].runCount).toBe(2);

    expect(body.analytics.byWindow.length).toBeGreaterThan(0);
    const totalWindowRuns = body.analytics.byWindow.reduce(
      (sum: number, g: { runCount: number }) => sum + g.runCount,
      0,
    );
    expect(totalWindowRuns).toBe(2);

    for (const run of body.runs) {
      expect(['researcher', 'writer']).toContain(run.agentName);
      expect(run.principal).toBe('static-token');
      expect(typeof run.startedAt).toBe('number');
    }
  });

  it('GET /api/v1/usage includes AB-92 cache-token fields when the provider reports them', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      generate: async () => ({
        content: 'Done.',
        toolCalls: [],
        usage: { prompt: 100, completion: 20, total: 120, cacheReadTokens: 80 },
      }),
    });

    const created = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello', maximumSteps: 1 }),
    });
    const createdRun = await created.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const response = await requestJSON(gateway, USAGE_PATH, { headers: authHeaders });
    const body = await response.json();

    expect(body.runs[0].usage.cacheReadTokens).toBe(80);
    expect(body.runs[0].usage.cacheCreationTokens).toBeUndefined();
    expect(body.aggregate.cacheReadTokens).toBe(80);
  });

  it('GET /api/v1/usage includes a cost estimate when the configured model has pricing', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      provider: { provider: 'anthropic', model: 'claude-3-5-haiku-20241022' },
      generate: async () => ({
        content: 'Done.',
        toolCalls: [],
        usage: { prompt: 1_000_000, completion: 1_000_000, total: 2_000_000 },
      }),
    });

    const created = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello', maximumSteps: 1 }),
    });
    const createdRun = await created.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const response = await requestJSON(gateway, USAGE_PATH, { headers: authHeaders });
    const body = await response.json();

    // claude-3-5-haiku-20241022: $0.8/M prompt, $4/M completion.
    expect(body.runs[0].cost.promptCost).toBeCloseTo(0.8);
    expect(body.runs[0].cost.completionCost).toBeCloseTo(4);
    expect(body.runs[0].cost.totalCost).toBeCloseTo(4.8);
    expect(body.aggregate.totalCost).toBeCloseTo(4.8);
    expect(body.aggregate.costComplete).toBe(true);
  });

  it('GET /api/v1/usage leaves cost absent when the configured model has no pricing entry', async () => {
    const gateway = await createTestGateway({
      authToken: AUTH_TOKEN,
      provider: { provider: 'anthropic', model: 'some-unpriced-model' },
      generate: async () => ({ content: 'Done.', toolCalls: [] }),
    });

    const created = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ message: 'Hello' }),
    });
    const createdRun = await created.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const response = await requestJSON(gateway, USAGE_PATH, { headers: authHeaders });
    const body = await response.json();

    expect(body.runs[0].cost).toBeUndefined();
    expect(body.aggregate.totalCost).toBe(0);
    expect(body.aggregate.costComplete).toBe(false);
  });
});

describe('groupUsage (pure aggregation)', () => {
  function makeRunView(overrides: Partial<UsageRunView> = {}): UsageRunView {
    return {
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'completed',
      agentName: 'bureau',
      principal: 'static-token',
      startedAt: Date.parse('2026-07-09T10:15:00.000Z'),
      steps: 1,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      ...overrides,
    };
  }

  it('buckets runs with no agentName under UNATTRIBUTED_AGENT', () => {
    const analytics = groupUsage([makeRunView({ agentName: undefined })]);
    expect(analytics.byAgent).toHaveLength(1);
    expect(analytics.byAgent[0]?.key).toBe(UNATTRIBUTED_AGENT);
  });

  it('buckets runs with no principal under UNATTRIBUTED_PRINCIPAL', () => {
    const analytics = groupUsage([makeRunView({ principal: undefined })]);
    expect(analytics.byPrincipal).toHaveLength(1);
    expect(analytics.byPrincipal[0]?.key).toBe(UNATTRIBUTED_PRINCIPAL);
  });

  it('sums tokens and cache tokens across runs in the same bucket', () => {
    const analytics = groupUsage([
      makeRunView({
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cacheReadTokens: 4 },
      }),
      makeRunView({
        usage: {
          promptTokens: 20,
          completionTokens: 10,
          totalTokens: 30,
          cacheCreationTokens: 50,
        },
      }),
    ]);

    const group = analytics.byAgent[0]!;
    expect(group.runCount).toBe(2);
    expect(group.promptTokens).toBe(30);
    expect(group.completionTokens).toBe(15);
    expect(group.totalTokens).toBe(45);
    expect(group.cacheReadTokens).toBe(4);
    expect(group.cacheCreationTokens).toBe(50);
  });

  it('marks a bucket costComplete:false when any contributing run has no cost estimate', () => {
    const analytics = groupUsage([
      makeRunView({ cost: undefined }),
      makeRunView({
        cost: {
          promptCost: 1,
          completionCost: 1,
          cacheWriteCost: 0,
          cacheReadCost: 0,
          totalCost: 2,
        },
      }),
    ]);

    const group = analytics.byAgent[0]!;
    expect(group.costComplete).toBe(false);
    // totalCost is still the sum of what IS known — a floor, not fabricated.
    expect(group.totalCost).toBe(2);
  });

  it('marks a bucket costComplete:true only when every run has a cost estimate', () => {
    const analytics = groupUsage([
      makeRunView({
        cost: {
          promptCost: 1,
          completionCost: 1,
          cacheWriteCost: 0,
          cacheReadCost: 0,
          totalCost: 2,
        },
      }),
      makeRunView({
        cost: {
          promptCost: 3,
          completionCost: 1,
          cacheWriteCost: 0,
          cacheReadCost: 0,
          totalCost: 4,
        },
      }),
    ]);

    const group = analytics.byAgent[0]!;
    expect(group.costComplete).toBe(true);
    expect(group.totalCost).toBe(6);
  });

  it('buckets by day by default and by hour when requested', () => {
    const runA = makeRunView({ startedAt: Date.parse('2026-07-09T10:15:00.000Z') });
    const runB = makeRunView({ startedAt: Date.parse('2026-07-09T14:45:00.000Z') });

    const byDay = groupUsage([runA, runB], 'day');
    expect(byDay.byWindow).toHaveLength(1);
    expect(byDay.byWindow[0]?.key).toBe('2026-07-09');
    expect(byDay.byWindow[0]?.runCount).toBe(2);

    const byHour = groupUsage([runA, runB], 'hour');
    expect(byHour.byWindow).toHaveLength(2);
    expect(byHour.byWindow.map((g) => g.key)).toEqual(['2026-07-09T10:00', '2026-07-09T14:00']);
  });

  it('windowKey formats day and hour buckets in UTC', () => {
    const timestamp = Date.parse('2026-07-09T14:45:30.123Z');
    expect(windowKey(timestamp, 'day')).toBe('2026-07-09');
    expect(windowKey(timestamp, 'hour')).toBe('2026-07-09T14:00');
  });

  it('sorts every grouping dimension by key', () => {
    const analytics = groupUsage([
      makeRunView({ agentName: 'writer', principal: 'p2' }),
      makeRunView({ agentName: 'analyst', principal: 'p1' }),
    ]);

    expect(analytics.byAgent.map((g) => g.key)).toEqual(['analyst', 'writer']);
    expect(analytics.byPrincipal.map((g) => g.key)).toEqual(['p1', 'p2']);
  });

  it('returns empty groups for an empty run list', () => {
    const analytics = groupUsage([]);
    expect(analytics.byAgent).toEqual([]);
    expect(analytics.byPrincipal).toEqual([]);
    expect(analytics.byWindow).toEqual([]);
  });
});
