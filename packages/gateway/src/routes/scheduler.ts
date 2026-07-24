import type { Scheduler, SchedulerPriority } from '@lostgradient/operative';
import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { SubmitSchedulerTaskRequest, SubmitSchedulerTaskResponse } from '../types';

type SchedulerHistoryEntry = {
  event: string;
  metadata?: Record<string, unknown>;
  priority?: SchedulerPriority;
  reason?: string;
  taskId: string;
  timestamp: number;
};

const SubmitSchedulerTaskRequestSchema = z.object({
  message: z.string().min(1),
  maximumSteps: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  priority: z.enum(['immediate', 'scheduled', 'background', 'ambient']).optional(),
  requeue: z.boolean().optional(),
  systemPrompt: z.string().optional(),
});

const MAX_HISTORY_ENTRIES = 100;
const schedulerHistoryByInstance = new WeakMap<Scheduler, SchedulerHistoryEntry[]>();

function createSchedulerHistoryStore(): SchedulerHistoryEntry[] {
  return [];
}

function appendSchedulerHistory(
  history: SchedulerHistoryEntry[],
  entry: SchedulerHistoryEntry,
): void {
  history.unshift(entry);
  if (history.length > MAX_HISTORY_ENTRIES) {
    history.length = MAX_HISTORY_ENTRIES;
  }
}

function getSchedulerHistory(scheduler: Scheduler): SchedulerHistoryEntry[] {
  const existingHistory = schedulerHistoryByInstance.get(scheduler);
  if (existingHistory) {
    return existingHistory;
  }

  const history = createSchedulerHistoryStore();

  scheduler.addEventListener('task.queued', (event) => {
    appendSchedulerHistory(history, {
      event: event.type,
      taskId: event.taskId,
      priority: event.priority,
      metadata: event.metadata,
      timestamp: Date.now(),
    });
  });

  scheduler.addEventListener('task.dispatched', (event) => {
    appendSchedulerHistory(history, {
      event: event.type,
      taskId: event.taskId,
      priority: event.priority,
      timestamp: Date.now(),
    });
  });

  scheduler.addEventListener('task.completed', (event) => {
    appendSchedulerHistory(history, {
      event: event.type,
      taskId: event.taskId,
      timestamp: Date.now(),
    });
  });

  scheduler.addEventListener('task.failed', (event) => {
    appendSchedulerHistory(history, {
      event: event.type,
      taskId: event.taskId,
      metadata: {
        error: event.error instanceof Error ? event.error.message : String(event.error),
      },
      timestamp: Date.now(),
    });
  });

  scheduler.addEventListener('task.preempted', (event) => {
    appendSchedulerHistory(history, {
      event: event.type,
      taskId: event.taskId,
      reason: event.reason,
      timestamp: Date.now(),
    });
  });

  scheduler.addEventListener('task.cancelled', (event) => {
    appendSchedulerHistory(history, {
      event: event.type,
      taskId: event.taskId,
      reason: event.phase,
      timestamp: Date.now(),
    });
  });

  schedulerHistoryByInstance.set(scheduler, history);
  return history;
}

/**
 * Creates HTTP routes for scheduler inspection, submission, cancellation, and history.
 */
export function createSchedulerRoutes(
  scheduler: Scheduler | undefined,
  submitSchedulerTask:
    | ((request: SubmitSchedulerTaskRequest) => Promise<SubmitSchedulerTaskResponse>)
    | undefined,
) {
  const app = new Hono();
  const history = scheduler ? getSchedulerHistory(scheduler) : [];

  app.get('/', (context) => {
    if (!scheduler) {
      return context.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Scheduler not configured' } },
        501,
      );
    }
    return context.json(scheduler.getState());
  });

  app.get('/history', (context) => {
    if (!scheduler) {
      return context.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Scheduler not configured' } },
        501,
      );
    }

    return context.json({ entries: history }, 200);
  });

  app.post('/tasks', async (context) => {
    if (!scheduler || !submitSchedulerTask) {
      return context.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Scheduler not configured' } },
        501,
      );
    }

    let requestBody: unknown;
    try {
      requestBody = await context.req.json();
    } catch {
      return context.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
    }

    const parsedBody = SubmitSchedulerTaskRequestSchema.safeParse(requestBody);
    if (!parsedBody.success) {
      const fieldErrors = parsedBody.error.flatten().fieldErrors;
      const message = Object.entries(fieldErrors)
        .map(([field, errors]) => `${field}: ${errors?.join(', ') ?? 'invalid'}`)
        .join('; ');
      return context.json(
        { error: { code: 'BAD_REQUEST', message: message || 'Invalid request' } },
        400,
      );
    }

    const body: SubmitSchedulerTaskRequest = parsedBody.data;
    try {
      const response = await submitSchedulerTask(body);
      return context.json(response, 202);
    } catch (error) {
      // submitSchedulerTask is a plain (non-async) function — a rejected
      // admission (BAD_REQUEST validation, AB-13's RATE_LIMITED flow-control
      // gate) throws synchronously, which surfaces here as a caught error
      // the same as an async rejection would.
      if (error instanceof BureauError) {
        // NOT_CONFIGURED (subject: 'scheduler') is unreachable here:
        // `scheduler`/`submitSchedulerTask` are a fixed snapshot of
        // `runtime.scheduler` taken once at bureau creation and never
        // reassigned, so having passed the `!scheduler` guard above means
        // `submitSchedulerTask`'s own `!runtime.scheduler` check can never
        // fire. Kept as defense-in-depth rather than removed as dead code —
        // 501 to match every other scheduler-missing branch in this file
        // (scheduler is a "deployment doesn't compose this" subject, not an
        // operator-fixable one), in case that invariant ever changes.
        if (error.code === 'NOT_CONFIGURED') {
          return context.json({ error: { code: 'NOT_CONFIGURED', message: error.message } }, 501);
        }
        if (error.code === 'BAD_REQUEST') {
          throw new HTTPException(400, { message: error.message });
        }
        // AB-13 — a flow-control policy (concurrency cap, rate limit, or
        // singleton dedupe) rejected this task's admission.
        if (error.code === 'RATE_LIMITED') {
          throw new HTTPException(429, { message: error.message });
        }
      }
      throw error;
    }
  });

  app.delete('/tasks/:id', (context) => {
    if (!scheduler) {
      return context.json(
        { error: { code: 'NOT_CONFIGURED', message: 'Scheduler not configured' } },
        501,
      );
    }

    const cancelled = scheduler.cancel(context.req.param('id'));
    if (!cancelled) {
      return context.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    }

    return context.json({ status: 'cancelled' }, 202);
  });

  return app;
}
