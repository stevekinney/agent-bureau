import { type MultiModalContent, renderDocumentReferenceText } from '../../multi-modal';
import { isStreamingMessage } from '../../streaming';
import type { Message, ToolCall, ToolResult } from '../../types';
import type {
  GeminiContent,
  GeminiFunctionCallPart,
  GeminiFunctionResponsePart,
  GeminiPart,
} from './types';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeGeminiResponse(toolResult: ToolResult): Record<string, unknown> {
  if (toolResult.outcome === 'success') {
    if (toolResult.content !== null && typeof toolResult.content === 'object') {
      return Array.isArray(toolResult.content)
        ? { result: toolResult.content }
        : Object.fromEntries(Object.entries(toolResult.content));
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
export function toGeminiParts(content: string | ReadonlyArray<MultiModalContent>): GeminiPart[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }

  const parts: GeminiPart[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          parts.push({ text: part.text });
        }
        break;
      case 'document':
        parts.push({ text: renderDocumentReferenceText(part) });
        break;
      case 'image': {
        const converted = toGeminiImagePart(part.url ?? '', part.mimeType);
        if (converted) parts.push(converted);
        break;
      }
    }
  }

  return parts;
}

function toGeminiImagePart(url: string, mimeType?: string): GeminiPart | undefined {
  if (url.startsWith('data:')) {
    const matches = url.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches?.[1] || !matches[2]) return undefined;
    return { inlineData: { mimeType: matches[1], data: matches[2] } };
  }
  return { fileData: { fileUri: url, mimeType: resolveMimeType(url, mimeType) } };
}

/**
 * Converts an internal ToolCall to Gemini functionCall part.
 */
export function toFunctionCallPart(toolCall: ToolCall): GeminiFunctionCallPart {
  let args: Record<string, unknown>;

  if (typeof toolCall.arguments === 'string') {
    try {
      const parsed = JSON.parse(toolCall.arguments) as unknown;
      if (isRecord(parsed)) {
        args = parsed;
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
    args = Object.fromEntries(Object.entries(toolCall.arguments));
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
export function toFunctionResponsePart(
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
export function extractSystemInstruction(
  messages: ReadonlyArray<Message>,
): GeminiContent | undefined {
  const systemMessages = messages.filter(
    (m) => (m.role === 'system' || m.role === 'developer') && !m.hidden && !isStreamingMessage(m),
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
