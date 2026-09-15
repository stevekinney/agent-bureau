import type {
  ToolElicitationRequest,
  ToolElicitationRequester,
  ToolElicitationResult,
} from 'armorer';
import { jsonSchemaToZod } from 'armorer';
import type { RuntimeServices } from 'lifecycle';
import { createDefaultRuntimeServices } from 'lifecycle';
import { z } from 'zod';

import type { EventDispatcher } from './loop';
import { createElicitationRequester } from './run-step-support';
import type { OnElicitation, StepContext } from './types';

/**
 * Options for {@link createMcpElicitationResponder}.
 */
export interface CreateMcpElicitationResponderOptions {
  /** The loop's injectable elicitation callback (the same one passed as `onElicitation`). */
  onElicitation: OnElicitation;
  /**
   * Resolves the `StepContext` to attach to each elicitation request. MCP
   * elicitation requests arrive out-of-band from a tool call already in
   * flight, so the caller supplies whatever step context is current (e.g.
   * tracked via `beforeToolExecution`/`afterToolExecution` hooks).
   */
  getContext: () => StepContext;
  /**
   * Optional event emitter. When provided, `ElicitationRequestedEvent` /
   * `ElicitationResolvedEvent` are dispatched around the call, matching the
   * events the in-loop `elicit()` helper already emits (see `run-step.ts`).
   */
  emitter?: EventDispatcher;
  runtime?: RuntimeServices;
}

/**
 * Bridges armorer's transport-agnostic MCP elicitation requester to
 * operative's `onElicitation` loop mechanism. Use this to answer elicitation
 * requests raised by a tool built with `createMCP` (the "MCP server"
 * direction) or received via `createMcpElicitationHandler` on an MCP client
 * (the "MCP client" direction) with the same approval/human-input flow the
 * loop already exposes to hooks via `elicit()`.
 *
 * @example
 * ```ts
 * import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
 * import { createMcpElicitationHandler } from 'armorer/mcp';
 * import { createMcpElicitationResponder } from '@lostgradient/operative';
 *
 * let currentContext: StepContext = { conversation, step: 0 };
 *
 * client.setRequestHandler(
 *   ElicitRequestSchema,
 *   createMcpElicitationHandler(
 *     createMcpElicitationResponder({
 *       onElicitation,
 *       getContext: () => currentContext,
 *       emitter,
 *     }),
 *   ),
 * );
 * ```
 */
export function createMcpElicitationResponder(
  options: CreateMcpElicitationResponderOptions,
): ToolElicitationRequester {
  const { onElicitation, getContext, emitter } = options;
  const runtime = options.runtime ?? createDefaultRuntimeServices();

  return async (request: ToolElicitationRequest): Promise<ToolElicitationResult> => {
    const context = getContext();
    const schema = toZodSchema(request);
    const message = toElicitationMessage(request);
    const elicit = createElicitationRequester(
      context.step,
      (question) => onElicitation(Object.freeze({ ...question, context })),
      context.conversation,
      context.signal,
      runtime,
      emitter,
    );
    const response = await elicit(message, schema);
    return response === null
      ? { action: 'decline' }
      : { action: 'accept', content: toContentRecord(response.data) };
  };
}

/**
 * `ElicitationRequest.message` is a plain string — `onElicitation`
 * implementations and the `elicitation.requested` event have no separate
 * slot for a URL. For URL-mode requests, fold the URL into the message so
 * callers can still present/launch it, instead of silently dropping it.
 */
function toElicitationMessage(request: ToolElicitationRequest): string {
  if (request.mode === 'url') {
    return `${request.message} (${request.url})`;
  }
  return request.message;
}

/**
 * Converts the MCP request's schema into a Zod schema for `onElicitation`.
 *
 * URL-mode elicitation asks the user to open a link out-of-band and doesn't
 * carry a form schema; we model the response as a simple acknowledgement
 * rather than building the full `notifications/elicitation/complete`
 * subsystem, which no caller of this bridge currently needs.
 */
function toZodSchema(request: ToolElicitationRequest): z.ZodType {
  if (request.mode === 'url') {
    return z.object({ acknowledged: z.boolean() });
  }
  return jsonSchemaToZod(request.schema ?? { type: 'object', properties: {} }) ?? z.object({});
}

function toContentRecord(data: unknown): Record<string, unknown> | undefined {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return undefined;
}
