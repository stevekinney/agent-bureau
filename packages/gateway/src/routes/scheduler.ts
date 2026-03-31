import { Conversation, createConversationHistory } from 'conversationalist';
import { Hono } from 'hono';
import type { Scheduler, SchedulerPriority } from 'operative';
import { z } from 'zod';

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
  systemPrompt: z.string().optional(),
});

type SubmitSchedulerTaskRequest = z.infer<typeof SubmitSchedulerTaskRequestSchema>;

const MAX_HISTORY_ENTRIES = 100;

/**
 * Creates HTTP routes for scheduler inspection, submission, cancellation, and history.
 */
export function createSchedulerRoutes(scheduler: Scheduler | undefined) {
  const app = new Hono();
  const history: SchedulerHistoryEntry[] = [];

  function appendHistory(entry: SchedulerHistoryEntry): void {
    history.unshift(entry);
    if (history.length > MAX_HISTORY_ENTRIES) {
      history.length = MAX_HISTORY_ENTRIES;
    }
  }

  if (scheduler) {
    scheduler.addEventListener('task.queued', (event) => {
      appendHistory({
        event: event.type,
        taskId: event.taskId,
        priority: event.priority,
        metadata: event.metadata,
        timestamp: Date.now(),
      });
    });

    scheduler.addEventListener('task.dispatched', (event) => {
      appendHistory({
        event: event.type,
        taskId: event.taskId,
        priority: event.priority,
        timestamp: Date.now(),
      });
    });

    scheduler.addEventListener('task.completed', (event) => {
      appendHistory({
        event: event.type,
        taskId: event.taskId,
        timestamp: Date.now(),
      });
    });

    scheduler.addEventListener('task.failed', (event) => {
      appendHistory({
        event: event.type,
        taskId: event.taskId,
        metadata: {
          error: event.error instanceof Error ? event.error.message : String(event.error),
        },
        timestamp: Date.now(),
      });
    });

    scheduler.addEventListener('task.preempted', (event) => {
      appendHistory({
        event: event.type,
        taskId: event.taskId,
        reason: event.reason,
        timestamp: Date.now(),
      });
    });

    scheduler.addEventListener('task.cancelled', (event) => {
      appendHistory({
        event: event.type,
        taskId: event.taskId,
        reason: event.phase,
        timestamp: Date.now(),
      });
    });
  }

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
    if (!scheduler) {
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
    const taskId = `scheduler-task-${crypto.randomUUID()}`;
    const priority: SchedulerPriority = body.priority ?? 'scheduled';

    const task: Parameters<Scheduler['submit']>[0] = {
      id: taskId,
      priority,
      metadata: body.metadata,
      createRun() {
        const conversation = new Conversation(createConversationHistory());
        if (body.systemPrompt) {
          conversation.appendSystemMessage(body.systemPrompt);
        }
        conversation.appendUserMessage(body.message);

        return {
          conversation,
          maximumSteps: body.maximumSteps,
        };
      },
    };

    void scheduler.submit(task).catch(() => {});

    return context.json({ taskId, priority, status: 'queued' }, 202);
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
