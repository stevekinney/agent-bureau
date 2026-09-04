import type { GenerateResponse, Scheduler, SchedulerPriority } from '@lostgradient/operative';
import { createScheduler } from '@lostgradient/operative';
import { createMockGenerate } from '@lostgradient/operative/test';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { BureauError } from 'bureau';
import { Conversation, createConversationHistory } from 'conversationalist';
import { Hono } from 'hono';

import type { SubmitSchedulerTaskRequest, SubmitSchedulerTaskResponse } from '../types';
import { createSchedulerRoutes } from './scheduler';

/**
 * A fake `Scheduler` backed by a raw `EventTarget`, so a test can dispatch
 * any scheduler event directly (`task.dispatched`, `task.completed`,
 * `task.preempted`, `task.queued`) without driving a real scheduler tick.
 * `submit`/`cancel`/`getState` are no-ops unless overridden.
 */
function createFakeScheduler(overrides: Partial<Scheduler> = {}): {
  events: EventTarget;
  scheduler: Scheduler;
} {
  const events = new EventTarget();
  const scheduler = {
    getState() {
      return {
        activeTask: undefined,
        completedCount: 0,
        idle: true,
        preemptedCount: 0,
        queued: { ambient: [], background: [], immediate: [], scheduled: [] },
      };
    },
    submit() {
      return Promise.resolve();
    },
    cancel() {
      return false;
    },
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      events.addEventListener(type, listener, options);
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) {
      events.removeEventListener(type, listener, options);
    },
    ...overrides,
  } as unknown as Scheduler;

  return { events, scheduler };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

async function waitForSchedulerTick() {
  // Yield a macrotask so the scheduler loop dispatches the next queued task —
  // matches the prior drainMicrotasks() drain of Weft's deferred launch queue.
  for (let i = 0; i < 5; i++) {
    await yieldToPortableEventLoop();
  }
}

function createSubmitSchedulerTask(
  scheduler: Scheduler | undefined,
): ((request: SubmitSchedulerTaskRequest) => Promise<SubmitSchedulerTaskResponse>) | undefined {
  if (!scheduler) {
    return undefined;
  }

  return async (request) => {
    const taskId = `scheduler-task-${crypto.randomUUID()}`;
    const priority = request.priority ?? 'scheduled';

    const task: Parameters<Scheduler['submit']>[0] = {
      id: taskId,
      priority,
      metadata: request.metadata,
      requeue: request.requeue,
      createRun() {
        const conversation = new Conversation(createConversationHistory());
        if (request.systemPrompt) {
          conversation.appendSystemMessage(request.systemPrompt);
        }
        conversation.appendUserMessage(request.message);

        return {
          conversation,
          maximumSteps: request.maximumSteps,
        };
      },
    };

    void scheduler.submit(task).catch(() => {});

    return {
      taskId,
      priority,
      status: 'queued',
    };
  };
}

function createSchedulerApplication(scheduler: Scheduler | undefined) {
  const app = new Hono();
  app.route(
    '/api/v1/scheduler',
    createSchedulerRoutes(scheduler, createSubmitSchedulerTask(scheduler)),
  );
  return app;
}

describe('scheduler routes', () => {
  it('GET /api/v1/scheduler returns state when scheduler is configured', async () => {
    const scheduler = createScheduler({
      generate: createMockGenerate([textResponse('ok')]),
      toolbox: createTestToolbox([]),
      idleDelay: 1,
    });

    const app = createSchedulerApplication(scheduler);

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
    const app = createSchedulerApplication(undefined);

    const response = await app.request('/api/v1/scheduler');
    expect(response.status).toBe(501);
  });

  it('POST /api/v1/scheduler/tasks enqueues a task and records it in history', async () => {
    const scheduler = createScheduler({
      generate: createMockGenerate([textResponse('ok')]),
      toolbox: createTestToolbox([]),
      idleDelay: 1,
    });

    const app = createSchedulerApplication(scheduler);

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

  it('POST /api/v1/scheduler/tasks forwards explicit requeue behavior', async () => {
    let submittedTask: Parameters<Scheduler['submit']>[0] | undefined;
    const events = new EventTarget();
    const scheduler = {
      getState() {
        return {
          activeTask: undefined,
          completedCount: 0,
          idle: true,
          preemptedCount: 0,
          queued: {
            ambient: [],
            background: [],
            immediate: [],
            scheduled: [],
          },
        };
      },
      submit(task: Parameters<Scheduler['submit']>[0]) {
        submittedTask = task;
        return Promise.resolve(null);
      },
      cancel() {
        return false;
      },
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        events.addEventListener(type, listener, options);
      },
      removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) {
        events.removeEventListener(type, listener, options);
      },
    } as unknown as Scheduler;

    const app = createSchedulerApplication(scheduler);

    const response = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Do not requeue this task',
        priority: 'background',
        requeue: false,
      }),
    });

    expect(response.status).toBe(202);
    expect(submittedTask?.priority).toBe('background');
    expect(submittedTask?.requeue).toBe(false);
  });

  it('DELETE /api/v1/scheduler/tasks/:id cancels a queued task', async () => {
    const scheduler = createScheduler({
      generate: createMockGenerate([textResponse('ok')]),
      toolbox: createTestToolbox([]),
      idleDelay: 1,
    });

    const app = createSchedulerApplication(scheduler);

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

  it('DELETE /api/v1/scheduler/tasks/:id returns 404 when cancel() reports no matching task', async () => {
    const { scheduler } = createFakeScheduler({ cancel: () => false });
    const app = createSchedulerApplication(scheduler);

    const response = await app.request('/api/v1/scheduler/tasks/nonexistent', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
  });

  it('POST /api/v1/scheduler/tasks returns BAD_REQUEST for invalid JSON', async () => {
    const scheduler = createScheduler({
      generate: createMockGenerate([textResponse('ok')]),
      toolbox: createTestToolbox([]),
      idleDelay: 1,
    });

    const app = createSchedulerApplication(scheduler);

    const response = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('BAD_REQUEST');

    await scheduler.stop();
  });

  it('records failed tasks once in scheduler history', async () => {
    const events = new EventTarget();
    const scheduler = {
      getState() {
        return {
          activeTask: undefined,
          completedCount: 0,
          idle: true,
          preemptedCount: 0,
          queued: {
            ambient: [],
            background: [],
            immediate: [],
            scheduled: [],
          },
        };
      },
      submit(task: Parameters<Scheduler['submit']>[0]) {
        queueMicrotask(() => {
          const failedEvent = new Event('task.failed') as Event & {
            error: Error;
            taskId: string;
          };
          failedEvent.taskId = task.id;
          failedEvent.error = new Error('boom');
          events.dispatchEvent(failedEvent);
        });
        return Promise.reject(new Error('boom'));
      },
      cancel() {
        return false;
      },
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        events.addEventListener(type, listener, options);
      },
      removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) {
        events.removeEventListener(type, listener, options);
      },
    } as unknown as Scheduler;

    const app = createSchedulerApplication(scheduler);

    const submitResponse = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Explode' }),
    });
    expect(submitResponse.status).toBe(202);

    await waitForSchedulerTick();

    const historyResponse = await app.request('/api/v1/scheduler/history');
    expect(historyResponse.status).toBe(200);
    const historyBody = await historyResponse.json();
    const failureEntries = historyBody.entries.filter(
      (entry: { event: string }) => entry.event === 'task.failed',
    );

    expect(failureEntries).toHaveLength(1);
  });

  it('does not register duplicate scheduler listeners when routes are recreated', async () => {
    const events = new EventTarget();
    const scheduler = {
      getState() {
        return {
          activeTask: undefined,
          completedCount: 0,
          idle: true,
          preemptedCount: 0,
          queued: {
            ambient: [],
            background: [],
            immediate: [],
            scheduled: [],
          },
        };
      },
      submit(task: Parameters<Scheduler['submit']>[0]) {
        queueMicrotask(() => {
          const queuedEvent = new Event('task.queued') as Event & {
            metadata?: Record<string, unknown>;
            priority: SchedulerPriority;
            taskId: string;
          };
          queuedEvent.taskId = task.id;
          queuedEvent.priority = task.priority;
          queuedEvent.metadata = task.metadata;
          events.dispatchEvent(queuedEvent);
        });
        return Promise.resolve();
      },
      cancel() {
        return false;
      },
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        events.addEventListener(type, listener, options);
      },
      removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) {
        events.removeEventListener(type, listener, options);
      },
    } as unknown as Scheduler;

    const firstApp = createSchedulerApplication(scheduler);

    const secondApp = createSchedulerApplication(scheduler);

    const submitResponse = await firstApp.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Queue once' }),
    });
    expect(submitResponse.status).toBe(202);

    await waitForSchedulerTick();

    const historyResponse = await secondApp.request('/api/v1/scheduler/history');
    expect(historyResponse.status).toBe(200);

    const historyBody = await historyResponse.json();
    const queuedEntries = historyBody.entries.filter(
      (entry: { event: string }) => entry.event === 'task.queued',
    );
    expect(queuedEntries).toHaveLength(1);
  });

  it('GET /api/v1/scheduler/history returns 501 when scheduler not configured', async () => {
    const app = createSchedulerApplication(undefined);
    const response = await app.request('/api/v1/scheduler/history');
    expect(response.status).toBe(501);
  });

  it('POST /api/v1/scheduler/tasks returns 501 when scheduler not configured', async () => {
    const app = createSchedulerApplication(undefined);
    const response = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(501);
  });

  it('DELETE /api/v1/scheduler/tasks/:id returns 501 when scheduler not configured', async () => {
    const app = createSchedulerApplication(undefined);
    const response = await app.request('/api/v1/scheduler/tasks/any', { method: 'DELETE' });
    expect(response.status).toBe(501);
  });

  it('POST /api/v1/scheduler/tasks returns 400 for a schema-invalid body (missing message)', async () => {
    const { scheduler } = createFakeScheduler();
    const app = createSchedulerApplication(scheduler);

    const response = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('records task.dispatched and task.completed events in history', async () => {
    const { events, scheduler } = createFakeScheduler();
    const app = new Hono();
    app.route(
      '/api/v1/scheduler',
      createSchedulerRoutes(scheduler, async () => ({
        taskId: 'task-1',
        priority: 'scheduled',
        status: 'queued',
      })),
    );

    const dispatchedEvent = new Event('task.dispatched') as Event & {
      taskId: string;
      priority: SchedulerPriority;
    };
    dispatchedEvent.taskId = 'task-1';
    dispatchedEvent.priority = 'scheduled';
    events.dispatchEvent(dispatchedEvent);

    const completedEvent = new Event('task.completed') as Event & { taskId: string };
    completedEvent.taskId = 'task-1';
    events.dispatchEvent(completedEvent);

    const historyResponse = await app.request('/api/v1/scheduler/history');
    const historyBody = await historyResponse.json();
    const eventTypes = historyBody.entries.map((entry: { event: string }) => entry.event);
    expect(eventTypes).toContain('task.dispatched');
    expect(eventTypes).toContain('task.completed');
  });

  it('records task.preempted events in history with their reason', async () => {
    const { events, scheduler } = createFakeScheduler();
    const app = new Hono();
    app.route(
      '/api/v1/scheduler',
      createSchedulerRoutes(scheduler, async () => ({
        taskId: 'task-1',
        priority: 'scheduled',
        status: 'queued',
      })),
    );

    const preemptedEvent = new Event('task.preempted') as Event & {
      taskId: string;
      reason: string;
    };
    preemptedEvent.taskId = 'task-1';
    preemptedEvent.reason = 'higher-priority task arrived';
    events.dispatchEvent(preemptedEvent);

    const historyResponse = await app.request('/api/v1/scheduler/history');
    const historyBody = await historyResponse.json();
    const preemptedEntry = historyBody.entries.find(
      (entry: { event: string }) => entry.event === 'task.preempted',
    );
    expect(preemptedEntry).toMatchObject({
      event: 'task.preempted',
      taskId: 'task-1',
      reason: 'higher-priority task arrived',
    });
  });

  it('caps history at 100 entries, dropping the oldest first', async () => {
    const { events, scheduler } = createFakeScheduler();
    const app = new Hono();
    app.route('/api/v1/scheduler', createSchedulerRoutes(scheduler, undefined));

    for (let index = 0; index < 105; index += 1) {
      const queuedEvent = new Event('task.queued') as Event & {
        taskId: string;
        priority: SchedulerPriority;
      };
      queuedEvent.taskId = `task-${index}`;
      queuedEvent.priority = 'scheduled';
      events.dispatchEvent(queuedEvent);
    }

    const historyResponse = await app.request('/api/v1/scheduler/history');
    const historyBody = await historyResponse.json();
    expect(historyBody.entries).toHaveLength(100);
    // Newest first (unshift): the most recent submission (task-104) is at
    // the front, and the oldest 5 (task-0..task-4) were dropped.
    expect(historyBody.entries[0].taskId).toBe('task-104');
    expect(historyBody.entries.some((entry: { taskId: string }) => entry.taskId === 'task-0')).toBe(
      false,
    );
  });

  it('POST /api/v1/scheduler/tasks maps a BAD_REQUEST BureauError from submitSchedulerTask to 400', async () => {
    const { scheduler } = createFakeScheduler();
    const app = new Hono();
    app.route(
      '/api/v1/scheduler',
      createSchedulerRoutes(scheduler, async () => {
        throw new BureauError('bad task shape', 'BAD_REQUEST');
      }),
    );

    const response = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(400);
  });

  it('POST /api/v1/scheduler/tasks maps a RATE_LIMITED BureauError from submitSchedulerTask to 429', async () => {
    const { scheduler } = createFakeScheduler();
    const app = new Hono();
    app.route(
      '/api/v1/scheduler',
      createSchedulerRoutes(scheduler, async () => {
        throw new BureauError('too many tasks', 'RATE_LIMITED');
      }),
    );

    const response = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(429);
  });

  it('POST /api/v1/scheduler/tasks rethrows a BureauError from submitSchedulerTask whose code has no mapped status', async () => {
    const { scheduler } = createFakeScheduler();
    const app = new Hono();
    app.route(
      '/api/v1/scheduler',
      createSchedulerRoutes(scheduler, async () => {
        throw new BureauError('task already exists', 'CONFLICT');
      }),
    );
    app.onError((error, context) => context.json({ message: String(error) }, 500));

    const response = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(500);
  });

  it('POST /api/v1/scheduler/tasks maps a NOT_CONFIGURED BureauError from submitSchedulerTask to 501 (defense in depth)', async () => {
    const { scheduler } = createFakeScheduler();
    const app = new Hono();
    app.route(
      '/api/v1/scheduler',
      createSchedulerRoutes(scheduler, async () => {
        throw new BureauError('scheduler not configured', 'NOT_CONFIGURED', 'generate');
      }),
    );

    const response = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(501);
  });

  it('POST /api/v1/scheduler/tasks rethrows a non-BureauError from submitSchedulerTask', async () => {
    const { scheduler } = createFakeScheduler();
    const app = new Hono();
    app.route(
      '/api/v1/scheduler',
      createSchedulerRoutes(scheduler, async () => {
        throw new Error('unexpected failure');
      }),
    );
    app.onError((error, context) => context.json({ message: String(error) }, 500));

    const response = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(500);
  });
});
