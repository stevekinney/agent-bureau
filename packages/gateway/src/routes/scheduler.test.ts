import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { GenerateResponse } from 'operative';
import { createScheduler } from 'operative';
import { createMockGenerate } from 'operative/test';

import { createSchedulerRoutes } from './scheduler';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('scheduler routes', () => {
  it('GET /api/v1/scheduler returns state when scheduler is configured', async () => {
    const scheduler = createScheduler({
      generate: createMockGenerate([textResponse('ok')]),
      toolbox: createTestToolbox([]),
      idleDelay: 1,
    });

    const app = new Hono();
    app.route('/api/v1/scheduler', createSchedulerRoutes(scheduler));

    const response = await app.request('/api/v1/scheduler');
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty('idle');
    expect(body).toHaveProperty('completedCount');
    expect(body).toHaveProperty('preemptedCount');
    expect(body).toHaveProperty('queued');

    await scheduler.stop();
  });

  it('GET /api/v1/scheduler returns 501 when scheduler not configured', async () => {
    const app = new Hono();
    app.route('/api/v1/scheduler', createSchedulerRoutes(undefined));

    const response = await app.request('/api/v1/scheduler');
    expect(response.status).toBe(501);
  });

  it('POST /api/v1/scheduler/heartbeat returns 501 when scheduler not configured', async () => {
    const app = new Hono();
    app.route('/api/v1/scheduler', createSchedulerRoutes(undefined));

    const response = await app.request('/api/v1/scheduler/heartbeat', { method: 'POST' });
    expect(response.status).toBe(501);
  });

  it('POST /api/v1/scheduler/heartbeat returns 200 when scheduler configured', async () => {
    const scheduler = createScheduler({
      generate: createMockGenerate([textResponse('ok')]),
      toolbox: createTestToolbox([]),
      idleDelay: 1,
    });

    const app = new Hono();
    app.route('/api/v1/scheduler', createSchedulerRoutes(scheduler));

    const response = await app.request('/api/v1/scheduler/heartbeat', { method: 'POST' });
    expect(response.status).toBe(200);

    await scheduler.stop();
  });
});
