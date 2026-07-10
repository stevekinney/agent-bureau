/**
 * A2A (Agent2Agent) JSON-RPC server facade (AB-71): `POST /a2a`.
 *
 * Server-first per Steve's AB-70 ruling — this ships the server side only;
 * an A2A *client* (calling other agents' A2A endpoints) is a deferred
 * follow-up, not built here.
 *
 * Architecturally this is `routes/openai-compat.ts`'s pattern: a typed-dispatch
 * HTTP facade in front of `bureau.createRun`/`getRun`/`abortRun`, translating
 * bureau's run lifecycle into a foreign wire protocol's task lifecycle. See
 * `routes/a2a-agent-card.ts` for the accompanying Agent Card endpoint.
 *
 * ── Spec verification ────────────────────────────────────────────────────
 * Verified against the A2A Protocol Specification v1.0.0 — GitHub
 * `a2aproject/A2A`, `docs/specification.md` + `specification/a2a.proto` at
 * commit `3303592588e388e62e0f69f701af531d2f4e3991` (tag `v1.0.1`, identical
 * spec text to `v1.0.0`).
 *
 * IMPORTANT — method naming discrepancy vs. this item's acceptance criteria:
 * the acceptance criteria names the JSON-RPC methods `message/send`,
 * `tasks/get`, `tasks/cancel` (the naming convention of the pre-1.0 A2A
 * drafts). The **current, released v1.0.0 spec's JSON-RPC binding** (Section
 * 5.3 "Method Mapping Reference", Section 9.4 "Core Methods") instead uses
 * the RPC method names shared with the gRPC binding: `SendMessage`,
 * `GetTask`, `CancelTask` (also `ListTasks`, `SubscribeToTask`,
 * `SendStreamingMessage`, and the push-notification-config CRUD methods).
 * This implementation follows the verified v1.0.0 spec's actual method
 * names, not the acceptance criteria's pre-1.0 naming — a client built
 * against the current reference SDK would send `SendMessage`, not
 * `message/send`.
 *
 * ── Implemented methods ──────────────────────────────────────────────────
 * - `SendMessage` — creates a new task, or (when `message.taskId` names a
 *   task parked `TASK_STATE_INPUT_REQUIRED`) resumes it via the AB-20/21
 *   human-input park (`Bureau.resolveReview`). Blocks until the task reaches
 *   a terminal or interrupted state by default (`configuration.
 *   returnImmediately: false`, the spec default) — pass `returnImmediately:
 *   true` for the non-blocking variant.
 * - `GetTask` — reads `Bureau.getRun`.
 * - `CancelTask` — `Bureau.abortRun`.
 *
 * ── Deferred / not implemented (documented, not silently dropped) ────────
 * - **Streaming** (`SendStreamingMessage`, `SubscribeToTask`, the SSE
 *   binding): the spec permits non-streaming servers — `AgentCapabilities.
 *   streaming` on the Agent Card is the client-facing signal, and this
 *   server declares `streaming: false`. Follow-up work.
 * - **`ListTasks`**, the push-notification-config CRUD methods, and
 *   `GetExtendedAgentCard`: not implemented — return `MethodNotFoundError`.
 * - **`TASK_STATE_REJECTED`**: bureau has no pre-admission "agent declines
 *   the task" verdict distinguishable after a `Task` exists — an
 *   admission-time rejection (e.g. AB-13 flow-control) surfaces as a
 *   `RATE_LIMITED`/`BAD_REQUEST` JSON-RPC error from `SendMessage` itself,
 *   before any `Task` is created, so `REJECTED` is never returned as a task
 *   state.
 * - **`TASK_STATE_AUTH_REQUIRED`**: bureau has no mid-task OAuth delegation
 *   primitive; not modeled.
 * - **A2A client** (calling other agents): explicitly deferred per AB-70.
 *
 * ── Task-state mapping (run → task) ──────────────────────────────────────
 * | Bureau run state                                          | A2A `TaskState`         |
 * | :--------------------------------------------------------- | :---------------------- |
 * | `status: 'running'`, no steps yet                           | `TASK_STATE_SUBMITTED`  |
 * | `status: 'running'`, steps completed, not parked            | `TASK_STATE_WORKING`    |
 * | `status: 'running'`, parked on `requestHumanInput`           | `TASK_STATE_INPUT_REQUIRED` |
 * | `status: 'aborted'`                                          | `TASK_STATE_CANCELED`   |
 * | `status: 'completed'`/`'error'`, `finishReason` failure       | `TASK_STATE_FAILED`     |
 * | `status: 'completed'`, `finishReason` success                | `TASK_STATE_COMPLETED`  |
 *
 * ── Conformance coverage ──────────────────────────────────────────────────
 * Request/response fixtures are encoded as tests in `a2a.test.ts`, hand-built
 * from the spec's own JSON-RPC examples (Section 6 "Common Workflows",
 * Section 9.4 "Core Methods") — envelope shape, `SendMessage`/`GetTask`/
 * `CancelTask` request params, the standard + A2A-specific JSON-RPC error
 * codes (Section 9.5 / Section 5.4). These are NOT validated against the
 * reference `a2a-sdk` conformance suite (no network access in this
 * environment) — that suite, and multi-transport (gRPC/REST) parity, are the
 * checks that still need the live reference implementation.
 */
import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { z } from 'zod';

import { resolvePrincipal } from '../middleware/authentication';
import { isRunFailure } from '../run-outcome';
import type { Bureau, CreateRunRequest, PendingHumanWaitReview, RunDetail } from '../types';

// ── A2A wire types (JSON, camelCase — Section 5.5 of the spec) ───────────

type A2ATaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED';

interface A2AMessage {
  messageId: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: { text: string }[];
  taskId?: string;
  contextId?: string;
}

interface A2AArtifact {
  artifactId: string;
  name?: string;
  parts: { text: string }[];
}

interface A2ATask {
  id: string;
  contextId: string;
  status: { state: A2ATaskState; message?: A2AMessage; timestamp: string };
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

// ── JSON-RPC 2.0 envelope ─────────────────────────────────────────────────

const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema.optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

/** Thrown by method handlers to produce a specific JSON-RPC error response. */
class A2AError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(shape: JsonRpcErrorShape) {
    super(shape.message);
    this.code = shape.code;
    this.data = shape.data;
  }
}

// Standard JSON-RPC 2.0 error codes (Section 9.5).
const INVALID_REQUEST = { code: -32600, message: 'Request payload validation error' };
const METHOD_NOT_FOUND = { code: -32601, message: 'Method not found' };
const INVALID_PARAMS = { code: -32602, message: 'Invalid parameters' };
const INTERNAL_ERROR = { code: -32603, message: 'Internal error' };
// A2A-specific error codes (Section 5.4 "Error Code Mappings").
const TASK_NOT_FOUND = { code: -32001, message: 'Task not found' };
const TASK_NOT_CANCELABLE = { code: -32002, message: 'Task cannot be canceled' };
const UNSUPPORTED_OPERATION = { code: -32004, message: 'Unsupported operation' };
// -32000 is in the general JSON-RPC reserved server-error range
// (-32000..-32099) but outside A2A's own reserved sub-range (-32001..-32099)
// — used here for bureau-specific admission failures the spec has no
// dedicated code for (AB-13 flow control).
const RATE_LIMITED = { code: -32000, message: 'Server error: rate limited' };

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function jsonRpcError(id: JsonRpcId, error: JsonRpcErrorShape) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: {
      code: error.code,
      message: error.message,
      ...(error.data ? { data: error.data } : {}),
    },
  };
}

/** Maps a thrown error to a JSON-RPC error shape for the response envelope. */
function toJsonRpcError(error: unknown): JsonRpcErrorShape {
  if (error instanceof A2AError) {
    return { code: error.code, message: error.message, data: error.data };
  }
  if (error instanceof BureauError) {
    if (error.code === 'NOT_FOUND') return { ...TASK_NOT_FOUND, message: error.message };
    if (error.code === 'CONFLICT') return { ...TASK_NOT_CANCELABLE, message: error.message };
    if (error.code === 'BAD_REQUEST') return { ...INVALID_PARAMS, message: error.message };
    if (error.code === 'RATE_LIMITED') return { ...RATE_LIMITED, message: error.message };
    // NOT_CONFIGURED (no generate configured) — an operator/deployment
    // problem, not a caller mistake.
    return { ...INTERNAL_ERROR, message: error.message };
  }
  return INTERNAL_ERROR;
}

// ── Request param schemas ─────────────────────────────────────────────────

const MessagePartSchema = z.object({ text: z.string() });

const SendMessageParamsSchema = z.object({
  message: z.object({
    messageId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    contextId: z.string().min(1).optional(),
    role: z.enum(['ROLE_USER', 'ROLE_AGENT']).optional(),
    parts: z.array(MessagePartSchema).min(1),
  }),
  configuration: z
    .object({
      returnImmediately: z.boolean().optional(),
      historyLength: z.number().int().nonnegative().optional(),
    })
    .partial()
    .optional(),
});

const GetTaskParamsSchema = z.object({
  id: z.string().min(1),
  historyLength: z.number().int().nonnegative().optional(),
});

const CancelTaskParamsSchema = z.object({ id: z.string().min(1) });

/** Parses `params` against `schema`, converting a validation failure into `InvalidParamsError`. */
function parseParams<TSchema extends z.ZodTypeAny>(
  params: unknown,
  schema: TSchema,
): z.infer<TSchema> {
  const result = schema.safeParse(params ?? {});
  if (!result.success) {
    throw new A2AError({ ...INVALID_PARAMS, data: result.error.issues });
  }
  return result.data;
}

// ── Run → Task mapping ────────────────────────────────────────────────────

function agentStatusMessage(text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    role: 'ROLE_AGENT',
    parts: [{ text }],
  };
}

/** Concatenates a message's text parts (this v1 server accepts text-only content). */
function flattenMessageText(message: { parts: { text: string }[] }): string {
  return message.parts.map((part) => part.text).join('\n');
}

function deriveTaskState(
  bureau: Bureau,
  detail: RunDetail,
): { state: A2ATaskState; statusMessage?: A2AMessage } {
  if (detail.status === 'aborted') {
    return { state: 'TASK_STATE_CANCELED' };
  }

  if (detail.status === 'running') {
    const parked = bureau
      .listPendingReviews()
      .find(
        (review): review is PendingHumanWaitReview =>
          review.kind === 'human-wait' && review.runId === detail.id,
      );
    if (parked) {
      return {
        state: 'TASK_STATE_INPUT_REQUIRED',
        statusMessage: agentStatusMessage(parked.prompt ?? 'Additional input is required.'),
      };
    }
    return {
      state: detail.stepDetails.length === 0 ? 'TASK_STATE_SUBMITTED' : 'TASK_STATE_WORKING',
    };
  }

  // status is 'completed' or 'error' — discriminate success vs. failure by
  // finishReason (see run-outcome.ts).
  if (isRunFailure(detail)) {
    const message =
      typeof detail.error === 'string' ? detail.error : (detail.finishReason ?? 'Task failed.');
    return { state: 'TASK_STATE_FAILED', statusMessage: agentStatusMessage(message) };
  }
  return { state: 'TASK_STATE_COMPLETED' };
}

/** Builds the run's step transcript as A2A message history, newest last. */
function buildHistory(detail: RunDetail, historyLength: number | undefined): A2AMessage[] {
  const history = detail.stepDetails
    .filter((step) => step.content.length > 0)
    .map((step) => ({
      messageId: `${detail.id}:step-${step.step}`,
      role: 'ROLE_AGENT' as const,
      parts: [{ text: step.content }],
    }));
  if (historyLength === undefined) return history;
  if (historyLength === 0) return [];
  return history.slice(-historyLength);
}

function buildTask(
  bureau: Bureau,
  detail: RunDetail,
  options?: { historyLength?: number },
): A2ATask {
  const { state, statusMessage } = deriveTaskState(bureau, detail);
  const timestamp = new Date(
    detail.events.at(-1)?.timestamp ?? detail.startedAt ?? Date.now(),
  ).toISOString();

  const task: A2ATask = {
    id: detail.id,
    contextId: detail.sessionId,
    status: { state, timestamp, ...(statusMessage ? { message: statusMessage } : {}) },
    history: buildHistory(detail, options?.historyLength),
    metadata: { agentName: detail.agentName ?? null, usage: detail.usage },
  };

  if (state === 'TASK_STATE_COMPLETED') {
    const finalContent = detail.stepDetails.at(-1)?.content ?? '';
    task.artifacts = [
      { artifactId: `${detail.id}:result`, name: 'Result', parts: [{ text: finalContent }] },
    ];
  }

  return task;
}

/** Waits until `runId` reaches a terminal state OR parks on a human-input wait, whichever first. */
async function awaitTerminalOrInterrupted(bureau: Bureau, runId: string): Promise<void> {
  const runState = bureau.store.getRun(runId);
  if (!runState || runState.status !== 'running') return;

  await Promise.race([
    runState.activeRun.result.catch(() => undefined),
    new Promise<void>((resolve) => {
      runState.activeRun.addEventListener('multiagent.human-wait.parked', () => resolve(), {
        once: true,
      });
    }),
  ]);
}

// ── Method handlers ────────────────────────────────────────────────────────

async function handleSendMessage(
  bureau: Bureau,
  params: unknown,
  principal: string,
): Promise<{ task: A2ATask }> {
  const { message, configuration } = parseParams(params, SendMessageParamsSchema);
  const text = flattenMessageText(message);

  if (message.taskId) {
    // Resume an existing parked task via the AB-20/21 human-input park.
    const existing = bureau.getRun(message.taskId);
    if (!existing) throw new A2AError(TASK_NOT_FOUND);

    const parked = bureau
      .listPendingReviews()
      .find(
        (review): review is PendingHumanWaitReview =>
          review.kind === 'human-wait' && review.runId === message.taskId,
      );
    if (!parked) {
      throw new A2AError({
        ...UNSUPPORTED_OPERATION,
        message: 'Task is not awaiting input and cannot accept a follow-up message',
      });
    }

    await bureau.resolveReview({
      id: parked.id,
      decision: 'approve',
      principal,
      payload: text,
    });

    if (configuration?.returnImmediately !== true) {
      await awaitTerminalOrInterrupted(bureau, message.taskId);
    }
    const resumed = bureau.getRun(message.taskId);
    if (!resumed) throw new A2AError(TASK_NOT_FOUND);
    return { task: buildTask(bureau, resumed, { historyLength: configuration?.historyLength }) };
  }

  const request: CreateRunRequest = { message: text, principal };
  let summary;
  try {
    summary = await bureau.createRun(request);
  } catch (error) {
    if (error instanceof BureauError) throw error;
    throw new A2AError(INTERNAL_ERROR);
  }

  if (configuration?.returnImmediately !== true) {
    await awaitTerminalOrInterrupted(bureau, summary.id);
  }
  const detail = bureau.getRun(summary.id);
  if (!detail) throw new A2AError(INTERNAL_ERROR);
  return { task: buildTask(bureau, detail, { historyLength: configuration?.historyLength }) };
}

function handleGetTask(bureau: Bureau, params: unknown): { task: A2ATask } {
  const { id, historyLength } = parseParams(params, GetTaskParamsSchema);
  const detail = bureau.getRun(id);
  if (!detail) throw new A2AError(TASK_NOT_FOUND);
  return { task: buildTask(bureau, detail, { historyLength }) };
}

function handleCancelTask(bureau: Bureau, params: unknown): { task: A2ATask } {
  const { id } = parseParams(params, CancelTaskParamsSchema);
  let summary;
  try {
    summary = bureau.abortRun(id);
  } catch (error) {
    if (error instanceof BureauError) throw error;
    throw new A2AError(INTERNAL_ERROR);
  }
  const detail = bureau.getRun(id);
  if (!detail) throw new A2AError(TASK_NOT_FOUND);
  // `abortRun`'s returned `RunSummary.status` is the authoritative
  // `'aborted'` verdict — the store's own `RunDetail.status` reflects it only
  // once the underlying run loop's abort signal has actually propagated,
  // which is not necessarily synchronous with this call returning.
  return { task: buildTask(bureau, { ...detail, status: summary.status }) };
}

async function dispatch(
  bureau: Bureau,
  method: string,
  params: unknown,
  principal: string,
): Promise<unknown> {
  switch (method) {
    case 'SendMessage':
      return handleSendMessage(bureau, params, principal);
    case 'GetTask':
      return handleGetTask(bureau, params);
    case 'CancelTask':
      return handleCancelTask(bureau, params);
    // Recognized but unsupported (streaming — see the header comment's
    // "Deferred" section). Section 8.5 of the spec: "If AgentCard.
    // capabilities.streaming is false or not present, attempts to use
    // SendStreamingMessage or SubscribeToTask operations MUST return
    // UnsupportedOperationError" — distinct from an unrecognized method.
    case 'SendStreamingMessage':
    case 'SubscribeToTask':
      throw new A2AError({
        ...UNSUPPORTED_OPERATION,
        message:
          'Streaming is not supported by this server (AgentCard.capabilities.streaming: false)',
      });
    default:
      throw new A2AError(METHOD_NOT_FOUND);
  }
}

export function createA2ARoutes(bureau: Bureau) {
  const app = new Hono();

  app.post('/', async (context) => {
    let rawBody: unknown;
    try {
      rawBody = await context.req.json();
    } catch {
      return context.json(
        jsonRpcError(null, { code: -32700, message: 'Invalid JSON payload' }),
        400,
      );
    }

    const envelope = JsonRpcRequestSchema.safeParse(rawBody);
    if (!envelope.success) {
      const maybeId =
        rawBody !== null && typeof rawBody === 'object' && 'id' in rawBody
          ? (rawBody as { id: unknown }).id
          : null;
      const id = JsonRpcIdSchema.safeParse(maybeId);
      return context.json(jsonRpcError(id.success ? id.data : null, INVALID_REQUEST), 200);
    }

    const { id = null, method, params } = envelope.data;

    try {
      const result = await dispatch(bureau, method, params, resolvePrincipal(context));
      return context.json(jsonRpcResult(id, result), 200);
    } catch (error) {
      return context.json(jsonRpcError(id, toJsonRpcError(error)), 200);
    }
  });

  return app;
}

export type { A2AArtifact, A2AMessage, A2ATask, A2ATaskState };
