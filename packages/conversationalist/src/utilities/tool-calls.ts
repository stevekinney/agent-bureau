import type { Message, ToolCall, ToolResult } from '../types';

/**
 * Represents a paired tool call with its optional result.
 */
export interface ToolCallPair {
  /** The tool call */
  call: ToolCall;
  /** The corresponding result, if available */
  result?: ToolResult | undefined;
}

/**
 * Pairs tool calls with their corresponding results from a list of messages.
 *
 * This is useful for UI rendering where tool calls and their results need
 * to be displayed together. The function performs two passes:
 * 1. Collects all tool results into a map by their callId
 * 2. Pairs each tool call with its matching result (if any)
 *
 * @param messages - Messages that may contain tool calls and results (array or record)
 * @returns Array of tool call pairs, preserving the order of tool calls
 *
 * @example
 * ```ts
 * const pairs = pairToolCallsWithResults(conversation.messages);
 * // pairs: [{ call: ToolCall, result?: ToolResult }, ...]
 * ```
 */
export function pairToolCallsWithResults(
  messages: ReadonlyArray<Message> | Readonly<Record<string, Message>>,
): ToolCallPair[] {
  const isMessageArray = (
    value: ReadonlyArray<Message> | Readonly<Record<string, Message>>,
  ): value is ReadonlyArray<Message> => Array.isArray(value);

  const ordered = isMessageArray(messages)
    ? messages
    : Object.values(messages).sort((a, b) => a.position - b.position);
  const pairs: ToolCallPair[] = [];
  const resultsMap = new Map<string, ToolResult>();

  // First pass: collect all results
  for (const msg of ordered) {
    if (msg.toolResult) {
      resultsMap.set(msg.toolResult.callId, msg.toolResult);
    }
  }

  // Second pass: pair calls with results
  for (const msg of ordered) {
    if (msg.toolCall) {
      pairs.push({
        call: msg.toolCall,
        result: resultsMap.get(msg.toolCall.id),
      });
    }
  }

  return pairs;
}
