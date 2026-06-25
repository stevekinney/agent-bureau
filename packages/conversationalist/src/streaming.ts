import { ensureConversationSafe } from './conversation/validation';
import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from './environment';
import type { MultiModalContent } from './multi-modal';
import type {
  AssistantMessage,
  ConversationHistory as Conversation,
  JSONValue,
  Message,
  TokenUsage,
  ToolCall,
} from './types';
import { createMessage, isAssistantMessage, toReadonly } from './utilities';
import { getOrderedMessages, toIdRecord } from './utilities/message-store';

const STREAMING_KEY = '__streaming';

const cloneMessage = (
  original: Message,
  overrides: {
    content?: string | MultiModalContent[];
    metadata?: Record<string, JSONValue>;
    position?: number;
    tokenUsage?: TokenUsage;
  } = {},
): Message => {
  const baseMessage = {
    id: original.id,
    role: original.role,
    content:
      overrides.content ??
      (typeof original.content === 'string'
        ? original.content
        : [...(original.content as MultiModalContent[])]),
    position: overrides.position ?? original.position,
    createdAt: original.createdAt,
    metadata: overrides.metadata ?? { ...original.metadata },
    hidden: original.hidden,
    toolCall: original.toolCall ? { ...original.toolCall } : undefined,
    toolResult: original.toolResult ? { ...original.toolResult } : undefined,
    tokenUsage: overrides.tokenUsage,
  };

  if (isAssistantMessage(original)) {
    const assistantMessage: AssistantMessage = {
      ...baseMessage,
      role: 'assistant',
      goalCompleted: original.goalCompleted,
    };
    return createMessage(assistantMessage);
  }

  return createMessage(baseMessage);
};

/**
 * Checks if a message is currently streaming (has the streaming metadata flag).
 */
export function isStreamingMessage(message: Message): boolean {
  return message.metadata[STREAMING_KEY] === true;
}

/**
 * Gets the currently streaming message from a conversation, if any.
 */
export function getStreamingMessage(conversation: Conversation): Message | undefined {
  return getOrderedMessages(conversation).find(isStreamingMessage);
}

/**
 * Creates a pending/streaming message placeholder and appends it to the conversation.
 * Returns both the updated conversation and the ID of the new streaming message.
 */
export function appendStreamingMessage(
  conversation: Conversation,
  role: 'assistant' | 'user',
  metadata?: Record<string, JSONValue>,
  environment?: Partial<ConversationEnvironment>,
): { conversation: Conversation; messageId: string } {
  const resolvedEnvironment = resolveConversationEnvironment(
    isConversationEnvironmentParameter(metadata) ? metadata : environment,
  );
  const resolvedMetadata = isConversationEnvironmentParameter(metadata) ? undefined : metadata;
  const now = resolvedEnvironment.now();
  const messageId = resolvedEnvironment.randomId();

  const newMessage = createMessage({
    id: messageId,
    role,
    content: '',
    position: conversation.ids.length,
    createdAt: now,
    metadata: { ...(resolvedMetadata ?? {}), [STREAMING_KEY]: true },
    hidden: false,
    toolCall: undefined,
    toolResult: undefined,
    tokenUsage: undefined,
  });

  const updatedConversation = toReadonly({
    ...conversation,
    ids: [...conversation.ids, messageId],
    messages: { ...conversation.messages, [messageId]: newMessage },
    updatedAt: now,
  });

  return { conversation: ensureConversationSafe(updatedConversation), messageId };
}

/**
 * Updates the content of a streaming message.
 * This replaces the existing content (use for accumulating streamed tokens).
 */
export function updateStreamingMessage(
  conversation: Conversation,
  messageId: string,
  content: string | MultiModalContent[],
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const now = resolvedEnvironment.now();

  const original = conversation.messages[messageId];
  if (!original) {
    return ensureConversationSafe(conversation);
  }

  const overrides: {
    content?: string | MultiModalContent[];
    tokenUsage?: TokenUsage;
  } = {
    content: typeof content === 'string' ? content : [...content],
  };
  if (original.tokenUsage) {
    overrides.tokenUsage = { ...original.tokenUsage };
  }

  const updated = cloneMessage(original, overrides);

  return ensureConversationSafe(
    toReadonly({
      ...conversation,
      ids: [...conversation.ids],
      messages: { ...conversation.messages, [updated.id]: updated },
      updatedAt: now,
    }),
  );
}

/**
 * Marks a streaming message as complete, removing the streaming flag.
 * Optionally adds token usage and additional metadata.
 */
export function finalizeStreamingMessage(
  conversation: Conversation,
  messageId: string,
  options?: {
    tokenUsage?: TokenUsage;
    metadata?: Record<string, JSONValue>;
  },
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = resolveConversationEnvironment(
    isConversationEnvironmentParameter(options) ? options : environment,
  );
  const resolvedOptions = isConversationEnvironmentParameter(options) ? undefined : options;
  const now = resolvedEnvironment.now();

  const original = conversation.messages[messageId];
  if (!original) {
    return ensureConversationSafe(conversation);
  }

  // Remove the streaming flag and merge in any new metadata
  const { [STREAMING_KEY]: _, ...restMetadata } = original.metadata as Record<string, JSONValue>;
  const finalMetadata: Record<string, JSONValue> = {
    ...restMetadata,
    ...(resolvedOptions?.metadata ?? {}),
  };

  const finalizeOverrides: {
    metadata?: Record<string, JSONValue>;
    tokenUsage?: TokenUsage;
  } = {
    metadata: finalMetadata,
  };
  if (resolvedOptions?.tokenUsage) {
    finalizeOverrides.tokenUsage = { ...resolvedOptions.tokenUsage };
  }

  const updated = cloneMessage(original, finalizeOverrides);

  return ensureConversationSafe(
    toReadonly({
      ...conversation,
      ids: [...conversation.ids],
      messages: { ...conversation.messages, [updated.id]: updated },
      updatedAt: now,
    }),
  );
}

// ─── Multi-part streaming accumulation ──────────────────────────────────────

/**
 * Discriminated union representing the accumulated state of one content block
 * during a streaming response. Each variant maps to an Anthropic block type.
 */
export type BlockAccumulatorState =
  | { type: 'text'; buffer: string }
  | { type: 'thinking'; buffer: string; signature: string }
  // redacted_thinking carries its encrypted payload in `data` (seeded at
  // content_block_start), not a streamed signature.
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; inputBuffer: string }
  | { type: 'server_tool_use'; id: string; name: string; inputBuffer: string }
  // Server-tool result blocks (web search, code execution) arrive with their
  // content in the content_block_start event rather than via deltas, so the
  // content is seeded at openBlock and carried through unchanged.
  | { type: 'web_search_tool_result'; tool_use_id: string; content: JSONValue }
  | {
      type:
        | 'code_execution_tool_result'
        | 'bash_code_execution_tool_result'
        | 'text_editor_code_execution_tool_result';
      tool_use_id: string;
      content: JSONValue;
    };

/**
 * An accumulator for a single content block within a streaming response.
 * Call the appropriate `append*` method as deltas arrive, then read `state`
 * once `content_block_stop` fires.
 */
export interface BlockAccumulator {
  /** Current accumulated state of this block. */
  readonly state: BlockAccumulatorState;
  /** Append a text_delta to a text or thinking block. */
  appendTextDelta(delta: string): void;
  /** Append a thinking_delta to a thinking block. */
  appendThinkingDelta(delta: string): void;
  /**
   * Append a signature_delta chunk to a thinking block's signature. Anthropic
   * may split the signature across multiple signature_delta events, so this
   * accumulates rather than replaces — the full signature must survive
   * byte-for-byte for extended-thinking replay.
   */
  appendSignatureDelta(delta: string): void;
  /** Append an input_json_delta to a tool_use or server_tool_use block. */
  appendInputJsonDelta(delta: string): void;
}

/**
 * One ordered piece of a finalized stream. Either a run of assistant content
 * blocks, or a single client tool call (which the conversation model represents
 * as its own `tool-call` role message). Emitting these in order preserves the
 * stream's true block order even when a client `tool_use` is interleaved between
 * content blocks (`[text, tool_use, text]`).
 */
export type StreamSegment =
  | { kind: 'content'; content: MultiModalContent[] }
  | { kind: 'tool-call'; toolCall: ToolCall };

/**
 * The result of finalizing a streamed message: an ordered list of
 * {@link StreamSegment}s. The caller appends each segment in order — a `content`
 * segment as an assistant message, a `tool-call` segment as a `tool-call` role
 * message — which both keeps tool-call/tool-result pairing intact (the tool call
 * becomes a real message a later `tool-result` can reference) AND preserves the
 * original block order. {@link contentOf} / {@link toolCallsOf} are convenience
 * accessors when order across the content/tool boundary does not matter.
 */
export interface StreamFinalizeResult {
  segments: StreamSegment[];
}

/** All assistant-content blocks across a finalized stream, in order (ignoring tool-call interleaving). */
export function contentOf(result: StreamFinalizeResult): MultiModalContent[] {
  return result.segments.flatMap((s) => (s.kind === 'content' ? s.content : []));
}

/** All client tool calls across a finalized stream, in block order. */
export function toolCallsOf(result: StreamFinalizeResult): ToolCall[] {
  return result.segments.flatMap((s) => (s.kind === 'tool-call' ? [s.toolCall] : []));
}

/**
 * Accumulates a multi-part streaming response keyed by block index.
 * Feed events as they arrive; call `finalize()` to build the completed message.
 */
export interface StreamingMessageAccumulator {
  /**
   * Open a new content block at the given index.
   * Call this when a `content_block_start` event arrives.
   */
  openBlock(index: number, state: BlockAccumulatorState): BlockAccumulator;
  /**
   * Get the accumulator for a block that is already open.
   * Returns undefined if no block exists at the given index.
   */
  getBlock(index: number): BlockAccumulator | undefined;
  /**
   * Finalize the accumulated blocks into a {@link StreamFinalizeResult}: ordered
   * assistant `content` plus the client `toolCalls` to append as `tool-call`
   * messages. JSON input buffers for tool_use / server_tool_use blocks are parsed
   * here. An empty buffer is a legitimate no-argument tool call and finalizes to
   * `{}`; a NON-empty but malformed buffer throws, because a truncated tool call
   * silently degrading to empty input is a dangerous ambiguity for a protocol
   * layer to paper over. Call this when the `message_stop` event arrives.
   */
  finalize(): StreamFinalizeResult;
}

/**
 * Parses a streamed tool-input buffer into a {@link JSONValue}.
 *
 * An empty buffer means no `input_json_delta` arrived, which is exactly how a
 * zero-argument tool call streams — it finalizes to `{}`. A non-empty buffer
 * that is not valid JSON throws, because a partial/corrupt buffer must not
 * silently degrade to empty input. The block name is included to make a corrupt
 * stream diagnosable.
 */
function parseStreamedToolInput(toolName: string, inputBuffer: string): JSONValue {
  // A no-argument tool call produces no input_json_delta; treat that as `{}`
  // rather than throwing on JSON.parse('').
  if (inputBuffer === '') {
    return {};
  }
  try {
    // JSON.parse only ever yields a JSON value, so this cast asserts its
    // documented contract rather than papering over a type-model gap.
    return JSON.parse(inputBuffer) as JSONValue;
  } catch (cause) {
    throw new Error(
      `Streamed tool input for "${toolName}" is not valid JSON; the stream may be incomplete or corrupt.`,
      { cause },
    );
  }
}

function createBlockAccumulator(initial: BlockAccumulatorState): BlockAccumulator {
  let state: BlockAccumulatorState = { ...initial };

  return {
    get state() {
      return state;
    },
    appendTextDelta(delta: string) {
      if (state.type === 'text') {
        state = { type: 'text', buffer: state.buffer + delta };
      } else if (state.type === 'thinking') {
        state = { ...state, buffer: state.buffer + delta };
      }
    },
    appendThinkingDelta(delta: string) {
      if (state.type === 'thinking') {
        state = { ...state, buffer: state.buffer + delta };
      }
    },
    appendSignatureDelta(delta: string) {
      // Only thinking blocks receive a streamed signature_delta; accumulate the
      // chunks. A redacted_thinking block's encrypted `data` is seeded at openBlock.
      if (state.type === 'thinking') {
        state = { ...state, signature: state.signature + delta };
      }
    },
    appendInputJsonDelta(delta: string) {
      if (state.type === 'tool_use' || state.type === 'server_tool_use') {
        state = { ...state, inputBuffer: state.inputBuffer + delta };
      }
    },
  };
}

/**
 * Creates a new `StreamingMessageAccumulator` for accumulating a multi-part
 * streamed Anthropic response.
 *
 * @example
 * ```ts
 * import { createStreamingAccumulator } from 'conversationalist/streaming';
 *
 * const acc = createStreamingAccumulator();
 *
 * // On content_block_start for a text block at index 0:
 * acc.openBlock(0, { type: 'text', buffer: '' });
 *
 * // On text_delta:
 * acc.getBlock(0)?.appendTextDelta(delta.text);
 *
 * // On content_block_start for a tool_use block at index 1:
 * acc.openBlock(1, { type: 'tool_use', id: 'call-1', name: 'my_tool', inputBuffer: '' });
 *
 * // On input_json_delta:
 * acc.getBlock(1)?.appendInputJsonDelta(delta.partial_json);
 *
 * // On message_stop: append each segment in order to preserve block order and
 * // keep tool-call/tool-result pairing intact.
 * const { segments } = acc.finalize();
 * for (const segment of segments) {
 *   conversation =
 *     segment.kind === 'content'
 *       ? appendMessages(conversation, { role: 'assistant', content: segment.content })
 *       : appendMessages(conversation, { role: 'tool-call', content: '', toolCall: segment.toolCall });
 * }
 * ```
 */
export function createStreamingAccumulator(): StreamingMessageAccumulator {
  const blocks = new Map<number, BlockAccumulator>();

  return {
    openBlock(index: number, state: BlockAccumulatorState): BlockAccumulator {
      const accumulator = createBlockAccumulator(state);
      blocks.set(index, accumulator);
      return accumulator;
    },
    getBlock(index: number): BlockAccumulator | undefined {
      return blocks.get(index);
    },
    finalize(): StreamFinalizeResult {
      const segments: StreamSegment[] = [];
      // The current run of contiguous assistant-content blocks. A client tool_use
      // flushes it and emits a tool-call segment, so interleaved sequences like
      // [text, tool_use, text] keep their true block order across the segments.
      let currentContent: MultiModalContent[] = [];
      const flushContent = () => {
        if (currentContent.length > 0) {
          segments.push({ kind: 'content', content: currentContent });
          currentContent = [];
        }
      };

      // Sort by index to preserve block order
      const sortedIndices = [...blocks.keys()].sort((a, b) => a - b);

      for (const index of sortedIndices) {
        const block = blocks.get(index);
        if (!block) continue;

        const { state } = block;
        switch (state.type) {
          case 'text':
            currentContent.push({ type: 'text', text: state.buffer });
            break;
          case 'thinking':
            currentContent.push({
              type: 'thinking',
              thinking: state.buffer,
              signature: state.signature,
            });
            break;
          case 'redacted_thinking':
            currentContent.push({ type: 'redacted_thinking', data: state.data });
            break;
          case 'tool_use': {
            // Client tool call: flush the content run first so the tool-call
            // segment lands in its true block position, then emit it.
            flushContent();
            segments.push({
              kind: 'tool-call',
              toolCall: {
                id: state.id,
                name: state.name,
                arguments: parseStreamedToolInput(state.name, state.inputBuffer),
              },
            });
            break;
          }
          case 'server_tool_use':
            currentContent.push({
              type: 'server_tool_use',
              id: state.id,
              name: state.name,
              input: parseStreamedToolInput(state.name, state.inputBuffer),
            });
            break;
          case 'web_search_tool_result':
            currentContent.push({
              type: 'web_search_tool_result',
              tool_use_id: state.tool_use_id,
              content: state.content,
            });
            break;
          case 'code_execution_tool_result':
          case 'bash_code_execution_tool_result':
          case 'text_editor_code_execution_tool_result':
            currentContent.push({
              type: state.type,
              tool_use_id: state.tool_use_id,
              content: state.content,
            });
            break;
        }
      }

      flushContent();
      return { segments };
    },
  };
}

/**
 * Cancels a streaming message by removing it from the conversation.
 */
export function cancelStreamingMessage(
  conversation: Conversation,
  messageId: string,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const now = resolvedEnvironment.now();

  if (!conversation.messages[messageId]) {
    return ensureConversationSafe(conversation);
  }

  const messages = getOrderedMessages(conversation)
    .filter((m) => m.id !== messageId)
    .map((message, index) =>
      message.position === index
        ? message
        : (() => {
            const overrides: { position: number; tokenUsage?: TokenUsage } = {
              position: index,
            };
            if (message.tokenUsage) {
              overrides.tokenUsage = { ...message.tokenUsage };
            }
            return cloneMessage(message, overrides);
          })(),
    );

  return ensureConversationSafe(
    toReadonly({
      ...conversation,
      ids: messages.map((message) => message.id),
      messages: toIdRecord(messages),
      updatedAt: now,
    }),
  );
}
