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
 * Format a run result as an OpenAI-compat SSE content chunk.
 *
 * When `isLast` is true the delta is empty and `finish_reason` is `'stop'`
 * (the sentinel chunk that closes the assistant turn). When false, `content`
 * is the assistant text and `finish_reason` is `null`.
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
 * Format a run failure as an in-band SSE error event.
 *
 * Once the SSE stream body has started (status 200 is committed), HTTP-level
 * error codes can no longer be sent. OpenAI-compatible clients expect errors
 * on the streaming path to arrive as `{"error":{...}}` SSE events — this
 * matches the wire format used by the OpenAI API itself.
 */
function formatSseErrorChunk(model: string, message: string): string {
  const chunk = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    error: { message, type: 'server_error' },
    choices: [],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * SSE heartbeat interval in milliseconds.
 *
 * Must be shorter than the reverse-proxy and server idle timeout so the
 * connection is never silently killed during long silences (e.g. a parked
 * human-in-the-loop workflow or a slow tool call).
 *
 * Bun.serve defaults `idleTimeout` to 10 s; common reverse proxies (nginx,
 * AWS ALB) default to 60 s. We pick 8 s — safely under both.
 */
const SSE_HEARTBEAT_INTERVAL_MS = 8_000;

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

    // ── SSE streaming path ───────────────────────────────────────────────────
    // Return the Response immediately — before the run settles — so the HTTP
    // connection opens and the client receives headers right away. The run
    // loop continues asynchronously; events feed into the ReadableStream.
    //
    // Errors that occur AFTER the stream opens are delivered in-band as an
    // OpenAI-compat error chunk (the HTTP status is already committed to 200 at
    // this point; returning a 500 is impossible once the body has started).
    if (stream) {
      const runState = bureau.store.getRun(summary.id);

      // No-arg cleanups captured from start() so the stream's cancel() and the
      // terminal close() can detach the run listeners and stop the heartbeat
      // timer — without this, a client disconnect would leave the listeners
      // attached and the run executing (and billing provider tokens) for an
      // audience that has left.
      let detachRunListeners: () => void = () => {};
      let stopHeartbeat: () => void = () => {};

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();

          function enqueue(chunk: string): void {
            controller.enqueue(encoder.encode(chunk));
          }

          function close(): void {
            stopHeartbeat();
            detachRunListeners();
            try {
              controller.close();
            } catch {
              // Already closed — ignore.
            }
          }

          // Send an initial comment so the connection is known-open immediately.
          enqueue(': connected\n\n');

          // Heartbeat timer: sends SSE comment lines at a fixed cadence so that
          // reverse proxies and HTTP clients do not close the connection during
          // long silences (e.g. slow tool calls, parked human-in-the-loop runs).
          // SSE comment lines (`:<text>\n\n`) are ignored by compliant clients.
          const heartbeatId = setInterval(() => {
            try {
              enqueue(': heartbeat\n\n');
            } catch {
              close();
            }
          }, SSE_HEARTBEAT_INTERVAL_MS);

          stopHeartbeat = (): void => {
            clearInterval(heartbeatId);
            stopHeartbeat = () => {};
          };

          if (!runState) {
            // No active run state — run may have already settled synchronously.
            // Emit a single empty content chunk and close.
            enqueue(formatSseChunk(agentName, '', false));
            enqueue(formatSseChunk(agentName, '', true));
            enqueue('data: [DONE]\n\n');
            close();
            return;
          }

          // Emit the run's terminal outcome exactly once, then close. Shared by
          // the `run.completed`/`run.aborted` listeners AND the already-settled
          // fast path below so success/error/abort discrimination can never drift
          // between them. `settled` guards against a double-emit if a listener
          // and the fast path both reach here (they can't enqueue into a closed
          // stream, but the guard keeps the contract explicit).
          let settled = false;
          const emitTerminal = (
            outcome:
              | { kind: 'success'; content: string }
              | { kind: 'error'; message: string }
              | { kind: 'aborted' },
          ): void => {
            if (settled) return;
            settled = true;
            if (outcome.kind === 'success') {
              enqueue(formatSseChunk(agentName, outcome.content, false));
              enqueue(formatSseChunk(agentName, '', true));
            } else if (outcome.kind === 'error') {
              enqueue(formatSseErrorChunk(agentName, outcome.message));
            } else {
              enqueue(formatSseErrorChunk(agentName, 'Run was aborted before completion'));
            }
            enqueue('data: [DONE]\n\n');
            close();
          };

          // `run.completed` fires in ALL terminal cases (success, error, or
          // budget-exceeded). The `finishReason` field discriminates:
          //   - 'stop-condition' / 'maximum-steps' — success → send content chunk
          //   - 'error' / 'elicitation-denied' / 'budget-exceeded' — failure → send error chunk
          // Note: the loop also dispatches `run.error` BEFORE `run.completed` on
          // the error path. We listen only to `run.completed` so we never enqueue
          // into an already-closed stream.
          const onCompleted = (event: {
            finishReason: string;
            error?: unknown;
            content: string;
          }): void => {
            const isError =
              event.finishReason === 'error' ||
              event.finishReason === 'budget-exceeded' ||
              event.finishReason === 'elicitation-denied';
            if (isError) {
              emitTerminal({
                kind: 'error',
                message:
                  event.error instanceof Error ? event.error.message : 'Run failed with an error',
              });
            } else {
              emitTerminal({ kind: 'success', content: event.content });
            }
          };
          runState.activeRun.addEventListener('run.completed', onCompleted);

          // `run.aborted` fires when the run is aborted (no `run.completed`
          // counterpart is dispatched on the abort path).
          const onAborted = (): void => {
            emitTerminal({ kind: 'aborted' });
          };
          runState.activeRun.addEventListener('run.aborted', onAborted);

          detachRunListeners = (): void => {
            runState.activeRun.removeEventListener('run.completed', onCompleted);
            runState.activeRun.removeEventListener('run.aborted', onAborted);
          };

          // Already-settled fast path. For very fast `stream: true` requests the
          // run can schedule and reach a terminal state BEFORE this start()
          // callback attaches the listeners above (the active run starts on a
          // microtask, ahead of the awaited handler continuation). In that case
          // `run.completed`/`run.aborted` already fired and will never fire again,
          // so the client would receive only heartbeats — no content, no [DONE].
          // The store synchronously records the terminal RunState as the run's
          // events pass through it (its subscription is wired at register() time,
          // before this callback runs), so re-read it now and emit the final
          // result directly if the run has already settled (PRRT_kwDORvupsc6MddwF).
          const settledState = bureau.store.getRun(summary.id);
          if (settledState && settledState.status !== 'running') {
            // Discriminate by finishReason, MIRRORING the run.completed listener
            // above — not by store status. A 'budget-exceeded'/'elicitation-denied'
            // run lands in the store as status 'completed' (the store only marks
            // 'error' when status was already error), so a status-based branch
            // would emit a content chunk where the listener emits an error chunk.
            const isError =
              settledState.finishReason === 'error' ||
              settledState.finishReason === 'budget-exceeded' ||
              settledState.finishReason === 'elicitation-denied';
            if (settledState.status === 'aborted') {
              emitTerminal({ kind: 'aborted' });
            } else if (isError) {
              const error = settledState.error;
              emitTerminal({
                kind: 'error',
                message: error instanceof Error ? error.message : 'Run failed with an error',
              });
            } else {
              emitTerminal({
                kind: 'success',
                content: settledState.steps.at(-1)?.content ?? '',
              });
            }
          }
        },

        // Fired when the consumer cancels the stream — i.e. the HTTP client
        // disconnected (or an intermediary timed out). Stop the bill: abort the
        // active run so the agent loop drops its in-flight provider call instead
        // of running to completion for an audience that has left. Detach our
        // listeners and stop the heartbeat so the now-orphaned stream controller
        // is never touched again.
        cancel() {
          stopHeartbeat();
          detachRunListeners();
          runState?.activeRun.abort('client disconnected from SSE stream');
        },
      });

      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // ── Non-streaming path ───────────────────────────────────────────────────
    // Await the run's result promise before reading stepDetails so the response
    // is never empty with a live provider. The loop resolves for all terminal
    // states (completed, error, aborted); the try/catch guards against
    // unexpected rejections only.
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

    if (runDetail.status === 'aborted') {
      throw new HTTPException(500, { message: 'Run was aborted before completion' });
    }

    // Reject ALL failure finish reasons, not just store status 'error'. A run
    // that fails with 'budget-exceeded' or 'elicitation-denied' arrives via
    // run.completed and lands in the store as status 'completed' (the store only
    // marks 'error' when status was already error), so a status-only check would
    // return a 200 chat completion with partial content. Discriminate by
    // finishReason — mirroring the streaming branch (PRRT_kwDORvupsc6MkTtu).
    const isFailure =
      runDetail.status === 'error' ||
      runDetail.finishReason === 'error' ||
      runDetail.finishReason === 'budget-exceeded' ||
      runDetail.finishReason === 'elicitation-denied';
    if (isFailure) {
      const message = runDetail.error ?? 'Run failed with an unspecified error';
      throw new HTTPException(500, {
        message: typeof message === 'string' ? message : 'Run failed',
      });
    }

    const lastStep = runDetail.stepDetails.at(-1);
    const textContent = lastStep?.content ?? '';

    return context.json(formatChatCompletion(agentName, textContent), 200);
  });

  return app;
}
