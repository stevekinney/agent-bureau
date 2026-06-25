import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import type { Bureau } from '../types';

/**
 * OpenAI Chat Completions compatible request schema.
 *
 * The `model` field carries the bureau agent name — the gateway routes the
 * request to `bureau.run(model, ...)`. This is the "typed dispatch" pattern:
 * the caller names the agent, the gateway validates and dispatches.
 */
const ChatCompletionRequestSchema = z.object({
  /** Bureau agent name (maps to OpenAI "model" field). */
  model: z.string().min(1),
  /** Conversation messages. At least one `user` message is required. */
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      }),
    )
    .min(1),
  /** Stream the response as SSE. Non-streaming returns a single JSON object. */
  stream: z.boolean().optional().default(false),
  /** Maximum tokens in the response (advisory — bureau enforces maximumSteps). */
  max_tokens: z.number().int().positive().optional(),
  /** Optional session id for conversation continuity. */
  session_id: z.string().optional(),
  /** Override the system prompt for this request. */
  system: z.string().optional(),
  /** Maximum number of agent steps. */
  maximum_steps: z.number().int().positive().optional(),
});

type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

/**
 * Build the single-user-message string from the OpenAI `messages` array.
 * Concatenates all `user` messages; system messages are forwarded via
 * `systemPrompt`. The last `user` role message is used as the run input.
 */
function extractUserMessage(messages: ChatCompletionRequest['messages']): string {
  const userMessages = messages.filter((m) => m.role === 'user');
  const last = userMessages.at(-1);
  return last?.content ?? '';
}

function extractSystemPrompt(
  messages: ChatCompletionRequest['messages'],
  systemOverride?: string,
): string | undefined {
  if (systemOverride) return systemOverride;
  const sys = messages.find((m) => m.role === 'system');
  return sys?.content;
}

/**
 * Build a minimal OpenAI-compat SSE `data:` chunk.
 */
function buildStreamChunk(delta: string, finishReason: string | null): string {
  return JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [
      {
        delta: { content: delta },
        finish_reason: finishReason,
        index: 0,
      },
    ],
  });
}

/**
 * Build a minimal OpenAI-compat non-streaming completion response.
 */
function buildCompletionResponse(content: string, promptTokens: number, completionTokens: number) {
  return {
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Creates the OpenAI-compat chat completions route.
 *
 * `POST /v1/chat/completions` — accepts an OpenAI chat completions request and
 * routes it to a bureau run. The `model` field carries the agent name.
 *
 * When `stream: true`, the response is Server-Sent Events in the OpenAI chunk
 * format. When `stream: false` (default), returns a single JSON completion.
 *
 * This makes the bureau a drop-in replacement for any client speaking the OpenAI
 * chat API — the only non-standard field is `model` naming an agent, not a model.
 */
export function createOpenAiCompatRoutes(bureau: Bureau) {
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
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const message = Object.entries(fieldErrors)
        .map(([field, errors]) => `${field}: ${errors?.join(', ') ?? 'invalid'}`)
        .join('; ');
      throw new HTTPException(400, { message: message || 'Invalid request body' });
    }

    const req: ChatCompletionRequest = parsed.data;
    const userMessage = extractUserMessage(req.messages);
    if (!userMessage) {
      throw new HTTPException(400, { message: 'At least one user message is required' });
    }

    const systemPrompt = extractSystemPrompt(req.messages, req.system);

    let summary;
    try {
      summary = await bureau.createRun({
        message: userMessage,
        sessionId: req.session_id,
        systemPrompt,
        maximumSteps: req.maximum_steps,
      });
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

    if (req.stream) {
      // ── SSE streaming response ───────────────────────────────────
      return streamSSE(context, async (stream) => {
        // Poll for run completion and stream intermediate events.
        // The bureau emits live frames via subscribeLiveFrames; here we wait
        // for the run to settle and stream the final content as chunks.
        //
        // For now we await the run settling (from the store) and emit the
        // assistant content as a single chunk followed by [DONE]. The store
        // polling is a simple interval poll against bureau.getRun.
        //
        // A future enhancement could subscribe to live frames for real-time
        // streaming (the bureau already supports this via subscribeLiveFrames
        // and the WS event surface).
        const runId = summary.id;
        const POLL_INTERVAL_MS = 50;
        const POLL_TIMEOUT_MS = 300_000; // 5 minutes

        let elapsed = 0;
        let run = bureau.getRun(runId);

        while (run && run.status === 'running') {
          if (elapsed >= POLL_TIMEOUT_MS) {
            await stream.writeSSE({ data: JSON.stringify({ error: 'timeout' }), event: 'error' });
            await stream.writeSSE({ data: '[DONE]' });
            return;
          }

          await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          elapsed += POLL_INTERVAL_MS;
          run = bureau.getRun(runId);
        }

        if (!run) {
          await stream.writeSSE({
            data: JSON.stringify({ error: 'run not found' }),
            event: 'error',
          });
          await stream.writeSSE({ data: '[DONE]' });
          return;
        }

        // Emit the final content as a chunk.
        // stepDetails[n].content is always a string per RunStepDetail.
        const contentText = run.stepDetails?.at(-1)?.content ?? '';

        await stream.writeSSE({ data: buildStreamChunk(contentText, null) });
        await stream.writeSSE({ data: buildStreamChunk('', 'stop') });
        await stream.writeSSE({ data: '[DONE]' });
      });
    }

    // ── Non-streaming response ───────────────────────────────────────
    // Wait for the run to complete
    const runId = summary.id;
    const POLL_INTERVAL_MS = 50;
    const POLL_TIMEOUT_MS = 300_000;

    let elapsed = 0;
    let run = bureau.getRun(runId);

    while (run && run.status === 'running') {
      if (elapsed >= POLL_TIMEOUT_MS) {
        throw new HTTPException(504, { message: 'Run timed out' });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      elapsed += POLL_INTERVAL_MS;
      run = bureau.getRun(runId);
    }

    if (!run) {
      throw new HTTPException(404, { message: 'Run not found' });
    }

    // stepDetails[n].content is always a string per RunStepDetail.
    const contentText = run.stepDetails?.at(-1)?.content ?? '';

    return context.json(
      buildCompletionResponse(contentText, run.usage?.prompt ?? 0, run.usage?.completion ?? 0),
      200,
    );
  });

  return app;
}
