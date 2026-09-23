import { materializeToolResult } from '@lostgradient/tool-protocol';

import { stableStringifyJson } from '../core/serialization/json';
import { policyPauseTierSymbol } from '../internal/approval-resume';
import type { ToolPolicyDecision } from '../is-tool';
import type { SatisfiedPolicyPause, ToolAction, ToolApprovalAction } from '../types';
import { computeDigest, normalizeToolContent } from './content';

export type ToolActionContext = {
  arguments: unknown;
  callId: string;
  policyVersion?: string | undefined;
  toolDefinitionRevision: string;
  toolName: string;
};

export function createToolAction(
  type: 'approval' | 'input',
  decision: ToolPolicyDecision,
  reason: string,
  context: ToolActionContext,
): ToolAction {
  if (type === 'approval') return createApprovalAction(decision, reason, context);
  const action: ToolAction = {
    type,
    message: coerceActionMessage(decision.action?.message, reason),
  };
  if (decision.action?.schema !== undefined)
    action.schema = normalizeToolContent(decision.action.schema);
  return action;
}

/**
 * Coerces an action's `message` to the `string` its type declares.
 *
 * `ToolAction.message` is declared `message?: string | undefined`, so a
 * non-string here is already a type violation — an untyped or JavaScript
 * policy, or a cast. It still has to be handled, because this value reaches
 * `signPendingApproval`, whose payload normalization runs the whole approval
 * through `JSON.stringify`. A BigInt there throws, and the throw surfaces as a
 * failed tool call rather than as the policy bug it is.
 *
 * Coercion rather than `normalizeToolContent`, which the sibling `schema` field
 * uses: that returns `JsonValue`, which is right for a field declared
 * `JSONValue` and wrong for one declared `string`. It would pass a plain object
 * or a bare number through unchanged — both survive it intact — leaving a
 * non-string in a field every consumer treats as a string.
 *
 * Nothing here may throw. `createToolAction` has two callers and only one is
 * issuance: the other is `policyPauseMatchesDescriptor`, which compares a
 * previously satisfied pause against a current decision on the resume path.
 * Neither wraps the call, and resume matching tolerates a non-serializable
 * message today. A guard that threw would introduce a new failure there.
 *
 * Coercion is a pure function of the value, so resume matching still compares
 * equal: the stored action was coerced when it was created, and the freshly
 * created one coerces the same input to the same string.
 *
 * Anything that cannot be turned into a useful string becomes the reason, which
 * is already the value this field takes when a policy supplies no message.
 */
function coerceActionMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'symbol') return value.description ?? fallback;
  try {
    // Objects and functions. Serializing preserves the content of a structured
    // message, which is the likeliest real mistake. `JSON.stringify` returns
    // undefined for a function and throws on a circular structure or a throwing
    // `toJSON`; both land on the fallback.
    //
    // Deliberately not `String(value)` here. It would yield `[object Object]`
    // for the common case and a function's whole source text for the other —
    // neither belongs in a message a human reads to decide on an approval — and
    // `no-base-to-string` rejects it, correctly.
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string') return serialized;
  } catch {
    /* falls through to the reason */
  }
  return fallback;
}

export function policyPauseMatchesSatisfiedPause(
  decision: ToolPolicyDecision,
  satisfiedPause: SatisfiedPolicyPause,
  context: ToolActionContext,
): boolean {
  if (
    !policyPauseMatchesDescriptor(decision, satisfiedPause.action, satisfiedPause.reason, context)
  ) {
    return false;
  }
  return (
    satisfiedPause.tier !== undefined &&
    satisfiedPause.tier === (decision[policyPauseTierSymbol] ?? 'tool')
  );
}

function createApprovalAction(
  decision: ToolPolicyDecision,
  reason: string,
  context: ToolActionContext,
): ToolApprovalAction {
  const policyVersion = decision.action?.policyVersion ?? context.policyVersion ?? 'policy:1';
  const actionInput = {
    type: 'approval' as const,
    message: coerceActionMessage(decision.action?.message, reason),
    risk: decision.action?.risk ?? 'high',
    operation: decision.action?.operation ?? {
      kind: 'other' as const,
      argsPreview: normalizeToolContent(context.arguments),
    },
    ...(decision.action?.sandbox !== undefined ? { sandbox: decision.action.sandbox } : {}),
    ...(decision.action?.env !== undefined ? { env: [...decision.action.env] } : {}),
    ...(decision.action?.snapshotId !== undefined
      ? { snapshotId: decision.action.snapshotId }
      : {}),
    ...(decision.action?.expiresAt !== undefined ? { expiresAt: decision.action.expiresAt } : {}),
    ...(decision.action?.editableArgs !== undefined
      ? { editableArgs: decision.action.editableArgs }
      : {}),
    policyVersion,
    idempotencyKey:
      decision.action?.idempotencyKey ?? createApprovalIdempotencyKey(decision, reason, context),
  };
  const materialized = materializeToolResult({
    callId: context.callId,
    outcome: 'action_required',
    content: reason,
    action: actionInput,
  });
  if (materialized.action?.type !== 'approval') {
    throw new Error('Approval action materialization did not produce an approval action.');
  }
  return materialized.action;
}

function createApprovalIdempotencyKey(
  decision: ToolPolicyDecision,
  reason: string,
  context: ToolActionContext,
): string {
  const payload = normalizeToolContent({
    toolName: context.toolName,
    toolDefinitionRevision: context.toolDefinitionRevision,
    pauseTier: decision[policyPauseTierSymbol] ?? 'tool',
    callId: context.callId,
    arguments: context.arguments,
    reason,
    policyVersion: decision.action?.policyVersion ?? context.policyVersion ?? 'policy:1',
    risk: decision.action?.risk ?? 'high',
    operation: decision.action?.operation ?? { kind: 'other', argsPreview: context.arguments },
    sandbox: decision.action?.sandbox,
    env: decision.action?.env,
    snapshotId: decision.action?.snapshotId,
    expiresAt: decision.action?.expiresAt,
    editableArgs: decision.action?.editableArgs,
  });
  return `approval:${computeDigest(payload, 'sha256')}`;
}

function policyPauseMatchesDescriptor(
  decision: ToolPolicyDecision,
  action: ToolAction,
  reason: string | undefined,
  context: ToolActionContext,
): boolean {
  const type = decision.status === 'needs_input' ? 'input' : 'approval';
  const decisionReason = decision.reason ?? `Tool execution requires ${type}`;
  const decisionAction = createToolAction(type, decision, decisionReason, context);
  return (
    reason === decisionReason &&
    stableStringifyJson(normalizeToolContent(action)) ===
      stableStringifyJson(normalizeToolContent(decisionAction))
  );
}
