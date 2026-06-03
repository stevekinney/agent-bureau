import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { Hono } from 'hono';
import type { GenerateResponse, Scheduler, SchedulerPriority } from 'operative';
import { createScheduler } from 'operative';
import { createMockGenerate } from 'operative/test';

import { drainMicrotasks } from '../test';
import type { SubmitSchedulerTaskRequest, SubmitSchedulerTaskResponse } from '../types';
import { createSchedulerRoutes } from './scheduler';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

async function waitForSchedulerTick() {
  await drainMicrotasks();
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
});
