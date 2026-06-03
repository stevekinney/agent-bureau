import { activity } from '@lostgradient/weft';
import type { ToolExecutionResult } from 'armorer';
import type { ToolCall } from 'interoperability';

import { getRunDeps } from './deps-registry';

/**
 * Input to the {@link executeToolActivity}. Plain and cloneable: the activity
 * crosses a worker boundary, so it carries the `runId` (to resolve the toolbox
 * from the deps registry) and the single materialized {@link ToolCall}, never
 * the non-serializable toolbox itself.
 */
export interface ExecuteToolInput {
  runId: string;
  toolCall: ToolCall;
}

/**
 * The durable, JSON-cloneable projection of a {@link ToolExecutionResult}.
 *
 * `ToolExecutionResult` carries an `AsyncIterable` `stream` and an `unknown`
 * `result` that are not guaranteed `structuredClone`-safe; a checkpointed
 * activity result must be. We persist the JSON-safe subset — `content` (typed
 * `JSONValue`) is the canonical payload — and drop the stream.
 *
 * TODO(weft-integration): streaming tool output (`stream`) is durable only as
 * its collected `content` here; intra-tool token deltas flow through the
 * in-process emitter and are not checkpointed (design seam #10).
 */
export interface DurableToolResult {
  callId: string;
  toolCallId: string;
  toolName: string;
  outcome: 'success' | 'error' | 'action_required';
  content: ToolExecutionResult['content'];
  error?: ToolExecutionResult['error'];
}

/** Project a runtime {@link ToolExecutionResult} onto its cloneable subset. */
export function toDurableToolResult(result: ToolExecutionResult): DurableToolResult {
  return {
    callId: result.callId,
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    outcome: result.outcome,
    content: result.content,
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * The single side-effecting activity in the durable agent run: executing one
 * tool call. Tool execution is the only operation that genuinely reaches outside
 * the workflow (network, disk, external services), so it is the one operation
 * that must be an at-least-once retryable activity with a checkpointed result.
 *
 * The toolbox is resolved per-run from the {@link getRunDeps deps registry} by
 * `runId` rather than passed as input, because a `Toolbox` is a non-serializable
 * closure that cannot cross the activity boundary.
 *
 * `idempotent: true` + the workflow's per-call `idempotencyKey = toolCall.id`
 * wire forward-compatibility for activity reconciliation.
 *
 * TODO(weft-integration): `idempotencyKey` does NOT provide cross-crash
 * deduplication in Weft 0.2.0 — a tool that commits an external effect and then
 * crashes before the checkpoint records its result will re-fire on resume
 * (design seam #4). Non-idempotent tools must supply their own external
 * idempotency for irreversible effects.
 */
export const executeToolActivity = activity({
  name: 'executeTool',
  idempotent: true,
  execute: async (input: ExecuteToolInput): Promise<DurableToolResult> => {
    const { toolbox } = getRunDeps(input.runId);
    const result = await toolbox.execute(input.toolCall);
    return toDurableToolResult(result);
  },
});
