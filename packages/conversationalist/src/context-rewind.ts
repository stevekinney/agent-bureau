import {
  buildMessageBlocks,
  cloneMessageWithPosition,
  ensureTruncationSafe,
} from './context-blocks';
import { assertConversationSafe } from './conversation/validation';
import type { ConversationEnvironment } from './environment';
import { resolveConversationEnvironment } from './environment';
import { copyContent } from './multi-modal';
import type { ConversationHistory as Conversation, Message } from './types';
import { toReadonly } from './utilities';
import { getOrderedMessages, toIdRecord } from './utilities/message-store';

/** Options for {@link rewindBeforePosition} and {@link rewindBeforeMessage}. */
export interface RewindOptions {
  /**
   * Keep tool-call/tool-result pairs atomic. A pair that straddles the
   * boundary — the call kept, its result dropped — is discarded whole, so a
   * rewind never leaves behind a call whose answer was rewound away.
   *
   * Set `false` to cut strictly at the boundary instead. The call then survives
   * without its result, which is a *pending* tool call rather than invalid
   * linkage, so nothing throws; the transcript simply reads as though the tool
   * was invoked and never answered.
   *
   * @default true
   */
  preserveToolPairs?: boolean;
}

/**
 * Drops the message at `position` and everything after it, returning the
 * conversation as it stood immediately before that point.
 *
 * This is the branch-rewind counterpart to {@link truncateFromPosition}, which
 * keeps the opposite tail: `truncateFromPosition` retains messages **from**
 * `position` onwards, while this retains messages **before** it. Reach for this
 * when implementing message-edit semantics — rewind to just before the edited
 * message, discard the superseded branch, re-send — rather than assembling
 * `ids`/`messages`/`updatedAt` by hand.
 *
 * Unlike the context-window helpers ({@link getRecentMessages},
 * {@link truncateToTokenLimit}), which drop the oldest messages to fit a
 * budget, this drops the newest to undo a branch.
 *
 * The boundary message is the first message in transcript order whose stored
 * position is at or past `position`; what gets dropped is that message and
 * everything after it *in the transcript*, even in histories whose stored
 * positions have drifted out of step with the id order.
 *
 * Positions are renumbered from zero, so the result is a well-formed
 * transcript rather than one with a gap. A `position` at or past the end
 * returns the conversation unchanged; a `position` of `0` or less empties it.
 * System messages are not exempt: one that lives after the boundary is part of
 * the branch being discarded and goes with it.
 */
export function rewindBeforePosition(
  conversation: Conversation,
  position: number,
  options?: RewindOptions,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  assertConversationSafe(conversation);

  // The boundary is *identified* by stored position — the value a caller read
  // off a message — but everything past identification works in transcript
  // order. Schema-valid histories can carry stale or sparse positions that
  // disagree with `ids` order, and deciding prefix membership by comparing
  // stored positions would then retain messages that sit after the boundary
  // in the transcript (agent-bureau#313).
  const ordered = getOrderedMessages(conversation);
  const boundaryIndex = ordered.findIndex((message) => message.position >= position);

  // Nothing sits at or past the boundary, so the transcript is already what
  // was asked for. Returning the same reference keeps a no-op rewind free of
  // a history entry and a spurious `updatedAt` bump.
  if (boundaryIndex === -1) return conversation;

  return rewindBeforeOrderedIndex(
    conversation,
    ordered,
    boundaryIndex,
    options,
    environment,
    'rewindBeforePosition',
  );
}

/**
 * {@link rewindBeforePosition} keyed by message id: drops `messageId` and
 * everything after it.
 *
 * This is the form edit flows usually want, since an adapter command such as
 * Chat's `editMessage` hands you the id of the message being edited rather than
 * its position. An unknown id returns the conversation unchanged — a message
 * that is not in the transcript has nothing after it to rewind.
 */
export function rewindBeforeMessage(
  conversation: Conversation,
  messageId: string,
  options?: RewindOptions,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  assertConversationSafe(conversation);

  // Locate the target in the ordered transcript rather than delegating via
  // its stored position: with stale positions the two disagree, and the id
  // the caller handed us names a place in the transcript, not a position
  // value (agent-bureau#313).
  const ordered = getOrderedMessages(conversation);
  const boundaryIndex = ordered.findIndex((message) => message.id === messageId);
  if (boundaryIndex === -1) return conversation;

  return rewindBeforeOrderedIndex(
    conversation,
    ordered,
    boundaryIndex,
    options,
    environment,
    'rewindBeforeMessage',
  );
}

/**
 * Shared tail of the rewind helpers: drops `ordered[boundaryIndex]` and
 * everything after it *in transcript order*, optionally discarding tool
 * blocks that straddle the boundary, then renumbers positions from zero.
 */
const rewindBeforeOrderedIndex = (
  conversation: Conversation,
  ordered: ReadonlyArray<Message>,
  boundaryIndex: number,
  options: RewindOptions | undefined,
  environment: Partial<ConversationEnvironment> | undefined,
  operation: 'rewindBeforePosition' | 'rewindBeforeMessage',
): Conversation => {
  const preserveToolPairs = options?.preserveToolPairs ?? true;
  const resolvedEnvironment = resolveConversationEnvironment(environment);

  let retained: ReadonlyArray<Message> = ordered.slice(0, boundaryIndex);

  if (preserveToolPairs) {
    const { messageToBlock } = buildMessageBlocks(ordered, () => 0, preserveToolPairs);
    // Keep a block only when all of it sits before the boundary. Expanding to
    // whole blocks the way `truncateFromPosition` does would pull dropped
    // messages back in, which is the wrong direction for a rewind. Block
    // extents are measured by ordered index, not by the block's stored
    // min/max positions, for the same reason as above: stale positions must
    // not let a block retain a member that follows the boundary in the
    // transcript.
    const orderedIndexById = new Map(ordered.map((message, index) => [message.id, index]));
    retained = retained.filter((message) => {
      const block = messageToBlock.get(message.id);
      return (
        block === undefined ||
        block.messages.every(
          (member) => (orderedIndexById.get(member.id) ?? Number.POSITIVE_INFINITY) < boundaryIndex,
        )
      );
    });
  }

  const renumbered = retained.map((message, index) =>
    cloneMessageWithPosition(message, index, copyContent(message.content)),
  );

  const next = toReadonly({
    ...conversation,
    ids: renumbered.map((message) => message.id),
    messages: toIdRecord(renumbered),
    updatedAt: resolvedEnvironment.now(),
  });

  return ensureTruncationSafe(next, preserveToolPairs, operation);
};
