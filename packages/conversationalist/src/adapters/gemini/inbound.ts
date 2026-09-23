import { appendMessages, createConversationHistory } from '../../conversation/index';
import type { MultiModalContent } from '../../multi-modal';
import type {
  ConversationHistory as Conversation,
  JSONValue,
  MessageInput,
  ToolResult,
} from '../../types';
import { isCanonicalToolResultPayload, toJSONValue } from '../shared';
import type {
  GeminiConversation,
  GeminiFileDataPart,
  GeminiInlineDataPart,
  GeminiPart,
  GeminiTextPart,
} from './types';

function parseFunctionArguments(args: Record<string, unknown>): JSONValue {
  if (Object.keys(args).length === 1 && Object.hasOwn(args, '_value')) {
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

function parseFunctionResponse(callId: string, response: Record<string, unknown>): ToolResult {
  const value = toJSONValue(response);

  const canonical = toCanonicalToolResult(callId, value);
  if (canonical) return canonical;
  const wrapped = toWrappedToolResult(callId, value);
  if (wrapped) return wrapped;

  return {
    callId,
    outcome: 'success',
    content: value,
  };
}

function toCanonicalToolResult(callId: string, value: JSONValue): ToolResult | undefined {
  if (!isCanonicalToolResultPayload(value)) return undefined;
  return {
    callId,
    outcome: value.outcome,
    content: value.content,
    ...(value.error ? { error: value.error } : {}),
    ...(value.action ? { action: value.action } : {}),
    ...(typeof value.inputDigest === 'string' ? { inputDigest: value.inputDigest } : {}),
    ...(typeof value.outputDigest === 'string' ? { outputDigest: value.outputDigest } : {}),
  };
}

function toWrappedToolResult(callId: string, value: JSONValue): ToolResult | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'result')
  ) {
    return undefined;
  }
  return { callId, outcome: 'success', content: Object.values(value)[0] ?? null };
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

function toMessageInputs(payload: GeminiConversation): MessageInput[] {
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
          dequeueToolCall(part.functionResponse.name) ?? `gemini-call-${++syntheticToolCallCount}`;
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

  return inputs;
}

/**
 * Converts Gemini SDK contents back into a ConversationHistory.
 */
export function fromGeminiMessages(payload: GeminiConversation): Conversation {
  let conversation = createConversationHistory();
  const inputs = toMessageInputs(payload);

  if (inputs.length > 0) {
    conversation = appendMessages(conversation, ...inputs);
  }

  return conversation;
}

export function appendGeminiMessages(
  conversation: Conversation,
  payload: GeminiConversation,
): Conversation {
  const inputs = toMessageInputs(payload);
  if (inputs.length === 0) {
    return conversation;
  }
  return appendMessages(conversation, ...inputs);
}
