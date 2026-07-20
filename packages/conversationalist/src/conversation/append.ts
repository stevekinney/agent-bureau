import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from '../environment';
import { createIntegrityError } from '../errors';
import type {
  ConversationHistory as Conversation,
  JSONValue,
  Message,
  MessageInput,
} from '../types';
import type { AppendableMessageInput } from '../utilities';
import { buildMessageFromInput, repositionMessage, toReadonly } from '../utilities';
import { getOrderedMessages, toIdRecord } from '../utilities/message-store';
import {
  assertToolReference,
  buildToolUseIndex,
  registerToolUse,
  type ToolUseIndex,
} from './tool-tracking';
import { ensureConversationSafe } from './validation';

/**
 * Separates message inputs from an optional trailing environment argument.
 */
function partitionAppendArgs(
  args: Array<AppendableMessageInput | Partial<ConversationEnvironment> | undefined>,
): {
  inputs: AppendableMessageInput[];
  environment?: Partial<ConversationEnvironment> | undefined;
} {
  const filtered = args.filter((arg) => arg !== undefined);

  if (filtered.length === 0) {
    return { inputs: [] };
  }

  const last = filtered[filtered.length - 1];
  if (isConversationEnvironmentParameter(last)) {
    return {
      inputs: filtered.slice(0, -1) as AppendableMessageInput[],
      environment: last,
    };
  }

  return { inputs: filtered as AppendableMessageInput[] };
}

/**
 * Runs conversation plugins over a MessageInput. Already-built messages
 * (identified by having an `id`) are passed through untouched — they were
 * presumably already processed once by `buildMessage`, and plugins are typed
 * against `MessageInput`'s mutable shape, which a `Message`'s readonly
 * `content` array isn't structurally assignable to anyway.
 */
function applyPlugins(
  input: AppendableMessageInput,
  plugins: ConversationEnvironment['plugins'],
): AppendableMessageInput {
  if ('id' in input) return input;
  return plugins.reduce((acc, plugin) => plugin(acc), input);
}

/**
 * Appends one or more messages to a conversation. Accepts raw `MessageInput`s
 * or already-built `Message`s (e.g. from `buildMessage`) — a pre-built
 * message's `id`/`createdAt` are preserved rather than re-minted, so a
 * message dispatched/persisted before it's part of a conversation keeps the
 * same identity once it's appended.
 * Validates that tool results reference existing function calls.
 * Returns a new immutable conversation with the messages added.
 */
export function appendMessages(
  conversation: Conversation,
  ...inputs: AppendableMessageInput[]
): Conversation;
export function appendMessages(
  conversation: Conversation,
  ...inputsAndEnvironment: [
    ...AppendableMessageInput[],
    Partial<ConversationEnvironment> | undefined,
  ]
): Conversation;
export function appendMessages(
  conversation: Conversation,
  ...args: (AppendableMessageInput | Partial<ConversationEnvironment> | undefined)[]
): Conversation {
  return appendMessagesInternal(conversation, args, true);
}

/**
 * Appends a message without validating conversation integrity or JSON-safety.
 * Use only when you have already validated the conversation yourself.
 */
export function appendUnsafeMessage(
  conversation: Conversation,
  input: AppendableMessageInput,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  return appendMessagesInternal(conversation, [input, environment], false);
}

const appendMessagesInternal = (
  conversation: Conversation,
  args: Array<AppendableMessageInput | Partial<ConversationEnvironment> | undefined>,
  validate: boolean,
): Conversation => {
  const { inputs, environment } = partitionAppendArgs(args);
  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const now = resolvedEnvironment.now();
  const startPosition = conversation.ids.length;
  const initialToolUses = validate
    ? buildToolUseIndex(getOrderedMessages(conversation))
    : new Map<string, { name: string }>();

  const { messages } = inputs.reduce<{
    toolUses: ToolUseIndex;
    messages: Message[];
  }>(
    (state, input, index) => {
      const processedInput = applyPlugins(input, resolvedEnvironment.plugins);

      if (validate && processedInput.role === 'tool-result' && processedInput.toolResult) {
        assertToolReference(state.toolUses, processedInput.toolResult.callId);
      }

      const message = buildMessageFromInput(
        processedInput,
        startPosition + index,
        now,
        resolvedEnvironment,
      );

      let toolUses = state.toolUses;
      if (processedInput.role === 'tool-call' && processedInput.toolCall) {
        if (validate && state.toolUses.has(processedInput.toolCall.id)) {
          throw createIntegrityError('duplicate toolCall.id in conversation', {
            toolCallId: processedInput.toolCall.id,
            messageId: message.id,
          });
        }

        toolUses = validate
          ? registerToolUse(state.toolUses, processedInput.toolCall)
          : state.toolUses;
      }

      return {
        toolUses,
        messages: [...state.messages, message],
      };
    },
    { toolUses: initialToolUses, messages: [] },
  );

  const messageIds = messages.map((message) => message.id);
  const next: Conversation = {
    ...conversation,
    ids: [...conversation.ids, ...messageIds],
    messages: { ...conversation.messages, ...toIdRecord(messages) },
    updatedAt: now,
  };
  const readonly = toReadonly(next);
  return validate ? ensureConversationSafe(readonly) : readonly;
};

/**
 * Prepends one or more messages to the front of a conversation, mirroring
 * `appendMessages` for the front-of-list case. Renumbers every existing
 * message's `position` so `position` stays dense and ordered across the
 * entire `ids` array — this is the internal-shape reach-in (hand-rolled
 * `Message` construction plus manual `position` renumbering) that history
 * pagination would otherwise have to do itself.
 *
 * Tool-call/tool-result ordering is verified by the same integrity check
 * `appendMessages` relies on (`ensureConversationSafe`), since a tool-result
 * prepended ahead of its tool-call would be invalid regardless of how the
 * conversation was assembled.
 *
 * Accepts raw `MessageInput`s or already-built `Message`s, same as
 * `appendMessages`.
 */
export function prependMessages(
  conversation: Conversation,
  ...inputs: AppendableMessageInput[]
): Conversation;
export function prependMessages(
  conversation: Conversation,
  ...inputsAndEnvironment: [
    ...AppendableMessageInput[],
    Partial<ConversationEnvironment> | undefined,
  ]
): Conversation;
export function prependMessages(
  conversation: Conversation,
  ...args: (AppendableMessageInput | Partial<ConversationEnvironment> | undefined)[]
): Conversation {
  const { inputs, environment } = partitionAppendArgs(args);
  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const now = resolvedEnvironment.now();

  const newMessages = inputs.map((input, index) => {
    const processedInput = applyPlugins(input, resolvedEnvironment.plugins);
    return buildMessageFromInput(processedInput, index, now, resolvedEnvironment);
  });

  const offset = newMessages.length;
  // Renumber only messages actually reachable through `conversation.ids`, and
  // preserve `conversation.ids`/`conversation.messages` verbatim otherwise —
  // same as `appendMessages`. Rebuilding from `getOrderedMessages` here would
  // silently drop dangling ids or unlisted messages instead of letting
  // `ensureConversationSafe` surface them as integrity violations below.
  //
  // Positions are assigned from the walk index, not `message.position +
  // offset`: this function promises a dense, ordered `position` sequence
  // across the whole result, and adding the offset to a possibly-already-
  // sparse stale position would just carry the gaps forward.
  const renumbered: Record<string, Message> = {};
  let index = 0;
  for (const id of conversation.ids) {
    const message = conversation.messages[id];
    if (message) {
      renumbered[id] = repositionMessage(message, offset + index);
      index += 1;
    }
  }

  const next: Conversation = {
    ...conversation,
    ids: [...newMessages.map((message) => message.id), ...conversation.ids],
    messages: { ...conversation.messages, ...renumbered, ...toIdRecord(newMessages) },
    updatedAt: now,
  };
  return ensureConversationSafe(toReadonly(next));
}

/**
 * Appends a user message to the conversation.
 */
export function appendUserMessage(
  conversation: Conversation,
  content: MessageInput['content'],
  metadata?: Record<string, JSONValue>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = isConversationEnvironmentParameter(metadata) ? metadata : environment;
  const resolvedMetadata = isConversationEnvironmentParameter(metadata) ? undefined : metadata;
  return appendMessages(
    conversation,
    { role: 'user', content, metadata: resolvedMetadata },
    resolvedEnvironment,
  );
}

/**
 * Appends an assistant message to the conversation.
 */
export function appendAssistantMessage(
  conversation: Conversation,
  content: MessageInput['content'],
  metadata?: Record<string, JSONValue>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = isConversationEnvironmentParameter(metadata) ? metadata : environment;
  const resolvedMetadata = isConversationEnvironmentParameter(metadata) ? undefined : metadata;
  return appendMessages(
    conversation,
    { role: 'assistant', content, metadata: resolvedMetadata },
    resolvedEnvironment,
  );
}

/**
 * Appends a system message to the conversation.
 */
export function appendSystemMessage(
  conversation: Conversation,
  content: string,
  metadata?: Record<string, JSONValue>,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = isConversationEnvironmentParameter(metadata) ? metadata : environment;
  const resolvedMetadata = isConversationEnvironmentParameter(metadata) ? undefined : metadata;
  return appendMessages(
    conversation,
    { role: 'system', content, metadata: resolvedMetadata },
    resolvedEnvironment,
  );
}
