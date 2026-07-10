import type {
  ToolElicitationRequest,
  ToolElicitationRequester,
  ToolElicitationResult,
} from 'armorer';
import { jsonSchemaToZod } from 'armorer';
import { z } from 'zod';

import { ElicitationRequestedEvent, ElicitationResolvedEvent } from './events';
import type { EventDispatcher } from './loop';
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
 * import { createMcpElicitationResponder } from 'operative';
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

  return async (request: ToolElicitationRequest): Promise<ToolElicitationResult> => {
    const context = getContext();
    const schema = toZodSchema(request);

    emitter?.dispatch(new ElicitationRequestedEvent(context.step, request.message));
    const response = await onElicitation({ message: request.message, schema, context });
    const accepted = response !== null;
    emitter?.dispatch(new ElicitationResolvedEvent(context.step, accepted));

    if (!accepted) {
      return { action: 'decline' };
    }
    return { action: 'accept', content: toContentRecord(response.data) };
  };
}

/**
 * Converts the MCP request's schema into a Zod schema for `onElicitation`.
 *
 * URL-mode elicitation asks the user to open a link out-of-band and doesn't
 * carry a form schema; we model the response as a simple acknowledgement
 * rather than building the full `notifications/elicitation/complete`
 * subsystem, which no caller of this bridge currently needs.
 */
function toZodSchema(request: ToolElicitationRequest): z.ZodTypeAny {
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
