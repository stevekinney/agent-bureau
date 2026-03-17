import { createInvalidToolReferenceError } from '../errors';
import type { Message } from '../types';

/**
 * A map of tool use IDs to their names, used for tracking tool calls
 * and validating tool results reference valid calls.
 */
export type ToolUseIndex = Map<string, { name: string }>;

/**
 * Builds an index of all tool use messages from a list of messages.
 * Used to validate that tool results reference existing tool uses.
 */
export const buildToolUseIndex = (messages: ReadonlyArray<Message>): ToolUseIndex =>
  messages.reduce((index, message) => {
    if (message.role === 'tool-use' && message.toolCall) {
      index.set(message.toolCall.id, { name: message.toolCall.name });
    }
    return index;
  }, new Map<string, { name: string }>());

/**
 * Registers a new tool use in the index, returning a new immutable index.
 */
export const registerToolUse = (
  index: ToolUseIndex,
  toolCall: { id: string; name: string },
): ToolUseIndex => {
  const next = new Map(index);
  next.set(toolCall.id, { name: toolCall.name });
  return next;
};

/**
 * Throws an error if the given call ID does not exist in the tool use index.
 * Used to ensure tool results reference valid tool uses.
 */
export const assertToolReference = (index: ToolUseIndex, callId: string): void => {
  if (!index.has(callId)) {
    throw createInvalidToolReferenceError(callId);
  }
};
