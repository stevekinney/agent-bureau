import { type MultiModalContent, renderDocumentReferenceText } from '../../multi-modal';
import { isStreamingMessage } from '../../streaming';
import type { Message, ToolCall, ToolResult } from '../../types';
import type {
  AnthropicContentBlock,
  AnthropicSystemBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from './types';

/**
 * Converts internal multi-modal content to Anthropic content blocks.
 */
export function toAnthropicContent(
  content: string | ReadonlyArray<MultiModalContent>,
): string | AnthropicContentBlock[] {
  if (typeof content === 'string') return content;
  const blocks = content.flatMap((part) => {
    const block = toAnthropicPart(part);
    return block === undefined ? [] : [block];
  });
  const only = blocks.length === 1 ? blocks[0] : undefined;
  return only?.type === 'text' && only.citations === undefined ? only.text : blocks;
}

function toAnthropicPart(part: MultiModalContent): AnthropicContentBlock | undefined {
  if (part.type === 'document') return toAnthropicDocument(part);
  if (part.type === 'image') return toAnthropicImage(part.url ?? '');
  return toAnthropicSimplePart(part);
}

function toAnthropicSimplePart(part: MultiModalContent): AnthropicContentBlock | undefined {
  if (part.type === 'text')
    return {
      type: 'text',
      text: part.text ?? '',
      ...(part.citations !== undefined ? { citations: part.citations } : {}),
    };
  if (part.type === 'thinking')
    return { type: 'thinking', thinking: part.thinking, signature: part.signature };
  if (part.type === 'redacted_thinking') return { type: 'redacted_thinking', data: part.data };
  if (part.type === 'server_tool_use')
    return { type: 'server_tool_use', id: part.id, name: part.name, input: part.input };
  if (part.type === 'web_search_tool_result')
    return { type: 'web_search_tool_result', tool_use_id: part.tool_use_id, content: part.content };
  if (isAnthropicMiscPart(part)) return toAnthropicMiscPart(part);
  return undefined;
}

function isAnthropicMiscPart(part: MultiModalContent): part is Extract<
  MultiModalContent,
  {
    type:
      | 'container_upload'
      | 'code_execution_tool_result'
      | 'bash_code_execution_tool_result'
      | 'text_editor_code_execution_tool_result'
      | 'web_fetch_tool_result';
  }
> {
  switch (part.type) {
    case 'container_upload':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
    case 'web_fetch_tool_result':
      return true;
    default:
      return false;
  }
}

function toAnthropicMiscPart(part: MultiModalContent): AnthropicContentBlock {
  if (part.type === 'container_upload') return { type: 'container_upload', file_id: part.file_id };
  return toAnthropicCodeBlock(part);
}

function toAnthropicCodeBlock(part: MultiModalContent): AnthropicContentBlock {
  if (part.type === 'code_execution_tool_result')
    return { type: part.type, tool_use_id: part.tool_use_id, content: part.content };
  if (part.type === 'bash_code_execution_tool_result')
    return { type: part.type, tool_use_id: part.tool_use_id, content: part.content };
  if (part.type === 'text_editor_code_execution_tool_result')
    return { type: part.type, tool_use_id: part.tool_use_id, content: part.content };
  if (part.type === 'web_fetch_tool_result') {
    return { type: part.type, tool_use_id: part.tool_use_id, content: part.content };
  }
  throw new TypeError(`Unsupported Anthropic miscellaneous content ${part.type}.`);
}

function toAnthropicDocument(
  part: Extract<MultiModalContent, { type: 'document' }>,
): AnthropicContentBlock {
  if (part.source.kind === 'base64')
    return {
      type: 'document',
      title: part.name,
      source: { type: 'base64', media_type: part.mimeType, data: part.source.data },
    };
  if (part.source.uri.startsWith('http://') || part.source.uri.startsWith('https://'))
    return { type: 'document', title: part.name, source: { type: 'url', url: part.source.uri } };
  if (part.source.uri.startsWith('file:'))
    return {
      type: 'document',
      title: part.name,
      source: { type: 'file', file_id: part.source.uri.slice('file:'.length) },
    };
  return { type: 'text', text: renderDocumentReferenceText(part) };
}

function toAnthropicImage(url: string): AnthropicContentBlock {
  const match = url.startsWith('data:') ? url.match(/^data:([^;]+);base64,(.+)$/) : null;
  if (match?.[1] && match[2])
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  return { type: 'image', source: { type: 'url', url } };
}

/**
 * Converts an internal ToolCall to Anthropic tool_use block.
 */
export function toToolUseBlock(toolCall: ToolCall): AnthropicToolUseBlock {
  let input: unknown = toolCall.arguments;
  if (typeof toolCall.arguments === 'string') {
    try {
      input = JSON.parse(toolCall.arguments) as unknown;
    } catch {
      input = toolCall.arguments;
    }
  }
  return {
    type: 'tool_use',
    id: toolCall.id,
    name: toolCall.name,
    input,
  };
}

/**
 * Converts an internal ToolResult to Anthropic tool_result block.
 */
export function toToolResultBlock(toolResult: ToolResult): AnthropicToolResultBlock {
  const payload =
    toolResult.outcome === 'success'
      ? toolResult.content
      : {
          outcome: toolResult.outcome,
          content: toolResult.content,
          ...(toolResult.error ? { error: toolResult.error } : {}),
          ...(toolResult.action ? { action: toolResult.action } : {}),
        };
  const result: AnthropicToolResultBlock = {
    type: 'tool_result',
    tool_use_id: toolResult.callId,
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };

  if (toolResult.outcome !== 'success') {
    result.is_error = true;
  }

  return result;
}

/**
 * Renders a single system/developer message's content to plain text.
 */
function systemMessageText(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n\n');
}

/**
 * Collects system message content from a conversation. Returns a plain
 * joined string in the common case; when at least one system message carries
 * a `cacheBoundary`, returns one addressable block per system message so the
 * cache breakpoint can be attached to the right segment.
 */
export function extractSystemPrompt(
  messages: ReadonlyArray<Message>,
  extendedCacheTtl: boolean,
): string | AnthropicSystemBlock[] | undefined {
  const systemMessages = messages.filter(
    (m) => (m.role === 'system' || m.role === 'developer') && !m.hidden && !isStreamingMessage(m),
  );

  if (systemMessages.length === 0) {
    return undefined;
  }

  const hasCacheBoundary = systemMessages.some((m) => m.cacheBoundary);
  if (!hasCacheBoundary) {
    return systemMessages.map((m) => systemMessageText(m)).join('\n\n');
  }

  return systemMessages.map((m) => {
    const text = systemMessageText(m);
    // Anthropic cannot cache an empty text block — there is nothing to cache.
    const canCache = m.cacheBoundary && text !== '';
    return {
      type: 'text' as const,
      text,
      ...(canCache
        ? {
            cache_control: {
              type: 'ephemeral' as const,
              ...(extendedCacheTtl ? { ttl: '1h' as const } : {}),
            },
          }
        : {}),
    };
  });
}
