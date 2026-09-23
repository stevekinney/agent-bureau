import { assertConversationSafe } from '../../conversation/validation';
import { isStreamingMessage } from '../../streaming';
import type { ConversationHistory as Conversation, Message } from '../../types';
import { getOrderedMessages } from '../../utilities/message-store';
import {
  extractSystemInstruction,
  toFunctionCallPart,
  toFunctionResponsePart,
  toGeminiParts,
} from './content';
import type { GeminiContent, GeminiConversation, GeminiPart } from './types';

/**
 * Converts a conversation to Google Gemini API format.
 * System messages are extracted to `systemInstruction`.
 * Tool calls become functionCall parts, tool results become functionResponse parts.
 *
 * @example
 * ```ts
 * import { GoogleGenAI } from '@google/genai';
 * import { toGeminiMessages } from 'conversationalist';
 *
 * const client = new GoogleGenAI({ apiKey });
 * const { systemInstruction, contents } = toGeminiMessages(conversation);
 * const response = await client.models.generateContent({
 *   model: 'gemini-pro',
 *   contents,
 *   config: { systemInstruction },
 * });
 * ```
 *
 * `message.cacheBoundary` is intentionally a no-op here: Gemini's context
 * caching is an out-of-band resource (`cachedContent`, created ahead of time
 * via a separate API call and referenced by name in the request) rather than
 * a per-message annotation, so there is no per-message wire field to
 * translate the mark to.
 */
export function toGeminiMessages(conversation: Conversation): GeminiConversation {
  assertConversationSafe(conversation);
  const ordered = getOrderedMessages(conversation);
  const systemInstruction = extractSystemInstruction(ordered);

  // Build a map of tool call IDs to function names for tool results
  const toolCallNames = new Map<string, string>();
  for (const message of ordered) {
    if (message.role === 'tool-call' && message.toolCall) {
      toolCallNames.set(message.toolCall.id, message.toolCall.name);
    }
  }

  const contents: GeminiContent[] = [];

  // Track pending parts to merge consecutive same-role messages
  let currentRole: 'user' | 'model' | null = null;
  let currentParts: GeminiPart[] = [];

  const flushCurrent = () => {
    if (currentRole && currentParts.length > 0) {
      contents.push({
        role: currentRole,
        parts: currentParts,
      });
      currentParts = [];
    }
    currentRole = null;
  };

  for (const message of ordered) {
    const converted = convertGeminiMessage(message, toolCallNames);
    if (!converted) continue;
    const { role: targetRole, parts } = converted;

    if (parts.length === 0) {
      continue;
    }

    // Merge with current or start new
    if (currentRole === targetRole) {
      currentParts.push(...parts);
    } else {
      flushCurrent();
      currentRole = targetRole;
      currentParts = parts;
    }
  }

  flushCurrent();

  const result: GeminiConversation = { contents };
  if (systemInstruction !== undefined) {
    result.systemInstruction = systemInstruction;
  }
  return result;
}

function convertGeminiMessage(
  message: Message,
  toolCallNames: ReadonlyMap<string, string>,
): { role: 'user' | 'model'; parts: GeminiPart[] } | undefined {
  if (shouldSkipGeminiMessage(message)) return undefined;
  switch (message.role) {
    case 'system':
    case 'developer':
    case 'snapshot':
      return undefined;
    case 'user':
    case 'assistant':
      return {
        role: message.role === 'user' ? 'user' : 'model',
        parts: toGeminiParts(message.content),
      };
    case 'tool-call':
    case 'tool-result':
      return convertToolGeminiMessage(message, toolCallNames);
    default:
      return undefined;
  }
}

function shouldSkipGeminiMessage(message: Message): boolean {
  return message.hidden || isStreamingMessage(message);
}

function convertToolGeminiMessage(
  message: Message,
  toolCallNames: ReadonlyMap<string, string>,
): { role: 'user' | 'model'; parts: GeminiPart[] } | undefined {
  if (message.role === 'tool-call') {
    return message.toolCall
      ? { role: 'model', parts: [toFunctionCallPart(message.toolCall)] }
      : undefined;
  }
  return message.toolResult
    ? {
        role: 'user',
        parts: [
          toFunctionResponsePart(
            message.toolResult,
            toolCallNames.get(message.toolResult.callId) ?? 'unknown',
          ),
        ],
      }
    : undefined;
}
