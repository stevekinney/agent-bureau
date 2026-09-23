import { appendMessages, createConversationHistory } from '../../conversation/index';
import type { MultiModalContent } from '../../multi-modal';
import type { ConversationHistory as Conversation, MessageInput, ToolResult } from '../../types';
import { isCanonicalToolResultPayload, parseJSONValue, toJSONValue } from '../shared';
import type {
  AnthropicContentBlock,
  AnthropicConversation,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from './types';

function parseToolResultContent(callId: string, content: string, isError?: boolean): ToolResult {
  const parsed = parseJSONValue(content);

  if (parsed !== undefined && isCanonicalToolResultPayload(parsed)) {
    return {
      callId,
      outcome: parsed.outcome,
      content: parsed.content,
      ...(parsed.error ? { error: parsed.error } : {}),
      ...(parsed.action ? { action: parsed.action } : {}),
      ...(typeof parsed.inputDigest === 'string' ? { inputDigest: parsed.inputDigest } : {}),
      ...(typeof parsed.outputDigest === 'string' ? { outputDigest: parsed.outputDigest } : {}),
    };
  }

  return {
    callId,
    outcome: isError ? 'error' : 'success',
    content: parsed ?? content,
  };
}

/**
 * Maps the role-bearing Anthropic blocks — `tool_use` and `tool_result` — to
 * their dedicated conversation messages. Groupable content blocks are handled by
 * {@link toGroupableContentPart}; only `tool_use`/`tool_result` reach here.
 */
function toMessageInputFromBlock(
  block: AnthropicToolUseBlock | AnthropicToolResultBlock,
): MessageInput {
  if (block.type === 'tool_use') {
    return {
      role: 'tool-call',
      content: '',
      toolCall: {
        id: block.id,
        name: block.name,
        arguments: toJSONValue(block.input),
      },
    };
  }

  return {
    role: 'tool-result',
    content: '',
    toolResult: parseToolResultContent(block.tool_use_id, block.content, block.is_error),
  };
}

/**
 * Maps an Anthropic content block that can coexist with siblings inside a single
 * message to its {@link MultiModalContent} part, preserving fields byte-for-byte.
 * Returns `undefined` for blocks that must become their own message because the
 * conversation model represents them as distinct roles (`tool_use` →
 * `tool-call`, `tool_result` → `tool-result`).
 */
function toGroupableContentPart(block: AnthropicContentBlock): MultiModalContent | undefined {
  if (block.type === 'text')
    return {
      type: 'text',
      text: block.text,
      ...(block.citations !== undefined ? { citations: toJSONValue(block.citations) } : {}),
    };
  if (block.type === 'thinking')
    return { type: 'thinking', thinking: block.thinking, signature: block.signature };
  if (block.type === 'redacted_thinking') return { type: 'redacted_thinking', data: block.data };
  if (block.type === 'server_tool_use')
    return {
      type: 'server_tool_use',
      id: block.id,
      name: block.name,
      input: toJSONValue(block.input),
    };
  if (block.type === 'web_search_tool_result')
    return {
      type: 'web_search_tool_result',
      tool_use_id: block.tool_use_id,
      content: toJSONValue(block.content),
    };
  if (block.type === 'document') return toDocumentPart(block);
  if (block.type === 'image')
    return block.source.type === 'url'
      ? { type: 'image', url: block.source.url }
      : {
          type: 'image',
          url: `data:${block.source.media_type};base64,${block.source.data}`,
          mimeType: block.source.media_type,
        };
  return toServerResultPart(block);
}
function toDocumentPart(
  block: Extract<AnthropicContentBlock, { type: 'document' }>,
): MultiModalContent {
  const name = block.title ?? 'document';
  if (block.source.type === 'base64')
    return {
      type: 'document',
      name,
      mimeType: block.source.media_type,
      source: { kind: 'base64', data: block.source.data },
    };
  if (block.source.type === 'text') return { type: 'text', text: block.source.data };
  if (block.source.type === 'url')
    return {
      type: 'document',
      name,
      mimeType: 'application/octet-stream',
      source: { kind: 'reference', uri: block.source.url },
    };
  return {
    type: 'document',
    name,
    mimeType: 'application/octet-stream',
    source: { kind: 'reference', uri: `file:${block.source.file_id}` },
  };
}
function toServerResultPart(block: AnthropicContentBlock): MultiModalContent | undefined {
  if (block.type === 'container_upload')
    return { type: 'container_upload', file_id: block.file_id };
  if (
    block.type === 'code_execution_tool_result' ||
    block.type === 'bash_code_execution_tool_result' ||
    block.type === 'text_editor_code_execution_tool_result' ||
    block.type === 'web_fetch_tool_result'
  )
    return {
      type: block.type,
      tool_use_id: block.tool_use_id,
      content: toJSONValue(block.content),
    };
  return undefined;
}

function appendMessageInputs(
  message: AnthropicConversation['messages'][number],
  inputs: MessageInput[],
): void {
  if (typeof message.content === 'string') {
    inputs.push({
      role: message.role,
      content: message.content,
    });
    return;
  }

  // Preserve the original Anthropic block order. Groupable blocks (text,
  // thinking, redacted_thinking, image, server_tool_use, web_search_tool_result)
  // accumulate into a single ordered multi-part MessageInput. Role-bearing
  // blocks (tool_use → tool-call, tool_result → tool-result) are distinct
  // messages in the conversation model, so they flush the current run and emit
  // their own message, keeping interleaved sequences like
  // [text, tool_use, text] in their true order.
  let pendingParts: MultiModalContent[] = [];
  let pendingCacheBoundary = false;

  const flushPending = () => {
    if (pendingParts.length === 0) return;
    const cacheBoundaryFlag = pendingCacheBoundary ? { cacheBoundary: true as const } : {};
    // A lone PLAIN text part round-trips as a string to match the
    // one-block-one-string storage convention; a cited text part (or any mixed
    // run) stays as an array so citations aren't lost.
    const first = pendingParts[0];
    if (pendingParts.length === 1 && first?.type === 'text' && first.citations === undefined) {
      inputs.push({ role: message.role, content: first.text, ...cacheBoundaryFlag });
    } else {
      inputs.push({ role: message.role, content: pendingParts, ...cacheBoundaryFlag });
    }
    pendingParts = [];
    pendingCacheBoundary = false;
  };

  for (const block of message.content) {
    const part = toGroupableContentPart(block);
    if (part !== undefined) {
      if (block.cache_control !== undefined) {
        // `cache_control` marks "everything up to and including THIS
        // block" as the stable prefix — and ONLY this block, since encode
        // attaches it to the last block a specific ConversationHistory
        // message contributed. Flush whatever preceded it as its own
        // (un-marked) message first, then this block as its own
        // boundary-marked message, so a later block in the same Anthropic
        // message (possible after `toAnthropicMessages` merges
        // consecutive same-role messages) neither absorbs the boundary
        // nor gets folded into it.
        flushPending();
        pendingParts.push(part);
        pendingCacheBoundary = true;
        flushPending();
      } else {
        pendingParts.push(part);
      }
    } else if (block.type === 'tool_use' || block.type === 'tool_result') {
      // Role-bearing block: flush the accumulated run first to preserve order.
      flushPending();
      const roleInput = toMessageInputFromBlock(block);
      inputs.push(
        block.cache_control !== undefined ? { ...roleInput, cacheBoundary: true } : roleInput,
      );
    }
  }

  flushPending();
}

function toMessageInputs(payload: AnthropicConversation): MessageInput[] {
  const inputs: MessageInput[] = [];

  if (typeof payload.system === 'string') {
    inputs.push({
      role: 'system',
      content: payload.system,
    });
  } else if (payload.system !== undefined) {
    // Array form: one addressable system segment per block, cache mark
    // restored from `cache_control` on that block.
    for (const block of payload.system) {
      inputs.push({
        role: 'system',
        content: block.text,
        ...(block.cache_control !== undefined ? { cacheBoundary: true } : {}),
      });
    }
  }

  for (const message of payload.messages) {
    appendMessageInputs(message, inputs);
  }

  return inputs;
}

/**
 * Converts Anthropic Messages API payloads back into a ConversationHistory.
 */
export function fromAnthropicMessages(payload: AnthropicConversation): Conversation {
  let conversation = createConversationHistory();
  const inputs = toMessageInputs(payload);

  if (inputs.length > 0) {
    conversation = appendMessages(conversation, ...inputs);
  }

  return conversation;
}

export function appendAnthropicMessages(
  conversation: Conversation,
  payload: AnthropicConversation,
): Conversation {
  const inputs = toMessageInputs(payload);
  if (inputs.length === 0) {
    return conversation;
  }
  return appendMessages(conversation, ...inputs);
}
