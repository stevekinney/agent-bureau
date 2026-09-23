import { assertConversationSafe } from '../../conversation/validation';
import { isStreamingMessage } from '../../streaming';
import type { ConversationHistory as Conversation, Message } from '../../types';
import { getOrderedMessages } from '../../utilities/message-store';
import {
  extractSystemPrompt,
  toAnthropicContent,
  toToolResultBlock,
  toToolUseBlock,
} from './content';
import type {
  AnthropicContentBlock,
  AnthropicConversation,
  AnthropicMessage,
  AnthropicSystemBlock,
  ToAnthropicMessagesOptions,
} from './types';

const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Anthropic cannot cache a `thinking`/`redacted_thinking` block (the
 * signature covers the whole block, so marking it is meaningless) or a text
 * block with no content (there is nothing to cache).
 */
function isCacheableAnthropicBlock(block: AnthropicContentBlock): boolean {
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return false;
  if (block.type === 'text' && block.text === '') return false;
  return true;
}

/**
 * Finds the last block in a run that Anthropic can actually attach
 * `cache_control` to, walking backward from the end. Returns -1 if none of
 * the blocks are cacheable.
 */
function lastCacheableBlockIndex(blocks: ReadonlyArray<AnthropicContentBlock>): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (isCacheableAnthropicBlock(blocks[index]!)) return index;
  }
  return -1;
}

function stripCacheControl(block: AnthropicContentBlock): AnthropicContentBlock {
  if (block.cache_control === undefined) return block;
  const { cache_control: _cacheControl, ...rest } = block;
  return rest;
}

function stripSystemCacheControl(block: AnthropicSystemBlock): AnthropicSystemBlock {
  if (block.cache_control === undefined) return block;
  const { cache_control: _cacheControl, ...rest } = block;
  return rest;
}

/**
 * Enforces Anthropic's 4-breakpoint-per-request cap. When more than 4 blocks
 * carry `cache_control`, strips it from the EARLIEST excess ones and keeps
 * only the last {@link MAX_CACHE_BREAKPOINTS} in document order (system
 * blocks first, then messages in order). Anthropic's caching is
 * prefix-cumulative, so a later breakpoint still covers everything an
 * earlier, now-unmarked one would have — dropping the oldest marks loses
 * their own distinct cache-hit granularity, not their coverage.
 */
function capCacheBreakpoints(result: AnthropicConversation): AnthropicConversation {
  type Location =
    | { kind: 'system'; index: number }
    | { kind: 'message'; messageIndex: number; blockIndex: number };

  const locations: Location[] = [];

  if (Array.isArray(result.system)) {
    result.system.forEach((block, index) => {
      if (block.cache_control !== undefined) locations.push({ kind: 'system', index });
    });
  }

  result.messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (block.cache_control !== undefined) {
        locations.push({ kind: 'message', messageIndex, blockIndex });
      }
    });
  });

  if (locations.length <= MAX_CACHE_BREAKPOINTS) return result;

  const toStrip = locations.slice(0, locations.length - MAX_CACHE_BREAKPOINTS);
  const stripSystemIndices = new Set(
    toStrip
      .filter(
        (location): location is Extract<Location, { kind: 'system' }> => location.kind === 'system',
      )
      .map((location) => location.index),
  );
  const stripMessageBlocks = new Map<number, Set<number>>();
  for (const location of toStrip) {
    if (location.kind === 'message') {
      const set = stripMessageBlocks.get(location.messageIndex) ?? new Set<number>();
      set.add(location.blockIndex);
      stripMessageBlocks.set(location.messageIndex, set);
    }
  }

  const system = Array.isArray(result.system)
    ? result.system.map((block, index) =>
        stripSystemIndices.has(index) ? stripSystemCacheControl(block) : block,
      )
    : result.system;

  const messages = result.messages.map((message, messageIndex) => {
    const blockIndicesToStrip = stripMessageBlocks.get(messageIndex);
    if (!blockIndicesToStrip || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((block, blockIndex) =>
        blockIndicesToStrip.has(blockIndex) ? stripCacheControl(block) : block,
      ),
    };
  });

  const capped: AnthropicConversation = { messages };
  if (system !== undefined) {
    capped.system = system;
  }
  return capped;
}

function toOutboundMessage(
  message: Message,
): { role: 'user' | 'assistant'; blocks: AnthropicContentBlock[] } | undefined {
  if (shouldSkipOutboundMessage(message)) return undefined;
  if (message.role === 'user' || message.role === 'assistant') {
    const content = toAnthropicContent(message.content);
    return {
      role: message.role,
      blocks: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    };
  }
  return toToolMessage(message);
}

function shouldSkipOutboundMessage(message: Message): boolean {
  return (
    message.hidden ||
    isStreamingMessage(message) ||
    message.role === 'system' ||
    message.role === 'developer' ||
    message.role === 'snapshot'
  );
}

function toToolMessage(
  message: Message,
): { role: 'user' | 'assistant'; blocks: AnthropicContentBlock[] } | undefined {
  if (message.role === 'tool-call' && message.toolCall)
    return { role: 'assistant', blocks: [toToolUseBlock(message.toolCall)] };
  if (message.role === 'tool-result' && message.toolResult)
    return { role: 'user', blocks: [toToolResultBlock(message.toolResult)] };
  return undefined;
}

/**
 * Converts a conversation to Anthropic Messages API format.
 * System messages are extracted to the top-level `system` field.
 * Tool calls become tool_use blocks, tool results become tool_result blocks.
 *
 * @example
 * ```ts
 * import { toAnthropicMessages } from 'conversationalist';
 *
 * const { system, messages } = toAnthropicMessages(conversation);
 * const response = await anthropic.messages.create({
 *   model: 'claude-3-opus-20240229',
 *   system,
 *   messages,
 * });
 * ```
 */
export function toAnthropicMessages(
  conversation: Conversation,
  options?: ToAnthropicMessagesOptions,
): AnthropicConversation {
  assertConversationSafe(conversation);
  const extendedCacheTtl = options?.extendedCacheTtl ?? false;
  const ordered = getOrderedMessages(conversation);
  const system = extractSystemPrompt(ordered, extendedCacheTtl);
  const messages: AnthropicMessage[] = [];

  // Track pending content blocks to merge consecutive same-role messages
  let currentRole: 'user' | 'assistant' | null = null;
  let currentBlocks: AnthropicContentBlock[] = [];

  const flushCurrent = () => {
    if (currentRole && currentBlocks.length > 0) {
      const onlyBlock = currentBlocks.length === 1 ? currentBlocks[0] : undefined;
      // A cache_control breakpoint must stay attached to a real block — a
      // lone text block carrying one cannot collapse to a bare string.
      const collapsible =
        onlyBlock?.type === 'text' &&
        onlyBlock.citations === undefined &&
        onlyBlock.cache_control === undefined;
      messages.push({
        role: currentRole,
        content: collapsible && onlyBlock?.type === 'text' ? onlyBlock.text : currentBlocks,
      });
      currentBlocks = [];
    }
    currentRole = null;
  };

  for (const message of ordered) {
    const converted = toOutboundMessage(message);
    if (converted === undefined) continue;
    let { role: targetRole, blocks } = converted;

    // A cache boundary marks everything up to and including THIS message as
    // cacheable, so the breakpoint lands on the last block this specific
    // message contributed (not the last block of the merged Anthropic
    // message, which may span several ConversationHistory messages). Anthropic
    // cannot cache a `thinking`/`redacted_thinking` block or an empty text
    // block, so walk backward to the last block that CAN carry the mark;
    // if none exists, the boundary is silently not lowered for this message
    // rather than producing an invalid breakpoint.
    blocks = applyCacheBoundary(message, blocks, extendedCacheTtl);

    // Merge with current or start new
    if (currentRole === targetRole) {
      currentBlocks.push(...blocks);
    } else {
      flushCurrent();
      currentRole = targetRole;
      currentBlocks = blocks;
    }
  }

  flushCurrent();

  const result: AnthropicConversation = { messages };
  if (system !== undefined) {
    result.system = system;
  }
  return capCacheBreakpoints(result);
}

function applyCacheBoundary(
  message: Message,
  blocks: AnthropicContentBlock[],
  extendedCacheTtl: boolean,
): AnthropicContentBlock[] {
  if (!message.cacheBoundary || blocks.length === 0) return blocks;
  const index = lastCacheableBlockIndex(blocks);
  if (index === -1) return blocks;
  const target = blocks[index];
  if (!target) return blocks;
  return [
    ...blocks.slice(0, index),
    { ...target, cache_control: { type: 'ephemeral', ...(extendedCacheTtl ? { ttl: '1h' } : {}) } },
    ...blocks.slice(index + 1),
  ];
}
