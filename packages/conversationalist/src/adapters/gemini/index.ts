import type { MultiModalContent } from '@lasercat/homogenaize';

import {
  appendMessages,
  createConversationHistory,
} from '../../conversation/index';
import { assertConversationSafe } from '../../conversation/validation';
import type {
  ConversationHistory as Conversation,
  JSONValue,
  Message,
  MessageInput,
  ToolCall,
  ToolResult,
} from '../../types';
import { getOrderedMessages } from '../../utilities/message-store';

/**
 * Gemini text part.
 */
export interface GeminiTextPart {
  text: string;
}

/**
 * Gemini inline data part (for images).
 */
export interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

/**
 * Gemini file data part (for URLs).
 */
export interface GeminiFileDataPart {
  fileData: {
    mimeType: string;
    fileUri: string;
  };
}

/**
 * Gemini function call part.
 */
export interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

/**
 * Gemini function response part.
 */
export interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
  };
}

/**
 * Gemini content part union type.
 */
export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFileDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

/**
 * Gemini content (message) format.
 */
export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Result of converting a conversation to Gemini format.
 */
export interface GeminiConversation {
  systemInstruction?: GeminiContent;
  contents: GeminiContent[];
}

const DEFAULT_FILE_MIME_TYPE = 'application/octet-stream';

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

function inferMimeType(url: string): string | undefined {
  const trimmed = url.split('#')[0]?.split('?')[0] ?? '';
  const dotIndex = trimmed.lastIndexOf('.');
  if (dotIndex === -1) {
    return undefined;
  }
  const extension = trimmed.slice(dotIndex + 1).toLowerCase();
  return MIME_TYPE_BY_EXTENSION[extension];
}

function resolveMimeType(url: string, explicit?: string): string {
  return explicit ?? inferMimeType(url) ?? DEFAULT_FILE_MIME_TYPE;
}

function normalizeGeminiResponse(toolResult: ToolResult): Record<string, unknown> {
  if (toolResult.outcome === 'success') {
    if (toolResult.content !== null && typeof toolResult.content === 'object') {
      return toolResult.content as Record<string, unknown>;
    }

    return { result: toolResult.content };
  }

  return {
    outcome: toolResult.outcome,
    content: toolResult.content,
    ...(toolResult.error ? { error: toolResult.error } : {}),
    ...(toolResult.action ? { action: toolResult.action } : {}),
  };
}

/**
 * Converts internal multi-modal content to Gemini parts.
 */
function toGeminiParts(content: string | ReadonlyArray<MultiModalContent>): GeminiPart[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }

  const parts: GeminiPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) {
        parts.push({ text: part.text });
      }
    } else if (part.type === 'image') {
      const url = part.url ?? '';
      if (url.startsWith('data:')) {
        // Base64 data URL
        const matches = url.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          parts.push({
            inlineData: {
              mimeType: matches[1]!,
              data: matches[2]!,
            },
          });
        }
      } else {
        // File URI
        const fileData: GeminiFileDataPart['fileData'] = {
          fileUri: url,
          mimeType: resolveMimeType(url, part.mimeType),
        };
        parts.push({ fileData });
      }
    }
  }

  return parts;
}

/**
 * Converts an internal ToolCall to Gemini functionCall part.
 */
function toFunctionCallPart(toolCall: ToolCall): GeminiFunctionCallPart {
  let args: Record<string, unknown>;

  if (typeof toolCall.arguments === 'string') {
    try {
      const parsed = JSON.parse(toolCall.arguments) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        args = { _value: parsed };
      }
    } catch {
      args = { _raw: toolCall.arguments };
    }
  } else if (
    toolCall.arguments &&
    typeof toolCall.arguments === 'object' &&
    !Array.isArray(toolCall.arguments)
  ) {
    args = toolCall.arguments as Record<string, unknown>;
  } else {
    args = { _value: toolCall.arguments };
  }

  return {
    functionCall: {
      name: toolCall.name,
      args,
    },
  };
}

/**
 * Converts an internal ToolResult to Gemini functionResponse part.
 * Note: Gemini needs the function name, which we track via a map from the conversation.
 */
function toFunctionResponsePart(
  toolResult: ToolResult,
  functionName: string,
): GeminiFunctionResponsePart {
  return {
    functionResponse: {
      name: functionName,
      response: normalizeGeminiResponse(toolResult),
    },
  };
}

/**
 * Collects system message content from a conversation for Gemini's systemInstruction.
 */
function extractSystemInstruction(
  messages: ReadonlyArray<Message>,
): GeminiContent | undefined {
  const systemMessages = messages.filter(
    (m) => (m.role === 'system' || m.role === 'developer') && !m.hidden,
  );

  if (systemMessages.length === 0) {
    return undefined;
  }

  const parts: GeminiPart[] = [];
  for (const msg of systemMessages) {
    parts.push(...toGeminiParts(msg.content));
  }

  if (parts.length === 0) {
    return undefined;
  }

  return {
    role: 'user', // systemInstruction uses 'user' role in Gemini
    parts,
  };
}

/**
 * Converts a conversation to Google Gemini API format.
 * System messages are extracted to `systemInstruction`.
 * Tool calls become functionCall parts, tool results become functionResponse parts.
 *
 * @example
 * ```ts
 * import { toGeminiMessages } from 'conversationalist/adapters/gemini';
 *
 * const { systemInstruction, contents } = toGeminiMessages(conversation);
 * const response = await genAI.getGenerativeModel({ model: 'gemini-pro' }).generateContent({
 *   systemInstruction,
 *   contents,
 * });
 * ```
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
    if (message.hidden) continue;

    // Skip system messages (already extracted)
    if (message.role === 'system' || message.role === 'developer') {
      continue;
    }

    // Skip snapshots
    if (message.role === 'snapshot') {
      continue;
    }

    let targetRole: 'user' | 'model';
    let parts: GeminiPart[] = [];

    if (message.role === 'user') {
      targetRole = 'user';
      parts = toGeminiParts(message.content);
    } else if (message.role === 'assistant') {
      targetRole = 'model';
      parts = toGeminiParts(message.content);
    } else if (message.role === 'tool-call' && message.toolCall) {
      targetRole = 'model';
      parts = [toFunctionCallPart(message.toolCall)];
    } else if (message.role === 'tool-result' && message.toolResult) {
      targetRole = 'user';
      const functionName = toolCallNames.get(message.toolResult.callId) ?? 'unknown';
      parts = [toFunctionResponsePart(message.toolResult, functionName)];
    } else {
      continue;
    }

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

function toJSONValue(value: unknown): JSONValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJSONValue(item));
  }

  if (value && typeof value === 'object') {
    const record: Record<string, JSONValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      record[key] = toJSONValue(entry);
    }
    return record;
  }

  return String(value);
}

function isCanonicalToolResultPayload(
  value: JSONValue,
): value is JSONValue & {
  outcome: ToolResult['outcome'];
  content: JSONValue;
  error?: ToolResult['error'];
  action?: ToolResult['action'];
  inputDigest?: string;
  outputDigest?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return (
    'outcome' in value &&
    (value['outcome'] === 'success' ||
      value['outcome'] === 'error' ||
      value['outcome'] === 'action_required') &&
    'content' in value
  );
}

function parseFunctionArguments(args: Record<string, unknown>): JSONValue {
  if (
    Object.keys(args).length === 1 &&
    Object.hasOwn(args, '_value')
  ) {
    return toJSONValue(args['_value']);
  }

  if (
    Object.keys(args).length === 1 &&
    Object.hasOwn(args, '_raw') &&
    typeof args['_raw'] === 'string'
  ) {
    return args['_raw'];
  }

  return toJSONValue(args);
}

function parseFunctionResponse(
  callId: string,
  response: Record<string, unknown>,
): ToolResult {
  const value = toJSONValue(response);

  if (isCanonicalToolResultPayload(value)) {
    return {
      callId,
      outcome: value.outcome,
      content: value.content,
      ...(value.error ? { error: value.error } : {}),
      ...(value.action ? { action: value.action } : {}),
      ...(typeof value.inputDigest === 'string'
        ? { inputDigest: value.inputDigest }
        : {}),
      ...(typeof value.outputDigest === 'string'
        ? { outputDigest: value.outputDigest }
        : {}),
    };
  }

  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, 'result')
  ) {
    return {
      callId,
      outcome: 'success',
      content: toJSONValue(value['result']),
    };
  }

  return {
    callId,
    outcome: 'success',
    content: value,
  };
}

function toContentFromGeminiPart(
  part: GeminiTextPart | GeminiInlineDataPart | GeminiFileDataPart,
): MessageInput['content'] {
  if ('text' in part) {
    return part.text;
  }

  if ('inlineData' in part) {
    return [
      {
        type: 'image',
        url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
        mimeType: part.inlineData.mimeType,
      },
    ];
  }

  return [
    {
      type: 'image',
      url: part.fileData.fileUri,
      mimeType: part.fileData.mimeType,
    },
  ];
}

function toSystemInstructionContent(parts: GeminiPart[]): MessageInput['content'] | undefined {
  const contentParts: MultiModalContent[] = [];

  for (const part of parts) {
    if ('text' in part) {
      contentParts.push({ type: 'text', text: part.text });
    } else if ('inlineData' in part) {
      contentParts.push({
        type: 'image',
        url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
        mimeType: part.inlineData.mimeType,
      });
    } else if ('fileData' in part) {
      contentParts.push({
        type: 'image',
        url: part.fileData.fileUri,
        mimeType: part.fileData.mimeType,
      });
    }
  }

  if (contentParts.length === 0) {
    return undefined;
  }

  if (contentParts.length === 1 && contentParts[0]?.type === 'text') {
    return contentParts[0].text ?? '';
  }

  return contentParts;
}

/**
 * Converts Gemini SDK contents back into a ConversationHistory.
 */
export function fromGeminiMessages(payload: GeminiConversation): Conversation {
  let conversation = createConversationHistory();
  const inputs: MessageInput[] = [];
  let syntheticToolCallCount = 0;
  const pendingToolCalls = new Map<string, string[]>();

  const queueToolCall = (name: string, callId: string) => {
    const queued = pendingToolCalls.get(name) ?? [];
    queued.push(callId);
    pendingToolCalls.set(name, queued);
  };

  const dequeueToolCall = (name: string): string | undefined => {
    const queued = pendingToolCalls.get(name);
    if (!queued || queued.length === 0) {
      return undefined;
    }
    const [callId, ...rest] = queued;
    if (rest.length === 0) {
      pendingToolCalls.delete(name);
    } else {
      pendingToolCalls.set(name, rest);
    }
    return callId;
  };

  const systemContent = payload.systemInstruction
    ? toSystemInstructionContent(payload.systemInstruction.parts)
    : undefined;
  if (systemContent !== undefined) {
    inputs.push({
      role: 'system',
      content: systemContent,
    });
  }

  for (const content of payload.contents) {
    const role = content.role === 'model' ? 'assistant' : 'user';

    for (const part of content.parts) {
      if ('functionCall' in part) {
        const callId = `gemini-call-${++syntheticToolCallCount}`;
        queueToolCall(part.functionCall.name, callId);
        inputs.push({
          role: 'tool-call',
          content: '',
          toolCall: {
            id: callId,
            name: part.functionCall.name,
            arguments: parseFunctionArguments(part.functionCall.args),
          },
        });
        continue;
      }

      if ('functionResponse' in part) {
        const callId =
          dequeueToolCall(part.functionResponse.name) ??
          `gemini-call-${++syntheticToolCallCount}`;
        inputs.push({
          role: 'tool-result',
          content: '',
          toolResult: parseFunctionResponse(callId, part.functionResponse.response),
        });
        continue;
      }

      inputs.push({
        role,
        content: toContentFromGeminiPart(part),
      });
    }
  }

  if (inputs.length > 0) {
    conversation = appendMessages(conversation, ...inputs);
  }

  return conversation;
}
