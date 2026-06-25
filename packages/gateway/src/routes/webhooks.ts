import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { Bureau } from '../types';

/**
 * Idempotency key header. Callers supply a unique key per delivery; webhook
 * ingress deduplicates by forwarding the key as the run's `sessionId`. A
 * re-delivered webhook with the same key lands in the same session, so the
 * agent sees it as a continuation rather than a fresh call.
 */
const IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key';

/**
 * Optional header that names the target agent. Falls back to the route
 * parameter (`/hooks/:agent`) when absent.
 */
const AGENT_HEADER = 'x-agent-name';

const WebhookBodySchema = z.object({
  /** Human-readable message forwarded to the agent as user input. */
  message: z.string().min(1),
  /** Override the default agent system prompt for this delivery. */
  systemPrompt: z.string().optional(),
  /** Override the maximum number of steps for this delivery. */
  maximumSteps: z.number().int().positive().optional(),
});

type WebhookBody = z.infer<typeof WebhookBodySchema>;

/**
 * Creates the webhook ingress routes.
 *
 * `POST /hooks/:agent` — fires a bureau run for the named agent.
 *
 * The request body must contain at least `{ message: string }`.
 * The optional `x-idempotency-key` header is used as the `sessionId` for the
 * resulting run, enabling idempotent re-delivery (duplicate webhooks land in
 * the same session). When omitted, a fresh session is created per delivery.
 *
 * The caller names the agent via the URL path parameter `:agent` (or the
 * `x-agent-name` header override). The gateway **never** resolves a route
 * from message content — typed dispatch, not a router.
 */
export function createWebhookRoutes(bureau: Bureau) {
  const app = new Hono();

  app.post('/:agent', async (context) => {
    const agentName = context.req.header(AGENT_HEADER) ?? context.req.param('agent');

    const idempotencyKey = context.req.header(IDEMPOTENCY_KEY_HEADER);

    let rawBody: unknown;
    try {
      rawBody = await context.req.json();
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }

    const parsed = WebhookBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const message = Object.entries(fieldErrors)
        .map(([field, errors]) => `${field}: ${errors?.join(', ') ?? 'invalid'}`)
        .join('; ');
      throw new HTTPException(400, { message: message || 'Invalid request body' });
    }

    const body: WebhookBody = parsed.data;

    try {
      const summary = await bureau.createRun({
        message: body.message,
        sessionId: idempotencyKey ?? undefined,
        systemPrompt: body.systemPrompt,
        maximumSteps: body.maximumSteps,
      });

      return context.json(
        {
          runId: summary.id,
          sessionId: summary.sessionId,
          status: summary.status,
          agentName,
          idempotencyKey: idempotencyKey ?? null,
        },
        202,
      );
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_CONFIGURED') {
          throw new HTTPException(503, { message: error.message });
        }
        if (error.code === 'BAD_REQUEST') {
          throw new HTTPException(400, { message: error.message });
        }
      }
      throw error;
    }
  });

  return app;
}
