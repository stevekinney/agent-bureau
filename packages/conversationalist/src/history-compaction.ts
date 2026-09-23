import { compactConversation } from './compaction/compact';
import type { CompactionOptions, CompactionResult, Summarizer } from './compaction/types';
import type { ConversationEnvironment } from './environment';
import { createOperationCancelledError, createRevisionConflictError } from './errors';
import type { ConversationActionType, ConversationEventDetail } from './events';
import type { ConversationHistory } from './types';

type CompactionHooks = {
  readonly signal: AbortSignal;
  readonly lifecycle: () => 'open' | 'closed' | 'disposed';
  readonly revision: () => number;
  readonly current: () => ConversationHistory;
  readonly track: (operation: Promise<unknown>) => void;
  readonly untrack: (operation: Promise<unknown>) => void;
  readonly event: (type: string, detail: ConversationEventDetail) => void;
  readonly detail: (
    type: ConversationActionType,
    previous: ConversationHistory,
    context: Record<string, unknown>,
  ) => ConversationEventDetail;
  readonly commit: (conversation: ConversationHistory, previous: ConversationHistory) => void;
};

export async function compactOwned(
  summarizer: Summarizer,
  options: CompactionOptions | undefined,
  environment: ConversationEnvironment,
  hooks: CompactionHooks,
): Promise<CompactionResult> {
  const previous = hooks.current();
  const startingRevision = hooks.revision();
  const operationSignal = options?.signal
    ? AbortSignal.any([hooks.signal, options.signal])
    : hooks.signal;
  const operation = compactConversation(
    previous,
    summarizer,
    { ...options, signal: operationSignal },
    environment,
  );
  hooks.track(operation);
  hooks.event(
    'compaction.started',
    hooks.detail('compaction.started', previous, { outcome: 'started' }),
  );
  let compacted: Awaited<typeof operation>;
  try {
    compacted = await operation;
  } catch (error) {
    throw handleCompactionError(error, operationSignal, previous, hooks);
  } finally {
    hooks.untrack(operation);
  }
  ensureCompactionActive(operationSignal, previous, hooks);
  if (hooks.revision() !== startingRevision) {
    hooks.event(
      'compaction.stale-discarded',
      hooks.detail('compaction.stale-discarded', previous, {
        outcome: 'discarded',
        reason: 'revision-conflict',
      }),
    );
    throw createRevisionConflictError(hooks.current().id, startingRevision, hooks.revision());
  }
  if (compacted.result.compacted) hooks.commit(compacted.conversation, previous);
  else
    hooks.event(
      'compaction.completed',
      hooks.detail('compaction.completed', previous, { outcome: 'completed' }),
    );
  return compacted.result;
}

function handleCompactionError(
  error: unknown,
  signal: AbortSignal,
  previous: ConversationHistory,
  hooks: CompactionHooks,
): Error {
  const cancelled = signal.aborted;
  if (hooks.lifecycle() === 'open') {
    const type = cancelled ? 'compaction.cancelled' : 'compaction.failed';
    hooks.event(
      type,
      hooks.detail(type, previous, {
        outcome: cancelled ? 'cancelled' : 'failed',
        reason: String(error),
      }),
    );
  }
  if (cancelled) return createOperationCancelledError(hooks.current().id, 'compaction');
  return error instanceof Error ? error : new Error(String(error));
}

function ensureCompactionActive(
  signal: AbortSignal,
  previous: ConversationHistory,
  hooks: CompactionHooks,
): void {
  if (!signal.aborted && hooks.lifecycle() === 'open') return;
  if (hooks.lifecycle() === 'open') {
    hooks.event(
      'compaction.cancelled',
      hooks.detail('compaction.cancelled', previous, {
        outcome: 'cancelled',
        reason: String(signal.reason),
      }),
    );
  }
  throw createOperationCancelledError(hooks.current().id, 'compaction');
}
