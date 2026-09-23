import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { ConversationHistory as Conversation } from '../../types';
import { toAnthropicMessages } from './outbound';
import {
  isAnthropicImageMediaType,
  toSdkCitations,
  toSdkWebSearchToolResultContent,
} from './sdk-validation';
import type {
  AnthropicCacheControl,
  AnthropicContentBlock,
  AnthropicSdkConversation,
  ToAnthropicMessagesOptions,
} from './types';

/** Converts a neutral Anthropic conversation to the official SDK request shapes. */
export function toAnthropicMessagesForSdk(
  conversation: Conversation,
  options?: ToAnthropicMessagesOptions,
): AnthropicSdkConversation {
  const neutral = toAnthropicMessages(conversation, options);

  return {
    ...(neutral.system === undefined
      ? {}
      : {
          system:
            typeof neutral.system === 'string'
              ? neutral.system
              : neutral.system.map((block) => ({
                  type: 'text' as const,
                  text: block.text,
                  ...(block.cache_control
                    ? { cache_control: toSdkCacheControl(block.cache_control) }
                    : {}),
                })),
        }),
    messages: neutral.messages.map((message): MessageParam => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map(toSdkContentBlock),
    })),
  };
}

function toSdkCacheControl(cacheControl: AnthropicCacheControl) {
  return {
    type: 'ephemeral' as const,
    ...(cacheControl.ttl === undefined ? {} : { ttl: cacheControl.ttl }),
  };
}

function toSdkContentBlock(block: AnthropicContentBlock): ContentBlockParam {
  const cacheControl = getSdkCacheControl(block);
  if (block.type === 'text') return toSdkTextBlock(block, cacheControl);
  if (block.type === 'image') return toSdkImageBlock(block, cacheControl);
  if (block.type === 'document') return toSdkDocumentBlock(block, cacheControl);
  if (block.type === 'tool_use') return toSdkToolUseBlock(block, cacheControl);
  if (block.type === 'tool_result') return toSdkToolResultBlock(block, cacheControl);
  if (block.type === 'server_tool_use') return toSdkServerToolBlock(block, cacheControl);
  if (block.type === 'web_search_tool_result') return toSdkWebSearchBlock(block, cacheControl);
  if (block.type === 'thinking')
    return { type: 'thinking', thinking: block.thinking, signature: block.signature };
  if (block.type === 'redacted_thinking') return { type: 'redacted_thinking', data: block.data };
  throw new TypeError(`Anthropic SDK does not accept ${block.type} request blocks.`);
}

function getSdkCacheControl(
  block: AnthropicContentBlock,
): ReturnType<typeof toSdkCacheControl> | undefined {
  return block.cache_control === undefined ? undefined : toSdkCacheControl(block.cache_control);
}

function toSdkTextBlock(
  block: Extract<AnthropicContentBlock, { type: 'text' }>,
  cacheControl: ReturnType<typeof toSdkCacheControl> | undefined,
): ContentBlockParam {
  return {
    type: 'text',
    text: block.text,
    ...(block.citations !== undefined ? { citations: toSdkCitations(block.citations) } : {}),
    ...(cacheControl ? { cache_control: cacheControl } : {}),
  };
}
function toSdkImageBlock(
  block: Extract<AnthropicContentBlock, { type: 'image' }>,
  cacheControl: ReturnType<typeof toSdkCacheControl> | undefined,
): ContentBlockParam {
  if (block.source.type === 'url')
    return {
      type: 'image',
      source: { type: 'url', url: block.source.url },
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    };
  if (!isAnthropicImageMediaType(block.source.media_type))
    throw new TypeError(
      `Anthropic SDK does not support image media type ${block.source.media_type}.`,
    );
  return {
    type: 'image',
    source: { type: 'base64', media_type: block.source.media_type, data: block.source.data },
    ...(cacheControl ? { cache_control: cacheControl } : {}),
  };
}
function toSdkDocumentBlock(
  block: Extract<AnthropicContentBlock, { type: 'document' }>,
  cacheControl: ReturnType<typeof toSdkCacheControl> | undefined,
): ContentBlockParam {
  if (block.source.type === 'url')
    return {
      type: 'document',
      source: { type: 'url', url: block.source.url },
      ...(block.title === undefined ? {} : { title: block.title }),
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    };
  if (block.source.type === 'base64') {
    if (block.source.media_type !== 'application/pdf')
      throw new TypeError(
        `Anthropic SDK documents require application/pdf, got ${block.source.media_type}.`,
      );
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: block.source.data },
      ...(block.title === undefined ? {} : { title: block.title }),
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    };
  }
  throw new TypeError(
    `Anthropic SDK document ${block.source.type} sources cannot be submitted through this adapter.`,
  );
}
function toSdkToolUseBlock(
  block: Extract<AnthropicContentBlock, { type: 'tool_use' }>,
  cacheControl: ReturnType<typeof toSdkCacheControl> | undefined,
): ContentBlockParam {
  return {
    type: 'tool_use',
    id: block.id,
    name: block.name,
    input: block.input,
    ...(cacheControl ? { cache_control: cacheControl } : {}),
  };
}
function toSdkToolResultBlock(
  block: Extract<AnthropicContentBlock, { type: 'tool_result' }>,
  cacheControl: ReturnType<typeof toSdkCacheControl> | undefined,
): ContentBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content: block.content,
    ...(block.is_error === undefined ? {} : { is_error: block.is_error }),
    ...(cacheControl ? { cache_control: cacheControl } : {}),
  };
}
function toSdkServerToolBlock(
  block: Extract<AnthropicContentBlock, { type: 'server_tool_use' }>,
  cacheControl: ReturnType<typeof toSdkCacheControl> | undefined,
): ContentBlockParam {
  if (block.name !== 'web_search')
    throw new TypeError(`Anthropic SDK does not support server tool ${block.name}.`);
  return {
    type: 'server_tool_use',
    id: block.id,
    name: 'web_search',
    input: block.input,
    ...(cacheControl ? { cache_control: cacheControl } : {}),
  };
}
function toSdkWebSearchBlock(
  block: Extract<AnthropicContentBlock, { type: 'web_search_tool_result' }>,
  cacheControl: ReturnType<typeof toSdkCacheControl> | undefined,
): ContentBlockParam {
  return {
    type: 'web_search_tool_result',
    tool_use_id: block.tool_use_id,
    content: toSdkWebSearchToolResultContent(block.content),
    ...(cacheControl ? { cache_control: cacheControl } : {}),
  };
}
