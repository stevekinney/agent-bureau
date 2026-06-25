import { ensureConversationSafe } from './conversation/validation';
import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from './environment';
import type {
  MultiModalContent,
  RedactedThinkingContent,
  ServerToolUseContent,
  TextContent,
  ThinkingContent,
  ToolUseContent,
} from './multi-modal';
import { jsonValueSchema } from './schemas';
import type {
  AssistantMessage,
  ConversationHistory as Conversation,
  JSONValue,
  Message,
  TokenUsage,
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
  | { type: 'redacted_thinking'; signature: string }
  | { type: 'tool_use'; id: string; name: string; inputBuffer: string }
  | { type: 'server_tool_use'; id: string; name: string; inputBuffer: string };

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
  /** Set the signature on a thinking or redacted_thinking block. */
  setSignature(signature: string): void;
  /** Append an input_json_delta to a tool_use or server_tool_use block. */
  appendInputJsonDelta(delta: string): void;
}

/**
 * Accumulates a multi-part streaming response keyed by block index.
 * Feed events as they arrive; call `finalize()` to build the completed
 * `MultiModalContent[]` for the finished message.
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
   * Finalize the accumulated blocks into a `MultiModalContent[]`.
   * JSON input buffers for tool_use / server_tool_use blocks are parsed at
   * this point. A malformed or non-JSON-value buffer throws, because a tool
   * call with silently-dropped input is indistinguishable from one the model
   * deliberately invoked with empty input — a dangerous ambiguity for a
   * protocol layer to paper over.
   * Call this when the `message_stop` event arrives.
   */
  finalize(): MultiModalContent[];
}

/**
 * Parses a streamed tool-input buffer into a {@link JSONValue}, throwing if the
 * buffer is not valid JSON or does not encode a JSON value. The block name is
 * included in the error to make a corrupt stream diagnosable.
 */
function parseStreamedToolInput(toolName: string, inputBuffer: string): JSONValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputBuffer);
  } catch (cause) {
    throw new Error(
      `Streamed tool input for "${toolName}" is not valid JSON; the stream may be incomplete or corrupt.`,
      { cause },
    );
  }
  const result = jsonValueSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Streamed tool input for "${toolName}" is not a JSON value.`);
  }
  return result.data;
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
    setSignature(signature: string) {
      if (state.type === 'thinking') {
        state = { ...state, signature };
      } else if (state.type === 'redacted_thinking') {
        state = { type: 'redacted_thinking', signature };
      }
    },
    appendInputJsonDelta(delta: string) {
      if (state.type === 'tool_use') {
        state = { ...state, inputBuffer: state.inputBuffer + delta };
      } else if (state.type === 'server_tool_use') {
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
 * // On message_stop:
 * const content = acc.finalize(); // MultiModalContent[]
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
    finalize(): MultiModalContent[] {
      const result: MultiModalContent[] = [];
      // Sort by index to preserve block order
      const sortedIndices = [...blocks.keys()].sort((a, b) => a - b);

      for (const index of sortedIndices) {
        const block = blocks.get(index);
        if (!block) continue;

        const { state } = block;
        switch (state.type) {
          case 'text': {
            const textPart: TextContent = { type: 'text', text: state.buffer };
            result.push(textPart);
            break;
          }
          case 'thinking': {
            const thinkingPart: ThinkingContent = {
              type: 'thinking',
              thinking: state.buffer,
              signature: state.signature,
            };
            result.push(thinkingPart);
            break;
          }
          case 'redacted_thinking': {
            const redactedPart: RedactedThinkingContent = {
              type: 'redacted_thinking',
              signature: state.signature,
            };
            result.push(redactedPart);
            break;
          }
          case 'tool_use': {
            const toolPart: ToolUseContent = {
              type: 'tool_use',
              id: state.id,
              name: state.name,
              input: parseStreamedToolInput(state.name, state.inputBuffer),
            };
            result.push(toolPart);
            break;
          }
          case 'server_tool_use': {
            const serverToolPart: ServerToolUseContent = {
              type: 'server_tool_use',
              id: state.id,
              name: state.name,
              input: parseStreamedToolInput(state.name, state.inputBuffer),
            };
            result.push(serverToolPart);
            break;
          }
        }
      }

      return result;
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
