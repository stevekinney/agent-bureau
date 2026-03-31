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

  it('POST /api/v1/scheduler/tasks enqueues a task and records it in history', async () => {
    const scheduler = createScheduler({
      generate: createMockGenerate([textResponse('ok')]),
      toolbox: createTestToolbox([]),
      idleDelay: 1,
    });

    const app = new Hono();
    app.route('/api/v1/scheduler', createSchedulerRoutes(scheduler));

    const submitResponse = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello scheduler' }),
    });

    expect(submitResponse.status).toBe(202);
    const submitBody = await submitResponse.json();
    expect(submitBody.taskId).toBeString();

    const historyResponse = await app.request('/api/v1/scheduler/history');
    expect(historyResponse.status).toBe(200);

    const historyBody = await historyResponse.json();
    expect(historyBody.entries[0]?.event).toBe('task.queued');

    await scheduler.stop();
  });

  it('DELETE /api/v1/scheduler/tasks/:id cancels a queued task', async () => {
    const scheduler = createScheduler({
      generate: createMockGenerate([textResponse('ok')]),
      toolbox: createTestToolbox([]),
      idleDelay: 1,
    });

    const app = new Hono();
    app.route('/api/v1/scheduler', createSchedulerRoutes(scheduler));

    const submitResponse = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Cancel me' }),
    });
    const submitBody = await submitResponse.json();

    const cancelResponse = await app.request(`/api/v1/scheduler/tasks/${submitBody.taskId}`, {
      method: 'DELETE',
    });
    expect(cancelResponse.status).toBe(202);

    const historyResponse = await app.request('/api/v1/scheduler/history');
    const historyBody = await historyResponse.json();
    expect(
      historyBody.entries.some((entry: { event: string }) => entry.event === 'task.cancelled'),
    ).toBe(true);

    await scheduler.stop();
  });
});
