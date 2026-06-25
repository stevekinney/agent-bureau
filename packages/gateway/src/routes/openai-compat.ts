import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import type { Bureau, CreateRunRequest } from '../types';

/**
 * An individual message in the OpenAI chat messages array.
 */
type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

/**
 * OpenAI-compat chat completions request schema.
 *
 * The `model` field carries the agent name — this is the typed dispatch
 * mechanism. No routing: the caller names the agent directly in the model
 * field, and the gateway dispatches to that agent verbatim.
 */
const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1, 'model field is required and must be a non-empty string'),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      }),
    )
    .min(1, 'messages array must contain at least one message'),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
});

/**
 * Collapse an OpenAI messages array into a single user prompt.
 *
 * System messages are prepended as a separate block; assistant turns are
 * included for context; the last user message is the primary input.
 */
function messagesToPrompt(messages: ChatMessage[]): { message: string; systemPrompt?: string } {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const userAndAssistant = messages.filter((m) => m.role !== 'system');

  const systemPrompt =
    systemMessages.length > 0 ? systemMessages.map((m) => m.content).join('\n\n') : undefined;

  // Use the last user message as the primary input. If a multi-turn context
  // exists, include prior turns as a flat transcript in the message.
  const lastUserIndex = [...userAndAssistant].reverse().findIndex((m) => m.role === 'user');
  if (lastUserIndex === -1) {
    throw new HTTPException(400, {
      message: 'messages array must contain at least one user message',
    });
  }

  const flattenedIndex = userAndAssistant.length - 1 - lastUserIndex;

  if (flattenedIndex === 0) {
    // Single user message — send directly.
    return { message: userAndAssistant[0]!.content, systemPrompt };
  }

  // Multi-turn: prepend prior context and send the last user message.
  const priorTurns = userAndAssistant
    .slice(0, flattenedIndex)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
  const lastMessage = userAndAssistant[flattenedIndex]!.content;
  const message = `${priorTurns}\n\nUser: ${lastMessage}`;
  return { message, systemPrompt };
}

/**
 * Format a completed run result as an OpenAI-compat chat completion response.
 */
function formatChatCompletion(model: string, content: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
  };
}

/**
 * Format a run summary as an SSE chunk and final done event.
 * Returns the SSE data lines to stream.
 */
function formatSseChunk(model: string, content: string, isLast: boolean): string {
  const chunk = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: isLast ? {} : { role: 'assistant' as const, content },
        finish_reason: isLast ? 'stop' : null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * OpenAI-compatible `POST /v1/chat/completions` route.
 *
 * The `model` field in the request body is the agent name — a typed dispatch
 * mechanism with no routing. The caller names the agent; the gateway dispatches
 * directly. Missing or unknown model → 422.
 *
 * Supports both standard JSON and SSE streaming (`stream: true`) responses.
 */
export function createOpenAICompatRoutes(bureau: Bureau) {
  const app = new Hono();

  app.post('/chat/completions', async (context) => {
    let rawBody: unknown;
    try {
      rawBody = await context.req.json();
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }

    const parsed = ChatCompletionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => i.message).join('; ');
      throw new HTTPException(422, {
        message: `Invalid request: ${messages}`,
      });
    }

    const { model: agentName, messages, max_tokens, stream } = parsed.data;

    // ── Typed dispatch: model field IS the agent name ──────────────────
    // No routing, no binding table. The caller provides the agent name in the
    // model field; the gateway dispatches to that agent verbatim. There is no
    // default agent: a missing or invalid model is rejected here.

    let message: string;
    let systemPrompt: string | undefined;
    try {
      const prompt = messagesToPrompt(messages as ChatMessage[]);
      message = prompt.message;
      systemPrompt = prompt.systemPrompt;
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(400, { message: 'Failed to process messages' });
    }

    const request: CreateRunRequest = {
      message,
      agentName,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(max_tokens ? { maximumTokens: max_tokens } : {}),
    };

    let summary;
    try {
      summary = await bureau.createRun(request);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_CONFIGURED') {
          throw new HTTPException(503, { message: error.message });
        }
        if (error.code === 'BAD_REQUEST') {
          throw new HTTPException(422, { message: error.message });
        }
        if (error.code === 'NOT_FOUND') {
          throw new HTTPException(404, { message: error.message });
        }
      }
      throw error;
    }

    // createRun() only registers the ActiveRun and returns a RunSummary — the
    // provider loop continues asynchronously. Await the run's result promise
    // before reading stepDetails so the response is never empty with a live provider.
    // The loop resolves for all terminal states (completed, error, aborted); the
    // try/catch guards against unexpected rejections only.
    const runState = bureau.store.getRun(summary.id);
    if (runState) {
      try {
        await runState.activeRun.result;
      } catch {
        // Unexpected rejection — the settled run state is checked below.
      }
    }

    // Read the final content from the settled run detail.
    const runDetail = bureau.getRun(summary.id);

    if (!runDetail) {
      throw new HTTPException(500, { message: 'Run result unavailable after settlement' });
    }

    if (runDetail.status === 'error') {
      const message = runDetail.error ?? 'Run failed with an unspecified error';
      throw new HTTPException(500, {
        message: typeof message === 'string' ? message : 'Run failed',
      });
    }

    if (runDetail.status === 'aborted') {
      throw new HTTPException(500, { message: 'Run was aborted before completion' });
    }

    const lastStep = runDetail.stepDetails.at(-1);
    const textContent = lastStep?.content ?? '';

    if (stream) {
      // SSE streaming response: send a single content chunk then done.
      const sse =
        formatSseChunk(agentName, textContent, false) +
        formatSseChunk(agentName, '', true) +
        'data: [DONE]\n\n';

      return new Response(sse, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    return context.json(formatChatCompletion(agentName, textContent), 200);
  });

  return app;
}
