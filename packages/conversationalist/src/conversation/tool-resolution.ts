import { materializeToolResult, materializeToolResultAsync } from '@lostgradient/tool-protocol';
import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from '../environment';
import {
  createIntegrityError,
  createInvalidInputError,
  createToolResultNotFoundError,
} from '../errors';
import type {
  AppendableToolResult,
  ConversationHistory as Conversation,
  Message,
  MessageInput,
  ToolResult,
} from '../types';
import { createMessage } from '../utilities/message';
import { getOrderedMessages } from '../utilities/message-store';
import { toReadonly } from '../utilities/type-helpers';
import type { AppendToolResultOptions } from './tool-interactions';
import { ensureConversationSafe } from './validation';

/**
 * Locates the single tool-result message for `callId`, or throws
 * `error:not-found`/`error:integrity` per {@link resolveToolResult}'s
 * documented not-found/ambiguous-match semantics. Shared by the sync and
 * async entry points.
 */
function findToolResultMessageToReplace(
  conversation: Conversation,
  callId: string,
): Message & { toolResult: ToolResult } {
  const matches = getOrderedMessages(conversation).filter(
    (message): message is Message & { toolResult: ToolResult } =>
      message.role === 'tool-result' &&
      message.toolResult !== undefined &&
      message.toolResult.callId === callId,
  );

  const original = matches[0];
  if (!original) {
    throw createToolResultNotFoundError(callId);
  }

  if (matches.length > 1) {
    throw createIntegrityError(`multiple tool-result messages found for callId: ${callId}`, {
      callId,
      messageIds: matches.map((message) => message.id),
    });
  }

  return original;
}

function createToolResultDraft(
  original: Message & { toolResult: ToolResult },
  normalizedToolResult: ToolResult,
  resolvedOptions: AppendToolResultOptions | undefined,
): MessageInput {
  return {
    role: 'tool-result',
    content:
      resolvedOptions?.content ??
      (typeof original.content === 'string' ? original.content : [...original.content]),
    metadata: { ...(resolvedOptions?.metadata ?? original.metadata) },
    hidden: resolvedOptions?.hidden ?? original.hidden,
    toolResult: normalizedToolResult,
    tokenUsage: resolvedOptions?.tokenUsage ?? original.tokenUsage,
    cacheBoundary: original.cacheBoundary,
  };
}

/**
 * Builds the replacement `Conversation` once a normalized `toolResult` and
 * its target message have been resolved. Runs `environment.plugins` over a
 * fresh `MessageInput` draft of the replacement content (the same pipeline
 * `appendMessages` runs for newly-appended messages, e.g. PII redaction),
 * then merges the processed result back onto the *original* message's
 * `id`/`createdAt`/`position` — plugins can't run through
 * `appendMessages`'s own pipeline here, since that pipeline treats any
 * input carrying an `id` as an already-processed prebuilt `Message` and
 * skips plugins entirely, which is exactly the case for this in-place
 * replacement.
 */
function replaceToolResultMessage(
  conversation: Conversation,
  original: Message & { toolResult: ToolResult },
  normalizedToolResult: ToolResult,
  resolvedOptions: AppendToolResultOptions | undefined,
  resolvedEnvironment: ConversationEnvironment,
): Conversation {
  const draftInput = createToolResultDraft(original, normalizedToolResult, resolvedOptions);
  const processedInput = resolvedEnvironment.plugins.reduce(
    (acc, plugin) => plugin(acc),
    draftInput,
  );

  const now = resolvedEnvironment.now();
  const replaced = createMessage({
    id: original.id,
    role: original.role,
    content: processedInput.content,
    position: original.position,
    createdAt: original.createdAt,
    metadata: { ...processedInput.metadata },
    hidden: processedInput.hidden ?? false,
    toolResult: processedInput.toolResult,
    tokenUsage: processedInput.tokenUsage,
    cacheBoundary: processedInput.cacheBoundary,
  });

  const next: Conversation = {
    ...conversation,
    ids: [...conversation.ids],
    messages: { ...conversation.messages, [replaced.id]: replaced },
    updatedAt: now,
  };
  return ensureConversationSafe(toReadonly(next));
}

function assertMatchingCallId(callId: string, normalizedToolResult: ToolResult): void {
  if (normalizedToolResult.callId !== callId) {
    throw createInvalidInputError(
      `toolResult.callId (${normalizedToolResult.callId}) does not match callId (${callId})`,
      { callId, toolResultCallId: normalizedToolResult.callId },
    );
  }
}

/**
 * Replaces the tool-result message for `callId` with a new result, in
 * place — producing exactly one tool-result message for that call
 * afterwards. This is the primitive a host needs to turn a pending
 * `action_required` result (appended before a run parks on approval) into
 * the resolved result from `toolbox.resumeApproval()`, without ending up
 * with two tool-result messages for the same call — a malformed
 * conversation most providers reject or mishandle on the next turn.
 *
 * Locates the message purely by `toolResult.callId`, by scanning
 * `conversation.messages` — never by position or by an undo/redo node
 * graph — so it behaves identically on a freshly-built `Conversation` and
 * one rehydrated from a persisted `ConversationHistory` (the exact case a
 * stateless host hits on every resume, since it reconstructs the
 * conversation from stored JSON each request).
 *
 * **Identity**: the replacement message keeps the original message's `id`,
 * `createdAt`, and `position` — it is the same logical result being
 * resolved, not a new message appended after it. This mirrors
 * {@link redactMessageAtPosition}'s in-place replacement and means callers
 * holding a reference to the pending result's message id keep a valid
 * reference afterwards.
 *
 * `content`/`metadata`/`hidden`/`tokenUsage` default to the original
 * message's values and can be overridden via `options`, same as
 * {@link appendToolResult}. `environment.plugins` (e.g. PII redaction) run
 * over the replacement content, same as a freshly appended tool result.
 *
 * Throws `error:not-found` if no tool-result message exists for `callId`,
 * `error:integrity` if more than one does (an already-malformed
 * conversation state — replacing one of several would silently guess which
 * one the caller meant), and `error:invalid-input` if `toolResult.callId`
 * disagrees with `callId` (replacing the wrong message silently would be
 * worse than refusing). Rejects streaming `toolResult` payloads the same
 * way {@link appendToolResult} does — use {@link resolveToolResultAsync}
 * for those.
 */
export function resolveToolResult(
  conversation: Conversation,
  callId: string,
  toolResult: AppendableToolResult,
  options?: AppendToolResultOptions,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedOptions = isConversationEnvironmentParameter(options) ? undefined : options;
  const resolvedEnvironmentInput = isConversationEnvironmentParameter(options)
    ? options
    : environment;

  const original = findToolResultMessageToReplace(conversation, callId);
  const normalizedToolResult = materializeToolResult(toolResult);
  assertMatchingCallId(callId, normalizedToolResult);

  const resolvedEnvironment = resolveConversationEnvironment(resolvedEnvironmentInput);
  return replaceToolResultMessage(
    conversation,
    original,
    normalizedToolResult,
    resolvedOptions,
    resolvedEnvironment,
  );
}

/**
 * Async counterpart to {@link resolveToolResult}: collects a streaming
 * `toolResult` payload (as returned by `toolbox.resumeApproval()` when the
 * resumed tool streams its output) before replacing the pending result, the
 * same relationship {@link appendToolResultAsync} has to
 * {@link appendToolResult}.
 */
export async function resolveToolResultAsync(
  conversation: Conversation,
  callId: string,
  toolResult: AppendableToolResult,
  options?: AppendToolResultOptions,
  environment?: Partial<ConversationEnvironment>,
): Promise<Conversation> {
  const resolvedOptions = isConversationEnvironmentParameter(options) ? undefined : options;
  const resolvedEnvironmentInput = isConversationEnvironmentParameter(options)
    ? options
    : environment;

  const original = findToolResultMessageToReplace(conversation, callId);
  const normalizedToolResult = await materializeToolResultAsync(toolResult, {
    signal: resolvedOptions?.signal,
  });
  assertMatchingCallId(callId, normalizedToolResult);

  const resolvedEnvironment = resolveConversationEnvironment(resolvedEnvironmentInput);
  return replaceToolResultMessage(
    conversation,
    original,
    normalizedToolResult,
    resolvedOptions,
    resolvedEnvironment,
  );
}
